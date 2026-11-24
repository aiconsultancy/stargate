import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type {
  ActivitySnapshot,
  ActivityWatch,
  CrewActivitySettings,
} from "./activity";
import type { AgentBackend } from "../backends/backend";
import type { TransportDelivery } from "../gateway/ports";
import type { Job } from "../gateway/store";
import type { ActivityRecords } from "./store";

const noop = () => {};

/** A durable Stop permits a facts refresh, never another report. */
function stoppedSnapshot(snapshot: ActivitySnapshot): ActivitySnapshot {
  if (snapshot.status !== "collecting" && snapshot.status !== "summarizing")
    return snapshot;

  return {
    ...snapshot,
    status: "cancelled",
    summaryCurrent: false,
    summary: "Activity collection stopped; later facts remain in the journal.",
  };
}

export type ActivityHandle = { finish(): void; cancel(): void };

type Pending = {
  controller: AbortController;
  wake: AbortController;
  done: Promise<void>;
  finished: boolean;
  job: number;
  cancelled: boolean;
  grace?: ReturnType<typeof setTimeout>;
};

type Options = {
  intervalMs?: number;
  startupTimeoutMs?: number;
  finalizeTimeoutMs?: number;
  settleIntervalMs?: number;
  store?: Pick<ActivityRecords, "activity" | "saveActivity">;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = noop;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => {
          reject(new Error("Activity cancelled"));
        };

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

  public constructor(
    private readonly backend: AgentBackend,
    private readonly slack: TransportDelivery,
    private readonly settings: () => CrewActivitySettings,
    private readonly allowed: (job: Job) => boolean,
    private readonly log: Logger,
    private readonly options: Options = {},
  ) {
    this.wait =
      options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  }

  public async start(
    job: Job,
    sessionID: string,
    requestSignal: AbortSignal,
    shutdown: AbortSignal,
    resume = false,
  ): Promise<ActivityHandle | undefined> {
    const settings = this.settings();
    const saved = this.options.store?.activity(job.id);

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
      (!start && !this.backend.resumeActivity) ||
      !publish ||
      !this.allowed(job) ||
      [...this.pending].some((entry) => entry.job === job.id) ||
      (resume
        ? [...this.pending].filter((entry) => entry.finished).length >= 32
        : [...this.pending].filter((entry) => !entry.finished).length >= 8)
    )
      return;
    const ready = Promise.withResolvers<boolean>();

    const entry: Pending = {
      controller: new AbortController(),
      wake: new AbortController(),
      done: Promise.resolve(),
      finished: resume,
      job: job.id,
      cancelled: false,
    };

    const signal = AbortSignal.any([shutdown, entry.controller.signal]);
    let settled = false;

    const finish = () => {
      if (settled || (entry.finished && entry.grace)) return;
      entry.finished = true;

      if ([...this.pending].filter((pending) => pending.finished).length > 32) {
        entry.controller.abort();

        return;
      }

      entry.grace = setTimeout(() => {
        entry.controller.abort();
      }, this.options.finalizeTimeoutMs ?? 615_000);
      const wake = entry.wake;
      entry.wake = new AbortController();
      wake.abort();
    };

    this.pending.add(entry);
    entry.done = (async () => {
      let watch: ActivityWatch | undefined;
      let terminal = false;
      let ts = saved?.ts;
      let latest: ActivitySnapshot | undefined;

      try {
        const setupSignal = AbortSignal.any([
          signal,
          requestSignal,
          AbortSignal.timeout(this.options.startupTimeoutMs ?? 1000),
        ]);

        const opened =
          resume && saved && this.backend.resumeActivity
            ? this.backend.resumeActivity(sessionID, saved.capture)
            : await abortable(
                start?.(
                  sessionID,
                  `slack-job-${job.id}`,
                  settings.reporter,
                  setupSignal,
                ) ?? Promise.reject(new Error("Activity start unavailable")),
                setupSignal,
              );

        watch = opened;
        const capture = opened.id ?? saved?.capture;

        if (capture && !saved)
          this.options.store?.saveActivity(job.id, {
            capture,
            revision: -1,
            done: false,
          });
        ready.resolve(true);

        if (resume) finish();
        let revision = saved?.revision ?? -1;
        let finished = false;

        while (!signal.aborted) {
          if (!this.allowed(job) || this.settings().detail === "off") {
            entry.cancelled = true;
            break;
          }

          const finishNow = entry.finished && !finished;
          const wake = entry.wake;
          const readSignal = AbortSignal.any([signal, wake.signal]);
          let snapshot: ActivitySnapshot;

          try {
            snapshot = await abortable(
              finishNow && !saved?.done
                ? opened.finish(readSignal)
                : opened.read(readSignal, saved?.done),
              readSignal,
            );
          } catch (error) {
            if (wake.signal.aborted && !signal.aborted) continue;
            throw error;
          }

          if (saved?.done) snapshot = stoppedSnapshot(snapshot);
          latest = snapshot;

          if (finishNow) finished = true;

          const isTerminal = ["complete", "unavailable", "cancelled"].includes(
            snapshot.status,
          );

          signal.throwIfAborted();

          if (!this.allowed(job) || this.settings().detail === "off") break;
          const detail = this.settings().detail;

          if (
            detail !== "off" &&
            snapshot.revision !== revision &&
            (snapshot.entries.length > 0 || ts)
          ) {
            ts = await abortable(
              publish(
                job.channel,
                job.thread,
                { ...snapshot, detail },
                ts,
                signal,
              ),
              signal,
            );
            revision = snapshot.revision;

            if (capture)
              this.options.store?.saveActivity(job.id, {
                capture,
                ...(ts && { ts }),
                revision,
                done: isTerminal,
              });
          }

          terminal = isTerminal;

          if (terminal && capture)
            this.options.store?.saveActivity(job.id, {
              capture,
              ...(ts && { ts }),
              revision,
              done: true,
            });

          if (terminal) break;

          try {
            await this.wait(
              entry.finished
                ? (this.options.settleIntervalMs ?? 15_000)
                : (this.options.intervalMs ?? 5000),
              readSignal,
            );
          } catch (error) {
            if (!wake.signal.aborted || signal.aborted) throw error;
          }
        }
      } catch (error) {
        const progress = this.options.store?.activity(job.id);

        if (
          progress &&
          error instanceof Error &&
          /does not own|expired|capture.*missing/i.test(error.message)
        )
          this.options.store?.saveActivity(job.id, { ...progress, done: true });

        if (!signal.aborted)
          this.log.warn(
            { job: job.id },
            "Crew activity unavailable; answer delivery continues",
          );
      } finally {
        settled = true;

        if (entry.grace) clearTimeout(entry.grace);
        ready.resolve(false);

        if (!this.allowed(job) || this.settings().detail === "off")
          entry.cancelled = true;

        if (entry.cancelled) {
          const progress = this.options.store?.activity(job.id);

          if (progress)
            this.options.store?.saveActivity(job.id, {
              ...progress,
              done: true,
            });
        }

        if (
          watch &&
          !terminal &&
          !saved?.done &&
          !shutdown.aborted &&
          !this.closed
        ) {
          const cleanup = AbortSignal.timeout(2000);

          if (entry.cancelled)
            await abortable(watch.cancel(cleanup), cleanup).catch(() => {});
          else await abortable(watch.finish(cleanup), cleanup).catch(() => {});
        }

        const detail = this.settings().detail;

        if (
          !terminal &&
          !shutdown.aborted &&
          !this.closed &&
          ts &&
          latest &&
          this.allowed(job) &&
          detail !== "off"
        ) {
          const cleanup = AbortSignal.timeout(2000);
          const aborted = entry.cancelled;
          await abortable(
            publish(
              job.channel,
              job.thread,
              {
                ...latest,
                summaryCurrent: false,
                revision: latest.revision + 1,
                status: aborted ? "cancelled" : "unavailable",
                summary: aborted
                  ? "Activity capture cancelled because the request stopped."
                  : "Activity report unavailable; answer delivery continues. No work was replayed.",
                detail,
              },
              ts,
              cleanup,
            ),
            cleanup,
          ).catch(() => {});
        }

        this.pending.delete(entry);
      }
    })();

    if (!(await ready.promise)) return;

    return {
      finish,
      cancel: () => {
        if (settled) return;
        entry.cancelled = true;
        entry.controller.abort();
      },
    };
  }

  public async resume(job: Job, sessionID: string, shutdown: AbortSignal) {
    if (!this.options.store?.activity(job.id) || !this.backend.resumeActivity)
      return;
    await this.start(
      job,
      sessionID,
      new AbortController().signal,
      shutdown,
      true,
    );
  }

  public async close() {
    this.closed = true;
    const pending = [...this.pending];

    for (const entry of pending) entry.controller.abort();
    await Promise.all(pending.map(({ done }) => done));
  }
}
