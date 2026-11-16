import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type DispatchResult,
  FleetError,
  type FleetSource,
  type FleetTarget,
  sourceSchema,
  type VerifiedSource,
} from "./protocol";

type SourceRow = { ownerSessionID: string; value: string };
type DispatchRow = { fingerprint: string; value: string };

/** Gateway-only state. The engine may connect its socket, never open this DB. */
export class FleetLedger {
  private readonly db: Database;
  constructor(path: string) {
    if (path !== ":memory:") {
      if (resolve(path) !== path)
        throw new FleetError(
          "Fleet ledger path must be absolute and normalised.",
        );
      if (lstatSync(dirname(path)).mode & 0o007)
        throw new FleetError(
          "Fleet ledger directory must exclude other users.",
        );
      let ancestor = dirname(path);
      while (true) {
        const info = lstatSync(ancestor);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          (info.mode & 0o002 && !(info.mode & 0o1000))
        )
          throw new FleetError("Fleet ledger directory is unsafe.");
        if (ancestor === dirname(ancestor)) break;
        ancestor = dirname(ancestor);
      }
      const fd = openSync(
        path,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o660,
      );
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.mode & 0o007)
          throw new FleetError("Fleet ledger must be a private regular file.");
        // A shared gateway group may open a file created by another gateway.
        // Only the owner can chmod it; existing group permissions stay intact.
        if (info.uid === process.getuid?.()) fchmodSync(fd, 0o660);
      } finally {
        closeSync(fd);
      }
    }
    const mask = process.umask(0o007);
    try {
      this.db = new Database(path, { create: true, strict: true });
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
      );
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS fleet_sources (
          reference TEXT PRIMARY KEY, ownerSessionID TEXT NOT NULL, value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS fleet_dispatches (
          ownerSessionID TEXT NOT NULL, requestID TEXT NOT NULL,
          fingerprint TEXT NOT NULL, value TEXT NOT NULL,
          PRIMARY KEY(ownerSessionID, requestID)
        );
        CREATE TABLE IF NOT EXISTS fleet_source_delegations (
          reference TEXT NOT NULL REFERENCES fleet_sources(reference),
          targetSessionID TEXT NOT NULL, ownerSessionID TEXT NOT NULL, requestID TEXT NOT NULL,
          PRIMARY KEY(reference, targetSessionID, ownerSessionID, requestID)
        );
      `);
    } finally {
      process.umask(mask);
    }
  }

  close() {
    this.db.close();
  }

  record(ownerSessionID: string, input: FleetSource): VerifiedSource {
    const source = sourceSchema.parse(input);
    const value = JSON.stringify(source);
    return this.db
      .transaction(() => {
        const old = this.db
          .query<SourceRow, [string]>(
            "SELECT ownerSessionID, value FROM fleet_sources WHERE reference=?",
          )
          .get(source.reference);
        if (old) {
          const original = sourceSchema.parse(JSON.parse(old.value));
          if (
            old.ownerSessionID !== ownerSessionID ||
            old.value !==
              JSON.stringify({ ...source, receivedAt: original.receivedAt })
          )
            throw new FleetError(
              "Source reference already belongs to different authenticated evidence.",
            );
          return { ...original, ownerSessionID, humanApproval: false as const };
        }
        this.db
          .query(
            "INSERT OR IGNORE INTO fleet_sources(reference, ownerSessionID, value) VALUES(?,?,?)",
          )
          .run(source.reference, ownerSessionID, value);
        return { ...source, ownerSessionID, humanApproval: false as const };
      })
      .immediate();
  }

  verify(sessionID: string, reference: string): VerifiedSource {
    const row = this.db
      .query<
        SourceRow,
        [string, string, string]
      >(`SELECT ownerSessionID, value FROM fleet_sources
      WHERE reference=? AND (ownerSessionID=? OR EXISTS (
        SELECT 1 FROM fleet_source_delegations WHERE fleet_source_delegations.reference=fleet_sources.reference AND targetSessionID=?
      ))`)
      .get(reference, sessionID, sessionID);
    if (!row)
      throw new FleetError(
        "Original source is unavailable to this pinned session.",
      );
    return {
      ...sourceSchema.parse(JSON.parse(row.value)),
      ownerSessionID: row.ownerSessionID,
      humanApproval: false,
    };
  }

  reserve(input: {
    ownerSessionID: string;
    requestID: string;
    source: VerifiedSource;
    target: FleetTarget;
    senderAccount: string;
    text: string;
  }): { created: boolean; result: DispatchResult } {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    return this.db
      .transaction(() => {
        const existing = this.read(input.ownerSessionID, input.requestID);
        if (existing) {
          if (existing.fingerprint !== fingerprint)
            throw new FleetError(
              "Dispatch request ID was already used for different work.",
            );
          return {
            created: false,
            result: JSON.parse(existing.value) as DispatchResult,
          };
        }
        // Unknown BEFORE any external write: process death can never admit replay.
        const result: DispatchResult = {
          requestID: input.requestID,
          target: input.target,
          sourceReference: input.source.reference,
          senderAccount: input.senderAccount,
          state: "unknown",
          humanApproval: false,
        };
        this.db
          .query(
            "INSERT INTO fleet_dispatches(ownerSessionID,requestID,fingerprint,value) VALUES(?,?,?,?)",
          )
          .run(
            input.ownerSessionID,
            input.requestID,
            fingerprint,
            JSON.stringify(result),
          );
        this.db
          .query(
            "INSERT OR IGNORE INTO fleet_source_delegations(reference,targetSessionID,ownerSessionID,requestID) VALUES(?,?,?,?)",
          )
          .run(
            input.source.reference,
            input.target.sessionID,
            input.ownerSessionID,
            input.requestID,
          );
        return { created: true, result };
      })
      .immediate();
  }

  private read(sessionID: string, requestID: string) {
    return this.db
      .query<DispatchRow, [string, string]>(
        "SELECT fingerprint,value FROM fleet_dispatches WHERE ownerSessionID=? AND requestID=?",
      )
      .get(sessionID, requestID);
  }

  dispatch(sessionID: string, requestID: string): DispatchResult | undefined {
    const row = this.read(sessionID, requestID);
    return row ? (JSON.parse(row.value) as DispatchResult) : undefined;
  }

  sent(sessionID: string, result: DispatchResult): DispatchResult {
    const sent = { ...result, state: "sent" as const };
    this.db
      .query(
        "UPDATE fleet_dispatches SET value=? WHERE ownerSessionID=? AND requestID=?",
      )
      .run(JSON.stringify(sent), sessionID, result.requestID);
    return sent;
  }
}
