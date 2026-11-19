import { isAbsolute, resolve } from "node:path";
import { Schema, SchemaTransformation } from "effect";
import { z } from "zod";
import { legacySetting } from "../settings-legacy";
import {
  settingsCheck,
  settingsDefault,
  settingsPattern,
  settingsRecord,
  settingsRefine,
  settingsStruct,
} from "../settings-schema";

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
const identifier = legacySetting(fleetIdentifier);
export const reviewTargetSchema = z.strictObject({
  repository: legacySetting(reviewRepositorySchema),
  pullRequest: z.number().int().positive().safe(),
  headSHA: z.string().regex(/^[a-f0-9]{40}$/),
  baseSHA: z.string().regex(/^[a-f0-9]{40}$/),
  mergeBaseSHA: z.string().regex(/^[a-f0-9]{40}$/),
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
export const reviewContextTextSchema = z
  .string()
  .min(1)
  .max(256000)
  .refine(
    (text) =>
      text.isWellFormed() &&
      Buffer.byteLength(text, "utf8") <= 256000 &&
      text.startsWith("diff --git ") &&
      !text.includes("\0") &&
      !/^GIT binary patch$|^Binary files .+ differ$/m.test(text) &&
      completeReviewDiff(text),
    "A complete bounded UTF-8 textual diff is required; binary or partial review is unsupported",
  );
export const reviewAssignmentSchema = reviewTargetSchema.extend({
  context: reviewContextTextSchema,
});
export type FleetReviewAssignment = z.infer<typeof reviewAssignmentSchema>;
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

export const sourceSchema = z
  .strictObject({
    reference: identifier,
    transport: z.enum(["irc", "teams", "fleet"]),
    account: identifier,
    authority: z.enum(["human", "agent", "context"]),
    role: z.enum(["rear_admiral", "captain", "crew"]).optional(),
    text: z.string().min(1).max(100_000),
    channel: z.string().min(1).max(1024),
    messageID: identifier,
    receivedAt: z.iso.datetime(),
    /** Trusted intake identity, never accepted from a fleet IPC request. */
    origin: z
      .strictObject({
        botKey: z.string().min(1).max(4096),
        eventId: z.string().min(1).max(4096),
      })
      .optional(),
  })
  .superRefine((source, context) => {
    if (source.transport === "fleet" && source.authority !== "agent")
      context.addIssue({
        code: "custom",
        message: "Fleet completion context must remain non-human",
      });
  });
export type FleetSource = z.infer<typeof sourceSchema>;
export type VerifiedSource = FleetSource & {
  ownerSessionID: string;
  humanApproval: false;
};

export const callerSchema = z.strictObject({
  sessionID: identifier,
  agent: identifier,
  messageID: identifier,
  id: identifier,
});
export type FleetCaller = z.infer<typeof callerSchema>;
export const verifyInputSchema = z.strictObject({ reference: identifier });
export const dispatchInputSchema = z.strictObject({
  target: identifier,
  text: z
    .string()
    .min(1)
    .max(1800)
    .refine((text) =>
      [...text].every(
        (character) =>
          character === "\n" ||
          character === "\t" ||
          !/\p{Cc}/u.test(character),
      ),
    ),
  sourceReference: identifier,
  requestID: identifier.optional(),
  review: reviewAssignmentSchema.optional(),
});
export type DispatchInput = z.infer<typeof dispatchInputSchema>;
export const statusInputSchema = z.strictObject({
  requestID: identifier.optional(),
});
export const reviewInputSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("start"),
    reviewID: identifier,
    reviewerAgent: identifier,
    requestID: identifier.optional(),
  }),
  z.strictObject({ op: z.literal("status"), id: identifier }),
]);
export const requestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("verify"),
    caller: callerSchema,
    input: verifyInputSchema,
  }),
  z.strictObject({
    operation: z.literal("dispatch"),
    caller: callerSchema,
    input: dispatchInputSchema,
  }),
  z.strictObject({
    operation: z.literal("status"),
    caller: callerSchema,
    input: statusInputSchema,
  }),
  z.strictObject({
    operation: z.literal("review"),
    caller: callerSchema,
    input: reviewInputSchema,
  }),
]);
export type FleetRequest = z.infer<typeof requestSchema>;
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

