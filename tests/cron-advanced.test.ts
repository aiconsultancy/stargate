import { afterEach, expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import pino from "pino";
import { botSchema } from "../src/config";
import {
  CronScheduler,
  type CronServices,
  type ScheduledInput,
} from "../src/cron";
import { runCronOperation } from "../src/cron-control";
import { validateCronInput } from "../src/cron-input";
import { CronStore } from "../src/cron-store";
import { parseCronjob, renderCronjob } from "../src/cronjob-files";
import { botKey } from "../src/routing";
import { bot, identity } from "./fixtures";

const now = Date.parse("2026-01-01T00:00:00Z");
const signal = new AbortController().signal;
const paths: string[] = [];
const stores: CronStore[] = [];
const input = {
  name: "quota-watch",
  expression: "* * * * *",
  timezone: "UTC",
  prompt: "Check quota and return the verified outcome.",
};
const model = "openai-proxy/gpt-6-luna#medium";

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const path of paths.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function fixture(advanced = true) {
  const directory = await mkdtemp(join(tmpdir(), "stargate-advanced-cron-"));
  paths.push(directory);
  const config = Schema.decodeUnknownSync(botSchema)({
    ...bot(),
    cronjobs: {
      directory: join(directory, "jobs"),
      channel: "C123",
      user: "U123",
      advanced,
    },
  });
  const store = new CronStore(join(directory, "cron.sqlite"));
  stores.push(store);
  const scope = {
    botKey: botKey(config, identity),
    channel: "C123",
    user: "U123",
  };
  const queued: ScheduledInput[] = [];
  const posts: string[] = [];
  const gateway = {
    enqueueScheduled(job: ScheduledInput) {
      queued.push(job);
      return queued.length;
    },
    scheduledStatus() {
      return "done" as const;
    },
  };
  const delivery = {
    async announce(_channel: string, text: string) {
      posts.push(text);
      return "1.000";
    },
  };
  const worker = (services: CronServices = {}) =>
    new CronScheduler(
      config,
      identity,
      store,
      gateway,
      delivery,
      pino({ level: "silent" }),
      services,
    );
  return { directory, config, store, scope, queued, posts, worker };
}

test("event-only definitions preserve trigger, model, once and arbiter in the exact file", () => {
  const definition = {
    name: "quota-watch",
    description: "Watch quota",
    timezone: "UTC",
    prompt: input.prompt,
    trigger: {
      type: "quota-threshold" as const,
      provider: "codex" as const,
      usedPercent: 98,
    },
    model,
    once: true,
    arbiter: "twiki",
    skills: [],
    enabled: true,
    report: "daily" as const,
  };
  expect(parseCronjob(renderCronjob(definition), definition.name, now)).toEqual(
    definition,
  );
  expect(
    validateCronInput(
      { ...input, expression: "", trigger: definition.trigger },
      now,
    ).nextAt,
  ).toBe(0);
  expect(() => validateCronInput({ ...input, expression: "" }, now)).toThrow();
  expect(() =>
    validateCronInput(
      { ...input, trigger: { ...definition.trigger, usedPercent: 101 } },
      now,
    ),
  ).toThrow();
});

test("disabled advanced flag holds accepted advanced work without a model turn or Slack post", async () => {
  const f = await fixture(false);
  f.store.add(f.scope, { ...input, model }, now);
  let calls = 0;
  await f
    .worker({
      async evaluate() {
        calls++;
        return { model, text: "No change.", verdict: "act" };
      },
    })
    .tick(now + 60_000, signal);
  expect(calls).toBe(0);
  expect(f.posts).toEqual([]);
  expect(f.queued).toEqual([]);
  expect(f.store.report(f.scope.botKey)[0]?.lastStatus).toBe("blocked");
});

test("ignore completes a one-off job with no captain admission or Slack announcement", async () => {
  const f = await fixture();
  f.store.add(f.scope, { ...input, model, arbiter: "twiki", once: true }, now);
  let calls = 0;
  const services: CronServices = {
    async evaluate(run) {
      calls++;
      expect(run.arbiter).toBe("twiki");
      return { model, text: "No action required.", verdict: "ignore" };
    },
  };
  await f.worker(services).tick(now + 60_000, signal);
  await f.worker(services).tick(now + 120_000, signal);
  expect(calls).toBe(1);
  expect(f.store.list(f.scope)).toEqual([]);
  expect(f.queued).toEqual([]);
  expect(f.posts).toEqual([]);
  expect(f.store.recentRuns(f.scope.botKey)[0]?.status).toBe("done");
});

test.each(["act", "escalate"] as const)(
  "%s alone announces and forwards retained output to captain",
  async (verdict) => {
    const f = await fixture();
    f.store.add(f.scope, { ...input, model, arbiter: "twiki" }, now);
    await f
      .worker({
        async evaluate() {
          expect(f.posts).toEqual([]);
          expect(f.queued).toEqual([]);
          return { model, text: "Verified quota event.", verdict };
        },
      })
      .tick(now + 60_000, signal);
    expect(f.posts).toHaveLength(1);
    expect(f.queued).toHaveLength(1);
    expect(f.queued[0]?.prompt).toContain(`Cron decision: ${verdict}`);
    expect(f.queued[0]?.prompt).toContain("Verified quota event.");
    expect(f.queued[0]?.prompt).toContain("approval");
  },
);

test("an ambiguous evaluation is held across scheduler restarts, never replayed", async () => {
  const f = await fixture();
  f.store.add(f.scope, { ...input, model }, now);
  let calls = 0;
  const services: CronServices = {
    async evaluate() {
      calls++;
      throw new Error("Provider outcome unknown");
    },
  };
  await f.worker(services).tick(now + 60_000, signal);
  await f.worker(services).tick(now + 120_000, signal);
  expect(calls).toBe(1);
  expect(f.store.report(f.scope.botKey)[0]?.lastStatus).toBe("blocked");
  expect(f.queued).toEqual([]);
  expect(f.posts).toEqual([]);
});

test("gateway quota polling uses no model until a durable event and supplies its observation", async () => {
  const f = await fixture();
  f.store.add(
    f.scope,
    {
      ...input,
      expression: "",
      trigger: { type: "quota-reset", provider: "codex" },
      model,
      arbiter: "twiki",
    },
    now,
  );
  let seen = now;
  let resetAt = now + 3_600_000;
  let evaluations = 0;
  const services: CronServices = {
    async quota() {
      return {
        status: "ok",
        observedAt: seen,
        cached: false,
        accounts: [
          {
            provider: "codex",
            account: "codex-1",
            status: "ok",
            observedAt: seen,
            windows: [
              {
                window: "weekly",
                scope: "subscription",
                usedPercent: 0,
                remainingPercent: 100,
                resetAt,
                active: true,
              },
            ],
          },
        ],
      };
    },
    async evaluate(run) {
      evaluations++;
      expect(run.prompt).toContain('"provider":"codex"');
      expect(run.prompt).toContain(`"resetAt":${resetAt}`);
      expect(run.prompt).toContain(`"observedAt":${seen}`);
      return { model, text: "No further action.", verdict: "ignore" };
    },
  };
  const worker = f.worker(services);
  await worker.tick(now, signal);
  expect(evaluations).toBe(0);
  seen = now + 60_000;
  resetAt += 3_600_000;
  await worker.tick(seen, signal);
  await f.worker(services).tick(seen + 60_000, signal);
  expect(evaluations).toBe(1);
  expect(f.posts).toEqual([]);
  expect(f.queued).toEqual([]);
});

test("control validates explicit models and shows selection in add, list and report", async () => {
  const f = await fixture();
  const configPath = join(f.directory, "gateway.json");
  await writeFile(
    configPath,
    JSON.stringify({ dataDirectory: f.directory, bots: [f.config] }),
  );
  const dependencies = {
    now: () => now,
    async identity() {
      return identity;
    },
    async model(
      _bot: unknown,
      _directory: string,
      selected: { model?: string },
    ) {
      if (selected.model !== model) throw new Error("Unavailable model");
      return { model };
    },
  };
  const binding = {
    configPath,
    bot: f.config.id,
    expectedDirectory: "/workspace",
  };
  const add = {
    op: "add",
    name: input.name,
    description: "Quota watcher",
    trigger: { type: "quota-reset", provider: "codex" },
    prompt: input.prompt,
    model,
    arbiter: "twiki",
    once: true,
  };
  expect(
    await runCronOperation(add, binding, signal, dependencies),
  ).toMatchObject({
    job: { model, once: true, arbiter: "twiki", expression: "" },
  });
  expect(
    await runCronOperation({ op: "list" }, binding, signal, dependencies),
  ).toMatchObject({ jobs: [{ model, once: true, arbiter: "twiki" }] });
  expect(
    await runCronOperation({ op: "report" }, binding, signal, dependencies),
  ).toMatchObject({ jobs: [{ model, once: true, arbiter: "twiki" }] });
  await expect(
    runCronOperation(
      { ...add, name: "bad-model", model: "unknown/missing" },
      binding,
      signal,
      dependencies,
    ),
  ).rejects.toThrow();
  expect(f.store.list(f.scope)).toHaveLength(1);
});

test("hot-reloaded control refuses a new fingerprint instead of syncing an empty namespace", async () => {
  const f = await fixture();
  f.store.add(f.scope, input, now);
  f.worker(); // Establish the gateway's active configuration, without starting it.
  const configPath = join(f.directory, "gateway.json");
  await writeFile(
    configPath,
    JSON.stringify({
      dataDirectory: f.directory,
      bots: [
        {
          ...f.config,
          backend: { ...f.config.backend, agent: "changed-profile" },
        },
      ],
    }),
  );
  const binding = {
    configPath,
    bot: f.config.id,
    expectedDirectory: "/workspace",
  };
  await expect(
    runCronOperation({ op: "list" }, binding, signal, {
      now: () => now,
      async identity() {
        return identity;
      },
    }),
  ).rejects.toThrow("restart the gateway");
  expect(f.store.list(f.scope)).toHaveLength(1);
  expect(f.store.report(f.scope.botKey)).toHaveLength(1);
});

test("read controls never create an empty cron database for a changed data directory", async () => {
  const f = await fixture();
  const elsewhere = join(f.directory, "elsewhere");
  const configPath = join(f.directory, "gateway.json");
  await writeFile(
    configPath,
    JSON.stringify({ dataDirectory: elsewhere, bots: [f.config] }),
  );
  await expect(
    runCronOperation({ op: "list" }, { configPath, bot: f.config.id }, signal, {
      now: () => now,
      async identity() {
        return identity;
      },
    }),
  ).rejects.toThrow("state is unavailable");
  await expect(access(join(elsewhere, "cron.sqlite"))).rejects.toThrow();
});
