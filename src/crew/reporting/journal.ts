import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { redactCredentials } from "../../lib/credentials";

export const journalInputSchema = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("append"),
    text: Schema.Trim.check(
      Schema.isMinCodePoints(1),
      Schema.isMaxCodePoints(64_000),
    ),
  }),
  Schema.Struct({
    op: Schema.Literal("read"),
    after: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
      Schema.withDecodingDefault(Effect.succeed(0)),
    ),
    member: Schema.optional(
      Schema.String.check(
        Schema.isMinCodePoints(1),
        Schema.isMaxCodePoints(64),
      ),
    ),
    limit: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: 100 }),
    ).pipe(Schema.withDecodingDefault(Effect.succeed(20))),
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
  public constructor(private readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL,
      member TEXT NOT NULL, captainID TEXT NOT NULL, taskID TEXT,
      kind TEXT NOT NULL, text TEXT NOT NULL, replayKey TEXT NOT NULL,
      UNIQUE(member,replayKey)
    );
    CREATE INDEX IF NOT EXISTS journal_context ON journal(captainID,id);`);
  }

  public append(
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
        redactCredentials(input.text),
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

  public head(): number {
    return (
      this.db
        .query<{ id: number }, []>(
          "SELECT COALESCE(MAX(id),0) AS id FROM journal",
        )
        .get()?.id ?? 0
    );
  }

  /** `null` reads every captain context of a pinned single-captain team. */
  public read(
    captainID: string | null,
    after: number,
    limit: number,
    member?: string,
  ) {
    const scope = captainID === null ? "captainID!=''" : "captainID=?1";

    const entries = this.db
      .query<JournalEntry, [string, number, string | null, number]>(
        `SELECT id,created,member,captainID,taskID,kind,text FROM journal
       WHERE ${scope} AND id>?2 AND (?3 IS NULL OR member=?3) ORDER BY id LIMIT ?4`,
      )
      .all(captainID ?? "", after, member ?? null, limit + 1);

    const truncated = entries.length > limit;

    if (truncated) entries.pop();

    return { entries, nextAfter: entries.at(-1)?.id ?? after, truncated };
  }

  public window(
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
