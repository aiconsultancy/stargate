import { cleanText, utf8Bytes } from "./protocol";

const fenceMarker = /^\s{0,3}(`{3,}|~{3,})/;
const rule = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const tableSeparator = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Emphasis, links and escapes in text outside inline code spans. */
function inline(text: string) {
  return text
    .replace(
      /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
      (_m, alt: string, url: string) => (alt ? `${alt} (${url})` : url),
    )
    .replace(
      /\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
      (_m, label: string, url: string) =>
        label === url ? url : `${label} (${url})`,
    )
    .replace(/<((?:https?|mailto):[^\s<>]+)>/g, "$1")
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1")
    .replace(/__(?=\S)(.+?)(?<=\S)__/g, "$1")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
    .replace(
      /(?<![\p{L}\p{N}*\\])\*(?=\S)(.+?)(?<=\S)\*(?![\p{L}\p{N}*])/gu,
      "$1",
    )
    .replace(
      /(?<![\p{L}\p{N}_\\])_(?=\S)(.+?)(?<=\S)_(?![\p{L}\p{N}_])/gu,
      "$1",
    )
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, "$1");
}

/** Inline code spans keep their backticks; only other text is rewritten. */
function inlineLine(line: string) {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, index) => (index % 2 ? part : inline(part)))
    .join("");
}

/**
 * Readable plain text from agent Markdown. IRC shows no Markdown, so fences,
 * headings, emphasis and table rules are removed; code lines, list bullets,
 * quotes and inline code backticks stay as typed. Links keep their URL.
 * Control characters are removed, so text cannot carry CTCP or formatting.
 */
export function plainText(markdown: string): string {
  const out: string[] = [];
  let fence: string | undefined;

  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = cleanText(raw);
    const marker = fenceMarker.exec(line)?.[1];

    if (fence !== undefined) {
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        line.trim() === marker
      ) {
        fence = undefined;
      } else {
        out.push(line);
      }

      continue;
    }

    if (marker) {
      fence = marker;
      continue;
    }

    if (rule.test(line) || tableSeparator.test(line)) {
      continue;
    }

    let text = line
      .replace(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/, "$1")
      .replace(/^(\s*)[*+]\s+/, "$1- ");

    // `| a | b |` table rows read as `a | b`.
    if (/^\s*\|.*\|\s*$/.test(text)) {
      text = text
        .trim()
        .replace(/^\|\s*/, "")
        .replace(/\s*\|$/, "");
    }

    out.push(inlineLine(text));
  }

  return out.join("\n");
}

/**
 * Split text into IRC lines of at most `budget` UTF-8 bytes. Blank lines are
 * dropped (IRC cannot send an empty message). A long line breaks at the last
 * space that keeps at least half the budget, otherwise at a code point
 * boundary, never inside a UTF-8 sequence.
 */
export function ircLines(text: string, budget: number): string[] {
  if (budget < 16) {
    throw new Error("IRC line budget too small");
  }

  const lines: string[] = [];

  for (const line of text.split("\n")) {
    let rest = line.trimEnd();

    while (rest.trim() && utf8Bytes(rest) > budget) {
      let bytes = 0;
      let end = 0;
      let space = -1;

      for (const char of rest) {
        const size = utf8Bytes(char);

        if (bytes + size > budget) {
          break;
        }

        bytes += size;
        end += char.length;

        if (char === " " && bytes > budget / 2) {
          space = end - 1;
        }
      }

      const cut = space > 0 ? space : end;
      lines.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).replace(/^ +/, "");
    }

    if (rest.trim()) {
      lines.push(rest);
    }
  }

  return lines;
}
