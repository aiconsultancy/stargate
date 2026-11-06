import { afterEach, expect, test } from "bun:test";
import pino from "pino";
import type { AgentBackend } from "../src/backend";
import { Gateway, type SlackDelivery } from "../src/gateway";
import { handleSlackRequest } from "../src/slack";
import { Store } from "../src/store";
import { bot, event, identity } from "./fixtures";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function fixture(channel = "C123") {
  const store = new Store(":memory:");
  stores.push(store);
  const config = bot();
  const started = Promise.withResolvers<AbortSignal>();
  const finish = Promise.withResolvers<string>();
  const writes: { text: string; stopJob?: number }[] = [];
  let prompts = 0;
  let stopped = false;
  const backend: AgentBackend = {
    async createSession() {
      return "session";
    },
    async prompt(_session, _text, signal, onText) {
      prompts++;
      onText?.("Partial answer");
      // Let the preview timestamp commit before exposing the test barrier.
      await Promise.resolve();
      started.resolve(signal);
      const aborted = Promise.withResolvers<never>();
      const abort = () => {
        stopped = true;
        aborted.reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        return await Promise.race([finish.promise, aborted.promise]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    async close() {},
  };
  const slack: SlackDelivery = {
    async post(_channel, _thread, text, stopJob) {
      writes.push({ text, ...(stopJob === undefined ? {} : { stopJob }) });
      return "2.000";
    },
    async update(_channel, _ts, text, stopJob) {
      writes.push({ text, ...(stopJob === undefined ? {} : { stopJob }) });
    },
    async remove() {},
  };
  const gateway = new Gateway(
    config,
    identity,
    store,
    backend,
    slack,
    pino({ enabled: false }),
  );
  gateway.accept({ ...event(), event: { ...event().event, channel } });
  const next = () => {
    const job = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1)[0];
    if (!job) throw new Error("Missing job");
    return job;
  };
  const job = next();
  const payload = () => ({
    type: "block_actions",
    api_app_id: "A123",
    team: { id: "T123" },
    user: { id: "U123" },
    channel: { id: channel },
    container: {
      type: "message",
      channel_id: channel,
      message_ts: "2.000",
      is_ephemeral: false,
    },
    message: { user: "UBOT", ts: "2.000", thread_ts: "1.000" },
    actions: [
      { type: "button", action_id: "pogo_stop", value: String(job.id) },
    ],
  });
  return {
    store,
    config,
    backend,
    slack,
    gateway,
    next,
    job,
    payload,
    started: started.promise,
    finish,
    writes,
    prompts: () => prompts,
    stopped: () => stopped,
  };
}

test("requester Stop aborts running work in channels and DMs, then replaces preview", async () => {
  for (const channel of ["C123", "D123"]) {
    const f = fixture(channel);
    const work = f.gateway.process(f.job, new AbortController().signal);
    const signal = await f.started;
    expect(f.store.previews(f.job.id)).toEqual([{ part: 0, ts: "2.000" }]);
    expect(f.writes[0]?.stopJob).toBe(f.job.id);
    expect(f.gateway.cancel(f.payload())).toBe(true);
    // Duplicate Slack deliveries must not select another job or rerun work.
    expect(f.gateway.cancel(f.payload())).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 10)).toEqual(
      [],
    );
    await work;
    expect(f.stopped()).toBe(true);
    expect(f.prompts()).toBe(1);
    expect(f.store.jobStatus(f.gateway.key, f.job.id)).toBe("done");
    expect(f.writes.at(-1)?.text).toContain("stop request");
    expect(f.writes.at(-1)?.text).toContain("existing effects may remain");
    expect(f.writes.at(-1)?.stopJob).toBeUndefined();
    expect(f.gateway.cancel(f.payload())).toBe(false);
  }
});

test("Stop rejects other humans, bots, installations, channels, threads, and previews", async () => {
  const f = fixture();
  f.config.access.users = ["*"];
  f.config.access.channels = ["*"];
  const work = f.gateway.process(f.job, new AbortController().signal);
  const signal = await f.started;
  const original = f.payload();
  const invalid = [
    { ...original, user: { id: "UOTHER" } },
    { ...original, user: { id: "UBOT" } },
    { ...original, user: { id: "U123", is_bot: true } },
    { ...original, user: { id: "U123", bot_id: "B123" } },
    { ...original, bot_id: "B123" },
    { ...original, api_app_id: "AOTHER" },
    { ...original, team: { id: "TOTHER" } },
    { ...original, channel: { id: "COTHER" } },
    { ...original, container: { ...original.container, channel_id: "COTHER" } },
    { ...original, container: { ...original.container, message_ts: "9.000" } },
    { ...original, container: { ...original.container, is_ephemeral: true } },
    { ...original, message: { ...original.message, user: "UOTHER" } },
    { ...original, message: { ...original.message, ts: "9.000" } },
    { ...original, message: { ...original.message, thread_ts: "9.000" } },
    { ...original, actions: [{ ...original.actions[0], value: "999" }] },
    { ...original, actions: [{ ...original.actions[0], value: "1 OR 1=1" }] },
    { ...original, actions: [{ ...original.actions[0], value: "1.5" }] },
    {
      ...original,
      actions: [{ ...original.actions[0], value: "9007199254740992" }],
    },
    { ...original, actions: [...original.actions, ...original.actions] },
    { ...original, message: undefined },
    {},
    null,
  ];
  try {
    for (const payload of invalid)
      expect(f.gateway.cancel(payload)).toBe(false);
    expect(signal.aborted).toBe(false);
    f.finish.resolve("Completed answer");
    await work;
    expect(f.writes.at(-1)?.text).toBe("Completed answer");
  } finally {
    f.finish.resolve("Completed answer");
    await work;
  }
});

