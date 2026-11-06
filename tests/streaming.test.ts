import { expect, test } from "bun:test";
import pino from "pino";
import type { AgentBackend } from "../src/backend";
import { Gateway, type SlackDelivery } from "../src/gateway";
import { Store } from "../src/store";
import { LiveReply } from "../src/streaming";
import { bot, event, identity } from "./fixtures";

test("text reaches Slack before generation completes, then updates in place", async () => {
  const store = new Store(":memory:");
  const visible = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const writes: string[] = [];
  const slack: SlackDelivery = {
    async post(_channel, _thread, text) {
      writes.push(text);
      visible.resolve();
      return "preview-1";
    },
    async update(_channel, ts, text) {
      expect(ts).toBe("preview-1");
      writes.push(text);
    },
    async remove() {},
  };
  const backend: AgentBackend = {
    async createSession() {
      return "session";
    },
    async prompt(_session, _text, _signal, onText) {
      onText?.("Hello");
      await finish.promise;
      return "Hello world";
    },
    async close() {},
  };
  const gateway = new Gateway(
    bot(),
    identity,
    store,
    backend,
    slack,
    pino({ enabled: false }),
  );
  try {
    gateway.accept(event());
    const job = store.ready(gateway.key, Date.now(), 1)[0];
    if (!job) throw new Error("Missing job");
    const work = gateway.process(job, new AbortController().signal);
    await visible.promise;
    expect(writes).toEqual(["Hello"]);
    finish.resolve();
    await work;
    expect(writes).toEqual(["Hello", "Hello world"]);
    expect(store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1)).toEqual([]);
  } finally {
    finish.resolve();
    store.close();
  }
});

function liveFixture(delayMs: number | null = 5000) {
  const store = new Store(":memory:");
  const input = {
    eventId: "1.000",
    botKey: "bot",
    conversation: "thread",
    channel: "C123",
    thread: "1.000",
    user: "U123",
    text: "hello",
  };
  store.enqueue(input);
  const job = store.ready("bot", Date.now(), 1)[0];
  if (!job) throw new Error("Missing job");
  const writes: string[] = [];
  const written = Array.from({ length: 10 }, () =>
    Promise.withResolvers<void>(),
  );
  const timers: { ms: number; signal: AbortSignal; resolve: () => void }[] = [];
  const slack: SlackDelivery = {
    async post(_channel, _thread, text) {
      writes.push(text);
      written[writes.length - 1]?.resolve();
      return String(writes.length);
    },
    async update(_channel, _ts, text) {
      writes.push(text);
      written[writes.length - 1]?.resolve();
    },
    async remove() {},
  };
  const live = new LiveReply(
    job,
    store,
    slack,
    new AbortController().signal,
    pino({ enabled: false }),
    {
      intervalMs: 0,
      waiting: { delayMs, intervalMs: 10000, name: "Starbuck" },
      phrase: (name, index) =>
        `${name} is ${["thinking", "tinkering", "pondering"][index]}…`,
      wait: (ms, signal) =>
        new Promise<void>((resolve, reject) => {
          const abort = () => reject(new Error("aborted"));
          signal.addEventListener("abort", abort, { once: true });
          timers.push({
            ms,
            signal,
            resolve: () => {
              signal.removeEventListener("abort", abort);
              resolve();
            },
          });
        }),
    },
  );
  return { store, live, writes, timers, written };
}

test("waiting feedback starts after five seconds, rotates, and yields to text", async () => {
  const f = liveFixture();
  try {
    expect(f.writes).toEqual([]);
    expect(f.timers[0]?.ms).toBe(5000);
    f.timers[0]?.resolve();
    await f.written[0]?.promise;
    expect(f.writes).toEqual(["Starbuck is thinking…"]);
    expect(f.timers[1]?.ms).toBe(10000);
    f.timers[1]?.resolve();
    await f.written[1]?.promise;
    expect(f.writes[1]).toBe("Starbuck is tinkering…");
    f.live.push("Actual response");
    await f.written[2]?.promise;
    expect(f.writes[2]).toBe("Actual response");
    expect(f.timers.filter((timer) => !timer.signal.aborted)).toHaveLength(0);
  } finally {
    await f.live.close();
    f.store.close();
  }
});

