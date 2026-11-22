import type { ViewsOpenArguments } from "@slack/web-api";
import type { Logger } from "pino";
import { z } from "zod";
import type { BotConfig } from "../config";
import { validateCronInput } from "./index";
import type { CronStore } from "./store";
import { cronjobNameSchema } from "./job-files";
import { CronjobManager, type CronModelResolver } from "./job-manager";
import {
  botKey,
  type Identity,
  isAllowedChannel,
  isAllowedUser,
} from "../gateway/routing";

export type SlackAck = (payload?: Record<string, unknown>) => Promise<void>;
export type CronView = Extract<ViewsOpenArguments["view"], { type: "modal" }>;
export interface CronUIApi {
  open(triggerId: string, view: CronView): Promise<void>;
  push(triggerId: string, view: CronView): Promise<void>;
  update(viewId: string, hash: string, view: CronView): Promise<void>;
}

const id = z.string().min(1).max(255);
const userId = z.string().regex(/^[UW][A-Z0-9]+$/);
const channelId = z.string().regex(/^[CGD][A-Z0-9]+$/);
const human = z
  .object({
    id: userId,
    is_bot: z.literal(false).optional(),
    bot_id: z.never().optional(),
  })
  .passthrough();
const commandSchema = z
  .object({
    command: z.literal("/cron"),
    api_app_id: id,
    team_id: id,
    user_id: userId,
    user_name: z.string().optional(),
    channel_id: channelId,
    trigger_id: id,
    text: z.string().max(1000),
    bot_id: z.never().optional(),
  })
  .passthrough();
const scopeSchema = z.object({
  botKey: z.string().max(2000),
  channel: channelId,
  user: userId,
});
const metadataSchema = scopeSchema.extend({
  page: z.number().int().min(0).max(1_000_000),
});
const viewSchema = z
  .object({
    id,
    hash: id,
    callback_id: z.enum(["cron_list", "cron_add"]),
    private_metadata: z.string().max(3000),
  })
  .passthrough();
const interactionBase = {
  api_app_id: id,
  team: z.object({ id }).passthrough(),
  user: human,
  bot_id: z.never().optional(),
};
const actionSchema = z
  .object({
    ...interactionBase,
    type: z.literal("block_actions"),
    trigger_id: id,
    view: viewSchema,
    actions: z
      .array(
        z
          .object({
            type: z.literal("button"),
            action_id: z.enum([
              "cron_add",
              "cron_remove",
              "cron_next",
              "cron_previous",
              "cron_refresh",
            ]),
            value: z.string().max(255).optional(),
          })
          .passthrough(),
      )
      .length(1),
  })
  .passthrough();
const submissionSchema = z
  .object({
    ...interactionBase,
    type: z.literal("view_submission"),
    view: viewSchema.extend({
      state: z
        .object({ values: z.record(z.string(), z.unknown()) })
        .passthrough(),
    }),
  })
  .passthrough();
type Metadata = z.infer<typeof metadataSchema>;
const usage =
  "Use /cron, /cron list, /cron add, /cron remove, or /cron run NAME_OR_ID.";
const plain = (text: string) => ({
  type: "plain_text" as const,
  text,
  emoji: false,
});
const section = (text: string) => ({
  type: "section" as const,
  text: plain(text),
});
const button = (text: string, action_id: string) => ({
  type: "button" as const,
  text: plain(text),
  action_id,
});
const fields = [
  ["name", "Name", 80],
  ["expression", "Cron expression (5 fields)", 100],
  ["timezone", "IANA timezone", 100],
  ["prompt", "Recurring prompt", 3000],
] as const;

function notice(text: string): CronView {
  return {
    type: "modal",
    title: plain("Cron"),
    close: plain("Close"),
    clear_on_close: true,
    blocks: [section(text)],
  };
}

