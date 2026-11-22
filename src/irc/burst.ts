import { Schema } from "effect";
import { settingsStartsWith, settingsStruct } from "../config/settings-schema";
import type { Incoming } from "../gateway/store-types";
import { validMsgid } from "./protocol";

/** Bounds apply to accepted live messages, never to already running work. */
export const ircBurstLimits = {
  waitMs: 10_000,
  messages: 16,
  bytes: 64 * 1024,
  files: 10,
} as const;

export const ircBurstMessageSchema = settingsStruct({
  eventId: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(4096),
  ),
  thread: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(1024),
  ),
  source: Schema.String.check(
    settingsStartsWith("s=irc;"),
    Schema.isMaxCodePoints(8192),
  ),
  text: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(100_000),
  ),
  originalText: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(100_000),
  ),
  received: Schema.Finite,
  files: Schema.mutable(
    Schema.Array(Schema.String.check(Schema.isMaxCodePoints(2048))),
  ).check(Schema.isMaxLength(10)),
});
export type IrcBurstMessage = typeof ircBurstMessageSchema.Type;

/** Transport admission remains separate; only ordinary human jobs can group. */
export function ircBurstEligible(input: Incoming): boolean {
  return (
    !input.sender &&
    !input.fleet &&
    !input.gate &&
    !input.deferDelivery &&
    validMsgid(input.thread) &&
    (input.replyParent == null || validMsgid(input.replyParent))
  );
}

/** JSON quotes user text; user-written delimiters cannot create another source. */
export function ircBurstText(messages: readonly IrcBurstMessage[]) {
  if (messages.length === 1) return messages[0]?.text ?? "";
  return [
    "IRC message burst, in receive order. Each JSON record is a separate original message, not one combined instruction or approval. Verify each source independently when required. Approval or clarification in one record does not apply to another unless its human author explicitly links them. Answer the complete burst without repeating work.",
    JSON.stringify(
      messages.map(({ source, text, received }) => ({
        source,
        received,
        text,
      })),
      null,
      2,
    ),
  ].join("\n\n");
}
