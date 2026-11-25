import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Option, Schema } from "effect";
import { isLoopbackAddress } from "../../lib/loopback";
import {
  settingsEmail,
  settingsPattern,
  settingsRecord,
  settingsRefine,
  settingsStruct,
  settingsURL,
} from "../../config/settings-schema";

const accountEmails = Schema.mutable(Schema.Array(settingsEmail))
  .check(Schema.isMinLength(1))
  .check(Schema.isMaxLength(10));

export const quotaInputSchema = settingsStruct({});

export const quotaConfigSchema = settingsStruct({
  baseURL: settingsURL.check(
    settingsRefine(
      (value) => {
        const url = new URL(value);

        return (
          url.protocol === "http:" &&
          isLoopbackAddress(url.hostname) &&
          !url.username &&
          !url.password &&
          url.pathname === "/" &&
          !url.search &&
          !url.hash &&
          !/[?#\\\s]/.test(value)
        );
      },
      {
        message:
          "Use a loopback HTTP origin without credentials, path, query or fragment",
      },
    ),
  ),
  accounts: Schema.optional(
    settingsStruct({
      claude: Schema.optional(accountEmails),
      codex: Schema.optional(accountEmails),
    }),
  ),
  managementKeyFile: Schema.String.check(
    settingsRefine((value) => isAbsolute(value) && !value.includes("\0"), {
      message: "Invalid input",
    }),
  ),
});

const providerSchema = Schema.Literals(["claude", "codex"]);

type Provider = typeof providerSchema.Type;

const providers: readonly Provider[] = ["claude", "codex"];

const percent = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1_000_000),
);

const timestamp = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(8_640_000_000_000_000),
);

// The installed Zod 4.6.7 ISO date-time with an optional offset.
const offsetDateTime = Schema.String.check(
  settingsPattern(
    /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$/,
  ),
);

const remainingPercent = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(100),
);

const pluginProvider = Schema.String.check(
  settingsPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/),
);

const pluginLabel = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(128),
);

const pluginPlan = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(64),
);

const pluginWindowName = Schema.String.check(Schema.isMaxCodePoints(64));

const pluginAccount = settingsStruct({
  provider: pluginProvider,
  label: pluginLabel,
  status: Schema.Literals(["ok", "unavailable"]),
  observedAt: timestamp,
  plan: Schema.NullOr(pluginPlan),
  windows: Schema.mutable(
    Schema.Array(
      settingsStruct({
        window: pluginWindowName,
        remainingPercent,
        resetAt: Schema.NullOr(timestamp),
      }),
    ),
  ).check(Schema.isMaxLength(16)),
});

const maxPluginAccounts = 20;
const decodePluginAccount = Schema.decodeUnknownSync(pluginAccount);

const scopeSchema = Schema.Literals([
  "subscription",
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "code-review",
]);

const windowSchema = settingsStruct({
  window: Schema.Literals(["5h", "weekly", "other"]),
  scope: scopeSchema,
  usedPercent: Schema.NullOr(percent),
  remainingPercent: Schema.NullOr(remainingPercent),
  resetAt: Schema.NullOr(timestamp),
  active: Schema.NullOr(Schema.Boolean),
});

const windowList = Schema.mutable(Schema.Array(windowSchema));

const accountFields = {
  provider: providerSchema,
  account: Schema.String.check(settingsPattern(/^(claude|codex)-[1-9][0-9]?$/)),
  status: Schema.Literals(["ok", "unavailable"]),
  observedAt: Schema.NullOr(timestamp),
  windows: windowList.check(Schema.isMaxLength(16)),
};

const snapshotFields = {
  status: Schema.Literals(["not-configured", "ok", "partial", "unavailable"]),
  observedAt: timestamp,
  cached: Schema.Boolean,
  pluginAccounts: Schema.optional(
    Schema.mutable(Schema.Array(pluginAccount)).check(
      Schema.isMaxLength(maxPluginAccounts),
    ),
  ),
};

export const quotaSnapshotSchema = settingsStruct({
  ...snapshotFields,
  accounts: Schema.mutable(Schema.Array(settingsStruct(accountFields))).check(
    Schema.isMaxLength(10),
  ),
});

export type QuotaSnapshot = typeof quotaSnapshotSchema.Type;

