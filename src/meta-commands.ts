import { z } from "zod";
import type { BotConfig } from "./config";
import type { SlackDelivery } from "./gateway";
import type { NotificationPage } from "./notification-store";
import { notificationKey } from "./notifications";
import { type Identity, isAllowedChannel, isAllowedUser } from "./routing";
import type { Store } from "./store";
import { resolveWaiting, saveWaitingDelay } from "./waiting";

const envelope = z.object({
  api_app_id: z.string(),
  team_id: z.string(),
  event: z.object({
    type: z.enum(["message", "app_mention"]),
    user: z.string(),
    channel: z.string(),
    ts: z.string().regex(/^\d{1,16}\.\d{1,6}$/),
    thread_ts: z
      .string()
      .regex(/^\d{1,16}\.\d{1,6}$/)
      .optional(),
    text: z.string().max(40_000),
    bot_id: z.unknown().optional(),
    subtype: z.unknown().optional(),
    hidden: z.unknown().optional(),
    blocks: z.unknown().optional(),
    attachments: z.unknown().optional(),
  }),
});

/** Only a literal first-token bot tag followed by a command word is local. */
export function metaCandidate(raw: unknown, identity: Identity): boolean {
  const parsed = z
    .object({
      event: z.object({
        text: z.string(),
        blocks: z.unknown().optional(),
        attachments: z.unknown().optional(),
      }),
    })
    .safeParse(raw);
  if (!parsed.success) return false;
  const event = parsed.data.event;
  const text = event.text.trimStart();
  const tag = `<@${identity.user}>`;
  return (
    text.startsWith(tag) &&
    /^\s*\/[a-z][a-z-]*(?=\s|$)/.test(text.slice(tag.length)) &&
    event.attachments === undefined &&
    !unsafeMetadata(event.blocks)
  );
}

/** A proven pre-write admission change may retry; an I/O failure may not. */
class MetaAdmissionChanged extends Error {
  constructor() {
    super("Command admission changed; retry delivery.");
  }
}
function assertOpen(open: () => boolean) {
  if (!open()) throw new MetaAdmissionChanged();
}

function unsafeMetadata(raw: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (Array.isArray(raw))
    return (
      raw.length > 1000 ||
      raw.some((entry: unknown) => unsafeMetadata(entry, depth + 1))
    );
  const parsed = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!parsed.success) return false;
  const node = parsed.data;
  if (
    node["type"] === "rich_text_quote" ||
    node["type"] === "rich_text_preformatted" ||
    node["code"] === true
  )
    return true;
  return Object.values(node).some((value) => unsafeMetadata(value, depth + 1));
}

export interface MetaOptions {
  listMutes?: () => NotificationPage | Promise<NotificationPage>;
  now?: () => number;
}
type Context = {
  bot: BotConfig;
  user: string;
  options: MetaOptions;
  open: () => boolean;
};
type Outcome = {
  reply: string;
  oldDelayMs?: number | null;
  newDelayMs?: number | null;
};
type Command = {
  syntax: string;
  pattern: RegExp;
  run(context: Context, match: RegExpMatchArray): Promise<Outcome>;
};
const unavailable = "Waiting settings unavailable for this registration.";
const unconfirmed =
  "Command outcome unconfirmed; use /config to read current settings. Do not replay the change.";
function seconds(value: number | null) {
  return value === null ? "off" : `${value / 1000} seconds`;
}

async function mutePage(
  options: MetaOptions,
): Promise<NotificationPage | undefined> {
  try {
    return await options.listMutes?.();
  } catch {
    return undefined;
  }
}

