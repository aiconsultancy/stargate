import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { Result, Schema } from "effect";
import type { BotConfig } from "./config";
import type { NotificationPage } from "./notification-store";
import {
  decodeQuestionSettings,
  type QuestionSettings,
  questionSettingsPath,
  resolveQuestionSettings,
} from "./question-settings";
import {
  settingsPattern,
  settingsStartsWith,
  settingsStruct,
} from "./settings-schema";
import type { SlackPanelContent } from "./slack-format";
import { resolveWaiting, waitingSettingsPath } from "./waiting";

export const configActionPrefix = "stargate_config_";
export const configPanelStale =
  "This config panel is stale; run /config again.";
export const configPanelRefused =
  "Config action refused; run /config in an allowed channel.";
export const configPanelUnavailable =
  "Config panel unavailable; use the typed /config commands.";

export const configSnapshotSchema = settingsStruct({
  delayMs: Schema.NullOr(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3_600_000 })),
  ),
  waitingFingerprint: Schema.String,
  // Validate with the settings owner, but retain the original object and order.
  questions: Schema.declare<QuestionSettings>(
    (value): value is QuestionSettings => {
      try {
        decodeQuestionSettings(value);
        return true;
      } catch {
        return false;
      }
    },
  ),
  questionsFingerprint: Schema.String,
  mutes: Schema.String,
  mutesFingerprint: Schema.String,
});
export type ConfigPanelSnapshot = typeof configSnapshotSchema.Type;
export type ConfigPanelRow = {
  id: string;
  title: string;
  value(snapshot: ConfigPanelSnapshot): string;
  actions: readonly { id: string; label: string; command: string }[];
};
export type ConfigPanelView = {
  nonce: string;
  revision: number;
  snapshot: ConfigPanelSnapshot;
  user: string;
  at: number;
};

/** Rows come from the meta-command table, including their fixed action mapping. */
export function buildConfigPanel(
  rows: readonly ConfigPanelRow[],
  panel: ConfigPanelView,
): SlackPanelContent {
  const audit = `Updated by ${panel.user} at ${new Date(panel.at).toISOString()}.`;
  const lines = rows.map((row) => `${row.title}: ${row.value(panel.snapshot)}`);
  const blocks: SlackPanelContent["blocks"] = [];
  for (const [index, row] of rows.entries()) {
    const block = `${panel.nonce}:${panel.revision}:${row.id}`;
    blocks.push({
      type: "section",
      block_id: `${block}:status`,
      text: {
        type: "plain_text",
        text: `${lines[index]}${index === rows.length - 1 ? `\n${audit}` : ""}`,
        emoji: false,
      },
    });
    if (row.actions.length) {
      blocks.push({
        type: "actions",
        block_id: `${block}:actions`,
        elements: row.actions.map((action) => ({
          type: "button",
          action_id: `${configActionPrefix}${action.id}`,
          value: `${panel.nonce}:${panel.revision}`,
          text: { type: "plain_text", text: action.label, emoji: false },
          accessibility_label: `${row.title}: ${action.label}`,
        })),
      });
    }
  }
  return { text: `${lines.join("\n")}\n${audit}`, blocks };
}