/** Private cron transport only. Never return identities through quota tools. */
const observedAccount = settingsStruct({
  ...accountFields,
  identity: Schema.optional(
    Schema.String.check(settingsPattern(/^sha256:[a-f0-9]{64}$/)),
  ),
});

export const quotaObservationSchema = settingsStruct({
  ...snapshotFields,
  accounts: Schema.mutable(Schema.Array(observedAccount)).check(
    Schema.isMaxLength(10),
  ),
});

export type QuotaObservation = typeof quotaObservationSchema.Type;

type Window = typeof windowSchema.Type;

const decodeRecord = Schema.decodeUnknownSync(
  settingsRecord(Schema.String, Schema.Unknown),
);

const decodeClaudeWindow = Schema.decodeUnknownSync(
  Schema.Struct({
    utilization: Schema.NullOr(percent),
    resets_at: Schema.optional(Schema.NullOr(offsetDateTime)),
  }),
);

const decodeCodexWindow = Schema.decodeUnknownSync(
  Schema.Struct({
    used_percent: Schema.NullOr(percent),
    reset_at: Schema.optional(Schema.NullOr(timestamp)),
    limit_window_seconds: Schema.optional(
      Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
    ),
  }),
);

const decodeLimits = Schema.decodeUnknownSync(
  Schema.Array(Schema.Unknown).check(Schema.isMaxLength(100)),
);

const limitModel = Schema.Struct({
  display_name: Schema.String.check(Schema.isMaxCodePoints(100)),
});

const limitScope = Schema.Struct({
  model: Schema.optional(Schema.NullOr(limitModel)),
});

const decodeLimit = Schema.decodeUnknownSync(
  Schema.Struct({
    kind: Schema.String,
    percent: Schema.optional(Schema.NullOr(percent)),
    resets_at: Schema.optional(Schema.NullOr(offsetDateTime)),
    is_active: Schema.optional(Schema.NullOr(Schema.Boolean)),
    scope: Schema.optional(Schema.NullOr(limitScope)),
  }),
);

const decodeScope = Schema.decodeUnknownSync(scopeSchema);
const decodeWindows = Schema.decodeUnknownSync(windowList);

function windowOf(seconds: number | null | undefined): Window["window"] {
  switch (seconds) {
    case 18_000:
      return "5h";
    case 604_800:
      return "weekly";
    default:
      return "other";
  }
}

/** Whitelisted numeric fields only. Missing limits are unknown, never free quota. */
export function parseQuotaWindows(
  provider: Provider,
  input: unknown,
): Window[] {
  const data = decodeRecord(input);
  const windows: Window[] = [];

  const add = (
    window: Window["window"],
    scope: Window["scope"],
    usedPercent: number | null,
    resetAt: number | null,
    active: boolean | null = null,
  ) => {
    windows.push({
      window,
      scope,
      usedPercent,
      remainingPercent:
        usedPercent === null ? null : Math.max(0, 100 - usedPercent),
      resetAt,
      active,
    });
  };

  if (provider === "claude") {
    const names = [
      ["five_hour", "5h", "subscription"],
      ["seven_day", "weekly", "subscription"],
      ["seven_day_opus", "weekly", "opus"],
      ["seven_day_sonnet", "weekly", "sonnet"],
    ] as const;

    for (const [name, window, scope] of names) {
      if (data[name] === null || data[name] === undefined) {
        continue;
      }

      const value = decodeClaudeWindow(data[name]);
      add(
        window,
        scope,
        value.utilization,
        value.resets_at ? Date.parse(value.resets_at) : null,
      );
    }

    if (data["limits"] !== null && data["limits"] !== undefined) {
      for (const raw of decodeLimits(data["limits"])) {
        const limit = decodeLimit(raw);
        const family = limit.scope?.model?.display_name.toLowerCase();
        const scope = family === "fable 5" ? "fable" : family;

        if (
          limit.kind !== "weekly_scoped" ||
          !scope ||
          !["opus", "sonnet", "haiku", "fable"].includes(scope)
        ) {
          continue;
        }

        add(
          "weekly",
          decodeScope(scope),
          limit.percent ?? null,
          limit.resets_at ? Date.parse(limit.resets_at) : null,
          limit.is_active ?? null,
        );
      }
    }
  } else {
    for (const [name, scope] of [
      ["rate_limit", "subscription"],
      ["code_review_rate_limit", "code-review"],
    ] as const) {
      if (data[name] === null || data[name] === undefined) {
        continue;
      }

      const family = decodeRecord(data[name]);

      for (const name of ["primary_window", "secondary_window"]) {
        if (family[name] === null || family[name] === undefined) {
          continue;
        }

        const value = decodeCodexWindow(family[name]);
        add(
          windowOf(value.limit_window_seconds),
          scope,
          value.used_percent,
          value.reset_at === null || value.reset_at === undefined
            ? null
            : value.reset_at * 1000,
        );
      }
    }
  }

  if (windows.length === 0 || windows.length > 16) {
    throw new Error("Quota windows unavailable");
  }

  return decodeWindows(windows);
}

