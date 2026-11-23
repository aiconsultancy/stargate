// Adapted from CFP Starfleet Teams 0.4.0; transport logic is independent of Claude Code.
// Validates requests that the Bot Connector service sends to the bot, as set out in
// "Authenticate requests from the Bot Connector service to your bot":
// https://learn.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-connector-authentication

import type { JWTHeaderParameters, JWTPayload } from "jose";
import { importJWK, errors as joseErrors, jwtVerify } from "jose";

export const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";

export const BOT_FRAMEWORK_OPENID_URL =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";

// Microsoft's documented clock skew allowance.
export const CLOCK_TOLERANCE_SECONDS = 300;

// Microsoft asks bots to refresh the signing keys at least once every 24 hours.
export const KEY_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

// Key fetches, for an unknown key ID or after a failure, are spaced at least this far apart.
export const MIN_UNKNOWN_KEY_REFRESH_MS = 30 * 1000;

// A key ID still unknown after a refresh is not looked up again for this long.
export const MISSING_KEY_TTL_MS = 60 * 60 * 1000;
const MISSING_KEY_LIMIT = 1000;
const FETCH_TIMEOUT_MS = 10_000;

type FetchFn = typeof fetch;

export type SigningKey = {
  kid: string;
  n: string;
  e: string;
  endorsements: string[];
};

// Status is the HTTP status the bot returns for the rejected request.
export class AuthError extends Error {
  public status: number;
  public constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

// Not an AuthError: the endpoint answers 503 so the Bot Connector service retries
// Once a refresh is allowed again.
export class KeyRefreshDeferredError extends Error {}

async function getJson(
  fetchFn: FetchFn,
  url: string,
): Promise<Record<string, unknown>> {
  const res = await fetchFn(url, {
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`GET ${url} returned HTTP ${res.status}`);
  const body = (await res.json()) as unknown;

  if (!body || typeof body !== "object")
    throw new Error(`GET ${url} did not return a JSON object`);

  return body as Record<string, unknown>;
}

export function isBotFrameworkHttpsUrl(raw: string): boolean {
  try {
    const url = new URL(raw);

    return (
      url.protocol === "https:" &&
      (url.hostname === "botframework.com" ||
        url.hostname.endsWith(".botframework.com"))
    );
  } catch {
    return false;
  }
}

// Caches the Bot Connector signing keys, including each key's channel endorsements,
// Which a generic JWKS client would discard.
export class BotFrameworkKeyStore {
  readonly #fetch: FetchFn;
  readonly #openIdUrl: string;
  readonly #now: () => number;
  #keys = new Map<string, SigningKey>();
  #algorithms: string[] = ["RS256"];
  #fetchedAt = Number.NEGATIVE_INFINITY;
  #attemptedAt = Number.NEGATIVE_INFINITY;
  readonly #missing = new Map<string, number>();
  #inflight: Promise<void> | undefined;

  public constructor(
    options: { fetch?: FetchFn; openIdUrl?: string; now?: () => number } = {},
  ) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#openIdUrl = options.openIdUrl ?? BOT_FRAMEWORK_OPENID_URL;
    this.#now = options.now ?? Date.now;
  }

  public get algorithms(): string[] {
    return this.#algorithms;
  }

  // Random key IDs in forged tokens must not be able to starve a real key rotation:
  // Each unknown key ID is looked up at most once an hour, and lookups are spaced at
  // Least 30 seconds apart. A new key that arrives inside that gap gets a retryable
  // Error rather than a rejection.
  public async getKey(kid: string): Promise<SigningKey | undefined> {
    let refreshed = false;

    if (
      this.#now() - this.#fetchedAt > KEY_REFRESH_INTERVAL_MS &&
      this.#mayAttempt()
    )
      refreshed = await this.#refreshKeepingCache();
    const known = this.#keys.get(kid);

    if (known) return known;
    const missingSince = this.#missing.get(kid);

    if (
      missingSince !== undefined &&
      this.#now() - missingSince < MISSING_KEY_TTL_MS
    )
      return undefined;

    if (!refreshed) {
      if (!this.#mayAttempt())
        throw new KeyRefreshDeferredError(
          "the signing keys were fetched moments ago; retry shortly",
        );
      refreshed = await this.#refreshKeepingCache();

      if (!refreshed)
        throw new KeyRefreshDeferredError(
          "the signing keys could not be refreshed; retry shortly",
        );
    }

    // The key set is fresh and still lacks this key ID: the token is not Bot Framework's.
    const key = this.#keys.get(kid);

    if (!key) this.#rememberMissing(kid);

    return key;
  }

  public refresh(): Promise<void> {
    this.#inflight ??= this.#load().finally(() => {
      this.#inflight = undefined;
    });

    return this.#inflight;
  }