test("quick text cancels waiting feedback before it appears", async () => {
  const f = liveFixture();
  try {
    f.live.push("Fast answer");
    await f.written[0]?.promise;
    expect(f.writes).toEqual(["Fast answer"]);
    expect(f.timers[0]?.signal.aborted).toBe(true);
  } finally {
    await f.live.close();
    f.store.close();
  }
});

test("off disables waiting feedback; zero starts it immediately", async () => {
  const off = liveFixture(null);
  const zero = liveFixture(0);
  try {
    expect(off.timers).toEqual([]);
    expect(zero.timers[0]?.ms).toBe(0);
    zero.timers[0]?.resolve();
    await zero.written[0]?.promise;
    expect(zero.writes).toEqual(["Starbuck is thinking…"]);
  } finally {
    await off.live.close();
    await zero.live.close();
    off.store.close();
    zero.store.close();
  }
});

test("long snapshots stream as bounded Slack messages", async () => {
  const f = liveFixture(null);
  try {
    f.live.push("x".repeat(6000));
    await f.written[2]?.promise;
    await f.live.close();
    expect(f.writes.map((text) => text.length)).toEqual([2800, 2800, 400]);
    expect(f.store.previews(1)).toHaveLength(3);
  } finally {
    await f.live.close();
    f.store.close();
  }
});

test("completion cancels pending status timers", async () => {
  const f = liveFixture();
  await f.live.close();
  expect(f.timers[0]?.signal.aborted).toBe(true);
  expect(f.writes).toEqual([]);
  f.store.close();
});

function gatewayFixture() {
  const store = new Store(":memory:");
  const messages = new Map<string, string>();
  let calls = 0;
  const slack: SlackDelivery = {
    async post(_channel, _thread, text) {
      const ts = String(messages.size + 1);
      messages.set(ts, text);
      return ts;
    },
    async update(_channel, ts, text) {
      messages.set(ts, text);
    },
    async remove(_channel, ts) {
      messages.delete(ts);
    },
  };
  const backend: AgentBackend = {
    async createSession() {
      return "session";
    },
    async prompt(_session, _text, _signal, onText) {
      calls++;
      onText?.("Partial");
      return "Final";
    },
    async close() {},
  };
  const gateway = new Gateway(
    bot(),
    identity,
    store,
    backend,
    slack,
    pino({ enabled: false }),
  );
  gateway.accept(event());
  const next = () => {
    const job = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1)[0];
    if (!job) throw new Error("Missing job");
    return job;
  };
  return { store, messages, slack, backend, gateway, next, calls: () => calls };
}

test("final update retries reuse preview and never rerun tools", async () => {
  const f = gatewayFixture();
  const update = f.slack.update;
  if (!update) throw new Error("Missing update");
  f.slack.update = async () => {
    throw new Error("Slack unavailable");
  };
  try {
    await f.gateway.process(f.next(), new AbortController().signal);
    expect([...f.messages.values()]).toEqual(["Partial"]);
    expect(f.next().status).toBe("responding");
    f.slack.update = update;
    await f.gateway.process(f.next(), new AbortController().signal);
    expect([...f.messages.values()]).toEqual(["Final"]);
    expect(f.calls()).toBe(1);
  } finally {
    f.store.close();
  }
});

test("generation errors replace partial text without exposing exceptions", async () => {
  const f = gatewayFixture();
  f.backend.prompt = async (_session, _text, _signal, onText) => {
    onText?.("Unfinished");
    throw new Error("private-token");
  };
  try {
    await f.gateway.process(f.next(), new AbortController().signal);
    expect(f.messages.size).toBe(1);
    expect([...f.messages.values()][0]).toContain("could not finish");
    expect([...f.messages.values()][0]).not.toContain("private-token");
  } finally {
    f.store.close();
  }
});

