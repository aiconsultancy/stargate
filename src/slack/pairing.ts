import { randomUUID } from "node:crypto";
import { Result, Schema } from "effect";
import type { Logger } from "pino";
import type { AgentBackend } from "../backend";
import type { BotConfig } from "../config";
import type { CronUIApi, CronView, SlackAck } from "../cron/ui";
import {
  type Identity,
  isAllowedChannel,
  isAllowedUser,
} from "../gateway/routing";
import { settingsPattern, settingsUUID } from "../config/settings-schema";
import { botDisplayName } from "../gateway/waiting";

const id = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(255),
);
const userId = Schema.String.check(settingsPattern(/^[UW][A-Z0-9]+$/));
const channelId = Schema.String.check(settingsPattern(/^[CGD][A-Z0-9]+$/));
const commandSchema = Schema.Struct({
  command: Schema.Literal("/stargate"),
  text: Schema.Literal("pair"),
  api_app_id: id,
  team_id: id,
  user_id: userId,
  channel_id: channelId,
  trigger_id: id,
  user_name: Schema.optional(Schema.String),
  is_bot: Schema.optional(Schema.Literal(false)),
  bot_id: Schema.optional(Schema.Never),
});
const actionSchema = Schema.Struct({
  type: Schema.Literal("block_actions"),
  api_app_id: id,
  team: Schema.Struct({ id }),
  user: Schema.Struct({
    id: userId,
    is_bot: Schema.optional(Schema.Literal(false)),
    bot_id: Schema.optional(Schema.Never),
  }),
  bot_id: Schema.optional(Schema.Never),
  channel: Schema.optional(Schema.Struct({ id: channelId })),
  container: Schema.Struct({ type: Schema.Literal("view"), view_id: id }),
  view: Schema.Struct({
    id,
    hash: id,
    callback_id: Schema.Literal("stargate_pair"),
    private_metadata: settingsUUID,
  }),
  actions: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        type: Schema.Literal("button"),
        action_id: Schema.Literal("stargate_pair_generate"),
        value: Schema.Literal("generate"),
        url: Schema.optional(Schema.Never),
      }),
    ),
  ).check(Schema.isBetweenLength(1, 1)),
});

const plain = (text: string) => ({
  type: "plain_text" as const,
  text,
  emoji: false,
});
const section = (text: string) => ({
  type: "section" as const,
  text: plain(text),
});
const warning =
  "This grants full server access for 30 days, not read-only or conversation-only access. Anyone with a URL can pair once before it expires. Generate only for your own trusted device. Slack receives the secret in this private modal.";
function notice(text: string): CronView {
  return {
    type: "modal",
    title: plain("OpenCode pairing"),
    close: plain("Close"),
    clear_on_close: true,
    blocks: [section(text)],
  };
}

type Confirmation = {
  user: string;
  channel: string;
  expires: number;
  used: boolean;
};

/** No codes, URLs or SDK errors enter persistent state or logging. */
export class PairingUI {
  private readonly pending = new Map<string, Confirmation>();
  constructor(
    private config: BotConfig,
    private readonly identity: Identity,
    private readonly backend: Pick<AgentBackend, "pair">,
    private readonly api: Pick<CronUIApi, "open" | "update">,
    private readonly log: Logger,
    private readonly signal: AbortSignal,
    private readonly monotonicNow: () => number = () => performance.now(),
    private readonly deadline: () => AbortSignal = () =>
      AbortSignal.timeout(15_000),
    private readonly wallNow: () => number = Date.now,
  ) {}

  /** Access changes apply before the next operation or delivery. */
  reconfigure(config: BotConfig) {
    this.config = config;
  }

  private allowed(user: string, channel: string, app: string, team: string) {
    return (
      !this.signal.aborted &&
      this.config.backend.type === "opencode" &&
      !!this.backend.pair &&
      !!this.config.pairing?.operators.includes(user) &&
      app === this.config.slack.appId &&
      team === this.identity.team &&
      user !== this.identity.user &&
      isAllowedUser(this.config, user) &&
      isAllowedChannel(this.config, channel)
    );
  }

