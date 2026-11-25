import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  Cause,
  Data,
  Deferred,
  Effect,
  FiberMap,
  Result,
  Schema,
  Scope,
} from "effect";
import pino, { type Logger } from "pino";
import {
  createActivityHub,
  startRuntimeApi,
} from "../observability/dashboard/api/v1/runtime-api";
import type { AgentBackend, BackendContext } from "../backends/backend";
import { createBackend, openCodeServerVersion } from "../backends/factory";
import {
  type BackendConfig,
  type BotConfig,
  type Config,
  type IrcConfig,
  secret,
} from "../config";
import { officerFleetSockets } from "../config/composition";
import { ConfigReload, readReloadCandidate } from "./config-reload";
import { NotificationShutdown } from "./notification-shutdown";
import type { IrcBinding, IrcRuntimeRegistration } from "./irc-reload";
import { reloadTransaction } from "./reload-transaction";
import type { CrewUIApi } from "../transports/slack/crew-ui";
import { CrewUI } from "../transports/slack/crew-ui";
import {
  type CronDelivery,
  CronScheduler,
  type CronServices,
} from "../automation/cron/index";
import { CronStore } from "../automation/cron/store";
import { CronUI, type CronUIApi } from "../automation/cron/ui";
import { startDashboard } from "../observability/dashboard/dashboard";
import {
  type DashboardShip,
  dashboardSource,
  ircDashboardShip,
  teamsDashboardShip,
} from "../observability/dashboard/dashboard-source";
import { sendDispatchAnswer } from "../coordination/fleet/dispatch/irc";
import { startAgentDispatch } from "../coordination/fleet/dispatch/start";
import type {
  SubspaceAgentsHost,
  SubspaceAgentsRuntime,
} from "../subspace/start";
import { abortable } from "../lib/effect";
import {
  FleetControl,
  type FleetControlOptions,
} from "../coordination/fleet/control";
import { fleetRequestAction } from "../coordination/fleet/permissions";
import { peerMessageInputSchema } from "../coordination/fleet/protocol";
import { FleetResults, fleetOrigin } from "../coordination/fleet/results";
import {
  sendFleetAssignment,
  sendFleetPeerMessage,
} from "../coordination/fleet/fleet-irc";
import { Gateway } from "../gateway/gateway";
import type { TransportDelivery } from "../gateway/ports";
import { createHealthReader } from "../observability/health/health";
import { controlInteractions } from "../transports/slack/interactions";
import { SlackAdmission } from "../transports/slack/admission";
import { type IrcRegistration, IrcShip, ircKey } from "../transports/irc/ship";
import { templatesDirectory } from "../lib/installation-paths";
import { DrainRuntime } from "../automation/maintenance/maintenance-drain";
import { discoverCrews } from "../automation/maintenance/nightly/crews";
import { MaintenanceOutbox } from "../automation/maintenance/nightly/reports/outbox";
import type { Ready } from "../automation/maintenance/nightly/update/ready";
import {
  packageDirectory,
  runningVersion,
  writeReady,
} from "../automation/maintenance/nightly/update/ready";
import { notificationKey } from "../notifications/preferences/notifications";
import { notificationQueries } from "../notifications/preferences/queries";
import {
  type SlackRegistration,
  resolveDestinations,
} from "../notifications/ingest/binding";
import {
  coreLimits,
  notifyConfigError,
  notifyEnabled,
} from "../notifications/ingest/config";
import { notificationRoutes } from "../notifications/ingest/http";
import { ShuttingDown } from "../notifications/ingest/model";
import { makeNotifications } from "../notifications/ingest/notifications";
import type { NotificationSink } from "../notifications/ingest/sink";
import {
  type NotificationSlack,
  slackNotificationSink,
} from "../notifications/ingest/slack";
import { PairingUI } from "../transports/slack/pairing";
import { PeerDirectory } from "../gateway/peers";
import { quotaWorkers } from "./usage-guard";
import {
  type Identity,
  backendFingerprint,
  botKey,
  isAllowedChannel,
} from "../gateway/routing";
import {
  SlackConnection,
  type SlackInteractions,
} from "../transports/slack/slack";
import { openStore } from "./open-store";
import type { Store } from "../gateway/store";
import { TeamsRegistration } from "../transports/teams/registration";
import { createTranscriber } from "../chat/transcription/startup";
import {
  type UpdateReceipt,
  type UpdateSnapshot,
  buildUpdateSnapshot,
} from "../automation/maintenance/update-notice";

const normalisePeerInput = Schema.decodeUnknownSync(peerMessageInputSchema, {
  onExcessProperty: "error",
});

