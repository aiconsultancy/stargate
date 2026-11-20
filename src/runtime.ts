import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";
import {
  Cause,
  Data,
  Deferred,
  Effect,
  FiberMap,
  Result,
  Schema,
} from "effect";
import pino, { type Logger } from "pino";
import { diffEvents } from "./api/v1/diff";
import { gatewayVersion } from "./api/v1/gateway";
import { createApiV1Source } from "./api/v1/projection";
import { startApiV1Server } from "./api/v1/server";
import {
  type AgentBackend,
  type BackendContext,
  createBackend,
} from "./backend";
import { OpenCodeBackend } from "./backends/opencode";
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
import {
  type DashboardShip,
  dashboardSource,
  ircDashboardShip,
  teamsDashboardShip,
} from "./dashboard-source";
import { abortable } from "./effect";
import { FleetControl } from "./fleet/control";
import { fleetRequestAction } from "./fleet/permissions";
import { FleetResults, fleetOrigin } from "./fleet/results";
import { sendFleetAssignment } from "./fleet-irc";
import { Gateway, type SlackDelivery } from "./gateway";
import { createHealthReader } from "./health";
import { controlInteractions } from "./interactions";
import { type IrcRegistration, IrcShip } from "./irc/ship";
import { DrainRuntime } from "./maintenance-drain";
import { discoverCrews } from "./nightly/crews";
import { MaintenanceOutbox } from "./nightly/outbox";
import type { Ready } from "./nightly/ready";
import { packageDirectory, runningVersion, writeReady } from "./nightly/ready";
import { NotificationStore } from "./notification-store";
import { notificationKey } from "./notifications";
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
import type { ConnectionState } from "./slack-connection";
import { Store } from "./store";
import { TeamsRegistration } from "./teams/registration";
import { createTranscriber } from "./transcribers/azure-openai";
import {
  buildUpdateSnapshot,
  type UpdateReceipt,
  type UpdateSnapshot,
} from "./update-notice";

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
  readonly worker: "gateway" | "cron" | "runtime" | "transport";
}> {}

