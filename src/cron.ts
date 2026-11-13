import { setTimeout as delay } from "node:timers/promises";
import { Cron } from "croner";
import type { Logger } from "pino";
import { z } from "zod";
import type { BotConfig } from "./config";
import type { CronRun, CronScope, CronStore } from "./cron-store";
import { CronjobManager } from "./cronjob-manager";
import {
  botKey,
  type Identity,
  isAllowedChannel,
  isAllowedUser,
} from "./routing";

const inputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  expression: z.string().trim().min(1).max(100),
  timezone: z.string().trim().min(1).max(100).default("UTC"),
  prompt: z.string().trim().min(1).max(12_000),
  report: z.enum(["immediate", "daily"]).optional(),
});

export type CronInput = z.infer<typeof inputSchema>;

/** Errors are safe for Slack: never include parser errors or supplied input. */
export function validateCronInput(
  raw: unknown,
  now: number,
): { input: CronInput; nextAt: number } {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid cron input or field length.");
  const input = parsed.data;
  input.expression = input.expression.replace(/\s+/g, " ");
  if (input.expression.split(" ").length !== 5)
    throw new Error("Invalid cron expression: use five fields.");
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime()))
    throw new Error("Invalid cron reference time.");
  try {
    // Intl also accepts fixed offsets, which are not IANA timezone names.
    if (/^[+-]/.test(input.timezone)) throw new Error();
    new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format(now);
  } catch {
    throw new Error("Invalid cron timezone: use an IANA timezone name.");
  }
  try {
    // Croner calculates dates only; SQLite owns all scheduling and recovery.
    const cron = new Cron(input.expression, {
      timezone: input.timezone,
      mode: "5-part",
      paused: true,
    });
    const nextAt = cron.nextRun(new Date(now))?.getTime();
    if (nextAt === undefined || !Number.isFinite(nextAt) || nextAt <= now)
      throw new Error();
    return { input, nextAt };
  } catch {
    throw new Error("Invalid cron expression or no future occurrence.");
  }
}

export type ScheduledInput = {
  runId: string;
  channel: string;
  user: string;
  prompt: string;
  thread: string;
  name: string;
  deferDelivery?: boolean;
};

export interface SchedulerGateway {
  /**
   * Must synchronously persist, deduplicate, and return the existing ID when
   * repeated after a crash. Undefined means policy rejected the request.
   */
  enqueueScheduled(input: ScheduledInput): number | undefined;
  scheduledStatus(
    jobId: number,
  ): "queued" | "running" | "responding" | "done" | "failed" | undefined;
  scheduledResult?(jobId: number):
    | {
        text: string;
        status: "queued" | "running" | "responding" | "done" | "failed";
        failure?: unknown;
      }
    | undefined;
}

export interface CronDelivery {
  /** Implementations should pass signal through to the underlying request. */
  announce(channel: string, text: string, signal: AbortSignal): Promise<string>;
}

export class CronScheduler {
  private readonly key: string;
  private recovered = false;
  private ticking = false;
  private queuedAfter = "";
  private files: CronjobManager;
  private syncAfter = 0;
  private definitionErrors: string[] = [];

  constructor(
    private config: BotConfig,
    private readonly identity: Identity,
    private readonly store: CronStore,
    private readonly gateway: SchedulerGateway,
    private readonly slack: CronDelivery,
    private readonly log: Pick<Logger, "warn">,
  ) {
    this.key = botKey(config, identity);
    this.files = new CronjobManager(config, identity, store);
  }

  /** Access changes apply before the next operation or delivery. */
  reconfigure(config: BotConfig) {
    this.config = config;
    this.files = new CronjobManager(config, this.identity, this.store);
  }

  private allowed(scope: CronScope) {
    return (
      scope.botKey === this.key &&
      scope.user !== this.identity.user &&
      isAllowedUser(this.config, scope.user) &&
      isAllowedChannel(this.config, scope.channel)
    );
  }

  /** One bounded pass. Repeated or concurrent calls never create a backlog. */
  async tick(now: number, signal: AbortSignal) {
    if (signal.aborted || this.ticking) return;
    this.ticking = true;
    try {
      if (this.config.cronjobs && now >= this.syncAfter) {
        this.definitionErrors = await this.files.sync(now);
        this.syncAfter = now + 10_000;
        if (this.definitionErrors.length)
          this.log.warn(
            { bot: this.config.id, count: this.definitionErrors.length },
            "Invalid cronjob definitions; execution disabled for affected files",
          );
      }
      if (!this.recovered) {
        const count = this.store.recoverAnnouncements(this.key);
        if (count)
          this.log.warn(
            { bot: this.config.id, count },
            "Cron announcements interrupted; not repeated",
          );
        this.recovered = true;
      }
      const queued = this.store.queued(this.key, this.queuedAfter);
      // Round-robin status polling keeps long-running early jobs from starving
      // terminal reconciliation when more than one batch is active.
      this.queuedAfter = queued.length === 100 ? (queued.at(-1)?.id ?? "") : "";
      for (const run of queued) {
        if (run.jobId === null) continue;
        const status = this.gateway.scheduledStatus(run.jobId);
        if (status === "done" || status === "failed")
          this.store.finish(run.id, status, now);
        else if (status === undefined) {
          // greybeard: missing queue state is uncertain, not permission to
          // rerun tools. Hold this schedule until its owner removes it.
          this.store.block(run.id);
          this.log.warn({ run: run.id }, "Cron queue state missing; run held");
        }
      }
      this.store.claimDue(this.key, now);
      for (const run of this.store.pending(this.key)) {
        if (signal.aborted) break;
        await this.process(run, signal);
      }
      if (!signal.aborted) await this.dailyReport(now, signal);
    } finally {
      this.ticking = false;
    }
  }