test("Stop rechecks current allows and denies", () => {
  for (const rule of [
    "users",
    "channels",
    "deniedUsers",
    "deniedChannels",
  ] as const) {
    const f = fixture();
    f.store.running(f.job.id);
    f.store.savePreview(f.job.id, 0, "2.000");
    f.config.access[rule] = rule.startsWith("denied")
      ? [rule === "deniedUsers" ? "U123" : "C123"]
      : [];
    expect(f.gateway.cancel(f.payload())).toBe(false);
  }
});

test("Stop is bound to the current bot/backend namespace", () => {
  const f = fixture();
  f.store.running(f.job.id);
  f.store.savePreview(f.job.id, 0, "2.000");
  const other = new Gateway(
    bot("another"),
    identity,
    f.store,
    f.backend,
    f.slack,
    pino({ enabled: false }),
  );
  expect(other.cancel(f.payload())).toBe(false);
  const changed = bot();
  if (changed.backend.type !== "opencode") throw new Error("Invalid fixture");
  changed.backend.directory = "/another";
  const backend = new Gateway(
    changed,
    identity,
    f.store,
    f.backend,
    f.slack,
    pino({ enabled: false }),
  );
  expect(backend.cancel(f.payload())).toBe(false);
});

test("accepted Stop wins over a backend answer that races with cancellation", async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  f.backend.prompt = async (_session, _text, _signal, onText) => {
    onText?.("Partial answer");
    await Promise.resolve();
    started.resolve();
    return f.finish.promise;
  };
  const work = f.gateway.process(f.job, new AbortController().signal);
  await started.promise;
  expect(f.gateway.cancel(f.payload())).toBe(true);
  f.finish.resolve("Too late answer");
  await work;
  expect(f.writes.at(-1)?.text).toContain("stop request");
});

test("a stale button cannot stop the next request in the same thread", async () => {
  const f = fixture();
  const work = f.gateway.process(f.job, new AbortController().signal);
  await f.started;
  f.finish.resolve("Completed answer");
  await work;
  f.gateway.accept({
    ...event(),
    event: {
      ...event("<@UBOT> Follow-up", "3.000").event,
      thread_ts: "1.000",
    },
  });
  const next = f.next();
  f.store.running(next.id);
  f.store.savePreview(next.id, 0, "4.000");
  expect(f.gateway.cancel(f.payload())).toBe(false);
  const forged = f.payload();
  forged.actions[0] = {
    type: "button",
    action_id: "pogo_stop",
    value: String(next.id),
  };
  expect(f.gateway.cancel(forged)).toBe(false);
  expect(f.store.jobStatus(f.gateway.key, next.id)).toBe("running");
});

test("completed response wins over a late Stop while Slack delivery is pending", async () => {
  const f = fixture();
  const delivering = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.slack.update = async () => {
    delivering.resolve();
    await release.promise;
  };
  const work = f.gateway.process(f.job, new AbortController().signal);
  await f.started;
  f.finish.resolve("Completed answer");
  await delivering.promise;
  try {
    expect(f.gateway.cancel(f.payload())).toBe(false);
    expect(f.next().response).toBe(JSON.stringify(["Completed answer"]));
  } finally {
    release.resolve();
    await work;
  }
});

test("accepted Stop survives restart and failed delivery without replay", async () => {
  const f = fixture();
  f.store.running(f.job.id);
  f.store.saveSession(f.job.conversation, "surviving-session");
  f.store.savePreview(f.job.id, 0, "2.000");
  expect(f.gateway.cancel(f.payload())).toBe(true);
  expect(f.store.interruptedSessions(f.gateway.key)).toEqual([
    "surviving-session",
  ]);
  f.store.recover(f.gateway.key);
  f.slack.update = async () => {
    throw new Error("Slack unavailable");
  };
  await f.gateway.process(f.next(), new AbortController().signal);
  expect(f.next().status).toBe("responding");
  f.slack.update = async (_channel, _ts, text) => {
    f.writes.push({ text });
  };
  await f.gateway.process(f.next(), new AbortController().signal);
  expect(f.writes.at(-1)?.text).toContain("stop request");
  expect(f.prompts()).toBe(0);
  expect(f.store.jobStatus(f.gateway.key, f.job.id)).toBe("done");
});

test("queued Stop persists a terminal reply and stale selection cannot start work", async () => {
  const f = fixture();
  f.store.savePreview(f.job.id, 0, "2.000");
  expect(f.gateway.cancel(f.payload())).toBe(true);
  expect(f.next().status).toBe("responding");
  await f.gateway.process(f.job, new AbortController().signal);
  expect(f.prompts()).toBe(0);
  await f.gateway.process(f.next(), new AbortController().signal);
  expect(f.writes.at(-1)?.text).toContain("stop request");
});

test("Stop commits before Socket ACK and an ACK failure does not undo cancellation", async () => {
  const f = fixture();
  f.store.running(f.job.id);
  f.store.savePreview(f.job.id, 0, "2.000");
  let acknowledgements = 0;
  await handleSlackRequest(
    {
      type: "interactive",
      body: f.payload(),
      ack: async () => {
        acknowledgements++;
        f.store.recover(f.gateway.key);
        expect(f.next().response).toContain("stop request");
        throw new Error("ACK failed");
      },
    },
    () => false,
    pino({ enabled: false }),
    {
      async command(_body, ack) {
        await ack();
      },
      async interactive(body, ack) {
        f.gateway.cancel(body);
        await ack();
      },
    },
  );
  expect(acknowledgements).toBe(1);
  expect(f.next().response).toContain("stop request");
});
