import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pino from "pino";
import type { AgentBackend } from "../src/backends/backend";
import { Gateway } from "../src/gateway/gateway";
import type { TransportDelivery } from "../src/gateway/ports";
import type {
  DrainControl,
  DrainHandler,
} from "../src/maintenance/maintenance-drain";
import { openStore } from "../src/app/open-store";
import { bot, identity } from "./fixtures";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function until(check: () => boolean) {
  for (let i = 0; i < 60 && !check(); i++) await delay(50);
  expect(check()).toBe(true);
}

function fixture(path: string, held: { value: boolean }) {
  const store = openStore(path);
  cleanup.push(() => store.close());
  const prompts: string[] = [];
  const handlers: DrainHandler[] = [];
  const backend: AgentBackend = {
    async createSession() {
      return "session-1";
    },
    async prompt(_session, text) {
      prompts.push(text);
      return `done ${text}`;
    },
    async close() {},
    async queueUpdateNotice(sessionID, id) {
      notices.push({ sessionID, id });
    },
  };
  const notices: { sessionID: string; id: string }[] = [];
  const control: DrainControl = {
    held: () => held.value,
    tick() {},
    attach: (handler) => handlers.push(handler),
  };
  const config = bot();
  config.waiting.delayMs = 0;
  const gateway = new Gateway(
    config,
    identity,
    store,
    backend,
    {} as TransportDelivery,
    pino({ enabled: false }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    control,
  );
  cleanup.push(() => gateway.close());
  const enqueue = (runId: string) => {
    const id = gateway.enqueueScheduled({
      runId,
      channel: "C123",
      thread: "",
      user: "U123",
      prompt: runId,
      name: "Held",
      deferDelivery: true,
    });
    if (id === undefined) throw new Error("Scheduled job rejected");
    return id;
  };
  return { store, gateway, prompts, notices, handlers, enqueue };
}

test("a drain holds new turns but keeps accepting jobs; they run FIFO after release or restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-drain-gateway-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "stargate.sqlite");
  const held = { value: true };
  const first = fixture(path, held);
  const a = first.enqueue("first");
  const b = first.enqueue("second");
  const stop = new AbortController();
  const work = first.gateway.work(stop.signal);
  await delay(700);
  expect(first.prompts).toEqual([]);
  expect(first.store.queueCounts(first.gateway.key).queued).toBe(2);
  // A turn the poll listed before the drain began still refuses at the last check.
  const ready = first.store.ready(first.gateway.key, Date.now(), 1)[0];
  if (!ready) throw new Error("Expected a queued job");
  await first.gateway.process(ready, new AbortController().signal);
  expect(first.prompts).toEqual([]);
  // Messages accepted during the drain persist behind the older ones.
  const c = first.enqueue("third");
  expect([a, b, c]).toEqual([a, a + 1, a + 2]);
  stop.abort();
  await work;
  await first.gateway.close();
  first.store.close();
  // Restart after completion: the persisted queue runs in order.
  held.value = false;
  const second = fixture(path, held);
  const again = new AbortController();
  const run = second.gateway.work(again.signal);
  await until(() => second.prompts.length === 3);
  expect(second.prompts).toEqual(["first", "second", "third"]);
  again.abort();
  await run;
});

test("releasing the hold in one process starts the held jobs without a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-drain-gateway-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const held = { value: true };
  const f = fixture(join(directory, "stargate.sqlite"), held);
  f.enqueue("only");
  const stop = new AbortController();
  const work = f.gateway.work(stop.signal);
  await delay(500);
  expect(f.prompts).toEqual([]);
  held.value = false;
  await until(() => f.prompts.length === 1);
  stop.abort();
  await work;
});

test("held queued jobs cannot hide a responding delivery in the bounded ready query", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-drain-delivery-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const f = fixture(join(directory, "stargate.sqlite"), { value: true });
  f.store.enqueue({
    botKey: f.gateway.key,
    eventId: "early",
    conversation: "a",
    channel: "C123",
    thread: "1",
    user: "U123",
    text: "held",
  });
  f.store.enqueue({
    botKey: f.gateway.key,
    eventId: "late",
    conversation: "b",
    channel: "C123",
    thread: "2",
    user: "U123",
    text: "finished",
  });
  const responding = f.store.queuedJob(f.gateway.key, "late")?.id;
  if (responding === undefined) throw new Error("Missing job");
  f.store.running(responding);
  f.store.respond(responding, ["done"]);
  const jobs = f.store.ready(f.gateway.key, Date.now(), 1, false, true);
  expect(jobs.map((job) => job.status)).toEqual(["responding"]);
});

test("the gateway broadcast queues each mapped unpinned session once with a deterministic ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-drain-gateway-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const held = { value: false };
  const f = fixture(join(directory, "stargate.sqlite"), held);
  f.enqueue("mapped");
  const stop = new AbortController();
  const work = f.gateway.work(stop.signal);
  await until(() => f.prompts.length === 1);
  stop.abort();
  await work;
  const record = {
    schema: "stargate.maintenance.drain.v1" as const,
    runID: "run-9",
    pid: process.pid,
    job: "nightly" as const,
    services: ["gateway" as const],
    startedAt: 1,
    deadlineAt: 2,
    phase: "draining" as const,
  };
  const handler = f.handlers[0];
  if (!handler) throw new Error("Gateway did not attach");
  const signal = new AbortController().signal;
  await handler.broadcast(record, signal);
  await handler.broadcast({ ...record, phase: "restarting" }, signal);
  expect(f.notices.map((n) => n.sessionID)).toEqual(["session-1", "session-1"]);
  expect(new Set(f.notices.map((n) => n.id)).size).toBe(1);
  await handler.broadcast({ ...record, phase: "completed" }, signal);
  expect(new Set(f.notices.map((n) => n.id)).size).toBe(2);
});