function addView(scope: Metadata, config: BotConfig): CronView {
  const immediate = { text: plain("Immediate"), value: "immediate" };
  return {
    type: "modal",
    callback_id: "cron_add",
    title: plain("Add recurring prompt"),
    close: plain("Cancel"),
    submit: plain("Add"),
    private_metadata: JSON.stringify(scope),
    blocks: [
      section(
        "Selecting Add authorizes recurring execution with this bot's existing tools and access. Results are posted to this channel. Timezone defaults to UTC. Five fields: minute hour day-of-month month day-of-week. Example: 0 9 * * 1-5.",
      ),
      section(
        config.cronjobs?.dailyReport
          ? `Daily results are reported at ${config.cronjobs.dailyReport.time} UTC (default 08:30 UTC).`
          : "Daily reporting is not configured. Daily results remain in local storage; no daily Slack report is sent.",
      ),
      ...fields.map(([key, label, max]) => ({
        type: "input" as const,
        block_id: key,
        label: plain(label),
        element: {
          type: "plain_text_input" as const,
          action_id: "value",
          max_length: max,
          ...(key === "timezone" ? { initial_value: "UTC" } : {}),
          ...(key === "prompt" ? { multiline: true } : {}),
        },
      })),
      {
        type: "input",
        block_id: "report",
        optional: true,
        label: plain("Result reporting"),
        element: {
          type: "static_select",
          action_id: "value",
          initial_option: immediate,
          options: [immediate, { text: plain("Daily report"), value: "daily" }],
        },
      },
    ],
  };
}

export class CronUI {
  // Leave time for Slack ACK even when a local filesystem is unavailable.
  private async bounded<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Cron storage timed out")),
            1500,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async sync() {
    if (this.config.cronjobs)
      await this.bounded(
        new CronjobManager(
          this.config,
          this.identity,
          this.store,
          this.resolveModel,
        ).sync(Date.now(), AbortSignal.timeout(1500)),
      );
  }
  constructor(
    private config: BotConfig,
    private readonly identity: Identity,
    private readonly store: CronStore,
    private readonly api: CronUIApi,
    private readonly log: Logger,
    private readonly resolveModel?: CronModelResolver,
  ) {}

  /** Access changes apply before the next operation or delivery. */
  reconfigure(config: BotConfig) {
    this.config = config;
  }

  private allowed(user: string, channel: string, app: string, team: string) {
    return (
      app === this.config.slack.appId &&
      team === this.identity.team &&
      user !== this.identity.user &&
      isAllowedUser(this.config, user) &&
      isAllowedChannel(this.config, channel)
    );
  }

  private metadata(raw: string, user: string, app: string, team: string) {
    try {
      const result = metadataSchema.safeParse(JSON.parse(raw));
      if (!result.success) return;
      const scope = result.data;
      if (
        scope.botKey !== botKey(this.config, this.identity) ||
        scope.user !== user ||
        !this.allowed(user, scope.channel, app, team)
      )
        return;
      return scope;
    } catch {
      return;
    }
  }

  private listView(scope: Metadata, message?: string): CronView {
    const owner = scopeSchema.parse(scope);
    let page = scope.page;
    let jobs = this.store.list(owner, page);
    // Removing the last row on a page returns to the preceding page.
    if (!jobs.length && page > 0) jobs = this.store.list(owner, --page);
    const current = { ...scope, page };
    const next =
      page < 1_000_000 && this.store.list(owner, page + 1).length > 0;
    return {
      type: "modal",
      callback_id: "cron_list",
      title: plain("Recurring prompts"),
      close: plain("Close"),
      clear_on_close: true,
      private_metadata: JSON.stringify(current),
      blocks: [
        section(
          message ??
            `Your recurring prompts in this channel. Page ${page + 1}.`,
        ),
        ...(jobs.length
          ? jobs.map((job) => ({
              ...section(
                `${job.name}\n${job.expression || "Quota event only"} · ${job.timezone}\n${job.available ? (job.paused ? "Paused" : "Active") : "Missing or invalid definition"} · Report: ${job.report}\nModel: ${job.model ?? "captain (default)"}${job.once ? " · Once" : ""}${job.arbiter ? ` · Arbiter: ${job.arbiter}` : ""}\nNext: ${job.expression ? new Date(job.nextAt).toISOString() : "on quota event"}\n${Array.from(job.prompt).slice(0, 500).join("")}`,
              ),
              accessory: {
                ...button("Remove", "cron_remove"),
                value: job.id,
                style: "danger" as const,
                confirm: {
                  title: plain("Remove recurring prompt?"),
                  text: plain(
                    `Remove ${job.name}? This stops future runs. An already queued or running request may still finish.`,
                  ),
                  confirm: plain("Remove"),
                  deny: plain("Keep"),
                  style: "danger" as const,
                },
              },
            }))
          : [section("No recurring prompts yet. Select Add to create one.")]),
        {
          type: "actions",
          elements: [
            { ...button("Add", "cron_add"), style: "primary" },
            button("Refresh", "cron_refresh"),
            ...(page > 0 ? [button("Previous", "cron_previous")] : []),
            ...(next ? [button("Next", "cron_next")] : []),
          ],
        },
      ],
    };
  }

