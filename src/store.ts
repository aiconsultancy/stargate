import { Database } from "bun:sqlite";

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
    `);
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
    this.db.query("UPDATE jobs SET status='running' WHERE id=?").run(id);
  }

  respond(id: number, chunks: string[]) {
    this.db
      .query("UPDATE jobs SET status='responding',response=?,sent=0 WHERE id=?")
      .run(JSON.stringify(chunks), id);
  }

  sent(id: number, count: number) {
    this.db.query("UPDATE jobs SET sent=? WHERE id=?").run(count, id);
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
      .query(`UPDATE jobs SET status='responding',response=?,sent=0
      WHERE botKey=? AND status='running'`)
      .run(
        JSON.stringify([
          "Pogo stopped during this request. Work may have run; it was not repeated. Check agent state before sending another request.",
        ]),
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
