import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { Cause, Data, Deferred, Effect } from "effect";
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
  loadConfig,
  secret,
} from "./config";
import type { CrewUIApi } from "./crew-ui";
import { CrewUI } from "./crew-ui";
import { type CronDelivery, CronScheduler } from "./cron";
import { CronStore } from "./cron-store";
import { CronUI, type CronUIApi } from "./cron-ui";
import { abortable } from "./effect";
import { Gateway, type SlackDelivery } from "./gateway";
import { controlInteractions } from "./interactions";
import { PairingUI } from "./pairing";
import { botKey, type Identity } from "./routing";
import { SlackConnection, type SlackInteractions } from "./slack";
import { Store } from "./store";

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
    throw new Error("Pogo is already using this data directory");
  }
}

/** Pogo failed after startup; the service manager should restart it. */
export class RuntimeStopped extends Data.TaggedError("RuntimeStopped")<{
  readonly worker: "gateway" | "cron" | "runtime";
}> {}

/** One registration's Slack surface: intake, Web API delivery and modals. */
export interface SlackApp extends SlackDelivery, CronDelivery {
  identity(): Promise<Identity>;
  start(
    accept: (body: unknown) => boolean,
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
  config: Config,
  log: Logger,
  shutdown: AbortSignal,
  dependencies: RuntimeDependencies = defaults,
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
        Effect.sync(() => new Store(join(config.dataDirectory, "pogo.sqlite"))),
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
      const workers: Effect.Effect<void>[] = [];
      const identities = new Set<string>();
      for (const bot of config.bots) {
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
        const backend = yield* Effect.acquireRelease(
          Effect.promise(() =>
            dependencies.backend(bot.backend, { dataDirectory }),
          ),
          (backend) => release(botLog, "Resource", () => backend.close()),
        );
        const gateway = new Gateway(
          bot,
          identity,
          store,
          backend,
          slack,
          botLog,
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
          supervise(botLog, "gateway", (signal) => gateway.work(signal)),
          supervise(botLog, "cron", (signal) => cron.work(signal)),
        );
        let closing: Promise<void> | undefined;
        const close = () => {
          closing ??= slack.close();
          return closing;
        };
        connections.push(close);
        // Startup failure: close this socket before its backend closes.
        yield* Effect.addFinalizer(() => closeIntake(close));
        yield* Effect.promise(() =>
          slack.start(
            (body) => open && gateway.accept(body),
            botLog,
            controlInteractions(
              new CronUI(bot, identity, cronStore, slack.cronUI, botLog),
              new PairingUI(
                bot,
                identity,
                backend,
                slack.cronUI,
                botLog,
                requests.signal,
              ),
              (body) => gateway.cancel(body),
              new CrewUI(
                bot,
                identity,
                backend,
                slack.crewUI,
                botLog,
                requests.signal,
              ),
            ),
            () => open,
          ),
        );
        botLog.info("Bot connected");
      }
      // Workers start only after every bot connected. A failed connection
      // leaves queued requests queued instead of consuming them as uncertain.
      // One fiber: shutdown interrupts every worker at once.
      yield* Effect.forkScoped(
        Effect.all(workers, { concurrency: "unbounded", discard: true }),
      );
      // Must stay registered after the worker fork: LIFO finalizers then set
      // `open = false` for every bot before any worker drain can block.
      yield* Effect.addFinalizer(() => closeIntake());
      started = true;
      log.info("Pogo ready");
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
  await loadEnvironment(configPath);
  const config = await loadConfig(configPath);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    // Rejects with RuntimeStopped after a worker failure; main sets exit 1.
    await Effect.runPromise(
      serve(config, pino({ level: "info" }), controller.signal),
    );
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