/** One registration's Slack surface: intake, Web API delivery and modals. */
export interface SlackApp extends SlackDelivery, CronDelivery {
  identity(signal?: AbortSignal): Promise<Identity>;
  readonly connectionState?: ConnectionState;
  watch?(): Promise<void>;
  /** Slack `users.info`; required for peer captain admission. */
  userInfo?(user: string, signal: AbortSignal): Promise<unknown>;
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
  irc?(config: IrcConfig, store: Store, log: Logger): Promise<IrcShip>;
  /** Short test-only outage/observation timings; never a host flag. */
  connectionTiming?: { outageMs: number; pollMs: number };
  /** Host maintenance drain. Absent in tests, so nothing touches host state. */
  drain?: { directory?: string };
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
  for (const ship of ships)
    if (ship.backend instanceof OpenCodeBackend)
      return ship.backend.serverVersion(signal);
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
        if (config.dashboardSocket) {
          const path = relative(
            config.dataDirectory,
            config.dashboardSocket.path,
          );
          if (
            path === "" ||
            (!isAbsolute(path) && path !== ".." && !path.startsWith("../"))
          )
            throw new Error(
              "Shared dashboard socket must be outside the private data directory",
            );
        }
        await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
        await chmod(config.dataDirectory, 0o700);
      });
      const lock = join(config.dataDirectory, "instance.sqlite");
      yield* Effect.acquireRelease(
        Effect.sync(() => lockInstance(lock)),
        (lock) => Effect.sync(() => lock.close()),
      );
      yield* Effect.promise(() =>
        rm(join(config.dataDirectory, "ready.json"), { force: true }),
      );
      const transportSources: (() => NonNullable<Ready["transports"]>)[] = [];
      const transportSnapshot = () =>
        transportSources.flatMap((read) => read());
      const connectionTiming = dependencies.connectionTiming ?? {
        outageMs: 600_000,
        pollMs: 250,
      };
      const store = yield* Effect.acquireRelease(
        Effect.sync(
          () => new Store(join(config.dataDirectory, "stargate.sqlite")),
        ),
        (store) => Effect.sync(() => store.close()),
      );
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
                warn: (message) => log.warn(message),
                ...(dependencies.drain?.directory
                  ? { directory: dependencies.drain.directory }
                  : {}),
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
        worker: "gateway" | "cron" | "transport",
        work: (signal: AbortSignal) => Promise<void>,
      ) =>
        abortable(work).pipe(
          Effect.catchCause(() => {
            botLog.error(
              worker === "gateway"
                ? "Worker stopped unexpectedly"
                : worker === "cron"
                  ? "Cron worker stopped unexpectedly"
                  : "Transport stopped unexpectedly",
            );
            return Deferred.fail(stopped, new RuntimeStopped({ worker }));
          }),
        );
      const workers: { key: string; work: Effect.Effect<void> }[] = [];
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
          )
            return;
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
          undefined,
          bot.backend.type === "opencode" && bot.backend.sessionID
            ? (channel, thread) => {
                const preferences = new NotificationStore(
                  join(config.dataDirectory, "notifications.sqlite"),
                );
                try {
                  return preferences.status(
                    notificationKey(currentBot, identity),
                    channel,
                    thread,
                  );
                } finally {
                  preferences.close();
                }
              }
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
            listMutes: () => {
              const preferences = new NotificationStore(
                join(config.dataDirectory, "notifications.sqlite"),
              );
              try {
                const result = preferences.operate(
                  notificationKey(currentBot, identity),
                  { op: "list" },
                  { id: "meta-list", caller: "gateway", now: Date.now },
                );
                if (result.op !== "list") throw new Error("Expected mute list");
                return result;
              } finally {
                preferences.close();
              }
            },
          },
          noticeFor(
            backend,
            bot.backend.type === "opencode" ? bot.backend.url : bot.id,
          ),
          drain,
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
          (body, ack) => gateway.configInteraction(body, ack, () => open),
        );
        yield* Effect.promise(() =>
          slack.start(
            async (body) => open && gateway.receive(body, () => open),
            botLog,
            interactions,
            () => open,
            AbortSignal.any([shutdown, requests.signal]),
          ),
        );
        slackStarted = true;
        if (slack.watch)
          workers.push({
            key: `transport:${bot.id}`,
            work: supervise(
              botLog,
              "transport",
              () => slack.watch?.() ?? Promise.resolve(),
            ),
          });
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
                ...(entry.resource.backend.startReview &&
                entry.resource.backend.readReview
                  ? {
                      nativeReviews: {
                        startReview: (binding, signal) =>
                          entry.resource.backend.startReview?.(
                            binding,
                            signal,
                          ) ??
                          Promise.reject(
                            new Error("Review backend unavailable"),
                          ),
                        readReview: (binding, signal) =>
                          entry.resource.backend.readReview?.(
                            binding,
                            signal,
                          ) ??
                          Promise.reject(
                            new Error("Review backend unavailable"),
                          ),
                      },
                    }
                  : {}),
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
                        return {
                          botKey: job.botKey,
                          eventId: job.eventId,
                          sessionID: pin,
                          inputID: job.input,
                        };
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
            if (registration.client.registered) seen.add(id);
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
      if (config.dashboard) {
        // Before the worker fork: a bind failure is an ordinary startup
        // failure. Released after workers drain and before backends close.
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
      if (config.api) {
        // Like the dashboard: a bind failure is an ordinary startup failure.
        const api = config.api;
        const viewers = new AbortController();
        yield* Effect.acquireRelease(
          Effect.promise(async () =>
            startApiV1Server({
              config: api,
              dataDirectory: config.dataDirectory,
              source: createApiV1Source({
                dashboard: dashboardSource(ships, store, cronStore),
                config: () => reload?.current.config ?? config,
                dataDirectory: config.dataDirectory,
              }),
              diff: diffEvents,
              gateway: {
                version: await gatewayVersion(),
                startedAt: Math.round(performance.timeOrigin),
                opencodeVersion: (signal) => openCodeVersion(ships, signal),
              },
              signal: viewers.signal,
            }),
          ),
          (server) =>
            Effect.sync(() => viewers.abort()).pipe(
              Effect.andThen(release(log, "Fleet API", () => server.stop())),
              Effect.timeoutOption("5 seconds"),
            ),
        );
        log.info({ listen: api.listen }, "Fleet API listening");
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
      if (config.notifications?.updateNotice)
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
              const plan = await binding.ship.prepareReload(
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
            const updates = plans.flatMap(
              ({ binding, plan, transcriber, next }) => {
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
                  if (
                    !entry ||
                    entry.gateway.key !== registration.transport.key
                  )
                    throw new ReloadRejected("unavailable");
                  return { binding, registration, entry, transcriber, next };
                });
              },
            );
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
              if (!ships.includes(entry.dashboard)) ships.push(entry.dashboard);
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
                if (entry) {
                  const index = ships.indexOf(entry.dashboard);
                  if (index >= 0) ships.splice(index, 1);
                }
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
      yield* Effect.promise(async () => {
        const deadline = Date.now() + connectionTiming.outageMs;
        while (
          transportSnapshot().length &&
          !transportSnapshot().some(
            (transport) => transport.state === "connected",
          )
        ) {
          if (Date.now() >= deadline)
            throw new Error("No transport connected before readiness deadline");
          await delay(connectionTiming.pollMs, undefined, { signal: shutdown });
        }
      });
      started = true;
      log.info("Stargate ready");
      const updateReceipts: UpdateReceipt[] = [];
      if (updateSnapshot)
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
                  updateSnapshot
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
                  updateSnapshot
                )
                  updateReceipts.push(
                    ...(await backend.crewUpdateNotice(updateSnapshot, signal)),
                  );
              } catch {
                log.warn("Update notice unavailable");
              }
            }),
          );
        });
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
              if (version === null && config.maintenance?.stargate)
                log.warn(
                  "This Stargate directory has no valid .stargate-release.json; the readiness record has no version and maintenance cannot verify an update. Install releases with stargate maintenance update or adopt.",
                );
            },
            () => log.warn("Readiness record not written"),
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
            if (signal.aborted) break;
            const transports = transportSnapshot();
            const next = JSON.stringify(transports);
            if (next !== last) {
              await publishReady(transports);
              last = next;
            }
            if (
              transports.length &&
              !transports.some((transport) => transport.state === "connected")
            ) {
              lostSince ??= Date.now();
              if (Date.now() - lostSince >= connectionTiming.outageMs)
                throw new Error(
                  "No transport connected before outage deadline",
                );
            } else lostSince = undefined;
          }
        }),
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
      if (shutdown.aborted && !started) return Effect.void;
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
