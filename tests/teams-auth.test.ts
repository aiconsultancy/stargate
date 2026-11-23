import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  AuthError,
  authenticateActivityRequest,
  BOT_FRAMEWORK_ISSUER,
  BOT_FRAMEWORK_OPENID_URL,
  BotFrameworkKeyStore,
  KeyRefreshDeferredError,
  MIN_UNKNOWN_KEY_REFRESH_MS,
  signingKeyResolver,
  verifyBotFrameworkToken,
} from "../src/transports/teams/botframework-auth";
import {
  APP_ID,
  botFrameworkKeys,
  json,
  makeSigningKey,
  mockFetch,
  SERVICE_URL,
  signToken,
  unsignedToken,
} from "./teams-support";

const activity = { serviceUrl: SERVICE_URL, channelId: "msteams" };

async function setup() {
  const key = await makeSigningKey("key-1");
  const outsider = await makeSigningKey("key-1");
  const unendorsed = await makeSigningKey("key-2", ["webchat"]);
  const http = mockFetch(botFrameworkKeys([key.jwk, unendorsed.jwk]));
  const keyStore = new BotFrameworkKeyStore({ fetch: http.fetch });

  const check = (token: string, target: Record<string, unknown> = activity) =>
    authenticateActivityRequest(`Bearer ${token}`, target, {
      keyStore,
      appId: APP_ID,
    });

  return { key, outsider, unendorsed, http, keyStore, check };
}

async function rejects(
  promise: Promise<unknown>,
  status: number,
  pattern: RegExp,
) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(
      err instanceof AuthError,
      `expected AuthError, got ${String(err)}`,
    );
    assert.equal(err.status, status);
    assert.match(err.message, pattern);

    return true;
  });
}

// Re-signs nothing: swaps the header of a valid RS256 token, as an attacker would.
function withHeader(token: string, header: Record<string, unknown>): string {
  const [, payload, signature] = token.split(".");

  return `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${payload}.${signature}`;
}

