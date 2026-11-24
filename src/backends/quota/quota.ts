import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
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
  remainingPercent: Schema.NullOr(
    Schema.Finite.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(100),
    ),
  ),
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
  auth_index: Schema.optional(
    Schema.Union([
      credentialText,
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    ]),
  ),
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

const decodeCall = Schema.decodeUnknownSync(
  Schema.Struct({ status_code: Schema.Int, body: Schema.Unknown }),
);

const decodeObservation = Schema.decodeUnknownSync(quotaObservationSchema);

const upstreams = {
  claude: "https://api.anthropic.com/api/oauth/usage",
  codex: "https://chatgpt.com/backend-api/wham/usage",
} as const;

const ttl = 60_000;

/** The proxy's management request that reads one upstream usage endpoint. */
type ApiCallBody = {
  auth_index: string;
  method: "GET";
  url: string;
  header: Record<string, string>;
};

/** One opt-in reader per host binding. No URL/auth/reset controls reach callers. */
export class QuotaReader {
  private readonly config: typeof quotaConfigSchema.Type | undefined;
  private cache?: QuotaObservation;
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

      const selected = this.config.accounts;

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

        const account: QuotaObservation["accounts"][number] = {
          provider,
          account: `${provider}-${++counts[provider]}`,
          status: "unavailable",
          observedAt: null,
          windows: [],
          // The proxy's auth_index hashes stable auth-file identity, not list
          // Position. Hash again with the provider to keep this key private.
          ...(file.auth_index !== undefined && {
            identity: `sha256:${createHash("sha256")
              .update(JSON.stringify([provider, String(file.auth_index)]))
              .digest("hex")}`,
          }),
        };

        snapshot.accounts.push(account);

        try {
          if (file.auth_index === undefined) {
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
                auth_index: String(file.auth_index),
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
    body?: ApiCallBody,
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
  } else if (snapshot.accounts.length === 0) {
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

  return lines;
}
