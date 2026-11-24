import {
  type KeyObject,
  X509Certificate,
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";

/** Key types the Subspace API accepts for an agent credential. */
export type AgentKeyAlgorithm = "ed25519" | "ecdsa-p256";

/** An officer's key and self-signed certificate, held only by the gateway. */
export type AgentKey = {
  algorithm: AgentKeyAlgorithm;
  privateKey: KeyObject;
  /** The certificate in PEM, as sent to the API at enrolment. */
  certificate: string;
  /** SHA-256 of the certificate's DER, lower-case hex, no separators. */
  fingerprint: string;
};

// DER, built by hand: the runtime can make keys and sign, but has no
// Certificate builder. Only the few types a certificate needs are here.
const tag = (type: number, content: Buffer) => {
  const length = content.length;

  if (length < 0x80)
    return Buffer.concat([Buffer.from([type, length]), content]);
  const bytes: number[] = [];

  for (let rest = length; rest > 0; rest = Math.floor(rest / 0x1_00))
    bytes.unshift(rest % 0x1_00);

  return Buffer.concat([
    Buffer.from([type, 0x80 + bytes.length, ...bytes]),
    content,
  ]);
};

const sequence = (...items: Buffer[]) => tag(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tag(0x31, Buffer.concat(items));
const explicit = (index: number, item: Buffer) => tag(0xa0 + index, item);
const octets = (content: Buffer) => tag(0x04, content);

const bits = (content: Buffer) =>
  tag(0x03, Buffer.concat([Buffer.of(0), content]));

/** A non-negative integer from big-endian bytes, with no redundant sign byte. */
function integer(value: Buffer) {
  let start = 0;

  while (start < value.length - 1 && value[start] === 0) start++;
  const trimmed = value.subarray(start);

  return tag(
    0x02,
    (trimmed[0] ?? 0) >= 0x80
      ? Buffer.concat([Buffer.of(0), trimmed])
      : trimmed,
  );
}

function oid(dotted: string) {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];

  for (const arc of rest) {
    const chunk = [arc % 0x80];
    let value = Math.floor(arc / 0x80);

    while (value > 0) {
      chunk.unshift((value % 0x80) + 0x80);
      value = Math.floor(value / 0x80);
    }

    bytes.push(...chunk);
  }

  return tag(0x06, Buffer.from(bytes));
}

/** UTCTime until 2049, GeneralizedTime from 2050 (RFC 5280, 4.1.2.5). */
function time(date: Date) {
  const text = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);

  return date.getUTCFullYear() < 2050
    ? tag(0x17, Buffer.from(`${text.slice(2)}Z`, "ascii"))
    : tag(0x18, Buffer.from(`${text}Z`, "ascii"));
}

const commonName = (name: string) =>
  sequence(set(sequence(oid("2.5.4.3"), tag(0x0c, Buffer.from(name, "utf8")))));

const signatureAlgorithms: Record<AgentKeyAlgorithm, Buffer> = {
  ed25519: sequence(oid("1.3.101.112")),
  "ecdsa-p256": sequence(oid("1.2.840.10045.4.3.2")),
};

/**
 * Not a CA; signs only; for TLS client authentication, so that the same
 * certificate can later sign the officer in to IRC.
 */
const extensions = explicit(
  3,
  sequence(
    sequence(oid("2.5.29.19"), tag(0x01, Buffer.of(0xff)), octets(sequence())),
    sequence(
      oid("2.5.29.15"),
      tag(0x01, Buffer.of(0xff)),
      octets(tag(0x03, Buffer.of(7, 0x80))),
    ),
    sequence(oid("2.5.29.37"), octets(sequence(oid("1.3.6.1.5.5.7.3.2")))),
  ),
);

/** Ten years: rotation, not expiry, replaces a credential. */
const validityMs = 3650 * 86_400_000;

/** Signature over `data` in the certificate's own encoding. */
function certificateSignature(
  algorithm: AgentKeyAlgorithm,
  data: Buffer,
  key: KeyObject,
) {
  return algorithm === "ed25519"
    ? sign(null, data, key)
    : sign("sha256", data, { key, dsaEncoding: "der" });
}

