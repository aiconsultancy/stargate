import { Schema } from "effect";
import { settingsPattern, settingsStruct } from "../../config/settings-schema";

/**
 * Discovery-driven quota pass for CLIProxyAPI plugin providers.
 *
 * Nothing about individual providers is enumerated here: the set of
 * quota-capable providers, their credentials and their windows all come
 * from the proxy's generic quota endpoints at read time, so adding or
 * removing a provider (OpenCode Go, Google Antigravity, or any later
 * plugin) is included automatically.
 */

const percent = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(100),
);

const timestamp = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(8_640_000_000_000_000),
);

// The installed Zod 4.6.7 ISO date-time with an optional offset.
const offsetDateTime = Schema.String.check(
  settingsPattern(
    /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:[1-9]|[12]\d|30)|(?:02)-(?:[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$/,
  ),
);

export const pluginWindowSchema = settingsStruct({
  window: Schema.Literals(["rolling", "weekly", "monthly"]),
  remainingPercent: percent,
  resetAt: Schema.NullOr(timestamp),
});

export const pluginAccountSchema = settingsStruct({
  provider: Schema.String.check(settingsPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/)),
  label: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(128),
  ),
  status: Schema.Literals(["ok", "unavailable"]),
  observedAt: timestamp,
  plan: Schema.NullOr(
    Schema.String.check(Schema.isMinCodePoints(1), Schema.isMaxCodePoints(64)),
  ),
  windows: Schema.mutable(Schema.Array(pluginWindowSchema)).check(
    Schema.isMaxLength(16),
  ),
});

export type PluginQuotaAccount = typeof pluginAccountSchema.Type;

export type PluginQuotaWindow = typeof pluginWindowSchema.Type;

const authIndex = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(256),
);

const decodeDiscovery = Schema.decodeUnknownSync(
  Schema.Struct({
    providers: Schema.Array(
      Schema.Struct({
        provider: Schema.String.check(
          Schema.isMinCodePoints(1),
          Schema.isMaxCodePoints(64),
        ),
        display_name: Schema.String.check(
          Schema.isMinCodePoints(1),
          Schema.isMaxCodePoints(128),
        ),
      }),
    ).check(Schema.isMaxLength(20)),
  }),
);

const fraction = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1),
);

const bucketSchema = Schema.Struct({
  window: Schema.Literals(["rolling", "weekly", "monthly"]),
  remainingFraction: fraction,
  resetTime: Schema.optional(Schema.NullOr(offsetDateTime)),
});

const groupSchema = Schema.Struct({
  buckets: Schema.Array(bucketSchema).check(Schema.isMaxLength(16)),
});

const decodeFetch = Schema.decodeUnknownSync(
  Schema.Struct({
    subscription: Schema.optional(
      Schema.Struct({
        plan: Schema.String.check(
          Schema.isMinCodePoints(1),
          Schema.isMaxCodePoints(64),
        ),
      }),
    ),
    groups: Schema.optional(
      Schema.Array(groupSchema).check(Schema.isMaxLength(8)),
    ),
  }),
);

/** POST body for the quota fetch endpoint. */
export type QuotaFetchBody = { auth_index: string };

/** One bounded management request against the proxy origin. */
export type QuotaRequest = (
  path: string,
  signal: AbortSignal,
  body?: QuotaFetchBody,
) => Promise<unknown>;

/** The credential fields the dynamic pass reads; nothing else is used. */
export type QuotaCredential = {
  provider?: string | undefined;
  type?: string | undefined;
  auth_index?: string | number | undefined;
  disabled?: boolean | undefined;
};

const decodeAuthIndex = Schema.decodeUnknownSync(authIndex);

function remainingOf(fraction: number): number {
  return Math.max(0, Math.min(100, Math.round((1 - fraction) * 100)));
}

function resetSeconds(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  return Math.floor(Date.parse(value) / 1000);
}

/** Normalize one credential's quota fetch into a plugin account. */
function accountOfFetched(
  account: PluginQuotaAccount,
  raw: unknown,
): PluginQuotaAccount {
  const fetched = decodeFetch(raw);
  const buckets = (fetched.groups ?? []).flatMap((group) => group.buckets);

  return {
    ...account,
    plan: fetched.subscription?.plan ?? null,
    windows: buckets.map((bucket) => ({
      window: bucket.window,
      remainingPercent: remainingOf(bucket.remainingFraction),
      resetAt: resetSeconds(bucket.resetTime ?? null),
    })),
    status: buckets.length > 0 ? "ok" : "unavailable",
  };
}

/** Label a provider's Nth credential consistently for policy routing. */
function labelOf(base: string, seen: number): string {
  return seen === 1 ? base : `${base} ${seen}`;
}

/**
 * Read every discovered plugin provider's quota. A provider or credential
 * that fails its read stays in the result as an unavailable account; the
 * pass itself only throws on abort or a failed discovery request, and a
 * failed pass never degrades the claude/codex account snapshot.
 */
export async function readPluginQuota(
  request: QuotaRequest,
  credentials: readonly QuotaCredential[],
  signal: AbortSignal,
  now: () => number,
): Promise<PluginQuotaAccount[]> {
  const discovery = decodeDiscovery(
    await request("/v0/management/quota/providers", signal),
  ).providers;

  const supported = new Map(
    discovery.map((entry) => [entry.provider, entry.display_name]),
  );

  const accounts: PluginQuotaAccount[] = [];
  const labelled = new Map<string, number>();

  for (const file of credentials) {
    if (accounts.length >= 20) {
      break;
    }

    if (file.disabled || file.auth_index === undefined) {
      continue;
    }

    const provider = file.provider ?? file.type;

    const base = provider === undefined ? undefined : supported.get(provider);

    if (provider === undefined || base === undefined) {
      continue;
    }

    const seen = (labelled.get(provider) ?? 0) + 1;
    labelled.set(provider, seen);

    const account: PluginQuotaAccount = {
      provider,
      label: labelOf(base, seen),
      status: "unavailable",
      observedAt: now(),
      plan: null,
      windows: [],
    };

    const body: QuotaFetchBody = {
      auth_index: decodeAuthIndex(String(file.auth_index)),
    };

    try {
      const raw = await request("/v0/management/quota/fetch", signal, body);
      accounts.push(accountOfFetched(account, raw));
    } catch {
      // A single unreadable credential is reported unavailable, not fatal.
      signal.throwIfAborted();
      accounts.push(account);
    }
  }

  return accounts;
}