export const nativeMakerSchema = z.strictObject({
  messageID: identifier,
  agent: identifier,
  provider: identifier,
  model: identifier,
  variant: identifier.optional(),
});
export type NativeMaker = z.infer<typeof nativeMakerSchema>;
export const reviewContextSchema = reviewTargetSchema.extend({
  id: identifier,
  authorShip: identifier,
  coordinatorShip: identifier,
  coordinatorSessionID: identifier,
  dispatchID: identifier,
  contextDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type FleetReviewContext = z.infer<typeof reviewContextSchema>;
export const reviewBindingSchema = z.strictObject({
  id: identifier,
  nonce: z.string().regex(/^[a-f0-9]{32}$/),
  context: reviewContextSchema,
  contextText: reviewContextTextSchema,
  reviewerShip: identifier,
  reviewer: legacySetting(reviewAgentSchema),
  sessionID: identifier,
  inputID: identifier,
  createdAt: z.iso.datetime(),
});
export type FleetReviewBinding = z.infer<typeof reviewBindingSchema>;
export const reviewVerdictSchema = reviewTargetSchema.extend({
  contextDigest: z.string().regex(/^[a-f0-9]{64}$/),
  verdict: z.enum(["approve", "request_changes", "comment"]),
  summary: z.string().min(1).max(16000),
  findings: z.array(z.string().min(1).max(4000)).max(50),
});
export const reviewProofSchema = reviewTargetSchema.extend({
  id: identifier,
  reviewID: identifier,
  contextDigest: z.string().regex(/^[a-f0-9]{64}$/),
  authorShip: identifier,
  coordinatorShip: identifier,
  reviewerShip: identifier,
  reviewerAgent: identifier,
  kind: z.enum(["crew", "captain"]),
  sessionID: identifier,
  inputID: identifier,
  makers: z.array(nativeMakerSchema).min(1).max(100),
  family: identifier,
  outcome: z.literal("completed"),
  verdict: reviewVerdictSchema.shape.verdict,
  resultText: z
    .string()
    .min(1)
    .max(64000)
    .refine(
      (text) => text.isWellFormed() && Buffer.byteLength(text, "utf8") <= 64000,
    ),
  resultDigest: z.string().regex(/^[a-f0-9]{64}$/),
  completedAt: z.iso.datetime(),
  authority: z.literal("agent"),
  humanApproval: z.literal(false),
});
export type FleetReviewProof = z.infer<typeof reviewProofSchema>;
export type FleetReviewEvidence = { resultText: string; makers: NativeMaker[] };
export interface FleetReviewNative {
  startReview(binding: FleetReviewBinding, signal: AbortSignal): Promise<void>;
  readReview(
    binding: FleetReviewBinding,
    signal: AbortSignal,
  ): Promise<FleetReviewEvidence | undefined>;
}
export const fleetOriginSchema = z.strictObject({
  botKey: z.string().min(1).max(4096),
  eventId: z.string().min(1).max(4096),
  sessionID: identifier,
  inputID: identifier,
});
export type FleetOrigin = z.infer<typeof fleetOriginSchema>;
export const fleetCompletionSchema = z.strictObject({
  dispatchID: identifier,
  sourceReference: identifier,
  actor: identifier,
  sessionID: identifier,
  inputID: identifier.nullable(),
  channel: z.string().min(1).max(1024),
  outcome: z.enum(["completed", "uncertain"]),
  text: z.string().max(12000),
  makers: z.array(nativeMakerSchema).max(100),
  humanApproval: z.literal(false),
});
export type FleetCompletion = z.infer<typeof fleetCompletionSchema>;
export const fleetJobSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("assignment"), dispatchID: identifier }),
  z.strictObject({
    kind: z.literal("result"),
    completion: fleetCompletionSchema,
    originInputID: identifier,
  }),
]);
export type FleetJob = z.infer<typeof fleetJobSchema>;
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
