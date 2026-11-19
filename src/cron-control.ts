import { join, resolve } from "node:path";
import { z } from "zod";
import { botToken, botWebClient } from "./bot-web";
import { type BotConfig, loadConfig } from "./config";
import { CronStore } from "./cron-store";
import { cronChannel, cronUser } from "./cronjob-config";
import { cronjobNameSchema } from "./cronjob-files";
import { CronjobManager } from "./cronjob-manager";
import type { Identity } from "./routing";
import { legacySetting } from "./settings-legacy";

const destination = {
  channel: legacySetting(cronChannel).optional(),
  user: legacySetting(cronUser).optional(),
};
export const cronOperationSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("list"),
    ...destination,
    page: z.number().int().min(0).max(1000).default(0),
  }),
  z.strictObject({
    op: z.literal("add"),
    ...destination,
    name: cronjobNameSchema,
    description: z.string().trim().min(1).max(1000),
    schedule: z.string().max(100),
    timezone: z.string().max(100).default("UTC"),
    prompt: z.string().min(1).max(12000),
    skills: z.array(cronjobNameSchema).max(100).default([]),
    enabled: z.boolean().default(true),
    report: z.enum(["immediate", "daily"]).default("immediate"),
  }),
  z.strictObject({
    op: z.literal("run"),
    ...destination,
    name: z.string().min(1).max(80),
    requestId: z.string().min(1).max(255).optional(),
  }),
  z.strictObject({ op: z.literal("remove"), ...destination, id: z.uuid() }),
  z.strictObject({ op: z.literal("report") }),
]);
export class CronControlError extends Error {}

type Binding = { configPath: string; bot: string; expectedDirectory?: string };
type Dependencies = {
  identity(
    bot: BotConfig,
    configPath: string,
    signal: AbortSignal,
  ): Promise<Identity>;
  now(): number;
};

const defaults: Dependencies = {
  now: Date.now,
  async identity(bot, configPath, signal) {
    const web = botWebClient(await botToken(bot, configPath), signal);
    const auth = await web.auth.test();
    if (!auth.bot_id || !auth.team_id || !auth.user_id)
      throw new Error("Workspace bot required.");
    return { team: auth.team_id, user: auth.user_id };
  },
};

/** Supported local operator interface; agents never access runtime SQL directly. */
export async function runCronOperation(
  raw: unknown,
  binding: Binding,
  signal: AbortSignal,
  dependencies: Dependencies = defaults,
): Promise<unknown> {
  const parsed = cronOperationSchema.safeParse(raw);
  if (!parsed.success) throw new CronControlError("Invalid cronjob operation.");
  signal.throwIfAborted();
  try {
    const config = await loadConfig(binding.configPath);
    const bot = config.bots.find((bot) => bot.id === binding.bot);
    if (!bot?.cronjobs)
      throw new CronControlError(
        "Configure this bot's cronjobs directory and Slack destination first.",
      );
    if (
      binding.expectedDirectory &&
      (bot.backend.type !== "opencode" ||
        resolve(bot.backend.directory) !== resolve(binding.expectedDirectory))
    ) {
      throw new CronControlError(
        "Cronjob binding does not match this captain workspace.",
      );
    }
    const identity = await dependencies.identity(
      bot,
      binding.configPath,
      signal,
    );
    signal.throwIfAborted();
    const store = new CronStore(join(config.dataDirectory, "cron.sqlite"));
    try {
      const manager = new CronjobManager(bot, identity, store);
      const now = dependencies.now();
      const errors = await manager.sync(now);
      signal.throwIfAborted();
      const input = parsed.data;
      if (input.op === "report")
        return { jobs: store.report(manager.key), definitionErrors: errors };
      const scope = {
        botKey: manager.key,
        user: input.user ?? bot.cronjobs.user,
        channel: input.channel ?? bot.cronjobs.channel,
      };
      if (!manager.allowed(scope))
        throw new CronControlError("Cronjob user or channel is not allowed.");
      if (input.op === "list")
        return {
          jobs: store.list(scope, input.page),
          page: input.page,
          definitionErrors: errors,
        };
      if (input.op === "remove")
        return { removed: store.remove(scope, input.id) };
      if (input.op === "run") {
        const run = store.runNow(scope, input.name, now, input.requestId);
        return run
          ? {
              runId: run.id,
              status: run.status,
              delivery: run.report,
              effect: "durably-admitted-not-completed",
            }
          : { status: "busy", effect: "no-overlap-no-new-run" };
      }
      const schedule = await manager.add(
        scope,
        {
          name: input.name,
          expression: input.schedule,
          timezone: input.timezone,
          prompt: input.prompt,
          report: input.report,
        },
        now,
        undefined,
        input,
      );
      return {
        job: schedule,
        effect: input.enabled
          ? "recurring-execution-authorized"
          : "schedule-paused-manual-run-available",
        ...(input.report === "daily" && !bot.cronjobs.dailyReport
          ? {
              warning:
                "Daily reporting is not configured; results remain local.",
            }
          : {}),
      };
    } finally {
      store.close();
    }
  } catch (error) {
    if (error instanceof CronControlError) throw error;
    throw new CronControlError(
      "Cronjob operation unconfirmed; check definition, ownership, configuration and access before retrying.",
    );
  }
}
