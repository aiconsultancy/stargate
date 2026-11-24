import { Deferred, Effect, FiberMap } from "effect";
import type { Logger } from "pino";
import { createTranscriber } from "../chat/transcription/startup";
import type { BotConfig, Config, IrcConfig } from "../config";
import type { Gateway } from "../gateway/gateway";
import {
  type DashboardShip,
  type dashboardSource,
  ircDashboardShip,
} from "../observability/dashboard/dashboard-source";
import type { IrcRegistration } from "../transports/irc/ship";
import { type ReloadCandidate, ReloadRejected } from "./config-reload";
import {
  type IrcBinding,
  type IrcRuntimeRegistration,
  prepareIrcRoster,
  resolveIrcRosterUpdates,
} from "./irc-reload";

/**
 * The live runtime the transaction publishes into. Every member is owned by
 * `serve`; the transaction reads, stages and commits through them and owns
 * no lifetime of its own.
 */
type ReloadRuntime = {
  /** Live bot publishers by registration id; absent means unavailable. */
  botBindings: ReadonlyMap<
    string,
    (
      next: BotConfig,
      transcriber: ReturnType<typeof createTranscriber> | undefined,
    ) => void
  >;
  /** Live IRC bindings by connection id. */
  ircBindings: ReadonlyMap<string, IrcBinding>;
  /** Stages one IRC registration's gateway entry under the shared scope. */
  buildRegistration: (
    registration: IrcRegistration,
    irc: IrcConfig,
  ) => Promise<IrcRuntimeRegistration>;
  /** Parent-bound supervision: a staged worker failure stops the runtime. */
  supervise: (
    log: Logger,
    worker: "gateway",
    work: (signal: AbortSignal) => Promise<void>,
  ) => Effect.Effect<void>;
  /** The runtime's shared worker fibers. */
  fibers: FiberMap.FiberMap<string, void>;
  admitting: () => boolean;
  /** Dashboard ships; the commit adds, updates and removes entries. */
  ships: DashboardShip[];
  fleetDashboard:
    | Pick<
        ReturnType<typeof dashboardSource>,
        "retireFleetBackend" | "invalidateFleetCrew"
      >
    | undefined;
  /** Owns committed additions until runtime shutdown. */
  addedResources: IrcRuntimeRegistration[];
  publishNotificationView: (config: Config) => void;
  log: Pick<Logger, "warn">;
};

/**
 * The live configuration reload transaction: stage every added IRC worker
 * behind a deferred gate, pause and check every removed member, then commit
 * the whole candidate without an await. A rejection rolls the staging back
 * and leaves the running settings and connections intact.
 */
export function reloadTransaction(runtime: ReloadRuntime) {
  const {
    admitting,
    addedResources,
    botBindings,
    buildRegistration,
    fibers,
    fleetDashboard,
    ircBindings,
    log,
    publishNotificationView,
    ships,
    supervise,
  } = runtime;

  return async (candidate: ReloadCandidate) => {
    const staged: {
      entry: IrcRuntimeRegistration;
      start: Deferred.Deferred<void>;
    }[] = [];

    const paused: Gateway[] = [];
    let committed = false;

    try {
      const bots = candidate.config.bots.map((next) => {
        const publish = botBindings.get(next.id);

        if (!publish) {
          throw new ReloadRejected("unavailable");
        }

        return {
          publish,
          next,
          transcriber: next.transcription
            ? createTranscriber(next.transcription)
            : undefined,
        };
      });

      const plans =
        candidate.config.irc.length === 0
          ? []
          : await prepareIrcRoster(
              candidate.config.irc,
              candidate.environment,
              ircBindings,
              async (registration, next) => {
                const entry = await buildRegistration(registration, next);
                const start = Deferred.makeUnsafe<void>();
                staged.push({ entry, start });
                // A staged worker cannot recover or process anything until the
                // Synchronous commit publishes the whole candidate.
                await Effect.runPromise(
                  FiberMap.run(
                    fibers,
                    registration.key,
                    Deferred.await(start).pipe(
                      Effect.andThen(
                        supervise(registration.log, "gateway", (signal) =>
                          entry.gateway.work(signal),
                        ),
                      ),
                    ),
                  ),
                );

                return entry;
              },
            );

      if (!admitting()) {
        throw new ReloadRejected("unavailable");
      }

      for (const { binding, plan } of plans) {
        for (const registration of plan.removed) {
          const entry = binding.entries.get(registration.key);

          if (!entry) {
            throw new ReloadRejected("unavailable");
          }

          entry.gateway.pause();
          paused.push(entry.gateway);
        }
      }

      if (paused.some((gateway) => !gateway.isIdle())) {
        throw new ReloadRejected("busy");
      }

      const updates = resolveIrcRosterUpdates(plans);

      // No awaits: publish all access/settings and roster references in
      // One JS turn. Admission cannot observe a half-applied candidate.
      for (const { binding, plan } of plans) {
        plan.commit(
          (key) => binding.entries.get(key)?.gateway.isIdle() ?? false,
        );
      }

      for (const bot of bots) {
        bot.publish(bot.next, bot.transcriber);
      }

      for (const {
        binding,
        registration,
        entry,
        transcriber,
        next,
      } of updates) {
        entry.gateway.reconfigure(
          registration.settings,
          transcriber,
          registration.transport,
        );
        Object.assign(
          entry.dashboard,
          ircDashboardShip(registration, next, entry.resource.backend),
        );

        if (!ships.includes(entry.dashboard)) {
          ships.push(entry.dashboard);
        }

        binding.entries.set(registration.key, entry);
      }

      publishNotificationView(candidate.config);

      // Retire all removed Fleet backends before a crew refresh can
      // Sample an alias that is waiting for asynchronous cleanup.
      for (const { binding, plan } of plans) {
        for (const registration of plan.removed) {
          const entry = binding.entries.get(registration.key);

          if (entry) {
            const index = ships.indexOf(entry.dashboard);

            if (index !== -1) {
              ships.splice(index, 1);
            }

            fleetDashboard?.retireFleetBackend(entry.resource.backend);
          }
        }
      }

      committed = true;
      fleetDashboard?.invalidateFleetCrew();

      for (const { entry, start } of staged) {
        addedResources.push(entry);
        Effect.runSync(Deferred.succeed(start, undefined));
      }

      // Removed members are already detached. They were idle, so worker
      // Cancellation and cleanup cannot discard queued or active work.
      for (const { binding, plan } of plans) {
        for (const registration of plan.removed) {
          const entry = binding.entries.get(registration.key);
          binding.entries.delete(registration.key);
          await Effect.runPromise(
            FiberMap.remove(fibers, registration.key),
          ).catch(() => {
            log.warn("Retired worker cleanup failed");
          });
          await entry?.resource.close().catch(() => {
            log.warn("Retired backend cleanup failed");
          });
        }

        await plan.retire().catch(() => {
          log.warn("Retired IRC cleanup failed");
        });
      }
    } finally {
      if (!committed) {
        for (const gateway of paused) {
          gateway.pause(false);
        }

        for (const { entry } of staged) {
          await Effect.runPromise(
            FiberMap.remove(fibers, entry.registration.key),
          );
          await entry.resource.close().catch(() => {
            log.warn("Staged backend cleanup failed");
          });
        }
      }
    }
  };
}
