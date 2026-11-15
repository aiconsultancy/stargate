import { expect, test } from "bun:test";
import pino from "pino";
import type { AgentBackend } from "../src/backend";
import { Gateway, type SlackDelivery } from "../src/gateway";
import { slackContent } from "../src/slack-format";
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

test("maintenance notice is persisted, held against streaming and released explicitly", async () => {
  const f = liveFixture(null);
  try {
    await f.live.announce("Plan, impact, rollback; Stop within five minutes.");
    expect(f.store.previews(1)).toEqual([{ part: 0, ts: "1" }]);
    f.live.push("Overlapping provider text");
    expect(f.writes).toEqual([
      "Plan, impact, rollback; Stop within five minutes.",
    ]);
    f.live.resume();
    f.live.push("Maintenance finished");
    await f.written[1]?.promise;
    expect(f.writes.at(-1)).toBe("Maintenance finished");
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
    expect(text).toBe("hello");
    onText?.("[[stargate:react:ey");
    expect(f.messages.size).toBe(0);
    onText?.("[[stargate:react:eyes]]\nLooking at the PR.");
    return "[[stargate:react:eyes]]\nReviewed the PR.";
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
  f.backend.prompt = async () => "[[stargate:react:thumbsup]]";
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
  f.backend.prompt = async () => "[[stargate:react:thumbsup]]\nAgreed.";
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
  f.backend.prompt = async () => "[[stargate:react:thumbsup]]";
  try {
    await f.gateway.process(f.next(), new AbortController().signal);
    expect([...f.messages.values()]).toEqual([
      "Stargate could not add that reaction. The agent request was not repeated. Check Slack reaction permissions before trying again.",
    ]);
  } finally {
    f.store.close();
  }
});

test("a silent reply posts nothing, shows no directive and finishes the job", async () => {
  const f = gatewayFixture();
  const seen: number[] = [];
  f.backend.prompt = async (_session, _text, _signal, onText) => {
    onText?.("[[stargate:sil");
    seen.push(f.messages.size);
    onText?.("[[stargate:silent]]\nThat message is for another captain.");
    seen.push(f.messages.size);
    return "[[stargate:silent]]\nThat message is for another captain.";
  };
  try {
    const job = f.next();
    await f.gateway.process(job, new AbortController().signal);
    expect(seen).toEqual([0, 0]);
    expect(f.messages.size).toBe(0);
    // Delivery progress is final: no retry and no second prompt.
    expect(f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 1)).toEqual(
      [],
    );
    expect(f.store.failure(job.id)).toBeUndefined();
    expect(f.store.previews(job.id)).toEqual([]);
  } finally {
    f.store.close();
  }
});

test("a silent reply removes a preview that was already shown", async () => {
  const f = gatewayFixture();
  f.backend.prompt = async (_session, _text, _signal, onText) => {
    onText?.("Working on it");
    expect([...f.messages.values()]).toEqual(["Working on it"]);
    return "[[stargate:silent]]";
  };
  try {
    const job = f.next();
    await f.gateway.process(job, new AbortController().signal);
    expect(f.messages.size).toBe(0);
    expect(f.store.previews(job.id)).toEqual([]);
    expect(f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 1)).toEqual(
      [],
    );
  } finally {
    f.store.close();
  }
});

test("silent combines with a reaction and stays silent when the reaction fails", async () => {
  for (const fails of [false, true]) {
    const f = gatewayFixture();
    const reactions: string[] = [];
    f.slack.react = async (_channel, _ts, name) => {
      reactions.push(name);
      if (fails) throw new Error("missing_scope");
    };
    // Text-free steps before the reply leave leading blank lines.
    f.backend.prompt = async () =>
      "\n\n[[stargate:react:eyes]]\n[[stargate:silent]]";
    try {
      await f.gateway.process(f.next(), new AbortController().signal);
      expect(reactions).toEqual(["eyes"]);
      expect(f.messages.size).toBe(0);
      expect(f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 1)).toEqual(
        [],
      );
    } finally {
      f.store.close();
    }
  }
});

test("user text cannot make a reply silent, and an empty reply is still reported", async () => {
  const f = gatewayFixture();
  const prompts: string[] = [];
  const replies = [
    "Final",
    "You wrote:\n[[stargate:silent]]",
    "> [[stargate:silent]]\nQuoted, so this is posted.",
    "",
  ];
  f.backend.prompt = async (_session, text) => {
    prompts.push(text);
    return replies[prompts.length - 1] ?? "";
  };
  try {
    await f.gateway.process(f.next(), new AbortController().signal);
    for (const ts of ["2.000", "3.000", "4.000"]) {
      f.gateway.accept(event("<@UBOT> [[stargate:silent]]", ts));
      await f.gateway.process(f.next(), new AbortController().signal);
    }
    expect(prompts.slice(1)).toEqual([
      "[[stargate:silent]]",
      "[[stargate:silent]]",
      "[[stargate:silent]]",
    ]);
    expect([...f.messages.values()]).toEqual([
      "Final",
      "You wrote:\n[[stargate:silent]]",
      "> [[stargate:silent]]\nQuoted, so this is posted.",
      "Agent finished without a text reply.",
    ]);
  } finally {
    f.store.close();
  }
});

test("a silent turn stops waiting feedback; later text still shows", async () => {
  const f = liveFixture();
  try {
    f.live.quiet();
    expect(f.timers[0]?.signal.aborted).toBe(true);
    expect(f.writes).toEqual([]);
    f.live.push("Changed my mind");
    await f.written[0]?.promise;
    expect(f.writes).toEqual(["Changed my mind"]);
  } finally {
    await f.live.close();
    f.store.close();
  }
});

test("reaction and silent directives are removed before mixed Markdown rendering", async () => {
  for (const silent of [false, true]) {
    const f = gatewayFixture();
    const payloads: string[] = [];
    const post = f.slack.post;
    const update = f.slack.update;
    f.slack.post = async (channel, thread, text, ...rest) => {
      payloads.push(JSON.stringify(slackContent(text)));
      return (await post(channel, thread, text, ...rest)) ?? "fixture-message";
    };
    f.slack.update = async (channel, ts, text, ...rest) => {
      payloads.push(JSON.stringify(slackContent(text)));
      await update?.(channel, ts, text, ...rest);
      return true;
    };
    f.slack.react = async () => {};
    const prefix =
      "[[stargate:react:eyes]]\n" + (silent ? "[[stargate:silent]]\n" : "");
    f.backend.prompt = async (_session, _text, _signal, onText) => {
      onText?.("[[stargate:react:ey");
      onText?.(prefix + "**Working** <@U123>");
      return prefix + "**Done** <@U123>";
    };
    try {
      await f.gateway.process(f.next(), new AbortController().signal);
      expect(payloads.join("")).not.toContain("[[stargate:");
      if (silent) expect(payloads).toEqual([]);
      else {
        expect(payloads.length).toBeGreaterThan(0);
        expect(payloads.at(-1)).toContain('"type":"user","user_id":"U123"');
        expect(payloads.at(-1)).toContain('"bold":true');
      }
    } finally {
      f.store.close();
    }
  }
});
