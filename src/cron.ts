import { setTimeout as delay } from "node:timers/promises";
import { Cron } from "croner";
import type { Logger } from "pino";
import { z } from "zod";
import type { BotConfig } from "./config";
import type { CronRun, CronScope, CronStore } from "./cron-store";
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

  constructor(
    private readonly config: BotConfig,
    private readonly identity: Identity,
    private readonly store: CronStore,
    private readonly gateway: SchedulerGateway,
    private readonly slack: CronDelivery,
    private readonly log: Pick<Logger, "warn">,
  ) {
    this.key = botKey(config, identity);
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
          this.store.finish(run.id, status);
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
    } finally {
      this.ticking = false;
    }
  }

  private async process(run: CronRun, signal: AbortSignal) {
    if (!this.allowed(run) || !this.store.enabled(run.scheduleId)) {
      this.store.finish(run.id, "failed");
      return;
    }
    let thread = run.thread;
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
    if (!this.allowed(run) || !this.store.enabled(run.scheduleId)) {
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
