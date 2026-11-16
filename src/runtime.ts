import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { Cause, Data, Deferred, Effect, FiberMap } from "effect";
import pino, { type Logger } from "pino";
import {
  type AgentBackend,
  type BackendContext,
  createBackend,
} from "./backend";
import {
  type BackendConfig,
  type BotConfig,
  type Config,
  type IrcConfig,
  secret,
} from "./config";
import {
  ConfigReload,
  type ReloadCandidate,
  ReloadRejected,
  readReloadCandidate,
} from "./config-reload";
import type { CrewUIApi } from "./crew-ui";
import { CrewUI } from "./crew-ui";
import { type CronDelivery, CronScheduler } from "./cron";
import { CronStore } from "./cron-store";
import { CronUI, type CronUIApi } from "./cron-ui";
import { startDashboard } from "./dashboard";
import { type DashboardShip, dashboardSource } from "./dashboard-source";
import { abortable } from "./effect";
import { FleetControl } from "./fleet/control";
import { fleetRequestAction } from "./fleet/permissions";
import { FleetResults, fleetOrigin } from "./fleet/results";
import { sendFleetAssignment } from "./fleet-irc";
import { Gateway, type SlackDelivery } from "./gateway";
import { controlInteractions } from "./interactions";
import { type IrcRegistration, IrcShip } from "./irc/ship";
import { MaintenanceOutbox } from "./nightly/outbox";
import { writeReady } from "./nightly/ready";
import { PairingUI } from "./pairing";
import { PeerDirectory } from "./peers";
import { QuotaReader } from "./quota";
import { QuotaWatch } from "./quota-watch";
import {
  backendFingerprint,
  botKey,
  type Identity,
  isAllowedChannel,
} from "./routing";
import { SlackConnection, type SlackInteractions } from "./slack";
import { Store } from "./store";
import { TeamsRegistration } from "./teams/registration";
import { createTranscriber } from "./transcribers/azure-openai";

