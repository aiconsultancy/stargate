import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { z } from "zod";
import type { BotConfig } from "./config";
import type { NotificationPage } from "./notification-store";
import {
  decodeQuestionSettings,
  type QuestionSettings,
  questionSettingsPath,
  resolveQuestionSettings,
} from "./question-settings";
import type { SlackPanelContent } from "./slack-format";
import { resolveWaiting, waitingSettingsPath } from "./waiting";

export const configActionPrefix = "stargate_config_";
export const configPanelStale =
  "This config panel is stale; run /config again.";
export const configPanelRefused =
  "Config action refused; run /config in an allowed channel.";
export const configPanelUnavailable =
  "Config panel unavailable; use the typed /config commands.";

export const configSnapshotSchema = z.strictObject({
  delayMs: z.number().int().min(0).max(3_600_000).nullable(),
  waitingFingerprint: z.string(),
  // Existing panel boundary remains Zod until its component migration.
  questions: z.custom<QuestionSettings>((value) => {
    try {
      decodeQuestionSettings(value);
      return true;
    } catch {
      return false;
    }
  }),
  questionsFingerprint: z.string(),
  mutes: z.string(),
  mutesFingerprint: z.string(),
});
export type ConfigPanelSnapshot = z.infer<typeof configSnapshotSchema>;
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
    if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success)
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

const timestamp = z.string().regex(/^\d{1,16}\.\d{1,6}$/);
export const configActionSchema = z.object({
  type: z.literal("block_actions"),
  api_app_id: z.string(),
  team: z.object({ id: z.string() }),
  user: z.object({
    id: z.string().regex(/^[UW][A-Z0-9]+$/),
    is_bot: z.literal(false).optional(),
    bot_id: z.never().optional(),
  }),
  bot_id: z.never().optional(),
  channel: z.object({ id: z.string().regex(/^[CGD][A-Z0-9]+$/) }),
  container: z.object({
    type: z.literal("message"),
    channel_id: z.string(),
    message_ts: timestamp,
    is_ephemeral: z.literal(false).optional(),
  }),
  message: z.object({ user: z.string(), ts: timestamp, thread_ts: timestamp }),
  actions: z
    .array(
      z.object({
        type: z.literal("button"),
        action_id: z.string().max(255).startsWith(configActionPrefix),
        value: z.string().regex(/^[a-f0-9-]{36}:(?:0|[1-9]\d{0,8})$/),
        action_ts: timestamp,
      }),
    )
    .length(1),
});

/** Only this namespace is consumed, even if its remaining payload is malformed. */
export function configActionCandidate(raw: unknown): boolean {
  const parsed = z.object({ actions: z.array(z.unknown()) }).safeParse(raw);
  return (
    parsed.success &&
    parsed.data.actions.some((entry) => {
      const action = z.object({ action_id: z.string() }).safeParse(entry);
      return (
        action.success && action.data.action_id.startsWith(configActionPrefix)
      );
    })
  );
}

/** An ephemeral refusal must not turn untrusted routing fields into a sender. */
export function configReplyTarget(raw: unknown, bot: BotConfig, team: string) {
  const parsed = z
    .object({
      api_app_id: z.literal(bot.slack.appId),
      team: z.object({ id: z.literal(team) }),
      channel: z.object({ id: z.string().regex(/^[CGD][A-Z0-9]+$/) }),
      user: z.object({ id: z.string().regex(/^[UW][A-Z0-9]+$/) }),
      message: z.object({ thread_ts: timestamp }),
    })
    .safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