/** Bind fleet calls to an executing native input and matching tool payload. */
function fleetAuthorizer(
  store: Pick<Store, "permissionCandidates">,
  backend: Pick<AgentBackend, "toolBelongsToInput">,
  pin: string,
  keys: readonly string[],
): FleetControlOptions["authorize"] {
  return async (caller, signal, request) => {
    const { action } = fleetRequestAction(request);
    const peerMessage = request.operation === "peer-message";

    const expected = {
      agent: caller.agent,
      id: caller.id,
      tool: peerMessage ? "stargate_dm" : action,
      input: request.input,
      ...(peerMessage && { normaliseInput: normalisePeerInput }),
    };

    for (const key of keys) {
      for (const job of store.permissionCandidates(key)) {
        if (
          job.input &&
          (await backend.toolBelongsToInput?.(
            pin,
            caller.messageID,
            job.input,
            signal,
            expected,
          ))
        ) {
          return {
            botKey: job.botKey,
            eventId: job.eventId,
            sessionID: pin,
            inputID: job.input,
          };
        }
      }
    }

    throw new Error("Fleet caller is not an active native input");
  };
}

export function lockInstance(path: string) {
  const lock = new Database(path, { create: true });

  try {
    lock.run("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");

    return lock;
  } catch {
    lock.close();
    throw new Error("Stargate is already using this data directory");
  }
}

/** Stargate failed after startup; the service manager should restart it. */
export class RuntimeStopped extends Data.TaggedError("RuntimeStopped")<{
  readonly worker: "gateway" | "cron" | "runtime" | "transport";
}> {}

/** One registration's Slack surface: intake, Web API delivery and modals. */
export interface SlackApp extends TransportDelivery, CronDelivery {
  notification?: NotificationSlack["notification"];
  identity(signal?: AbortSignal): Promise<Identity>;
  readonly connectionState?: SlackConnection["connectionState"];
  watch?(): Promise<void>;
  start(
    accept: (body: unknown) => boolean | Promise<boolean>,
    log: Logger,
    interactions: SlackInteractions,
    open: () => boolean,
    signal?: AbortSignal,
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
  irc?: typeof IrcShip.create;
  /** Short test-only outage/observation timings; never a host flag. */
  connectionTiming?: { outageMs: number; pollMs: number };
  /** Host maintenance drain. Absent in tests, so nothing touches host state. */
  drain?: { directory?: string };
  /** Tests only: agent dispatch's Subspace API transport and environment. */
  agentDispatch?: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv };
  /** Tests only: Subspace agent identity's API transport, environment and socket lock. */
  subspaceAgents?: Pick<SubspaceAgentsHost, "fetch" | "env" | "ownership">;
  /** Isolated notification fixtures only; not operator configuration. */
  notification?: {
    environment?: NodeJS.ProcessEnv;
    shutdownGraceMs?: number;
    terminate?: () => never;
    sink?: NotificationSink;
  };
};

/** Programmatic callers may omit transports they do not use. */
export type ServeConfig = Omit<Config, "irc" | "teams" | "notifications"> & {
  notifications?: Config["notifications"];
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
  drain: {},
};

const release = (log: Logger, name: string, close: () => unknown) =>
  Effect.promise(async () => {
    try {
      await close();
    } catch {
      log.warn(`${name} cleanup failed`);
    }
  });

/** The connected OpenCode server's version, from the first OpenCode ship. */
async function openCodeVersion(
  ships: readonly DashboardShip[],
  signal: AbortSignal,
): Promise<string | null> {
  for (const ship of ships) {
    const version = openCodeServerVersion(ship.backend, signal);

    if (version) {
      return version;
    }
  }

  return null;
}

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

/** Each registration's backend, with its Fleet API turn activity recorder. */
function registrationBackends(
  config: ServeConfig,
  log: Logger,
  dependencies: RuntimeDependencies,
) {
  // Officer turn activity is collected only for the Fleet API to serve.
  const activity = config.api ? createActivityHub() : undefined;

  return subspaceAgents(config, log, dependencies).pipe(
    Effect.map((bridged) => ({
      activity,
      irc: (irc: IrcConfig, store: Store) =>
        (dependencies.irc ?? IrcShip.create)(irc, store, log, {
          ...(bridged.upload && { subspaceUpload: bridged.upload }),
        }),
      create: (
        registration: { id: string; backend: BackendConfig },
        dataDirectory: string,
      ) =>
        dependencies.backend(
          bridged.backend(registration.id, registration.backend),
          {
            dataDirectory,
            ...(activity && { activity: activity.recorder(registration.id) }),
          },
        ),
    })),
  );
}

/** Outage and observation timings outside tests. */
const defaultConnectionTiming = { outageMs: 600_000, pollMs: 250 } as const;