describe("Bot Framework token validation", () => {
  test("accepts a token signed by an endorsed Bot Framework key", async () => {
    const { key, check } = await setup();
    const result = await check(await signToken(key));
    assert.equal(result.claims.aud, APP_ID);
    assert.ok(result.endorsements.includes("msteams"));
  });

  test("rejects the wrong issuer", async () => {
    const { key, check } = await setup();
    await rejects(
      check(await signToken(key, { iss: "https://sts.windows.net/attacker/" })),
      401,
      /iss/,
    );
  });

  test("rejects an Entra token such as one IMDS issues, because of its issuer", async () => {
    const { key, check } = await setup();

    const entra = await signToken(key, {
      iss: "https://sts.windows.net/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/",
      aud: APP_ID,
    });

    await rejects(check(entra), 401, /iss/);
  });

  test("rejects the wrong audience", async () => {
    const { key, check } = await setup();
    await rejects(
      check(
        await signToken(key, { aud: "00000000-0000-0000-0000-000000000000" }),
      ),
      401,
      /aud/,
    );
  });

  test("rejects a token that expired beyond the five-minute clock skew", async () => {
    const { key, check } = await setup();
    const now = Math.floor(Date.now() / 1000);
    await rejects(
      check(await signToken(key, { nbf: now - 3600, exp: now - 360 })),
      401,
      /exp/,
    );
  });

  test("allows expiry within the five-minute clock skew", async () => {
    const { key, check } = await setup();
    const now = Math.floor(Date.now() / 1000);
    await check(await signToken(key, { nbf: now - 3600, exp: now - 120 }));
  });

  test("rejects a token without an expiry", async () => {
    const { key, check } = await setup();
    await rejects(check(await signToken(key, { exp: undefined })), 401, /exp/);
  });

  test("rejects an unsigned token", async () => {
    const { check } = await setup();
    await rejects(check(unsignedToken()), 401, /not allowed|alg/i);
  });

  test("rejects a token with a forged signature for a known key ID", async () => {
    const { outsider, check } = await setup();
    await rejects(check(await signToken(outsider)), 401, /signature/);
  });

  test("jose's algorithm allow-list rejects a non-RS256 header before any key lookup", async () => {
    const { key, http, check } = await setup();

    const token = withHeader(await signToken(key), {
      alg: "PS256",
      kid: "key-1",
    });

    await rejects(
      check(token),
      401,
      /token rejected: .*Header Parameter value not allowed/,
    );
    assert.equal(http.calls.length, 0, "no key was fetched");
  });

  test("the key resolver rejects a non-RS256 algorithm on its own", async () => {
    const { keyStore } = await setup();
    const resolve = signingKeyResolver(keyStore);

    for (const alg of ["HS256", "PS256", "none"]) {
      await rejects(
        resolve({ alg, kid: "key-1" }),
        401,
        new RegExp(`token algorithm ${alg} is not allowed`),
      );
    }

    await rejects(resolve({ alg: "RS256" }), 401, /no key ID/);
  });

  test("rejects an unknown key ID after one refresh, and does not look it up again", async () => {
    let now = 1_000_000;
    const key = await makeSigningKey("key-1");
    const http = mockFetch(botFrameworkKeys([key.jwk]));

    const keyStore = new BotFrameworkKeyStore({
      fetch: http.fetch,
      now: () => now,
    });

    const keyFetches = () =>
      http.calls.filter((call) => call.url.endsWith("/keys")).length;

    const verify = async (kid: string) =>
      verifyBotFrameworkToken(`Bearer ${await signToken(key, {}, { kid })}`, {
        keyStore,
        appId: APP_ID,
      });

    await rejects(verify("not-published"), 401, /unknown key/);
    assert.equal(keyFetches(), 1, "the first lookup fetched the key set");
    now += MIN_UNKNOWN_KEY_REFRESH_MS;
    await rejects(verify("not-published"), 401, /unknown key/);
    assert.equal(
      keyFetches(),
      1,
      "a key ID already looked up is not fetched again",
    );
  });

  test("random key IDs cannot starve a real key rotation", async () => {
    let now = 1_000_000;
    const key = await makeSigningKey("key-1");
    const rotated = await makeSigningKey("key-new");
    const published = [key.jwk];

    const http = mockFetch((url) =>
      botFrameworkKeys(published)(url, { url: url.href }),
    );

    const keyStore = new BotFrameworkKeyStore({
      fetch: http.fetch,
      now: () => now,
    });

    const verify = async (signer: typeof key, kid: string) =>
      verifyBotFrameworkToken(
        `Bearer ${await signToken(signer, {}, { kid })}`,
        { keyStore, appId: APP_ID },
      );

    await verify(key, "key-1");

    // An attacker sprays fresh key IDs straight after the fetch: each is deferred, not cached.
    for (const kid of ["r1", "r2", "r3"]) {
      await assert.rejects(verify(key, kid), KeyRefreshDeferredError);
    }

    published.push(rotated.jwk);
    // Microsoft rotates; the first token with the new key is deferred (a 503), then accepted.
    await assert.rejects(verify(rotated, "key-new"), KeyRefreshDeferredError);
    now += MIN_UNKNOWN_KEY_REFRESH_MS;
    const accepted = await verify(rotated, "key-new");
    assert.ok(accepted.endorsements.includes("msteams"));
  });

  test("refreshes the key set after twelve hours", async () => {
    let now = 1_000_000;
    const key = await makeSigningKey("key-1");
    const http = mockFetch(botFrameworkKeys([key.jwk]));

    const keyStore = new BotFrameworkKeyStore({
      fetch: http.fetch,
      now: () => now,
    });

    const keyFetches = () =>
      http.calls.filter((call) => call.url.endsWith("/keys")).length;

    await verifyBotFrameworkToken(`Bearer ${await signToken(key)}`, {
      keyStore,
      appId: APP_ID,
    });
    now += 12 * 60 * 60 * 1000 + 1;
    await verifyBotFrameworkToken(`Bearer ${await signToken(key)}`, {
      keyStore,
      appId: APP_ID,
    });
    assert.equal(keyFetches(), 2);
  });

  test("rejects a serviceUrl claim that does not match the activity", async () => {
    const { key, check } = await setup();
    await rejects(
      check(
        await signToken(key, {
          serviceurl: "https://smba.trafficmanager.net/amer/",
        }),
      ),
      401,
      /serviceUrl/,
    );
    await rejects(
      check(await signToken(key, { serviceurl: undefined })),
      401,
      /serviceUrl/,
    );
  });

  test("answers 403 when the signing key is not endorsed for msteams", async () => {
    const { unendorsed, check } = await setup();
    await rejects(check(await signToken(unendorsed)), 403, /endorsed/);
  });

  test("answers 403 when the activity names another channel than the key endorses", async () => {
    const { key, check } = await setup();
    await rejects(
      check(await signToken(key), {
        serviceUrl: SERVICE_URL,
        channelId: "webchat",
      }),
      403,
      /endorsed/,
    );
  });

  test("rejects a missing or non-Bearer Authorization header", async () => {
    const { keyStore } = await setup();
    await rejects(
      authenticateActivityRequest(undefined, activity, {
        keyStore,
        appId: APP_ID,
      }),
      401,
      /Bearer/,
    );
    await rejects(
      authenticateActivityRequest("Basic abc", activity, {
        keyStore,
        appId: APP_ID,
      }),
      401,
      /Bearer/,
    );
  });

  test("ignores keys that are not for signatures", async () => {
    const encryption = await makeSigningKey("enc-key");

    const http = mockFetch(
      botFrameworkKeys([
        { ...encryption.jwk, use: "enc" },
        (await makeSigningKey("key-1")).jwk,
      ]),
    );

    const keyStore = new BotFrameworkKeyStore({ fetch: http.fetch });
    await rejects(
      verifyBotFrameworkToken(`Bearer ${await signToken(encryption)}`, {
        keyStore,
        appId: APP_ID,
      }),
      401,
      /unknown key/,
    );
  });

  test("fetches the metadata and keys without following redirects", async () => {
    const { key, http, check } = await setup();
    await check(await signToken(key));
    assert.ok(http.calls.length >= 2);
    assert.ok(http.calls.every((call) => call.redirect === "error"));
  });
});

