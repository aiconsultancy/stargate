import { Database } from "bun:sqlite";
import { Result, Schema } from "effect";

const offerSchema = Schema.Struct({
  id: Schema.String,
  captain: Schema.String,
  account: Schema.String,
  messageID: Schema.optional(Schema.String),
  askedAt: Schema.Finite,
  deadline: Schema.Finite,
});

const trackedSchema = Schema.Struct({
  issue: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  /**
   * `asking`: one captain holds an open offer. `waiting`: a round ended and
   * the next starts at `nextRoundAt`. `accepting`: the asked captain accepted
   * and the versioned assignment is pending. `clearing`: the last round ended
   * and the give-up comment or flag clear is pending. `done`: finished.
   */
  state: Schema.Literals([
    "asking",
    "waiting",
    "accepting",
    "clearing",
    "done",
  ]),
  round: Schema.Finite,
  start: Schema.Finite,
  /** Captain user IDs in this round's order. */
  order: Schema.Array(Schema.String),
  /** Index in `order` of the captain asked now, or of the next one to ask. */
  position: Schema.Finite,
  offer: Schema.optional(offerSchema),
  nextRoundAt: Schema.optional(Schema.Finite),
  /** Offer whose timeout or decline was already handled in chat. */
  closedOffer: Schema.optional(Schema.String),
  /**
   * Index in `order` to ask after `closedOffer` when it is not the next one:
   * an offer the chat connection could not deliver asks the same captain.
   */
  resume: Schema.optional(Schema.Finite),
  /** Give-up progress: the comment is recorded before the flag is cleared. */
  commented: Schema.optional(Schema.Boolean),
  /** Issue version after Stargate's own final write, when known. */
  doneVersion: Schema.optional(Schema.Finite),
  outcome: Schema.optional(Schema.String),
  updatedAt: Schema.Finite,
});

/**
 * An assignment listing longer than one poll's page budget, read over
 * several polls. The API cursor is bound to the same filter, so the
 * assignees and `since` are kept with it.
 */
const walkSchema = Schema.Struct({
  /** Captain user IDs the listing filters on, sorted. */
  assignees: Schema.Array(Schema.String),
  /** The listing's `updatedSince`; absent for the first start's full read. */
  since: Schema.optional(Schema.String),
  /** API cursor of the next page to read. */
  cursor: Schema.String,
  /** When the listing began (ms). */
  startedAt: Schema.Finite,
  /** Newest server `updatedAt` seen so far, the earlier cursor included. */
  newest: Schema.optional(Schema.String),
  /** Oldest `updatedAt` of a notice that is still to be sent. */
  hold: Schema.optional(Schema.String),
});

export type AssignmentWalk = typeof walkSchema.Type;

export type DispatchOfferRecord = typeof offerSchema.Type;

export type TrackedIssue = {
  -readonly [
    K in keyof typeof trackedSchema.Type
  ]: (typeof trackedSchema.Type)[K];
};

/**
 * Durable dispatcher state, private to the rear admiral's gateway: issues
 * already notified (behaviour 1) and offer progress (behaviour 2). Every
 * change is written before the chat message it leads to, so a restart never
 * loses a pending offer; a crash between the write and the send can at most
 * leave an offer that times out unanswered.
 */
