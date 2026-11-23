import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Predicate, Result, Schema } from "effect";
import { OpenCodeBackend } from "../backends/opencode/opencode";
import { botToken, botWebClient } from "../transports/slack/bot-web";
import { type BotConfig, loadConfig } from "../config";
import { type CronAdvanced, cronAdvancedOptions } from "./advanced";
import { CronStore } from "./store";
import { cronChannel, cronUser } from "./config";
import { cronjobNameSchema } from "./job-files";
import { CronjobManager, cronRuntimeBinding } from "./job-manager";
import {
  type Identity,
  isAllowedChannel,
  isAllowedUser,
} from "../shared/registration";
import {
  settingsDefault,
  settingsDiscriminatedUnion,
  settingsStruct,
  settingsUUID,
} from "../config/settings-schema";

const destination = {
  channel: Schema.optional(cronChannel),
  user: Schema.optional(cronUser),
};

/** The operation branches, in the order and with the fields of the tool. */
export const cronOperationBranches = Schema.Union([
  settingsStruct({
    op: Schema.Literal("list"),
    ...destination,
    page: Schema.Int.check(
      Schema.isBetween({ minimum: 0, maximum: 1000 }),
    ).pipe(settingsDefault(0)),
  }),
  settingsStruct({
    op: Schema.Literal("add"),
    ...destination,
    name: cronjobNameSchema,
    description: Schema.Trim.check(
      Schema.isMinCodePoints(1),
      Schema.isMaxCodePoints(1000),
    ),
    schedule: Schema.optional(Schema.String.check(Schema.isMaxCodePoints(100))),
    ...cronAdvancedOptions,
    timezone: Schema.String.check(Schema.isMaxCodePoints(100)).pipe(
      settingsDefault("UTC"),
    ),
    prompt: Schema.String.check(
      Schema.isMinCodePoints(1),
      Schema.isMaxCodePoints(12_000),
    ),
    skills: Schema.mutable(Schema.Array(cronjobNameSchema))
      .check(Schema.isMaxLength(100))
      .pipe(settingsDefault([])),
    enabled: Schema.Boolean.pipe(settingsDefault(true)),
    report: Schema.Literals(["immediate", "daily"]).pipe(
      settingsDefault("immediate"),
    ),
  }),
  settingsStruct({
    op: Schema.Literal("run"),
    ...destination,
    name: Schema.String.check(
      Schema.isMinCodePoints(1),
      Schema.isMaxCodePoints(80),
    ),
    requestId: Schema.optional(
      Schema.String.check(
        Schema.isMinCodePoints(1),
        Schema.isMaxCodePoints(255),
      ),
    ),
  }),
  settingsStruct({
    op: Schema.Literal("remove"),
    ...destination,
    id: settingsUUID,
  }),
  settingsStruct({ op: Schema.Literal("report") }),
]);

// A discriminator that is not a property key is refused before the union
// Converts it to a string.
const operationKey = Schema.makeFilter<unknown>((value) =>
  Predicate.isObject(value) && !Predicate.isPropertyKey(value["op"])
    ? { path: ["op"], issue: "Invalid input" }
    : undefined,
);

export const cronOperationSchema = Schema.Unknown.check(operationKey).pipe(
  Schema.decodeTo(
    settingsDiscriminatedUnion("op", cronOperationBranches.members),
  ),
);

export class CronControlError extends Error {}

type Binding = { configPath: string; bot: string; expectedDirectory?: string };

