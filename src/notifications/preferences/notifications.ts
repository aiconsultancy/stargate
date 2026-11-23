import { Schema } from "effect";
import { exactStruct } from "../../shared/session-history";
import type { NotificationSnapshot } from "./notification-store";

type Identity = { team: string; user: string };

/** Slack preference identity deliberately excludes the backend fingerprint. */
export function notificationKey<
  T extends { id: string; slack: { appId: string } },
>(bot: T, identity: Identity) {
  return JSON.stringify([
    bot.id,
    bot.slack.appId,
    identity.team,
    identity.user,
  ]);
}

/** Only verified Slack ingress supplies this metadata; legacy jobs lack it. */
export const notificationContextSchema = exactStruct({
  wake: Schema.Literals(["ordinary", "direct", "broadcast"]),
  note: Schema.optional(Schema.String.check(Schema.isMaxCodePoints(2000))),
});

export type NotificationContext = typeof notificationContextSchema.Type;

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