  #mayAttempt(): boolean {
    return this.#now() - this.#attemptedAt >= MIN_UNKNOWN_KEY_REFRESH_MS;
  }

  #rememberMissing(kid: string): void {
    this.#missing.delete(kid);
    this.#missing.set(kid, this.#now());

    while (this.#missing.size > MISSING_KEY_LIMIT) {
      const oldest = this.#missing.keys().next().value;

      if (oldest === undefined) break;
      this.#missing.delete(oldest);
    }
  }

  // Returns false when the refresh failed but older keys are still held.
  async #refreshKeepingCache(): Promise<boolean> {
    try {
      await this.refresh();

      return true;
    } catch (err) {
      // Keep serving with the keys already held; fail only when there are none.
      if (this.#keys.size === 0) throw err;

      return false;
    }
  }

  async #load(): Promise<void> {
    this.#attemptedAt = this.#now();
    const metadata = await getJson(this.#fetch, this.#openIdUrl);

    if (metadata["issuer"] !== BOT_FRAMEWORK_ISSUER) {
      throw new Error(
        `OpenID metadata names issuer ${String(metadata["issuer"])}, not ${BOT_FRAMEWORK_ISSUER}`,
      );
    }

    const jwksUri =
      typeof metadata["jwks_uri"] === "string" ? metadata["jwks_uri"] : "";

    if (!isBotFrameworkHttpsUrl(jwksUri)) {
      throw new Error(
        `OpenID metadata jwks_uri is not an https botframework.com URL: ${jwksUri}`,
      );
    }

    const offered = Array.isArray(
      metadata["id_token_signing_alg_values_supported"],
    )
      ? metadata["id_token_signing_alg_values_supported"]
      : [];

    const algorithms = offered.filter((alg): alg is "RS256" => alg === "RS256");

    if (!algorithms.length)
      throw new Error("OpenID metadata does not offer RS256 signing");

    const jwks = await getJson(this.#fetch, jwksUri);
    const keys = new Map<string, SigningKey>();

    for (const entry of Array.isArray(jwks["keys"]) ? jwks["keys"] : []) {
      const key = entry as Record<string, unknown>;

      if (
        key?.["kty"] !== "RSA" ||
        typeof key["kid"] !== "string" ||
        typeof key["n"] !== "string" ||
        typeof key["e"] !== "string"
      )
        continue;

      if (key["use"] !== undefined && key["use"] !== "sig") continue;

      const endorsements = Array.isArray(key["endorsements"])
        ? key["endorsements"].map(String)
        : [];

      keys.set(key["kid"], {
        kid: key["kid"],
        n: key["n"],
        e: key["e"],
        endorsements,
      });
    }

    if (!keys.size)
      throw new Error(
        "the Bot Framework key document holds no RSA signing keys",
      );
    this.#keys = keys;
    this.#algorithms = algorithms;
    this.#fetchedAt = this.#now();

    for (const kid of keys.keys()) this.#missing.delete(kid);
  }
}

export type AuthOptions = {
  keyStore: BotFrameworkKeyStore;
  appId: string;
  now?: () => number;
};

export type VerifiedToken = {
  claims: JWTPayload;
  endorsements: string[];
};

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/i;

// The key lookup jose calls once the header has passed its algorithm check. It
// Checks the algorithm again itself, so neither guard depends on the other.
export function signingKeyResolver(
  keyStore: BotFrameworkKeyStore,
  onKey: (key: SigningKey) => void = () => {},
) {
  return async (header: JWTHeaderParameters) => {
    if (header.alg !== "RS256")
      throw new AuthError(
        `token algorithm ${String(header.alg)} is not allowed`,
      );

    if (typeof header.kid !== "string" || !header.kid)
      throw new AuthError("token has no key ID");
    const key = await keyStore.getKey(header.kid);

    if (!key) throw new AuthError("token is signed with an unknown key");
    onKey(key);

    return importJWK({ kty: "RSA", n: key["n"], e: key["e"] }, "RS256");
  };
}

// Step 1, before the request body is read: the Authorization header must carry a
// Bot Framework token with a valid RS256 signature from the published keys, the
// Bot Framework issuer, this bot's app ID as audience and an unexpired validity
// Period. Throws AuthError when the request must be rejected. Any other error means
// The keys could not be fetched yet, and the caller should answer 503.
export async function verifyBotFrameworkToken(
  authorization: string | undefined,
  options: AuthOptions,
): Promise<VerifiedToken> {
  const match = BEARER.exec((authorization ?? "").trim());

  if (!match) throw new AuthError("missing or malformed Bearer token");

  let signingKey: SigningKey | undefined;
  let claims: JWTPayload;

  try {
    const verified = await jwtVerify(
      match[1] ?? "",
      signingKeyResolver(options.keyStore, (key) => {
        signingKey = key;
      }),
      {
        issuer: BOT_FRAMEWORK_ISSUER,
        audience: options.appId,
        algorithms: options.keyStore.algorithms,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ["exp"],
        ...(options.now ? { currentDate: new Date(options.now()) } : {}),
      },
    );

    claims = verified.payload;
  } catch (err) {
    if (err instanceof AuthError) throw err;

    if (err instanceof joseErrors.JOSEError)
      throw new AuthError(`token rejected: ${err.message}`);
    throw err;
  }

  return { claims, endorsements: signingKey?.endorsements ?? [] };
}

// Step 2, once the body is parsed: the token's serviceUrl claim must equal the
// Activity's serviceUrl (401), and the signing key must be endorsed for the
// Activity's channel ID (403).
export function checkActivityBinding(
  token: VerifiedToken,
  activity: { serviceUrl?: unknown; channelId?: unknown },
): void {
  const serviceUrl =
    typeof activity.serviceUrl === "string" ? activity.serviceUrl : "";

  const claimedServiceUrl =
    token.claims["serviceurl"] ?? token.claims["serviceUrl"];

  if (!serviceUrl || claimedServiceUrl !== serviceUrl) {
    throw new AuthError(
      "the token serviceUrl claim does not match the activity serviceUrl",
    );
  }

  const channelId =
    typeof activity.channelId === "string" ? activity.channelId : "";

  if (!channelId || !token.endorsements.includes(channelId)) {
    throw new AuthError(
      `the signing key is not endorsed for channel "${channelId}"`,
      403,
    );
  }
}

// Both steps, for callers that already hold the parsed activity.
export async function authenticateActivityRequest(
  authorization: string | undefined,
  activity: { serviceUrl?: unknown; channelId?: unknown },
  options: AuthOptions,
): Promise<VerifiedToken> {
  const token = await verifyBotFrameworkToken(authorization, options);
  checkActivityBinding(token, activity);

  return token;
}
