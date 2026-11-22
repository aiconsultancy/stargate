import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import type { Logger } from "pino";
import { z } from "zod";
import { atomicWrite, readOptional } from "../maintenance/nightly/files";
import {
  type QuotaReader,
  type QuotaSnapshot,
  quotaConfigSchema,
} from "./quota";
import {
  settingsDefault,
  settingsPattern,
  settingsRefine,
  settingsStruct,
} from "../settings-schema";

const providers = ["claude", "codex"] as const;
const providerSchema = Schema.Literals(providers);
const absolutePath = Schema.String.check(
  settingsRefine((path) => isAbsolute(path) && !path.includes("\0"), {
    message: "Invalid input",
  }),
);
export const quotaWatchSchema = settingsStruct({
  proxy: quotaConfigSchema,
  stateFile: absolutePath,
  nativeCodexFile: Schema.optional(absolutePath),
  providers: Schema.mutable(Schema.Array(providerSchema))
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(2))
    .check(
      settingsRefine((items) => new Set(items).size === items.length, {
        message: "Invalid input",
      }),
    )
    .pipe(settingsDefault([...providers])),
  report: settingsStruct({
    bot: Schema.String.check(settingsPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/)),
    channel: Schema.String.check(settingsPattern(/^[CG][A-Z0-9]+$/)),
  }),
});
type QuotaWatchConfig = typeof quotaWatchSchema.Type;
type Provider = typeof providerSchema.Type;
const observation = z.strictObject({
  mode: z.enum(["normal", "limited", "paused"]),
  observedAt: z.number().int().positive(),
});
const policySchema = z.strictObject({
  claude: observation.optional(),
  codex: observation.optional(),
});
type Observation = z.infer<typeof observation>;

const pollMs = 120_000;
const epochSeconds = z.number().int().positive();
const nativeQuotaSchema = z.strictObject({
  remainingPercent: z.number().finite().min(0).max(100),
  observedAt: epochSeconds,
  resetAt: epochSeconds.nullable(),
});

function fresh(observedAt: number, now: number) {
  return observedAt <= now && now - observedAt < pollMs;
}

function policy(remaining: number, observedAt: number): Observation {
  return {
    mode: remaining <= 15 ? "paused" : remaining <= 25 ? "limited" : "normal",
    observedAt: Math.floor(observedAt / 1000),
  };
}

async function nativeCodexPolicy(path: string, now: number) {
  try {
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        (stat.mode & 0o077) !== 0 ||
        stat.uid !== process.getuid?.() ||
        stat.size > 256
      )
        return;
      const native = nativeQuotaSchema.parse(
        JSON.parse(await file.readFile("utf8")),
      );
      const seen = native.observedAt * 1000;
      if (
        !fresh(seen, now) ||
        (native.resetAt !== null && native.resetAt * 1000 <= now)
      )
        return;
      return policy(native.remainingPercent, seen);
    } finally {
      await file.close();
    }
  } catch {
    // A missing or invalid receipt is unknown; never use a proxy login instead.
    return undefined;
  }
}

function currentPolicy(
  snapshot: QuotaSnapshot,
  provider: Provider,
  now: number,
): Observation | undefined {
  const accounts = snapshot.accounts.filter((row) => row.provider === provider);
  if (!accounts.length) return;
  let remaining = 0;
  let observedAt = now;
  for (const account of accounts) {
    const seen = account.observedAt;
    if (account.status !== "ok" || seen === null || !fresh(seen, now)) return;
    const windows = account.windows.filter(
      (window) => window.scope === "subscription" && window.active !== false,
    );
    if (!windows.length) return;
    let usable = 100;
    for (const { remainingPercent, resetAt } of windows) {
      if (remainingPercent === null || (resetAt !== null && resetAt <= now))
        return;
      usable = Math.min(usable, remainingPercent);
    }
    remaining = Math.max(remaining, usable);
    observedAt = Math.min(observedAt, seen);
  }
  return policy(remaining, observedAt);
}

const message = {
  paused:
    "Pause crew launches and resumes. Checkpoint active crew work at its next safe point and preserve task claims.",
  limited:
    "Run at most one crew worker of this type per captain. Hold additional work.",
  normal:
    "Quota has recovered above 25%. Resume normal quota-based crew operations.",
} as const;
const heading = {
  paused: "15% or less remaining.",
  limited: "25% or less remaining.",
  normal: "Quota restored.",
} as const;

/** Publish verified quota policy before announcing changes; replay neither on restart. */
export class QuotaWatch {
  constructor(
    private readonly config: QuotaWatchConfig,
    private readonly reader: Pick<QuotaReader, "read">,
    private readonly announce: (
      text: string,
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly log: Pick<Logger, "warn">,
    private readonly now = Date.now,
  ) {}

  async tick(signal: AbortSignal) {
    const snapshot = await this.reader.read(signal);
    signal.throwIfAborted();
    const raw = await readOptional(this.config.stateFile);
    const before = raw === null ? {} : policySchema.parse(JSON.parse(raw));
    const after = { ...before };
    const notices: string[] = [];
    let updated = false;
    const now = this.now();
    for (const provider of this.config.providers) {
      const current =
        provider === "codex" && this.config.nativeCodexFile
          ? await nativeCodexPolicy(this.config.nativeCodexFile, now)
          : currentPolicy(snapshot, provider, now);
      const previous = before[provider];
      if (!current || (previous && current.observedAt <= previous.observedAt))
        continue;
      after[provider] = current;
      updated = true;
      if (
        previous?.mode === current.mode ||
        (!previous && current.mode === "normal")
      )
        continue;
      const name = provider === "claude" ? "Claude" : "Codex";
      notices.push(
        `${name} crew quota: ${heading[current.mode]} ${message[current.mode]}`,
      );
    }
    if (!updated) return;
    await mkdir(dirname(this.config.stateFile), {
      recursive: true,
      mode: 0o700,
    });
    signal.throwIfAborted();
    await atomicWrite(
      this.config.stateFile,
      `${JSON.stringify(after)}\n`,
      0o600,
    );
    if (!notices.length || signal.aborted) return;
    try {
      await this.announce(notices.join("\n\n"), signal);
    } catch {
      // Slack may have accepted the message before timing out. As with
      // maintenance notices, preserve the receipt and avoid duplicate wakes.
      this.log.warn("Crew quota announcement delivery uncertain");
    }
  }

  async work(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        await this.tick(signal);
      } catch {
        if (!signal.aborted)
          this.log.warn("Crew quota policy could not be updated");
      }
      await delay(pollMs, undefined, { signal }).catch(() => {});
    }
  }
}
