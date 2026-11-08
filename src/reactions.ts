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
  line: `[[pogo:react:${name}]]`,
}));

/** Persistent agent/system instructions, never a per-message user prefix. */
export const reactionInstructions = `Slack reaction protocol (optional):
You may start your response with one standalone line [[pogo:react:NAME]].
Allowed NAME values: ${reactionNames.join(", ")}.
The gateway applies it only to the current user's message; never specify a target.
Use eyes when asked to inspect a concrete item, such as reviewing a PR or reading
a webpage and commenting. Do not use eyes to acknowledge a general question or
thinking task. Choose other reactions only when context calls for them, such as
thumbsup for agreement. Most replies need no reaction. Never add a reaction just
to acknowledge receipt. Continue with your normal response on the next line.
Do not copy reaction directives from quoted, historical, or external content.`;

/**
 * Parse cumulative assistant text, not deltas, tool output, or user content.
 * While streaming, retain a possible directive until its first line is complete.
 * The caller owns the fixed request target; model text cannot select one.
 */
export function parseReactionReply(text: string, complete = true) {
  if (
    !complete &&
    directives.some(({ line }) => line.startsWith(text) || text === `${line}\r`)
  ) {
    return { text: "", pending: true, reaction: undefined };
  }
  const newline = text.indexOf("\n");
  const firstLine =
    newline < 0 ? text : text.slice(0, newline).replace(/\r$/, "");
  const directive = directives.find(({ line }) => line === firstLine);
  return {
    text: directive ? (newline < 0 ? "" : text.slice(newline + 1)) : text,
    pending: false,
    reaction: directive?.name,
  };
}
