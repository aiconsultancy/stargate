import { afterEach, expect, test } from "bun:test";
import pino from "pino";
import type { AgentBackend } from "../src/backend";
import { Gateway } from "../src/gateway";
import { Store } from "../src/store";
import { bot, event, identity } from "./fixtures";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function fixture() {
  const store = new Store(":memory:");
  stores.push(store);
  const prompts: { session: string; text: string }[] = [];
  let sessions = 0;
  const backend: AgentBackend = {
    async createSession() {
      return `session-${++sessions}`;
    },
    async prompt(session, text) {
      prompts.push({ session, text });
      return `answer: ${text}`;
    },
    async close() {},
  };
  const delivered: string[] = [];
  const slack = {
    async post(_channel: string, _thread: string, text: string) {
      delivered.push(text);
    },
  };
  const config = bot();
  const gateway = new Gateway(
    config,
    identity,
    store,
    backend,
    slack,
    pino({ enabled: false }),
  );
  function next() {
    const job = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1)[0];
    if (!job) throw new Error("Expected a job");
    return job;
  }
  return { store, backend, config, gateway, prompts, delivered, slack, next };
}

test("persists once and resumes the same session on thread replies", async () => {
  const f = fixture();
  expect(f.gateway.accept(event())).toBe(true);
  expect(f.gateway.accept(event())).toBe(false);
  await f.gateway.process(f.next(), new AbortController().signal);
  expect(f.delivered).toEqual(["answer: hello"]);
  const reply = {
    ...event(),
    event: {
      ...event("continue", "2.000").event,
      type: "message",
      thread_ts: "1.000",
    },
  };
  expect(f.gateway.accept(reply)).toBe(true);
  await f.gateway.process(f.next(), new AbortController().signal);
  expect(f.prompts).toEqual([
    { session: "session-1", text: "hello" },
    { session: "session-1", text: "continue" },
  ]);
});

test("unmentioned messages cannot open new conversations", () => {
  expect(fixture().gateway.accept(event("hello"))).toBe(false);
});

test("workspace-wide humans pass both admission and execution policy", async () => {
  const f = fixture();
  f.config.access.users = ["*"];
  const request = { ...event(), event: { ...event().event, user: "U999" } };
  expect(f.gateway.accept(request)).toBe(true);
  await f.gateway.process(f.next(), new AbortController().signal);
  expect(f.prompts).toEqual([{ session: "session-1", text: "hello" }]);
  expect(f.delivered).toEqual(["answer: hello"]);
});

test("removing wildcard blocks pending delivery to a formerly allowed user", async () => {
  const f = fixture();
  f.config.access.users = ["*"];
  f.gateway.accept({ ...event(), event: { ...event().event, user: "U999" } });
  f.store.respond(f.next().id, ["private reply"]);
  f.config.access.users = ["U123"];
  await f.gateway.process(f.next(), new AbortController().signal);
  expect(f.delivered).toEqual([]);
});

test("channel wildcard works through execution and delivery", async () => {
  const f = fixture();
  f.config.access.channels = ["*"];
  expect(
    f.gateway.accept({
      ...event(),
      event: { ...event().event, channel: "C999" },
    }),
  ).toBe(true);
  await f.gateway.process(f.next(), new AbortController().signal);
  expect(f.delivered).toEqual(["answer: hello"]);
});

test("denies block queued execution and already-persisted replies", async () => {
  for (const field of ["deniedUsers", "deniedChannels"] as const) {
    for (const responding of [false, true]) {
      const f = fixture();
      f.config.access.users = ["*"];
      f.config.access.channels = ["*"];
      expect(f.gateway.accept(event())).toBe(true);
      if (responding) f.store.respond(f.next().id, ["private reply"]);
      f.config.access[field] = [field === "deniedUsers" ? "U123" : "C123"];
      await f.gateway.process(f.next(), new AbortController().signal);
      expect(f.prompts).toEqual([]);
      expect(f.delivered).toEqual([]);
      expect(f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 1)).toEqual(
        [],
      );
    }
  }
});

test("FIFO blocks the next turn but permits other threads", () => {
  const f = fixture();
  f.gateway.accept(event());
  f.gateway.accept({
    ...event(),
    event: { ...event("<@UBOT> follow", "2.000").event, thread_ts: "1.000" },
  });
  f.gateway.accept(event("<@UBOT> separate", "3.000"));
  const first = f.next();
  f.store.running(first.id);
  expect(
    f.store
      .ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 10)
      .map((job) => job.text),
  ).toEqual(["separate"]);
});

test("delivery retries do not rerun agent tools", async () => {
  const f = fixture();
  f.slack.post = async () => {
    throw new Error("Slack unavailable");
  };
  f.gateway.accept(event());
  await f.gateway.process(f.next(), new AbortController().signal);
  const retry = f.next();
  expect(retry.status).toBe("responding");
  f.slack.post = async (_channel, _thread, text) => {
    f.delivered.push(text);
  };
  await f.gateway.process(retry, new AbortController().signal);
  expect(f.prompts).toHaveLength(1);
  expect(f.delivered).toEqual(["answer: hello"]);
});

test("crash recovery reports uncertain outcomes without repeating work", async () => {
  const f = fixture();
  f.gateway.accept(event());
  f.store.running(f.next().id);
  f.store.recover(f.gateway.key);
  await f.gateway.process(f.next(), new AbortController().signal);
  expect(f.prompts).toEqual([]);
  expect(f.delivered[0]).toContain("Work may have run");
});

test("partial delivery resumes after the last confirmed chunk", async () => {
  const f = fixture();
  f.backend.prompt = async () => "x".repeat(3000);
  f.slack.post = async (_channel, _thread, text) => {
    if (f.delivered.length === 1) throw new Error("delivery failed");
    f.delivered.push(text);
  };
  f.gateway.accept(event());
  await f.gateway.process(f.next(), new AbortController().signal);
  expect(f.next().sent).toBe(1);
  f.slack.post = async (_channel, _thread, text) => {
    f.delivered.push(text);
  };
  await f.gateway.process(f.next(), new AbortController().signal);
  expect(f.delivered.map((text) => text.length)).toEqual([2800, 200]);
});

test("revoked policy blocks queued work and pending delivery", async () => {
  const f = fixture();
  f.gateway.accept(event());
  f.config.access.users = [];
  await f.gateway.process(f.next(), new AbortController().signal);
  expect(f.prompts).toEqual([]);
  expect(f.delivered).toEqual([]);
});

test("failure produces a safe reply without exposing SDK errors", async () => {
  const f = fixture();
  f.backend.prompt = async () => {
    throw new Error("secret-token");
  };
  f.gateway.accept(event());
  await f.gateway.process(f.next(), new AbortController().signal);
  expect(f.delivered[0]).toContain("could not finish");
  expect(f.delivered[0]).not.toContain("secret-token");
});

test("cancellation prevents work and persists a delivery for restart", async () => {
  const f = fixture();
  f.gateway.accept(event());
  await f.gateway.process(f.next(), AbortSignal.abort());
  expect(f.prompts).toEqual([]);
  expect(f.delivered).toEqual([]);
  expect(f.next().status).toBe("responding");
});