  // Mark ACK before awaiting it: a rejected transport must not send a second ACK.
  private async handle(
    ack: SlackAck,
    run: (once: SlackAck) => Promise<void>,
    submission = false,
  ) {
    let acknowledged = false;
    const once: SlackAck = async (payload) => {
      if (acknowledged) return;
      acknowledged = true;
      await ack(payload);
    };
    try {
      await run(once);
    } catch {
      this.log.error("Could not handle cron interaction");
      if (!acknowledged) {
        try {
          await once(
            submission
              ? {
                  response_action: "errors",
                  errors: { name: "Could not save. Try again." },
                }
              : {
                  response_type: "ephemeral",
                  text: "Cron unavailable. Try /cron again.",
                },
          );
        } catch {
          this.log.error("Could not acknowledge cron interaction");
        }
      }
    }
  }

  async command(body: unknown, ack: SlackAck): Promise<void> {
    await this.handle(ack, async (once) => {
      const parsed = commandSchema.safeParse(body);
      if (
        !parsed.success ||
        parsed.data.user_name === "slackbot" ||
        !this.allowed(
          parsed.data.user_id,
          parsed.data.channel_id,
          parsed.data.api_app_id,
          parsed.data.team_id,
        )
      ) {
        await once({
          response_type: "ephemeral",
          text: "Cron unavailable for this user or channel.",
        });
        return;
      }
      const data = parsed.data;
      const subcommand = data.text.trim();
      const runName = /^run\s+(.+)$/.exec(subcommand)?.[1]?.trim();
      if (!["", "list", "add", "remove"].includes(subcommand) && !runName) {
        await once({ response_type: "ephemeral", text: usage });
        return;
      }
      const scope = {
        botKey: botKey(this.config, this.identity),
        channel: data.channel_id,
        user: data.user_id,
        page: 0,
      };
      await this.sync();
      if (
        !this.allowed(
          data.user_id,
          data.channel_id,
          data.api_app_id,
          data.team_id,
        )
      ) {
        await once({
          response_type: "ephemeral",
          text: "Cron unavailable for this user or channel.",
        });
        return;
      }
      if (runName) {
        const run = this.store.runNow(
          scopeSchema.parse(scope),
          runName,
          Date.now(),
          data.trigger_id,
        );
        await once({
          response_type: "ephemeral",
          text: run
            ? "Recurring prompt queued. Execution is not completed."
            : "Recurring prompt busy or unavailable. No new run queued.",
        });
        return;
      }
      await once();
      await this.api.open(
        data.trigger_id,
        subcommand === "add"
          ? addView(scope, this.config)
          : this.listView(scope),
      );
    });
  }