test("deleted previews are replaced during final delivery", async () => {
  const f = gatewayFixture();
  f.slack.update = async (_channel, ts) => {
    f.messages.delete(ts);
    return false;
  };
  try {
    await f.gateway.process(f.next(), new AbortController().signal);
    expect([...f.messages.values()]).toEqual(["Final"]);
  } finally {
    f.store.close();
  }
});

test("recovery updates persisted previews and removes obsolete preview chunks", async () => {
  const f = gatewayFixture();
  try {
    const job = f.next();
    f.store.running(job.id);
    f.store.savePreview(job.id, 0, "first");
    f.store.savePreview(job.id, 1, "second");
    f.messages.set("first", "Partial answer");
    f.messages.set("second", "More partial text");
    f.store.recover(f.gateway.key);
    await f.gateway.process(f.next(), new AbortController().signal);
    expect(f.messages.size).toBe(1);
    expect(f.messages.get("first")).toContain("Work may have run");
    expect(f.calls()).toBe(0);
  } finally {
    f.store.close();
  }
});

test("only explicit model reactions target the current user message", async () => {
  const f = gatewayFixture();
  const reactions: { channel: string; ts: string; name: string }[] = [];
  f.slack.react = async (channel, ts, name) => {
    reactions.push({ channel, ts, name });
  };
  f.backend.prompt = async (_session, text, _signal, onText) => {
    expect(text).toContain("Do not use eyes to acknowledge a general question");
    onText?.("[[pogo:react:ey");
    expect(f.messages.size).toBe(0);
    onText?.("[[pogo:react:eyes]]\nLooking at the PR.");
    return "[[pogo:react:eyes]]\nReviewed the PR.";
  };
  try {
    await f.gateway.process(f.next(), new AbortController().signal);
    expect(reactions).toEqual([{ channel: "C123", ts: "1.000", name: "eyes" }]);
    expect([...f.messages.values()]).toEqual(["Reviewed the PR."]);
  } finally {
    f.store.close();
  }
});

test("a normal question gets no automatic eyes reaction", async () => {
  const f = gatewayFixture();
  const reactions: string[] = [];
  f.slack.react = async (_channel, _ts, name) => {
    reactions.push(name);
  };
  try {
    await f.gateway.process(f.next(), new AbortController().signal);
    expect(reactions).toEqual([]);
    expect([...f.messages.values()]).toEqual(["Final"]);
  } finally {
    f.store.close();
  }
});

test("a reaction-only answer does not post a synthetic empty reply", async () => {
  const f = gatewayFixture();
  const reactions: string[] = [];
  f.slack.react = async (_channel, _ts, name) => {
    reactions.push(name);
  };
  f.backend.prompt = async () => "[[pogo:react:thumbsup]]";
  try {
    await f.gateway.process(f.next(), new AbortController().signal);
    expect(reactions).toEqual(["thumbsup"]);
    expect(f.messages.size).toBe(0);
  } finally {
    f.store.close();
  }
});

test("reaction failure does not prevent final reply or expose credentials", async () => {
  const f = gatewayFixture();
  f.slack.react = async () => {
    throw new Error("private-token");
  };
  f.backend.prompt = async () => "[[pogo:react:thumbsup]]\nAgreed.";
  try {
    await f.gateway.process(f.next(), new AbortController().signal);
    expect([...f.messages.values()]).toEqual(["Agreed."]);
  } finally {
    f.store.close();
  }
});

test("a failed reaction-only answer reports failure instead of disappearing", async () => {
  const f = gatewayFixture();
  f.slack.react = async () => {
    throw new Error("missing_scope");
  };
  f.backend.prompt = async () => "[[pogo:react:thumbsup]]";
  try {
    await f.gateway.process(f.next(), new AbortController().signal);
    expect([...f.messages.values()]).toEqual([
      "Pogo could not add that reaction.",
    ]);
  } finally {
    f.store.close();
  }
});
