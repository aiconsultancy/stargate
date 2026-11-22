import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { settingsDefault, settingsStruct } from "../../settings-schema";
import { Audience, Id, type Limits, Subscription, TopicPattern } from "./model";

const positive = (max: number) =>
  Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(max));
const record = <S extends Schema.Constraint>(value: S, max: number) =>
  Schema.Record(Schema.String, value).check(
    Schema.isPropertyNames(Id),
    Schema.makeFilter((values) => Object.keys(values).length <= max),
  );
const source = settingsStruct({
  id: Id,
  tokenEnv: Schema.String.check(
    Schema.isMaxLength(256),
    Schema.isPattern(/^[A-Z_][A-Z0-9_]*$/),
  ),
  topics: Schema.Array(TopicPattern).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
  ),
  audience: Audience,
  perMinute: positive(60_000).pipe(settingsDefault(60)),
});
export const notifySchema = settingsStruct({
  adapters: record(
    settingsStruct({
      type: Schema.Literal("http"),
      enabled: Schema.Boolean.pipe(settingsDefault(false)),
      path: Schema.String.check(
        Schema.isMaxLength(128),
        Schema.isPattern(/^\/v1\/notifications\/[A-Za-z0-9][A-Za-z0-9_-]*$/),
      ),
      sources: Schema.Array(source).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(64),
      ),
    }),
    16,
  ),
  destinations: record(
    settingsStruct({
      slack: settingsStruct({
        bot: Id,
        channel: Schema.String.check(
          Schema.isMaxLength(64),
          Schema.isPattern(/^[CG][A-Z0-9]+$/),
        ),
      }),
      audience: Audience,
    }),
    128,
  ),
  subscriptions: Schema.Array(Subscription).check(Schema.isMaxLength(512)),
  limits: Schema.optional(
    settingsStruct({
      admissionQueue: Schema.optional(positive(1000)),
      outboxRows: Schema.optional(positive(10_000)),
      perDestination: Schema.optional(positive(500)),
      maxAgeHours: Schema.optional(positive(24)),
      sendAttempts: Schema.optional(positive(3)),
      dedupDays: Schema.optional(positive(7)),
      dedupRecords: Schema.optional(positive(100_000)),
    }),
  ),
});
export type NotifyConfig = typeof notifySchema.Type;
export const notifyEnabled = (config: NotifyConfig | undefined) =>
  Object.values(config?.adapters ?? {}).some((adapter) => adapter.enabled);

export function coreLimits(config: NotifyConfig) {
  const { maxAgeHours, dedupDays, ...limits } = config.limits ?? {};
  const result: Partial<Limits> = {
    ...(maxAgeHours === undefined ? {} : { maxAgeMs: maxAgeHours * 3_600_000 }),
    ...(dedupDays === undefined ? {} : { dedupMs: dedupDays * 86_400_000 }),
  };
  for (const key of [
    "admissionQueue",
    "outboxRows",
    "perDestination",
    "sendAttempts",
    "dedupRecords",
  ] as const) {
    const value = limits[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Read-only credential check. Never creates or rotates the operator token. */
export async function checkProducerCredentials(
  config: NotifyConfig | undefined,
  environment: NodeJS.ProcessEnv,
  dataDirectory: string,
) {
  producerCredentials(config, environment);
  if (!notifyEnabled(config)) return;
  const file = await open(
    join(dataDirectory, "api-token"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw new Error("Cannot check notification credential separation.");
  });
  if (!file) return;
  let operatorToken: string;
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o7777) !== 0o600 ||
      info.size < 43 ||
      info.size > 44
    )
      throw new Error("Cannot check notification credential separation.");
    const bytes = Buffer.alloc(45);
    const { bytesRead } = await file.read(bytes);
    const token = bytes.subarray(0, bytesRead).toString("utf8");
    if (!/^[A-Za-z0-9_-]{43}\n?$/.test(token))
      throw new Error("Cannot check notification credential separation.");
    operatorToken = token.trim();
  } catch {
    throw new Error("Cannot check notification credential separation.");
  } finally {
    await file.close().catch(() => {
      throw new Error("Cannot check notification credential separation.");
    });
  }
  producerCredentials(config, environment, operatorToken);
}

// Fixed-length digests keep timingSafeEqual safe for every input length.
export function equalCredential(left: string, right: string) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(left), digest(right));
}
export function producerCredentials(
  config: NotifyConfig | undefined,
  env: NodeJS.ProcessEnv,
  operatorToken?: string,
) {
  const resolved: {
    adapter: string;
    source: typeof source.Type;
    token: string;
  }[] = [];
  for (const [name, adapter] of Object.entries(config?.adapters ?? {})) {
    if (!adapter.enabled) continue;
    for (const source of adapter.sources) {
      const token = env[source.tokenEnv];
      if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token))
        throw new Error("Missing or invalid notification producer credential.");
      if (
        (operatorToken !== undefined &&
          equalCredential(token, operatorToken)) ||
        resolved.some((entry) => equalCredential(entry.token, token))
      )
        throw new Error("Ambiguous notification producer credential.");
      resolved.push({ adapter: name, source, token });
    }
  }
  return resolved;
}
