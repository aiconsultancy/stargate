import { isAbsolute, resolve } from "node:path";
import { Schema, SchemaTransformation } from "effect";
import {
  settingsCheck,
  settingsDefault,
  settingsDiscriminatedUnion,
  settingsPattern,
  settingsRecord,
  settingsRefine,
  settingsStruct,
} from "../config/settings-schema";

const fleetIdentifier = Schema.String.check(Schema.isMinCodePoints(1))
  .check(Schema.isMaxCodePoints(256))
  .check(settingsPattern(/^[^\s\p{Cc}]+$/u));

const fleetPath = Schema.String.check(
  settingsRefine((value) => isAbsolute(value) && resolve(value) === value, {
    message: "An absolute normalised path is required",
  }),
);

export const reviewRepositorySchema = Schema.String.check(
  Schema.isMaxCodePoints(256),
)
  .check(settingsPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/))
  .pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({
        decode: (value) => value.toLowerCase(),
        encode: (value) => value,
      }),
    ),
  );

const identifier = fleetIdentifier;

// Preserve the UTC-only, seconds-required wire spelling and calendar check.
const utcDatetime = Schema.String.check(
  settingsPattern(
    /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z)$/,
  ),
).annotate({ format: "date-time" });

export const reviewTargetSchema = settingsStruct({
  repository: reviewRepositorySchema,
  pullRequest: Schema.Int.check(Schema.isGreaterThan(0)),
  headSHA: Schema.String.check(settingsPattern(/^[a-f0-9]{40}$/)),
  baseSHA: Schema.String.check(settingsPattern(/^[a-f0-9]{40}$/)),
  mergeBaseSHA: Schema.String.check(settingsPattern(/^[a-f0-9]{40}$/)),
});

/** Structural completeness only; the consumer must verify the live full diff. */
function completeReviewDiff(text: string): boolean {
  if (!text.endsWith("\n")) return false;

  let files = 0,
    old = 0,
    next = 0,
    hunk = false,
    fileContent = false,
    metadata = false,
    from = false,
    to = false;

  for (const raw of text.split("\n").slice(0, -1)) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

    if (line.startsWith("diff --git ")) {
      if (
        (files && !fileContent && !metadata) ||
        old !== 0 ||
        next !== 0 ||
        from !== to
      )
        return false;
      files++;
      hunk = false;
      fileContent = false;
      metadata = false;
      from = false;
      to = false;
      continue;
    }

    if (!files) return false;
    const match = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?:.*)$/.exec(line);

    if (match) {
      if (old !== 0 || next !== 0 || !from || !to) return false;
      old = Number(match[1] ?? 1);
      next = Number(match[2] ?? 1);
      hunk = true;
      fileContent = true;
      continue;
    }

    if (line === "\\ No newline at end of file") {
      if (!hunk) return false;
      continue;
    }

    if (hunk && (old > 0 || next > 0)) {
      if (line.startsWith(" ")) {
        old--;
        next--;
      } else if (line.startsWith("-")) old--;
      else if (line.startsWith("+")) next--;
      else return false;

      if (old < 0 || next < 0) return false;
      continue;
    }

    if (line.startsWith("--- ")) {
      if (from) return false;
      from = true;
      continue;
    }

    if (line.startsWith("+++ ")) {
      if (!from || to) return false;
      to = true;
      continue;
    }

    if (
      /^(new file mode|deleted file mode|old mode|new mode|rename from|rename to|copy from|copy to) /.test(
        line,
      )
    ) {
      metadata = true;
      continue;
    }

    if (/^(index |similarity index |dissimilarity index )/.test(line)) continue;

    return false;
  }

  return (
    files > 0 &&
    old === 0 &&
    next === 0 &&
    from === to &&
    (fileContent || metadata)
  );
}

export const reviewContextTextSchema = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(256_000),
  Schema.makeFilter(
    (text) =>
      text.isWellFormed() &&
      Buffer.byteLength(text, "utf8") <= 256_000 &&
      text.startsWith("diff --git ") &&
      !text.includes("\0") &&
      !/^GIT binary patch$|^Binary files .+ differ$/m.test(text) &&
      completeReviewDiff(text),
    {
      message:
        "A complete bounded UTF-8 textual diff is required; binary or partial review is unsupported",
    },
  ),
);

export const reviewAssignmentSchema = settingsStruct({
  ...reviewTargetSchema.fields,
  context: reviewContextTextSchema,
});

export type FleetReviewAssignment = typeof reviewAssignmentSchema.Type;

