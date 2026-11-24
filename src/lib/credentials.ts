/**
 * Text patterns that carry credentials: private keys, provider tokens,
 * authorization headers and `name=value` secrets. One list for redaction
 * (`redactCredentials`) and for withholding text (`containsCredential`).
 */
const credentialRules: readonly [RegExp, string][] = [
  [
    /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gi,
    "[REDACTED PRIVATE KEY]",
  ],
  [
    /\b(?:xox[a-z]-[a-z0-9-]+|xapp-[a-z0-9-]+|sk-[a-z0-9_-]+|AIza[a-z0-9_-]+|gh[pousr]_[a-z0-9_]+|github_pat_[a-z0-9_]+)\b/gi,
    "[REDACTED]",
  ],
  [/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi, "[REDACTED AUTHORIZATION]"],
  [
    /\b((?:[a-z0-9_]*(?:secret|token|password|passwd|api[_-]?key|credential)[a-z0-9_]*|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,
    "$1[REDACTED]",
  ],
];

/** True when any credential rule matches `text`. */
export function containsCredential(text: string) {
  return credentialRules.some(([pattern]) =>
    new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text),
  );
}

/**
 * `text` without credentials and control characters (newline, carriage
 * return and tab stay), cut to `limit`. Apply it before persistence,
 * truncation, inference and publication. At most 64,000 characters are read.
 */
export function redactCredentials(text: string, limit = 1500): string {
  let redacted = text.slice(0, 64_000);

  for (const [pattern, replacement] of credentialRules)
    redacted = redacted.replace(pattern, replacement);

  return redacted
    .replace(/\p{Cc}/gu, (character) =>
      ["\n", "\r", "\t"].includes(character) ? character : "",
    )
    .slice(0, limit);
}

export function secret(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[name];

  if (!value?.trim()) throw new Error(`Missing environment variable: ${name}`);

  return value;
}
