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

export const sourceSchema = z.strictObject({
  reference: identifier,
  transport: z.enum(["irc", "teams"]),
  account: identifier,
  authority: z.enum(["human", "agent", "context"]),
  role: z.enum(["rear_admiral", "captain", "crew"]).optional(),
  text: z.string().min(1).max(100_000),
  channel: z.string().min(1).max(1024),
  messageID: identifier,
  receivedAt: z.iso.datetime(),
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
};
export class FleetError extends Error {}
