import { createHash } from "node:crypto";
import { z } from "zod";
import type { BotConfig } from "./config";

const eventSchema = z.object({
  type: z.enum(["app_mention", "message"]),
  channel: z.string(),
  user: z.string(),
  text: z.string().max(40_000),
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

export function backendFingerprint(config: BotConfig) {
  return createHash("sha256")
    .update(JSON.stringify(config.backend))
    .digest("hex");
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

export function routeEvent(
  raw: unknown,
  config: BotConfig,
  identity: Identity,
) {
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) return;
  const body = parsed.data;
  if (body.api_app_id !== config.slack.appId || body.team_id !== identity.team)
    return;
  const result = eventSchema.safeParse(body.event);
  if (!result.success) return;
  const event = result.data;
  if (
    event.bot_id ||
    event.subtype ||
    event.hidden ||
    event.user === identity.user
  )
    return;
  if (
    !config.access.users.includes(event.user) ||
    !config.access.channels.includes(event.channel)
  )
    return;
  const mention = `<@${identity.user}>`;
  const mentioned = event.text.includes(mention);
  const direct = event.channel_type === "im";
  if (config.access.mentionOnly && !mentioned) return;
  const text = event.text.split(mention).join("").trim();
  if (!text) return;
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
    startsConversation: mentioned || direct,
  };
}

export function chunks(text: string): string[] {
  const points = Array.from(
    text.trim() || "Agent finished without a text reply.",
  );
  const truncated = points.length > 60_000;
  const bounded = points.slice(0, 60_000);
  if (truncated) bounded.push(...Array.from("\n[Response truncated by Pogo.]"));
  const result: string[] = [];
  for (let i = 0; i < bounded.length; i += 2800)
    result.push(bounded.slice(i, i + 2800).join(""));
  return result;
}
