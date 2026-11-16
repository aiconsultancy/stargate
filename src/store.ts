import { Database } from "bun:sqlite";
import { z } from "zod";
import type { PreparedAttachment, PublishedFile } from "./attachments";
import { cancellationNotice } from "./cancellation";
import {
  type FleetJob,
  fleetJobSchema,
  type NativeMaker,
  nativeMakerSchema,
} from "./fleet/protocol";
import { validMsgid } from "./irc/protocol";
import { failureText, type RequestFailure } from "./request-failure";
import type { ReplyChunk } from "./slack-format";

export type Incoming = {
  eventId: string;
  botKey: string;
  conversation: string;
  channel: string;
  thread: string;
  /** IRC thread root; null/absent means an ordinary main-channel request. */
  replyParent?: string | null;
  user: string;
  text: string;
  files?: readonly string[];
  deferDelivery?: boolean;
  /**
   * `captain`: a verified peer captain bot. `crew`: this ship's own captain
   * or crew account on IRC. Absent for people.
   */
  sender?: "captain" | "crew" | null;
  /** Transport time of the message in ms, for rolling turn limits (IRC). */
  received?: number | null;
  /**
   * `spoken`: held until its speech names the bot; it neither starts nor
   * continues a conversation yet. `admitted`: its speech named the bot.
   */
  gate?: "spoken" | "admitted" | null;
  /** The configured name that admitted a message without a mention. */
  textMention?: string | null;
  /** Earliest start in ms (IRC all-call turns); absent starts at once. */
  notBefore?: number | null;
  /** Only trusted gateway intake/result recovery supplies this correlation. */
  fleet?: FleetJob;
};

/**
 * Job lifecycle. Each method below is one transition and its SQL guard is
 * the check: a transition from any other status writes nothing.
 *
 * - queued → running: `running` (not after an accepted Stop).
 * - queued → responding: an accepted Stop (`cancel`, `cancelTurn`).
 * - running → responding: `respond` (throws `JobTransitionRefused` from
 *   another status), or `recover` after a restart.
 * - responding → done or failed: `finish`, after delivery or its last retry.
 * - failed → responding: `appendTranscript` requeues a `transcript:*` row.
 * - queued → failed: `finish`, when access was removed before the turn.
 *
 * While responding, `sent` moves the delivery cursor forward and `retry`
 * delays the next attempt. `finish`, `sent` and `retry` return false when
 * the status refused them.
 *
 * A row with `deferDelivery` has no delivery: it goes to `done` at once.
 */
export const jobStatuses = [
  "queued",
  "running",
  "responding",
  "done",
  "failed",
] as const;
export type JobStatus = (typeof jobStatuses)[number];

const sqlList = (statuses: readonly JobStatus[]) =>
  statuses.map((status) => `'${status}'`).join(",");
/** SQL list: no reply is stored yet; the backend may still run this job. */
export const pendingJobs = sqlList(["queued", "running"]);
/** SQL list: not delivered or failed yet; later jobs of the thread wait. */
export const unfinishedJobs = sqlList(["queued", "running", "responding"]);

/** Status of a stored reply: a deferred source needs no delivery. */
const storedReplyStatus =
  "CASE WHEN deferDelivery=1 THEN 'done' ELSE 'responding' END";
/**
 * An accepted Stop. A queued job settles at once with the notice (the one
 * parameter); a running job keeps its status and its worker sees the flag.
 */
const stopJob = `UPDATE jobs SET cancel_requested=1,
  response=CASE WHEN status='queued' THEN ? ELSE response END,
  failure=CASE WHEN status='queued' THEN 'cancelled' ELSE failure END,
  status=CASE WHEN status='queued' THEN 'responding' ELSE status END`;

export type Job = Incoming & {
  id: number;
  status: JobStatus;
  response: string | null;
  sent: number;
  attempts: number;
  failure?: RequestFailure | null;
  input?: string | null;
  makers?: NativeMaker[];
};

type StoredJob = Omit<Job, "deferDelivery" | "fleet" | "makers"> & {
  deferDelivery: number;
  fleet_context: string | null;
  makers: string | null;
  fleet_exported: number;
};

function decodeStoredJob(row: StoredJob): Job {
  const { fleet_context, makers, fleet_exported: _exported, ...job } = row;
  return {
    ...job,
    deferDelivery: row.deferDelivery === 1,
    ...(fleet_context
      ? { fleet: fleetJobSchema.parse(JSON.parse(fleet_context)) }
      : {}),
    ...(makers
      ? { makers: z.array(nativeMakerSchema).parse(JSON.parse(makers)) }
      : {}),
  };
}

function decodeJob(row: StoredJob | null): Job | null {
  return row && decodeStoredJob(row);
}

export type CaptainCursor = {
  cursor: string | undefined;
  owner: number | null;
};

export type CaptainTranscript = {
  botKey: string;
  sessionID: string;
  from: CaptainCursor;
  cursor: string;
  owner: number | null;
  replies: {
    job: number;
    eventId: string;
    chunks: ReplyChunk[];
    files?: PublishedFile[];
  }[];
};

export type AttachmentDelivery = PublishedFile & {
  title?: string;
  prepared?: PreparedAttachment;
  phase?:
    | "reserved"
    | "uploading"
    | "uploaded"
    | "completing"
    | "shared"
    | "unavailable";
  fileID?: string;
  noticeSent?: boolean;
};

const activityProgress = z.strictObject({
  ts: z.string().optional(),
  capture: z.string(),
  revision: z.number().int(),
  done: z.boolean(),
});
export type ActivityProgress = z.infer<typeof activityProgress>;

/**
 * `respond` was called for a job that is not running. Nothing was written:
 * a stored reply is never replaced, and a queued job has no reply.
 */
export class JobTransitionRefused extends Error {
  constructor(
    readonly job: number,
    readonly status: JobStatus,
  ) {
    super(`Job ${job} is ${status}; a reply needs a running job`);
  }
}

/** Another writer moved the transcript cursor or its outbox rows. */
export class TranscriptConflict extends Error {
  constructor() {
    super("Transcript cursor or delivery rows changed");
  }
}

