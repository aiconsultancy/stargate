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
  settingsCheck,
  settingsDefault,
  settingsPattern,
  settingsRecord,
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

const providerKey = Schema.String.check(
  settingsPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/),
);

const modelPrefix = Schema.String.check(
  settingsPattern(/^[^/\s#]+\/[^\s#]*$/),
).check(Schema.isMaxLength(120));

const actionText = Schema.String.check(
  settingsRefine(
    (text) =>
      text.trim() === text &&
      text.length > 0 &&
      !/\p{Cc}/u.test(text) &&
      Buffer.byteLength(text) <= 180,
    { message: "Use one line of at most 180 UTF-8 bytes" },
  ),
);

const limitSchema = settingsStruct({
  remainingPercent: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: 99 }),
  ),
  action: Schema.Literals(["warn", "pause"]),
  message: Schema.optional(actionText),
});

const providerGuardSchema = settingsStruct({
  modelPrefixes: Schema.Array(modelPrefix).check(Schema.isBetweenLength(1, 20)),
  limits: Schema.Array(limitSchema).check(Schema.isBetweenLength(1, 2)),
}).check(
  settingsCheck(({ limits }, context) => {
    const warn = limits.find(({ action }) => action === "warn");
    const pause = limits.find(({ action }) => action === "pause");

    if (
      limits.length === 2 &&
      (!warn || !pause || warn.remainingPercent <= pause.remainingPercent)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "The warning must be higher than the cutoff, with one of each action",
      });
    }
  }),
);

const defaultLimits = [
  { remainingPercent: 25, action: "warn" },
  { remainingPercent: 20, action: "pause" },
] as const;

export const usageGuardSchema = settingsStruct({
  enabled: Schema.Boolean.pipe(settingsDefault(false)),
  sender: Schema.optional(
    Schema.String.check(settingsPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/)),
  ),
  proxy: Schema.optional(quotaConfigSchema),
  nativeCodexFile: Schema.optional(absolutePath),
  stateFile: Schema.optional(absolutePath),
  captains: Schema.optional(
    Schema.Array(
      settingsStruct({
        account: Schema.String.check(
          settingsPattern(/^[A-Za-z[\]\\`_^{|}][A-Za-z0-9[\]\\`_^{|}-]{0,31}$/),
        ),
        channel: Schema.String.check(
          settingsPattern(/^[#&][^\s,:]{1,49}$/),
        ).check(
          settingsRefine(
            (text) => !/\p{Cc}/u.test(text) && Buffer.byteLength(text) <= 50,
            { message: "Use a valid IRC channel of at most 50 UTF-8 bytes" },
          ),
        ),
      }),
    ),
  ),
  providers: settingsRecord(providerKey, providerGuardSchema).pipe(
    settingsDefault({
      claude: {
        modelPrefixes: ["claude/", "claude-proxy/", "anthropic/"],
        limits: defaultLimits,
      },
      codex: {
        modelPrefixes: [
          "codex/",
          "codex-proxy/",
          "openai-proxy/",
          "openai/gpt-",
          "openai/codex",
        ],
        limits: defaultLimits,
      },
    }),
  ),
  recoveryMessage: Schema.optional(actionText),
}).check(
  settingsCheck((guard, context) => {
    if (
      guard.enabled &&
      (!guard.sender ||
        !guard.proxy ||
        !guard.stateFile ||
        Object.keys(guard.providers).length === 0)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Enabled usageGuard requires sender, proxy, stateFile and at least one provider",
      });
    }

    const prefixes = Object.values(guard.providers).flatMap(
      (provider) => provider.modelPrefixes,
    );

    if (
      prefixes.some((prefix, index) =>
        prefixes
          .slice(index + 1)
          .some(
            (other) => prefix.startsWith(other) || other.startsWith(prefix),
          ),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Usage guard model prefixes must not overlap",
      });
    }
  }),
);

export type UsageGuardConfig = typeof usageGuardSchema.Type;

type QuotaWatchConfig = typeof quotaWatchSchema.Type;

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

