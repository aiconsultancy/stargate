import { join, resolve } from "node:path";
import { botToken, botWebClient } from "./bot-web";
import { type BotConfig, loadConfig } from "./config";
import {
  NotificationStore,
  notificationInputSchema,
} from "./notification-store";
import { notificationKey } from "./notifications";
import { type Identity, isAllowedChannel } from "./routing";

export class NotificationControlError extends Error {}

type Binding = {
  configPath: string;
  bot: string;
  expectedDirectory: string;
  captainSessionID: string;
  operationID?: string | undefined;
};
export type NotificationDependencies = {
  loadConfig: typeof loadConfig;
  identity(
    bot: BotConfig,
    configPath: string,
    signal: AbortSignal,
  ): Promise<Identity>;
  now(): number;
};
const defaults: NotificationDependencies = {
  loadConfig,
  now: Date.now,
  async identity(bot, configPath, signal) {
    const web = botWebClient(await botToken(bot, configPath), signal);
    const auth = await web.auth.test();
    if (!auth.bot_id || !auth.team_id || !auth.user_id)
      throw new Error("Workspace bot required.");
    return { team: auth.team_id, user: auth.user_id };
  },
};

/** The bound captain controls only its own dedicated preference store. */
export async function runNotificationOperation(
  raw: unknown,
  binding: Binding,
  signal: AbortSignal,
  dependencies: NotificationDependencies = defaults,
): Promise<unknown> {
  const parsed = notificationInputSchema.safeParse(raw);
  if (!parsed.success)
    throw new NotificationControlError(
      "Invalid notification operation; use explicit C/G targets.",
    );
  signal.throwIfAborted();
  try {
    const config = await dependencies.loadConfig(binding.configPath);
    const bot = config.bots.find((entry) => entry.id === binding.bot);
    if (
      bot?.backend.type !== "opencode" ||
      bot.backend.sessionID !== binding.captainSessionID ||
      resolve(bot.backend.directory) !== resolve(binding.expectedDirectory)
    )
      throw new NotificationControlError(
        "Notification binding does not match this pinned Slack captain.",
      );
    const input = parsed.data;
    if ("channel" in input && !isAllowedChannel(bot, input.channel))
      throw new NotificationControlError(
        "Notification target channel is not allowed for this bot.",
      );
    if (
      ["mute", "unmute", "clear_all"].includes(input.op) &&
      !binding.operationID
    )
      throw new NotificationControlError(
        "Notification changes require a stable host tool-call identity.",
      );
    const identity = await dependencies.identity(
      bot,
      binding.configPath,
      signal,
    );
    signal.throwIfAborted();
    const store = new NotificationStore(
      join(config.dataDirectory, "notifications.sqlite"),
    );
    try {
      return store.operate(notificationKey(bot, identity), input, {
        id: binding.operationID ?? "read",
        caller: binding.captainSessionID,
        now: dependencies.now,
      });
    } finally {
      store.close();
    }
  } catch (error) {
    if (error instanceof NotificationControlError) throw error;
    throw new NotificationControlError(
      "Notification operation unconfirmed; no success is claimed. Retry the same host operation after checking private store access.",
    );
  }
}
