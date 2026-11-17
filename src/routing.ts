import { createHash } from "node:crypto";
import { z } from "zod";
import { maxAttachments } from "./attachments";
import type { BotConfig } from "./config";
import { markdownChunks } from "./markdown-chunks";
import { findMention, visibleText } from "./mentions";
import {
  type NotificationContext,
  type NotificationReader,
  notificationNote,
} from "./notifications";
import type { PeerSender } from "./peers";

const eventSchema = z.object({
  type: z.enum(["app_mention", "message"]),
  channel: z.string(),
  user: z.string(),
  text: z.string().max(40_000).default(""),
  files: z
    .array(z.object({ id: z.string().regex(/^F[A-Z0-9]+$/) }))
    .max(maxAttachments)
    .optional(),
  ts: z.string().regex(/^\d+\.\d+$/),
  thread_ts: z
    .string()
    .regex(/^\d+\.\d+$/)
    .optional(),
  channel_type: z.string().optional(),
  bot_id: z.string().optional(),
  subtype: z.string().optional(),
  hidden: z.boolean().optional(),
});

export const envelopeSchema = z.object({
  api_app_id: z.string(),
  team_id: z.string(),
  event_id: z.string(),
  event: z.unknown(),
});

export type Identity = { team: string; user: string };

export function backendFingerprint(config: Pick<BotConfig, "backend">) {
  // A pin selects execution identity, not a new Slack/outbox namespace.
  const backend = { ...config.backend };
  if (backend.type === "opencode") delete backend.sessionID;
  return createHash("sha256").update(JSON.stringify(backend)).digest("hex");
}

export function botKey(config: BotConfig, identity: Identity) {
  const fingerprint = backendFingerprint(config);
  return JSON.stringify([
    config.id,
    config.slack.appId,
    identity.team,
    identity.user,
    fingerprint,
  ]);
}

export function conversationKey(key: string, channel: string, thread: string) {
  return JSON.stringify([key, channel, thread]);
}

function matchesId(rules: readonly string[], id: string) {
  return rules.includes("*") || rules.includes(id);
}

export function isAllowedUser(config: BotConfig, user: string) {
  return (
    !matchesId(config.access.deniedUsers, user) &&
    matchesId(config.access.users, user)
  );
}

export function isAllowedChannel(config: BotConfig, channel: string) {
  return (
    !matchesId(config.access.deniedChannels, channel) &&
    matchesId(config.access.channels, channel)
  );
}

/**
 * `peer` is a sender that Slack's directory proved to be a peer captain bot.
 * Without it, every bot message is rejected.
 */
export function routeEvent(
  raw: unknown,
  config: BotConfig,
  identity: Identity,
  peer?: PeerSender,
  notifications?: NotificationReader,
) {
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) return;
  const body = parsed.data;
  if (body.api_app_id !== config.slack.appId || body.team_id !== identity.team)
    return;
  const result = eventSchema.safeParse(body.event);
  if (!result.success) return;
  const event = result.data;
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
  )
    return;
  if (
    !isAllowedUser(config, event.user) ||
    !isAllowedChannel(config, event.channel)
  )
    return;
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
  if (muted && wake === "ordinary") return;
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
  if (config.access.mentionOnly && !mentioned && !spoken && !named) return;
  if (!text && !event.files?.length) return;
  const key = botKey(config, identity);
  return {
    // app_mention and message can describe the same Slack message.
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
    ...(notification
      ? {
          notification: {
            wake,
            ...(muted && wake !== "ordinary"
              ? {
                  note: notificationNote(
                    event.channel,
                    event.thread_ts ?? event.ts,
                    wake,
                    notification,
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(config.slackReadReceipts ? { received: Number(event.ts) * 1000 } : {}),
    ...(event.files?.length
      ? { files: event.files.map((file) => file.id) }
      : {}),
    ...(captain ? { sender: "captain" as const } : {}),
    ...(spoken ? { gate: "spoken" as const } : {}),
    ...(named ? { textMention: named } : {}),
    startsConversation: mentioned || direct || named !== undefined,
  };
}

export function chunks(text: string): string[] {
  const points = Array.from(
    text.trim() || "Agent finished without a text reply.",
  );
  const truncated = points.length > 60_000;
  const bounded = points.slice(0, 60_000);
  if (truncated)
    bounded.push(...Array.from("\n[Response truncated by Stargate.]"));
  return markdownChunks(bounded);
}

/** Every chunk of settled transcript text; history replies are never clipped. */
export function transcriptChunks(text: string): string[] {
  const trimmed = text.trim();
  return trimmed ? markdownChunks(Array.from(trimmed)) : [];
}
