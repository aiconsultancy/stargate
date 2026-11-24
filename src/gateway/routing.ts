import {
  type Identity,
  botKey,
  isAllowedChannel,
  isAllowedUser,
} from "../shared/registration";

export {
  backendFingerprint,
  botKey,
  type Identity,
  isAllowedChannel,
  isAllowedUser,
} from "../shared/registration";

import { Result, Schema } from "effect";
import { maxAttachments } from "../chat/attachments/attachments";
import { markdownChunks } from "../transports/slack/markdown-chunks";
import { findMention, visibleText } from "../shared/mentions";
import {
  type NotificationContext,
  type NotificationReader,
  notificationNote,
} from "../notifications/preferences/notifications";
import type { PeerSender } from "./peers";
import {
  type InboundReaction,
  inboundReactionSchema,
  slackTimestamp,
} from "../shared/reactions";
import { settingsDefault, settingsPattern } from "../config/settings-schema";

const eventSchema = Schema.Struct({
  type: Schema.Literals(["app_mention", "message"]),
  channel: Schema.String,
  user: Schema.String,
  text: Schema.String.check(Schema.isMaxCodePoints(40_000)).pipe(
    settingsDefault(""),
  ),
  files: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          id: Schema.String.check(settingsPattern(/^F[A-Z0-9]+$/)),
        }),
      ),
    ).check(Schema.isMaxLength(maxAttachments)),
  ),
  ts: Schema.String.check(settingsPattern(/^\d+\.\d+$/)),
  thread_ts: Schema.optional(
    Schema.String.check(settingsPattern(/^\d+\.\d+$/)),
  ),
  channel_type: Schema.optional(Schema.String),
  bot_id: Schema.optional(Schema.String),
  subtype: Schema.optional(Schema.String),
  hidden: Schema.optional(Schema.Boolean),
});

export const envelopeSchema = Schema.Struct({
  api_app_id: Schema.String,
  team_id: Schema.String,
  event_id: Schema.String,
  event: Schema.optional(Schema.Unknown),
});

const reactionEventSchema = Schema.Struct({
  type: Schema.Literals(["reaction_added", "reaction_removed"]),
  user: Schema.String.check(settingsPattern(/^[UW][A-Z0-9]+$/)),
  bot_id: Schema.optional(Schema.Never),
  reaction: inboundReactionSchema.fields.name,
  item: Schema.Struct({
    type: Schema.Literal("message"),
    channel: Schema.String.check(settingsPattern(/^[CGD][A-Z0-9]+$/)),
    ts: slackTimestamp,
  }),
  item_user: Schema.String,
  event_ts: slackTimestamp,
});

const reactionEnvelopeSchema = Schema.Struct({
  ...envelopeSchema.fields,
  event_id: Schema.String.check(settingsPattern(/^Ev[A-Za-z0-9]{1,128}$/)),
  event: reactionEventSchema,
});

export function conversationKey(key: string, channel: string, thread: string) {
  return JSON.stringify([key, channel, thread]);
}

/** Candidate only. Slack intake must still prove target ownership and a human actor. */
export function routeReaction<T extends Parameters<typeof botKey>[0]>(
  raw: unknown,
  config: T,
  identity: Identity,
) {
  if (!config.slack.inboundReactions || config.access.mentionOnly) {
    return;
  }

  const parsed = Schema.decodeUnknownResult(reactionEnvelopeSchema)(raw);

  if (Result.isFailure(parsed)) {
    return;
  }

  const { api_app_id, team_id, event_id, event } = parsed.success;

  if (
    api_app_id !== config.slack.appId ||
    team_id !== identity.team ||
    event.item_user !== identity.user ||
    event.user === identity.user ||
    event.user === "USLACKBOT" ||
    !isAllowedUser(config, event.user) ||
    !isAllowedChannel(config, event.item.channel)
  ) {
    return;
  }

  return {
    eventId: `reaction:${event_id}`,
    botKey: botKey(config, identity),
    channel: event.item.channel,
    user: event.user,
    slackReaction: {
      name: event.reaction,
      action: event.type === "reaction_added" ? "added" : "removed",
      ts: event.item.ts,
    } satisfies InboundReaction,
  };
}

/**
 * `peer` is a sender that Slack's directory proved to be a peer captain bot.
 * Without it, every bot message is rejected.
 */