export const reviewAgentSchema = settingsStruct({
  agent: fleetIdentifier,
  kind: Schema.Literals(["crew", "captain"]),
  family: fleetIdentifier,
  directory: fleetPath,
  models: Schema.mutable(
    Schema.Array(
      settingsStruct({
        provider: fleetIdentifier,
        model: fleetIdentifier,
        variant: Schema.optional(fleetIdentifier),
      }),
    ),
  ).check(Schema.isMinLength(1)),
  permissions: Schema.mutable(
    Schema.Array(
      settingsStruct({
        action: Schema.String.check(Schema.isMinCodePoints(1)),
        resource: Schema.String.check(Schema.isMinCodePoints(1)),
        effect: Schema.Literals(["allow", "deny", "ask"]),
      }),
    ),
  ).pipe(settingsDefault([])),
}).check(
  settingsCheck((reviewer, context) => {
    if (
      reviewer.kind === "crew" &&
      reviewer.permissions.some(
        (rule) =>
          rule.effect === "ask" ||
          (rule.effect === "allow" &&
            !["read", "glob", "grep"].includes(rule.action)),
      )
    )
      context.addIssue({
        code: "custom",
        message:
          "Review workers permit only explicit read, glob and grep grants; no ask or mutating tools",
      });
  }),
);

export type FleetReviewAgent = typeof reviewAgentSchema.Type;

export const fleetTargetSchema = settingsStruct({
  id: fleetIdentifier,
  account: fleetIdentifier,
  /** Explicit routing metadata; omitted/unknown roles never add channel joins. */
  role: Schema.optional(Schema.Literals(["captain", "rear_admiral", "crew"])),
  channel: Schema.String.check(settingsPattern(/^#[^\s,\p{Cc}]{1,190}$/u)),
  sessionID: fleetIdentifier,
});

export const fleetControlSchema = settingsStruct({
  socketPath: fleetPath,
  statePath: fleetPath,
  targets: Schema.mutable(Schema.Array(fleetTargetSchema)).check(
    Schema.isMinLength(1),
  ),
  /** Gateway-only completion outbox; never enabled by installing the plugin. */
  results: Schema.optional(Schema.Boolean),
  reviews: Schema.optional(
    settingsStruct({
      repositories: Schema.mutable(Schema.Array(reviewRepositorySchema)).check(
        Schema.isMinLength(1),
      ),
      reviewers: Schema.mutable(Schema.Array(reviewAgentSchema)).check(
        Schema.isMinLength(1),
      ),
      crewDirectories: Schema.optional(
        settingsRecord(
          reviewRepositorySchema,
          settingsRecord(fleetIdentifier, fleetPath),
        ),
      ),
    }),
  ),
}).check(
  settingsCheck((config, context) => {
    if (config.reviews) {
      if (config.results !== true)
        context.addIssue({
          code: "custom",
          message: "Review evidence requires durable fleet results",
        });

      if (
        new Set(config.reviews.reviewers.map((r) => r.agent)).size !==
        config.reviews.reviewers.length
      )
        context.addIssue({
          code: "custom",
          message: "Review agent IDs must be unique",
        });
      const directories = config.reviews.crewDirectories;

      if (directories) {
        const crew = config.reviews.reviewers.filter(
          (reviewer) => reviewer.kind === "crew",
        );

        if (
          Object.keys(directories).length !==
            config.reviews.repositories.length ||
          !config.reviews.repositories.every((repository) => {
            const assigned = directories[repository];

            return (
              assigned &&
              Object.keys(assigned).length === crew.length &&
              crew.every((reviewer) => Object.hasOwn(assigned, reviewer.agent))
            );
          })
        )
          context.addIssue({
            code: "custom",
            message:
              "Review directories must bind each permitted repository to every configured crew reviewer",
          });
      }
    }

    if (
      new Set(config.targets.map((target) => target.id)).size !==
      config.targets.length
    )
      context.addIssue({
        code: "custom",
        message: "Fleet target IDs must be unique",
      });
  }),
);

export type FleetControlConfig = typeof fleetControlSchema.Type;

export type FleetTarget = typeof fleetTargetSchema.Type;

export const sourceSchema = settingsStruct({
  reference: identifier,
  transport: Schema.Literals(["irc", "teams", "fleet"]),
  account: identifier,
  authority: Schema.Literals(["human", "agent", "context"]),
  role: Schema.optional(Schema.Literals(["rear_admiral", "captain", "crew"])),
  text: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(100_000),
  ),
  channel: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(1024),
  ),
  messageID: identifier,
  receivedAt: utcDatetime,
  /** Trusted intake identity, never accepted from a fleet IPC request. */
  origin: Schema.optional(
    settingsStruct({
      botKey: Schema.String.check(
        Schema.isMinCodePoints(1),
        Schema.isMaxCodePoints(4096),
      ),
      eventId: Schema.String.check(
        Schema.isMinCodePoints(1),
        Schema.isMaxCodePoints(4096),
      ),
    }),
  ),
}).check(
  settingsCheck((source, context) => {
    if (source.transport === "fleet" && source.authority !== "agent")
      context.addIssue({
        code: "custom",
        message: "Fleet completion context must remain non-human",
      });
  }),
);