function hash(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

/** Stat identity detects same-value writes, including atomic replacement/ABA. */
async function settingsFingerprint(
  bot: BotConfig,
  settingsPath: (directory: string, agent: string) => string,
): Promise<string> {
  if (bot.backend.type !== "opencode" || !bot.backend.agent)
    return "unsupported";
  const path = settingsPath(bot.backend.directory, bot.backend.agent);
  try {
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size > 4096n)
        throw new Error(configPanelUnavailable);
      const bytes = Buffer.alloc(4097);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 4096) throw new Error(configPanelUnavailable);
      const after = await file.stat({ bigint: true });
      const current = await lstat(path, { bigint: true });
      const identity = (info: typeof before) =>
        `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      if (
        identity(before) !== identity(after) ||
        identity(after) !== identity(current)
      )
        throw new Error(configPanelStale);
      return hash(`${identity(after)}:${hash(bytes.subarray(0, bytesRead))}`);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (
      Result.isSuccess(
        Schema.decodeUnknownResult(
          Schema.Struct({ code: Schema.Literal("ENOENT") }),
        )(error),
      )
    )
      return "absent";
    throw error;
  }
}

export async function readConfigSnapshot(
  bot: BotConfig,
  page: NotificationPage | undefined,
): Promise<ConfigPanelSnapshot> {
  const before = await settingsFingerprint(bot, waitingSettingsPath);
  const questionsBefore = await settingsFingerprint(bot, questionSettingsPath);
  const waiting = await resolveWaiting(bot);
  const questions = await resolveQuestionSettings(bot);
  const after = await settingsFingerprint(bot, waitingSettingsPath);
  const questionsAfter = await settingsFingerprint(bot, questionSettingsPath);
  if (before !== after || questionsBefore !== questionsAfter)
    throw new Error(configPanelStale);
  // Only the current registration's safe status projection is retained, not reasons.
  const mutes = page
    ? `${page.counts.channel} channels, ${page.counts.thread} threads`
    : "unavailable";
  const safePage = page
    ? {
        counts: page.counts,
        cursor: page.cursor,
        settings: page.settings.map(({ target, setting }) => ({
          target,
          state: setting.state,
          mute_until: setting.mute_until,
        })),
      }
    : null;
  return {
    delayMs: waiting.delayMs,
    waitingFingerprint: after,
    questions,
    questionsFingerprint: questionsAfter,
    mutes,
    mutesFingerprint: hash(JSON.stringify(safePage)),
  };
}

export function sameConfigSnapshot(
  left: ConfigPanelSnapshot,
  right: ConfigPanelSnapshot,
) {
  return (
    left.delayMs === right.delayMs &&
    left.waitingFingerprint === right.waitingFingerprint &&
    left.questions.enabled === right.questions.enabled &&
    left.questions.timeoutMs === right.questions.timeoutMs &&
    left.questions.answer === right.questions.answer &&
    left.questionsFingerprint === right.questionsFingerprint &&
    left.mutesFingerprint === right.mutesFingerprint
  );
}

const timestamp = Schema.String.check(settingsPattern(/^\d{1,16}\.\d{1,6}$/));
export const configActionSchema = Schema.Struct({
  type: Schema.Literal("block_actions"),
  api_app_id: Schema.String,
  team: Schema.Struct({ id: Schema.String }),
  user: Schema.Struct({
    id: Schema.String.check(settingsPattern(/^[UW][A-Z0-9]+$/)),
    is_bot: Schema.optional(Schema.Literal(false)),
    bot_id: Schema.optional(Schema.Never),
  }),
  bot_id: Schema.optional(Schema.Never),
  channel: Schema.Struct({
    id: Schema.String.check(settingsPattern(/^[CGD][A-Z0-9]+$/)),
  }),
  container: Schema.Struct({
    type: Schema.Literal("message"),
    channel_id: Schema.String,
    message_ts: timestamp,
    is_ephemeral: Schema.optional(Schema.Literal(false)),
  }),
  message: Schema.Struct({
    user: Schema.String,
    ts: timestamp,
    thread_ts: timestamp,
  }),
  actions: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        type: Schema.Literal("button"),
        action_id: Schema.String.check(
          Schema.isMaxCodePoints(255),
          settingsStartsWith(configActionPrefix),
        ),
        value: Schema.String.check(
          settingsPattern(/^[a-f0-9-]{36}:(?:0|[1-9]\d{0,8})$/),
        ),
        action_ts: timestamp,
      }),
    ),
  ).check(Schema.isBetweenLength(1, 1)),
});

/** Only this namespace is consumed, even if its remaining payload is malformed. */
export function configActionCandidate(raw: unknown): boolean {
  const parsed = Schema.decodeUnknownResult(
    Schema.Struct({ actions: Schema.mutable(Schema.Array(Schema.Unknown)) }),
  )(raw);
  return (
    Result.isSuccess(parsed) &&
    parsed.success.actions.some((entry) => {
      const action = Schema.decodeUnknownResult(
        Schema.Struct({ action_id: Schema.String }),
      )(entry);
      return (
        Result.isSuccess(action) &&
        action.success.action_id.startsWith(configActionPrefix)
      );
    })
  );
}

/** An ephemeral refusal must not turn untrusted routing fields into a sender. */
export function configReplyTarget(raw: unknown, bot: BotConfig, team: string) {
  const parsed = Schema.decodeUnknownResult(
    Schema.Struct({
      api_app_id: Schema.Literal(bot.slack.appId),
      team: Schema.Struct({ id: Schema.Literal(team) }),
      channel: Schema.Struct({
        id: Schema.String.check(settingsPattern(/^[CGD][A-Z0-9]+$/)),
      }),
      user: Schema.Struct({
        id: Schema.String.check(settingsPattern(/^[UW][A-Z0-9]+$/)),
      }),
      message: Schema.Struct({ thread_ts: timestamp }),
    }),
  )(raw);
  return Result.isSuccess(parsed) ? parsed.success : undefined;
}
