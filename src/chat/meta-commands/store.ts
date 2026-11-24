import type { Database } from "bun:sqlite";

export interface MetaReceipt {
  registration: string;
  message: string;
  channel: string;
  thread: string;
  user: string;
  at: number;
  command: string;
  state: "pending" | "applied";
  oldDelayMs: number | null;
  newDelayMs: number | null;
  reply: string | null;
  delivered: number;
}

/** One message-bound config panel. The snapshot contains hashes/status only. */
export interface ConfigPanelRecord {
  nonce: string;
  registration: string;
  message: string;
  channel: string;
  thread: string;
  ts: string | null;
  createdAt: number;
  revision: number;
  snapshot: string;
  user: string;
  at: number;
}

export class MetaRecords {
  public constructor(private readonly db: Database) {}

  public metaReceipt(
    registration: string,
    message: string,
  ): MetaReceipt | null {
    return this.db
      .query<MetaReceipt, [string, string]>(
        "SELECT * FROM meta_receipts WHERE registration=? AND message=?",
      )
      .get(registration, message);
  }

  public configPanel(
    registration: string,
    nonce: string,
  ): ConfigPanelRecord | null {
    return this.db
      .query<ConfigPanelRecord, [string, string]>(
        "SELECT * FROM config_panels WHERE registration=? AND nonce=?",
      )
      .get(registration, nonce);
  }

  public configPanelForMessage(
    registration: string,
    message: string,
  ): ConfigPanelRecord | null {
    return this.db
      .query<ConfigPanelRecord, [string, string]>(
        "SELECT * FROM config_panels WHERE registration=? AND message=?",
      )
      .get(registration, message);
  }

  public createConfigPanel(panel: ConfigPanelRecord) {
    this.db
      .query(`INSERT INTO config_panels
      (nonce,registration,message,channel,thread,ts,createdAt,revision,snapshot,user,at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        panel.nonce,
        panel.registration,
        panel.message,
        panel.channel,
        panel.thread,
        panel.ts,
        panel.createdAt,
        panel.revision,
        panel.snapshot,
        panel.user,
        panel.at,
      );
  }

  public bindConfigPanel(registration: string, nonce: string, ts: string) {
    const changed = this.db
      .query(`UPDATE config_panels SET ts=?
      WHERE registration=? AND nonce=? AND ts IS NULL`)
      .run(ts, registration, nonce).changes;

    if (changed !== 1) {
      throw new Error("Config panel binding unavailable");
    }
  }

  public pendingConfigPanel(registration: string, nonce: string): boolean {
    return (
      this.db
        .query(`SELECT 1 FROM meta_receipts
      WHERE registration=? AND message LIKE ? AND state='pending' LIMIT 1`)
        .get(registration, `panel:${nonce}:%`) !== null
    );
  }

  /** Applied receipt and next revision become durable together, before delivery. */
  public applyConfigPanel(
    panel: ConfigPanelRecord,
    message: string,
    reply: string,
    oldDelayMs: number | null,
    newDelayMs: number | null,
  ) {
    this.db.transaction(() => {
      const changed = this.db
        .query(`UPDATE config_panels SET
        revision=?,snapshot=?,user=?,at=? WHERE registration=? AND nonce=? AND revision=?`)
        .run(
          panel.revision,
          panel.snapshot,
          panel.user,
          panel.at,
          panel.registration,
          panel.nonce,
          panel.revision - 1,
        ).changes;

      if (changed !== 1) {
        throw new Error("Config panel revision changed");
      }

      this.applyMeta(
        panel.registration,
        message,
        reply,
        oldDelayMs,
        newDelayMs,
      );
    })();
  }

  /** Claim before touching the shared waiting file; pending never replays. */
  public claimMeta(
    input: Pick<
      MetaReceipt,
      | "registration"
      | "message"
      | "channel"
      | "thread"
      | "user"
      | "at"
      | "command"
    >,
  ): boolean {
    return (
      this.db
        .query(`INSERT OR IGNORE INTO meta_receipts
      (registration,message,channel,thread,user,at,command) VALUES (?,?,?,?,?,?,?)`)
        .run(
          input.registration,
          input.message,
          input.channel,
          input.thread,
          input.user,
          input.at,
          input.command,
        ).changes === 1
    );
  }

  public applyMeta(
    registration: string,
    message: string,
    reply: string,
    oldDelayMs: number | null = null,
    newDelayMs: number | null = null,
  ) {
    const changed = this.db
      .query(`UPDATE meta_receipts SET state='applied',
      reply=?,oldDelayMs=?,newDelayMs=? WHERE registration=? AND message=? AND state='pending'`)
      .run(reply, oldDelayMs, newDelayMs, registration, message).changes;

    if (changed !== 1) {
      throw new Error("Meta command claim unavailable");
    }
  }

  public deliverMeta(registration: string, message: string) {
    this.db
      .query(
        "UPDATE meta_receipts SET delivered=1 WHERE registration=? AND message=?",
      )
      .run(registration, message);
  }

  /** Only a fresh claim proven to have made no write can be released. */
  public releaseMetaClaim(registration: string, message: string) {
    this.db
      .query(`DELETE FROM meta_receipts WHERE registration=? AND message=?
      AND state='pending' AND delivered=0 AND reply IS NULL`)
      .run(registration, message);
  }
}
