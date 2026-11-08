import { Database } from "bun:sqlite";
import { z } from "zod";
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
};

export type Job = Incoming & {
  id: number;
  status: "queued" | "running" | "responding" | "done" | "failed";
  response: string | null;
  sent: number;
  attempts: number;
  failure?: RequestFailure | null;
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
    `);
    const column = (table: string, name: string, type: string) => {
      if (
        !this.db
          .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
          .all()
          .some((column) => column.name === name)
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    };
    column("jobs", "cancel_requested", "INTEGER NOT NULL DEFAULT 0");
    column("jobs", "failure", "TEXT");
    column("jobs", "activity", "TEXT");
    // Newest native message accounted for in Slack; NULL needs a baseline.
    column("sessions", "cursor", "TEXT");
    // Server-wide settle events look up mappings by native session ID.
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS sessions_session ON sessions(session_id)",
    );
  }

  enqueue(input: Incoming): boolean {
    return (
      this.db
        .query(`INSERT OR IGNORE INTO jobs
      (eventId,botKey,conversation,channel,thread,user,text)
      VALUES ($eventId,$botKey,$conversation,$channel,$thread,$user,$text)`)
        .run({
          $eventId: input.eventId,
          $botKey: input.botKey,
          $conversation: input.conversation,
          $channel: input.channel,
          $thread: input.thread,
          $user: input.user,
          $text: input.text,
        }).changes > 0
    );
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
    return this.db
      .query<Job, [string, string]>(
        "SELECT * FROM jobs WHERE botKey=? AND conversation=? AND activity IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
      .get(botKey, conversation);
  }

  follows(conversation: string): boolean {
    return (
      this.db
        .query("SELECT 1 FROM jobs WHERE conversation = ? LIMIT 1")
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

  /** The mapped session plus the latest request's Slack destination. */
  transcriptTarget(botKey: string, conversation: string) {
    const row = this.db
      .query<
        {
          session: string;
          cursor: string | null;
          channel: string;
          thread: string;
          user: string;
        },
        [string, string]
      >(`SELECT s.session_id AS session, s.cursor, j.channel, j.thread, j.user
      FROM sessions s JOIN jobs j ON j.conversation=s.conversation
      WHERE j.botKey=? AND s.conversation=? ORDER BY j.id DESC LIMIT 1`)
      .get(botKey, conversation);
    return row && { ...row, cursor: row.cursor ?? undefined };
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
    replies: { eventId: string; chunks: string[] }[];
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
          .query(`UPDATE jobs SET status='responding',attempts=0,retry_at=0
          WHERE botKey=? AND conversation=? AND eventId=? AND status='failed'`)
          .run(input.botKey, input.conversation, eventId).changes;
      for (const reply of input.replies) {
        queued += this.db
          .query(`INSERT OR IGNORE INTO jobs
          (eventId,botKey,conversation,channel,thread,user,text,status,response)
          VALUES (?,?,?,?,?,?,'','responding',?)`)
          .run(
            reply.eventId,
            input.botKey,
            input.conversation,
            target.channel,
            target.thread,
            target.user,
            JSON.stringify(reply.chunks),
          ).changes;
      }
      // An existing row would be skipped silently; never advance past it.
      if (queued !== input.replies.length + (input.requeue?.length ?? 0))
        throw new TranscriptConflict();
      return queued;
    })();
  }

  ready(botKey: string, now: number, limit: number): Job[] {
    return this.db
      .query<Job, [string, number, number]>(`SELECT * FROM jobs j
      WHERE botKey = ? AND status IN ('queued','responding') AND retry_at <= ?
      AND NOT EXISTS (SELECT 1 FROM jobs earlier
        WHERE earlier.conversation=j.conversation AND earlier.id < j.id
        AND earlier.status IN ('queued','running','responding'))
      ORDER BY id LIMIT ?`)
      .all(botKey, now, limit);
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
          "UPDATE jobs SET status='responding',response=?,failure=?,sent=0 WHERE id=?",
        )
        .run(
          JSON.stringify(response),
          cancelled ? "cancelled" : (failure ?? null),
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

  close() {
    this.db.close();
  }
}
