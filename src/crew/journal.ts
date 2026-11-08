import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import { redactActivity } from "./reporting";

export const journalInputSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("append"),
    text: z.string().trim().min(1).max(64000),
  }),
  z.strictObject({
    op: z.literal("read"),
    after: z.number().int().safe().nonnegative().default(0),
    member: z.string().min(1).max(64).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
]);
export type JournalEntry = {
  id: number;
  created: number;
  member: string;
  captainID: string;
  taskID: string | null;
  kind: "note" | "assignment" | "update" | "message" | "result";
  text: string;
};

/** Append-only milestones, independent of temporary Slack captures. */
export class JournalStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL,
      member TEXT NOT NULL, captainID TEXT NOT NULL, taskID TEXT,
      kind TEXT NOT NULL, text TEXT NOT NULL, replayKey TEXT NOT NULL,
      UNIQUE(member,replayKey)
    );
    CREATE INDEX IF NOT EXISTS journal_context ON journal(captainID,id);`);
  }

  append(
    input: Omit<JournalEntry, "id" | "created">,
    replayKey: string,
  ): JournalEntry {
    replayKey = createHash("sha256").update(replayKey).digest("hex");
    this.db
      .query(`INSERT OR IGNORE INTO journal
      (created,member,captainID,taskID,kind,text,replayKey) VALUES (?,?,?,?,?,?,?)`)
      .run(
        Date.now(),
        input.member,
        input.captainID,
        input.taskID,
        input.kind,
        redactActivity(input.text),
        replayKey,
      );
    const entry = this.db
      .query<JournalEntry, [string, string]>(
        "SELECT id,created,member,captainID,taskID,kind,text FROM journal WHERE member=? AND replayKey=?",
      )
      .get(input.member, replayKey);
    if (!entry) throw new Error("Journal append unavailable");
    return entry;
  }

  head(): number {
    return (
      this.db
        .query<{ id: number }, []>(
          "SELECT COALESCE(MAX(id),0) AS id FROM journal",
        )
        .get()?.id ?? 0
    );
  }

  read(captainID: string, after: number, limit: number, member?: string) {
    const entries = this.db
      .query<
        JournalEntry,
        [string, number, string | null, string | null, number]
      >(
        `SELECT id,created,member,captainID,taskID,kind,text FROM journal
       WHERE captainID=? AND id>? AND (? IS NULL OR member=?) ORDER BY id LIMIT ?`,
      )
      .all(captainID, after, member ?? null, member ?? null, limit + 1);
    const truncated = entries.length > limit;
    if (truncated) entries.pop();
    return { entries, nextAfter: entries.at(-1)?.id ?? after, truncated };
  }

  window(
    captainID: string,
    after: number,
    end: number | null,
    excluded: string,
    limit: number,
  ) {
    return this.db
      .query<
        JournalEntry,
        [string, number, number | null, number | null, string, number]
      >(
        `SELECT id,created,member,captainID,taskID,kind,text FROM journal
       WHERE captainID=? AND id>? AND (? IS NULL OR id<=?) AND member!=?
       ORDER BY id DESC LIMIT ?`,
      )
      .all(captainID, after, end, end, excluded, limit)
      .reverse();
  }
}