/** This table is the sole dispatch and help catalogue. No model fallback. */
const commands: readonly Command[] = [
  {
    syntax: "/help",
    pattern: /^\/help$/,
    async run() {
      return { reply: help() };
    },
  },
  {
    syntax: "/config",
    pattern: /^\/config$/,
    async run({ bot, options }) {
      const page = await mutePage(options);
      return {
        reply: `waiting: ${seconds((await resolveWaiting(bot)).delayMs)}\nmutes (read-only): ${page ? `${page.counts.channel} channels, ${page.counts.thread} threads` : "unavailable"}`,
      };
    },
  },
  {
    syntax: "/config waiting <0..3600|off>",
    pattern: /^\/config waiting (off|\d+)$/,
    async run({ bot, user, open }, match) {
      const value = match[1];
      const count = value === "off" ? null : Number(value);
      if (count !== null && (!Number.isSafeInteger(count) || count > 3600))
        return { reply: help() };
      if (bot.backend.type !== "opencode" || !bot.backend.agent)
        return { reply: unavailable };
      const oldDelayMs = (await resolveWaiting(bot)).delayMs;
      const newDelayMs = count === null ? null : count * 1000;
      assertOpen(open);
      await saveWaitingDelay(
        bot.backend.directory,
        bot.backend.agent,
        newDelayMs,
        AbortSignal.timeout(5000),
      );
      return {
        reply: `waiting: ${seconds(oldDelayMs)} → ${seconds(newDelayMs)}; changed by ${user}.`,
        oldDelayMs,
        newDelayMs,
      };
    },
  },
  {
    syntax: "/config mutes",
    pattern: /^\/config mutes$/,
    async run({ options }) {
      const page = await mutePage(options);
      if (!page) {
        return { reply: "Mute preferences unavailable for this registration." };
      }
      const candidates = page.settings.map(
        ({ target, setting }) =>
          `${target.channel}${target.scope === "thread" ? ` thread ${target.thread_ts}` : " channel"}: ${setting.state}; expiry ${setting.mute_until ?? "none"}`,
      );
      const lines: string[] = [];
      let size = 0;
      for (const line of candidates) {
        if (size + line.length > 2400) break;
        lines.push(line);
        size += line.length + 1;
      }
      // One bounded page/reply; reasons never enter Slack output.
      return {
        reply: `Mutes: ${page.counts.channel} channels, ${page.counts.thread} threads.\n${lines.join("\n") || "None saved."}${page.cursor || lines.length < candidates.length ? `\nTruncated: first ${lines.length} settings shown.` : ""}`,
      };
    },
  },
  ...["enable", "disable"].flatMap((action) =>
    ["filtering", "routing"].map(
      (feature): Command => ({
        syntax: `/config ${action} system one message ${feature}`,
        pattern: new RegExp(
          `^/config ${action} system one message ${feature}$`,
        ),
        async run() {
          return { reply: "not available yet (NET-1709)" };
        },
      }),
    ),
  ),
];
function help(): string {
  return `Valid commands:\n${commands.map((command) => command.syntax).join("\n")}`;
}

/** Per-registration serialisation is independent of the model worker queue. */
export class MetaCommands {
  private tail = Promise.resolve();
  constructor(
    private readonly store: Store,
    private readonly slack: SlackDelivery,
    private readonly options: MetaOptions = {},
  ) {}

  receive(
    raw: unknown,
    bot: BotConfig,
    identity: Identity,
    open: () => boolean,
  ): Promise<boolean> | false {
    if (!metaCandidate(raw, identity)) return false;
    const next = this.tail.then(() => this.handle(raw, bot, identity, open));
    this.tail = next.catch(() => {});
    return next.then(() => true);
  }

  private async handle(
    raw: unknown,
    bot: BotConfig,
    identity: Identity,
    open: () => boolean,
  ) {
    const parsed = envelope.safeParse(raw);
    if (!parsed.success) return;
    assertOpen(open);
    const body = parsed.data;
    const event = body.event;
    const text = event.text.trim();
    const tag = `<@${identity.user}>`;
    if (
      body.api_app_id !== bot.slack.appId ||
      body.team_id !== identity.team ||
      event.bot_id !== undefined ||
      event.subtype !== undefined ||
      event.hidden ||
      event.user === identity.user ||
      !isAllowedUser(bot, event.user) ||
      !isAllowedChannel(bot, event.channel) ||
      !text.startsWith(tag) ||
      (text.match(/<@[A-Z0-9]+>/g)?.length ?? 0) !== 1 ||
      event.attachments !== undefined ||
      unsafeMetadata(event.blocks)
    )
      return;
    const commandText = text.slice(tag.length).trim().replace(/\s+/g, " ");
    if (!commandText.startsWith("/")) return;
    const registration = notificationKey(bot, identity);
    const message = `${event.channel}:${event.ts}`;
    const entry = commands.find((candidate) =>
      candidate.pattern.test(commandText),
    );
    const at = (this.options.now ?? Date.now)();
    assertOpen(open);
    const fresh = this.store.claimMeta({
      registration,
      message,
      channel: event.channel,
      thread: event.thread_ts ?? event.ts,
      user: event.user,
      at,
      command: entry?.syntax ?? "unknown",
    });
    if (fresh) {
      let outcome: Outcome;
      try {
        const match = entry?.pattern.exec(commandText);
        outcome =
          entry && match
            ? await entry.run(
                { bot, user: event.user, options: this.options, open },
                match,
              )
            : { reply: help() };
      } catch (error) {
        if (error instanceof MetaAdmissionChanged) {
          this.store.releaseMetaClaim(registration, message);
          throw error;
        }
        // A write may have completed: retain pending and never reapply it.
        assertOpen(open);
        await this.slack.post(
          event.channel,
          event.thread_ts ?? event.ts,
          unconfirmed,
        );
        this.store.deliverMeta(registration, message);
        return;
      }
      this.store.applyMeta(
        registration,
        message,
        outcome.reply,
        outcome.oldDelayMs,
        outcome.newDelayMs,
      );
    }
    const receipt = this.store.metaReceipt(registration, message);
    if (!receipt || receipt.user !== event.user) return;
    assertOpen(open);
    if (receipt.delivered) return;
    await this.slack.post(
      receipt.channel,
      receipt.thread,
      receipt.reply ?? unconfirmed,
    );
    this.store.deliverMeta(registration, message);
  }
}
