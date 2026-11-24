import { randomUUID, sign } from "node:crypto";
import type { AgentKey } from "./certificate";

/** Seconds a token lives. The API accepts at most 300; a fresh one is minted per request. */
export const agentTokenLifetimeSeconds = 120;

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * A short-lived agent token for one upstream request: a JWT signed with the
 * officer's key, `kid` and `sub` its certificate fingerprint, `aud` the API's
 * public origin and a unique `jti`, so it can never be replayed.
 */
export function mintAgentToken(
  key: AgentKey,
  audience: string,
  now = Date.now(),
): string {
  const issuedAt = Math.floor(now / 1000);

  const header = {
    alg: key.algorithm === "ed25519" ? "EdDSA" : "ES256",
    typ: "subspace-agent+jwt",
    kid: key.fingerprint,
  };

  const claims = {
    iss: "subspace-agent",
    sub: key.fingerprint,
    aud: audience,
    iat: issuedAt,
    exp: issuedAt + agentTokenLifetimeSeconds,
    jti: randomUUID(),
  };

  const input = `${encode(header)}.${encode(claims)}`;

  // JWS ES256 is the raw r || s pair, not the DER structure.
  const signature =
    key.algorithm === "ed25519"
      ? sign(null, Buffer.from(input), key.privateKey)
      : sign("sha256", Buffer.from(input), {
          key: key.privateKey,
          dsaEncoding: "ieee-p1363",
        });

  return `${input}.${signature.toString("base64url")}`;
}
