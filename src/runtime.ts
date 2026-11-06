import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import pino from "pino";
import { createBackend } from "./backend";
import { loadConfig, secret } from "./config";
import { CronScheduler } from "./cron";
import { CronStore } from "./cron-store";
import { CronUI } from "./cron-ui";
import { Gateway } from "./gateway";
import { botKey } from "./routing";
import { SlackConnection } from "./slack";
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

export async function start(configPath: string) {
  process.umask(0o077);
  await loadEnvironment(configPath);
  const config = await loadConfig(configPath);
  await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(config.dataDirectory, 0o700);
  const lock = lockInstance(join(config.dataDirectory, "instance.sqlite"));
  const log = pino({ level: "info" });
  const store = new Store(join(config.dataDirectory, "pogo.sqlite"));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const resources: { close(): Promise<void> }[] = [];
  const workers: Promise<void>[] = [];
  let cronStore: CronStore | undefined;
  try {
    cronStore = new CronStore(join(config.dataDirectory, "cron.sqlite"));
    const identities = new Set<string>();
    for (const bot of config.bots) {
      const botLog = log.child({ bot: bot.id });
      const slack = new SlackConnection(
        secret(bot.slack.appTokenEnv),
        secret(bot.slack.botTokenEnv),
        botLog,
      );
      resources.push(slack);
      const identity = await slack.identity();
      const key = JSON.stringify([identity.team, identity.user]);
      if (identities.has(key))
        throw new Error("Two registrations use the same Slack bot");
      identities.add(key);
      const namespace = createHash("sha256")
        .update(botKey(bot, identity))
        .digest("hex");
      const dataDirectory = join(config.dataDirectory, bot.id, namespace);
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      const backend = await createBackend(bot.backend, { dataDirectory });
      resources.push(backend);
      const gateway = new Gateway(bot, identity, store, backend, slack, botLog);
      const cronUI = new CronUI(bot, identity, cronStore, slack.cronUI, botLog);
      const cron = new CronScheduler(
        bot,
        identity,
        cronStore,
        gateway,
        slack,
        botLog,
      );
      await slack.start(
        (body) => !controller.signal.aborted && gateway.accept(body),
        botLog,
        {
          command: (body, ack) => cronUI.command(body, ack),
          interactive: async (body, ack) => {
            if (gateway.cancel(body)) await ack();
            else await cronUI.interactive(body, ack);
          },
        },
      );
      const worker = gateway.work(controller.signal).catch(() => {
        botLog.error("Worker stopped unexpectedly");
        controller.abort();
      });
      workers.push(worker);
      workers.push(
        cron.work(controller.signal).catch(() => {
          botLog.error("Cron worker stopped unexpectedly");
          controller.abort();
        }),
      );
      botLog.info("Bot connected");
    }
    log.info("Pogo ready");
    if (!controller.signal.aborted)
      await new Promise<void>((resolve) =>
        controller.signal.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
  } finally {
    controller.abort();
    await Promise.all(workers);
    for (const resource of resources.reverse())
      await resource.close().catch(() => log.warn("Resource cleanup failed"));
    cronStore?.close();
    store.close();
    lock.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
