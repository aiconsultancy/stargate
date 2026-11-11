import { Database } from "bun:sqlite";
import { z } from "zod";
import type { PreparedAttachment, PublishedFile } from "./attachments";
import { cancellationNotice } from "./cancellation";
import { failureText, type RequestFailure } from "./request-failure";

export type Incoming = {
  eventId: string;
  botKey: string;
  conversation: string;
  channel: string;
  thread: string;
  user: string;
  text: string;
  files?: readonly string[];
  deferDelivery?: boolean;
  /** A verified peer captain bot sent this message. Absent for people. */
  sender?: "captain" | null;
  /**
   * `spoken`: held until its speech names the bot; it neither starts nor
   * continues a conversation yet. `admitted`: its speech named the bot.
   */
  gate?: "spoken" | "admitted" | null;
};

export type Job = Incoming & {
  id: number;
  status: "queued" | "running" | "responding" | "done" | "failed";
  response: string | null;
  sent: number;
  attempts: number;
  failure?: RequestFailure | null;
  input?: string | null;
};

type StoredJob = Omit<Job, "deferDelivery"> & { deferDelivery: number };

function decodeJob(row: StoredJob | null): Job | null {
  return row && { ...row, deferDelivery: row.deferDelivery === 1 };
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
    chunks: string[];
    files?: PublishedFile[];
  }[];
};