type Dependencies = {
  identity(
    bot: BotConfig,
    configPath: string,
    signal: AbortSignal,
  ): Promise<Identity>;
  now(): number;
  model?(
    bot: BotConfig,
    dataDirectory: string,
    input: Pick<CronAdvanced, "model" | "arbiter">,
    signal: AbortSignal,
  ): Promise<{ model: string }>;
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
  const parsed = Schema.decodeUnknownResult(cronOperationSchema)(raw);

  if (Result.isFailure(parsed))
    throw new CronControlError("Invalid cronjob operation.");
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
    const storePath = join(config.dataDirectory, "cron.sqlite");

    if (parsed.success.op !== "add") {
      const existing = await lstat(storePath).catch(() => {});

      if (!existing?.isFile() || existing.isSymbolicLink())
        throw new CronControlError(
          "Cron state is unavailable at this configuration's data directory; inspect the gateway configuration before retrying.",
        );
    }

    const store = new CronStore(storePath);

    try {
      const binding = cronRuntimeBinding(bot, identity);

      try {
        store.assertRuntimeBinding(
          binding.registration,
          binding.signature,
          binding.key,
        );
      } catch {
        throw new CronControlError(
          "Cron gateway configuration differs; restart the gateway before managing jobs.",
        );
      }

      const model = async (
        input: Pick<CronAdvanced, "model" | "arbiter">,
        current: AbortSignal,
      ) => {
        if (dependencies.model)
          return dependencies.model(bot, config.dataDirectory, input, current);

        if (bot.backend.type !== "opencode")
          throw new CronControlError(
            "This backend cannot validate cron models.",
          );
        const backend = new OpenCodeBackend(bot.backend);

        try {
          if (typeof backend.cronModel !== "function")
            throw new CronControlError(
              "This backend cannot validate cron models.",
            );

          return await backend.cronModel(input, current);
        } finally {
          await backend.close();
        }
      };

      const manager = new CronjobManager(bot, identity, store, model);
      const now = dependencies.now();
      const errors = await manager.sync(now, signal);
      signal.throwIfAborted();
      const input = parsed.success;

      if (input.op === "report")
        return {
          jobs: store
            .report(manager.key)
            .map((job) => ({ ...job, model: job.model ?? "captain" })),
          definitionErrors: errors,
        };

      if (input.op === "list") {
        if (
          (input.channel !== undefined &&
            !isAllowedChannel(bot, input.channel)) ||
          (input.user !== undefined &&
            (input.user === identity.user || !isAllowedUser(bot, input.user)))
        )
          throw new CronControlError("Cronjob user or channel is not allowed.");

        const filter = {
          botKey: manager.key,
          channel: input.channel,
          user: input.user,
        };

        return {
          jobs: store.listDestinations(filter, input.page).map((job) => {
            const { prompt, ...metadata } = job;

            return {
              ...metadata,
              model: job.model ?? "captain",
              ...(input.channel !== undefined &&
                input.user !== undefined &&
                manager.allowed(job) && { prompt }),
            };
          }),
          filter: { channel: input.channel ?? null, user: input.user ?? null },
          page: input.page,
          definitionErrors: errors,
        };
      }

      if (input.op === "remove") {
        const job = store.findDestination(manager.key, input.id);

        if (
          !job ||
          (input.channel !== undefined && input.channel !== job.channel) ||
          (input.user !== undefined && input.user !== job.user)
        )
          return { removed: false };

        // Removing an existing task grants no new access or execution. Retain
        // Bot ownership even when its former destination is no longer allowed.
        return {
          removed: store.remove(
            { botKey: job.botKey, channel: job.channel, user: job.user },
            input.id,
          ),
        };
      }

      const scope = {
        botKey: manager.key,
        user: input.user ?? bot.cronjobs.user,
        channel: input.channel ?? bot.cronjobs.channel,
      };

      if (!manager.allowed(scope))
        throw new CronControlError("Cronjob user or channel is not allowed.");

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
          expression: input.schedule ?? "",
          timezone: input.timezone,
          prompt: input.prompt,
          report: input.report,
          trigger: input.trigger,
          model: input.model,
          once: input.once,
          arbiter: input.arbiter,
        },
        now,
        undefined,
        input,
        signal,
      );

      return {
        job: { ...schedule, model: schedule.model ?? "captain" },
        effect: input.enabled
          ? "recurring-execution-authorized"
          : "schedule-paused-manual-run-available",
        ...(input.report === "daily" &&
          !bot.cronjobs.dailyReport && {
            warning: "Daily reporting is not configured; results remain local.",
          }),
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