async function nativeCodexReading(path: string, now: number): Promise<Reading> {
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
        return { status: "unavailable" };
      }

      const native = decodeNativeQuota(JSON.parse(await file.readFile("utf8")));
      const seen = native.observedAt * 1000;

      if (
        !fresh(seen, now) ||
        (native.resetAt !== null && native.resetAt * 1000 <= now)
      ) {
        return { status: "stale" };
      }

      return {
        status: "ok",
        value: {
          remainingPercent: native.remainingPercent,
          observedAt: seen,
          resetAt: native.resetAt === null ? null : native.resetAt * 1000,
        },
      };
    } finally {
      await file.close();
    }
  } catch {
    // A missing or invalid receipt is unknown; never use a proxy login instead.
    return { status: "unavailable" };
  }
}

type QuotaReading = {
  remainingPercent: number;
  observedAt: number;
  resetAt: number | null;
};

type Reading =
  | { status: "ok"; value: QuotaReading }
  | { status: "unavailable" | "stale" };

function readAccounts(
  accounts: readonly {
    status: string;
    observedAt: number | null;
    windows: readonly {
      remainingPercent: number | null;
      resetAt: number | null;
    }[];
  }[],
  now: number,
): Reading {
  if (accounts.length === 0) {
    return { status: "unavailable" };
  }

  let best: QuotaReading | undefined;
  let observedAt = now;

  for (const account of accounts) {
    const seen = account.observedAt;

    if (
      account.status !== "ok" ||
      seen === null ||
      account.windows.length === 0
    ) {
      return { status: "unavailable" };
    }

    if (!fresh(seen, now)) {
      return { status: "stale" };
    }

    observedAt = Math.min(observedAt, seen);
    let limiting: QuotaReading | undefined;

    for (const { remainingPercent, resetAt } of account.windows) {
      if (remainingPercent === null) {
        return { status: "unavailable" };
      }

      if (resetAt !== null && resetAt <= now) {
        return { status: "stale" };
      }

      if (
        !limiting ||
        remainingPercent < limiting.remainingPercent ||
        (remainingPercent === limiting.remainingPercent &&
          (resetAt ?? Infinity) < (limiting.resetAt ?? Infinity))
      ) {
        limiting = { remainingPercent, resetAt, observedAt: seen };
      }
    }

    if (
      limiting &&
      (!best || limiting.remainingPercent > best.remainingPercent)
    ) {
      best = limiting;
    }
  }

  return best
    ? { status: "ok", value: { ...best, observedAt } }
    : { status: "unavailable" };
}

export async function quotaReading(
  snapshot: QuotaSnapshot,
  provider: string,
  nativeCodexFile: string | undefined,
  now: number,
): Promise<Reading> {
  if (provider === "codex" && nativeCodexFile) {
    return nativeCodexReading(nativeCodexFile, now);
  }

  if (provider !== "claude" && provider !== "codex") {
    return readAccounts(
      snapshot.pluginAccounts?.filter((row) => row.provider === provider) ?? [],
      now,
    );
  }

  return readAccounts(
    snapshot.accounts
      .filter((row) => row.provider === provider)
      .map((row) => ({
        ...row,
        windows: row.windows.filter(
          (window) =>
            window.scope === "subscription" && window.active !== false,
        ),
      })),
    now,
  );
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

    const pluginProviders = new Set(
      (snapshot.pluginAccounts ?? []).map((row) => row.provider),
    );

    pluginProviders.delete("claude");
    pluginProviders.delete("codex");
    const watched = [...this.config.providers, ...pluginProviders];

    for (const provider of watched) {
      const builtIn = provider === "claude" || provider === "codex";

      const reading = await quotaReading(
        snapshot,
        provider,
        this.config.nativeCodexFile,
        now,
      );

      const current =
        reading.status === "ok"
          ? policy(reading.value.remainingPercent, reading.value.observedAt)
          : undefined;

      const previous = Object.hasOwn(before, provider)
        ? before[provider]
        : undefined;

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

      const name = builtIn
        ? provider === "claude"
          ? "Claude"
          : "Codex"
        : pluginLabel(snapshot, provider);

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
