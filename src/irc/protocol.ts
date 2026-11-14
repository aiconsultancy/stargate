/**
 * IRC message framing (RFC 1459/2812) with IRCv3 message tags. Pure
 * functions only; the client owns the socket and the protocol state.
 */

export type IrcMessage = {
  /** Unescaped tag values; a tag without a value maps to "". */
  tags: ReadonlyMap<string, string>;
  source?: string;
  /** Upper-case command or three-digit numeric. */
  command: string;
  params: readonly string[];
};

/** Bytes of one line without CRLF, tags excluded (RFC 1459). */
export const lineBytes = 510;
/** Received lines are refused above this size: 8191 tag bytes + 512. */
export const maxReceivedBytes = 8703;

const tagKey = /^\+?(?:[A-Za-z0-9.-]+\/)?[A-Za-z0-9-]+$/;
const unsafe = (value: string) =>
  value.includes("\0") || value.includes("\r") || value.includes("\n");

function unescapeTag(value: string) {
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char !== "\\") {
      result += char;
      continue;
    }
    const next = value[++i];
    if (next === undefined) break;
    result +=
      next === ":"
        ? ";"
        : next === "s"
          ? " "
          : next === "r"
            ? "\r"
            : next === "n"
              ? "\n"
              : next;
  }
  return result;
}

function escapeTag(value: string) {
  return value.replace(
    /[\\; \r\n]/g,
    (char) =>
      ({ "\\": "\\\\", ";": "\\:", " ": "\\s", "\r": "\\r", "\n": "\\n" })[
        char
      ] ?? char,
  );
}

/** One received line without CRLF; undefined for malformed input. */
export function parseMessage(line: string): IrcMessage | undefined {
  let rest = line;
  const tags = new Map<string, string>();
  if (rest.startsWith("@")) {
    const space = rest.indexOf(" ");
    if (space < 0) return;
    for (const item of rest.slice(1, space).split(";")) {
      if (!item) continue;
      const equals = item.indexOf("=");
      const key = equals < 0 ? item : item.slice(0, equals);
      if (!tagKey.test(key)) continue;
      tags.set(key, equals < 0 ? "" : unescapeTag(item.slice(equals + 1)));
    }
    rest = rest.slice(space + 1).replace(/^ +/, "");
  }
  let source: string | undefined;
  if (rest.startsWith(":")) {
    const space = rest.indexOf(" ");
    if (space < 0) return;
    source = rest.slice(1, space);
    rest = rest.slice(space + 1).replace(/^ +/, "");
  }
  const space = rest.indexOf(" ");
  const command = (space < 0 ? rest : rest.slice(0, space)).toUpperCase();
  if (!/^(?:[A-Z]+|\d{3})$/.test(command)) return;
  rest = space < 0 ? "" : rest.slice(space + 1);
  const params: string[] = [];
  while (rest) {
    if (rest.startsWith(":")) {
      params.push(rest.slice(1));
      break;
    }
    const next = rest.indexOf(" ");
    if (next < 0) {
      params.push(rest);
      break;
    }
    if (next > 0) params.push(rest.slice(0, next));
    rest = rest.slice(next + 1);
  }
  return { tags, ...(source ? { source } : {}), command, params };
}

/**
 * Serialize one outgoing message. Throws on any parameter that would inject
 * another line or another parameter, never silently rewriting it.
 */
export function formatMessage(
  command: string,
  params: readonly string[],
  tags: ReadonlyMap<string, string> | Record<string, string> = {},
): string {
  if (!/^(?:[A-Z]+|\d{3})$/.test(command))
    throw new Error("Invalid IRC command");
  const entries = tags instanceof Map ? [...tags] : Object.entries(tags);
  const tagText = entries
    .map(([key, value]) => {
      if (!tagKey.test(key) || value.includes("\0"))
        throw new Error("Invalid IRC tag");
      return value === "" ? key : `${key}=${escapeTag(value)}`;
    })
    .join(";");
  const parts = params.map((param, index) => {
    if (unsafe(param)) throw new Error("Invalid IRC parameter");
    const last = index === params.length - 1;
    if (last && (param === "" || param.includes(" ") || param.startsWith(":")))
      return `:${param}`;
    if (param === "" || param.includes(" ") || param.startsWith(":"))
      throw new Error("Invalid IRC middle parameter");
    return param;
  });
  return `${tagText ? `@${tagText} ` : ""}${[command, ...parts].join(" ")}`;
}

