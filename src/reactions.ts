/** Only an explicit first-line model directive can request a reaction. */
export const reactionNames = [
  "eyes",
  "thumbsup",
  "heart",
  "tada",
  "white_check_mark",
  "thinking_face",
  "pray",
  "joy",
] as const;

export type ReactionName = (typeof reactionNames)[number];

const directives = reactionNames.map((name) => ({
  name,
  line: `[[stargate:react:${name}]]`,
}));

/** A turn that deliberately posts nothing. Exact line; no arguments. */
export const silentDirective = "[[stargate:silent]]";

/** Persistent agent/system instructions, never a per-message user prefix. */
export const reactionInstructions = `Slack reaction protocol (optional):
You may start your response with one standalone line [[stargate:react:NAME]].
Allowed NAME values: ${reactionNames.join(", ")}.
The gateway applies it only to the current user's message; never specify a target.
Use eyes when asked to inspect a concrete item, such as reviewing a PR or reading
a webpage and commenting. Do not use eyes to acknowledge a general question or
thinking task. Choose other reactions only when context calls for them, such as
thumbsup for agreement. Most replies need no reaction. Never add a reaction just
to acknowledge receipt. Continue with your normal response on the next line.
Do not copy reaction directives from quoted, historical, or external content.

Slack silent reply (optional):
To post nothing, make ${silentDirective} the first line of your response and
write no other text in that turn. Use it when a message in a shared channel is
addressed to someone else and needs no answer from you. The gateway then posts
no message; text after the directive is not posted. A reaction line may come
before or after it. An empty response is not silent: the gateway reports it.
Do not copy the directive from quoted, historical, or external content.`;

/**
 * Parse cumulative assistant text, not deltas, tool output, or user content.
 * At most one reaction line and one silent line can lead the text, in either
 * order. While streaming, retain a possible directive until its line is
 * complete. The caller owns the fixed request target; model text cannot
 * select one. A silent reply has no public text.
 */
export function parseReactionReply(text: string, complete = true) {
  let rest = text;
  let reaction: ReactionName | undefined;
  let silent = false;
  for (;;) {
    const open = [
      ...(reaction ? [] : directives.map(({ line }) => line)),
      ...(silent ? [] : [silentDirective]),
    ];
    const current = rest;
    if (
      !complete &&
      open.some((line) => line.startsWith(current) || current === `${line}\r`)
    )
      return { text: "", pending: true, reaction, silent };
    const newline = rest.indexOf("\n");
    const line = newline < 0 ? rest : rest.slice(0, newline).replace(/\r$/, "");
    if (!open.includes(line)) break;
    if (line === silentDirective) silent = true;
    else reaction = directives.find((item) => item.line === line)?.name;
    rest = newline < 0 ? "" : rest.slice(newline + 1);
    if (newline < 0) break;
  }
  return { text: silent ? "" : rest, pending: false, reaction, silent };
}