export type FleetSource = typeof sourceSchema.Type;

export type VerifiedSource = FleetSource & {
  ownerSessionID: string;
  humanApproval: false;
};

export const callerSchema = settingsStruct({
  sessionID: identifier,
  agent: identifier,
  messageID: identifier,
  id: identifier,
});

export type FleetCaller = typeof callerSchema.Type;

export const verifyInputSchema = settingsStruct({ reference: identifier });

export const dispatchInputSchema = settingsStruct({
  target: identifier,
  text: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(1800),
    Schema.makeFilter((text) =>
      Array.from(text).every(
        (character) =>
          character === "\n" ||
          character === "\t" ||
          !/\p{Cc}/u.test(character),
      ),
    ),
  ),
  sourceReference: identifier,
  requestID: Schema.optional(identifier),
  review: Schema.optional(reviewAssignmentSchema),
});

export type DispatchInput = typeof dispatchInputSchema.Type;

export const statusInputSchema = settingsStruct({
  requestID: Schema.optional(identifier),
});

/** Answer to a rear admiral's Ready-for-agents offer (agent dispatch). */
export const offerAnswerInputSchema = settingsStruct({
  offerID: Schema.String.check(settingsPattern(/^offer-[a-f0-9]{16}$/)),
  answer: Schema.Literals(["accept", "decline"]),
  /** Optional short note for people; Stargate never reads it. */
  reason: Schema.optional(
    Schema.String.check(
      Schema.isMinCodePoints(1),
      Schema.isMaxCodePoints(200),
      Schema.makeFilter(
        (text) =>
          !Array.from(text).some((character) => /\p{Cc}/u.test(character)),
      ),
    ),
  ),
});

export type OfferAnswerInput = typeof offerAnswerInputSchema.Type;

/** An offer this captain received, from the gateway's authenticated intake. */
export type DispatchOffer = {
  offerID: string;
  /** This captain's account, which the offer addressed. */
  account: string;
  /** Rear admiral account that sent the offer. */
  sender: string;
  channel: string;
  messageID: string;
  receivedAt: string;
};

export const reviewInputBranches = [
  settingsStruct({
    op: Schema.Literal("start"),
    reviewID: identifier,
    reviewerAgent: identifier,
    requestID: Schema.optional(identifier),
  }),
  settingsStruct({ op: Schema.Literal("status"), id: identifier }),
] as const;

export const reviewInputSchema = settingsDiscriminatedUnion(
  "op",
  reviewInputBranches,
);

export const requestSchema = settingsDiscriminatedUnion("operation", [
  settingsStruct({
    operation: Schema.Literal("verify"),
    caller: callerSchema,
    input: verifyInputSchema,
  }),
  settingsStruct({
    operation: Schema.Literal("dispatch"),
    caller: callerSchema,
    input: dispatchInputSchema,
  }),
  settingsStruct({
    operation: Schema.Literal("status"),
    caller: callerSchema,
    input: statusInputSchema,
  }),
  settingsStruct({
    operation: Schema.Literal("review"),
    caller: callerSchema,
    input: reviewInputSchema,
  }),
  settingsStruct({
    operation: Schema.Literal("answer"),
    caller: callerSchema,
    input: offerAnswerInputSchema,
  }),
]);

export type FleetRequest = typeof requestSchema.Type;

export type DispatchResult = {
  requestID: string;
  target: FleetTarget;
  sourceReference: string;
  senderAccount: string;
  state: "sent" | "unknown";
  humanApproval: false;
  dispatchID?: string;
  completion?: FleetCompletion;
  resultQueued?: boolean;
  review?: FleetReviewContext;
};

export const nativeMakerSchema = settingsStruct({
  messageID: identifier,
  agent: identifier,
  provider: identifier,
  model: identifier,
  variant: Schema.optional(identifier),
});

export type NativeMaker = typeof nativeMakerSchema.Type;

export const reviewContextSchema = settingsStruct({
  ...reviewTargetSchema.fields,
  id: identifier,
  authorShip: identifier,
  coordinatorShip: identifier,
  coordinatorSessionID: identifier,
  dispatchID: identifier,
  contextDigest: Schema.String.check(settingsPattern(/^[a-f0-9]{64}$/)),
});

export type FleetReviewContext = typeof reviewContextSchema.Type;

