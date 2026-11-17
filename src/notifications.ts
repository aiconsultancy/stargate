import { z } from "zod";
import type { BotConfig } from "./config";
import type { NotificationSnapshot } from "./notification-store";
import type { Identity } from "./routing";

/** Slack preference identity deliberately excludes the backend fingerprint. */
export function notificationKey(bot: BotConfig, identity: Identity) {
  return JSON.stringify([
    bot.id,
    bot.slack.appId,
    identity.team,
    identity.user,
  ]);
}

/** Only verified Slack ingress supplies this metadata; legacy jobs lack it. */
export const notificationContextSchema = z.strictObject({
  wake: z.enum(["ordinary", "direct", "broadcast"]),
  note: z.string().max(2000).optional(),
});
export type NotificationContext = z.infer<typeof notificationContextSchema>;
export type NotificationReader = (
  channel: string,
  thread: string,
) => NotificationSnapshot;

export function notificationNote(
  channel: string,
  thread: string,
  wake: "direct" | "broadcast",
  state: NotificationSnapshot,
) {
  return `[Notification wake: ${JSON.stringify({
    channel,
    thread,
    wake,
    mode: state.mode,
    channelMute: {
      state: state.channel.state,
      mute_until: state.channel.mute_until,
    },
    threadMute: {
      state: state.thread.state,
      mute_until: state.thread.mute_until,
    },
  })}] Saved mute remains. This message bypassed it once; explicitly unmute the exact target only if continuing participation is useful.`;
}
