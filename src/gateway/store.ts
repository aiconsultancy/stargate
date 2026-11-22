import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { Result, Schema } from "effect";
import { ActivityRecords } from "../activity/store";
import type { PublishedFile } from "../attachments/attachments";
import { AttachmentRecords } from "../attachments/store";
import { BackgroundCases } from "../questions/background-questions";
import { cancellationNotice } from "./cancellation";
import { fleetJobSchema } from "../fleet/protocol";
import {
  ircBurstEligible,
  ircBurstLimits,
  ircBurstMessageSchema,
  ircBurstText,
} from "../irc/burst";
import { validMsgid } from "../irc/protocol";
import type { IrcBurstMessage, IrcOperations } from "../irc/store-contract";
import { FleetRecords } from "../fleet/store";
import { decodeJob, decodeStoredJob, type StoredJob } from "./row-codec";
import { TranscriptRecords } from "./transcript-store";
import { MetaRecords } from "../meta-commands/store";
import { notificationContextSchema } from "../notifications/preferences/notifications";
import type { QuestionOffer } from "../questions/questions";
import { QuestionRecords } from "../questions/store";
import { inboundReactionSchema } from "../shared/reactions";
import { failureText, type RequestFailure } from "../shared/request-failure";
import type { ReplyChunk } from "../shared/slack-format";
import { type Incoming, type Job, type JobStatus } from "./store-types";
import type { TurnProgress } from "../shared/turn-progress";
import { UpdateNotices } from "../maintenance/update-notice";

export { jobStatuses } from "./store-types";
export type { Incoming, Job, JobStatus };

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