export class Store {
  private readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sessions (
        conversation TEXT PRIMARY KEY, session_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        eventId TEXT NOT NULL, botKey TEXT NOT NULL,
        conversation TEXT NOT NULL, channel TEXT NOT NULL,
        thread TEXT NOT NULL, user TEXT NOT NULL, text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued', response TEXT,
        sent INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER NOT NULL DEFAULT 0,
        UNIQUE(botKey, eventId), UNIQUE(botKey, channel, eventId)
      );
      CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(botKey, status, retry_at);
      CREATE INDEX IF NOT EXISTS jobs_conversation ON jobs(conversation, id);
      CREATE TABLE IF NOT EXISTS previews (
        job INTEGER NOT NULL REFERENCES jobs(id), part INTEGER NOT NULL,
        ts TEXT NOT NULL, PRIMARY KEY(job, part)
      );
      CREATE TABLE IF NOT EXISTS ignored_events (
        botKey TEXT NOT NULL, eventId TEXT NOT NULL, PRIMARY KEY(botKey, eventId)
      );
      CREATE TABLE IF NOT EXISTS captain_cursors (
        botKey TEXT NOT NULL, session_id TEXT NOT NULL, cursor TEXT,
        owner INTEGER, PRIMARY KEY(botKey, session_id)
      );
      CREATE TABLE IF NOT EXISTS irc_cursors (
        botKey TEXT NOT NULL, target TEXT NOT NULL, time TEXT NOT NULL,
        PRIMARY KEY(botKey, target)
      );
      CREATE TABLE IF NOT EXISTS irc_thread_messages (
        botKey TEXT NOT NULL, channel TEXT NOT NULL, msgid TEXT NOT NULL,
        root TEXT NOT NULL, PRIMARY KEY(botKey,channel,msgid)
      );
      CREATE TABLE IF NOT EXISTS irc_thread_memberships (
        botKey TEXT NOT NULL, channel TEXT NOT NULL, root TEXT NOT NULL,
        PRIMARY KEY(botKey,channel,root)
      );
      CREATE TABLE IF NOT EXISTS irc_stargate_dm (
        id TEXT PRIMARY KEY, sent INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS irc_stargate_dm_cursor (
        botKey TEXT PRIMARY KEY, sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delivery_units (
        job INTEGER NOT NULL REFERENCES jobs(id), part INTEGER NOT NULL,
        plan TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(job, part)
      );
    `);
    const column = (table: string, name: string, type: string) => {
      if (
        !this.db
          .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
          .all()
          .some((column) => column.name === name)
      ) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
        return true;
      }
      return false;
    };
    column("jobs", "cancel_requested", "INTEGER NOT NULL DEFAULT 0");
    column("jobs", "failure", "TEXT");
    column("jobs", "activity", "TEXT");
    column("jobs", "input", "TEXT");
    column("jobs", "input_files", "TEXT");
    column("jobs", "output_files", "TEXT");
    column("jobs", "deferDelivery", "INTEGER NOT NULL DEFAULT 0");
    column("jobs", "sender", "TEXT");
    column("jobs", "gate", "TEXT");
    column("jobs", "textMention", "TEXT");
    column("jobs", "received", "INTEGER");
    column("jobs", "replyParent", "TEXT");
    column("jobs", "fleet_context", "TEXT");
    column("jobs", "fleet_exported", "INTEGER NOT NULL DEFAULT 0");
    column("jobs", "makers", "TEXT");
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS jobs_fleet_assignment
      ON jobs(botKey,json_extract(fleet_context,'$.dispatchID'))
      WHERE json_extract(fleet_context,'$.kind')='assignment'`);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS jobs_received ON jobs(sender,received) WHERE received IS NOT NULL",
    );
    // Preserve source-first context and legacy ownership; keep statuses intact.
    if (column("jobs", "started", "INTEGER NOT NULL DEFAULT 0"))
      this.db.exec(`UPDATE jobs SET started=1 WHERE started=0
      AND status!='queued' AND failure IS NOT 'context'
      AND failure IS NOT 'cancelled' AND text!='';`);
    this.db.exec("CREATE INDEX IF NOT EXISTS jobs_input ON jobs(botKey,input)");
    // Newest native message accounted for in Slack; NULL needs a baseline.
    column("sessions", "cursor", "TEXT");
    // Server-wide settle events look up mappings by native session ID.
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS sessions_session ON sessions(session_id)",
    );
  }

  enqueue(input: Incoming): boolean {
    if (
      this.db
        .query("SELECT 1 FROM ignored_events WHERE botKey=? AND eventId=?")
        .get(input.botKey, input.eventId) !== null
    )
      return false;
    return (
      this.db
        .query(`INSERT OR IGNORE INTO jobs
      (eventId,botKey,conversation,channel,thread,replyParent,user,text,input_files,deferDelivery,sender,gate,textMention,received,retry_at,fleet_context)
      VALUES ($eventId,$botKey,$conversation,$channel,$thread,$replyParent,$user,$text,$files,$deferDelivery,$sender,$gate,$textMention,$received,$retryAt,$fleet)`)
        .run({
          $eventId: input.eventId,
          $botKey: input.botKey,
          $conversation: input.conversation,
          $channel: input.channel,
          $thread: input.thread,
          $replyParent: input.replyParent ?? null,
          $user: input.user,
          $text: input.text,
          $files: input.files?.length ? JSON.stringify(input.files) : null,
          $deferDelivery: input.deferDelivery ? 1 : 0,
          $sender: input.sender ?? null,
          $gate: input.gate ?? null,
          $textMention: input.textMention ?? null,
          $received: input.received ?? null,
          $retryAt: input.notBefore ?? 0,
          $fleet: input.fleet
            ? JSON.stringify(fleetJobSchema.parse(input.fleet))
            : null,
        }).changes > 0
    );
  }

  /**
   * Admitted messages of one sender kind received at or after `since` (ms),
   * in these registrations and in one conversation or channel. IRC only:
   * Slack rows carry no `received` time.
   */
  turnsSince(input: {
    botKeys: readonly string[];
    sender: "captain" | "crew";
    since: number;
    scope: { conversation: string } | { channel: string };
  }): number {
    if (!input.botKeys.length) return 0;
    const keys = input.botKeys.map(() => "?").join(",");
    const [column, value] =
      "conversation" in input.scope
        ? ["conversation", input.scope.conversation]
        : ["channel", input.scope.channel];
    return (
      this.db
        .query<{ n: number }, (string | number)[]>(
          `SELECT COUNT(*) AS n FROM jobs WHERE sender=? AND received>=?
        AND ${column}=? AND botKey IN (${keys})`,
        )
        .get(input.sender, input.since, value, ...input.botKeys)?.n ?? 0
    );
  }

  /**
   * A held voice message that did not name the bot is deleted. Only its event
   * ID remains, in a separate table, so Slack redelivery is deduplicated.
   */
  discard(id: number) {
    this.db.transaction(() => {
      this.db
        .query(`INSERT OR IGNORE INTO ignored_events (botKey,eventId)
        SELECT botKey,eventId FROM jobs WHERE id=? AND status='queued' AND gate='spoken'`)
        .run(id);
      this.db
        .query(
          "DELETE FROM jobs WHERE id=? AND status='queued' AND gate='spoken'",
        )
        .run(id);
    })();
  }

  /** A held voice message named the bot: it is now an ordinary request. */
  admitSpoken(id: number) {
    return (
      this.db
        .query(
          "UPDATE jobs SET gate='admitted' WHERE id=? AND status='queued' AND gate='spoken'",
        )
        .run(id).changes > 0
    );
  }

  /** Peer captain messages in a conversation whose Slack time is after `since`. */
  peerTurns(conversation: string, since: number): number {
    return this.db
      .query<{ eventId: string }, [string]>(
        "SELECT eventId FROM jobs WHERE conversation=? AND sender='captain' ORDER BY id DESC LIMIT 600",
      )
      .all(conversation)
      .filter(({ eventId }) => {
        const ts = Number(eventId.slice(eventId.lastIndexOf(":") + 1));
        return Number.isFinite(ts) && ts * 1000 >= since;
      }).length;
  }

  inputFiles(id: number): string[] {
    const row = this.db
      .query<{ input_files: string | null }, [number]>(
        "SELECT input_files FROM jobs WHERE id=?",
      )
      .get(id);
    return row?.input_files
      ? z
          // Slack file IDs, or IRC FILEHOST URLs that the transport rechecks.
          .array(
            z
              .string()
              .max(2048)
              .regex(/^(?:F[A-Z0-9]+|https?:\/\/\S+)$/),
          )
          .max(10)
          .parse(JSON.parse(row.input_files))
      : [];
  }

  attachments(id: number): AttachmentDelivery[] {
    const row = this.db
      .query<{ output_files: string | null }, [number]>(
        "SELECT output_files FROM jobs WHERE id=?",
      )
      .get(id);
    return row?.output_files
      ? (JSON.parse(row.output_files) as AttachmentDelivery[])
      : [];
  }

  saveAttachments(id: number, files: readonly AttachmentDelivery[]) {
    this.db
      .query("UPDATE jobs SET output_files=? WHERE id=?")
      .run(JSON.stringify(files), id);
  }

  activity(id: number): ActivityProgress | undefined {
    const raw = this.db
      .query<{ activity: string | null }, [number]>(
        "SELECT activity FROM jobs WHERE id=?",
      )
      .get(id)?.activity;
    return raw ? activityProgress.parse(JSON.parse(raw)) : undefined;
  }

  saveActivity(id: number, progress: ActivityProgress) {
    this.db
      .query("UPDATE jobs SET activity=? WHERE id=?")
      .run(JSON.stringify(activityProgress.parse(progress)), id);
  }

  latestActivity(botKey: string, conversation: string): Job | null {
    return decodeJob(
      this.db
        .query<StoredJob, [string, string]>(
          "SELECT * FROM jobs WHERE botKey=? AND conversation=? AND activity IS NOT NULL ORDER BY id DESC LIMIT 1",
        )
        .get(botKey, conversation),
    );
  }

  latestBotActivity(botKey: string): Job | null {
    return decodeJob(
      this.db
        .query<StoredJob, [string]>(
          "SELECT * FROM jobs WHERE botKey=? AND activity IS NOT NULL ORDER BY id DESC LIMIT 1",
        )
        .get(botKey),
    );
  }

  /** Persist admission correlation before the backend submits any native work. */
  saveInput(botKey: string, id: number, input: string, sessionID?: string) {
    this.db.transaction(() => {
      if (
        this.db
          .query(
            "UPDATE jobs SET input=? WHERE botKey=? AND id=? AND status='running' AND input IS NULL",
          )
          .run(input, botKey, id).changes !== 1
      )
        throw new Error("Native input could not be recorded");
      // Failed initial baselines still have a durable, owned lower bound.
      if (sessionID)
        this.db
          .query(`UPDATE captain_cursors SET cursor=?,owner=?
        WHERE botKey=? AND session_id=? AND cursor IS NULL`)
          .run(input, id, botKey, sessionID);
    })();
  }

  jobByInput(botKey: string, input: string): Job | null {
    return decodeJob(
      this.db
        .query<StoredJob, [string, string]>(
          "SELECT * FROM jobs WHERE botKey=? AND input=? ORDER BY id DESC LIMIT 1",
        )
        .get(botKey, input),
    );
  }

  /** Native approval candidates are executing inputs, never queued chat text. */
  permissionCandidates(botKey: string): Job[] {
    return this.db
      .query<StoredJob, [string]>(
        "SELECT * FROM jobs WHERE botKey=? AND status='running' AND input IS NOT NULL ORDER BY id LIMIT 32",
      )
      .all(botKey)
      .map(decodeStoredJob);
  }

  /** One cursor per pin. Old thread mappings and all outbox rows stay intact. */
  captainCursor(botKey: string, sessionID: string): CaptainCursor {
    return this.db.transaction(() => {
      const legacy = this.db
        .query<
          { cursor: string | null; owner: number },
          [string, string]
        >(`SELECT s.cursor,j.id AS owner FROM sessions s
        JOIN jobs j ON j.conversation=s.conversation
        WHERE j.botKey=? AND s.session_id=? AND j.started=1 AND j.failure IS NOT 'context'
        ORDER BY j.id DESC LIMIT 1`)
        .get(botKey, sessionID);
      this.db
        .query(`INSERT OR IGNORE INTO captain_cursors
        (botKey,session_id,cursor,owner) VALUES (?,?,?,?)`)
        .run(botKey, sessionID, legacy?.cursor ?? null, legacy?.owner ?? null);
      const row = this.db
        .query<
          { cursor: string | null; owner: number | null },
          [string, string]
        >(
          "SELECT cursor,owner FROM captain_cursors WHERE botKey=? AND session_id=?",
        )
        .get(botKey, sessionID);
      if (!row) throw new Error("Captain cursor not found");
      return { cursor: row.cursor ?? undefined, owner: row.owner };
    })();
  }

  captainBusy(botKey: string): boolean {
    return (
      this.db
        .query(`SELECT 1 FROM jobs WHERE botKey=?
      AND status IN (${pendingJobs}) LIMIT 1`)
        .get(botKey) !== null
    );
  }

  baselineCaptain(
    botKey: string,
    sessionID: string,
    cursor: string,
  ): CaptainCursor {
    this.db
      .query(`UPDATE captain_cursors SET cursor=?
      WHERE botKey=? AND session_id=? AND cursor IS NULL`)
      .run(cursor, botKey, sessionID);
    return this.captainCursor(botKey, sessionID);
  }

  interruptedInput(botKey: string): string | undefined {
    return this.db
      .query<{ input: string }, [string]>(
        "SELECT input FROM jobs WHERE botKey=? AND status='running' AND input IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
      .get(botKey)?.input;
  }

  /** Atomic shared cursor and source-provenanced delivery; never broadcasts. */
  private commitCaptain(input: CaptainTranscript) {
    if (
      this.db
        .query(`UPDATE captain_cursors SET cursor=?,owner=?
      WHERE botKey=? AND session_id=? AND cursor IS ? AND owner IS ?`)
        .run(
          input.cursor,
          input.owner,
          input.botKey,
          input.sessionID,
          input.from.cursor ?? null,
          input.from.owner,
        ).changes !== 1
    )
      throw new TranscriptConflict();
    // Native ownership selects both source and delivery mode. Digest catch-ups
    // commit as locally delivered rows, never as pending Slack work.
    for (const reply of input.replies) {
      if (
        this.db
          .query(`INSERT OR IGNORE INTO jobs
        (eventId,botKey,conversation,channel,thread,replyParent,user,text,status,response,output_files,deferDelivery,sent)
        SELECT ?,botKey,conversation,channel,thread,replyParent,user,'',
        ${storedReplyStatus},?,?,deferDelivery,
        CASE WHEN deferDelivery=1 THEN ? ELSE 0 END
        FROM jobs WHERE botKey=? AND id=?`)
          .run(
            reply.eventId,
            JSON.stringify(reply.chunks),
            reply.files?.length ? JSON.stringify(reply.files) : null,
            reply.chunks.length,
            input.botKey,
            reply.job,
          ).changes !== 1
      )
        throw new TranscriptConflict();
    }
  }

  appendCaptainTranscript(input: CaptainTranscript): boolean {
    return this.db.transaction(() => {
      if (this.captainBusy(input.botKey)) return false;
      this.commitCaptain(input);
      return true;
    })();
  }

  follows(conversation: string): boolean {
    return (
      this.db
        .query(
          "SELECT 1 FROM jobs WHERE conversation = ? AND (gate IS NULL OR gate='admitted') LIMIT 1",
        )
        .get(conversation) !== null
    );
  }

  session(conversation: string): string | undefined {
    return this.db
      .query<{ session_id: string }, [string]>(
        "SELECT session_id FROM sessions WHERE conversation = ?",
      )
      .get(conversation)?.session_id;
  }

  saveSession(conversation: string, id: string, cursor?: string) {
    this.db
      .query(
        "INSERT INTO sessions (conversation,session_id,cursor) VALUES (?,?,?)",
      )
      .run(conversation, id, cursor ?? null);
  }

  transcriptCursor(conversation: string): string | undefined {
    return (
      this.db
        .query<{ cursor: string | null }, [string]>(
          "SELECT cursor FROM sessions WHERE conversation=?",
        )
        .get(conversation)?.cursor ?? undefined
    );
  }

  /** Seed a missing cursor without moving an existing one. */
  baselineTranscript(conversation: string, cursor: string) {
    this.db
      .query(
        "UPDATE sessions SET cursor=? WHERE conversation=? AND cursor IS NULL",
      )
      .run(cursor, conversation);
    return this.transcriptCursor(conversation);
  }

  /** Every mapped conversation of this bot namespace, or one session's. */
  transcripts(botKey: string, session?: string): string[] {
    // Separate statements keep the session_id index usable for settle events.
    return this.db
      .query<{ conversation: string }, string[]>(
        `SELECT s.conversation FROM sessions s
      WHERE ${session === undefined ? "" : "s.session_id=? AND"} EXISTS
      (SELECT 1 FROM jobs j WHERE j.conversation=s.conversation AND j.botKey=?)`,
      )
      .all(...(session === undefined ? [] : [session]), botKey)
      .map((row) => row.conversation);
  }

  /** The mapped session plus the latest request's source and delivery mode. */
  transcriptTarget(botKey: string, conversation: string) {
    const row = this.db
      .query<
        {
          session: string;
          cursor: string | null;
          channel: string;
          thread: string;
          replyParent: string | null;
          user: string;
          deferDelivery: number;
        },
        [string, string]
      >(`SELECT s.session_id AS session, s.cursor, j.channel, j.thread, j.replyParent, j.user,j.deferDelivery
      FROM sessions s JOIN jobs j ON j.conversation=s.conversation
      WHERE j.botKey=? AND s.conversation=? AND (j.gate IS NULL OR j.gate='admitted')
      ORDER BY j.id DESC LIMIT 1`)
      .get(botKey, conversation);
    return (
      row && {
        ...row,
        cursor: row.cursor ?? undefined,
        deferDelivery: row.deferDelivery === 1,
      }
    );
  }

  unfinished(conversation: string) {
    return (
      this.db
        .query(`SELECT 1 FROM jobs WHERE conversation=?
        AND status IN (${unfinishedJobs}) LIMIT 1`)
        .get(conversation) !== null
    );
  }

  /** Bot keys with requests in one Slack thread, for targeted repair. */
  threadBots(channel: string, thread: string): string[] {
    return this.db
      .query<{ botKey: string }, [string, string]>(
        "SELECT DISTINCT botKey FROM jobs WHERE channel=? AND thread=?",
      )
      .all(channel, thread)
      .map((row) => row.botKey);
  }

  /** Persisted reply chunks, including replies that are still delivering. */
  replies(botKey: string, conversation: string): ReplyChunk[][] {
    return this.db
      .query<{ response: string }, [string, string]>(`SELECT response FROM jobs
      WHERE botKey=? AND conversation=? AND response IS NOT NULL
      AND status IN ('responding','done') ORDER BY id`)
      .all(botKey, conversation)
      .map((row) => JSON.parse(row.response) as ReplyChunk[]);
  }

  /** This thread's `transcript:*` outbox rows, for targeted repair. */
  transcriptRows(botKey: string, conversation: string) {
    return this.db
      .query<
        { eventId: string; status: JobStatus; response: string | null },
        [string, string]
      >(`SELECT eventId, status, response FROM jobs WHERE botKey=?
      AND conversation=? AND eventId LIKE 'transcript:%' ORDER BY id`)
      .all(botKey, conversation)
      .map((row) => ({
        ...row,
        response: JSON.parse(row.response ?? "[]") as ReplyChunk[],
      }));
  }

  /**
   * Advance the cursor and queue its replies in one transaction. Refuses when
   * the cursor moved or a turn is pending; that turn reads the same history.
   * `requeue` retries failed rows of this thread with their stored text. Any
   * row that cannot be inserted or requeued rolls the whole change back.
   */
  appendTranscript(input: {
    botKey: string;
    conversation: string;
    from: string | undefined;
    cursor: string;
    replies: {
      eventId: string;
      chunks: ReplyChunk[];
      files?: PublishedFile[];
    }[];
    requeue?: string[];
  }): number | undefined {
    return this.db.transaction(() => {
      const target = this.transcriptTarget(input.botKey, input.conversation);
      if (
        !target ||
        this.db
          .query(`SELECT 1 FROM jobs WHERE conversation=?
          AND status IN (${pendingJobs}) LIMIT 1`)
          .get(input.conversation) !== null ||
        this.db
          .query(
            "UPDATE sessions SET cursor=? WHERE conversation=? AND cursor IS ?",
          )
          .run(input.cursor, input.conversation, input.from ?? null).changes ===
          0
      )
        return;
      let queued = 0;
      for (const eventId of input.requeue ?? [])
        queued += this.db
          .query(`UPDATE jobs SET status=${storedReplyStatus},
          sent=CASE WHEN deferDelivery=1 THEN COALESCE(json_array_length(response),0) ELSE sent END,
          attempts=0,retry_at=0
          WHERE botKey=? AND conversation=? AND eventId=? AND status='failed'`)
          .run(input.botKey, input.conversation, eventId).changes;
      for (const reply of input.replies) {
        queued += this.db
          .query(`INSERT OR IGNORE INTO jobs
          (eventId,botKey,conversation,channel,thread,replyParent,user,text,status,response,output_files,deferDelivery,sent)
          VALUES (?,?,?,?,?,?,?,'',?,?,?,?,?)`)
          .run(
            reply.eventId,
            input.botKey,
            input.conversation,
            target.channel,
            target.thread,
            target.replyParent,
            target.user,
            target.deferDelivery ? "done" : "responding",
            JSON.stringify(reply.chunks),
            reply.files?.length ? JSON.stringify(reply.files) : null,
            target.deferDelivery ? 1 : 0,
            target.deferDelivery ? reply.chunks.length : 0,
          ).changes;
      }
      // An existing row would be skipped silently; never advance past it.
      if (queued !== input.replies.length + (input.requeue?.length ?? 0))
        throw new TranscriptConflict();
      return queued;
    })();
  }

  ready(botKey: string, now: number, limit: number, serial = false): Job[] {
    return this.db
      .query<StoredJob, [string, number, number]>(`SELECT * FROM jobs j
      WHERE botKey = ? AND status IN ('queued','responding') AND retry_at <= ?
      AND NOT EXISTS (SELECT 1 FROM jobs earlier
        WHERE earlier.conversation=j.conversation AND earlier.id < j.id
         AND earlier.status IN (${unfinishedJobs}))
      ${
        serial
          ? `AND (j.status!='queued' OR NOT EXISTS
        (SELECT 1 FROM jobs pending WHERE pending.botKey=j.botKey
        AND pending.id<j.id AND pending.status IN (${pendingJobs})))`
          : ""
      }
      ORDER BY id LIMIT ?`)
      .all(botKey, now, limit)
      .map(decodeStoredJob);
  }

  running(id: number) {
    return (
      this.db
        .query(
          "UPDATE jobs SET status='running' WHERE id=? AND status='queued' AND cancel_requested=0",
        )
        .run(id).changes > 0
    );
  }

  started(id: number) {
    this.db
      .query("UPDATE jobs SET started=1 WHERE id=? AND status='running'")
      .run(id);
  }

  cancel(
    botKey: string,
    target: {
      id: number;
      user: string;
      channel: string;
      thread: string;
      ts: string;
    },
  ) {
    // Never infer a target from the conversation's most recent request.
    return (
      this.db
        .query(`${stopJob}
      WHERE botKey=? AND id=? AND user=? AND channel=? AND thread=?
      AND status IN (${pendingJobs}) AND EXISTS (
        SELECT 1 FROM previews WHERE job=jobs.id AND part=0 AND ts=?)`)
        .run(
          JSON.stringify([cancellationNotice]),
          botKey,
          target.id,
          target.user,
          target.channel,
          target.thread,
          target.ts,
        ).changes > 0
    );
  }

  /**
   * Request Stop for the active (queued or running) turn of one request in
   * one conversation; a queued one settles at once with the stop notice.
   * IRC Stop by reaction; Slack's button uses `cancel`.
   */
  cancelTurn(
    botKey: string,
    conversation: string,
    thread: string,
  ): number | undefined {
    return this.db.transaction(() => {
      const row = this.db
        .query<{ id: number }, [string, string, string]>(`SELECT id FROM jobs
        WHERE botKey=? AND conversation=? AND thread=?
        AND status IN (${pendingJobs}) ORDER BY id DESC LIMIT 1`)
        .get(botKey, conversation, thread);
      if (!row) return;
      this.db
        .query(`${stopJob}
        WHERE id=? AND status IN (${pendingJobs})`)
        .run(JSON.stringify([cancellationNotice]), row.id);
      return row.id;
    })();
  }

  queuedJob(botKey: string, eventId: string) {
    return this.db
      .query<{ id: number; status: JobStatus }, [string, string]>(
        "SELECT id,status FROM jobs WHERE botKey=? AND eventId=?",
      )
      .get(botKey, eventId);
  }

  jobByEvent(botKey: string, eventId: string): Job | null {
    return decodeJob(
      this.db
        .query<StoredJob, [string, string]>(
          "SELECT * FROM jobs WHERE botKey=? AND eventId=?",
        )
        .get(botKey, eventId),
    );
  }

  pendingFleetJobs(botKey: string): Job[] {
    return this.db
      .query<StoredJob, [string]>(
        "SELECT * FROM jobs WHERE botKey=? AND json_extract(fleet_context,'$.kind')='assignment' AND fleet_exported=0 ORDER BY id LIMIT 100",
      )
      .all(botKey)
      .map(decodeStoredJob);
  }

  fleetPublished(id: number) {
    this.db
      .query(
        "UPDATE jobs SET fleet_exported=1 WHERE id=? AND json_extract(fleet_context,'$.kind')='assignment'",
      )
      .run(id);
  }

  saveMakers(id: number, makers: NativeMaker[]) {
    this.db
      .query("UPDATE jobs SET makers=? WHERE id=? AND makers IS NULL")
      .run(
        JSON.stringify(z.array(nativeMakerSchema).max(100).parse(makers)),
        id,
      );
  }

  /** Outbound IRC root of this registration's request; legacy rows stay plain. */
  ircReplyParent(botKey: string, thread: string): string | undefined {
    return (
      this.db
        .query<{ replyParent: string | null }, [string, string]>(
          "SELECT replyParent FROM jobs WHERE botKey=? AND thread=? ORDER BY id LIMIT 1",
        )
        .get(botKey, thread)?.replyParent ?? undefined
    );
  }

  /** New opt-in human intake: persist ancestry and explicit invitation atomically. */
  enqueueIrcHuman(input: Incoming, invited: boolean): boolean {
    const root = input.replyParent ?? input.thread;
    if (!validMsgid(input.thread) || !validMsgid(root))
      throw new Error("IRC human thread identity is invalid");
    return this.db.transaction(() => {
      if (!this.enqueue(input)) return false;
      this.ircThreadMessage(input.botKey, input.channel, input.thread, root);
      if (invited) this.joinIrcThread(input.botKey, input.channel, root);
      return true;
    })();
  }

  ircThreadRoot(
    botKey: string,
    channel: string,
    msgid: string,
  ): string | undefined {
    return this.db
      .query<{ root: string }, [string, string, string]>(
        "SELECT root FROM irc_thread_messages WHERE botKey=? AND channel=? AND msgid=?",
      )
      .get(botKey, channel, msgid)?.root;
  }

  ircThreadParticipating(
    botKey: string,
    channel: string,
    root: string,
  ): boolean {
    return (
      this.db
        .query(
          "SELECT 1 FROM irc_thread_memberships WHERE botKey=? AND channel=? AND root=?",
        )
        .get(botKey, channel, root) !== null
    );
  }

  /** Called only for an exact locally-correlated, SASL-account-confirmed own echo. */
  ircPublished(
    botKey: string,
    channel: string,
    msgid: string,
    request: string,
    wireRoot?: string,
  ) {
    if (
      !validMsgid(msgid) ||
      !validMsgid(request) ||
      (wireRoot !== undefined && !validMsgid(wireRoot))
    )
      return false;
    return this.db.transaction(() => {
      const job = this.db
        .query<
          { thread: string; replyParent: string | null },
          [string, string, string]
        >(
          "SELECT thread,replyParent FROM jobs WHERE botKey=? AND channel=? AND thread=? ORDER BY id LIMIT 1",
        )
        .get(botKey, channel, request);
      if (!job) return false;
      const root = job.replyParent ?? job.thread;
      if (!validMsgid(root) || (wireRoot !== undefined && wireRoot !== root))
        return false;
      this.ircThreadMessage(botKey, channel, msgid, root);
      this.joinIrcThread(botKey, channel, root);
      return true;
    })();
  }

  private ircThreadMessage(
    botKey: string,
    channel: string,
    msgid: string,
    root: string,
  ) {
    const existing = this.ircThreadRoot(botKey, channel, msgid);
    if (existing !== undefined && existing !== root)
      throw new Error("IRC thread ancestry conflict");
    this.db
      .query(
        "INSERT OR IGNORE INTO irc_thread_messages(botKey,channel,msgid,root) VALUES (?,?,?,?)",
      )
      .run(botKey, channel, msgid, root);
  }

  private joinIrcThread(botKey: string, channel: string, root: string) {
    this.db
      .query(
        "INSERT OR IGNORE INTO irc_thread_memberships(botKey,channel,root) VALUES (?,?,?)",
      )
      .run(botKey, channel, root);
  }

  jobStatus(botKey: string, id: number): JobStatus | undefined {
    return this.db
      .query<{ status: JobStatus }, [string, number]>(
        "SELECT status FROM jobs WHERE botKey=? AND id=?",
      )
      .get(botKey, id)?.status;
  }

  /** Public outbox text only. Deferred runs also include their local catch-ups. */
  scheduledResult(
    botKey: string,
    id: number,
  ):
    | {
        text: string;
        status: JobStatus;
        failure: RequestFailure | null;
      }
    | undefined {
    const job = this.db
      .query<
        {
          status: JobStatus;
          failure: RequestFailure | null;
          conversation: string;
          deferDelivery: number;
        },
        [string, number]
      >(
        "SELECT status,failure,conversation,deferDelivery FROM jobs WHERE botKey=? AND id=?",
      )
      .get(botKey, id);
    if (!job) return;
    // Iterate bounded public chunks; never select prompts, inputs or file metadata.
    const parts = this.db
      .query<{ text: string }, [string, number, number, string, number]>(
        `SELECT substr(CASE p.type WHEN 'object' THEN json_extract(p.value,'$.text') ELSE p.value END,1,12000) AS text FROM jobs j,json_each(j.response) p
      WHERE j.botKey=? AND (j.id=? OR (?=1 AND j.conversation=?
      AND j.deferDelivery=1 AND j.id>? AND j.eventId LIKE 'transcript:%'))
      ORDER BY j.id,CAST(p.key AS INTEGER)`,
      )
      .iterate(botKey, id, job.deferDelivery, job.conversation, id);
    let text = "";
    for (const part of parts) {
      text = `${text}${text ? "\n\n" : ""}${part.text}`.slice(0, 12_000);
      if (text.length === 12_000) break;
    }
    return { text, status: job.status, failure: job.failure };
  }

  /**
   * An accepted Stop replaces the reply with its notice, except for the first
   * `keep` chunks: settled public text that already happened. The optional
   * transcript cursor advances in the same transaction; if it moved, this
   * throws `TranscriptConflict` and nothing is written.
   */
  respond(
    id: number,
    chunks: ReplyChunk[],
    failure?: RequestFailure,
    options: {
      keep?: number;
      transcript?: { from: string | undefined; cursor: string };
      captain?: CaptainTranscript;
      files?: PublishedFile[];
    } = {},
  ) {
    return this.db.transaction(() => {
      const job = this.db
        .query<
          { cancel_requested: number; conversation: string; status: JobStatus },
          [number]
        >("SELECT cancel_requested, conversation, status FROM jobs WHERE id=?")
        .get(id);
      if (!job) throw new Error("Response job not found");
      if (job.status !== "running")
        throw new JobTransitionRefused(id, job.status);
      const cancelled = job.cancel_requested === 1;
      const response = cancelled
        ? [...chunks.slice(0, options.keep ?? 0), cancellationNotice]
        : chunks;
      this.db
        .query(
          "UPDATE jobs SET started=1,status='responding',response=?,failure=?,sent=0,output_files=? WHERE id=? AND status='running'",
        )
        .run(
          JSON.stringify(response),
          cancelled ? "cancelled" : (failure ?? null),
          !cancelled && !failure && options.files?.length
            ? JSON.stringify(options.files)
            : null,
          id,
        );
      // A moved cursor means another writer queued some of this text.
      if (
        options.transcript &&
        this.db
          .query(
            "UPDATE sessions SET cursor=? WHERE conversation=? AND cursor IS ?",
          )
          .run(
            options.transcript.cursor,
            job.conversation,
            options.transcript.from ?? null,
          ).changes === 0
      )
        throw new TranscriptConflict();
      if (options.captain) this.commitCaptain(options.captain);
      return response;
    })();
  }

  failure(id: number): RequestFailure | undefined {
    return (
      this.db
        .query<{ failure: RequestFailure | null }, [number]>(
          "SELECT failure FROM jobs WHERE id=?",
        )
        .get(id)?.failure ?? undefined
    );
  }

  /** Chunks confirmed so far: forward only, within the stored reply. */
  sent(id: number, count: number) {
    return (
      this.db
        .query(`UPDATE jobs SET sent=? WHERE id=? AND status='responding'
        AND ?>=sent AND ?<=json_array_length(response)`)
        .run(count, id, count, count).changes > 0
    );
  }

  previews(id: number): { part: number; ts: string }[] {
    return this.db
      .query<{ part: number; ts: string }, [number]>(
        "SELECT part,ts FROM previews WHERE job=? ORDER BY part",
      )
      .all(id);
  }

  savePreview(id: number, part: number, ts: string) {
    this.db
      .query("INSERT INTO previews (job,part,ts) VALUES (?,?,?)")
      .run(id, part, ts);
  }

  removePreview(id: number, part: number) {
    this.db.query("DELETE FROM previews WHERE job=? AND part=?").run(id, part);
  }

  /**
   * End a job whose reply is stored. A queued job has no reply, so it can
   * only fail (access was removed before its turn).
   */
  finish(id: number, status: "done" | "failed" = "done") {
    return this.db.transaction(() => {
      const changed =
        this.db
          .query(`UPDATE jobs SET status=? WHERE id=?
          AND (status='responding' OR (status='queued' AND ?='failed'))`)
          .run(status, id, status).changes > 0;
      if (changed)
        this.db.query("DELETE FROM delivery_units WHERE job=?").run(id);
      return changed;
    })();
  }

  /**
   * A transport's delivery plan for one stored reply chunk and how many of
   * its units (IRC lines or multiline batches) were confirmed. The first
   * plan wins, so a retry splits the chunk exactly as before and resends
   * only the units after `done`.
   */
  deliveryPlan(job: number, part: number, plan: string) {
    this.db
      .query(
        "INSERT OR IGNORE INTO delivery_units (job,part,plan) VALUES (?,?,?)",
      )
      .run(job, part, plan);
    const row = this.db
      .query<{ plan: string; done: number }, [number, number]>(
        "SELECT plan,done FROM delivery_units WHERE job=? AND part=?",
      )
      .get(job, part);
    if (!row) throw new Error("Delivery plan not found");
    return row;
  }

  /**
   * Replace a stored plan whose first `done` units are unchanged, for a
   * transport that must re-split the rest (IRC: multiline lost before a
   * retry). Progress stays.
   */
  replaceDeliveryPlan(job: number, part: number, plan: string) {
    this.db
      .query("UPDATE delivery_units SET plan=? WHERE job=? AND part=?")
      .run(plan, job, part);
  }

  /**
   * Newest IRC server time seen in one target (folded channel, or "" for
   * direct messages) of one registration: CHATHISTORY catch-up resumes
   * after it.
   */
  ircCursor(botKey: string, target: string): string | undefined {
    return (
      this.db
        .query<{ time: string }, [string, string]>(
          "SELECT time FROM irc_cursors WHERE botKey=? AND target=?",
        )
        .get(botKey, target)?.time ?? undefined
    );
  }

  /** Moves forward only, unless `replace` (operator repair and tests). */
  saveIrcCursor(botKey: string, target: string, time: string, replace = false) {
    this.db
      .query(`INSERT INTO irc_cursors (botKey,target,time) VALUES (?,?,?)
      ON CONFLICT(botKey,target) DO UPDATE SET time=excluded.time
      WHERE ? OR excluded.time > irc_cursors.time`)
      .run(botKey, target, time, replace ? 1 : 0);
  }

  /**
   * A stargate_dm receipt ID that this process copies to IRC: recorded before
   * the IRC copy is sent, so the recipient connection recognises it and
   * never admits it as a second turn. Kept 7 days.
   */
  markStargateDmCopy(id: string, now = Date.now()) {
    this.db.transaction(() => {
      this.db
        .query("INSERT OR IGNORE INTO irc_stargate_dm VALUES (?,?)")
        .run(id, now);
      this.db
        .query("DELETE FROM irc_stargate_dm WHERE sent<?")
        .run(now - 7 * 24 * 60 * 60_000);
    })();
  }

  stargateDmCopy(id: string) {
    return (
      this.db.query("SELECT 1 FROM irc_stargate_dm WHERE id=?").get(id) !== null
    );
  }

  /** Last crew-plugin outbox sequence handled for one ship (its captain). */
  stargateDmCursor(botKey: string): number | undefined {
    return (
      this.db
        .query<{ sequence: number }, [string]>(
          "SELECT sequence FROM irc_stargate_dm_cursor WHERE botKey=?",
        )
        .get(botKey)?.sequence ?? undefined
    );
  }

  saveStargateDmCursor(botKey: string, sequence: number) {
    this.db
      .query(`INSERT INTO irc_stargate_dm_cursor VALUES (?,?)
      ON CONFLICT(botKey) DO UPDATE SET sequence=excluded.sequence`)
      .run(botKey, sequence);
  }

  deliveredUnits(job: number, part: number, done: number) {
    this.db
      .query("UPDATE delivery_units SET done=? WHERE job=? AND part=?")
      .run(done, job, part);
  }

  /** Count a failed delivery attempt and delay the next one. */
  retry(id: number, now: number) {
    return (
      this.db
        .query(
          "UPDATE jobs SET attempts=attempts+1,retry_at=? WHERE id=? AND status='responding'",
        )
        .run(now, id).changes > 0
    );
  }

  recover(botKey: string) {
    // greybeard: unknown tool outcomes are never retried automatically.
    // Reconciliation requires a backend-specific execution identifier.
    this.db
      .query(`UPDATE jobs SET status='responding',response=CASE WHEN cancel_requested=1 THEN ? ELSE ? END,sent=0,
      failure=CASE WHEN cancel_requested=1 THEN 'cancelled' ELSE 'interrupted' END
      WHERE botKey=? AND status='running'`)
      .run(
        JSON.stringify([cancellationNotice]),
        JSON.stringify([failureText("interrupted")]),
        botKey,
      );
  }

  interruptedSessions(botKey: string): string[] {
    return this.db
      .query<
        { session_id: string },
        [string]
      >(`SELECT DISTINCT s.session_id FROM sessions s
      JOIN jobs j ON j.conversation=s.conversation WHERE j.botKey=? AND j.status='running'`)
      .all(botKey)
      .map((row) => row.session_id);
  }

  /** Operator view: per-status totals for one bot namespace. */
  queueCounts(botKey: string): Record<JobStatus, number> {
    const counts = { queued: 0, running: 0, responding: 0, done: 0, failed: 0 };
    for (const row of this.db
      .query<{ status: JobStatus; n: number }, [string]>(
        "SELECT status,COUNT(*) AS n FROM jobs WHERE botKey=? GROUP BY status",
      )
      .all(botKey))
      if (Object.hasOwn(counts, row.status)) counts[row.status] = row.n;
    return counts;
  }

  /** Operator view: newest requests without prompt or reply text. */
  recentJobs(botKey: string, limit: number) {
    return this.db
      .query<
        {
          id: number;
          status: JobStatus;
          channel: string;
          thread: string;
          user: string;
          failure: RequestFailure | null;
          deferDelivery: number;
        },
        [string, number]
      >(`SELECT id,status,channel,thread,user,failure,deferDelivery FROM jobs
      WHERE botKey=? ORDER BY id DESC LIMIT ?`)
      .all(botKey, limit);
  }

  /** Native sessions this bot namespace has used, most recently used first. */
  sessionIDs(botKey: string, limit: number): string[] {
    return this.db
      .query<
        { session_id: string },
        [string, number]
      >(`SELECT s.session_id FROM sessions s
      JOIN jobs j ON j.conversation=s.conversation WHERE j.botKey=?
      GROUP BY s.session_id ORDER BY MAX(j.id) DESC LIMIT ?`)
      .all(botKey, limit)
      .map((row) => row.session_id);
  }

  /** True only when this bot namespace has a request mapped to the session. */
  ownsSession(botKey: string, sessionID: string): boolean {
    return (
      this.db
        .query(`SELECT 1 FROM sessions s
      JOIN jobs j ON j.conversation=s.conversation
      WHERE s.session_id=? AND j.botKey=? LIMIT 1`)
        .get(sessionID, botKey) !== null
    );
  }

  close() {
    this.db.close();
  }
}
