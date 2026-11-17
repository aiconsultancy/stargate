import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
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
  assertReviewDiffLimit,
  type DispatchResult,
  type FleetCompletion,
  FleetError,
  type FleetOrigin,
  type FleetResultDelivery,
  type FleetReviewAgent,
  type FleetReviewAssignment,
  type FleetReviewBinding,
  type FleetReviewProof,
  type FleetSource,
  type FleetTarget,
  fleetAssignmentText,
  fleetCompletionSchema,
  fleetOriginSchema,
  reviewBindingSchema,
  reviewContextSchema,
  reviewContextTextSchema,
  reviewProofSchema,
  sourceSchema,
  type VerifiedSource,
} from "./protocol";

type SourceRow = { ownerSessionID: string; value: string };
type DispatchRow = { fingerprint: string; value: string };
type ReviewRow = {
  binding: string;
  state: "reserved" | "admitted" | "uncertain" | "completed";
  proof: string | null;
};
export type ReviewRecord = {
  binding: FleetReviewBinding;
  state: ReviewRow["state"];
  proof?: FleetReviewProof;
};

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
        CREATE TABLE IF NOT EXISTS fleet_review_requests (
          id TEXT PRIMARY KEY, context TEXT NOT NULL, text TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS fleet_reviews (
          id TEXT PRIMARY KEY, reviewID TEXT NOT NULL,
          ownerSessionID TEXT NOT NULL, reviewerShip TEXT NOT NULL, reviewerAgent TEXT NOT NULL,
          sessionID TEXT NOT NULL, inputID TEXT NOT NULL,
          binding TEXT NOT NULL, state TEXT NOT NULL, proof TEXT,
          UNIQUE(reviewID,reviewerShip,reviewerAgent), UNIQUE(sessionID,inputID)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS fleet_review_admission_slot
          ON fleet_reviews(reviewerShip,reviewerAgent) WHERE state IN ('reserved','admitted');
        CREATE TABLE IF NOT EXISTS fleet_review_poll_cursors (
          ownerSessionID TEXT PRIMARY KEY, lastID TEXT NOT NULL
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
    review?: FleetReviewAssignment;
    maxDiffBytes?: number | null;
  }): { created: boolean; result: DispatchResult } {
    if (input.review) {
      reviewContextTextSchema.parse(input.review.context);
      assertReviewDiffLimit(input.review.context, input.maxDiffBytes);
    }
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
        if (input.review) {
          if (
            !result.dispatchID ||
            input.senderAccount.toLowerCase() ===
              input.target.account.toLowerCase()
          )
            throw new FleetError(
              "Review coordination requires another ship and a durable dispatch",
            );
          result.review = reviewContextSchema.parse({
            promptVersion: 2,
            id: result.dispatchID,
            repository: input.review.repository,
            pullRequest: input.review.pullRequest,
            headSHA: input.review.headSHA,
            baseSHA: input.review.baseSHA,
            mergeBaseSHA: input.review.mergeBaseSHA,
            contextDigest: createHash("sha256")
              .update(input.review.context, "utf8")
              .digest("hex"),
            authorShip: input.senderAccount.toLowerCase(),
            coordinatorShip: input.target.account.toLowerCase(),
            coordinatorSessionID: input.target.sessionID,
            dispatchID: result.dispatchID,
          });
          if (input.review.context.includes(`END_REVIEW_${result.review.id}`))
            throw new FleetError("Ambiguous review context");
          this.db
            .query(
              "INSERT INTO fleet_review_requests(id,context,text) VALUES(?,?,?)",
            )
            .run(
              result.review.id,
              JSON.stringify(result.review),
              input.review.context,
            );
        }
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

  private decodeReview(row: ReviewRow): ReviewRecord {
    return {
      binding: reviewBindingSchema.parse(JSON.parse(row.binding)),
      state: row.state,
      ...(row.proof
        ? { proof: reviewProofSchema.parse(JSON.parse(row.proof)) }
        : {}),
    };
  }

  reviewContext(
    sessionID: string,
    ship: string,
    reviewID: string,
    maxDiffBytes?: number | null,
  ) {
    const row = this.db
      .query<{ context: string; text: string }, [string]>(
        "SELECT context,text FROM fleet_review_requests WHERE id=?",
      )
      .get(reviewID);
    if (!row) return;
    const context = reviewContextSchema.parse(JSON.parse(row.context));
    if (
      context.coordinatorSessionID !== sessionID ||
      context.coordinatorShip !== ship.toLowerCase()
    )
      return;
    assertReviewDiffLimit(row.text, maxDiffBytes);
    return { context, text: row.text };
  }

  reserveReview(input: {
    ownerSessionID: string;
    ship: string;
    reviewID: string;
    reviewer: FleetReviewAgent;
    origin: FleetOrigin;
    repositories: readonly string[];
    maxDiffBytes?: number | null;
  }): { created: boolean; record: ReviewRecord } {
    return this.db
      .transaction(() => {
        const request = this.db
          .query<{ context: string; text: string }, [string]>(
            "SELECT context,text FROM fleet_review_requests WHERE id=?",
          )
          .get(input.reviewID);
        if (!request)
          throw new FleetError("Structured review assignment unavailable");
        assertReviewDiffLimit(request.text, input.maxDiffBytes);
        const context = reviewContextSchema.parse(JSON.parse(request.context));
        if (!input.repositories.includes(context.repository))
          throw new FleetError("Review repository is not permitted");
        const ship = input.ship.toLowerCase();
        if (
          context.coordinatorSessionID !== input.ownerSessionID ||
          context.coordinatorShip !== ship ||
          context.authorShip === ship ||
          input.origin.sessionID !== input.ownerSessionID
        )
          throw new FleetError(
            "Review is not assigned to this independent coordinator",
          );
        const intake = this.db
          .query<
            {
              targetBotKey: string | null;
              targetEvent: string | null;
              targetInput: string | null;
              targetAccount: string | null;
            },
            [string]
          >(
            "SELECT targetBotKey,targetEvent,targetInput,targetAccount FROM fleet_results WHERE dispatchID=?",
          )
          .get(context.dispatchID);
        if (
          !intake ||
          intake.targetBotKey !== input.origin.botKey ||
          intake.targetEvent !== input.origin.eventId ||
          intake.targetAccount?.toLowerCase() !== ship ||
          (intake.targetInput !== null &&
            intake.targetInput !== input.origin.inputID)
        )
          throw new FleetError(
            "Review must originate from its exact admitted coordinator input",
          );
        this.db
          .query("UPDATE fleet_results SET targetInput=? WHERE dispatchID=?")
          .run(input.origin.inputID, context.dispatchID);
        const previous = this.db
          .query<ReviewRow, [string, string, string]>(
            "SELECT binding,state,proof FROM fleet_reviews WHERE reviewID=? AND reviewerShip=? AND reviewerAgent=?",
          )
          .get(input.reviewID, ship, input.reviewer.agent);
        if (previous)
          return { created: false, record: this.decodeReview(previous) };
        const binding = reviewBindingSchema.parse({
          id: `proof_${randomUUID().replaceAll("-", "")}`,
          nonce: randomUUID().replaceAll("-", ""),
          context,
          contextText: request.text,
          ...(input.maxDiffBytes != null
            ? { maxDiffBytes: input.maxDiffBytes }
            : {}),
          reviewerShip: ship,
          reviewer: input.reviewer,
          sessionID:
            input.reviewer.kind === "captain"
              ? input.ownerSessionID
              : `ses_${randomUUID().replaceAll("-", "")}`,
          inputID:
            input.reviewer.kind === "captain"
              ? input.origin.inputID
              : `msg_${randomUUID().replaceAll("-", "")}`,
          createdAt: new Date().toISOString(),
        });
        this.db
          .query(
            "INSERT INTO fleet_reviews(id,reviewID,ownerSessionID,reviewerShip,reviewerAgent,sessionID,inputID,binding,state) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(
            binding.id,
            context.id,
            input.ownerSessionID,
            ship,
            input.reviewer.agent,
            binding.sessionID,
            binding.inputID,
            JSON.stringify(binding),
            "reserved",
          );
        return {
          created: true,
          record: { binding, state: "reserved" as const },
        };
      })
      .immediate();
  }

  reviewState(id: string, state: "admitted" | "uncertain") {
    this.db
      .query("UPDATE fleet_reviews SET state=? WHERE id=? AND proof IS NULL")
      .run(state, id);
  }

  reviewRecord(ownerSessionID: string, id: string): ReviewRecord | undefined {
    const row = this.db
      .query<ReviewRow, [string, string]>(
        "SELECT binding,state,proof FROM fleet_reviews WHERE ownerSessionID=? AND id=?",
      )
      .get(ownerSessionID, id);
    return row ? this.decodeReview(row) : undefined;
  }

  /** Rotate bounded read-only recovery across all work, including uncertainty. */
  pendingReviews(ownerSessionID: string): ReviewRecord[] {
    return this.db
      .transaction(() => {
        const lastID =
          this.db
            .query<{ lastID: string }, [string]>(
              "SELECT lastID FROM fleet_review_poll_cursors WHERE ownerSessionID=?",
            )
            .get(ownerSessionID)?.lastID ?? "";
        const after = this.db
          .query<ReviewRow & { id: string }, [string, string]>(
            `SELECT id,binding,state,proof FROM fleet_reviews WHERE ownerSessionID=? AND proof IS NULL
           AND rowid>COALESCE((SELECT rowid FROM fleet_reviews WHERE id=?),0) ORDER BY rowid LIMIT 100`,
          )
          .all(ownerSessionID, lastID);
        const batch =
          after.length === 100
            ? after
            : after.concat(
                this.db
                  .query<ReviewRow & { id: string }, [string, string, number]>(
                    `SELECT id,binding,state,proof FROM fleet_reviews WHERE ownerSessionID=? AND proof IS NULL
           AND rowid<=COALESCE((SELECT rowid FROM fleet_reviews WHERE id=?),0) ORDER BY rowid LIMIT ?`,
                  )
                  .all(ownerSessionID, lastID, 100 - after.length),
              );
        const last = batch.at(-1);
        if (last)
          this.db
            .query(
              "INSERT INTO fleet_review_poll_cursors(ownerSessionID,lastID) VALUES(?,?) ON CONFLICT(ownerSessionID) DO UPDATE SET lastID=excluded.lastID",
            )
            .run(ownerSessionID, last.id);
        return batch.map((row) => this.decodeReview(row));
      })
      .immediate();
  }

  completeReview(binding: FleetReviewBinding, proof: FleetReviewProof) {
    const parsed = reviewProofSchema.parse(proof);
    this.db
      .transaction(() => {
        const row = this.db
          .query<ReviewRow, [string]>(
            "SELECT binding,state,proof FROM fleet_reviews WHERE id=?",
          )
          .get(binding.id);
        if (!row || row.binding !== JSON.stringify(binding))
          throw new FleetError("Review native binding changed");
        const context = binding.context;
        if (
          parsed.id !== binding.id ||
          parsed.reviewID !== context.id ||
          parsed.repository !== context.repository ||
          parsed.pullRequest !== context.pullRequest ||
          parsed.headSHA !== context.headSHA ||
          parsed.baseSHA !== context.baseSHA ||
          parsed.mergeBaseSHA !== context.mergeBaseSHA ||
          parsed.contextDigest !== context.contextDigest ||
          parsed.authorShip !== context.authorShip ||
          parsed.coordinatorShip !== context.coordinatorShip ||
          parsed.reviewerShip !== binding.reviewerShip ||
          parsed.reviewerAgent !== binding.reviewer.agent ||
          parsed.kind !== binding.reviewer.kind ||
          parsed.sessionID !== binding.sessionID ||
          parsed.inputID !== binding.inputID
        )
          throw new FleetError(
            "Review proof does not match its immutable assignment",
          );
        const text = JSON.stringify(parsed);
        if (row.proof !== null && row.proof !== text)
          throw new FleetError("Review proof is immutable");
        this.db
          .query(
            "UPDATE fleet_reviews SET state='completed',proof=? WHERE id=?",
          )
          .run(text, binding.id);
      })
      .immediate();
  }

  reviewProof(id: string, ship: string): FleetReviewProof | undefined {
    const row = this.db
      .query<{ proof: string | null }, [string]>(
        "SELECT proof FROM fleet_reviews WHERE id=?",
      )
      .get(id);
    if (!row?.proof) return;
    const proof = reviewProofSchema.parse(JSON.parse(row.proof));
    return [
      proof.authorShip,
      proof.coordinatorShip,
      proof.reviewerShip,
    ].includes(ship.toLowerCase())
      ? proof
      : undefined;
  }

  reviewProofs(
    ship: string,
    target: { repository: string; pullRequest: number; headSHA: string },
  ): FleetReviewProof[] {
    return this.db
      .query<
        { proof: string },
        [string, number, string, string, string, string]
      >(`SELECT proof FROM fleet_reviews WHERE proof IS NOT NULL
      AND json_extract(proof,'$.repository')=? AND json_extract(proof,'$.pullRequest')=? AND json_extract(proof,'$.headSHA')=?
      AND (json_extract(proof,'$.authorShip')=? OR json_extract(proof,'$.coordinatorShip')=? OR json_extract(proof,'$.reviewerShip')=?)
      ORDER BY rowid DESC LIMIT 100`)
      .all(
        target.repository,
        target.pullRequest,
        target.headSHA,
        ship.toLowerCase(),
        ship.toLowerCase(),
        ship.toLowerCase(),
      )
      .map((row) => reviewProofSchema.parse(JSON.parse(row.proof)));
  }
}