  private async process(run: CronRun, signal: AbortSignal) {
    if (!this.allowed(run) || !this.store.enabled(run.scheduleId, run.manual)) {
      this.store.finish(run.id, "failed");
      return;
    }
    let thread = run.thread;
    if (run.report === "daily" && thread === null) {
      // No external effect here: one durable transition can be safely resumed.
      if (!this.store.prepareDeferred(run.id)) return;
      thread = "";
    }
    if (thread === null) {
      // Persist before POST. A timeout, exception, or crash cannot establish
      // whether Slack accepted the root message; never automatically repost.
      if (!this.store.announcing(run.id)) return;
      try {
        thread = await this.slack.announce(
          run.channel,
          `Scheduled task: ${run.name}`,
          signal,
        );
        if (!/^\d+\.\d+$/.test(thread)) throw new Error();
      } catch {
        this.store.finish(run.id, "failed");
        this.log.warn(
          { run: run.id },
          "Cron announcement uncertain; not repeated",
        );
        return;
      }
      if (!this.store.announced(run.id, thread)) return;
    }
    // Removal, access revocation, and shutdown can occur while Slack is pending.
    // On shutdown keep the saved root for the next worker; no second POST.
    if (signal.aborted) return;
    if (!this.allowed(run) || !this.store.enabled(run.scheduleId, run.manual)) {
      this.store.finish(run.id, "failed");
      return;
    }
    try {
      const job = this.gateway.enqueueScheduled({
        runId: run.id,
        channel: run.channel,
        user: run.user,
        prompt: run.prompt,
        thread,
        name: run.name,
        deferDelivery: run.report === "daily",
      });
      if (job === undefined) this.store.finish(run.id, "failed");
      else this.store.enqueued(run.id, job);
    } catch {
      // Do not retry an ambiguous queue write in this process. A crash between
      // enqueue and enqueued is safe because enqueueScheduled is idempotent.
      this.store.block(run.id);
      this.log.warn({ run: run.id }, "Cron enqueue uncertain; run held");
    }
  }

  private async dailyReport(now: number, signal: AbortSignal) {
    const settings = this.config.cronjobs;
    const report = settings?.dailyReport;
    if (!settings || !report) return;
    const date = new Date(now).toISOString().slice(0, 10);
    const cutoff = Date.parse(`${date}T${report.time}:00Z`);
    if (now < cutoff) return;
    const scope = {
      botKey: this.key,
      channel: report.channel ?? settings.channel,
      user: settings.user,
    };
    if (!this.allowed(scope)) return;
    // Check the durable claim before reading results on every scheduler tick.
    if (!this.store.claimDailyReport(scope, date)) return;
    const jobs = this.store
      .report(this.key)
      .filter((job) => this.allowed({ ...job, botKey: this.key }));
    const runs = this.store
      .dailyResults(this.key, cutoff - 86_400_000, cutoff)
      .filter((run) => this.allowed({ ...run, botKey: this.key }));
    const line = (text: string, max: number) =>
      Array.from(text.replace(/[\r\n\t]+/g, " "))
        .slice(0, max)
        .join("");
    const roster = jobs
      .slice(0, 10)
      .map(
        (job) =>
          `- ${line(job.name, 32)}: ${!job.available ? "unavailable" : job.paused ? "paused" : "scheduled"}; last ${job.lastStatus ?? "not run"}`,
      );
    const outcomes = runs.slice(0, 10).map((run) => {
      const result =
        run.jobId === null
          ? undefined
          : this.gateway.scheduledResult?.(run.jobId);
      const status = result?.failure ? "failed" : run.status;
      return `- ${line(run.name, 32)}: ${status}${result?.text ? ` — ${line(result.text, 120)}` : ""}`;
    });
    const text = [
      `Cronjob report ${date} (${report.time} UTC)`,
      `Jobs: ${jobs.length}; deferred runs: ${runs.length}; invalid definitions: ${this.definitionErrors.length}.`,
      "Jobs (up to 10; inventory bounded to 100):",
      ...roster,
      "Deferred results (up to 10; window bounded to 100):",
      ...outcomes,
      "Full public results remain in private local queue state. Missed report days are not replayed.",
    ].join("\n");
    // One bounded message. Claim first: uncertain Slack writes never repost.
    try {
      await this.slack.announce(
        scope.channel,
        Array.from(text).slice(0, 2800).join(""),
        signal,
      );
      this.store.finishDailyReport(scope, date, "done");
    } catch {
      this.store.finishDailyReport(scope, date, "failed");
      this.log.warn(
        { bot: this.config.id },
        "Daily cron report uncertain; not repeated",
      );
    }
  }

  async work(signal: AbortSignal) {
    try {
      while (!signal.aborted) {
        await this.tick(Date.now(), signal);
        await delay(1000, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
