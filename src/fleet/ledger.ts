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
  type FleetCompletion,
  FleetError,
  type FleetOrigin,
  type FleetResultDelivery,
  type FleetSource,
  type FleetTarget,
  fleetAssignmentText,
  fleetCompletionSchema,
  fleetOriginSchema,
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
        CREATE TABLE IF NOT EXISTS fleet_results (
          dispatchID TEXT PRIMARY KEY, ownerSessionID TEXT NOT NULL,
          origin TEXT NOT NULL, target TEXT NOT NULL,
          sourceReference TEXT NOT NULL,
          senderAccount TEXT NOT NULL, assignment TEXT NOT NULL,
          targetBotKey TEXT, targetEvent TEXT, targetAccount TEXT, targetInput TEXT, completion TEXT,
          acknowledged INTEGER NOT NULL DEFAULT 0
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
    origin?: FleetOrigin;
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
          ...(input.origin
            ? {
                dispatchID: createHash("sha256")
                  .update(
                    JSON.stringify([input.ownerSessionID, input.requestID]),
                  )
                  .digest("hex"),
              }
            : {}),
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
        if (input.origin && result.dispatchID) {
          const origin = fleetOriginSchema.parse(input.origin);
          if (origin.sessionID !== input.ownerSessionID)
            throw new FleetError(
              "Fleet result origin does not match its owner pin",
            );
          this.db
            .query(`INSERT INTO fleet_results
            (dispatchID,ownerSessionID,origin,target,sourceReference,senderAccount,assignment)
            VALUES(?,?,?,?,?,?,?)`)
            .run(
              result.dispatchID,
              input.ownerSessionID,
              JSON.stringify(origin),
              JSON.stringify(input.target),
              input.source.reference,
              input.senderAccount,
              fleetAssignmentText(result, input.text, input.source.authority),
            );
        }
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
    if (!row) return;
    const result = JSON.parse(row.value) as DispatchResult;
    if (!result.dispatchID) return result;
    const outbox = this.db
      .query<
        { completion: string | null; acknowledged: number },
        [string, string]
      >(
        "SELECT completion,acknowledged FROM fleet_results WHERE dispatchID=? AND ownerSessionID=?",
      )
      .get(result.dispatchID, sessionID);
    return outbox?.completion
      ? {
          ...result,
          completion: fleetCompletionSchema.parse(
            JSON.parse(outbox.completion),
          ),
          resultQueued: outbox.acknowledged === 1,
        }
      : result;
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

  /** Exact trusted gateway delegation, not a model-written dispatch label. */
  assignment(
    input: {
      sessionID: string;
      account: string;
      sender: string;
      channel: string;
      text: string;
      botKey: string;
      eventId: string;
    },
    fold: (value: string) => string,
  ): string | undefined {
    if (!input.text.startsWith("[fleet_dispatch ")) return;
    const dispatchID = /\bdispatch=([a-f0-9]{64}); not human approval\]/.exec(
      input.text,
    )?.[1];
    if (!dispatchID) throw new FleetError("Uncorrelated fleet assignment");
    return this.db
      .transaction(() => {
        const row = this.db
          .query<
            {
              target: string;
              senderAccount: string;
              assignment: string;
              targetBotKey: string | null;
              targetEvent: string | null;
              targetAccount: string | null;
            },
            [string]
          >(
            "SELECT target,senderAccount,assignment,targetBotKey,targetEvent,targetAccount FROM fleet_results WHERE dispatchID=?",
          )
          .get(dispatchID);
        if (!row || row.assignment !== input.text)
          throw new FleetError("Uncorrelated fleet assignment");
        const target = JSON.parse(row.target) as FleetTarget;
        if (
          target.sessionID !== input.sessionID ||
          fold(target.account) !== fold(input.account) ||
          fold(target.channel) !== fold(input.channel) ||
          fold(row.senderAccount) !== fold(input.sender)
        )
          throw new FleetError(
            "Fleet assignment identity does not match its delegation",
          );
        if (
          row.targetEvent !== null &&
          (row.targetEvent !== input.eventId ||
            row.targetBotKey !== input.botKey ||
            row.targetAccount !== input.account)
        )
          throw new FleetError(
            "Fleet assignment was already admitted as another request",
          );
        this.db
          .query(
            "UPDATE fleet_results SET targetBotKey=?,targetEvent=?,targetAccount=? WHERE dispatchID=?",
          )
          .run(input.botKey, input.eventId, input.account, dispatchID);
        return dispatchID;
      })
      .immediate();
  }

  complete(
    sessionID: string,
    account: string,
    botKey: string,
    eventId: string,
    value: FleetCompletion,
  ) {
    const completion = fleetCompletionSchema.parse(value);
    return this.db
      .transaction(() => {
        const row = this.db
          .query<
            {
              target: string;
              sourceReference: string;
              targetBotKey: string | null;
              targetEvent: string | null;
              targetAccount: string | null;
              targetInput: string | null;
              completion: string | null;
            },
            [string]
          >(
            "SELECT target,sourceReference,targetBotKey,targetEvent,targetAccount,targetInput,completion FROM fleet_results WHERE dispatchID=?",
          )
          .get(completion.dispatchID);
        if (!row) throw new FleetError("Unknown fleet completion delegation");
        const target = JSON.parse(row.target) as FleetTarget;
        if (
          target.sessionID !== sessionID ||
          row.targetAccount !== account ||
          completion.sessionID !== sessionID ||
          completion.actor !== account ||
          completion.channel !== target.channel ||
          completion.sourceReference !== row.sourceReference
        )
          throw new FleetError(
            "Fleet completion does not belong to this gateway target",
          );
        if (
          row.targetEvent !== eventId ||
          row.targetBotKey !== botKey ||
          row.targetInput !== completion.inputID
        )
          throw new FleetError("Fleet completion native request changed");
        if (
          completion.outcome === "completed" &&
          (!completion.inputID || !completion.makers.length)
        )
          throw new FleetError(
            "Completed fleet work needs native input and maker evidence",
          );
        const text = JSON.stringify(completion);
        if (row.completion !== null && row.completion !== text)
          throw new FleetError("Fleet completion is immutable");
        this.db
          .query(
            "UPDATE fleet_results SET targetEvent=?,targetInput=?,completion=? WHERE dispatchID=?",
          )
          .run(eventId, completion.inputID, text, completion.dispatchID);
      })
      .immediate();
  }

  bindInput(
    sessionID: string,
    account: string,
    botKey: string,
    eventId: string,
    dispatchID: string,
    inputID: string,
  ) {
    this.db
      .transaction(() => {
        const row = this.db
          .query<
            {
              target: string;
              targetBotKey: string | null;
              targetEvent: string | null;
              targetAccount: string | null;
              targetInput: string | null;
            },
            [string]
          >(
            "SELECT target,targetBotKey,targetEvent,targetAccount,targetInput FROM fleet_results WHERE dispatchID=?",
          )
          .get(dispatchID);
        if (!row) throw new FleetError("Unknown fleet native request");
        const target = JSON.parse(row.target) as FleetTarget;
        if (
          target.sessionID !== sessionID ||
          row.targetAccount !== account ||
          row.targetBotKey !== botKey ||
          row.targetEvent !== eventId ||
          (row.targetInput !== null && row.targetInput !== inputID)
        )
          throw new FleetError(
            "Fleet native input does not match its admitted delegation",
          );
        this.db
          .query("UPDATE fleet_results SET targetInput=? WHERE dispatchID=?")
          .run(inputID, dispatchID);
      })
      .immediate();
  }

  pendingResults(sessionID: string): FleetResultDelivery[] {
    return this.db
      .query<{ origin: string; completion: string }, [string]>(
        "SELECT origin,completion FROM fleet_results WHERE ownerSessionID=? AND completion IS NOT NULL AND acknowledged=0 ORDER BY rowid LIMIT 100",
      )
      .all(sessionID)
      .map((row) => ({
        origin: fleetOriginSchema.parse(JSON.parse(row.origin)),
        completion: fleetCompletionSchema.parse(JSON.parse(row.completion)),
      }));
  }

  delegation(sessionID: string, account: string, dispatchID: string) {
    const row = this.db
      .query<
        {
          target: string;
          sourceReference: string;
          targetAccount: string | null;
        },
        [string]
      >(
        "SELECT target,sourceReference,targetAccount FROM fleet_results WHERE dispatchID=?",
      )
      .get(dispatchID);
    if (!row) return;
    const target = JSON.parse(row.target) as FleetTarget;
    if (target.sessionID !== sessionID || row.targetAccount !== account) return;
    return { target, sourceReference: row.sourceReference };
  }

  acknowledgeResult(sessionID: string, dispatchID: string) {
    this.db
      .query(
        "UPDATE fleet_results SET acknowledged=1 WHERE dispatchID=? AND ownerSessionID=? AND completion IS NOT NULL",
      )
      .run(dispatchID, sessionID);
  }
}
