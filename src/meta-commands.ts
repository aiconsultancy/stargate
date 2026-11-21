import { randomUUID } from "node:crypto";
import { Result, Schema } from "effect";
import type { BotConfig } from "./config";
import {
  buildConfigPanel,
  type ConfigPanelRow,
  configActionCandidate,
  configActionPrefix,
  configActionSchema,
  configPanelRefused,
  configPanelStale,
  configPanelUnavailable,
  configReplyTarget,
  configSnapshotSchema,
  readConfigSnapshot,
  sameConfigSnapshot,
} from "./config-panel";
import type { SlackDelivery } from "./gateway/ports";
import type { NotificationPage } from "./notification-store";
import { notificationKey } from "./notifications";
import {
  type QuestionSettings,
  resolveQuestionSettings,
  saveQuestionSettings,
} from "./question-settings";
import { type Identity, isAllowedChannel, isAllowedUser } from "./routing";
import { settingsPattern, settingsRecord } from "./settings-schema";
import type { ConfigPanelRecord, Store } from "./store";
import { resolveWaiting, saveWaitingDelay } from "./waiting";

const envelope = Schema.Struct({
  api_app_id: Schema.String,
  team_id: Schema.String,
  event: Schema.Struct({
    type: Schema.Literals(["message", "app_mention"]),
    user: Schema.String,
    channel: Schema.String,
    ts: Schema.String.check(settingsPattern(/^\d{1,16}\.\d{1,6}$/)),
    thread_ts: Schema.optional(
      Schema.String.check(settingsPattern(/^\d{1,16}\.\d{1,6}$/)),
    ),
    text: Schema.String.check(Schema.isMaxCodePoints(40_000)),
    bot_id: Schema.optional(Schema.Unknown),
    subtype: Schema.optional(Schema.Unknown),
    hidden: Schema.optional(Schema.Unknown),
    blocks: Schema.optional(Schema.Unknown),
    attachments: Schema.optional(Schema.Unknown),
  }),
});

/** Only a literal first-token bot tag followed by a command word is local. */
export function metaCandidate(raw: unknown, identity: Identity): boolean {
  const parsed = Schema.decodeUnknownResult(
    Schema.Struct({
      event: Schema.Struct({
        text: Schema.String,
        blocks: Schema.optional(Schema.Unknown),
        attachments: Schema.optional(Schema.Unknown),
      }),
    }),
  )(raw);
  if (Result.isFailure(parsed)) return false;
  const event = parsed.success.event;
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
  const parsed = Schema.decodeUnknownResult(
    settingsRecord(Schema.String, Schema.Unknown),
  )(raw);
  if (Result.isFailure(parsed)) return false;
  const node = parsed.success;
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
  health?: (section?: string) => Promise<string>;
  now?: () => number;
  /** Authenticated directory evidence, not a payload's omission of is_bot. */
  isHuman?: (user: string) => Promise<boolean>;
}
type Context = {
  bot: BotConfig;
  user: string;
  options: MetaOptions;
  open: () => boolean;
  beforeWrite?: () => Promise<void>;
};
type Outcome = {
  reply: string;
  oldDelayMs?: number | null;
  newDelayMs?: number | null;
  questions?: QuestionSettings;
};
type Command = {
  syntax: string;
  pattern: RegExp;
  panel?: ConfigPanelRow;
  run(context: Context, match: RegExpMatchArray): Promise<Outcome>;
};
const unavailable = "Waiting settings unavailable for this registration.";
const unconfirmed =
  "Command outcome unconfirmed; use /config to read current settings. Do not replay the change.";
function seconds(value: number | null) {
  return value === null ? "off" : `${value / 1000} seconds`;
}
function questionTimeout(value: number) {
  return value === 3_600_000 ? "1h" : `${value / 60_000}m`;
}

