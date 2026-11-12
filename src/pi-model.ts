import { z } from "zod";

/**
 * Pi Durable model selection, shared by Pi bot backends, Pi crew workers and
 * the maintenance droid. Kept apart from `config.ts` so the maintenance
 * schema can use it without an import cycle.
 */
export const piProxyModel = "openai/opencode-go/deepseek-v4.1-flash";

const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);

const piProxyURL = z.url().refine((value) => {
  const url = new URL(value);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  return (
    (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    !value.includes("?") &&
    !value.includes("#")
  );
}, "Use HTTPS or loopback HTTP without credentials, query, or fragment");

export const piModelSchema = z
  .string()
  .regex(
    /^(openai|anthropic)\/.+$/,
    "Use openai/model-id or anthropic/model-id",
  );

/** Explicit proxy endpoint; the key is an environment reference, never a value. */
export const piProviderSchema = z.strictObject({
  baseURL: piProxyURL,
  apiKeyEnv: envName,
});

export type PiModelSettings = {
  model: string;
  provider?: z.infer<typeof piProviderSchema> | undefined;
};
