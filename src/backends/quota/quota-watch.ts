import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import type { Logger } from "pino";
import {
  atomicWrite,
  readOptional,
} from "../../automation/maintenance/nightly/files";
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
} from "../../config/settings-schema";

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

const epochSeconds = Schema.Int.check(Schema.isGreaterThan(0));

const observation = settingsStruct({
  mode: Schema.Literals(["normal", "limited", "paused"]),
  observedAt: epochSeconds,
});

const policyKey = Schema.String.check(
  settingsPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/),
);

const decodePolicy = Schema.decodeUnknownSync(
  Schema.Record(policyKey, observation),
);

type Policy = Record<string, Observation>;

type Observation = typeof observation.Type;

const pollMs = 120_000;

const decodeNativeQuota = Schema.decodeUnknownSync(
  settingsStruct({
    remainingPercent: Schema.Finite.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(100),
    ),
    observedAt: epochSeconds,
    resetAt: Schema.NullOr(epochSeconds),
  }),
);

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
      ) {
        return;
      }

      const native = decodeNativeQuota(JSON.parse(await file.readFile("utf8")));
      const seen = native.observedAt * 1000;

      if (
        !fresh(seen, now) ||
        (native.resetAt !== null && native.resetAt * 1000 <= now)
      ) {
        return;
      }

      return policy(native.remainingPercent, seen);
    } finally {
      await file.close();
    }
  } catch {
    // A missing or invalid receipt is unknown; never use a proxy login instead.
    return;
  }
}

function currentPolicy(
  snapshot: QuotaSnapshot,
  provider: Provider,
  now: number,
): Observation | undefined {
  const accounts = snapshot.accounts.filter((row) => row.provider === provider);

  if (accounts.length === 0) {
    return;
  }

  let remaining = 0;
  let observedAt = now;

  for (const account of accounts) {
    const seen = account.observedAt;

    if (account.status !== "ok" || seen === null || !fresh(seen, now)) {
      return;
    }

    const windows = account.windows.filter(
      (window) => window.scope === "subscription" && window.active !== false,
    );

    if (windows.length === 0) {
      return;
    }

    let usable = 100;

    for (const { remainingPercent, resetAt } of windows) {
      if (remainingPercent === null || (resetAt !== null && resetAt <= now)) {
        return;
      }

      usable = Math.min(usable, remainingPercent);
    }

    remaining = Math.max(remaining, usable);
    observedAt = Math.min(observedAt, seen);
  }

  return policy(remaining, observedAt);
}

function currentPluginPolicy(
  snapshot: QuotaSnapshot,
  provider: string,
  now: number,
): Observation | undefined {
  const accounts = snapshot.pluginAccounts?.filter(
    (row) => row.provider === provider,
  );

  if (!accounts || accounts.length === 0) {
    return;
  }

  let remaining = 0;
  let observedAt = now;

  for (const account of accounts) {
    if (account.status !== "ok" || !fresh(account.observedAt, now)) {
      return;
    }

    if (account.windows.length === 0) {
      return;
    }

    let usable = 100;

    for (const { remainingPercent, resetAt } of account.windows) {
      if (resetAt !== null && resetAt <= now) {
        return;
      }

      usable = Math.min(usable, remainingPercent);
    }

    remaining = Math.max(remaining, usable);
    observedAt = Math.min(observedAt, account.observedAt);
  }

  return policy(remaining, observedAt);
}

function pluginLabel(snapshot: QuotaSnapshot, provider: string): string {
  return (
    snapshot.pluginAccounts?.find((row) => row.provider === provider)?.label ??
    provider
  );
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
  public constructor(
    private readonly config: QuotaWatchConfig,
    private readonly reader: Pick<QuotaReader, "read">,
    private readonly announce: (
      text: string,
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly log: Pick<Logger, "warn">,
    private readonly now = Date.now,
  ) {}

  public async tick(signal: AbortSignal) {
    const snapshot = await this.reader.read(signal);
    signal.throwIfAborted();
    const raw = await readOptional(this.config.stateFile);
    const before: Policy = raw === null ? {} : decodePolicy(JSON.parse(raw));
    const after: Policy = { ...before };
    const notices: string[] = [];
    let updated = false;
    const now = this.now();

    // Configured OAuth providers plus every discovered plugin provider,
    // So adding or removing a provider is automatic.
    const pluginProviders = new Set(
      (snapshot.pluginAccounts ?? []).map((row) => row.provider),
    );

    const watched = [...this.config.providers, ...pluginProviders];

    for (const provider of watched) {
      const isPlugin =
        pluginProviders.has(provider) &&
        !this.config.providers.includes(provider as Provider);

      const current =
        !isPlugin && provider === "codex" && this.config.nativeCodexFile
          ? await nativeCodexPolicy(this.config.nativeCodexFile, now)
          : isPlugin
            ? currentPluginPolicy(snapshot, provider, now)
            : currentPolicy(snapshot, provider as Provider, now);

      const previous = before[provider];

      if (!current || (previous && current.observedAt <= previous.observedAt)) {
        continue;
      }

      after[provider] = current;
      updated = true;

      if (
        previous?.mode === current.mode ||
        (!previous && current.mode === "normal")
      ) {
        continue;
      }

      const name = isPlugin
        ? pluginLabel(snapshot, provider)
        : provider === "claude"
          ? "Claude"
          : "Codex";

      notices.push(
        `${name} crew quota: ${heading[current.mode]} ${message[current.mode]}`,
      );
    }

    if (!updated) {
      return;
    }

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

    if (notices.length === 0 || signal.aborted) {
      return;
    }

    try {
      await this.announce(notices.join("\n\n"), signal);
    } catch {
      // Slack may have accepted the message before timing out. As with
      // Maintenance notices, preserve the receipt and avoid duplicate wakes.
      this.log.warn("Crew quota announcement delivery uncertain");
    }
  }

  public async work(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        await this.tick(signal);
      } catch {
        if (!signal.aborted) {
          this.log.warn("Crew quota policy could not be updated");
        }
      }

      await delay(pollMs, undefined, { signal }).catch(() => {});
    }
  }
}