export function routeEvent<T extends Parameters<typeof botKey>[0]>(
  raw: unknown,
  config: T,
  identity: Identity,
  peer?: PeerSender,
  notifications?: NotificationReader,
) {
  const parsed = Schema.decodeUnknownResult(envelopeSchema)(raw);

  if (Result.isFailure(parsed)) {
    return;
  }

  const body = parsed.success;

  if (
    body.api_app_id !== config.slack.appId ||
    body.team_id !== identity.team
  ) {
    return;
  }

  const result = Schema.decodeUnknownResult(eventSchema)(body.event);

  if (Result.isFailure(result)) {
    return;
  }

  const event = result.success;

  const captain =
    event.bot_id !== undefined &&
    config.access.peerCaptains &&
    peer?.user === event.user &&
    peer.bot === event.bot_id;

  if (
    (event.bot_id && !captain) ||
    (event.subtype && event.subtype !== "file_share") ||
    event.hidden ||
    event.user === identity.user
  ) {
    return;
  }

  if (
    !isAllowedUser(config, event.user) ||
    !isAllowedChannel(config, event.channel)
  ) {
    return;
  }

  const mention = `<@${identity.user}>`;
  const mentioned = event.text.includes(mention);
  const direct = event.channel_type === "im";
  const text = event.text.split(mention).join("").trim();

  const notification =
    !direct && !event.channel.startsWith("D")
      ? notifications?.(event.channel, event.thread_ts ?? event.ts)
      : undefined;

  const muted = notification?.mode === "addressed-only";
  // A top-level channel message can address the bot by name, without a mention.
  const textRule = config.access.textMentions;

  const broadcast =
    !event.bot_id && textRule?.channels.includes(event.channel)
      ? findMention([visibleText(text)], textRule.muteBypassNames ?? [])
      : undefined;

  const wake: NotificationContext["wake"] = mentioned
    ? "direct"
    : broadcast
      ? "broadcast"
      : "ordinary";

  if (muted && wake === "ordinary") {
    return;
  }

  const named =
    (!mentioned &&
    !direct &&
    (event.thread_ts === undefined || event.thread_ts === event.ts) &&
    textRule?.channels.includes(event.channel)
      ? findMention([visibleText(text)], textRule.names)
      : undefined) ?? (muted ? broadcast : undefined);

  // Speech can name the bot; the gateway decides after transcription.
  const spoken =
    !mentioned &&
    !direct &&
    named === undefined &&
    (event.files?.length ?? 0) > 0 &&
    config.transcription?.spokenMentions?.channels.includes(event.channel) ===
      true;

  if (config.access.mentionOnly && !mentioned && !spoken && !named) {
    return;
  }

  if (!text && !event.files?.length) {
    return;
  }

  const key = botKey(config, identity);

  return {
    // App_mention and message can describe the same Slack message.
    eventId: `${event.channel}:${event.ts}`,
    botKey: key,
    conversation: conversationKey(
      key,
      event.channel,
      event.thread_ts ?? event.ts,
    ),
    channel: event.channel,
    thread: event.thread_ts ?? event.ts,
    user: event.user,
    text,
    ...(notification && {
      notification: {
        wake,
        ...(muted &&
          wake !== "ordinary" && {
            note: notificationNote(
              event.channel,
              event.thread_ts ?? event.ts,
              wake,
              notification,
            ),
          }),
      },
    }),
    ...(config.slackReadReceipts && { received: Number(event.ts) * 1000 }),
    ...(event.files?.length && { files: event.files.map((file) => file.id) }),
    ...(captain && { sender: "captain" as const }),
    ...(spoken && { gate: "spoken" as const }),
    ...(named && { textMention: named }),
    startsConversation: mentioned || direct || named !== undefined,
  };
}

export function chunks(text: string): string[] {
  const points = Array.from(
    text.trim() || "Agent finished without a text reply.",
  );

  const truncated = points.length > 60_000;
  const bounded = points.slice(0, 60_000);

  if (truncated) {
    bounded.push(...Array.from("\n[Response truncated by Stargate.]"));
  }

  return markdownChunks(bounded);
}

/** Every chunk of settled transcript text; history replies are never clipped. */
export function transcriptChunks(text: string): string[] {
  const trimmed = text.trim();

  return trimmed ? markdownChunks(Array.from(trimmed)) : [];
}