const credentialText = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(256),
);

const credentialFile = Schema.Struct({
  provider: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  auth_index: Schema.optional(Schema.Unknown),
  disabled: Schema.optional(Schema.Boolean),
  email: Schema.optional(Schema.String),
  account_id: Schema.optional(credentialText),
  chatgpt_account_id: Schema.optional(credentialText),
});

const decodeCredentials = Schema.decodeUnknownSync(
  Schema.Struct({
    files: Schema.Array(credentialFile).check(Schema.isMaxLength(100)),
  }),
);

const decodeProvider = Schema.decodeUnknownOption(providerSchema);

const decodeAuthIndex = Schema.decodeUnknownOption(
  Schema.Union([
    credentialText,
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ]),
);

const decodeCall = Schema.decodeUnknownSync(
  Schema.Struct({ status_code: Schema.Int, body: Schema.Unknown }),
);

const decodeObservation = Schema.decodeUnknownSync(quotaObservationSchema);

const upstreams = {
  claude: "https://api.anthropic.com/api/oauth/usage",
  codex: "https://chatgpt.com/backend-api/wham/usage",
} as const;

const ttl = 60_000;

type ApiCallBody = {
  auth_index: string;
  method: "GET";
  url: string;
  header: Record<string, string>;
};

type QuotaFetchBody = { auth_index: string };

export type QuotaRequest = (
  path: string,
  signal: AbortSignal,
  body?: QuotaFetchBody,
) => Promise<unknown>;

export type QuotaCredential = Pick<
  typeof credentialFile.Type,
  "provider" | "type" | "auth_index" | "disabled"
>;

const decodePluginDiscovery = Schema.decodeUnknownSync(
  Schema.Struct({
    providers: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(20)),
  }),
);

const decodePluginProvider = Schema.decodeUnknownOption(
  Schema.Struct({
    provider: pluginProvider,
    display_name: pluginLabel,
    supported_providers: Schema.optional(
      Schema.Array(pluginProvider).check(Schema.isMaxLength(100)),
    ),
  }),
);

const pluginBucket = Schema.Struct({
  window: Schema.optional(pluginWindowName),
  remainingFraction: Schema.Finite.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(1),
  ),
  resetTime: Schema.optional(Schema.NullOr(offsetDateTime)),
});

const pluginGroup = Schema.Struct({
  buckets: Schema.Array(pluginBucket).check(Schema.isMaxLength(16)),
});

const decodePluginFetch = Schema.decodeUnknownSync(
  Schema.Struct({
    subscription: Schema.optional(
      Schema.Struct({ plan: Schema.optional(pluginPlan) }),
    ),
    groups: Schema.optional(
      Schema.Array(pluginGroup).check(Schema.isMaxLength(8)),
    ),
  }),
);

