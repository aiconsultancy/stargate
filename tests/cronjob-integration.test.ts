import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Result, Schema } from "effect";
import pino from "pino";
import { botSchema, configSchema } from "../src/config";
import {
  CronScheduler,
  type ScheduledInput,
  type SchedulerGateway,
} from "../src/automation/cron/index";
import { runCronOperation } from "../src/automation/cron/control";
import { CronStore } from "../src/automation/cron/store";
import {
  type CronjobDefinition,
  readCronjob,
  renderCronjob,
  writeCronjob,
} from "../src/automation/cron/job-files";
import { CronjobManager } from "../src/automation/cron/job-manager";
import { bot, identity } from "./fixtures";

const now = Date.parse("2026-01-01T00:00:00Z");
const signal = new AbortController().signal;
const directories: string[] = [];
const stores: CronStore[] = [];

test("bundled maintenance example is valid and never enabled by default", async () => {
  const root = fileURLToPath(new URL("../cronjobs", import.meta.url));
  expect(await readCronjob(root, "system-maintenance", now)).toMatchObject({
    enabled: false,
    report: "daily",
    schedule: "15 3 * * *",
    skills: ["stargate-cronjobs"],
  });
});

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();

  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(
    join(tmpdir(), "stargate-cronjob-integration-"),
  );

  directories.push(directory);

  const config = Schema.decodeUnknownSync(botSchema)({
    ...bot(),
    cronjobs: {
      directory: join(directory, "cronjobs"),
      channel: "C123",
      user: "U123",
      dailyReport: {},
    },
  });

  const store = new CronStore(join(directory, "cron.sqlite"));
  stores.push(store);
  const manager = new CronjobManager(config, identity, store);
  const scope = { botKey: manager.key, channel: "C123", user: "U123" };

  const definition: CronjobDefinition = {
    name: "maintenance",
    description: "Nightly maintenance",
    schedule: "15 3 * * *",
    timezone: "UTC",
    prompt:
      "Read supporting policy. Update only idle tools. Return verified outcomes.",
    skills: ["stargate-cronjobs"],
    enabled: true,
    report: "daily",
  };

  const jobs: ScheduledInput[] = [];
  let status: "running" | "done" = "running";

  const gateway: SchedulerGateway = {
    enqueueScheduled(input) {
      jobs.push(input);

      return jobs.length;
    },
    scheduledStatus() {
      return status;
    },
    scheduledResult() {
      return {
        text: "Updated tools; proxy activation deferred while busy.",
        status,
      };
    },
  };

  const posts: { channel: string; text: string }[] = [];

  const delivery = {
    async announce(channel: string, text: string) {
      posts.push({ channel, text });

      return "1.000";
    },
  };

  const scheduler = () =>
    new CronScheduler(
      config,
      identity,
      store,
      gateway,
      delivery,
      pino({ level: "silent" }),
    );

  return {
    directory,
    config,
    definition,
    store,
    manager,
    scope,
    jobs,
    posts,
    scheduler,
    delivery,
    complete() {
      status = "done";
    },
  };
}

test("files run silently overnight and share one durable 08:30 UTC report", async () => {
  const f = await fixture();
  const root = f.config.cronjobs?.directory;

  if (!root) throw new Error("Missing fixture root");
  await writeCronjob(root, f.definition, now);
  await writeCronjob(root, { ...f.definition, name: "other-maintenance" }, now);
  const worker = f.scheduler();
  await worker.tick(now, signal);
  await worker.tick(now + 3.25 * 3_600_000, signal);
  expect(f.jobs).toHaveLength(2);
  expect(f.jobs.every((job) => job.deferDelivery && job.thread === "")).toBe(
    true,
  );
  expect(f.jobs[0]?.prompt).toContain(
    "Required agent skills: stargate-cronjobs",
  );
  expect(f.posts).toEqual([]);
  f.complete();
  await worker.tick(now + 4 * 3_600_000, signal);
  await worker.tick(now + 8.5 * 3_600_000 - 1, signal);
  expect(f.posts).toEqual([]);
  await worker.tick(now + 8.5 * 3_600_000, signal);
  expect(f.posts).toHaveLength(1);
  expect(f.posts[0]?.text).toContain("maintenance: done");
  expect(f.posts[0]?.text).toContain("other-maintenance: done");
  expect(f.posts[0]?.text).toContain("proxy activation deferred");
  expect(f.posts[0]?.text).not.toContain(f.definition.prompt);
  await f.scheduler().tick(now + 9 * 3_600_000, signal);
  expect(f.posts).toHaveLength(1);
});

