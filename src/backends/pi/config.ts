import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { Schema } from "effect";
import {
  absolutePath,
  piProviderSchema,
  settingsDefault,
  settingsPattern,
  settingsStruct,
} from "../../config/settings-schema";

export {
  piProviderSchema,
  secureLocalOrHttpsURL,
} from "../../config/settings-schema";

/**
 * Pi Durable model selection, shared by Pi bot backends, Pi crew workers and
 * the maintenance droid. Kept apart from `config.ts` so the maintenance
 * schema can use it without an import cycle.
 */
export const piProxyModel = "openai/opencode-go/deepseek-v4.1-flash";
/** Claude through the proxy's Anthropic route; also valid natively. */
export const piClaudeProxyModel = "anthropic/claude-haiku-5-5";
/** Models an explicit `provider` may serve; anything else fails closed. */
export const piProxyModels: readonly string[] = [
  piProxyModel,
  piClaudeProxyModel,
];

export const piModelSchema = Schema.String.check(
  settingsPattern(/^(openai|anthropic)\/.+$/, {
    message: "Use openai/model-id or anthropic/model-id",
  }),
);

/**
 * Pi thinking level from the pinned SDK's own enum. Unset keeps Pi's default
 * `off`; the selected model must support the level (see `piModels`).
 */
export const piThinkingLevelSchema = Schema.Literals(MODEL_THINKING_LEVELS);

export const piDurableBackendSchema = settingsStruct({
  type: Schema.Literal("pi-durable"),
  directory: absolutePath,
  model: piModelSchema,
  provider: Schema.optional(piProviderSchema),
  thinkingLevel: Schema.optional(piThinkingLevelSchema),
  systemPrompt: Schema.String.pipe(
    settingsDefault("You are a helpful assistant responding in Slack."),
  ),
  tools: Schema.Literals(["none", "coding"]).pipe(settingsDefault("none")),
});

const { directory: _piDirectory, ...piCrewBackendFields } =
  piDurableBackendSchema.fields;
/** Crew working directories are supplied by the configured worktree map. */
export const piCrewBackendSchema = settingsStruct(piCrewBackendFields);

export type PiModelSettings = {
  model: string;
  provider?: typeof piProviderSchema.Type | undefined;
  thinkingLevel?: typeof piThinkingLevelSchema.Type | undefined;
};
