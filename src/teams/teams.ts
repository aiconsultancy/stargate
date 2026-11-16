// Adapted from CFP Starfleet Teams 0.4.0; transport logic is independent of Claude Code.
// The parts of a Bot Framework activity that the channel reads.
export type ChannelAccount = {
  id?: string;
  name?: string;
  aadObjectId?: string;
  role?: string;
};

export type Activity = {
  type?: string;
  id?: string;
  timestamp?: string;
  replyToId?: string;
  serviceUrl?: string;
  channelId?: string;
  from?: ChannelAccount;
  recipient?: ChannelAccount;
  conversation?: {
    id?: string;
    conversationType?: string;
    tenantId?: string;
    name?: string;
  };
  channelData?: {
    tenant?: { id?: string };
    channel?: { id?: string };
    team?: { id?: string };
  };
  text?: string;
  entities?: Array<{
    type?: string;
    text?: string;
    mentioned?: ChannelAccount;
  }>;
  attachments?: Array<{ contentType?: string }>;
};

export function activityTenantIds(activity: Activity): string[] {
  return [activity.channelData?.tenant?.id, activity.conversation?.tenantId]
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .map((id) => id.toLowerCase());
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// Removes the bot's own @mention, keeps the names of other people mentioned and
// decodes the few HTML entities Teams puts in message text. Everything else is
// kept as sent, including indentation and runs of spaces in pasted code: only the
// spaces next to the removed mention and around the whole message are trimmed.
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractText(activity: Activity): string {
  let text = typeof activity.text === "string" ? activity.text : "";
  const botId = activity.recipient?.id;
  for (const entity of activity.entities ?? []) {
    if (
      entity?.type === "mention" &&
      typeof entity.text === "string" &&
      entity.text &&
      entity.mentioned?.id === botId
    ) {
      text = text.replace(
        new RegExp(`[ \\t]*${escapeRegExp(entity.text)}[ \\t]*`, "g"),
        " ",
      );
    }
  }
  text = text.replace(/<at>(.*?)<\/at>/gi, "$1");
  return decodeEntities(text)
    .replace(/\u00a0/g, " ")
    .trim();
}

// Teams adds a text/html copy of the message body as an attachment; it is not a file.
export function countAttachments(activity: Activity): number {
  return (activity.attachments ?? []).filter(
    (item) => item?.contentType !== "text/html",
  ).length;
}

// Microsoft's documented limit for a bot message ("Format agent messages",
// section "Message size limits", checked on 2026-11-06:
// https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/format-your-bot-messages#message-size-limits):
// about 100 KB, counted as UTF-16 and including mentions and reactions. Microsoft
// says to keep a message within 80 KB to be sure it is delivered; a larger one is
// refused with HTTP 413 and the error code MessageSizeTooBig.
export const TEAMS_SAFE_MESSAGE_BYTES = 80_000;
// What the bridge lets itself send in one message: half of that, as measured by
// teamsMessageBytes. The headroom covers the activity around the text, what Teams
// adds itself, and any difference between how Teams counts and how the bridge does.
export const TEAMS_MESSAGE_BYTE_BUDGET = TEAMS_SAFE_MESSAGE_BYTES / 2;
// The much smaller size a message is cut down to when Teams refuses one as too
// large anyway, for the single retry.
export const TEAMS_RETRY_MESSAGE_BYTES = 8_000;

// The size of text as Teams receives it: JSON-escaped, quotes included, as the
// bridge sends it in the activity, and counted in whichever of UTF-8 and UTF-16
// is larger. Microsoft documents the limit in UTF-16; UTF-8 is what goes over the
// wire, and is the larger for most non-Latin scripts.
export function teamsMessageBytes(text: string): number {
  const json = JSON.stringify(text);
  return Math.max(Buffer.byteLength(json, "utf8"), json.length * 2);
}

// What one code point adds to teamsMessageBytes, in UTF-8 and in UTF-16 bytes,
// following JSON.stringify: quotes, backslashes and control characters are
// escaped, as are lone surrogates (six ASCII characters each).
function jsonCost(point: number): [number, number] {
  if (point === 0x22 || point === 0x5c) return [2, 4];
  if (point < 0x20)
    return [0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(point) ? [2, 4] : [6, 12];
  if (point >= 0xd800 && point <= 0xdfff) return [6, 12];
  if (point < 0x80) return [1, 2];
  if (point < 0x800) return [2, 2];
  if (point < 0x10000) return [3, 2];
  return [4, 4];
}

// The longest prefix of text, ending on a code point boundary, that is at most
// limit UTF-16 code units long and whose teamsMessageBytes is at most maxBytes.
function fittingEnd(text: string, limit: number, maxBytes: number): number {
  let utf8 = 2;
  let utf16 = 4;
  let end = 0;
  while (end < text.length) {
    const point = text.codePointAt(end) ?? 0;
    const width = point > 0xffff ? 2 : 1;
    const [bytes8, bytes16] = jsonCost(point);
    if (
      end + width > limit ||
      Math.max(utf8 + bytes8, utf16 + bytes16) > maxBytes
    )
      break;
    utf8 += bytes8;
    utf16 += bytes16;
    end += width;
  }
  return end;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// The grapheme boundaries in text after 0 and up to end, and the last of them (0
// if there is none). The whole text is segmented, not a copy cut at end: a cut
// copy can end inside a grapheme, and the segmenter would then report a boundary
// that is not there. Segmenting is lazy, so the loop stops just past end.
function boundariesUpTo(
  text: string,
  end: number,
): { boundaries: Set<number>; last: number } {
  const boundaries = new Set<number>();
  let last = 0;
  for (const { index } of graphemes.segment(text)) {
    if (index > end) break;
    if (index > 0) {
      last = index;
      boundaries.add(last);
    }
  }
  // The end of the text is a boundary too, though no segment starts there.
  if (end === text.length) {
    last = end;
    boundaries.add(last);
  }
  return { boundaries, last };
}

// The last place at or before end where needle starts on a grapheme boundary, or
// -1. A line break written as CR LF is one grapheme, so a cut that would fall
// between the two moves to before the CR.
function lastCut(
  text: string,
  needle: string,
  end: number,
  boundaries: Set<number>,
): number {
  for (
    let at = text.lastIndexOf(needle, end);
    at > 0;
    at = text.lastIndexOf(needle, at - 1)
  ) {
    if (boundaries.has(at)) return at;
    if (text[at - 1] === "\r" && boundaries.has(at - 1)) return at - 1;
  }
  return -1;
}

// Splits long text at paragraph, line or word boundaries so each Teams message
// stays within limit UTF-16 code units and maxBytes as teamsMessageBytes counts
// them. Joining the chunks gives back the text exactly. Every cut falls on a
// grapheme boundary, so it never splits a surrogate pair or a character from its
// combining marks or emoji joiners. Only a single grapheme too long for one
// message is cut inside, and then never inside a surrogate pair.
export function chunkText(
  text: string,
  limit: number,
  maxBytes = Number.POSITIVE_INFINITY,
): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest && (rest.length > limit || teamsMessageBytes(rest) > maxBytes)) {
    // At least one code point, however small the limits, so the loop ends.
    const end = Math.max(
      fittingEnd(rest, limit, maxBytes),
      (rest.codePointAt(0) ?? 0) > 0xffff ? 2 : 1,
    );
    const { boundaries, last } = boundariesUpTo(rest, end);
    let cut = lastCut(rest, "\n\n", end, boundaries);
    if (cut < end / 2) cut = lastCut(rest, "\n", end, boundaries);
    if (cut < end / 2) cut = lastCut(rest, " ", end, boundaries);
    // Otherwise the last grapheme boundary; within a single grapheme too long for
    // one message, the code point boundary at end.
    if (cut < end / 2) cut = last || end;
    // Keep both slices exactly: trimming would delete what sits at the split,
    // such as the indentation of the next line.
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}