  async interactive(body: unknown, ack: SlackAck): Promise<void> {
    const submitting = z
      .object({ type: z.literal("view_submission") })
      .safeParse(body).success;
    await this.handle(
      ack,
      async (once) => {
        if (submitting) {
          const parsed = submissionSchema.safeParse(body);
          const data = parsed.success ? parsed.data : undefined;
          const scope =
            data &&
            this.metadata(
              data.view.private_metadata,
              data.user.id,
              data.api_app_id,
              data.team.id,
            );
          if (!data || !scope || data.view.callback_id !== "cron_add") {
            await once({
              response_action: "update",
              view: notice(
                "This form is no longer valid. Close it and run /cron again.",
              ),
            });
            return;
          }
          const raw: Record<string, string> = {};
          const errors: Record<string, string> = {};
          for (const [key, , max] of fields) {
            const field = z
              .object({
                value: z
                  .object({
                    type: z.literal("plain_text_input"),
                    value: z.string().trim().min(1).max(max),
                  })
                  .passthrough(),
              })
              .passthrough()
              .safeParse(data.view.state.values[key]);
            if (field.success) raw[key] = field.data.value.value;
            else
              errors[key] =
                `Enter ${key === "expression" ? "a five-field cron expression" : `a valid ${key}`} (1–${max} characters).`;
          }
          const report = z
            .object({
              value: z
                .object({
                  type: z.literal("static_select"),
                  selected_option: z
                    .object({ value: z.enum(["immediate", "daily"]) })
                    .passthrough()
                    .nullable(),
                })
                .passthrough(),
            })
            .passthrough()
            .safeParse(data.view.state.values["report"]);
          if (data.view.state.values["report"] !== undefined && !report.success)
            errors["report"] = "Choose immediate or daily reporting.";
          raw["report"] = report.success
            ? (report.data.value.selected_option?.value ?? "immediate")
            : "immediate";
          if (
            this.config.cronjobs &&
            !cronjobNameSchema.safeParse(raw["name"]).success
          )
            errors["name"] =
              "Use a lowercase kebab-case name, for example daily-build.";
          if (Object.keys(errors).length) {
            await once({ response_action: "errors", errors });
            return;
          }
          const now = Date.now();
          let validated: ReturnType<typeof validateCronInput>;
          try {
            validated = validateCronInput(raw, now);
          } catch (error) {
            const timezone =
              error instanceof Error && error.message.includes("timezone");
            await once({
              response_action: "errors",
              errors: {
                [timezone ? "timezone" : "expression"]: timezone
                  ? "Use an IANA timezone, for example UTC or Europe/London."
                  : "Use a valid five-field cron expression with a future occurrence.",
              },
            });
            return;
          }
          // Synchronous SQLite commit precedes success ACK. Slack retries reuse view.id.
          if (this.config.cronjobs) {
            await this.bounded(
              new CronjobManager(
                this.config,
                this.identity,
                this.store,
                this.resolveModel,
              ).add(
                scopeSchema.parse(scope),
                validated.input,
                now,
                data.view.id,
              ),
            );
          } else
            this.store.add(
              scopeSchema.parse(scope),
              validated.input,
              now,
              data.view.id,
            );
          // Clear all views after saving. The next Add gets a fresh view.id,
          // preserving durable retry deduplication without growing the stack.
          await once({ response_action: "clear" });
          return;
        }
        const parsed = actionSchema.safeParse(body);
        if (!parsed.success) {
          await once();
          return;
        }
        const data = parsed.data;
        const scope = this.metadata(
          data.view.private_metadata,
          data.user.id,
          data.api_app_id,
          data.team.id,
        );
        const action = data.actions[0];
        if (!scope || !action || data.view.callback_id !== "cron_list") {
          await once();
          return;
        }
        let message: string | undefined;
        await this.sync();
        if (
          !this.metadata(
            data.view.private_metadata,
            data.user.id,
            data.api_app_id,
            data.team.id,
          )
        ) {
          await once();
          return;
        }
        if (action.action_id === "cron_remove") {
          // Commit before ACK: a lost ACK must not lose an authorized removal.
          const removed =
            action.value &&
            this.store.remove(scopeSchema.parse(scope), action.value);
          message = removed
            ? "Recurring prompt removed. Future runs stop; queued or running requests may still finish."
            : "Recurring prompt not found. The list is refreshed.";
        }
        await once();
        if (
          !this.metadata(
            data.view.private_metadata,
            data.user.id,
            data.api_app_id,
            data.team.id,
          )
        )
          return;
        if (action.action_id === "cron_add") {
          await this.api.push(data.trigger_id, addView(scope, this.config));
          return;
        }
        const page = Math.max(
          0,
          scope.page +
            (action.action_id === "cron_next"
              ? 1
              : action.action_id === "cron_previous"
                ? -1
                : 0),
        );
        await this.api.update(
          data.view.id,
          data.view.hash,
          this.listView({ ...scope, page }, message),
        );
      },
      submitting,
    );
  }
}