async function changeQuestions(
  { bot, user, open, beforeWrite }: Context,
  change: Partial<QuestionSettings>,
): Promise<Outcome> {
  if (bot.backend.type !== "opencode" || !bot.backend.agent)
    return { reply: "Question settings unavailable for this registration." };
  const previous = await resolveQuestionSettings(bot);
  const questions = { ...previous, ...change };
  await beforeWrite?.();
  assertOpen(open);
  await saveQuestionSettings(
    bot.backend.directory,
    bot.backend.agent,
    questions,
    AbortSignal.timeout(5000),
  );
  return {
    reply: `questions: ${questions.enabled ? "on" : "off"}; timeout: ${questionTimeout(questions.timeoutMs)}; answer: ${questions.answer}; changed by ${user}.`,
    questions,
  };
}

/** A snapshot mismatch is proven before the shared waiting write. */
class ConfigSnapshotChanged extends Error {}

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
    syntax: "/health [host|agents|stargate|opencode|proxy|services|starfleet]",
    pattern: /^\/health(?: (.*))?$/,
    async run({ options }, match) {
      try {
        return {
          reply:
            (await options.health?.(match[1])) ??
            "⚠ Health: unknown (reader unavailable).",
        };
      } catch {
        return { reply: "⚠ Health: unknown (read failed)." };
      }
    },
  },
  {
    syntax: "/config",
    pattern: /^\/config$/,
    async run({ bot, options }) {
      const page = await mutePage(options);
      const questions = await resolveQuestionSettings(bot);
      return {
        reply: `waiting: ${seconds((await resolveWaiting(bot)).delayMs)}\nquestions: ${questions.enabled ? "on" : "off"}; timeout: ${questionTimeout(questions.timeoutMs)}; answer: ${questions.answer}\nmutes (read-only): ${page ? `${page.counts.channel} channels, ${page.counts.thread} threads` : "unavailable"}\n${help()}`,
      };
    },
  },
  {
    syntax: "/config waiting <0..3600|off>",
    pattern: /^\/config waiting (off|\d+)$/,
    panel: {
      id: "waiting",
      title: "waiting",
      value: (snapshot) => seconds(snapshot.delayMs),
      actions: [
        { id: "waiting_off", label: "Off", command: "/config waiting off" },
        { id: "waiting_3", label: "3s", command: "/config waiting 3" },
        { id: "waiting_10", label: "10s", command: "/config waiting 10" },
      ],
    },
    async run({ bot, user, open, beforeWrite }, match) {
      const value = match[1];
      const count = value === "off" ? null : Number(value);
      if (count !== null && (!Number.isSafeInteger(count) || count > 3600))
        return { reply: help() };
      if (bot.backend.type !== "opencode" || !bot.backend.agent)
        return { reply: unavailable };
      const oldDelayMs = (await resolveWaiting(bot)).delayMs;
      const newDelayMs = count === null ? null : count * 1000;
      await beforeWrite?.();
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
    syntax: "/config questions <on|off>",
    pattern: /^\/config questions (on|off)$/,
    panel: {
      id: "questions",
      title: "questions",
      value: (snapshot) => (snapshot.questions.enabled ? "on" : "off"),
      actions: [
        { id: "questions_on", label: "On", command: "/config questions on" },
        { id: "questions_off", label: "Off", command: "/config questions off" },
      ],
    },
    async run(context, match) {
      return changeQuestions(context, { enabled: match[1] === "on" });
    },
  },
  {
    syntax: "/config questions timeout <5m|15m|1h>",
    pattern: /^\/config questions timeout (5m|15m|1h)$/,
    panel: {
      id: "questions_timeout",
      title: "questions timeout",
      value: (snapshot) => questionTimeout(snapshot.questions.timeoutMs),
      actions: [
        {
          id: "questions_timeout_5m",
          label: "5m",
          command: "/config questions timeout 5m",
        },
        {
          id: "questions_timeout_15m",
          label: "15m",
          command: "/config questions timeout 15m",
        },
        {
          id: "questions_timeout_1h",
          label: "1h",
          command: "/config questions timeout 1h",
        },
      ],
    },
    async run(context, match) {
      return changeQuestions(context, {
        timeoutMs:
          match[1] === "5m" ? 300_000 : match[1] === "1h" ? 3_600_000 : 900_000,
      });
    },
  },
  {
    syntax: "/config questions answer <requester|allowed>",
    pattern: /^\/config questions answer (requester|allowed)$/,
    panel: {
      id: "questions_answer",
      title: "questions answer",
      value: (snapshot) => snapshot.questions.answer,
      actions: [
        {
          id: "questions_answer_requester",
          label: "Requester",
          command: "/config questions answer requester",
        },
        {
          id: "questions_answer_allowed",
          label: "Allowed",
          command: "/config questions answer allowed",
        },
      ],
    },
    async run(context, match) {
      return changeQuestions(context, {
        answer: match[1] === "allowed" ? "allowed" : "requester",
      });
    },
  },
  {
    syntax: "/config mutes",
    pattern: /^\/config mutes$/,
    panel: {
      id: "mutes",
      title: "mutes (read-only)",
      value: (snapshot) => snapshot.mutes,
      actions: [],
    },
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
  {
    syntax: "/config system1 <on|off>",
    pattern: /^\/config system1(?: (.*))?$/,
    panel: {
      id: "system1",
      title: "System One",
      value: () => "not available yet (NET-1709)",
      actions: [
        { id: "system1_on", label: "On", command: "/config system1 on" },
        { id: "system1_off", label: "Off", command: "/config system1 off" },
      ],
    },
    async run(_context, match) {
      return {
        reply:
          match[1] === "on" || match[1] === "off"
            ? "not available yet (NET-1709)"
            : "valid values: on, off",
      };
    },
  },
];
function help(): string {
  return `Valid commands:\n${commands.map((command) => command.syntax).join("\n")}`;
}

export function configPanelRows(): readonly ConfigPanelRow[] {
  return commands.flatMap((command) => (command.panel ? [command.panel] : []));
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

  /** ACK never waits behind a health read, directory lookup or Slack update. */
  async interactive(
    raw: unknown,
    bot: BotConfig,
    identity: Identity,
    open: () => boolean,
    ack: (payload?: Record<string, unknown>) => Promise<void>,
  ): Promise<boolean> {
    if (!configActionCandidate(raw)) return false;
    assertOpen(open);
    await ack();
    const next = this.tail.then(() =>
      this.handleInteractive(raw, bot, identity, open),
    );
    this.tail = next.catch(() => {});
    await next;
    return true;
  }

  private async snapshot(bot: BotConfig) {
    return readConfigSnapshot(bot, await mutePage(this.options));
  }

  private view(panel: ConfigPanelRecord) {
    return buildConfigPanel(configPanelRows(), {
      ...panel,
      snapshot: Schema.decodeUnknownSync(configSnapshotSchema)(
        JSON.parse(panel.snapshot),
      ),
    });
  }

  private async refuse(
    raw: unknown,
    bot: BotConfig,
    identity: Identity,
    open: () => boolean,
    text: string,
  ) {
    assertOpen(open);
    const target = configReplyTarget(raw, bot, identity.team);
    if (
      target &&
      isAllowedChannel(bot, target.channel.id) &&
      target.user.id !== identity.user &&
      target.user.id !== "USLACKBOT"
    ) {
      await this.slack.ephemeral?.(
        target.channel.id,
        target.user.id,
        target.message.thread_ts,
        text,
      );
    }
  }

  private async handleInteractive(
    raw: unknown,
    bot: BotConfig,
    identity: Identity,
    open: () => boolean,
  ) {
    assertOpen(open);
    const reject = (text = configPanelRefused) =>
      this.refuse(raw, bot, identity, open, text);
    const parsed = Schema.decodeUnknownResult(configActionSchema)(raw);
    if (
      Result.isFailure(parsed) ||
      !bot.configPanelEnabled ||
      !this.slack.update
    )
      return reject();
    const body = parsed.success;
    const action = body.actions[0];
    if (
      !action ||
      body.api_app_id !== bot.slack.appId ||
      body.team.id !== identity.team ||
      body.user.id === identity.user ||
      body.user.id === "USLACKBOT" ||
      body.message.user !== identity.user ||
      body.container.channel_id !== body.channel.id ||
      body.container.message_ts !== body.message.ts ||
      !isAllowedUser(bot, body.user.id) ||
      !isAllowedChannel(bot, body.channel.id)
    )
      return reject();
    let human = false;
    try {
      human = (await this.options.isHuman?.(body.user.id)) === true;
    } catch {
      /* Fail closed. */
    }
    assertOpen(open);
    if (!human) return reject();
    const [nonce = "", rawRevision = ""] = action.value.split(":");
    const revision = Number(rawRevision);
    const registration = notificationKey(bot, identity);
    const panel = this.store.configPanel(registration, nonce);
    if (
      !panel ||
      panel.ts !== body.message.ts ||
      panel.channel !== body.channel.id ||
      panel.thread !== body.message.thread_ts
    )
      return reject();
    const at = (this.options.now ?? Date.now)();
    if (panel.createdAt > at || at - panel.createdAt > 86_400_000)
      return reject(configPanelStale);
    const entry = commands.find((command) =>
      command.panel?.actions.some(
        (candidate) =>
          `${configActionPrefix}${candidate.id}` === action.action_id,
      ),
    );
    const choice = entry?.panel?.actions.find(
      (candidate) =>
        `${configActionPrefix}${candidate.id}` === action.action_id,
    );
    if (!entry || !choice) return reject(`Unknown config action. ${help()}`);
    const message = `panel:${nonce}:${revision}:${action.action_ts}`;
    const receipt = this.store.metaReceipt(registration, message);
    if (receipt) {
      if (receipt.user !== body.user.id || receipt.command !== entry.syntax)
        return reject();
      if (receipt.state === "pending") return reject(unconfirmed);
      if (
        receipt.oldDelayMs === null &&
        receipt.newDelayMs === null &&
        entry.panel?.id !== "waiting" &&
        !entry.syntax.startsWith("/config questions ")
      ) {
        return reject(receipt.reply ?? unconfirmed);
      }
      if (
        panel.revision !== revision + 1 ||
        !(await this.matchesSnapshot(bot, panel))
      )
        return reject(configPanelStale);
      assertOpen(open);
      if (!receipt.delivered) await this.updatePanel(panel, open);
      this.store.deliverMeta(registration, message);
      return;
    }
    if (
      panel.revision !== revision ||
      !(await this.matchesSnapshot(bot, panel))
    )
      return reject(configPanelStale);
    if (this.store.pendingConfigPanel(registration, nonce))
      return reject(unconfirmed);
    const match = entry.pattern.exec(choice.command);
    if (!match) return reject();
    assertOpen(open);
    if (
      !this.store.claimMeta({
        registration,
        message,
        channel: panel.channel,
        thread: panel.thread,
        user: body.user.id,
        at,
        command: entry.syntax,
      })
    )
      return reject(unconfirmed);
    let outcome: Outcome;
    let next: ConfigPanelRecord | undefined;
    try {
      outcome = await entry.run(
        {
          bot,
          user: body.user.id,
          options: this.options,
          open,
          beforeWrite: async () => {
            if (!(await this.matchesSnapshot(bot, panel)))
              throw new ConfigSnapshotChanged();
            assertOpen(open);
          },
        },
        match,
      );
      if (
        (outcome.oldDelayMs !== undefined &&
          outcome.newDelayMs !== undefined) ||
        outcome.questions !== undefined
      ) {
        const snapshot = await this.snapshot(bot);
        // A tool can write after our file rename. Retain our outcome, but never
        // attribute that newer value to this actor or repaint it as our change.
        if (outcome.newDelayMs !== undefined)
          snapshot.delayMs = outcome.newDelayMs;
        if (outcome.questions) snapshot.questions = outcome.questions;
        next = {
          ...panel,
          revision: revision + 1,
          snapshot: JSON.stringify(snapshot),
          user: body.user.id,
          at,
        };
        this.store.applyConfigPanel(
          next,
          message,
          outcome.reply,
          outcome.oldDelayMs ?? null,
          outcome.newDelayMs ?? null,
        );
      } else this.store.applyMeta(registration, message, outcome.reply);
    } catch (error) {
      if (
        error instanceof MetaAdmissionChanged ||
        error instanceof ConfigSnapshotChanged
      ) {
        this.store.releaseMetaClaim(registration, message);
        if (error instanceof MetaAdmissionChanged) throw error;
        return reject(configPanelStale);
      }
      // The file may have changed; retain pending and never write on a retry.
      return reject(unconfirmed);
    }
    assertOpen(open);
    if (next) {
      if (!(await this.matchesSnapshot(bot, next)))
        return reject(configPanelStale);
      await this.updatePanel(next, open);
    } else await reject(outcome.reply);
    this.store.deliverMeta(registration, message);
  }

  private async matchesSnapshot(
    bot: BotConfig,
    panel: ConfigPanelRecord,
  ): Promise<boolean> {
    try {
      return sameConfigSnapshot(
        Schema.decodeUnknownSync(configSnapshotSchema)(
          JSON.parse(panel.snapshot),
        ),
        await this.snapshot(bot),
      );
    } catch {
      return false;
    }
  }

  private async updatePanel(panel: ConfigPanelRecord, open: () => boolean) {
    assertOpen(open);
    if (!panel.ts || !this.slack.update)
      throw new Error(configPanelUnavailable);
    const content = this.view(panel);
    const updated = await this.slack.update(
      panel.channel,
      panel.ts,
      content.text,
      undefined,
      content,
    );
    if (updated === false) throw new Error(configPanelUnavailable);
  }

  private async handle(
    raw: unknown,
    bot: BotConfig,
    identity: Identity,
    open: () => boolean,
  ) {
    const parsed = Schema.decodeUnknownResult(envelope)(raw);
    if (Result.isFailure(parsed)) return;
    assertOpen(open);
    const body = parsed.success;
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
    let publishPanel = false;
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
        if (
          commandText === "/config" &&
          bot.configPanelEnabled &&
          this.slack.update
        ) {
          const snapshot = await this.snapshot(bot);
          assertOpen(open);
          const panel: ConfigPanelRecord = {
            nonce: randomUUID(),
            registration,
            message,
            channel: event.channel,
            thread: event.thread_ts ?? event.ts,
            ts: null,
            createdAt: at,
            revision: 0,
            snapshot: JSON.stringify(snapshot),
            user: event.user,
            at,
          };
          this.store.createConfigPanel(panel);
          outcome = { reply: this.view(panel).text };
          publishPanel = true;
        }
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
    const panel = this.store.configPanelForMessage(registration, message);
    if (panel) {
      if (!bot.configPanelEnabled || !this.slack.update) return;
      if (!panel.ts) {
        // Never republish after a crash/ambiguous post. No unbound controls exist.
        if (!publishPanel) return;
        const ts = await this.slack.post(
          panel.channel,
          panel.thread,
          `${receipt.reply ?? configPanelUnavailable}\n${configPanelUnavailable}`,
          undefined,
          { allowed: open },
        );
        if (typeof ts !== "string" || !/^\d{1,16}\.\d{1,6}$/.test(ts)) {
          this.store.deliverMeta(registration, message);
          return;
        }
        this.store.bindConfigPanel(registration, panel.nonce, ts);
        panel.ts = ts;
      }
      assertOpen(open);
      if (!(await this.matchesSnapshot(bot, panel))) {
        assertOpen(open);
        await this.slack.update(panel.channel, panel.ts, configPanelStale);
      } else await this.updatePanel(panel, open);
      this.store.deliverMeta(registration, message);
      return;
    }
    await this.slack.post(
      receipt.channel,
      receipt.thread,
      receipt.reply ?? unconfirmed,
    );
    this.store.deliverMeta(registration, message);
  }
}
