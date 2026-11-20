import type { PromptSourceContext } from "./backend";
import { validMsgid } from "./irc/protocol";

/** Compact source identity; IRC optionally adds `;r=<encoded thread root>`. */
export function sourceLine({ source }: PromptSourceContext) {
  const value = encodeURIComponent;
  return `s=${source.transport ?? "slack"};c=${value(source.channel)};t=${value(source.thread)};m=${value(source.message)};u=${value(source.user)}${source.sender ? `;k=${source.sender}` : ""}${source.authority ? `;a=${source.authority}` : ""}${source.reference ? `;e=${value(source.reference)}` : ""}${source.transport === "irc" && validMsgid(source.replyParent) ? `;r=${value(source.replyParent)}` : ""}${source.reaction ? `;reaction=${value(source.reaction.name)};action=${source.reaction.action}` : ""}`;
}

/**
 * Permanent transcript failures: the mapped session or the stored cursor no
 * longer exists. Transient read errors stay ordinary errors.
 */
export class TranscriptUnavailable extends Error {
  constructor(readonly reason: "session" | "cursor") {
    super(
      reason === "session"
        ? "Mapped session no longer exists"
        : "Transcript cursor is not in session history",
    );
  }
}

/** `after` value for messages after this adapter's latest prompt input. */
export const latestInput = "\u0000latest-input";