export function fingerprintOf(certificate: X509Certificate) {
  return createHash("sha256").update(certificate.raw).digest("hex");
}

const pem = (label: string, der: Buffer) =>
  `-----BEGIN ${label}-----\n${
    der
      .toString("base64")
      .match(/.{1,64}/g)
      ?.join("\n") ?? ""
  }\n-----END ${label}-----\n`;

/**
 * A new key and a self-signed X.509 v3 certificate whose subject is the
 * officer's name. Keys come from the runtime's own cryptography.
 */
export function generateAgentKey(
  name: string,
  algorithm: AgentKeyAlgorithm = "ed25519",
  now = new Date(),
): AgentKey {
  const { privateKey, publicKey } =
    algorithm === "ed25519"
      ? generateKeyPairSync("ed25519")
      : generateKeyPairSync("ec", { namedCurve: "prime256v1" });

  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const subject = commonName(name);
  // Back-dated a little, so a peer with a slower clock accepts it at once.
  const notBefore = new Date(now.getTime() - 300_000);

  const body = sequence(
    explicit(0, integer(Buffer.of(2))),
    integer(serial),
    signatureAlgorithms[algorithm],
    subject,
    sequence(time(notBefore), time(new Date(notBefore.getTime() + validityMs))),
    subject,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );

  const der = sequence(
    body,
    signatureAlgorithms[algorithm],
    bits(certificateSignature(algorithm, body, privateKey)),
  );

  const certificate = new X509Certificate(der);

  return {
    algorithm,
    privateKey,
    certificate: pem("CERTIFICATE", der),
    fingerprint: fingerprintOf(certificate),
  };
}

/** PEM blocks by label, without interpreting their content. */
function pemBlocks(text: string) {
  return [
    ...text.matchAll(
      /-----BEGIN ([A-Z0-9 ]+)-----\r?\n([A-Za-z0-9+/=\r\n]+?)-----END \1-----/g,
    ),
  ].map((match) => ({ label: match[1] ?? "", body: match[0] }));
}

/** One file: the PKCS #8 private key, then the certificate. */
export function bundleText(key: AgentKey) {
  const privateKey = key.privateKey.export({ type: "pkcs8", format: "pem" });

  return `${privateKey}${key.certificate}`;
}

export class BundleError extends Error {}

/**
 * The key and certificate from a bundle's text. Exactly one private key and
 * a first certificate that matches it; Ed25519 or ECDSA P-256 only. Errors
 * never quote the text.
 */
export function parseBundle(text: string): AgentKey {
  const blocks = pemBlocks(text);
  const keys = blocks.filter((block) => block.label.endsWith("PRIVATE KEY"));
  const leaf = blocks.find((block) => block.label === "CERTIFICATE");

  if (keys.length !== 1 || !leaf)
    throw new BundleError(
      "The bundle needs one private key and its certificate",
    );

  let privateKey: KeyObject;
  let certificate: X509Certificate;

  try {
    privateKey = createPrivateKey(keys[0]?.body ?? "");
    certificate = new X509Certificate(leaf.body);
  } catch {
    throw new BundleError("The bundle's key or certificate is unreadable");
  }

  const algorithm: AgentKeyAlgorithm | undefined =
    privateKey.asymmetricKeyType === "ed25519"
      ? "ed25519"
      : privateKey.asymmetricKeyType === "ec" &&
          privateKey.asymmetricKeyDetails?.namedCurve === "prime256v1"
        ? "ecdsa-p256"
        : undefined;

  if (!algorithm) throw new BundleError("Use an Ed25519 or ECDSA P-256 key");

  if (!certificate.checkPrivateKey(privateKey))
    throw new BundleError("The bundle's certificate does not match its key");

  return {
    algorithm,
    privateKey,
    // Canonical PEM of exactly the DER, as the API accepts it.
    certificate: pem("CERTIFICATE", certificate.raw),
    fingerprint: fingerprintOf(certificate),
  };
}