test("paused files allow owner run-now; edits and missing files fail closed", async () => {
  const f = await fixture();
  const root = f.config.cronjobs?.directory;

  if (!root) throw new Error("Missing fixture root");

  const path = await writeCronjob(
    root,
    { ...f.definition, enabled: false },
    now,
  );

  expect(await f.manager.sync(now)).toEqual([]);
  expect(f.store.claimDue(f.manager.key, now + 4 * 3_600_000)).toEqual([]);
  const first = f.store.runNow(f.scope, "maintenance", now, "manual-request");
  expect(first?.manual).toBe(true);
  await f.scheduler().tick(now, signal);
  expect(f.jobs).toHaveLength(1);
  expect(f.posts).toEqual([]);
  await writeFile(
    path,
    renderCronjob({ ...f.definition, enabled: false, prompt: "Changed body" }),
  );
  await f.manager.sync(now + 1000);
  expect(f.store.queued(f.manager.key)[0]?.prompt).toContain(
    f.definition.prompt,
  );
  await unlink(path);
  expect(await f.manager.sync(now + 2000)).toEqual(["maintenance"]);
  expect(() => f.store.runNow(f.scope, "maintenance", now + 2000)).toThrow();
});

test("uncertain daily report is not retried and revoked destinations receive nothing", async () => {
  const f = await fixture();
  f.delivery.announce = async () => {
    throw new Error("private network details");
  };

  const cutoff = now + 8.5 * 3_600_000;
  await f.scheduler().tick(cutoff, signal);
  f.delivery.announce = async (channel, text) => {
    f.posts.push({ channel, text });

    return "2.000";
  };

  await f.scheduler().tick(cutoff + 1000, signal);
  expect(f.posts).toEqual([]);
  f.config.access.deniedChannels.push("C123");
  await f.scheduler().tick(cutoff + 86_400_000, signal);
  expect(f.posts).toEqual([]);
});

test("local control creates idempotent files, binds workspace and admits durable manual runs", async () => {
  const f = await fixture();
  const configPath = join(f.directory, "stargate-test.json");
  await writeFile(
    configPath,
    JSON.stringify({ dataDirectory: f.directory, bots: [f.config] }),
  );

  const dependencies = {
    async identity() {
      return identity;
    },
    now: () => now,
  };

  const binding = {
    configPath,
    bot: f.config.id,
    expectedDirectory: "/workspace",
  };

  const add = {
    op: "add",
    name: "maintenance",
    description: "Nightly maintenance",
    schedule: "15 3 * * *",
    prompt: f.definition.prompt,
    enabled: false,
    report: "daily",
    skills: ["stargate-cronjobs"],
  };

  await runCronOperation(add, binding, signal, dependencies);
  await runCronOperation(add, binding, signal, dependencies);
  expect(f.store.list(f.scope)).toHaveLength(1);

  const result = await runCronOperation(
    { op: "run", name: "maintenance", requestId: "same-request" },
    binding,
    signal,
    dependencies,
  );

  expect(result).toMatchObject({
    status: "pending",
    effect: "durably-admitted-not-completed",
  });
  expect(
    await runCronOperation(
      { op: "run", name: "maintenance", requestId: "same-request" },
      binding,
      signal,
      dependencies,
    ),
  ).toMatchObject({ status: "busy", effect: "no-overlap-no-new-run" });
  expect(f.store.pending(f.manager.key)).toHaveLength(1);
  await expect(
    runCronOperation(
      { op: "list" },
      { ...binding, expectedDirectory: "/other" },
      signal,
      dependencies,
    ),
  ).rejects.toThrow("does not match");
  await expect(
    runCronOperation(
      { op: "list", channel: "COTHER" },
      binding,
      signal,
      dependencies,
    ),
  ).rejects.toThrow("not allowed");
  const controller = new AbortController();
  controller.abort();
  await expect(
    runCronOperation({ op: "list" }, binding, controller.signal, dependencies),
  ).rejects.toThrow();
});

test("cron config rejects duplicate file roots and unsupported report times", () => {
  const config = {
    ...bot(),
    cronjobs: {
      directory: "/srv/cronjobs",
      channel: "C123",
      user: "U123",
      dailyReport: {},
    },
  };

  expect(
    Schema.decodeUnknownSync(botSchema)(config).cronjobs?.dailyReport,
  ).toEqual({
    time: "08:30",
    timezone: "UTC",
  });
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(botSchema)({
        ...config,
        cronjobs: { ...config.cronjobs, dailyReport: { time: "25:30" } },
      }),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(configSchema)({
        bots: [
          config,
          {
            ...config,
            id: "second",
            slack: {
              appId: "AOTHER",
              appTokenEnv: "OTHER_APP",
              botTokenEnv: "OTHER_BOT",
            },
          },
        ],
      }),
    ),
  ).toBe(false);
});

test("file cron sync follows reloaded access without restarting the scheduler", async () => {
  const f = await fixture();
  const settings = f.config.cronjobs;

  if (!settings) throw new Error("Missing cron fixture");
  await writeCronjob(
    settings.directory,
    { ...f.definition, slack: { channel: "C456", user: "U123" } },
    now,
  );
  const scheduler = f.scheduler();
  await scheduler.tick(now, signal);
  expect(f.store.list({ ...f.scope, channel: "C456" })).toHaveLength(0);
  scheduler.reconfigure({
    ...f.config,
    access: { ...f.config.access, channels: ["C123", "C456"] },
  });
  await scheduler.tick(now + 10_000, signal);
  expect(f.store.list({ ...f.scope, channel: "C456" })).toHaveLength(1);
});
