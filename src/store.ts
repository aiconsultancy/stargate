import { Database } from "bun:sqlite";
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
    if (
      !this.db
        .query<{ name: string }, []>("PRAGMA table_info(jobs)")
        .all()
        .some((column) => column.name === "cancel_requested")
    )
      this.db.exec(
        "ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0",
      );
    if (
      !this.db
        .query<{ name: string }, []>("PRAGMA table_info(jobs)")
        .all()
        .some((column) => column.name === "failure")
    )
      this.db.exec("ALTER TABLE jobs ADD COLUMN failure TEXT");
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

  saveSession(conversation: string, id: string) {
    this.db
      .query("INSERT INTO sessions (conversation,session_id) VALUES (?,?)")
      .run(conversation, id);
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

  respond(id: number, chunks: string[], failure?: RequestFailure) {
    const row = this.db
      .query<
        { response: string },
        [string, string, string | null, number]
      >(`UPDATE jobs SET status='responding',
        response=CASE WHEN cancel_requested=1 THEN ? ELSE ? END,
        failure=CASE WHEN cancel_requested=1 THEN 'cancelled' ELSE ? END,sent=0
        WHERE id=? RETURNING response`)
      .get(
        JSON.stringify([cancellationNotice]),
        JSON.stringify(chunks),
        failure ?? null,
        id,
      );
    if (!row) throw new Error("Response job not found");
    return JSON.parse(row.response) as string[];
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