  async command(body: unknown, ack: SlackAck) {
    let acknowledged = false;
    const once: SlackAck = async (payload) => {
      acknowledged = true;
      await ack(payload);
    };
    try {
      const parsed = Schema.decodeUnknownResult(commandSchema)(body);
      if (
        Result.isFailure(parsed) ||
        parsed.success.user_name === "slackbot" ||
        !this.allowed(
          parsed.success.user_id,
          parsed.success.channel_id,
          parsed.success.api_app_id,
          parsed.success.team_id,
        )
      ) {
        await once({
          response_type: "ephemeral",
          text: "Pairing unavailable. Use /stargate pair with an authorized operator and channel.",
        });
        return;
      }
      const now = this.monotonicNow();
      for (const [nonce, entry] of this.pending) {
        if (entry.expires <= now) this.pending.delete(nonce);
      }
      if (this.pending.size >= 128) {
        await once({
          response_type: "ephemeral",
          text: "Too many pairing confirmations. Wait five minutes and try again.",
        });
        return;
      }
      const data = parsed.success;
      const nonce = randomUUID();
      this.pending.set(nonce, {
        user: data.user_id,
        channel: data.channel_id,
        expires: now + 300_000,
        used: false,
      });
      await once();
      await this.api.open(data.trigger_id, {
        ...notice(warning),
        callback_id: "stargate_pair",
        private_metadata: nonce,
        blocks: [
          section(warning),
          {
            type: "actions",
            elements: [
              {
                type: "button",
                action_id: "stargate_pair_generate",
                value: "generate",
                text: plain("Generate"),
                style: "danger",
              },
            ],
          },
        ],
      });
    } catch {
      this.log.error("Could not open pairing confirmation");
      if (!acknowledged)
        await once({
          response_type: "ephemeral",
          text: "Pairing unavailable.",
        });
    }
  }

  async interactive(body: unknown, ack: SlackAck) {
    // Acknowledge before any network work, including error notices.
    // Consume the confirmation before ACK: a failed ACK must not replay minting.
    const parsed = Schema.decodeUnknownResult(actionSchema)(body);
    const data = Result.isSuccess(parsed) ? parsed.success : undefined;
    const pending = data && this.pending.get(data.view.private_metadata);
    const owned =
      data &&
      pending &&
      !pending.used &&
      data.container.view_id === data.view.id &&
      pending.user === data.user.id &&
      (!data.channel || data.channel.id === pending.channel) &&
      data.api_app_id === this.config.slack.appId &&
      data.team.id === this.identity.team;
    const valid =
      owned &&
      pending.expires > this.monotonicNow() &&
      this.allowed(
        data.user.id,
        pending.channel,
        data.api_app_id,
        data.team.id,
      );
    if (owned) pending.used = true;
    try {
      await ack();
    } catch {
      this.log.error("Could not acknowledge pairing action");
      return;
    }
    // Invalid envelopes cannot select a modal. Duplicate actions do nothing,
    // preserving any already-delivered code instead of overwriting it.
    if (!owned || !data || !pending) return;
    try {
      if (!valid || pending.expires <= this.monotonicNow()) {
        await this.api.update(
          data.view.id,
          data.view.hash,
          notice(
            "Pairing confirmation expired or access was removed. Close this modal and use /stargate pair again if authorized.",
          ),
        );
        return;
      }
      const signal = AbortSignal.any([this.signal, this.deadline()]);
      signal.throwIfAborted();
      // Recheck after ACK; never trust Slack to select a backend or URL.
      if (
        !this.allowed(
          data.user.id,
          pending.channel,
          data.api_app_id,
          data.team.id,
        ) ||
        !this.backend.pair
      )
        return;
      const started = this.monotonicNow();
      const result = await this.backend.pair(signal);
      signal.throwIfAborted();
      if (
        !this.allowed(
          data.user.id,
          pending.channel,
          data.api_app_id,
          data.team.id,
        )
      )
        return;
      // Wall-clock corrections must not change local expiry decisions.
      // Count request time conservatively; only the server can redeem a code.
      const remaining =
        result.expiresIn * 1000 - (this.monotonicNow() - started);
      if (remaining <= 0) throw new Error("Pairing expired");
      const expires = this.wallNow() + remaining;
      const urls =
        this.config.pairing?.urls.map(
          (origin) =>
            `${origin}/auth/connect/${encodeURIComponent(result.code)}`,
        ) ?? [];
      await this.api.update(data.view.id, data.view.hash, {
        ...notice(warning),
        blocks: [
          section(warning),
          section(
            `Single use across all URLs: redeeming any one invalidates all aliases. Server lifetime: ${result.expiresIn} seconds from generation. Use before ${new Date(expires).toISOString()} (conservative local estimate; server expiry is authoritative). Copy a URL into the trusted device's browser; do not share it.`,
          ),
          // Literal plain_text only: no markdown, link button or unfurl.
          ...urls.map(section),
          section(
            `After pairing, find your conversation in OpenCode. New sessions here use the title: ${botDisplayName(this.config)} (slack ${pending.channel}). Separate threads can share this title; existing titles stay unchanged. Pairing does not create a session. Closing this modal does not revoke an issued code or paired device.`,
          ),
        ],
      });
    } catch {
      this.log.error("Pairing request failed; not retried");
      if (this.signal.aborted) return;
      try {
        await this.api.update(
          data.view.id,
          data.view.hash,
          notice(
            "Pairing failed or delivery is uncertain. No retry was made. An issued code may remain valid until expiry. Close this modal. Inspect the server before requesting a new code.",
          ),
        );
      } catch {
        this.log.error("Could not update pairing modal");
      }
    }
  }
}
