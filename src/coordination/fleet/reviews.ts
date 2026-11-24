import { createHash } from "node:crypto";
import { Schema } from "effect";
import type { FleetLedger, ReviewRecord } from "./ledger";
import {
  type FleetControlConfig,
  FleetError,
  type FleetOrigin,
  type FleetReviewNative,
  type FleetReviewProof,
  nativeMakerSchema,
  reviewProofSchema,
  reviewVerdictSchema,
} from "./protocol";

function summary(record: ReviewRecord) {
  return {
    id: record.binding.id,
    reviewID: record.binding.context.id,
    reviewerAgent: record.binding.reviewer.agent,
    sessionID: record.binding.sessionID,
    inputID: record.binding.inputID,
    state: record.state,
    humanApproval: false as const,
  };
}

export class FleetReviews {
  public constructor(
    private readonly options: {
      ledger: FleetLedger;
      config: NonNullable<FleetControlConfig["reviews"]>;
      sessionID: string;
      ship: string;
      native: FleetReviewNative;
    },
  ) {}

  public async start(
    input: { reviewID: string; reviewerAgent: string },
    origin: FleetOrigin | undefined,
    callerAgent: string,
    signal: AbortSignal,
  ) {
    if (!origin) {
      throw new FleetError("Review caller has no exact native ingress binding");
    }

    const reviewer = this.options.config.reviewers.find(
      (r) => r.agent === input.reviewerAgent,
    );

    if (
      !reviewer ||
      (reviewer.kind === "captain" && reviewer.agent !== callerAgent)
    ) {
      throw new FleetError(
        "Native review agent is not configured for this caller",
      );
    }

    const reserved = this.options.ledger.reserveReview({
      ownerSessionID: this.options.sessionID,
      ship: this.options.ship,
      reviewID: input.reviewID,
      reviewer,
      origin,
      repositories: this.options.config.repositories,
      crewDirectories: this.options.config.crewDirectories,
    });

    if (
      !this.options.config.repositories.includes(
        reserved.record.binding.context.repository,
      )
    ) {
      throw new FleetError("Review repository is not permitted");
    }

    if (reserved.created) {
      if (reviewer.kind === "crew") {
        try {
          await this.options.native.startReview(
            reserved.record.binding,
            signal,
          );
          this.options.ledger.reviewState(
            reserved.record.binding.id,
            "admitted",
          );
        } catch {
          this.options.ledger.reviewState(
            reserved.record.binding.id,
            "uncertain",
          );
          signal.throwIfAborted();
        }
      } else {
        this.options.ledger.reviewState(reserved.record.binding.id, "admitted");
      }
    }

    const current = this.options.ledger.reviewRecord(
      this.options.sessionID,
      reserved.record.binding.id,
    );

    return summary(current ?? reserved.record);
  }

  public async poll(signal: AbortSignal) {
    for (const record of this.options.ledger.pendingReviews(
      this.options.sessionID,
    )) {
      signal.throwIfAborted();
      const binding = record.binding;

      if (
        !this.options.config.repositories.includes(binding.context.repository)
      ) {
        continue;
      }

      try {
        const evidence = await this.options.native.readReview(binding, signal);

        if (!evidence) {
          continue;
        }

        const result = Schema.decodeUnknownSync(reviewVerdictSchema)(
          JSON.parse(evidence.resultText),
        );

        const target = binding.context;

        if (
          result.repository !== target.repository ||
          result.pullRequest !== target.pullRequest ||
          result.headSHA !== target.headSHA ||
          result.baseSHA !== target.baseSHA ||
          result.mergeBaseSHA !== target.mergeBaseSHA ||
          result.contextDigest !== target.contextDigest
        ) {
          throw new FleetError(
            "Native reviewer returned a different PR context",
          );
        }

        const makers = evidence.makers.map((m) =>
          Schema.decodeUnknownSync(nativeMakerSchema)(m),
        );

        if (
          makers.length === 0 ||
          makers.length > 100 ||
          makers.some(
            (m) =>
              m.agent !== binding.reviewer.agent ||
              !binding.reviewer.models.some(
                (s) =>
                  s.provider === m.provider &&
                  s.model === m.model &&
                  (s.variant === undefined || s.variant === m.variant),
              ),
          )
        ) {
          throw new FleetError(
            "Native reviewer family or agent does not match approved selectors",
          );
        }

        const proof: FleetReviewProof = Schema.decodeUnknownSync(
          reviewProofSchema,
        )({
          id: binding.id,
          reviewID: target.id,
          repository: target.repository,
          pullRequest: target.pullRequest,
          headSHA: target.headSHA,
          baseSHA: target.baseSHA,
          mergeBaseSHA: target.mergeBaseSHA,
          contextDigest: target.contextDigest,
          authorShip: target.authorShip,
          coordinatorShip: target.coordinatorShip,
          reviewerShip: binding.reviewerShip,
          reviewerAgent: binding.reviewer.agent,
          kind: binding.reviewer.kind,
          sessionID: binding.sessionID,
          inputID: binding.inputID,
          makers,
          family: binding.reviewer.family,
          outcome: "completed",
          verdict: result.verdict,
          resultText: evidence.resultText,
          resultDigest: createHash("sha256")
            .update(evidence.resultText, "utf8")
            .digest("hex"),
          completedAt: new Date().toISOString(),
          authority: "agent",
          humanApproval: false,
        });

        this.options.ledger.completeReview(binding, proof);
      } catch {
        this.options.ledger.reviewState(binding.id, "uncertain");
        signal.throwIfAborted();
      }
    }
  }
}
