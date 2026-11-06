import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { waitingSchema } from "./waiting";

const absolutePath = z.string().refine(isAbsolute, "Use an absolute path");
const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const userRule = z.union([z.literal("*"), z.string().regex(/^[UW][A-Z0-9]+$/)]);
const channelRule = z.union([
  z.literal("*"),
  z.string().regex(/^[CGD][A-Z0-9]+$/),
]);

export const backendSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("opencode"),
    url: z
      .url()
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
    directory: absolutePath,
    headersEnv: z.record(z.string(), envName).default({}),
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
  z.strictObject({
    type: z.literal("pi-durable"),
    directory: absolutePath,
    model: z
      .string()
      .regex(
        /^(openai|anthropic)\/.+$/,
        "Use openai/model-id or anthropic/model-id",
      ),
    systemPrompt: z
      .string()
      .default("You are a helpful assistant responding in Slack."),
    tools: z.enum(["none", "coding"]).default("none"),
  }),
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
  waiting: waitingSchema.default({ delayMs: 5000, intervalMs: 10000 }),
  concurrency: z.number().int().min(1).max(32).default(4),
  turnTimeoutMs: z.number().int().min(1000).max(3_600_000).default(300_000),
});

export const configSchema = z
  .strictObject({
    dataDirectory: z.string().default(".pogo"),
    bots: z.array(botSchema).min(1),
  })
  .superRefine(({ bots }, context) => {
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
