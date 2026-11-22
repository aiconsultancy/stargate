import { Schema } from "effect";
import { legacySetting } from "../settings-legacy";
import { settingsPattern, settingsStruct } from "../config/settings-schema";

const provider = Schema.Literals(["claude", "codex"]);
const selector = {
  provider,
  window: Schema.optional(Schema.Literals(["5h", "weekly", "other"])),
  scope: Schema.optional(
    Schema.Literals([
      "subscription",
      "opus",
      "sonnet",
      "haiku",
      "fable",
      "code-review",
    ]),
  ),
};
export const cronTriggerSchema = Schema.Union([
  settingsStruct({ type: Schema.Literal("quota-reset"), ...selector }),
  settingsStruct({
    type: Schema.Literal("quota-threshold"),
    ...selector,
    usedPercent: Schema.Finite.check(
      Schema.isBetween({ minimum: 0, maximum: 100 }),
    ),
  }),
]);
export type CronTrigger = typeof cronTriggerSchema.Type;
export const cronQuotaEventSchema = settingsStruct({
  type: Schema.Literals(["quota-reset", "quota-threshold"]),
  provider,
  account: Schema.String.check(settingsPattern(/^(claude|codex)-[1-9][0-9]?$/)),
  window: Schema.Literals(["5h", "weekly", "other"]),
  scope: Schema.Literals([
    "subscription",
    "opus",
    "sonnet",
    "haiku",
    "fable",
    "code-review",
  ]),
  usedPercent: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  previousResetAt: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  resetAt: Schema.Int.check(Schema.isGreaterThan(0)),
  observedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type CronQuotaEvent = typeof cronQuotaEventSchema.Type;

export const cronModelSchema = Schema.String.check(
  Schema.isMaxLength(256),
  settingsPattern(/^[^/\s#]+\/[^\s#]+(?:#[^\s#]+)?$/),
);
export const cronArbiterSchema = Schema.String.check(
  settingsPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/),
);
export const cronAdvancedSchema = settingsStruct({
  trigger: Schema.optional(cronTriggerSchema),
  model: Schema.optional(cronModelSchema),
  once: Schema.optional(Schema.Boolean),
  arbiter: Schema.optional(cronArbiterSchema),
});
export type CronAdvanced = typeof cronAdvancedSchema.Type;
export const cronEvaluationSchema = settingsStruct({
  text: Schema.String.check(Schema.isMaxLength(12000)),
  model: cronModelSchema,
  verdict: Schema.Literals(["act", "ignore", "escalate"]),
});
export type CronEvaluation = typeof cronEvaluationSchema.Type;
export const cronAdvancedFields = {
  trigger: legacySetting(cronTriggerSchema).optional(),
  model: legacySetting(cronModelSchema).optional(),
  once: legacySetting(Schema.Boolean).optional(),
  arbiter: legacySetting(cronArbiterSchema).optional(),
};

export function usesAdvancedCron(input: CronAdvanced): boolean {
  return (
    input.trigger !== undefined ||
    input.model !== undefined ||
    input.once === true ||
    input.arbiter !== undefined
  );
}