const followUpSchema = Schema.Struct({
  botKey: Schema.String,
  eventId: Schema.String,
  conversation: Schema.String,
  channel: Schema.String,
  thread: Schema.String,
  replyParent: Schema.optionalKey(Schema.NullOr(Schema.String)),
  user: Schema.String,
  text: Schema.String,
  files: Schema.optionalKey(Schema.Array(Schema.String)),
  received: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  sender: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["captain", "crew"])),
  ),
  gate: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["spoken", "admitted"])),
  ),
  textMention: Schema.optionalKey(Schema.NullOr(Schema.String)),
  notBefore: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  deferDelivery: Schema.optionalKey(Schema.Boolean),
  fleet: Schema.optionalKey(fleetJobSchema),
  slackReaction: Schema.optionalKey(inboundReactionSchema),
  notification: Schema.optionalKey(
    Schema.Struct({
      wake: Schema.Literals(["ordinary", "direct", "broadcast"]),
      note: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type ThreadFollowUp = {
  botKey: string;
  eventId: string;
  owner: number;
  sessionID: string;
  inputID: string;
  nativeID: string;
  transport: "slack" | "irc";
  state: "pending" | "writing" | "accepted" | "uncertain" | "queued";
  notified: number;
  reconcileAttempts: number;
  retryAt: number;
  payload: string;
};

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
  readonly backgroundCases: BackgroundCases;
  readonly questions: QuestionRecords;
  readonly meta: MetaRecords;
  readonly attachmentRecords: AttachmentRecords;
  readonly activityRecords: ActivityRecords;
  readonly fleet: FleetRecords<StoredJob, Job>;
  readonly transcript: TranscriptRecords;
  readonly irc: IrcOperations;
  private readonly db: Database;
  readonly updateNotices: UpdateNotices;
  constructor(path: string, createIrcRecords: (db: Database) => IrcOperations) {
    this.db = new Database(path, { create: true, strict: true });
    this.backgroundCases = new BackgroundCases(this.db);
    this.updateNotices = new UpdateNotices(this.db);
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
      CREATE INDEX IF NOT EXISTS previews_ts ON previews(ts);
      CREATE TABLE IF NOT EXISTS ignored_events (
        botKey TEXT NOT NULL, eventId TEXT NOT NULL, PRIMARY KEY(botKey, eventId)
      );
      CREATE TABLE IF NOT EXISTS thread_followups (
        botKey TEXT NOT NULL, eventId TEXT NOT NULL, owner INTEGER NOT NULL,
        sessionID TEXT NOT NULL, inputID TEXT NOT NULL, nativeID TEXT NOT NULL,
        state TEXT NOT NULL, notified INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL, transport TEXT NOT NULL,
        reconcileAttempts INTEGER NOT NULL DEFAULT 0,
        retryAt INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(botKey,eventId)
      );
      CREATE TABLE IF NOT EXISTS meta_receipts (
        registration TEXT NOT NULL, message TEXT NOT NULL,
        channel TEXT NOT NULL, thread TEXT NOT NULL, user TEXT NOT NULL,
        at INTEGER NOT NULL, command TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', oldDelayMs INTEGER,
        newDelayMs INTEGER, reply TEXT, delivered INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(registration,message)
      );
      CREATE TABLE IF NOT EXISTS slack_questions (
        token TEXT PRIMARY KEY, ts TEXT NOT NULL, question TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS config_panels (
        nonce TEXT PRIMARY KEY, registration TEXT NOT NULL, message TEXT NOT NULL,
        channel TEXT NOT NULL, thread TEXT NOT NULL, ts TEXT,
        createdAt INTEGER NOT NULL, revision INTEGER NOT NULL,
        snapshot TEXT NOT NULL, user TEXT NOT NULL, at INTEGER NOT NULL,
        UNIQUE(registration,message)
      );
      CREATE TABLE IF NOT EXISTS captain_cursors (
        botKey TEXT NOT NULL, session_id TEXT NOT NULL, cursor TEXT,
        owner INTEGER, PRIMARY KEY(botKey, session_id)
      );
      CREATE TABLE IF NOT EXISTS irc_cursors (
        botKey TEXT NOT NULL, target TEXT NOT NULL, time TEXT NOT NULL,
        PRIMARY KEY(botKey, target)
      );
      CREATE TABLE IF NOT EXISTS irc_bursts (
        job INTEGER PRIMARY KEY REFERENCES jobs(id), policy TEXT NOT NULL,
        deadline INTEGER NOT NULL, maximum INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS irc_burst_messages (
        botKey TEXT NOT NULL, eventId TEXT NOT NULL,
        job INTEGER NOT NULL REFERENCES jobs(id), ordinal INTEGER NOT NULL,
        message TEXT NOT NULL, PRIMARY KEY(botKey,eventId), UNIQUE(job,ordinal)
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
      CREATE TABLE IF NOT EXISTS native_questions (
        token TEXT PRIMARY KEY, botKey TEXT NOT NULL, formID TEXT NOT NULL,
        sessionID TEXT NOT NULL, inputID TEXT NOT NULL, jobID INTEGER NOT NULL,
        fingerprint TEXT NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL,
        notified INTEGER NOT NULL DEFAULT 0, recovering INTEGER NOT NULL DEFAULT 0,
        UNIQUE(botKey,sessionID,formID)
      );
      CREATE TABLE IF NOT EXISTS irc_question_sources (
        botKey TEXT NOT NULL,eventId TEXT NOT NULL,user TEXT NOT NULL,
        channel TEXT NOT NULL,thread TEXT NOT NULL,root TEXT NOT NULL,
        PRIMARY KEY(botKey,eventId)
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
    column("slack_questions", "progress", "TEXT NOT NULL DEFAULT '{}'");
    column("slack_questions", "revision", "INTEGER NOT NULL DEFAULT 0");
    column("jobs", "progressStage", "TEXT");
    column("jobs", "progressAt", "INTEGER");
    column("jobs", "progressDisconnected", "INTEGER NOT NULL DEFAULT 0");
    column("jobs", "cancel_requested", "INTEGER NOT NULL DEFAULT 0");
    column("jobs", "question_stop_attempted", "INTEGER NOT NULL DEFAULT 0");
    column("jobs", "failure", "TEXT");
    column("jobs", "activity", "TEXT");
    column("jobs", "input", "TEXT");
    column("jobs", "input_files", "TEXT");
    column("jobs", "output_files", "TEXT");
    column("jobs", "deferDelivery", "INTEGER NOT NULL DEFAULT 0");
    column("jobs", "sender", "TEXT");
    column("jobs", "gate", "TEXT");
    column("jobs", "textMention", "TEXT");
    column("jobs", "notification_context", "TEXT");
    column("jobs", "slack_reaction", "TEXT");
    column("jobs", "notification_held", "INTEGER NOT NULL DEFAULT 0");
    column("jobs", "received", "INTEGER");
    column("jobs", "replyParent", "TEXT");
    column("jobs", "fleet_context", "TEXT");
    column("jobs", "fleet_exported", "INTEGER NOT NULL DEFAULT 0");
    column("jobs", "makers", "TEXT");
    column("native_questions", "outcome", "TEXT");
    column("native_questions", "outcomeNotified", "INTEGER NOT NULL DEFAULT 0");
    if (
      column(
        "native_questions",
        "publicationStarted",
        "INTEGER NOT NULL DEFAULT 0",
      )
    )
      // Existing offers may have been seen despite a lost ACK. Preserve their
      // original expiry rather than restarting their window on this migration.
      this.db.exec("UPDATE native_questions SET publicationStarted=1");
    column("irc_thread_messages", "request", "TEXT");
    for (const table of [
      "native_questions",
      "irc_question_sources",
      "irc_thread_messages",
      "irc_thread_memberships",
    ]) {
      if (column(table, "recorded", "INTEGER NOT NULL DEFAULT 0"))
        this.db.query(`UPDATE ${table} SET recorded=?`).run(Date.now());
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS ${table}_retention ON ${table}(botKey,recorded)`,
      );
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS jobs_irc_root ON jobs(botKey,channel,CAST(COALESCE(replyParent,thread) AS TEXT),status)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS native_questions_job ON native_questions(botKey,jobID)",
    );
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS jobs_fleet_assignment
      ON jobs(botKey,json_extract(fleet_context,'$.dispatchID'))
      WHERE json_extract(fleet_context,'$.kind')='assignment'`);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS jobs_received ON jobs(sender,received) WHERE received IS NOT NULL",
    );
    this.db.exec(`CREATE INDEX IF NOT EXISTS jobs_activity_ts
      ON jobs(botKey,channel,json_extract(activity,'$.ts')) WHERE activity IS NOT NULL`);
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
    this.questions = new QuestionRecords(this.db);
    this.meta = new MetaRecords(this.db);
    this.attachmentRecords = new AttachmentRecords(this.db);
    this.activityRecords = new ActivityRecords(this.db);
    this.fleet = new FleetRecords(this.db, decodeStoredJob);
    this.transcript = new TranscriptRecords(this.db);
    this.irc = createIrcRecords(this.db);
  }

  enqueue(input: Incoming): boolean {
    if (
      this.db
        .query(
          `SELECT 1 FROM ignored_events WHERE botKey=? AND eventId=?
           UNION ALL SELECT 1 FROM irc_burst_messages WHERE botKey=? AND eventId=?
           UNION ALL SELECT 1 FROM thread_followups WHERE botKey=? AND eventId=? LIMIT 1`,
        )
        .get(
          input.botKey,
          input.eventId,
          input.botKey,
          input.eventId,
          input.botKey,
          input.eventId,
        ) !== null
    )
      return false;
    return (
      this.db
        .query(`INSERT OR IGNORE INTO jobs
      (eventId,botKey,conversation,channel,thread,replyParent,user,text,input_files,deferDelivery,sender,gate,textMention,received,retry_at,fleet_context,notification_context,slack_reaction)
      VALUES ($eventId,$botKey,$conversation,$channel,$thread,$replyParent,$user,$text,$files,$deferDelivery,$sender,$gate,$textMention,$received,$retryAt,$fleet,$notification,$slackReaction)`)
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
          $notification: input.notification
            ? JSON.stringify(
                notificationContextSchema.parse(input.notification),
              )
            : null,
          $slackReaction: input.slackReaction
            ? JSON.stringify(input.slackReaction)
            : null,
          $received: input.received ?? null,
          $retryAt: input.notBefore ?? 0,
          $fleet: input.fleet
            ? JSON.stringify(
                Schema.decodeUnknownSync(fleetJobSchema)(input.fleet),
              )
            : null,
        }).changes > 0
    );
  }

  /** Persist admission before transport ACK. Undefined keeps ordinary intake. */
  admitFollowUp(
    input: Incoming,
    sessionID: string,
    transport: "slack" | "irc" = "slack",
    invited = false,
  ): boolean | undefined {
    return this.db.transaction(() => {
      if (
        this.db
          .query("SELECT 1 FROM thread_followups WHERE botKey=? AND eventId=?")
          .get(input.botKey, input.eventId) ||
        this.jobByEvent(input.botKey, input.eventId)
      )
        return false;
      const owner = this.db
        .query<StoredJob, [string]>(
          "SELECT * FROM jobs WHERE botKey=? AND status='running' ORDER BY id DESC LIMIT 1",
        )
        .get(input.botKey);
      if (!owner) return undefined;
      const root = (message: Pick<Incoming, "thread" | "replyParent">) =>
        transport === "irc"
          ? (message.replyParent ?? message.thread)
          : message.thread;
      const eligible =
        owner.conversation === input.conversation &&
        owner.channel === input.channel &&
        root(owner) === root(input) &&
        !!owner.input &&
        !input.sender &&
        !input.fleet &&
        !input.gate &&
        !input.deferDelivery &&
        !input.files?.length;
      if (!eligible && !this.enqueue(input)) return false;
      if (transport === "irc") {
        this.irc.ircThreadMessage(
          input.botKey,
          input.channel,
          input.thread,
          root(input),
        );
        if (eligible)
          this.db
            .query(
              "UPDATE jobs SET replyParent=COALESCE(replyParent,thread) WHERE id=? AND status='running'",
            )
            .run(owner.id);
        if (
          invited ||
          this.irc.ircThreadParticipating(
            input.botKey,
            input.channel,
            root(input),
          )
        )
          this.irc.joinIrcThread(input.botKey, input.channel, root(input));
      }
      this.db
        .query(`INSERT INTO thread_followups
        (botKey,eventId,owner,sessionID,inputID,nativeID,state,payload,transport)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(
          input.botKey,
          input.eventId,
          owner.id,
          sessionID,
          owner.input ?? "",
          `msg_${createHash("sha256").update(`${input.botKey}\0${input.eventId}`).digest("hex")}`,
          eligible ? "pending" : "queued",
          JSON.stringify(input),
          transport,
        );
      return true;
    })();
  }

  followUps(botKey: string, finalOwner?: number): ThreadFollowUp[] {
    return this.db
      .query<
        ThreadFollowUp,
        [string, number | null, number | null, number, number | null]
      >(
        `SELECT * FROM thread_followups WHERE botKey=? AND (? IS NULL OR owner=?) AND
      (state='pending' OR notified=0 OR
       (state IN ('writing','uncertain') AND ((reconcileAttempts<8 AND retryAt<=?) OR owner=?)))
      ORDER BY rowid LIMIT 32`,
      )
      .all(
        botKey,
        finalOwner ?? null,
        finalOwner ?? null,
        Date.now(),
        finalOwner ?? null,
      );
  }

  followUpInput(receipt: ThreadFollowUp): Incoming {
    return Schema.decodeUnknownSync(followUpSchema)(
      JSON.parse(receipt.payload),
    );
  }

  ownsFollowUp(receipt: ThreadFollowUp): boolean {
    const input = this.followUpInput(receipt);
    const owner = this.jobByInput(receipt.botKey, receipt.inputID);
    const root = (message: Incoming) =>
      receipt.transport === "irc"
        ? (message.replyParent ?? message.thread)
        : message.thread;
    return (
      owner?.id === receipt.owner &&
      owner.status === "running" &&
      owner.conversation === input.conversation &&
      owner.channel === input.channel &&
      root(owner) === root(input) &&
      this.db
        .query("SELECT 1 FROM jobs WHERE id=? AND cancel_requested=0")
        .get(owner.id) !== null
    );
  }

  claimFollowUp(receipt: ThreadFollowUp): boolean {
    return (
      this.db
        .query(
          "UPDATE thread_followups SET state='writing' WHERE botKey=? AND eventId=? AND state='pending'",
        )
        .run(receipt.botKey, receipt.eventId).changes === 1
    );
  }

  settleFollowUp(
    receipt: ThreadFollowUp,
    state: "accepted" | "uncertain" | "queued",
  ) {
    this.db.transaction(() => {
      // A definite refusal alone permits normal queue admission. Remove the
      // receipt temporarily inside this transaction to reuse enqueue's guards.
      if (state === "queued") {
        this.db
          .query("DELETE FROM thread_followups WHERE botKey=? AND eventId=?")
          .run(receipt.botKey, receipt.eventId);
        this.enqueue(this.followUpInput(receipt));
        this.db
          .query(`INSERT INTO thread_followups
          (botKey,eventId,owner,sessionID,inputID,nativeID,state,notified,payload,transport)
          VALUES (?,?,?,?,?,?,'queued',0,?,?)`)
          .run(
            receipt.botKey,
            receipt.eventId,
            receipt.owner,
            receipt.sessionID,
            receipt.inputID,
            receipt.nativeID,
            receipt.payload,
            receipt.transport,
          );
      } else if (state === "uncertain")
        this.db
          .query(
            "UPDATE thread_followups SET state=?,reconcileAttempts=reconcileAttempts+1,retryAt=? WHERE botKey=? AND eventId=?",
          )
          .run(
            state,
            Date.now() +
              Math.min(60_000, 1000 * 2 ** receipt.reconcileAttempts),
            receipt.botKey,
            receipt.eventId,
          );
      else
        this.db
          .query(
            "UPDATE thread_followups SET state=?,notified=0 WHERE botKey=? AND eventId=?",
          )
          .run(state, receipt.botKey, receipt.eventId);
    })();
  }

  notifiedFollowUp(receipt: ThreadFollowUp) {
    this.db
      .query(
        "UPDATE thread_followups SET notified=1 WHERE botKey=? AND eventId=?",
      )
      .run(receipt.botKey, receipt.eventId);
  }

  followUpLinks(owner: number): string {
    return this.db
      .query<{ payload: string; transport: string }, [number]>(
        "SELECT payload,transport FROM thread_followups WHERE owner=? AND state='accepted' ORDER BY rowid LIMIT 20",
      )
      .all(owner)
      .map((row) => {
        const input = Schema.decodeUnknownSync(followUpSchema)(
          JSON.parse(row.payload),
        );
        const message =
          input.slackReaction?.ts ??
          input.eventId.slice(input.channel.length + 1);
        return row.transport === "slack"
          ? `https://slack.com/archives/${input.channel}/p${message.replace(".", "")}`
          : `irc follow-up ${message}`;
      })
      .join("\n");
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

  unfinished(conversation: string) {
    return (
      this.db
        .query(`SELECT 1 FROM jobs WHERE conversation=?
        AND status IN (${unfinishedJobs}) LIMIT 1`)
        .get(conversation) !== null
    );
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
      const target = this.transcript.transcriptTarget(
        input.botKey,
        input.conversation,
      );
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
          WHERE botKey=? AND conversation=? AND eventId=? AND status='failed' AND failure IS NOT 'muted'`)
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

  ready(
    botKey: string,
    now: number,
    limit: number,
    serial = false,
    holdQueued = false,
  ): Job[] {
    return this.db
      .query<StoredJob, (string | number)[]>(`SELECT * FROM jobs j
      WHERE botKey = ? AND status IN ('queued','responding') AND retry_at <= ?
      ${holdQueued ? "AND status='responding'" : ""}
      AND NOT EXISTS (SELECT 1 FROM jobs earlier
        WHERE earlier.conversation=j.conversation AND earlier.id < j.id
         AND earlier.status IN (${unfinishedJobs})
         AND NOT (j.notification_context IS NULL AND earlier.status='queued'
           AND earlier.notification_held=1 AND (earlier.retry_at>? OR j.status='responding')))
      AND NOT (j.notification_held=1 AND EXISTS (SELECT 1 FROM jobs later
        WHERE later.conversation=j.conversation AND later.id>j.id
        AND later.status IN ('running','responding')))
      ${
        serial
          ? `AND (j.status!='queued' OR NOT EXISTS
        (SELECT 1 FROM jobs pending WHERE pending.botKey=j.botKey
        AND pending.id<j.id AND pending.status IN (${pendingJobs})
        AND NOT (j.notification_context IS NULL AND pending.status='queued'
          AND pending.notification_held=1 AND pending.retry_at>?)))`
          : ""
      }
      ORDER BY id LIMIT ?`)
      .all(botKey, now, now, ...(serial ? [now] : []), limit)
      .map(decodeStoredJob);
  }

  running(id: number, expectedText?: string) {
    return (
      this.db
        .query(
          `UPDATE jobs SET status='running',notification_held=0
           WHERE id=$id AND status='queued' AND cancel_requested=0
             AND ($expected IS NULL OR text=$expected)`,
        )
        .run({ $id: id, $expected: expectedText ?? null }).changes > 0
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
        .query<StoredJob, [string, string, string, string]>(
          `SELECT * FROM jobs WHERE botKey=? AND eventId=?
           UNION ALL SELECT j.* FROM irc_burst_messages b JOIN jobs j
             ON j.id=b.job AND j.botKey=b.botKey
           WHERE b.botKey=? AND b.eventId=? LIMIT 1`,
        )
        .get(botKey, eventId, botKey, eventId),
    );
  }

  /** New opt-in human intake: persist ancestry and explicit invitation atomically. */
  enqueueIrcHuman(input: Incoming, invited: boolean): boolean {
    const root = input.replyParent ?? input.thread;
    if (!validMsgid(input.thread) || !validMsgid(root))
      throw new Error("IRC human thread identity is invalid");
    return this.db.transaction(() => {
      if (!this.enqueue(input)) return false;
      this.irc.ircThreadMessage(
        input.botKey,
        input.channel,
        input.thread,
        root,
      );
      if (
        invited ||
        this.irc.ircThreadParticipating(input.botKey, input.channel, root)
      )
        this.irc.joinIrcThread(input.botKey, input.channel, root);
      return true;
    })();
  }

  /**
   * Coalesce only consecutively admitted human messages before work starts.
   * Original sources remain durable; event aliases never invent a native input.
   * Host receive time owns the deadline, not sender-controlled server-time tags.
   */
  enqueueIrcBurst(
    input: Incoming,
    options: {
      quietMs: number;
      policy: string;
      source: string;
      originalText: string;
      invited: boolean;
      /** Preserve the preexisting humanWakeChannels-only intake bookkeeping. */
      trackThreads: boolean;
      now?: number;
    },
  ): boolean {
    const ordinary = (job: Incoming) =>
      options.trackThreads
        ? this.enqueueIrcHuman(job, options.invited)
        : this.enqueue(job);
    if (
      !Number.isInteger(options.quietMs) ||
      options.quietMs < 1 ||
      options.quietMs > 5000 ||
      !ircBurstEligible(input)
    )
      return ordinary(input);
    const now = options.now ?? Date.now();
    const message: IrcBurstMessage = {
      eventId: input.eventId,
      thread: input.thread,
      source: options.source,
      text: input.text,
      originalText: options.originalText,
      received: input.received ?? now,
      files: [...(input.files ?? [])],
    };
    // An individually large message still follows ordinary admission intact.
    if (
      message.files.length > ircBurstLimits.files ||
      Buffer.byteLength(JSON.stringify(message)) > ircBurstLimits.bytes
    )
      return ordinary(input);
    if (
      Result.isFailure(
        Schema.decodeUnknownResult(ircBurstMessageSchema)(message),
      )
    )
      return ordinary(input);
    return this.db.transaction(() => {
      if (
        this.jobByEvent(input.botKey, input.eventId) ||
        this.db
          .query(`SELECT 1 FROM ignored_events WHERE botKey=? AND eventId=?
            UNION ALL SELECT 1 FROM thread_followups WHERE botKey=? AND eventId=? LIMIT 1`)
          .get(input.botKey, input.eventId, input.botKey, input.eventId) !==
          null
      )
        return false;
      const latest = this.db
        .query<StoredJob, [string]>(
          `SELECT * FROM jobs WHERE botKey=? AND text!=''
           AND COALESCE(json_extract(fleet_context,'$.kind'),'')!='result'
           ORDER BY id DESC LIMIT 1`,
        )
        .get(input.botKey);
      const burst = latest
        ? this.db
            .query<
              { policy: string; deadline: number; maximum: number },
              [number]
            >("SELECT policy,deadline,maximum FROM irc_bursts WHERE job=?")
            .get(latest.id)
        : null;
      if (
        latest &&
        burst &&
        latest.status === "queued" &&
        !latest.input &&
        latest.user === input.user &&
        latest.channel === input.channel &&
        latest.conversation === input.conversation &&
        (latest.replyParent ?? null) === (input.replyParent ?? null) &&
        (latest.textMention ?? null) === (input.textMention ?? null) &&
        burst.policy === options.policy &&
        now < burst.deadline &&
        now < burst.maximum
      ) {
        const messages = this.irc.ircBurstMessages(latest.id);
        const combined = [...messages, message];
        const files = [...new Set(combined.flatMap((item) => item.files))];
        const text = ircBurstText(combined);
        if (
          combined.length <= ircBurstLimits.messages &&
          files.length <= ircBurstLimits.files &&
          Buffer.byteLength(JSON.stringify(combined)) <= ircBurstLimits.bytes &&
          Buffer.byteLength(text) <= ircBurstLimits.bytes
        ) {
          const deadline = Math.min(now + options.quietMs, burst.maximum);
          const changed = this.db
            .query(
              `UPDATE jobs SET text=?,input_files=?,retry_at=MAX(retry_at,?)
               WHERE id=? AND status='queued' AND input IS NULL AND cancel_requested=0`,
            )
            .run(
              text,
              files.length ? JSON.stringify(files) : null,
              Math.max(deadline, input.notBefore ?? 0),
              latest.id,
            ).changes;
          if (changed) {
            this.db
              .query("UPDATE irc_bursts SET deadline=? WHERE job=?")
              .run(deadline, latest.id);
            this.irc.saveIrcBurstMessage(
              latest.id,
              combined.length - 1,
              input.botKey,
              message,
            );
            if (options.trackThreads) {
              const root = latest.replyParent ?? latest.thread;
              this.irc.ircThreadMessage(
                input.botKey,
                input.channel,
                input.thread,
                root,
                latest.thread,
              );
              if (options.invited)
                this.irc.joinIrcThread(input.botKey, input.channel, root);
            }
            return true;
          }
        }
      }
      const deadline = now + options.quietMs;
      if (
        !ordinary({
          ...input,
          notBefore: Math.max(deadline, input.notBefore ?? 0),
        })
      )
        return false;
      const job = this.jobByEvent(input.botKey, input.eventId);
      if (!job) throw new Error("IRC burst job was not persisted");
      this.db
        .query(
          "INSERT INTO irc_bursts(job,policy,deadline,maximum) VALUES(?,?,?,?)",
        )
        .run(job.id, options.policy, deadline, now + ircBurstLimits.waitMs);
      this.irc.saveIrcBurstMessage(job.id, 0, input.botKey, message);
      return true;
    })();
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
      const prior = this.irc.ircRequestAnchor(botKey, channel, msgid);
      if (prior !== undefined && prior !== request) return false;
      this.irc.ircThreadMessage(botKey, channel, msgid, root, request);
      this.irc.joinIrcThread(botKey, channel, root);
      return true;
    })();
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
  sent(id: number, count: number, slackTs?: string) {
    const advance = () =>
      this.db
        .query(`UPDATE jobs SET sent=? WHERE id=? AND status='responding'
        AND ?>=sent AND ?<=json_array_length(response)`)
        .run(count, id, count, count).changes > 0;
    if (!slackTs) return advance();
    return this.db.transaction(() => {
      if (!advance()) return false;
      this.savePreview(id, count - 1, slackTs);
      return true;
    })();
  }

  /** Confirmed reply chunks (including previews) and crew activity posts. */
  slackReplyThread(botKey: string, channel: string, ts: string) {
    const matches = this.db
      .query<
        { thread: string },
        { $botKey: string; $channel: string; $ts: string }
      >(
        `SELECT j.thread FROM previews p JOIN jobs j ON j.id=p.job
         WHERE p.ts=$ts AND j.botKey=$botKey AND j.channel=$channel
         UNION
         SELECT thread FROM jobs WHERE botKey=$botKey AND channel=$channel
         AND activity IS NOT NULL AND json_extract(activity,'$.ts')=$ts LIMIT 2`,
      )
      .all({ $ts: ts, $botKey: botKey, $channel: channel });
    return matches.length === 1 ? matches[0]?.thread : undefined;
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

  /** Intentional notification suppression, never cancellation or reply delivery. */
  suppressNotification(id: number) {
    return (
      this.db
        .query(`UPDATE jobs SET status='failed',failure='muted'
      WHERE id=? AND status='queued'
      AND json_extract(notification_context,'$.wake')='ordinary'`)
        .run(id).changes === 1
    );
  }

  /** A preference-store fault backs off only chat; exempt native/cron work may pass. */
  holdNotification(id: number, until: number) {
    return (
      this.db
        .query(`UPDATE jobs SET notification_held=1,retry_at=?
      WHERE id=? AND status='queued' AND notification_context IS NOT NULL`)
        .run(until, id).changes === 1
    );
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

  recover(botKey: string, retainedQuestionInputs: readonly string[] = []) {
    // greybeard: unknown tool outcomes are never retried automatically.
    // Reconciliation requires a backend-specific execution identifier.
    this.db
      .query(`UPDATE jobs SET status='responding',response=CASE WHEN cancel_requested=1 THEN ? ELSE ? END,sent=0,
      failure=CASE WHEN cancel_requested=1 THEN 'cancelled' ELSE 'interrupted' END
      WHERE botKey=? AND status='running'${retainedQuestionInputs.length ? ` AND (input IS NULL OR input NOT IN (${retainedQuestionInputs.map(() => "?").join(",")}))` : ""}`)
      .run(
        JSON.stringify([cancellationNotice]),
        JSON.stringify([failureText("interrupted")]),
        botKey,
        ...retainedQuestionInputs,
      );
  }

  saveTurnProgress(id: number, progress: TurnProgress) {
    this.db
      .query(
        "UPDATE jobs SET progressStage=?,progressAt=?,progressDisconnected=? WHERE id=? AND status='running'",
      )
      .run(
        progress.stage,
        progress.observedAt,
        progress.disconnected ? 1 : 0,
        id,
      );
  }
  requestProgress(ship: string, request?: number, at = Date.now()) {
    return this.db
      .query<
        {
          request: number;
          stage: TurnProgress["stage"];
          observedAt: number;
          offline: number;
          status: JobStatus;
          failure: RequestFailure | null;
        },
        [string, number | null]
      >(
        `SELECT id AS request,progressStage AS stage,progressAt AS observedAt,progressDisconnected AS offline,status,failure FROM jobs
       WHERE botKey=? AND progressStage IS NOT NULL AND id=COALESCE(?,id) ORDER BY id DESC LIMIT 16`,
      )
      .all(ship, request ?? null)
      .map(({ offline, ...row }) => ({
        ...row,
        disconnected: !!offline,
        stale:
          row.status === "running" &&
          row.stage !== "completed" &&
          at - row.observedAt > 60_000,
      }));
  }
  offerQuestion(offer: QuestionOffer): QuestionOffer | undefined {
    return this.db.transaction(() => {
      this.db
        .query(
          "INSERT OR IGNORE INTO native_questions(token,botKey,formID,sessionID,inputID,jobID,fingerprint,expires,state,notified,recovering,recorded,publicationStarted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          offer.token,
          offer.botKey,
          offer.formID,
          offer.sessionID,
          offer.inputID,
          offer.jobID,
          offer.fingerprint,
          offer.expires,
          offer.state,
          offer.notified,
          offer.recovering,
          Date.now(),
          offer.publicationStarted ?? 0,
        );
      const existing = this.db
        .query<QuestionOffer, [string, string, string]>(
          "SELECT * FROM native_questions WHERE botKey=? AND sessionID=? AND formID=?",
        )
        .get(offer.botKey, offer.sessionID, offer.formID);
      if (
        !existing ||
        existing.inputID !== offer.inputID ||
        existing.jobID !== offer.jobID ||
        existing.fingerprint !== offer.fingerprint
      )
        return;
      // A clarification creates a thread on the original request, never a new source.
      this.db
        .query(
          "UPDATE jobs SET replyParent=COALESCE(replyParent,thread) WHERE id=? AND botKey=? AND input=? AND status='running'",
        )
        .run(offer.jobID, offer.botKey, offer.inputID);
      return existing;
    })();
  }

  /** A deleted native session is unknown work, never a successful completion. */
  failQuestionRecovery(offer: QuestionOffer) {
    this.db.transaction(() => {
      this.db
        .query(
          `UPDATE jobs SET status='responding',response=CASE WHEN cancel_requested=1 THEN ? ELSE ? END,failure=CASE WHEN cancel_requested=1 THEN 'cancelled' ELSE 'interrupted' END,sent=0 WHERE id=? AND botKey=? AND input=? AND status='running' AND EXISTS(SELECT 1 FROM native_questions WHERE token=? AND recovering=1)`,
        )
        .run(
          JSON.stringify([cancellationNotice]),
          JSON.stringify([failureText("interrupted")]),
          offer.jobID,
          offer.botKey,
          offer.inputID,
          offer.token,
        );
      this.db
        .query(
          "UPDATE native_questions SET state='closed',recovering=0 WHERE token=?",
        )
        .run(offer.token);
    })();
  }

  /** Thirty days of settled history. Active native work and recovery holds survive. */
  pruneIrcHistory(botKey: string, now: number) {
    const cutoff = now - 30 * 86_400_000;
    this.db.transaction(() => {
      this.db
        .query(`DELETE FROM native_questions WHERE rowid IN (SELECT rowid FROM native_questions WHERE botKey=? AND recorded<? AND recovering=0
        AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.id=native_questions.jobID AND j.status NOT IN ('done','failed')) ORDER BY recorded LIMIT 256)`)
        .run(botKey, cutoff);
      this.db
        .query(`DELETE FROM irc_question_sources WHERE rowid IN (SELECT rowid FROM irc_question_sources WHERE botKey=? AND recorded<?
        AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.botKey=irc_question_sources.botKey AND j.eventId=irc_question_sources.eventId AND j.status NOT IN ('done','failed'))
        AND NOT EXISTS(SELECT 1 FROM native_questions q WHERE q.botKey=irc_question_sources.botKey AND q.jobID IN (SELECT id FROM jobs WHERE botKey=irc_question_sources.botKey AND eventId=irc_question_sources.eventId)) ORDER BY recorded LIMIT 256)`)
        .run(botKey, cutoff);
      for (const table of ["irc_thread_messages", "irc_thread_memberships"]) {
        this.db
          .query(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE botKey=? AND recorded<?
          AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.botKey=${table}.botKey AND j.channel=${table}.channel AND CAST(COALESCE(j.replyParent,j.thread) AS TEXT)=${table}.root AND j.status NOT IN ('done','failed'))
          AND NOT EXISTS(SELECT 1 FROM irc_thread_memberships m WHERE m.botKey=${table}.botKey AND m.channel=${table}.channel AND m.root=${table}.root AND m.recorded>=?)
          AND NOT EXISTS(SELECT 1 FROM native_questions q JOIN jobs j ON j.id=q.jobID WHERE q.botKey=${table}.botKey AND j.channel=${table}.channel AND CAST(COALESCE(j.replyParent,j.thread) AS TEXT)=${table}.root) ORDER BY recorded LIMIT 256)`)
          .run(botKey, cutoff, cutoff);
      }
    })();
  }

  finishQuestionRecovery(offer: QuestionOffer) {
    this.db.transaction(() => {
      this.db
        .query(
          "UPDATE jobs SET status=CASE WHEN cancel_requested=1 THEN 'responding' ELSE 'done' END,response=CASE WHEN cancel_requested=1 THEN ? ELSE '[]' END,failure=CASE WHEN cancel_requested=1 THEN 'cancelled' ELSE NULL END WHERE id=? AND botKey=? AND input=? AND status='running' AND EXISTS(SELECT 1 FROM native_questions WHERE token=? AND recovering=1)",
        )
        .run(
          JSON.stringify([cancellationNotice]),
          offer.jobID,
          offer.botKey,
          offer.inputID,
          offer.token,
        );
      this.db
        .query(
          "UPDATE native_questions SET recovering=0,state='closed' WHERE token=?",
        )
        .run(offer.token);
    })();
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

  close() {
    this.db.close();
  }
}
