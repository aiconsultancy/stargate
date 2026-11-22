import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { Schema } from "effect";
import { isLoopbackHost } from "../../lib/loopback";
import {
  settingsPattern,
  settingsRefine,
  settingsStruct,
  settingsURL,
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

const envName = Schema.String.check(settingsPattern(/^[A-Z_][A-Z0-9_]*$/));

export const secureLocalOrHttpsURL = settingsURL.check(
  settingsRefine(
    (value) => {
      const url = new URL(value);
      const loopback = isLoopbackHost(url.hostname);
      return (
        (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        !value.includes("?") &&
        !value.includes("#")
      );
    },
    {
      message:
        "Use HTTPS or loopback HTTP without credentials, query, or fragment",
    },
  ),
);

export const piModelSchema = Schema.String.check(
  settingsPattern(/^(openai|anthropic)\/.+$/, {
    message: "Use openai/model-id or anthropic/model-id",
  }),
);

/** Explicit proxy endpoint; the key is an environment reference, never a value. */
export const piProviderSchema = settingsStruct({
  baseURL: secureLocalOrHttpsURL,
  apiKeyEnv: envName,
});

/**
 * Pi thinking level from the pinned SDK's own enum. Unset keeps Pi's default
 * `off`; the selected model must support the level (see `piModels`).
 */
export const piThinkingLevelSchema = Schema.Literals(MODEL_THINKING_LEVELS);

export type PiModelSettings = {
  model: string;
  provider?: typeof piProviderSchema.Type | undefined;
  thinkingLevel?: typeof piThinkingLevelSchema.Type | undefined;
};