export class DispatchLedger {
  private readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_meta (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dispatch_notified (
        issue TEXT NOT NULL, assignee TEXT NOT NULL, identifier TEXT NOT NULL,
        at INTEGER NOT NULL, sent INTEGER NOT NULL,
        PRIMARY KEY(issue, assignee)
      );
      CREATE TABLE IF NOT EXISTS dispatch_issues (
        issue TEXT PRIMARY KEY, state TEXT NOT NULL, offerID TEXT,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dispatch_issues_offer ON dispatch_issues(offerID);
    `);
  }

  close() {
    this.db.close();
  }

  private meta(key: string): string | undefined {
    return (
      this.db
        .query<{ value: string }, [string]>(
          "SELECT value FROM dispatch_meta WHERE key=?",
        )
        .get(key)?.value ?? undefined
    );
  }

  private setMeta(key: string, value: string) {
    this.db
      .query(
        "INSERT INTO dispatch_meta(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }

  /** Whether the first poll has recorded the existing assignments. */
  get initialised() {
    return this.meta("initialised") === "1";
  }

  markInitialised() {
    this.setMeta("initialised", "1");
  }

  /** Server `updatedAt` of the newest assigned issue seen (behaviour 1). */
  get cursor() {
    return this.meta("cursor");
  }

  set cursor(value: string | undefined) {
    if (value !== undefined) this.setMeta("cursor", value);
  }

  /** An unfinished assignment listing; an unreadable value starts it again. */
  get assignmentWalk(): AssignmentWalk | undefined {
    const value = this.meta("assignmentWalk");

    if (value === undefined) return undefined;

    const parsed = Schema.decodeUnknownResult(
      Schema.fromJsonString(walkSchema),
    )(value);

    return Result.isSuccess(parsed) ? parsed.success : undefined;
  }

  set assignmentWalk(value: AssignmentWalk | undefined) {
    if (value === undefined)
      this.db
        .query("DELETE FROM dispatch_meta WHERE key=?")
        .run("assignmentWalk");
    else
      this.setMeta(
        "assignmentWalk",
        JSON.stringify(Schema.encodeUnknownSync(walkSchema)(value)),
      );
  }

  /** One-time log flags, so a restart does not repeat a warning every poll. */
  flag(name: string) {
    return this.meta(`flag:${name}`) === "1";
  }

  setFlag(name: string, on: boolean) {
    if (on) this.setMeta(`flag:${name}`, "1");
    else
      this.db
        .query("DELETE FROM dispatch_meta WHERE key=?")
        .run(`flag:${name}`);
  }

  /** A strictly increasing counter: who is asked first moves on per issue. */
  nextRotation(): number {
    return this.db
      .transaction(() => {
        const value = Number(this.meta("rotation") ?? "0");
        const current = Number.isSafeInteger(value) && value >= 0 ? value : 0;
        this.setMeta("rotation", String(current + 1));

        return current;
      })
      .immediate();
  }

  notified(issue: string, assignee: string) {
    return (
      this.db
        .query<{ sent: number }, [string, string]>(
          "SELECT sent FROM dispatch_notified WHERE issue=? AND assignee=?",
        )
        .get(issue, assignee) !== null
    );
  }

  recordNotified(
    issue: string,
    assignee: string,
    identifier: string,
    at: number,
    sent: boolean,
  ) {
    this.db
      .query(
        "INSERT OR IGNORE INTO dispatch_notified(issue, assignee, identifier, at, sent) VALUES(?,?,?,?,?)",
      )
      .run(issue, assignee, identifier, Math.floor(at), sent ? 1 : 0);
  }

  /** An unreadable row is skipped, never fatal to the rest of the ledger. */
  private decode(value: string): TrackedIssue | undefined {
    const parsed = Schema.decodeUnknownResult(
      Schema.fromJsonString(trackedSchema),
    )(value);

    if (Result.isFailure(parsed)) return;

    return { ...parsed.success, order: [...parsed.success.order] };
  }

  tracked(issue: string): TrackedIssue | undefined {
    const row = this.db
      .query<{ value: string }, [string]>(
        "SELECT value FROM dispatch_issues WHERE issue=?",
      )
      .get(issue);

    return row ? this.decode(row.value) : undefined;
  }

  /** Every issue that is not done, oldest change first. */
  active(): TrackedIssue[] {
    return this.db
      .query<{ value: string }, []>(
        "SELECT value FROM dispatch_issues WHERE state <> 'done'",
      )
      .all()
      .flatMap((row) => {
        const value = this.decode(row.value);

        return value ? [value] : [];
      })
      .sort(
        (a, b) => a.updatedAt - b.updatedAt || a.issue.localeCompare(b.issue),
      );
  }

  byOffer(offerID: string): TrackedIssue | undefined {
    const row = this.db
      .query<{ value: string }, [string]>(
        "SELECT value FROM dispatch_issues WHERE offerID=?",
      )
      .get(offerID);

    return row ? this.decode(row.value) : undefined;
  }

  save(value: TrackedIssue) {
    const encoded = Schema.encodeUnknownSync(trackedSchema)(value);
    this.db
      .query(
        "INSERT INTO dispatch_issues(issue, state, offerID, value) VALUES(?,?,?,?) ON CONFLICT(issue) DO UPDATE SET state=excluded.state, offerID=excluded.offerID, value=excluded.value",
      )
      .run(
        value.issue,
        value.state,
        value.offer?.id ?? null,
        JSON.stringify(encoded),
      );
  }

  /** Bounded retention for finished work; open offers are never removed. */
  prune(now: number, keepMs = 30 * 24 * 3_600_000) {
    for (const row of this.db
      .query<{ issue: string; value: string }, []>(
        "SELECT issue, value FROM dispatch_issues WHERE state='done'",
      )
      .all()) {
      const value = this.decode(row.value);

      if (!value || value.updatedAt < now - keepMs)
        this.db
          .query("DELETE FROM dispatch_issues WHERE issue=?")
          .run(row.issue);
    }
  }
}