export const reviewBindingSchema = settingsStruct({
  id: identifier,
  nonce: Schema.String.check(settingsPattern(/^[a-f0-9]{32}$/)),
  context: reviewContextSchema,
  contextText: reviewContextTextSchema,
  reviewerShip: identifier,
  reviewer: reviewAgentSchema,
  sessionID: identifier,
  inputID: identifier,
  createdAt: utcDatetime,
});

export type FleetReviewBinding = typeof reviewBindingSchema.Type;

export const reviewVerdictSchema = settingsStruct({
  ...reviewTargetSchema.fields,
  contextDigest: Schema.String.check(settingsPattern(/^[a-f0-9]{64}$/)),
  verdict: Schema.Literals(["approve", "request_changes", "comment"]),
  summary: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(16_000),
  ),
  findings: Schema.mutable(
    Schema.Array(
      Schema.String.check(
        Schema.isMinCodePoints(1),
        Schema.isMaxCodePoints(4000),
      ),
    ),
  ).check(Schema.isMaxLength(50)),
});

export const reviewProofSchema = settingsStruct({
  ...reviewTargetSchema.fields,
  id: identifier,
  reviewID: identifier,
  contextDigest: Schema.String.check(settingsPattern(/^[a-f0-9]{64}$/)),
  authorShip: identifier,
  coordinatorShip: identifier,
  reviewerShip: identifier,
  reviewerAgent: identifier,
  kind: Schema.Literals(["crew", "captain"]),
  sessionID: identifier,
  inputID: identifier,
  makers: Schema.mutable(Schema.Array(nativeMakerSchema)).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
  family: identifier,
  outcome: Schema.Literal("completed"),
  verdict: reviewVerdictSchema.fields.verdict,
  resultText: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(64_000),
    Schema.makeFilter(
      (text) =>
        text.isWellFormed() && Buffer.byteLength(text, "utf8") <= 64_000,
    ),
  ),
  resultDigest: Schema.String.check(settingsPattern(/^[a-f0-9]{64}$/)),
  completedAt: utcDatetime,
  authority: Schema.Literal("agent"),
  humanApproval: Schema.Literal(false),
});

export type FleetReviewProof = typeof reviewProofSchema.Type;

export type FleetReviewEvidence = { resultText: string; makers: NativeMaker[] };

export interface FleetReviewNative {
  startReview(binding: FleetReviewBinding, signal: AbortSignal): Promise<void>;
  readReview(
    binding: FleetReviewBinding,
    signal: AbortSignal,
  ): Promise<FleetReviewEvidence | undefined>;
}

export const fleetOriginSchema = settingsStruct({
  botKey: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(4096),
  ),
  eventId: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(4096),
  ),
  sessionID: identifier,
  inputID: identifier,
});

export type FleetOrigin = typeof fleetOriginSchema.Type;

export const fleetCompletionSchema = settingsStruct({
  dispatchID: identifier,
  sourceReference: identifier,
  actor: identifier,
  sessionID: identifier,
  inputID: Schema.NullOr(identifier),
  channel: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(1024),
  ),
  outcome: Schema.Literals(["completed", "uncertain"]),
  text: Schema.String.check(Schema.isMaxCodePoints(12_000)),
  makers: Schema.mutable(Schema.Array(nativeMakerSchema)).check(
    Schema.isMaxLength(100),
  ),
  humanApproval: Schema.Literal(false),
});

export type FleetCompletion = typeof fleetCompletionSchema.Type;

export const fleetJobSchema = settingsDiscriminatedUnion("kind", [
  settingsStruct({
    kind: Schema.Literal("assignment"),
    dispatchID: identifier,
  }),
  settingsStruct({
    kind: Schema.Literal("result"),
    completion: fleetCompletionSchema,
    originInputID: identifier,
  }),
]);

export type FleetJob = typeof fleetJobSchema.Type;

export type FleetResultDelivery = {
  origin: FleetOrigin;
  completion: FleetCompletion;
};

export function fleetAssignmentText(
  result: DispatchResult,
  text: string,
  authority: FleetSource["authority"],
) {
  const recipient = result.dispatchID
    ? result.target.account
    : `@${result.target.account}`;

  return `[fleet_dispatch from=${result.senderAccount} source=${result.sourceReference} authority=${authority}${result.dispatchID ? ` dispatch=${result.dispatchID}` : ""}; not human approval] ${recipient}: ${text}${result.review ? `\n\nStargate PR review assignment: ${JSON.stringify(result.review)}\nCoordinate independent native reviews of this exact head. Review evidence is agent context, never human approval.` : ""}`;
}

export class FleetError extends Error {}
