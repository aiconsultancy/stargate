import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type {
  ActivitySnapshot,
  ActivityWatch,
  CrewActivitySettings,
} from "./activity";
import type { AgentBackend } from "./backend";
import type { SlackDelivery } from "./gateway";
import type { Job } from "./store";

export type ActivityHandle = { finish(): void; cancel(): void };
type Pending = {
  controller: AbortController;
  done: Promise<void>;
  finished: boolean;
};
type Options = {
  intervalMs?: number;
  startupTimeoutMs?: number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("Activity cancelled"));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Best-effort reporting is independent of answer delivery and its retries. */
export class ActivityDelivery {
  private readonly pending = new Set<Pending>();
  private closed = false;
  private readonly wait: NonNullable<Options["wait"]>;

  constructor(
    private readonly backend: AgentBackend,
    private readonly slack: SlackDelivery,
    private readonly settings: () => CrewActivitySettings,
    private readonly allowed: (job: Job) => boolean,
    private readonly log: Logger,
    private readonly options: Options = {},
  ) {
    this.wait =
      options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  }

  async start(
    job: Job,
    sessionID: string,
    requestSignal: AbortSignal,
    shutdown: AbortSignal,
  ): Promise<ActivityHandle | undefined> {
    const settings = this.settings();
    const start =
      typeof this.backend.startActivity === "function"
        ? this.backend.startActivity.bind(this.backend)
        : undefined;
    const publish =
      typeof this.slack.activity === "function"
        ? this.slack.activity.bind(this.slack)
        : undefined;
    if (
      this.closed ||
      settings.detail === "off" ||
      !start ||
      !publish ||
      !this.allowed(job) ||
      this.pending.size >= 8
    )
      return;
    const ready = Promise.withResolvers<boolean>();
    const entry: Pending = {
      controller: new AbortController(),
      done: Promise.resolve(),
      finished: false,
    };
    const signal = AbortSignal.any([
      shutdown,
      entry.controller.signal,
      AbortSignal.timeout(300_000),
    ]);
    this.pending.add(entry);
    entry.done = (async () => {
      let watch: ActivityWatch | undefined;
      let terminal = false;
      try {
        const setupSignal = AbortSignal.any([
          signal,
          requestSignal,
          AbortSignal.timeout(this.options.startupTimeoutMs ?? 1000),
        ]);
        const opened = await abortable(
          start(
            sessionID,
            `slack-job-${job.id}`,
            settings.reporter,
            setupSignal,
          ),
          setupSignal,
        );
        watch = opened;
        ready.resolve(true);
        let ts: string | undefined;
        let revision = -1;
        let finished = false;
        while (!signal.aborted) {
          if (!this.allowed(job) || this.settings().detail === "off") break;
          const finishNow = entry.finished && !finished;
          const snapshot: ActivitySnapshot = await abortable(
            finishNow ? opened.finish(signal) : opened.read(signal),
            signal,
          );
          if (finishNow) finished = true;
          terminal = ["complete", "unavailable", "cancelled"].includes(
            snapshot.status,
          );
          signal.throwIfAborted();
          if (!this.allowed(job) || this.settings().detail === "off") break;
          const detail = this.settings().detail;
          if (
            detail !== "off" &&
            snapshot.revision !== revision &&
            (snapshot.entries.length || snapshot.summary || ts)
          ) {
            ts = await publish(
              job.channel,
              job.thread,
              { ...snapshot, detail },
              ts,
              signal,
            );
            revision = snapshot.revision;
          }
          if (terminal) break;
          await this.wait(this.options.intervalMs ?? 5000, signal);
        }
      } catch {
        if (!signal.aborted)
          this.log.warn(
            { job: job.id },
            "Crew activity unavailable; answer delivery continues",
          );
      } finally {
        ready.resolve(false);
        if (watch && !terminal) {
          await watch.cancel(AbortSignal.timeout(2000)).catch(() => {});
        }
        this.pending.delete(entry);
      }
    })();
    if (!(await ready.promise)) return;
    return {
      finish: () => {
        entry.finished = true;
      },
      cancel: () => entry.controller.abort(),
    };
  }

  async close() {
    this.closed = true;
    const pending = [...this.pending];
    for (const entry of pending) entry.controller.abort();
    await Promise.all(pending.map(({ done }) => done));
  }
}
