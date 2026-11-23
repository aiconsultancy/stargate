import type { Database } from "bun:sqlite";
import { outboxMaxAgeMs } from "./irc-rpc";

/** One stargate_dm for Stargate's IRC copy; members are team IDs. */
export type OutboxItem = {
  sequence: number;
  /** Mesij receipt ID: stable across retries, the IRC dedupe key. */
  id: string;
  from: { role: "captain" | "crew"; id: string };
  to: { role: "captain" | "crew"; id: string };
  text: string;
  /** Time the stargate_dm was stored (ms). */
  created: number;
};

const outboxMs = outboxMaxAgeMs;
const outboxRows = 1000;

function role(value: string): "captain" | "crew" {
  return value === "captain" ? "captain" : "crew";
}

/**
 * Stargate IRC sessions bound to the crew member they serve. Stargate binds a crew
 * IRC session after it creates it (CrewIrc RPC from the captain location);
 * the engine validates the native session first. A binding never moves to
 * another member. Bound sessions may use stargate_dm and stargate_mail as that
 * member; they never get a task, and nothing ever prompts them.
 */
export class IrcSessions {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS irc_sessions (
      sessionID TEXT PRIMARY KEY, crewID TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS irc_dm_outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      fromRole TEXT NOT NULL, fromID TEXT NOT NULL,
      toRole TEXT NOT NULL, toID TEXT NOT NULL,
      text TEXT NOT NULL, created INTEGER NOT NULL
    );`);
  }

  /**
   * Record one stored stargate_dm for Stargate's IRC copy (see `outbox`), once per
   * Mesij receipt. Rows older than `outboxMs`, and beyond `outboxRows`,
   * are pruned: a copy is a convenience, never the record.
   */
  enqueue(item: Omit<OutboxItem, "sequence" | "created">, now = Date.now()) {
    this.db
      .transaction(() => {
        this.db
          .query(
            "INSERT OR IGNORE INTO irc_dm_outbox (id,fromRole,fromID,toRole,toID,text,created) VALUES (?,?,?,?,?,?,?)",
          )
          .run(
            item.id,
            item.from.role,
            item.from.id,
            item.to.role,
            item.to.id,
            item.text,
            now,
          );
        this.db
          .query(
            "DELETE FROM irc_dm_outbox WHERE created<? OR sequence<=(SELECT MAX(sequence) FROM irc_dm_outbox)-?",
          )
          .run(now - outboxMs, outboxRows);
      })
      .immediate();
  }

  /**
   * Items after `after`, oldest first, and the newest sequence. Without
   * `after` there are no items: the caller starts from `latest`. Entries
   * older than `outboxMs` are never listed, however long the reader was
   * away; one snapshot, so no items with `latest` past `after` means every
   * later entry expired.
   */
  outbox(
    input: { after?: number | undefined; limit: number },
    now = Date.now(),
  ) {
    return this.db
      .transaction(() => this.page(input, now - outboxMs))
      .immediate();
  }

  private page(
    input: { after?: number | undefined; limit: number },
    oldest: number,
  ) {
    const latest =
      this.db
        .query<{ sequence: number | null }, []>(
          "SELECT MAX(sequence) AS sequence FROM irc_dm_outbox",
        )
        .get()?.sequence ??
      this.db
        .query<{ seq: number }, []>(
          "SELECT seq FROM sqlite_sequence WHERE name='irc_dm_outbox'",
        )
        .get()?.seq ??
      0;

    if (input.after === undefined) return { items: [], latest };

    const items = this.db
      .query<
        {
          sequence: number;
          id: string;
          fromRole: string;
          fromID: string;
          toRole: string;
          toID: string;
          text: string;
          created: number;
        },
        [number, number, number]
      >(
        "SELECT sequence,id,fromRole,fromID,toRole,toID,text,created FROM irc_dm_outbox WHERE sequence>? AND created>=? ORDER BY sequence LIMIT ?",
      )
      .all(input.after, oldest, input.limit)
      .map((row): OutboxItem => ({
        sequence: row.sequence,
        id: row.id,
        from: { role: role(row.fromRole), id: row.fromID },
        to: { role: role(row.toRole), id: row.toID },
        text: row.text,
        created: row.created,
      }));

    return { items, latest };
  }

  crewID(sessionID: string): string | undefined {
    return (
      this.db
        .query<{ crewID: string }, [string]>(
          "SELECT crewID FROM irc_sessions WHERE sessionID=?",
        )
        .get(sessionID)?.crewID ?? undefined
    );
  }

  sessions() {
    return this.db
      .query<{ sessionID: string; crewID: string }, []>(
        "SELECT sessionID,crewID FROM irc_sessions ORDER BY rowid",
      )
      .all();
  }

  /** True when the session is now bound to `crewID` (new or unchanged). */
  bind(sessionID: string, crewID: string) {
    this.db
      .query("INSERT OR IGNORE INTO irc_sessions VALUES (?,?)")
      .run(sessionID, crewID);

    return this.crewID(sessionID) === crewID;
  }
}
