import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { isLoopbackAddress } from "./loopback";

const accountEmails = z.array(z.email()).min(1).max(10);
export const quotaInputSchema = z.strictObject({});
export const quotaConfigSchema = z.strictObject({
  baseURL: z.url().refine((value) => {
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
  }, "Use a loopback HTTP origin without credentials, path, query or fragment"),
  accounts: z
    .strictObject({
      claude: accountEmails.optional(),
      codex: accountEmails.optional(),
    })
    .optional(),
  managementKeyFile: z
    .string()
    .refine((value) => isAbsolute(value) && !value.includes("\0")),
});
const providerSchema = z.enum(["claude", "codex"]);
type Provider = z.infer<typeof providerSchema>;
const providers: readonly Provider[] = ["claude", "codex"];
const percent = z.number().finite().min(0).max(1_000_000);
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000);
const scopeSchema = z.enum([
  "subscription",
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "code-review",
]);
const windowSchema = z.strictObject({
  window: z.enum(["5h", "weekly", "other"]),
  scope: scopeSchema,
  usedPercent: percent.nullable(),
  remainingPercent: z.number().min(0).max(100).nullable(),
  resetAt: timestamp.nullable(),
  active: z.boolean().nullable(),
});
export const quotaSnapshotSchema = z.strictObject({
  status: z.enum(["not-configured", "ok", "partial", "unavailable"]),
  observedAt: timestamp,
  cached: z.boolean(),
  accounts: z
    .array(
      z.strictObject({
        provider: providerSchema,
        account: z.string().regex(/^(claude|codex)-[1-9][0-9]?$/),
        status: z.enum(["ok", "unavailable"]),
        observedAt: timestamp.nullable(),
        windows: z.array(windowSchema).max(16),
      }),
    )
    .max(10),
});
export type QuotaSnapshot = z.infer<typeof quotaSnapshotSchema>;
type Window = z.infer<typeof windowSchema>;
const recordSchema = z.record(z.string(), z.unknown());
const claudeWindow = z.object({
  utilization: percent.nullable(),
  resets_at: z.iso.datetime({ offset: true }).nullish(),
});
const codexWindow = z.object({
  used_percent: percent.nullable(),
  reset_at: timestamp.nullish(),
  limit_window_seconds: z.number().int().positive().nullish(),
});

/** Whitelisted numeric fields only. Missing limits are unknown, never free quota. */
export function parseQuotaWindows(
  provider: Provider,
  input: unknown,
): Window[] {
  const data = recordSchema.parse(input);
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
      if (data[name] == null) continue;
      const value = claudeWindow.parse(data[name]);
      add(
        window,
        scope,
        value.utilization,
        value.resets_at ? Date.parse(value.resets_at) : null,
      );
    }
    if (data["limits"] != null) {
      for (const raw of z.array(z.unknown()).max(100).parse(data["limits"])) {
        const limit = z
          .object({
            kind: z.string(),
            percent: percent.nullish(),
            resets_at: z.iso.datetime({ offset: true }).nullish(),
            is_active: z.boolean().nullish(),
            scope: z
              .object({
                model: z
                  .object({ display_name: z.string().max(100) })
                  .nullish(),
              })
              .nullish(),
          })
          .parse(raw);
        const family = limit.scope?.model?.display_name.toLowerCase();
        const scope = family === "fable 5" ? "fable" : family;
        if (
          limit.kind !== "weekly_scoped" ||
          !scope ||
          !["opus", "sonnet", "haiku", "fable"].includes(scope)
        )
          continue;
        add(
          "weekly",
          scopeSchema.parse(scope),
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
      if (data[name] == null) continue;
      const family = recordSchema.parse(data[name]);
      for (const name of ["primary_window", "secondary_window"]) {
        if (family[name] == null) continue;
        const value = codexWindow.parse(family[name]);
        add(
          value.limit_window_seconds === 18000
            ? "5h"
            : value.limit_window_seconds === 604800
              ? "weekly"
              : "other",
          scope,
          value.used_percent,
          value.reset_at == null ? null : value.reset_at * 1000,
        );
      }
    }
  }
  if (!windows.length || windows.length > 16)
    throw new Error("Quota windows unavailable");
  return z.array(windowSchema).parse(windows);
}