/** Bytes of the `@tags ` prefix that `formatMessage` writes for these tags. */
export function tagBytes(tags: Record<string, string>) {
  return Object.keys(tags).length
    ? utf8Bytes(formatMessage("PING", [], tags)) - "PING".length
    : 0;
}

/** `nick!user@host` → nick; a server name stays whole. */
export function sourceNick(source: string | undefined) {
  if (!source) return "";
  const bang = source.indexOf("!");
  return bang < 0 ? source : source.slice(0, bang);
}

/** ISUPPORT CASEMAPPING families; `unicode` covers rfc8265/precis. */
export type Casemapping = "ascii" | "rfc1459" | "strict-rfc1459" | "unicode";

/** The server's CASEMAPPING token; absent means the RFC 1459 default. */
export function casemapping(token: string | undefined): Casemapping {
  switch (token?.toLowerCase() ?? "rfc1459") {
    case "ascii":
      return "ascii";
    case "rfc1459":
      return "rfc1459";
    case "strict-rfc1459":
    case "rfc1459-strict":
      return "strict-rfc1459";
    default:
      return "unicode";
  }
}

const rfc1459Pairs: Record<string, string> = {
  "[": "{",
  "]": "}",
  "\\": "|",
  "~": "^",
};

/**
 * IRC names (nicks, accounts, channels) compare without case under the
 * server's CASEMAPPING. Before ISUPPORT, and for configuration checks,
 * rfc1459 applies: the RFC default and the widest classic mapping, so two
 * names it treats as equal are never kept apart.
 * greybeard: `unicode` is lower case after NFKC, an approximation of
 * RFC 8265 case folding.
 */
export function fold(value: string, mapping: Casemapping = "rfc1459") {
  if (mapping === "unicode") return value.normalize("NFKC").toLowerCase();
  const lower = value.replace(/[A-Z]/g, (char) => char.toLowerCase());
  if (mapping === "ascii") return lower;
  return lower.replace(
    mapping === "rfc1459" ? /[[\]\\~]/g : /[[\]\\]/g,
    (char) => rfc1459Pairs[char] ?? char,
  );
}

/**
 * A key at least as coarse as `fold` under every CASEMAPPING: two names
 * that any mapping treats as equal get the same key. For isolation checks
 * (configuration), never for routing. It starts from the `unicode` fold
 * (NFKC, lower case), so names equal there stay equal; upper then lower
 * case again makes ẞ, ß, SS and ss converge (and ı with i, ſ with s); NFKC
 * once more; then rfc1459, the widest classic mapping, which also covers
 * `ascii` and `strict-rfc1459`.
 */
export function widestFold(value: string) {
  return fold(
    fold(value, "unicode").toUpperCase().toLowerCase().normalize("NFKC"),
    "rfc1459",
  );
}

/** `cap1 cap2=value` → capability map. */
export function parseCapabilities(text: string) {
  const caps = new Map<string, string>();
  for (const item of text.split(" ")) {
    if (!item) continue;
    const equals = item.indexOf("=");
    caps.set(
      equals < 0 ? item : item.slice(0, equals),
      equals < 0 ? "" : item.slice(equals + 1),
    );
  }
  return caps;
}

export function utf8Bytes(text: string) {
  return Buffer.byteLength(text, "utf8");
}

const colour = /\d{1,2}(?:,\d{1,2})?/y;
const hexColour = /[0-9a-fA-F]{6}(?:,[0-9a-fA-F]{6})?/y;

/**
 * Text without IRC colour/style codes or other control characters. A tab
 * becomes a space; line breaks are removed. Used for received text and for
 * every outgoing line, so model text cannot inject CTCP or formatting.
 */
export function cleanText(text: string) {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 3 || code === 4) {
      const pattern = code === 3 ? colour : hexColour;
      pattern.lastIndex = i + 1;
      const match = pattern.exec(text);
      if (match) i += match[0].length;
      continue;
    }
    if (code === 9) result += " ";
    else if (code >= 32 && code !== 127) result += text[i];
  }
  return result;
}