export async function loadEnvironment(configPath: string) {
  const file = Bun.file(`${configPath}.env`);
  if (await file.exists()) {
    for (const [key, value] of Object.entries(parseEnv(await file.text()))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

export function lockInstance(path: string) {
  const lock = new Database(path, { create: true });
  try {
    lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
    return lock;
  } catch {
    lock.close();
    throw new Error("Stargate is already using this data directory");
  }
}

/** Stargate failed after startup; the service manager should restart it. */
export class RuntimeStopped extends Data.TaggedError("RuntimeStopped")<{
  readonly worker: "gateway" | "cron" | "runtime";
}> {}

/** One registration's Slack surface: intake, Web API delivery and modals. */
export interface SlackApp extends SlackDelivery, CronDelivery {
  identity(): Promise<Identity>;
  /** Slack `users.info`; required for peer captain admission. */
  userInfo?(user: string, signal: AbortSignal): Promise<unknown>;
  start(
    accept: (body: unknown) => boolean | Promise<boolean>,
    log: Logger,
    interactions: SlackInteractions,
    open: () => boolean,
  ): Promise<void>;
  close(): Promise<void>;
  readonly cronUI: CronUIApi;
  readonly crewUI: CrewUIApi;
}

export type RuntimeDependencies = {
  slack(bot: BotConfig, log: Logger): SlackApp;
  backend(
    config: BackendConfig,
    context: BackendContext,
  ): Promise<AgentBackend>;
  /** IRC ship connections; tests shorten the timings. */
  irc?(config: IrcConfig, store: Store, log: Logger): Promise<IrcShip>;
};

/** Programmatic callers may omit transports they do not use. */
export type ServeConfig = Omit<Config, "irc" | "teams"> & {
  irc?: Config["irc"];
  teams?: Config["teams"];
};

const defaults: RuntimeDependencies = {
  slack: (bot, log) =>
    new SlackConnection(
      secret(bot.slack.appTokenEnv),
      secret(bot.slack.botTokenEnv),
      log,
    ),
  backend: createBackend,
};

const release = (log: Logger, name: string, close: () => unknown) =>
  Effect.promise(async () => {
    try {
      await close();
    } catch {
      log.warn(`${name} cleanup failed`);
    }
  });

/** One idempotent close owner, shared by reload retirement and shutdown. */
function ownedBackend(backend: AgentBackend) {
  let closing: Promise<void> | undefined;
  return {
    backend,
    close: () => (closing ??= Promise.resolve().then(() => backend.close())),
  };
}

/** Injected signal source keeps tests away from the real process. */
export function listenForReload(
  reload: Pick<ConfigReload, "request">,
  source: {
    on(event: "SIGHUP", listener: () => void): unknown;
    off(event: "SIGHUP", listener: () => void): unknown;
  } = process,
) {
  const request = () => {
    void reload.request();
  };
  source.on("SIGHUP", request);
  return () => {
    source.off("SIGHUP", request);
  };
}

/**
 * Process ownership as one scope. Workers start only after every bot has
 * connected. Finalizers run in reverse order: one shared gate closes Slack
 * intake for every bot (no ACK without persistence), then one fiber
 * interrupts every worker at once and waits for their turns to settle, then
 * backends, stores and the instance lock close. Startup failures release
 * everything already acquired and leave queued requests queued. A worker
 * failure stops every bot and fails the program, so the service manager
 * restarts it.
 */
export function serve(
  config: ServeConfig,
  log: Logger,
  shutdown: AbortSignal,
  dependencies: RuntimeDependencies = defaults,
  reload?: ConfigReload,
) {
  let started = false;
  const program = Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
        await chmod(config.dataDirectory, 0o700);
      });
      const lock = join(config.dataDirectory, "instance.sqlite");
      yield* Effect.acquireRelease(
        Effect.sync(() => lockInstance(lock)),
        (lock) => Effect.sync(() => lock.close()),
      );
      const store = yield* Effect.acquireRelease(
        Effect.sync(
          () => new Store(join(config.dataDirectory, "stargate.sqlite")),
        ),
        (store) => Effect.sync(() => store.close()),
      );
      const cronStore = yield* Effect.acquireRelease(
        Effect.sync(
          () => new CronStore(join(config.dataDirectory, "cron.sqlite")),
        ),
        (store) => Effect.sync(() => store.close()),
      );
      // One intake gate for every bot: the first close stops all ACKs, and
      // modal and pairing reads stop, before any worker drains.
      let open = true;
      const requests = new AbortController();
      const connections: (() => Promise<void>)[] = [];
      const closeIntake = (only?: () => Promise<void>) =>
        Effect.sync(() => {
          open = false;
          requests.abort();
        }).pipe(
          Effect.andThen(
            Effect.all(
              (only ? [only] : connections).map((close) =>
                release(log, "Slack intake", close),
              ),
              { concurrency: "unbounded", discard: true },
            ),
          ),
          // A stuck socket must not keep accepted turns from draining.
          Effect.timeoutOption("5 seconds"),
        );
      const stopped = yield* Deferred.make<void, RuntimeStopped>();
      const supervise = (
        botLog: Logger,
        worker: "gateway" | "cron",
        work: (signal: AbortSignal) => Promise<void>,
      ) =>
        abortable(work).pipe(
          Effect.catchCause(() => {
            botLog.error(
              worker === "gateway"
                ? "Worker stopped unexpectedly"
                : "Cron worker stopped unexpectedly",
            );
            return Deferred.fail(stopped, new RuntimeStopped({ worker }));
          }),
        );
      const workers: { key: string; work: Effect.Effect<void> }[] = [];
      const botBindings = new Map<
        string,
        (
          next: BotConfig,
          transcriber: ReturnType<typeof createTranscriber> | undefined,
        ) => void
      >();
      const ships: DashboardShip[] = [];
      const identities = new Set<string>();
      const teamsRegistrations: TeamsRegistration[] = [];
      for (const teams of config.teams ?? []) {
        const teamLog = log.child({ teams: teams.id });
        const dataDirectory = join(config.dataDirectory, teams.id);
        yield* Effect.promise(() =>
          mkdir(dataDirectory, { recursive: true, mode: 0o700 }),
        );
        const resource = yield* Effect.acquireRelease(
          Effect.promise(async () =>
            ownedBackend(
              await dependencies.backend(teams.backend, { dataDirectory }),
            ),
          ),
          (resource) => release(teamLog, "Teams backend", resource.close),
        );
        const registration = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new TeamsRegistration(
                teams,
                join(dataDirectory, "teams.sqlite"),
                store,
                resource.backend,
                (message) => teamLog.warn(message),
              ),
          ),
          (registration) =>
            release(teamLog, "Teams transport", () => registration.close()),
        );
        const gateway = new Gateway(
          teams,
          { team: teams.tenantId, user: teams.botClientId },
          store,
          resource.backend,
          registration.delivery,
          teamLog,
          undefined,
          undefined,
          registration.transport,
        );
        workers.push({
          key: registration.key,
          work: supervise(teamLog, "gateway", (signal) => gateway.work(signal)),
        });
        teamsRegistrations.push(registration);
      }
      for (const bot of config.bots) {
        let currentBot = bot;
        const botLog = log.child({ bot: bot.id });
        const slack = dependencies.slack(bot, botLog);
        const identity = yield* Effect.promise(() => slack.identity());
        const key = JSON.stringify([identity.team, identity.user]);
        if (identities.has(key))
          return yield* Effect.die(
            new Error("Two registrations use the same Slack bot"),
          );
        identities.add(key);
        const namespace = createHash("sha256")
          .update(botKey(bot, identity))
          .digest("hex");
        const dataDirectory = join(config.dataDirectory, bot.id, namespace);
        yield* Effect.promise(() =>
          mkdir(dataDirectory, { recursive: true, mode: 0o700 }),
        );
        const resource = yield* Effect.acquireRelease(
          Effect.promise(async () =>
            ownedBackend(
              await dependencies.backend(bot.backend, { dataDirectory }),
            ),
          ),
          (resource) => release(botLog, "Resource", resource.close),
        );
        const backend = resource.backend;
        const gateway = new Gateway(
          bot,
          identity,
          store,
          backend,
          slack,
          botLog,
          bot.transcription ? createTranscriber(bot.transcription) : undefined,
          slack.userInfo
            ? new PeerDirectory(
                (user, signal) =>
                  slack.userInfo?.(user, signal) ?? Promise.resolve(undefined),
                identity.team,
              )
            : undefined,
        );
        const cron = new CronScheduler(
          bot,
          identity,
          cronStore,
          gateway,
          slack,
          botLog,
        );
        workers.push(
          {
            key: `gateway:${bot.id}`,
            work: supervise(botLog, "gateway", (signal) =>
              gateway.work(signal),
            ),
          },
          {
            key: `cron:${bot.id}`,
            work: supervise(botLog, "cron", (signal) => cron.work(signal)),
          },
        );
        if (config.maintenance?.report?.bot === bot.id) {
          // Maintenance summaries use this bot's normal Slack client.
          const outbox = new MaintenanceOutbox(
            config.dataDirectory,
            (channel) => isAllowedChannel(currentBot, channel),
            (channel, text, signal) => slack.announce(channel, text, signal),
            botLog,
          );
          workers.push({
            key: `maintenance:${bot.id}`,
            work: abortable((signal) => outbox.work(signal)).pipe(
              Effect.catchCause(() => Effect.void),
            ),
          });
        }
        const quota = config.quotaWatch;
        if (quota?.report.bot === bot.id) {
          const viaProxy = quota.providers.filter(
            (provider) => provider !== "codex" || !quota.nativeCodexFile,
          );
          const watcher = new QuotaWatch(
            quota,
            new QuotaReader(
              viaProxy.length ? quota.proxy : undefined,
              Date.now,
              viaProxy,
            ),
            async (text, signal) => {
              if (
                !currentBot.access.deniedChannels.some(
                  (rule) => rule === "*" || rule === quota.report.channel,
                )
              )
                await slack.announce(quota.report.channel, text, signal);
            },
            botLog,
          );
          workers.push({
            key: `quota:${bot.id}`,
            work: abortable((signal) => watcher.work(signal)),
          });
        }
        let closing: Promise<void> | undefined;
        const close = () => {
          closing ??= slack.close();
          return closing;
        };
        connections.push(close);
        // Startup failure: close this socket before its backend closes.
        yield* Effect.addFinalizer(() => closeIntake(close));
        const cronUI = new CronUI(
          bot,
          identity,
          cronStore,
          slack.cronUI,
          botLog,
        );
        const pairing = new PairingUI(
          bot,
          identity,
          backend,
          slack.cronUI,
          botLog,
          requests.signal,
        );
        const crewUI = new CrewUI(
          bot,
          identity,
          backend,
          slack.crewUI,
          botLog,
          requests.signal,
        );
        const interactions = controlInteractions(
          cronUI,
          pairing,
          (body) => gateway.cancel(body),
          crewUI,
        );
        yield* Effect.promise(() =>
          slack.start(
            async (body) => open && gateway.receive(body, () => open),
            botLog,
            interactions,
            () => open,
          ),
        );
        botLog.info("Bot connected");
        const dashboardShip = {
          bot,
          identity,
          key: botKey(bot, identity),
          backend,
        };
        ships.push(dashboardShip);
        botBindings.set(bot.id, (next, transcriber) => {
          gateway.reconfigure(next, transcriber);
          cron.reconfigure(next);
          cronUI.reconfigure(next);
          pairing.reconfigure(next);
          crewUI.reconfigure(next);
          dashboardShip.bot = next;
          currentBot = next;
        });
      }
      // IRC never blocks startup or Slack: connections retry in the
      // background, and delivery waits for them or retries later.
      const buildRegistration = async (
        registration: IrcRegistration,
        irc: IrcConfig,
      ) => {
        const namespace = createHash("sha256")
          .update(registration.key)
          .digest("hex");
        const dataDirectory = join(
          config.dataDirectory,
          registration.id,
          namespace,
        );
        await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
        const resource = ownedBackend(
          await dependencies.backend(registration.backend, { dataDirectory }),
        );
        try {
          const gateway = new Gateway(
            registration.settings,
            registration.identity,
            store,
            resource.backend,
            registration.delivery,
            registration.log,
            irc.transcription
              ? createTranscriber(irc.transcription)
              : undefined,
            undefined,
            registration.transport,
          );
          registration.stopTurn = (conversation, thread) =>
            gateway.stopTurn(conversation, thread);
          return { registration, gateway, resource };
        } catch (error) {
          await resource.close();
          throw error;
        }
      };
      type Registration = Awaited<ReturnType<typeof buildRegistration>>;
      const ircBindings = new Map<
        string,
        { ship: IrcShip; entries: Map<string, Registration> }
      >();
      for (const irc of config.irc ?? []) {
        const ship = yield* Effect.promise(() =>
          (dependencies.irc ?? IrcShip.create)(irc, store, log),
        );
        const entries = new Map<string, Registration>();
        for (const registration of ship.registrations) {
          const entry = yield* Effect.acquireRelease(
            Effect.promise(() => buildRegistration(registration, irc)),
            (entry) =>
              release(registration.log, "Resource", entry.resource.close),
          );
          entries.set(registration.key, entry);
          workers.push({
            key: registration.key,
            work: supervise(registration.log, "gateway", (signal) =>
              entry.gateway.work(signal),
            ),
          });
        }
        ircBindings.set(irc.id, { ship, entries });
        if (
          irc.fleetControl &&
          irc.backend.type === "opencode" &&
          irc.backend.sessionID
        ) {
          const pin = irc.backend.sessionID;
          const permissions = irc.backend.permissions;
          const fleetControl = irc.fleetControl;
          const primary = ship.registrations[0];
          const entry = primary ? entries.get(primary.key) : undefined;
          if (!entry || !primary)
            throw new Error("Fleet primary registration unavailable");
          const relatedTeams = teamsRegistrations.filter(
            (team) =>
              team.config.backend.type === "opencode" &&
              team.config.backend.sessionID === pin &&
              backendFingerprint(team.config) === backendFingerprint(irc),
          );
          const control = yield* Effect.acquireRelease(
            Effect.promise(() =>
              FleetControl.open({
                config: fleetControl,
                sessionID: pin,
                account: irc.account,
                permissions,
                origin: (source) =>
                  source.origin &&
                  [
                    primary.key,
                    ...relatedTeams.map((team) => team.key),
                  ].includes(source.origin.botKey)
                    ? fleetOrigin(store, pin, source)
                    : undefined,
                allowDispatch:
                  irc.fleetPolicy?.capabilities.includes("dispatch") === true,
                authorize: async (caller, signal, request) => {
                  const { action } = fleetRequestAction(request);
                  for (const key of [
                    primary.key,
                    ...relatedTeams.map((team) => team.key),
                  ]) {
                    for (const job of store.permissionCandidates(key)) {
                      if (
                        job.input &&
                        (await entry.resource.backend.toolBelongsToInput?.(
                          pin,
                          caller.messageID,
                          job.input,
                          signal,
                          {
                            agent: caller.agent,
                            id: caller.id,
                            tool: action,
                            input: request.input,
                          },
                        ))
                      )
                        return;
                    }
                  }
                  throw new Error("Fleet caller is not an active native input");
                },
                send: async (target, text, signal) => {
                  await sendFleetAssignment(
                    primary.client,
                    target.channel,
                    text,
                    () => open,
                    signal,
                  );
                },
                status: () => ({
                  account: irc.account,
                  connected: ship.registrations.map((registration) => ({
                    id: registration.id,
                    channels: irc.channels.filter((channel) =>
                      registration.client.inChannel(channel),
                    ),
                  })),
                }),
              }),
            ),
            (control) => release(log, "Fleet control", () => control.close()),
          );
          ship.sourceRecorder = (source) => {
            control.recordSource(source);
          };
          for (const team of relatedTeams)
            team.sourceRecorder = (source) => {
              control.recordSource(source);
            };
          if (control.resultsEnabled) {
            ship.assignmentRecorder = (input, fold) =>
              control.assignment(input, fold);
            const results = new FleetResults({
              control,
              store,
              botKey: primary.key,
              sessionID: pin,
              account: irc.account,
              backend: entry.resource.backend,
            });
            workers.push({
              key: `${primary.key}:fleet-results`,
              work: supervise(
                log.child({ fleetResults: true }),
                "gateway",
                (signal) => results.work(signal),
              ),
            });
          }
        }
        let closing: Promise<void> | undefined;
        const close = () => (closing ??= ship.close());
        connections.push(close);
        yield* Effect.addFinalizer(() => closeIntake(close));
        ship.start(() => open);
        log.info({ irc: irc.id }, "IRC connecting");
      }
      for (const team of teamsRegistrations) {
        yield* Effect.promise(() => team.start(() => open));
        log.info({ teams: team.config.id }, "Teams listener ready");
      }
      if (config.dashboard) {
        // Before the worker fork: a bind failure is an ordinary startup
        // failure. Released after workers drain and before backends close.
        const viewers = new AbortController();
        yield* Effect.acquireRelease(
          Effect.promise(async () =>
            startDashboard({
              socket: join(config.dataDirectory, "dashboard.sock"),
              source: dashboardSource(ships, store, cronStore),
              html: await Bun.file(
                new URL("../templates/dashboard/index.html", import.meta.url),
              ).text(),
              signal: viewers.signal,
              log,
            }),
          ),
          (dashboard) =>
            Effect.sync(() => viewers.abort()).pipe(
              Effect.andThen(release(log, "Dashboard", () => dashboard.stop())),
              Effect.timeoutOption("5 seconds"),
            ),
        );
        log.info("Dashboard listening");
      }
      // Dynamic backend resources close after worker interruption, before the
      // stores. The single finalizer also owns later roster additions.
      const addedResources: Registration[] = [];
      yield* Effect.addFinalizer(() =>
        Effect.all(
          addedResources.map((entry) =>
            release(entry.registration.log, "Resource", entry.resource.close),
          ),
          { concurrency: "unbounded", discard: true },
        ),
      );
      // Registered after backends: shutdown interrupts every worker first.
      const fibers = yield* FiberMap.make<string, void>();
      for (const worker of workers)
        yield* FiberMap.run(fibers, worker.key, worker.work);
      if (reload) {
        const apply = async (candidate: ReloadCandidate) => {
          const staged: {
            entry: Registration;
            start: Deferred.Deferred<void>;
          }[] = [];
          const paused: Gateway[] = [];
          let committed = false;
          try {
            const bots = candidate.config.bots.map((next) => {
              const publish = botBindings.get(next.id);
              if (!publish) throw new ReloadRejected("unavailable");
              return {
                publish,
                next,
                transcriber: next.transcription
                  ? createTranscriber(next.transcription)
                  : undefined,
              };
            });
            const plans = [];
            for (const next of candidate.config.irc) {
              const binding = ircBindings.get(next.id);
              if (!binding) throw new ReloadRejected("unavailable");
              const plan = binding.ship.prepareReload(
                next,
                candidate.environment,
              );
              for (const registration of plan.added) {
                const entry = await buildRegistration(registration, next);
                const start = Deferred.makeUnsafe<void>();
                staged.push({ entry, start });
                // A staged worker cannot recover or process anything until the
                // synchronous commit publishes the whole candidate.
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
              }
              plans.push({
                binding,
                plan,
                next,
                transcriber: next.transcription
                  ? createTranscriber(next.transcription)
                  : undefined,
              });
            }
            if (!open || requests.signal.aborted)
              throw new ReloadRejected("unavailable");
            for (const { binding, plan } of plans)
              for (const registration of plan.removed) {
                const entry = binding.entries.get(registration.key);
                if (!entry) throw new ReloadRejected("unavailable");
                entry.gateway.pause();
                paused.push(entry.gateway);
              }
            if (paused.some((gateway) => !gateway.isIdle()))
              throw new ReloadRejected("busy");
            // Resolve every entry and namespace before publishing anything.
            const updates = plans.flatMap(({ binding, plan, transcriber }) => {
              const removed = new Set(plan.removed);
              const registrations = [
                ...binding.ship.registrations.filter(
                  (registration) => !removed.has(registration),
                ),
                ...plan.added,
              ];
              return registrations.map((registration) => {
                const entry =
                  staged.find(
                    ({ entry }) => entry.registration === registration,
                  )?.entry ?? binding.entries.get(registration.key);
                if (!entry || entry.gateway.key !== registration.transport.key)
                  throw new ReloadRejected("unavailable");
                return { binding, registration, entry, transcriber };
              });
            });
            // No awaits: publish all access/settings and roster references in
            // one JS turn. Admission cannot observe a half-applied candidate.
            for (const { binding, plan } of plans)
              plan.commit(
                (key) => binding.entries.get(key)?.gateway.isIdle() ?? false,
              );
            for (const bot of bots) bot.publish(bot.next, bot.transcriber);
            for (const {
              binding,
              registration,
              entry,
              transcriber,
            } of updates) {
              entry.gateway.reconfigure(
                registration.settings,
                transcriber,
                registration.transport,
              );
              binding.entries.set(registration.key, entry);
            }
            committed = true;
            for (const { entry, start } of staged) {
              addedResources.push(entry);
              Effect.runSync(Deferred.succeed(start, undefined));
            }
            // Removed members are already detached. They were idle, so worker
            // cancellation and cleanup cannot discard queued or active work.
            for (const { binding, plan } of plans) {
              for (const registration of plan.removed) {
                const entry = binding.entries.get(registration.key);
                binding.entries.delete(registration.key);
                await Effect.runPromise(
                  FiberMap.remove(fibers, registration.key),
                ).catch(() => log.warn("Retired worker cleanup failed"));
                await entry?.resource
                  .close()
                  .catch(() => log.warn("Retired backend cleanup failed"));
              }
              await plan
                .retire()
                .catch(() => log.warn("Retired IRC cleanup failed"));
            }
          } finally {
            if (!committed) {
              for (const gateway of paused) gateway.pause(false);
              for (const { entry } of staged) {
                await Effect.runPromise(
                  FiberMap.remove(fibers, entry.registration.key),
                );
                await entry.resource
                  .close()
                  .catch(() => log.warn("Staged backend cleanup failed"));
              }
            }
          }
        };
        const unsubscribe = reload.listen(apply);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            unsubscribe();
            reload.close();
          }),
        );
      }
      // LIFO: close intake and abort reload preparation before workers drain.
      yield* Effect.addFinalizer(() => closeIntake());
      started = true;
      log.info("Stargate ready");
      // Readiness record for maintenance health checks; never fatal.
      yield* Effect.promise(() =>
        writeReady(config.dataDirectory).then(
          (version) => {
            // Only matters where maintenance manages Stargate releases.
            if (version === null && config.maintenance?.stargate)
              log.warn(
                "This Stargate directory has no valid .stargate-release.json; the readiness record has no version and maintenance cannot verify an update. Install releases with stargate maintenance update or adopt.",
              );
          },
          () => log.warn("Readiness record not written"),
        ),
      );
      yield* Effect.raceFirst(
        Deferred.await(stopped),
        Effect.callback<void>((resume) => {
          const stop = () => resume(Effect.void);
          if (shutdown.aborted) return stop();
          shutdown.addEventListener("abort", stop, { once: true });
          return Effect.sync(() => shutdown.removeEventListener("abort", stop));
        }),
      );
    }),
  );
  // After startup, any failure, including a failed release, is a runtime
  // stop, not a startup failure. The raw cause is never exposed.
  return program.pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      return started &&
        !Cause.hasInterruptsOnly(cause) &&
        !(error instanceof RuntimeStopped)
        ? Effect.fail(new RuntimeStopped({ worker: "runtime" }))
        : Effect.failCause(cause);
    }),
  );
}

export async function start(configPath: string) {
  process.umask(0o077);
  const baseEnvironment = { ...process.env };
  const initial = await readReloadCandidate(configPath, baseEnvironment);
  // Startup still supplies companion references to backend modules. Reload
  // candidates never mutate process.env or connected transport credentials.
  for (const [key, value] of Object.entries(initial.environment))
    if (process.env[key] === undefined && value !== undefined)
      process.env[key] = value;
  const log = pino({ level: "info" });
  const reload = new ConfigReload(
    initial,
    () => readReloadCandidate(configPath, baseEnvironment),
    log,
  );
  const controller = new AbortController();
  const stop = () => controller.abort();
  const unlisten = listenForReload(reload);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await Effect.runPromise(
      serve(initial.config, log, controller.signal, defaults, reload),
    );
  } finally {
    unlisten();
    reload.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
