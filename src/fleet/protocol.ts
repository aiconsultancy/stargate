import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\s\p{Cc}]+$/u);
const path = z
  .string()
  .refine(
    (value) => isAbsolute(value) && resolve(value) === value,
    "An absolute normalised path is required",
  );
export const fleetTargetSchema = z.strictObject({
  id: identifier,
  account: identifier,
  channel: z.string().regex(/^#[^\s,\p{Cc}]{1,190}$/u),
  sessionID: identifier,
});
export const fleetControlSchema = z
  .strictObject({
    socketPath: path,
    statePath: path,
    targets: z.array(fleetTargetSchema).min(1),
    /** Gateway-only completion outbox; never enabled by installing the plugin. */
    results: z.boolean().optional(),
  })
  .superRefine((config, context) => {
    if (
      new Set(config.targets.map((target) => target.id)).size !==
      config.targets.length
    )
      context.addIssue({
        code: "custom",
        message: "Fleet target IDs must be unique",
      });
  });
export type FleetControlConfig = z.infer<typeof fleetControlSchema>;
export type FleetTarget = z.infer<typeof fleetTargetSchema>;

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
});
export type DispatchInput = z.infer<typeof dispatchInputSchema>;
export const statusInputSchema = z.strictObject({
  requestID: identifier.optional(),
});
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
};

export const nativeMakerSchema = z.strictObject({
  messageID: identifier,
  agent: identifier,
  provider: identifier,
  model: identifier,
  variant: identifier.optional(),
});
export type NativeMaker = z.infer<typeof nativeMakerSchema>;
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
  return `[fleet_dispatch from=${result.senderAccount} source=${result.sourceReference} authority=${authority}${result.dispatchID ? ` dispatch=${result.dispatchID}` : ""}; not human approval] ${result.target.account}: ${text}`;
}
export class FleetError extends Error {}
