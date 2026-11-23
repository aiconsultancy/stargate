import { join } from "node:path";
import type { BotConfig } from "../config";
import { type CronAdvanced, usesAdvancedCron } from "./advanced";
import { type CronInput, validateCronInput } from "./input";
import type { CronScope, CronStore } from "./store";
import {
  type CronjobDefinition,
  listCronjobNames,
  readCronjob,
  writeCronjob,
} from "./job-files";
import {
  type Identity,
  botKey,
  isAllowedChannel,
  isAllowedUser,
} from "../shared/registration";

export type CronModelResolver = (
  input: Pick<CronAdvanced, "model" | "arbiter">,
  signal: AbortSignal,
) => Promise<{ model: string }>;

export function cronRuntimeBinding(config: BotConfig, identity: Identity) {
  const key = botKey(config, identity);

  return {
    key,
    registration: JSON.stringify([
      config.id,
      config.slack.appId,
      identity.team,
      identity.user,
    ]),
    signature: JSON.stringify([key, config.cronjobs ?? null]),
  };
}

export function cronjobPrompt(definition: CronjobDefinition, path: string) {
  const skills = definition.skills.length
    ? `Required agent skills: ${definition.skills.join(", ")}. Load these skills before doing the task; if unavailable, report the gap rather than inventing their instructions.\n`
    : "";

  return `Cronjob: ${definition.name}\nDefinition: ${JSON.stringify(path)}\nSupporting files resolve relative to its directory. The accepted task body is below; do not substitute a newer definition for this run.\n${skills}Reporting: ${definition.report === "daily" ? "deferred to the daily Slack digest; do not post to Slack yourself" : "Stargate delivers the final answer to Slack"}. Return a concise verified result, failures and deferred work; never credentials, tool transcripts or private reasoning.\n\n${definition.prompt}`;
}

/** Files define tasks; SQLite owns admission, retries and execution state. */
export class CronjobManager {
  public readonly key: string;
  public constructor(
    public readonly config: BotConfig,
    public readonly identity: Identity,
    public readonly store: CronStore,
    private readonly resolveModel?: CronModelResolver,
  ) {
    this.key = botKey(config, identity);
  }

  public allowed(scope: CronScope) {
    return (
      scope.botKey === this.key &&
      scope.user !== this.identity.user &&
      isAllowedUser(this.config, scope.user) &&
      isAllowedChannel(this.config, scope.channel)
    );
  }

  private async validateAdvanced(input: CronAdvanced, signal: AbortSignal) {
    if (usesAdvancedCron(input) && !this.config.cronjobs?.advanced)
      throw new Error("Advanced cron jobs are disabled.");

    if (input.model !== undefined || input.arbiter !== undefined) {
      if (!this.resolveModel)
        throw new Error("Cron model validation is unavailable.");

      return this.resolveModel(input, signal);
    }

    return undefined;
  }

  public async sync(now: number, signal = new AbortController().signal) {
    const settings = this.config.cronjobs;

    if (!settings) return [];
    const available: string[] = [];
    const errors: string[] = [];

    try {
      for (const name of await listCronjobNames(settings.directory)) {
        try {
          const definition = await readCronjob(settings.directory, name, now);

          const scope = {
            botKey: this.key,
            ...(definition.slack ?? {
              channel: settings.channel,
              user: settings.user,
            }),
          };

          if (!this.allowed(scope)) throw new Error("Cronjob access denied.");
          const source = join(settings.directory, name, "CRONJOB.md");

          const { input } = validateCronInput(
            {
              name,
              expression: definition.schedule ?? "",
              timezone: definition.timezone,
              prompt: cronjobPrompt(definition, source),
              report: definition.report,
              trigger: definition.trigger,
              model: definition.model,
              once: definition.once,
              arbiter: definition.arbiter,
            },
            now,
          );

          await this.validateAdvanced(input, signal);
          signal.throwIfAborted();
          this.store.upsertFile(scope, input, source, !definition.enabled, now);
          available.push(source);
        } catch {
          signal.throwIfAborted();
          errors.push(name);
        }
      }
    } catch {
      signal.throwIfAborted();
      errors.push("cronjobs-directory");
    }

    signal.throwIfAborted();
    this.store.fileAvailability(this.key, available);

    return errors;
  }

  public async add(
    scope: CronScope,
    raw: CronInput,
    now: number,
    requestId?: string,
    details: {
      description?: string;
      skills?: string[];
      enabled?: boolean;
    } = {},
    signal = new AbortController().signal,
  ) {
    if (!this.allowed(scope)) throw new Error("Cronjob access denied.");
    const { input } = validateCronInput(raw, now);
    await this.validateAdvanced(input, signal);
    signal.throwIfAborted();
    const settings = this.config.cronjobs;

    if (!settings) return this.store.add(scope, input, now, requestId);

    const definition: CronjobDefinition = {
      name: input.name,
      description: details.description ?? input.name,
      ...(input.expression ? { schedule: input.expression } : {}),
      timezone: input.timezone,
      prompt: input.prompt,
      report: input.report ?? "immediate",
      skills: details.skills ?? [],
      enabled: details.enabled ?? true,
      slack: { channel: scope.channel, user: scope.user },
      trigger: input.trigger,
      model: input.model,
      once: input.once,
      arbiter: input.arbiter,
    };

    const source = join(settings.directory, definition.name, "CRONJOB.md");

    const compiled = validateCronInput(
      { ...input, prompt: cronjobPrompt(definition, source) },
      now,
    ).input;

    await writeCronjob(settings.directory, definition, now);

    const schedule = this.store.upsertFile(
      scope,
      compiled,
      source,
      !definition.enabled,
      now,
    );

    if (!this.store.enabled(schedule.id, true))
      throw new Error("Cronjob was removed; use a new name.");

    return schedule;
  }
}