/**
 * Officers' Subspace API identity, only when `subspaceAgents.enabled` is
 * true: the module is loaded then and not otherwise. Absent or disabled,
 * nothing is created, opened, logged or contacted, and every backend
 * configuration passes through unchanged.
 */
function subspaceAgents(
  config: ServeConfig,
  log: Logger,
  dependencies: RuntimeDependencies,
): Effect.Effect<
  Pick<SubspaceAgentsRuntime, "backend"> &
    Partial<Pick<SubspaceAgentsRuntime, "upload">>,
  never,
  Scope.Scope
> {
  const section = config.subspaceAgents;

  if (!section?.enabled) {
    return Effect.succeed({
      backend: (_registration, backend) => backend,
    });
  }

  return Effect.acquireRelease(
    Effect.promise(async () =>
      (await import("../subspace/start")).startSubspaceAgents({
        config: section,
        dataDirectory: config.dataDirectory,
        log,
        ...dependencies.subspaceAgents,
      }),
    ),
    (started) => Effect.promise(() => started.close()),
  );
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

  const connectionTiming =
    dependencies.connectionTiming ?? defaultConnectionTiming;

  const program = Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        if (config.dashboardSocket) {
          const path = relative(
            config.dataDirectory,
            config.dashboardSocket.path,
          );

          if (
            path === "" ||
            (!isAbsolute(path) && path !== ".." && !path.startsWith("../"))
          ) {
            throw new Error(
              "Shared dashboard socket must be outside the private data directory",
            );
          }
        }

        await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
        await chmod(config.dataDirectory, 0o700);
      });
      const lock = join(config.dataDirectory, "instance.sqlite");
      yield* Effect.acquireRelease(
        Effect.sync(() => lockInstance(lock)),
        (lock) =>
          Effect.sync(() => {
            lock.close();
          }),
      );
      yield* Effect.promise(() =>
        rm(join(config.dataDirectory, "ready.json"), { force: true }),
      );
      const transportSources: (() => NonNullable<Ready["transports"]>)[] = [];

      const transportSnapshot = () =>
        transportSources.flatMap((read) => read());

      const store = yield* Effect.acquireRelease(
        Effect.sync(() =>
          openStore(join(config.dataDirectory, "stargate.sqlite")),
        ),
        (store) =>
          Effect.sync(() => {
            store.close();
          }),
      );

      // Unchanged backend configuration unless Subspace agents are enabled.
      const backends = yield* registrationBackends(config, log, dependencies);

      // Registered before any worker starts; a failure never stops the gateway.
      const drain = dependencies.drain
        ? yield* Effect.acquireRelease(
            Effect.promise(async () => {
              const control = new DrainRuntime({
                dataDirectory: config.dataDirectory,
                pinnedSessions: () =>
                  [
                    ...config.bots.map((bot) => bot.backend),
                    ...(config.teams ?? []).map((teams) => teams.backend),
                    ...(config.irc ?? []).map((irc) => irc.backend),
                  ].flatMap((backend) =>
                    "sessionID" in backend && backend.sessionID
                      ? [backend.sessionID]
                      : [],
                  ),
                discover: () => discoverCrews(config as Config, true),
                warn: (message) => {
                  log.warn(message);
                },
                ...(dependencies.drain?.directory && {
                  directory: dependencies.drain.directory,
                }),
              });

              await control.start().catch(() => {
                log.warn("Maintenance drain registration unavailable");
              });

              return control;
            }),
            (control) => Effect.promise(() => control.close()),
          )
        : undefined;

      const cronStore = yield* Effect.acquireRelease(
        Effect.sync(
          () => new CronStore(join(config.dataDirectory, "cron.sqlite")),
        ),
        (store) =>
          Effect.sync(() => {
            store.close();
          }),
      );

      // One intake gate for every bot: the first close stops all ACKs, and
      // Modal and pairing reads stop, before any worker drains.
      let open = true;
      const requests = new AbortController();
      const connections: (() => Promise<void>)[] = [];
      const notify = notifyEnabled(config.notify) ? config.notify : undefined;
      const notificationRegistrations: SlackRegistration[] = [];

      let notificationView = {
        notify: config.notify,
        registrations:
          notificationRegistrations as readonly SlackRegistration[],
      };

      const notificationConnections = new Map<string, NotificationSlack>();

      const notificationShutdown = new NotificationShutdown(
        !!notify,
        log,
        dependencies.notification,
      );

      const closeIntake = (only?: () => Promise<void>) =>
        Effect.sync(() => {
          open = false;
          notificationShutdown.closeAdmission();
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
      // Covers startup failure too. No timeout can release the outer lock.
      yield* Effect.addFinalizer(() =>
        Effect.promise(notificationShutdown.stop),
      );

      const supervise = (
        botLog: Logger,
        worker: "gateway" | "cron" | "transport",
        work: (signal: AbortSignal) => Promise<void>,
      ) =>
        abortable(work).pipe(
          Effect.catchCause(() => {
            botLog.error(workerStoppedMessage(worker));

            return Deferred.fail(stopped, new RuntimeStopped({ worker }));
          }),
        );

      const workers: { key: string; work: Effect.Effect<void> }[] = [];

      const quota = quotaWorkers(config, log, (worker) => {
        workers.push(worker);
      });

      let updateSnapshot: UpdateSnapshot | undefined;
      const updateTargets = new Map<AgentBackend, string>();

      const noticeFor = (backend: AgentBackend, scope: string) => {
        const owner = createHash("sha256").update(scope).digest("hex");
        updateTargets.set(backend, owner);

        return async (sessionID: string, signal: AbortSignal) => {
          if (
            !updateSnapshot ||
            !backend.queueUpdateNotice ||
            !backend.updateNoticeContext
          ) {
            return;
          }

          const bounded = AbortSignal.any([signal, AbortSignal.timeout(2000)]);

          const selected = await backend.updateNoticeContext(
            sessionID,
            updateSnapshot,
            bounded,
          );

          return store.updateNotices
            .deliver(
              sessionID,
              selected,
              "queued",
              (id, text) =>
                backend.queueUpdateNotice?.(sessionID, id, text, bounded) ??
                Promise.reject(new Error("Update notice unsupported")),
              owner,
            )
            .then(() => {});
        };
      };

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
            ownedBackend(await backends.create(teams, dataDirectory)),
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
                (message) => {
                  teamLog.warn(message);
                },
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
          undefined,
          undefined,
          noticeFor(
            resource.backend,
            teams.backend.type === "opencode" ? teams.backend.url : teams.id,
          ),
          drain,
        );

        workers.push({
          key: registration.key,
          work: supervise(teamLog, "gateway", (signal) => gateway.work(signal)),
        });
        teamsRegistrations.push(registration);
        ships.push(
          teamsDashboardShip(teams, registration.key, resource.backend),
        );
      }

      for (const bot of config.bots) {
        let currentBot = bot;
        const botLog = log.child({ bot: bot.id });
        const slack = dependencies.slack(bot, botLog);
        const identity = yield* Effect.promise(() => slack.identity(shutdown));
        let slackStarted = false;
        transportSources.push(() => [
          {
            kind: "slack",
            id: bot.id,
            state:
              slack.connectionState ??
              (slackStarted ? "connected" : "connecting"),
          },
        ]);
        const key = JSON.stringify([identity.team, identity.user]);

        if (identities.has(key)) {
          return yield* Effect.die(
            new Error("Two registrations use the same Slack bot"),
          );
        }

        identities.add(key);
        const notificationRegistration = { bot, identity };
        notificationRegistrations.push(notificationRegistration);

        if (notify) {
          if (!slack.notification) {
            return yield* Effect.die(
              new Error("Slack notification delivery is unavailable"),
            );
          }

          notificationConnections.set(bot.id, {
            notification: slack.notification.bind(slack),
          });
        }

        const namespace = createHash("sha256")
          .update(botKey(bot, identity))
          .digest("hex");

        const dataDirectory = join(config.dataDirectory, bot.id, namespace);
        yield* Effect.promise(() =>
          mkdir(dataDirectory, { recursive: true, mode: 0o700 }),
        );

        const resource = yield* Effect.acquireRelease(
          Effect.promise(async () =>
            ownedBackend(await backends.create(bot, dataDirectory)),
          ),
          (resource) => release(botLog, "Resource", resource.close),
        );

        const backend = resource.backend;

        const preferences = notificationQueries(config.dataDirectory, () =>
          notificationKey(currentBot, identity),
        );

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
          undefined,
          bot.backend.type === "opencode" && bot.backend.sessionID
            ? preferences.status
            : undefined,
          {
            health: createHealthReader({
              bot: () => currentBot,
              dataDirectory: config.dataDirectory,
              backend,
              schedules: () => cronStore.report(botKey(currentBot, identity)),
              maintenance: config.maintenance,
            }),
            isHuman: async (user) => {
              try {
                const result = Schema.decodeUnknownResult(
                  Schema.Struct({
                    ok: Schema.Literal(true),
                    user: Schema.Struct({
                      id: Schema.Literal(user),
                      team_id: Schema.Literal(identity.team),
                      is_bot: Schema.Literal(false),
                      deleted: Schema.Literal(false),
                    }),
                  }),
                )(
                  await slack.userInfo?.(
                    user,
                    AbortSignal.any([
                      requests.signal,
                      AbortSignal.timeout(2000),
                    ]),
                  ),
                );

                return Result.isSuccess(result);
              } catch {
                return false;
              }
            },
            listMutes: preferences.listMutes,
          },
          noticeFor(
            backend,
            bot.backend.type === "opencode" ? bot.backend.url : bot.id,
          ),
          drain,
        );

        const cronServices: CronServices = {
          quota: (signal) => {
            if (!backend.cronQuota) {
              throw new Error("Cron quota reader unavailable.");
            }

            return backend.cronQuota(signal);
          },
          model: (input, signal) => {
            if (!backend.cronModel) {
              throw new Error("Cron model validation unavailable.");
            }

            return backend.cronModel(input, signal);
          },
          evaluate: (input, signal) => {
            if (!backend.cronEvaluate) {
              throw new Error("Cron evaluation unavailable.");
            }

            return backend.cronEvaluate(input, signal);
          },
        };

        const cron = new CronScheduler(
          bot,
          identity,
          cronStore,
          gateway,
          slack,
          botLog,
          cronServices,
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

        quota.slack(bot.id, () => currentBot, slack, botLog);

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
          cronServices.model,
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
          (body, ack) => gateway.configInteraction(body, ack, () => open),
        );

        yield* Effect.promise(() =>
          slack.start(
            new SlackAdmission(gateway.slackIntake()).handler(() => open),
            botLog,
            interactions,
            () => open,
            AbortSignal.any([shutdown, requests.signal]),
          ),
        );
        slackStarted = true;

        if (slack.watch) {
          workers.push({
            key: `transport:${bot.id}`,
            work: supervise(
              botLog,
              "transport",
              () => slack.watch?.() ?? Promise.resolve(),
            ),
          });
        }

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
      // Background, and delivery waits for them or retries later.
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
          await backends.create(registration, dataDirectory),
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
            undefined,
            undefined,
            noticeFor(
              resource.backend,
              registration.backend.type === "opencode"
                ? registration.backend.url
                : registration.id,
            ),
            drain,
          );

          registration.stopTurn = (conversation, thread) =>
            gateway.stopTurn(conversation, thread);
          registration.operatorQuestion =
            gateway.operatorQuestion.bind(gateway);
          registration.answerQuestion = (input, control) =>
            gateway.answerQuestion(input, control);

          return {
            registration,
            gateway,
            resource,
            dashboard: ircDashboardShip(registration, irc, resource.backend),
          };
        } catch (error) {
          await resource.close();
          throw error;
        }
      };

      const ircBindings = new Map<string, IrcBinding>();

      for (const irc of config.irc ?? []) {
        const ship = yield* Effect.promise(() => backends.irc(irc, store));

        const entries = new Map<string, IrcRuntimeRegistration>();

        for (const registration of ship.registrations) {
          const entry = yield* Effect.acquireRelease(
            Effect.promise(() => buildRegistration(registration, irc)),
            (entry) =>
              release(registration.log, "Resource", entry.resource.close),
          );

          entries.set(registration.key, entry);
          ships.push(entry.dashboard);
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

          if (!entry || !primary) {
            throw new Error("Fleet primary registration unavailable");
          }

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
                ...(entry.resource.backend.startReview &&
                  entry.resource.backend.readReview && {
                    nativeReviews: {
                      startReview: (binding, signal) =>
                        entry.resource.backend.startReview?.(binding, signal) ??
                        Promise.reject(new Error("Review backend unavailable")),
                      readReview: (binding, signal) =>
                        entry.resource.backend.readReview?.(binding, signal) ??
                        Promise.reject(new Error("Review backend unavailable")),
                    },
                  }),
                authorize: fleetAuthorizer(store, entry.resource.backend, pin, [
                  primary.key,
                  ...relatedTeams.map((team) => team.key),
                ]),
                send: async (target, text, signal) => {
                  await sendFleetAssignment(
                    primary.client,
                    target.channel,
                    text,
                    () => open,
                    signal,
                  );
                },
                peerMessage: (target, input, signal) =>
                  sendFleetPeerMessage(
                    () => ship.routingConfig,
                    primary.client,
                    target,
                    input,
                    () => open,
                    signal,
                  ),
                answer: (offer, answer, reason, signal) =>
                  sendDispatchAnswer(
                    primary.client,
                    offer,
                    answer,
                    reason,
                    () => open,
                    signal,
                  ),
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

          ship.offerRecorder = (offer) => {
            control.recordOffer(offer);
          };

          for (const team of relatedTeams) {
            team.sourceRecorder = (source) => {
              control.recordSource(source);
            };
          }

          if (control.resultsEnabled) {
            ship.assignmentRecorder = (input, fold) =>
              control.assignment(input, fold);
            ship.assignmentPrompt = (dispatchID) =>
              control.reviewAssignmentPrompt(dispatchID);

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
        const seen = new Set<string>();
        transportSources.push(() =>
          ship.registrations.map((registration) => {
            const id = `${irc.id}:${registration.id}`;

            if (registration.client.registered) {
              seen.add(id);
            }

            return {
              kind: "irc",
              id,
              state: registration.client.registered
                ? "connected"
                : seen.has(id)
                  ? "reconnecting"
                  : "connecting",
            };
          }),
        );
        log.info({ irc: irc.id }, "IRC connecting");
      }

      quota.irc(
        (id) => ircBindings.get(id)?.ship.registrations[0]?.client,
        () => open,
      );

      // Off unless enabled: then nothing is opened, listened to or contacted.
      const agentDispatch = yield* Effect.acquireRelease(
        Effect.sync(() =>
          startAgentDispatch({
            config: config.agentDispatch,
            irc: config.irc ?? [],
            ship: (id) => ircBindings.get(id)?.ship,
            dataDirectory: config.dataDirectory,
            allowed: () => open,
            log,
            ...dependencies.agentDispatch,
          }),
        ),
        (started) => Effect.sync(() => started?.close()),
      );

      if (agentDispatch) {
        workers.push({
          key: agentDispatch.key,
          work: supervise(agentDispatch.log, "gateway", (signal) =>
            agentDispatch.run(signal),
          ),
        });
        agentDispatch.log.info("Agent dispatch enabled");
      }

      for (const team of teamsRegistrations) {
        yield* Effect.promise(() => team.start(() => open));
        transportSources.push(() => [
          {
            kind: "teams",
            id: team.config.id,
            state: open ? "connected" : "closed",
          },
        ]);
        log.info({ teams: team.config.id }, "Teams listener ready");
      }

      const notificationDestinations = notify
        ? resolveDestinations(notify, notificationRegistrations)
        : undefined;

      if (config.notify) {
        const error = notifyConfigError(
          config.notify,
          config.bots,
          config.api?.listen,
        );

        if (error) {
          return yield* Effect.die(new Error(error));
        }
      }

      if (config.dashboard) {
        // Before the worker fork: a bind failure is an ordinary startup
        // Failure. Released after workers drain and before backends close.
        const viewers = new AbortController();
        yield* Effect.acquireRelease(
          Effect.promise(async () =>
            startDashboard({
              socket:
                config.dashboardSocket?.path ??
                join(config.dataDirectory, "dashboard.sock"),
              groupAccess: config.dashboardSocket?.groupAccess ?? false,
              source: dashboardSource(ships, store, cronStore),
              html: await Bun.file(
                join(templatesDirectory, "dashboard", "index.html"),
              ).text(),
              signal: viewers.signal,
              log,
            }),
          ),
          (dashboard) =>
            Effect.sync(() => {
              viewers.abort();
            }).pipe(
              Effect.andThen(release(log, "Dashboard", () => dashboard.stop())),
              Effect.timeoutOption("5 seconds"),
            ),
        );
        log.info("Dashboard listening");
      }

      let fleetDashboard: ReturnType<typeof dashboardSource> | undefined;

      // Officers' sockets serve it too, without the listener (docs/api.md#officers).
      if (config.api || officerFleetSockets(config.subspaceAgents).length > 0) {
        // Like the dashboard: a bind failure is an ordinary startup failure.
        const api = config.api;
        const viewers = new AbortController();

        const dashboard = dashboardSource(ships, store, cronStore, Date.now, {
          fleetSignal: viewers.signal,
        });

        fleetDashboard = dashboard;
        notificationShutdown.api = yield* Effect.acquireRelease(
          Effect.promise(async () =>
            startRuntimeApi({
              config: api,
              log,
              dataDirectory: config.dataDirectory,
              projection: {
                requests: (registration, at) => {
                  if (registration.kind !== "irc") {
                    return [];
                  }

                  const cfg = registration.config;

                  return store.requestProgress(
                    ircKey(cfg.id, cfg.server, cfg.account, cfg.backend),
                    undefined,
                    at,
                  );
                },
                // This instance carries the viewers' signal, so shutdown and
                // Reload can cancel the shared crew reads.
                dashboard,
                config: () => reload?.current.config ?? config,
                dataDirectory: config.dataDirectory,
              },
              opencodeVersion: (signal) => openCodeVersion(ships, signal),
              activity: backends.activity,
              signal: viewers.signal,
              ...(notify && {
                composeRoutes: (token: string) => {
                  notificationShutdown.producer = notificationRoutes(
                    notify,
                    dependencies.notification?.environment ??
                      reload?.current.environment ??
                      process.env,
                    token,
                    {
                      publish: (source, input) =>
                        notificationShutdown.core?.publish(source, input) ??
                        Effect.fail(new ShuttingDown()),
                    },
                  );

                  return notificationShutdown.producer.routes;
                },
              }),
            }),
          ),
          (server) =>
            notify
              ? Effect.promise(notificationShutdown.stop)
              : Effect.sync(() => {
                  viewers.abort();
                }).pipe(
                  Effect.andThen(
                    release(log, "Fleet API", () => server.stop()),
                  ),
                  Effect.timeoutOption("5 seconds"),
                ),
        );
      }

      // Dynamic backend resources close after worker interruption, before the
      // Stores. The single finalizer also owns later roster additions.
      const addedResources: IrcRuntimeRegistration[] = [];
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

      if (config.notifications?.updateNotice) {
        updateSnapshot = yield* Effect.promise(async () =>
          buildUpdateSnapshot(
            await runningVersion(),
            config,
            await readFile(
              join(packageDirectory, "CHANGELOG.md"),
              "utf8",
            ).catch(() => ""),
          ),
        );
      }

      for (const worker of workers) {
        yield* FiberMap.run(fibers, worker.key, worker.work);
      }

      if (reload) {
        const unsubscribe = reload.listen(
          reloadTransaction({
            admitting: () => open && !requests.signal.aborted,
            addedResources,
            botBindings,
            buildRegistration,
            fibers,
            fleetDashboard,
            ircBindings,
            log,
            publishNotificationView: (next) => {
              notificationView = {
                notify: next.notify,
                registrations: notificationRegistrations.map(
                  ({ bot, identity }) => ({
                    bot: next.bots.find(({ id }) => id === bot.id) ?? bot,
                    identity,
                  }),
                ),
              };
            },
            ships,
            supervise,
          }),
        );

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            unsubscribe();
            reload.close();
          }),
        );
      }

      // LIFO: close intake and abort reload preparation before workers drain.
      yield* Effect.addFinalizer(() => closeIntake());
      yield* Effect.promise(async () => {
        const deadline = Date.now() + connectionTiming.outageMs;

        while (
          transportSnapshot().length > 0 &&
          !transportSnapshot().some(
            (transport) => transport.state === "connected",
          )
        ) {
          if (Date.now() >= deadline) {
            throw new Error("No transport connected before readiness deadline");
          }

          await delay(connectionTiming.pollMs, undefined, { signal: shutdown });
        }
      });

      if (notify) {
        const destinations = notificationDestinations ?? {};
        notificationShutdown.scope = yield* Scope.make();
        notificationShutdown.core = yield* makeNotifications({
          path: join(config.dataDirectory, "notify.sqlite"),
          destinations,
          subscriptions: notify.subscriptions,
          limits: coreLimits(notify),
          sink:
            dependencies.notification?.sink ??
            slackNotificationSink({
              admitted: destinations,
              current: () => notificationView,
              connections: notificationConnections,
            }),
        }).pipe(Scope.provide(notificationShutdown.scope));
        yield* FiberMap.run(
          fibers,
          "notifications",
          notificationShutdown.core.failure.pipe(
            Effect.catch(() =>
              Deferred.fail(stopped, new RuntimeStopped({ worker: "runtime" })),
            ),
          ),
        );
        // Latest owner also covers failures after acquisition but before ready.
        yield* Effect.addFinalizer(() =>
          closeIntake().pipe(
            Effect.andThen(Effect.promise(notificationShutdown.stop)),
          ),
        );
      }

      started = true;
      log.info("Stargate ready");
      const updateReceipts: UpdateReceipt[] = [];

      if (updateSnapshot) {
        yield* Effect.promise(async () => {
          await Promise.all(
            [...updateTargets].map(async ([backend, scope]) => {
              const signal = AbortSignal.any([
                requests.signal,
                AbortSignal.timeout(10_000),
              ]);

              try {
                if (
                  backend.sessionID &&
                  backend.queueUpdateNotice &&
                  backend.updateNoticeContext &&
                  updateSnapshot !== undefined
                ) {
                  const selected = await backend.updateNoticeContext(
                    backend.sessionID,
                    updateSnapshot,
                    signal,
                  );

                  updateReceipts.push(
                    await store.updateNotices.deliver(
                      backend.sessionID,
                      selected,
                      "queued",
                      (id, text) =>
                        backend.queueUpdateNotice?.(
                          backend.sessionID ?? "",
                          id,
                          text,
                          signal,
                        ) ??
                        Promise.reject(new Error("Update notice unsupported")),
                      scope,
                    ),
                  );
                }

                if (
                  backend.sessionID &&
                  backend.crewUpdateNotice &&
                  updateSnapshot !== undefined
                ) {
                  updateReceipts.push(
                    ...(await backend.crewUpdateNotice(updateSnapshot, signal)),
                  );
                }
              } catch {
                log.warn("Update notice unavailable");
              }
            }),
          );
        });
      }

      // Readiness record for maintenance health checks; never fatal.
      const readyAt = Date.now();
      let readinessWrite = Promise.resolve();

      const publishReady = (transports = transportSnapshot()) => {
        readinessWrite = readinessWrite.then(() =>
          writeReady(
            config.dataDirectory,
            readyAt,
            packageDirectory,
            updateReceipts,
            transports,
          ).then(
            (version) => {
              // Only matters where maintenance manages Stargate releases.
              if (version === null && config.maintenance?.stargate) {
                log.warn(
                  "This Stargate directory has no valid .stargate-release.json; the readiness record has no version and maintenance cannot verify an update. Install releases with stargate maintenance update or adopt.",
                );
              }
            },
            () => {
              log.warn("Readiness record not written");
            },
          ),
        );

        return readinessWrite;
      };

      const initialTransports = transportSnapshot();
      yield* Effect.promise(() => publishReady(initialTransports));
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          publishReady(
            transportSnapshot().map((transport) => ({
              ...transport,
              state: "closed",
            })),
          ),
        ),
      );
      yield* FiberMap.run(
        fibers,
        "transport-readiness",
        supervise(log, "transport", async (signal) => {
          let last = JSON.stringify(initialTransports);
          let lostSince: number | undefined;

          while (!signal.aborted) {
            await delay(connectionTiming.pollMs, undefined, { signal }).catch(
              () => {},
            );

            if (signal.aborted) {
              break;
            }

            const transports = transportSnapshot();
            const next = JSON.stringify(transports);

            if (next !== last) {
              await publishReady(transports);
              last = next;
            }

            if (
              transports.length > 0 &&
              !transports.some((transport) => transport.state === "connected")
            ) {
              lostSince ??= Date.now();

              if (Date.now() - lostSince >= connectionTiming.outageMs) {
                throw new Error(
                  "No transport connected before outage deadline",
                );
              }
            } else {
              lostSince = undefined;
            }
          }
        }),
      );
      yield* Effect.raceFirst(
        Deferred.await(stopped),
        Effect.callback<void>((resume) => {
          const stop = () => {
            resume(Effect.void);
          };

          if (shutdown.aborted) {
            stop();

            return;
          }

          shutdown.addEventListener("abort", stop, { once: true });

          return Effect.sync(() => {
            shutdown.removeEventListener("abort", stop);
          });
        }),
      );
    }),
  );

  // After startup, any failure, including a failed release, is a runtime
  // Stop, not a startup failure. The raw cause is never exposed.
  return program.pipe(
    Effect.catchCause((cause) => {
      if (shutdown.aborted && !started) {
        return Effect.void;
      }

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
  // Candidates never mutate process.env or connected transport credentials.
  const producerReferences = new Set(
    Object.values(initial.config.notify?.adapters ?? {})
      .filter((adapter) => adapter.enabled)
      .flatMap((adapter) => adapter.sources.map((source) => source.tokenEnv)),
  );

  const registrations = [
    ...initial.config.bots,
    ...initial.config.teams,
    ...initial.config.irc,
    ...initial.config.irc.flatMap((registration) => registration.crew),
  ];

  const existingReferences = new Set([
    ...initial.config.bots.flatMap((bot) => [
      bot.slack.appTokenEnv,
      bot.slack.botTokenEnv,
    ]),
    ...initial.config.irc.flatMap((registration) =>
      [registration, ...registration.crew].flatMap((member) =>
        member.passwordEnv ? [member.passwordEnv] : [],
      ),
    ),
    ...registrations.flatMap(({ backend }) => {
      if (backend.type === "opencode") {
        return Object.values(backend.headersEnv);
      }

      if (backend.type === "module") {
        return [];
      }

      if (backend.provider) {
        return [backend.provider.apiKeyEnv];
      }

      return [
        backend.model.startsWith("anthropic/")
          ? "ANTHROPIC_API_KEY"
          : "OPENAI_API_KEY",
      ];
    }),
  ]);

  for (const [key, value] of Object.entries(initial.environment)) {
    if (
      (!producerReferences.has(key) || existingReferences.has(key)) &&
      process.env[key] === undefined &&
      value !== undefined
    ) {
      process.env[key] = value;
    }
  }

  const log = pino({ level: "info" });

  const reload = new ConfigReload(
    initial,
    () => readReloadCandidate(configPath, baseEnvironment, true),
    log,
  );

  const controller = new AbortController();

  const stop = () => {
    controller.abort();
  };

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

function workerStoppedMessage(worker: string) {
  switch (worker) {
    case "gateway":
      return "Worker stopped unexpectedly";
    case "cron":
      return "Cron worker stopped unexpectedly";
    default:
      return "Transport stopped unexpectedly";
  }
}