export type AttachmentDelivery = PublishedFile & {
  title?: string;
  prepared?: PreparedAttachment;
  phase?: "reserved" | "uploaded" | "completing" | "shared" | "unavailable";
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
      (eventId,botKey,conversation,channel,thread,user,text,input_files,deferDelivery,sender,gate)
      VALUES ($eventId,$botKey,$conversation,$channel,$thread,$user,$text,$files,$deferDelivery,$sender,$gate)`)
        .run({
          $eventId: input.eventId,
          $botKey: input.botKey,
          $conversation: input.conversation,
          $channel: input.channel,
          $thread: input.thread,
          $user: input.user,
          $text: input.text,
          $files: input.files?.length ? JSON.stringify(input.files) : null,
          $deferDelivery: input.deferDelivery ? 1 : 0,
          $sender: input.sender ?? null,
          $gate: input.gate ?? null,
        }).changes > 0
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
        "SELECT eventId FROM jobs WHERE conversation=? AND sender='captain' ORDER BY id DESC LIMIT 100",
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
          .array(z.string().regex(/^F[A-Z0-9]+$/))
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
      AND status IN ('queued','running') LIMIT 1`)
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
        (eventId,botKey,conversation,channel,thread,user,text,status,response,output_files,deferDelivery,sent)
        SELECT ?,botKey,conversation,channel,thread,user,'',
        CASE WHEN deferDelivery=1 THEN 'done' ELSE 'responding' END,?,?,deferDelivery,
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
          user: string;
          deferDelivery: number;
        },
        [string, string]
      >(`SELECT s.session_id AS session, s.cursor, j.channel, j.thread, j.user,j.deferDelivery
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
        AND status IN ('queued','running','responding') LIMIT 1`)
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
  replies(botKey: string, conversation: string): string[][] {
    return this.db
      .query<{ response: string }, [string, string]>(`SELECT response FROM jobs
      WHERE botKey=? AND conversation=? AND response IS NOT NULL
      AND status IN ('responding','done') ORDER BY id`)
      .all(botKey, conversation)
      .map((row) => JSON.parse(row.response) as string[]);
  }

  /** This thread's `transcript:*` outbox rows, for targeted repair. */
  transcriptRows(botKey: string, conversation: string) {
    return this.db
      .query<
        { eventId: string; status: Job["status"]; response: string | null },
        [string, string]
      >(`SELECT eventId, status, response FROM jobs WHERE botKey=?
      AND conversation=? AND eventId LIKE 'transcript:%' ORDER BY id`)
      .all(botKey, conversation)
      .map((row) => ({
        ...row,
        response: JSON.parse(row.response ?? "[]") as string[],
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
    replies: { eventId: string; chunks: string[]; files?: PublishedFile[] }[];
    requeue?: string[];
  }): number | undefined {
    return this.db.transaction(() => {
      const target = this.transcriptTarget(input.botKey, input.conversation);
      if (
        !target ||
        this.db
          .query(`SELECT 1 FROM jobs WHERE conversation=?
          AND status IN ('queued','running') LIMIT 1`)
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
          .query(`UPDATE jobs SET status=CASE WHEN deferDelivery=1 THEN 'done' ELSE 'responding' END,
          sent=CASE WHEN deferDelivery=1 THEN COALESCE(json_array_length(response),0) ELSE sent END,
          attempts=0,retry_at=0
          WHERE botKey=? AND conversation=? AND eventId=? AND status='failed'`)
          .run(input.botKey, input.conversation, eventId).changes;
      for (const reply of input.replies) {
        queued += this.db
          .query(`INSERT OR IGNORE INTO jobs
          (eventId,botKey,conversation,channel,thread,user,text,status,response,output_files,deferDelivery,sent)
          VALUES (?,?,?,?,?,?,'',?,?,?,?,?)`)
          .run(
            reply.eventId,
            input.botKey,
            input.conversation,
            target.channel,
            target.thread,
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
         AND earlier.status IN ('queued','running','responding'))
      ${
        serial
          ? `AND (j.status!='queued' OR NOT EXISTS
        (SELECT 1 FROM jobs pending WHERE pending.botKey=j.botKey
        AND pending.id<j.id AND pending.status IN ('queued','running')))`
          : ""
      }
      ORDER BY id LIMIT ?`)
      .all(botKey, now, limit)
      .map((row) => ({ ...row, deferDelivery: row.deferDelivery === 1 }));
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
        .query(`UPDATE jobs SET cancel_requested=1,
      response=CASE WHEN status='queued' THEN ? ELSE response END,
      failure=CASE WHEN status='queued' THEN 'cancelled' ELSE failure END,
      status=CASE WHEN status='queued' THEN 'responding' ELSE status END
      WHERE botKey=? AND id=? AND user=? AND channel=? AND thread=?
      AND status IN ('queued','running') AND EXISTS (
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

  queuedJob(botKey: string, eventId: string) {
    return this.db
      .query<{ id: number; status: Job["status"] }, [string, string]>(
        "SELECT id,status FROM jobs WHERE botKey=? AND eventId=?",
      )
      .get(botKey, eventId);
  }

  jobStatus(botKey: string, id: number): Job["status"] | undefined {
    return this.db
      .query<{ status: Job["status"] }, [string, number]>(
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
        status: Job["status"];
        failure: RequestFailure | null;
      }
    | undefined {
    const job = this.db
      .query<
        {
          status: Job["status"];
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
        `SELECT substr(p.value,1,12000) AS text FROM jobs j,json_each(j.response) p
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
    chunks: string[],
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
        .query<{ cancel_requested: number; conversation: string }, [number]>(
          "SELECT cancel_requested, conversation FROM jobs WHERE id=?",
        )
        .get(id);
      if (!job) throw new Error("Response job not found");
      const cancelled = job.cancel_requested === 1;
      const response = cancelled
        ? [...chunks.slice(0, options.keep ?? 0), cancellationNotice]
        : chunks;
      this.db
        .query(
          "UPDATE jobs SET started=CASE WHEN status='running' THEN 1 ELSE started END,status='responding',response=?,failure=?,sent=0,output_files=? WHERE id=?",
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

  sent(id: number, count: number) {
    this.db.query("UPDATE jobs SET sent=? WHERE id=?").run(count, id);
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

  finish(id: number, status: "done" | "failed" = "done") {
    this.db.query("UPDATE jobs SET status=? WHERE id=?").run(status, id);
  }

  retry(id: number, now: number) {
    this.db
      .query("UPDATE jobs SET attempts=attempts+1,retry_at=? WHERE id=?")
      .run(now, id);
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
  queueCounts(botKey: string): Record<Job["status"], number> {
    const counts = { queued: 0, running: 0, responding: 0, done: 0, failed: 0 };
    for (const row of this.db
      .query<{ status: Job["status"]; n: number }, [string]>(
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
          status: Job["status"];
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