export async function readPluginQuota(
  request: QuotaRequest,
  credentials: readonly QuotaCredential[],
  signal: AbortSignal,
  now: () => number,
): Promise<(typeof pluginAccount.Type)[]> {
  const discovery = decodePluginDiscovery(
    await request("/v0/management/quota/providers", signal),
  );

  const supported = new Map<string, string>();
  const aliases = new Map<string, string>();

  for (const row of discovery.providers) {
    const entry = decodePluginProvider(row);

    if (Option.isNone(entry)) {
      continue;
    }

    const { provider, display_name, supported_providers } = entry.value;
    supported.set(provider, display_name);

    for (const alias of supported_providers ?? []) {
      if (!aliases.has(alias)) {
        aliases.set(alias, display_name);
      }
    }
  }

  const accounts: (typeof pluginAccount.Type)[] = [];
  const labelled = new Map<string, number>();

  for (const file of credentials) {
    if (accounts.length === maxPluginAccounts) {
      break;
    }

    const provider = file.provider ?? file.type;

    if (
      file.disabled ||
      !provider ||
      provider === "claude" ||
      provider === "codex"
    ) {
      continue;
    }

    const base = supported.get(provider) ?? aliases.get(provider);

    if (!base) {
      continue;
    }

    const seen = (labelled.get(provider) ?? 0) + 1;
    labelled.set(provider, seen);
    const suffix = seen === 1 ? "" : ` ${seen}`;

    const label =
      Array.from(base)
        .slice(0, 128 - suffix.length)
        .join("") + suffix;

    const account = decodePluginAccount({
      provider,
      label,
      status: "unavailable",
      observedAt: now(),
      plan: null,
      windows: [],
    });

    const authIndex = decodeAuthIndex(file.auth_index);

    if (Option.isNone(authIndex)) {
      accounts.push(account);
      continue;
    }

    try {
      const fetched = decodePluginFetch(
        await request("/v0/management/quota/fetch", signal, {
          auth_index: String(authIndex.value),
        }),
      );

      const windows = (fetched.groups ?? []).flatMap((group) =>
        group.buckets.map((bucket) => ({
          window: bucket.window?.length ? bucket.window : "other",
          remainingPercent: Math.round(bucket.remainingFraction * 10_000) / 100,
          resetAt: bucket.resetTime ? Date.parse(bucket.resetTime) : null,
        })),
      );

      accounts.push(
        decodePluginAccount({
          ...account,
          status: windows.length > 0 ? "ok" : "unavailable",
          plan: fetched.subscription?.plan ?? null,
          windows,
        }),
      );
    } catch {
      signal.throwIfAborted();
      accounts.push(account);
    }
  }

  return accounts;
}

/** One opt-in reader per host binding. No URL/auth/reset controls reach callers. */
export class QuotaReader {
  private readonly config: typeof quotaConfigSchema.Type | undefined;
  private cache?: QuotaObservation;
  private pending?: Promise<QuotaObservation> | undefined;
  public constructor(
    config?: typeof quotaConfigSchema.Encoded,
    private readonly now = Date.now,
    private readonly monitoredProviders = providers,
  ) {
    this.config =
      config === undefined
        ? undefined
        : Schema.decodeUnknownSync(quotaConfigSchema)(config);
  }

  public async read(caller: AbortSignal): Promise<QuotaSnapshot> {
    const snapshot = await this.readForCron(caller);

    return {
      ...snapshot,
      accounts: snapshot.accounts.map(({ identity: _, ...account }) => account),
    };
  }