const credentialsSchema = z.object({
  files: z
    .array(
      z.object({
        provider: z.string().optional(),
        type: z.string().optional(),
        auth_index: z
          .union([z.string().min(1).max(256), z.number().int().nonnegative()])
          .optional(),
        disabled: z.boolean().optional(),
        email: z.string().optional(),
        account_id: z.string().min(1).max(256).optional(),
        chatgpt_account_id: z.string().min(1).max(256).optional(),
      }),
    )
    .max(100),
});
const upstreams = {
  claude: "https://api.anthropic.com/api/oauth/usage",
  codex: "https://chatgpt.com/backend-api/wham/usage",
} as const;
const ttl = 60_000;

/** One opt-in reader per host binding. No URL/auth/reset controls reach callers. */
export class QuotaReader {
  private readonly config: z.infer<typeof quotaConfigSchema> | undefined;
  private cache?: QuotaSnapshot;
  constructor(
    config?: z.input<typeof quotaConfigSchema>,
    private readonly now = Date.now,
    private readonly monitoredProviders = providers,
  ) {
    this.config =
      config === undefined ? undefined : quotaConfigSchema.parse(config);
  }

  async read(caller: AbortSignal): Promise<QuotaSnapshot> {
    caller.throwIfAborted();
    const now = this.now();
    if (!this.config)
      return {
        status: "not-configured",
        observedAt: now,
        cached: false,
        accounts: [],
      };
    if (
      this.cache &&
      now >= this.cache.observedAt &&
      now - this.cache.observedAt < ttl
    )
      return structuredClone({ ...this.cache, cached: true });
    const signal = AbortSignal.any([caller, AbortSignal.timeout(8000)]);
    let snapshot: QuotaSnapshot = {
      status: "unavailable",
      observedAt: now,
      cached: false,
      accounts: [],
    };
    try {
      const key = await this.key();
      signal.throwIfAborted();
      const credentials = credentialsSchema.parse(
        await this.request("/v8/management/credentials", key, signal),
      );
      const selected = this.config.accounts;
      const active = credentials.files.filter((file) => {
        const provider = providerSchema.safeParse(file.provider ?? file.type);
        if (
          file.disabled ||
          !provider.success ||
          !this.monitoredProviders.includes(provider.data)
        )
          return false;
        const emails = selected?.[provider.data];
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
          ).length ?? (files.length ? 0 : 1);
        return { provider, count };
      });
      if (
        active.length + missing.reduce((sum, item) => sum + item.count, 0) >
        10
      )
        throw new Error("Too many quota accounts");
      const counts = { claude: 0, codex: 0 };
      // Sequential, bounded reads avoid bursting subscription status endpoints.
      for (const file of active) {
        const provider = providerSchema.parse(file.provider ?? file.type);
        const account: QuotaSnapshot["accounts"][number] = {
          provider,
          account: `${provider}-${++counts[provider]}`,
          status: "unavailable",
          observedAt: null,
          windows: [],
        };
        snapshot.accounts.push(account);
        try {
          if (file.auth_index === undefined) continue;
          const header: Record<string, string> = {
            Authorization: "Bearer $TOKEN$",
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent":
              provider === "claude"
                ? "claude-cli/2.1.280 (external, cli)"
                : "codex-tui/0.149.1",
          };
          if (provider === "claude")
            header["anthropic-beta"] = "oauth-2025-04-20";
          const accountID = file.chatgpt_account_id ?? file.account_id;
          if (provider === "codex" && accountID)
            header["Chatgpt-Account-Id"] = accountID;
          const result = z
            .object({ status_code: z.number().int(), body: z.unknown() })
            .parse(
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
          if (result.status_code !== 200) continue;
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
        for (let skipped = 0; skipped < count; skipped++)
          snapshot.accounts.push({
            provider,
            account: `${provider}-${++counts[provider]}`,
            status: "unavailable",
            observedAt: null,
            windows: [],
          });
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
      snapshot = quotaSnapshotSchema.parse(snapshot);
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
    if (!this.config) throw new Error("Quota not configured");
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
      )
        throw new Error("Private quota key required");
      const key = (await file.readFile("utf8")).trim();
      if (!key || /\s/.test(key)) throw new Error("Invalid quota key");
      return key;
    } finally {
      await file.close();
    }
  }

  private async request(
    path: string,
    key: string,
    signal: AbortSignal,
    body?: object,
  ): Promise<unknown> {
    if (!this.config) throw new Error("Quota not configured");
    const response = await fetch(new URL(path, this.config.baseURL), {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
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
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 1024 * 1024) throw new Error("Quota response too large");
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
  if (snapshot.status === "not-configured")
    lines.push("Quota reader not configured.");
  else if (!snapshot.accounts.length)
    lines.push(
      "Quota unavailable. Check proxy access and private management-key configuration.",
    );
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