describe("Bot Framework OpenID metadata", () => {
  async function refuses(metadata: Record<string, unknown>, pattern: RegExp) {
    const key = await makeSigningKey("key-1");

    const http = mockFetch((url) => {
      if (url.href === BOT_FRAMEWORK_OPENID_URL) return json(metadata);

      return json({ keys: [key.jwk] });
    });

    const keyStore = new BotFrameworkKeyStore({ fetch: http.fetch });
    await assert.rejects(
      verifyBotFrameworkToken(`Bearer ${await signToken(key)}`, {
        keyStore,
        appId: APP_ID,
      }),
      (err: unknown) =>
        !(err instanceof AuthError) && pattern.test(String(err)),
    );
  }

  const good = {
    issuer: BOT_FRAMEWORK_ISSUER,
    jwks_uri: "https://login.botframework.com/v1/.well-known/keys",
    id_token_signing_alg_values_supported: ["RS256"],
  };

  test("refuses metadata that names another issuer", async () => {
    await refuses(
      { ...good, issuer: "https://login.example.com" },
      /names issuer/,
    );
  });

  test("refuses a key set on another host", async () => {
    await refuses(
      { ...good, jwks_uri: "https://keys.example.com/jwks" },
      /jwks_uri/,
    );
  });

  test("refuses a key set on a host that only ends in botframework.com", async () => {
    await refuses(
      { ...good, jwks_uri: "https://evilbotframework.com/keys" },
      /jwks_uri/,
    );
  });

  test("refuses a key set over plain http", async () => {
    await refuses(
      {
        ...good,
        jwks_uri: "http://login.botframework.com/v1/.well-known/keys",
      },
      /jwks_uri/,
    );
  });

  test("refuses metadata that does not offer RS256", async () => {
    await refuses(
      { ...good, id_token_signing_alg_values_supported: ["HS256"] },
      /RS256/,
    );
  });
});