  public async readForCron(caller: AbortSignal): Promise<QuotaObservation> {
    caller.throwIfAborted();
    const now = this.now();

    if (!this.config) {
      return {
        status: "not-configured",
        observedAt: now,
        cached: false,
        accounts: [],
      };
    }

    if (
      this.cache &&
      now >= this.cache.observedAt &&
      now - this.cache.observedAt < ttl
    ) {
      return structuredClone({ ...this.cache, cached: true });
    }

    if (this.pending) {
      const stopped = Promise.withResolvers<void>();

      const abort = () => {
        stopped.reject(caller.reason);
      };

      caller.addEventListener("abort", abort, { once: true });

      try {
        await Promise.race([this.pending.catch(() => {}), stopped.promise]);
      } finally {
        caller.removeEventListener("abort", abort);
      }

      return this.readForCron(caller);
    }

    this.pending = this.refresh(now, caller);

    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  private async refresh(
    now: number,
    caller: AbortSignal,
  ): Promise<QuotaObservation> {
    const config = this.config;

    if (!config) {
      throw new Error("Quota not configured");
    }

    const signal = AbortSignal.any([caller, AbortSignal.timeout(8000)]);

    let snapshot: QuotaObservation = {
      status: "unavailable",
      observedAt: now,
      cached: false,
      accounts: [],
    };

    try {
      const key = await this.key();
      signal.throwIfAborted();

      const credentials = decodeCredentials(
        await this.request("/v8/management/credentials", key, signal),
      );

      const selected = config.accounts;

      const active = credentials.files.filter((file) => {
        const provider = decodeProvider(file.provider ?? file.type);

        if (
          file.disabled ||
          Option.isNone(provider) ||
          !this.monitoredProviders.includes(provider.value)
        ) {
          return false;
        }

        const emails = selected?.[provider.value];

        return (
          !emails ||
          emails.some(
            (email) => email.toLowerCase() === file.email?.toLowerCase(),
          )
        );
      });

      const missing = this.monitoredProviders.map((provider) => {
        const files = active.filter(
          (file) => (file.provider ?? file.type) === provider,
        );

        const count =
          selected?.[provider]?.filter(
            (email) =>
              !files.some(
                (file) => file.email?.toLowerCase() === email.toLowerCase(),
              ),
          ).length ?? (files.length > 0 ? 0 : 1);

        return { provider, count };
      });

      if (
        active.length + missing.reduce((sum, item) => sum + item.count, 0) >
        10
      ) {
        throw new Error("Too many quota accounts");
      }

      const counts = { claude: 0, codex: 0 };

      // Sequential, bounded reads avoid bursting subscription status endpoints.
      for (const file of active) {
        const provider = Schema.decodeUnknownSync(providerSchema)(
          file.provider ?? file.type,
        );

        const authIndex = decodeAuthIndex(file.auth_index);

        const account: QuotaObservation["accounts"][number] = {
          provider,
          account: `${provider}-${++counts[provider]}`,
          status: "unavailable",
          observedAt: null,
          windows: [],
          // The proxy's auth_index hashes stable auth-file identity, not list
          // Position. Hash again with the provider to keep this key private.
          ...(Option.isSome(authIndex) && {
            identity: `sha256:${createHash("sha256")
              .update(JSON.stringify([provider, String(authIndex.value)]))
              .digest("hex")}`,
          }),
        };

        snapshot.accounts.push(account);

        try {
          if (Option.isNone(authIndex)) {
            continue;
          }

          const header: Record<string, string> = {
            Authorization: "Bearer $TOKEN$",
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent":
              provider === "claude"
                ? "claude-cli/2.1.280 (external, cli)"
                : "codex-tui/0.149.1",
          };

          if (provider === "claude") {
            header["anthropic-beta"] = "oauth-2025-04-20";
          }

          const accountID = file.chatgpt_account_id ?? file.account_id;

          if (provider === "codex" && accountID) {
            header["Chatgpt-Account-Id"] = accountID;
          }

          const result = decodeCall(
            await this.request(
              "/v8/management/requests/api-call",
              key,
              signal,
              {
                auth_index: String(authIndex.value),
                method: "GET",
                url: upstreams[provider],
                header,
              },
            ),
          );

          if (result.status_code !== 200) {
            continue;
          }

          account.windows = parseQuotaWindows(
            provider,
            typeof result.body === "string"
              ? JSON.parse(result.body)
              : result.body,
          );
          account.status = "ok";
          account.observedAt = this.now();
        } catch {
          // Account failures never return upstream error bodies or SDK objects.
          signal.throwIfAborted();
        }
      }

      for (const { provider, count } of missing) {
        for (let skipped = 0; skipped < count; skipped++) {
          snapshot.accounts.push({
            provider,
            account: `${provider}-${++counts[provider]}`,
            status: "unavailable",
            observedAt: null,
            windows: [],
          });
        }
      }

      const available = snapshot.accounts.filter(
        (account) => account.status === "ok",
      ).length;

      snapshot.status =
        available === snapshot.accounts.length
          ? "ok"
          : available
            ? "partial"
            : "unavailable";
      snapshot = decodeObservation(snapshot);

      // Keep the built-in snapshot if the optional plugin pass times out.
      try {
        snapshot.pluginAccounts = await readPluginQuota(
          (path, inner, body) => this.request(path, key, inner, body),
          credentials.files,
          AbortSignal.any([signal, AbortSignal.timeout(2000)]),
          this.now,
        );
      } catch {
        caller.throwIfAborted();
      }
    } catch {
      // No raw request, credential metadata, exception or account text escapes.
      caller.throwIfAborted();
      snapshot = {
        status: "unavailable",
        observedAt: now,
        cached: false,
        accounts: [],
      };
    }

    caller.throwIfAborted();
    this.cache = snapshot;

    return structuredClone(snapshot);
  }

  private async key() {
    if (!this.config) {
      throw new Error("Quota not configured");
    }

    const file = await open(
      this.config.managementKeyFile,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );

    try {
      const stat = await file.stat();

      if (
        !stat.isFile() ||
        (stat.mode & 0o077) !== 0 ||
        stat.uid !== process.getuid?.() ||
        stat.size > 4096
      ) {
        throw new Error("Private quota key required");
      }

      const key = (await file.readFile("utf8")).trim();

      if (!key || /\s/.test(key)) {
        throw new Error("Invalid quota key");
      }

      return key;
    } finally {
      await file.close();
    }
  }

  private async request(
    path: string,
    key: string,
    signal: AbortSignal,
    body?: ApiCallBody | QuotaFetchBody,
  ): Promise<unknown> {
    if (!this.config) {
      throw new Error("Quota not configured");
    }

    const response = await fetch(new URL(path, this.config.baseURL), {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      ...(body && { body: JSON.stringify(body) }),
    });

    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("Quota request failed");
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;

    try {
      for (;;) {
        const chunk = await reader.read();

        if (chunk.done) {
          break;
        }

        bytes += chunk.value.byteLength;

        if (bytes > 1024 * 1024) {
          throw new Error("Quota response too large");
        }

        chunks.push(chunk.value);
      }

      signal.throwIfAborted();

      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      await reader.cancel();
    }
  }
}

export function formatQuota(
  snapshot: QuotaSnapshot,
  now = Date.now(),
): string[] {
  const lines = [
    "Subscription quota, not token counts. Missing limits and model applicability are unknown. Accounts are separate; percentages cannot be added.",
    `Snapshot: ${new Date(snapshot.observedAt).toISOString()}${snapshot.cached ? " (cached up to 60s)" : ""}.`,
  ];

  if (snapshot.status === "not-configured") {
    lines.push("Quota reader not configured.");
  } else if (
    snapshot.accounts.length === 0 &&
    !snapshot.pluginAccounts?.length
  ) {
    lines.push(
      "Quota unavailable. Check proxy access and private management-key configuration.",
    );
  }

  for (const account of snapshot.accounts) {
    lines.push(
      `${account.account}: ${account.status === "ok" ? `observed ${new Date(account.observedAt ?? snapshot.observedAt).toISOString()}` : "unavailable; quota unknown"}`,
    );

    for (const window of account.windows) {
      const expired = window.resetAt !== null && window.resetAt <= now;
      lines.push(
        `${window.scope} ${window.window}: ${window.usedPercent ?? "unknown"}% used; ${window.remainingPercent ?? "unknown"}% remaining. Reset: ${window.resetAt === null ? "unknown" : new Date(window.resetAt).toISOString()}.${window.active === false ? " INACTIVE scope; not routing evidence." : ""}${expired ? " Reset passed; current allowance unknown." : ""}`,
      );
    }
  }

  for (const account of snapshot.pluginAccounts ?? []) {
    lines.push(
      `${account.label}: ${account.status === "ok" ? (account.plan ?? "observed") : "unavailable; quota unknown"}`,
    );

    for (const { window, remainingPercent, resetAt } of account.windows) {
      const reset =
        resetAt === null ? "unknown" : new Date(resetAt).toISOString();

      const expired = resetAt !== null && resetAt <= now;
      lines.push(
        `${window}: ${remainingPercent}% remaining. Reset: ${reset}.${expired ? " Reset passed; current allowance unknown." : ""}`,
      );
    }
  }

  return lines;
}

const receiptSchema = settingsStruct({
  remainingPercent: Schema.Finite,
  observedAt: Schema.Int,
  resetAt: Schema.NullOr(Schema.Int),
  modelPrefixes: Schema.Array(Schema.String),
  mode: Schema.Literals(["normal", "warn", "pause"]),
  notice: Schema.NullOr(
    Schema.Literals(["warn", "pause", "recover", "reopen"]),
  ),
  attempted: Schema.Array(Schema.String),
});

const guardStateSchema = settingsRecord(Schema.String, receiptSchema);
const decodeGuard = Schema.decodeUnknownSync(guardStateSchema);

export type GuardState = typeof guardStateSchema.Type;

export async function readUsageGuard(path: string): Promise<GuardState> {
  const raw = await readFile(path, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }

      throw error;
    },
  );

  return raw === null ? {} : decodeGuard(JSON.parse(raw));
}

export async function crewUsageBlock(path: string, model: string | undefined) {
  const state = await readUsageGuard(path);

  return Object.entries(state).find(
    ([, receipt]) =>
      receipt.mode === "pause" &&
      model !== undefined &&
      receipt.modelPrefixes.some((prefix) => model.startsWith(prefix)),
  )?.[0];
}
