import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { crewActivitySchema } from "./activity";
import { cronjobsSchema } from "./cronjob-config";
import { transcriptionSchema } from "./transcription";
import { waitingSchema } from "./waiting";

const absolutePath = z.string().refine(isAbsolute, "Use an absolute path");
const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const userRule = z.union([z.literal("*"), z.string().regex(/^[UW][A-Z0-9]+$/)]);
const channelRule = z.union([
  z.literal("*"),
  z.string().regex(/^[CGD][A-Z0-9]+$/),
]);

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

export const piDurableBackendSchema = z.strictObject({
  type: z.literal("pi-durable"),
  directory: absolutePath,
  model: z
    .string()
    .regex(
      /^(openai|anthropic)\/.+$/,
      "Use openai/model-id or anthropic/model-id",
    ),
  provider: z
    .strictObject({ baseURL: piProxyURL, apiKeyEnv: envName })
    .optional(),
  systemPrompt: z
    .string()
    .default("You are a helpful assistant responding in Slack."),
  tools: z.enum(["none", "coding"]).default("none"),
});

// HTTP is permitted only for Tailscale names/addresses. Public routes need TLS.
const pairingOrigin = z
  .url()
  .max(2048)
  .refine((value) => {
    if (!URL.canParse(value) || !/^https?:\/\//i.test(value)) return false;
    const url = new URL(value);
    if (
      /[\s\\?#@]/.test(value) ||
      url.username ||
      url.password ||
      url.pathname !== "/"
    )
      return false;
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    const host = url.hostname;
    const parts = host.split(".").map(Number);
    return (
      host.endsWith(".ts.net") ||
      (parts.length === 4 &&
        parts.every(
          (part) => Number.isInteger(part) && part >= 0 && part <= 255,
        ) &&
        parts[0] === 100 &&
        (parts[1] ?? 0) >= 64 &&
        (parts[1] ?? 256) <= 127) ||
      host.startsWith("[fd7a:115c:a1e0:")
    );
  }, "Use an HTTPS origin, or an HTTP Tailscale origin, without credentials, path, query or fragment")
  .transform((value) => new URL(value).origin);

const pairingSchema = z.strictObject({
  operators: z
    .array(z.string().regex(/^[UW][A-Z0-9]+$/))
    .min(1)
    .max(100),
  urls: z.array(pairingOrigin).min(1).max(5),
});

export const backendSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("opencode"),
    url: z
      .url()
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
    directory: absolutePath,
    headersEnv: z.record(z.string(), envName).default({}),
    sessionID: z
      .string()
      .max(256)
      .regex(/^ses_[A-Za-z0-9]+$/)
      .optional(),
    agent: z.string().min(1).optional(),
    model: z
      .strictObject({ providerID: z.string().min(1), id: z.string().min(1) })
      .optional(),
    permissions: z
      .array(
        z.strictObject({
          action: z.string().min(1),
          resource: z.string().min(1),
          effect: z.enum(["allow", "deny"]),
        }),
      )
      .default([{ action: "*", resource: "*", effect: "deny" }]),
  }),
  piDurableBackendSchema,
  z.strictObject({
    type: z.literal("module"),
    module: absolutePath,
    options: z.record(z.string(), z.unknown()).default({}),
  }),
]);

export const botSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  displayName: z.string().trim().min(1).max(100).optional(),
  slack: z.strictObject({
    appId: z.string().regex(/^A[A-Z0-9]+$/),
    appTokenEnv: envName,
    botTokenEnv: envName,
  }),
  access: z.strictObject({
    users: z.array(userRule).min(1),
    channels: z.array(channelRule).min(1),
    deniedUsers: z.array(userRule).default([]),
    deniedChannels: z.array(channelRule).default([]),
    mentionOnly: z.boolean().default(false),
  }),
  backend: backendSchema,
  cronjobs: cronjobsSchema.optional(),
  pairing: pairingSchema.optional(),
  threadContext: z.boolean().default(false),
  /** Speech-to-text for accepted audio and video messages; absent is off. */
  transcription: transcriptionSchema.optional(),
  waiting: waitingSchema.default({ delayMs: 5000, intervalMs: 10000 }),
  crewActivity: crewActivitySchema.default({
    detail: "off",
  }),
  concurrency: z.number().int().min(1).max(32).default(4),
  turnTimeoutMs: z.number().int().min(1000).max(3_600_000).default(1_800_000),
});

export const configSchema = z
  .strictObject({
    dataDirectory: z.string().default(".pogo"),
    /** Serve the read-only fleet dashboard on `<dataDirectory>/dashboard.sock`. */
    dashboard: z.boolean().optional(),
    bots: z.array(botSchema).min(1),
  })
  .superRefine(({ bots }, context) => {
    const cronDirectories = bots.flatMap((bot) =>
      bot.cronjobs ? [resolve(bot.cronjobs.directory)] : [],
    );
    if (new Set(cronDirectories).size !== cronDirectories.length)
      context.addIssue({
        code: "custom",
        message: "Each bot needs a separate cronjobs directory",
      });
    const pinnedSessions = bots.flatMap((bot) =>
      bot.backend.type === "opencode" && bot.backend.sessionID !== undefined
        ? [bot.backend.sessionID]
        : [],
    );
    if (new Set(pinnedSessions).size !== pinnedSessions.length) {
      context.addIssue({
        code: "custom",
        message:
          "Duplicate pinned OpenCode sessionID; each root needs one bot owner",
      });
    }
    for (const field of [
      "id",
      "appId",
      "botTokenEnv",
      "appTokenEnv",
    ] as const) {
      const values = bots.map((bot) =>
        field === "id" ? bot.id : bot.slack[field],
      );
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: "custom", message: `Duplicate bot ${field}` });
      }
    }
  });

export type BackendConfig = z.infer<typeof backendSchema>;
export type BotConfig = z.infer<typeof botSchema>;
/** Loaded configuration; `dataDirectory` is absolute. */
export type Config = z.infer<typeof configSchema>;

export function secret(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[name];
  if (!value?.trim()) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export async function loadConfig(path: string) {
  const config = configSchema.parse(await Bun.file(path).json());
  return {
    ...config,
    dataDirectory: resolve(dirname(resolve(path)), config.dataDirectory),
  };
}
