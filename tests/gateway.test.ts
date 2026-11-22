import { afterEach, expect, test } from "bun:test";
import pino from "pino";
import {
  type AgentBackend,
  latestInput,
  TranscriptUnavailable,
} from "../src/backend";
import { Gateway } from "../src/gateway/gateway";
import type { TransportDelivery } from "../src/gateway/ports";
import { PromptNotSubmitted } from "../src/shared/request-failure";
import { handleSlackRequest } from "../src/slack/slack";
import { Store } from "../src/gateway/store";
import { ThreadContextUnavailable } from "../src/gateway/thread-context";
import { bot, event, identity } from "./fixtures";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function fixture(config = bot()) {
  const store = new Store(":memory:");
  stores.push(store);
  const prompts: { session: string; text: string }[] = [];
  const titles: string[] = [];
  let sessions = 0;
  const backend: AgentBackend = {
    async createSession({ title }) {
      titles.push(title);
      return `session-${++sessions}`;
    },
    async prompt(session, text) {
      prompts.push({ session, text });
      return `answer: ${text}`;
    },
    async close() {},
  };
  const delivered: string[] = [];
  const slack: TransportDelivery = {
    async post(_channel: string, _thread: string, text: string) {
      delivered.push(text);
    },
  };
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
  return {
    store,
    backend,
    config,
    gateway,
    prompts,
    titles,
    delivered,
    slack,
    next,
  };
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
  expect(f.titles).toEqual(["helper (slack C123)"]);
});

test("timeout before native submission cannot read a previous turn as the new reply", async () => {
  const config = bot();
  config.turnTimeoutMs = 100;
  const f = fixture(config);
  let staleAnchorReads = 0;
  Object.assign(f.backend, {
    sessionID: "session-1",
    async prompt(_session: string, _text: string, signal: AbortSignal) {
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      throw new PromptNotSubmitted();
    },
    async transcript(_session: string, cursor: string | undefined) {
      if (cursor === latestInput) {
        staleAnchorReads++;
        return {
          cursor: "prior-reply",
          entries: [{ id: "prior-reply", text: "Earlier turn", created: 1 }],
        };
      }
      throw new TranscriptUnavailable("cursor");
    },
  } satisfies Partial<AgentBackend>);
  expect(f.gateway.accept(event())).toBe(true);
  await f.gateway.process(f.next(), AbortSignal.timeout(3000));
  expect(staleAnchorReads).toBe(0);
  expect(f.delivered).toHaveLength(1);
  expect(f.delivered[0]).toContain("reached the request time limit");
});

test("resumes an existing Slack thread only after seeing this bot's earlier reply", async () => {
  const config = bot();
  config.resumeSlackThreads = true;
  const f = fixture(config);
  const request = event("Continue", "2.000");
  const reply = {
    ...request,
    event: { ...request.event, type: "message", thread_ts: "1.000" },
  };
  f.slack.threadContext = async () => ({
    messages: [{ author: "requester", text: "Earlier question" }],
    truncated: false,
  });
  expect(await f.gateway.receive(reply)).toBe(false);
  f.slack.threadContext = async () => {
    throw new ThreadContextUnavailable();
  };
  await expect(f.gateway.receive(reply)).rejects.toThrow(
    ThreadContextUnavailable,
  );
  f.slack.threadContext = async (input) => {
    expect(input).toMatchObject({
      channel: "C123",
      thread: "1.000",
      before: "2.000",
      botUser: "UBOT",
    });
    return {
      messages: [{ author: "this_bot", text: "Earlier reply" }],
      truncated: false,
    };
  };
  expect(await f.gateway.receive(reply)).toBe(true);
  expect(await f.gateway.receive(reply)).toBe(false);
  await f.gateway.process(f.next(), new AbortController().signal);
  expect(f.delivered).toEqual(["answer: Continue"]);
});

test("a Slack read receipt marks the request before work and clears after delivery", async () => {
  const config = bot();
  config.slackReadReceipts = true;
  const f = fixture(config);
  const order: string[] = [];
  f.slack.readReceipt = async (channel, ts, active) => {
    order.push(`${active ? "seen" : "clear"} ${channel}:${ts}`);
  };
  f.slack.post = async () => {
    order.push("delivered");
  };
  expect(await f.gateway.receive(event())).toBe(true);
  await f.gateway.process(f.next(), new AbortController().signal);
  expect(order).toEqual(["seen C123:1.000", "delivered", "clear C123:1.000"]);
});

test("reaction support does not prepend instructions to user messages", async () => {
  const f = fixture();
  const reactions: string[] = [];
  f.slack.react = async (_channel, _ts, name) => {
    reactions.push(name);
  };
  for (const [index, text] of [
    "Can you unblock them?",
    "Keep going.",
  ].entries()) {
    const request = event(`<@UBOT> ${text}`, `${index + 1}.000`);
    f.gateway.accept({
      ...request,
      event: { ...request.event, thread_ts: "1.000" },
    });
    await f.gateway.process(f.next(), new AbortController().signal);
  }
  expect(f.prompts.map(({ text }) => text)).toEqual([
    "Can you unblock them?",
    "Keep going.",
  ]);
  expect(reactions).toEqual([]);
});

test("friendly session titles use the bot name without merging Slack threads", async () => {
  const config = bot();
  config.displayName = "Galactica Captain";
  const f = fixture(config);
  for (const ts of ["1.000", "2.000"]) {
    const request = event("hello", ts);
    expect(
      f.gateway.accept({
        ...request,
        event: {
          ...request.event,
          type: "message",
          channel: "D123",
          channel_type: "im",
        },
      }),
    ).toBe(true);
    await f.gateway.process(f.next(), new AbortController().signal);
  }
  expect(f.titles).toEqual([
    "Galactica Captain (slack D123)",
    "Galactica Captain (slack D123)",
  ]);
  expect(f.prompts).toEqual([
    { session: "session-1", text: "hello" },
    { session: "session-2", text: "hello" },
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
  const waiting = f.next();
  f.store.running(waiting.id);
  f.store.respond(waiting.id, ["private reply"]);
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
      if (responding) {
        const waiting = f.next();
        f.store.running(waiting.id);
        f.store.respond(waiting.id, ["private reply"]);
      }
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

test("scheduled prompts enter the durable thread queue once and permit follow-up", async () => {
  const f = fixture();
  const scheduled = {
    runId: "run-1",
    name: "Daily review",
    channel: "C123",
    thread: "9.000",
    user: "U123",
    prompt: "Review today's changes",
  };
  const id = f.gateway.enqueueScheduled(scheduled);
  expect(id).toBeNumber();
  expect(f.gateway.enqueueScheduled(scheduled)).toBe(id);
  if (id === undefined) throw new Error("Missing scheduled job");
  expect(f.gateway.scheduledStatus(id)).toBe("queued");
  await f.gateway.process(f.next(), new AbortController().signal);
  expect(f.gateway.scheduledStatus(id)).toBe("done");
  expect(f.prompts).toEqual([{ session: "session-1", text: scheduled.prompt }]);
  expect(
    f.gateway.accept({
      ...event(),
      event: {
        ...event("Explain", "10.000").event,
        type: "message",
        thread_ts: "9.000",
      },
    }),
  ).toBe(true);
  await f.gateway.process(f.next(), new AbortController().signal);
  expect(f.prompts[1]).toEqual({ session: "session-1", text: "Explain" });
});

test("scheduled prompts recheck creator and channel access", () => {
  const f = fixture();
  const input = {
    runId: "run-1",
    name: "Review",
    channel: "C123",
    thread: "9.000",
    user: "U123",
    prompt: "Review changes",
  };
  expect(
    f.gateway.enqueueScheduled({ ...input, user: "UOTHER" }),
  ).toBeUndefined();
  expect(
    f.gateway.enqueueScheduled({ ...input, channel: "COTHER" }),
  ).toBeUndefined();
  expect(f.store.ready(f.gateway.key, Date.now(), 10)).toEqual([]);
});

function initialThreadReply(text = "<@UBOT> summarize", ts = "3.000") {
  return {
    ...event(),
    event: { ...event(text, ts).event, thread_ts: "1.000" },
  };
}

test("initial context is off by default and does not change the prompt", async () => {
  const f = fixture();
  let historyCalls = 0;
  f.slack.threadContext = async () => {
    historyCalls++;
    throw new Error("History must not be fetched");
  };
  f.gateway.accept(initialThreadReply());
  await f.gateway.process(f.next(), new AbortController().signal);
  expect(historyCalls).toBe(0);
  expect(f.prompts).toEqual([{ session: "session-1", text: "summarize" }]);
});

test("context starts after durable accept and ACK, only for the first session turn", async () => {
  const f = fixture();
  f.config.threadContext = true;
  const steps: string[] = [];
  await handleSlackRequest(
    {
      type: "events_api",
      body: initialThreadReply(),
      ack: async () => {
        expect(f.next().text).toBe("summarize");
        steps.push("ack");
      },
    },
    (body) => {
      const accepted = f.gateway.accept(body);
      steps.push("persist");
      return accepted;
    },
    pino({ enabled: false }),
  );
  expect(steps).toEqual(["persist", "ack"]);
  const job = f.next();
  // ready() no longer returns running jobs; use the durable accepted ID here.
  f.slack.threadContext = async (input) => {
    expect(f.store.jobStatus(f.gateway.key, job.id)).toBe("running");
    expect(input).toMatchObject({
      channel: "C123",
      thread: "1.000",
      before: "3.000",
      user: "U123",
      botUser: "UBOT",
      appId: "A123",
      team: "T123",
    });
    expect(input.signal.aborted).toBe(false);
    steps.push("history");
    return {
      messages: [{ author: "requester", text: "prior text" }],
      truncated: true,
    };
  };
  await f.gateway.process(job, new AbortController().signal);
  expect(steps).toEqual(["persist", "ack", "history"]);
  expect(f.prompts[0]?.text).toContain('"truncated":true');
  expect(f.prompts[0]?.text).toContain('"text":"prior text"');
  expect(f.prompts[0]?.text).toEndWith("Current user instruction:\nsummarize");
  f.gateway.accept(initialThreadReply("continue", "4.000"));
  await f.gateway.process(f.next(), new AbortController().signal);
  expect(steps).toEqual(["persist", "ack", "history"]);
  expect(f.prompts[1]).toEqual({ session: "session-1", text: "continue" });
});

test("roots, scheduled runs and existing sessions never fetch initial context", async () => {
  for (const kind of ["root", "scheduled", "existing"] as const) {
    const f = fixture();
    f.config.threadContext = true;
    let historyCalls = 0;
    f.slack.threadContext = async () => {
      historyCalls++;
      throw new Error("History must not be fetched");
    };
    if (kind === "scheduled") {
      f.gateway.enqueueScheduled({
        runId: "run-1",
        channel: "C123",
        thread: "1.000",
        user: "U123",
        prompt: "scheduled instruction",
        name: "Task",
      });
    } else {
      f.gateway.accept(kind === "root" ? event() : initialThreadReply());
    }
    const job = f.next();
    if (kind === "existing") f.store.saveSession(job.conversation, "existing");
    await f.gateway.process(job, new AbortController().signal);
    expect(historyCalls).toBe(0);
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]?.text).not.toContain("untrustedSlackThreadContext");
  }
});

test("context rechecks user and channel access before history or backend calls", async () => {
  for (const field of ["deniedUsers", "deniedChannels"] as const) {
    const f = fixture();
    f.config.threadContext = true;
    let historyCalls = 0;
    f.slack.threadContext = async () => {
      historyCalls++;
      return { messages: [], truncated: false };
    };
    expect(f.gateway.accept(initialThreadReply())).toBe(true);
    f.config.access[field] = [field === "deniedUsers" ? "U123" : "C123"];
    await f.gateway.process(f.next(), new AbortController().signal);
    expect(historyCalls).toBe(0);
    expect(f.prompts).toEqual([]);
    expect(f.delivered).toEqual([]);
  }
  const f = fixture();
  f.config.threadContext = true;
  for (const request of [
    { ...initialThreadReply(), team_id: "TOTHER" },
    { ...initialThreadReply(), api_app_id: "AOTHER" },
    {
      ...initialThreadReply(),
      event: { ...initialThreadReply().event, user: "UOTHER" },
    },
    {
      ...initialThreadReply(),
      event: { ...initialThreadReply().event, channel: "COTHER" },
    },
  ]) {
    expect(f.gateway.accept(request)).toBe(false);
  }
  expect(f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
});

test("empty eligible history preserves the original user instruction", async () => {
  const f = fixture();
  f.config.threadContext = true;
  f.slack.threadContext = async () => ({ messages: [], truncated: false });
  f.gateway.accept(initialThreadReply());
  await f.gateway.process(f.next(), new AbortController().signal);
  expect(f.prompts).toEqual([{ session: "session-1", text: "summarize" }]);
});

test("delivery retries do not reload initial history", async () => {
  const f = fixture();
  f.config.threadContext = true;
  let historyCalls = 0;
  f.slack.threadContext = async () => {
    historyCalls++;
    return {
      messages: [{ author: "requester", text: "earlier" }],
      truncated: false,
    };
  };
  f.slack.post = async () => {
    throw new Error("Delivery unavailable");
  };
  f.gateway.accept(initialThreadReply());
  await f.gateway.process(f.next(), new AbortController().signal);
  f.slack.post = async (_channel, _thread, text) => {
    f.delivered.push(text);
  };
  await f.gateway.process(f.next(), new AbortController().signal);
  expect(historyCalls).toBe(1);
  expect(f.prompts).toHaveLength(1);
  expect(f.delivered).toHaveLength(1);
});

test("context failures and unsupported delivery fail closed before creating a session", async () => {
  for (const missing of [false, true]) {
    const f = fixture();
    f.config.threadContext = true;
    if (!missing)
      f.slack.threadContext = async () => {
        throw new ThreadContextUnavailable();
      };
    f.gateway.accept(initialThreadReply());
    const job = f.next();
    await f.gateway.process(job, new AbortController().signal);
    expect(f.store.session(job.conversation)).toBeUndefined();
    expect(f.prompts).toEqual([]);
    expect(f.delivered).toEqual([
      "Stargate could not load initial thread context. No agent turn was started. Check Slack history access and try again.",
    ]);
  }
});

test("canceling history prevents session creation and backend work", async () => {
  const f = fixture();
  f.config.threadContext = true;
  const started = Promise.withResolvers<void>();
  const controller = new AbortController();
  f.slack.threadContext = async ({ signal }) => {
    started.resolve();
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };
  f.gateway.accept(initialThreadReply());
  const job = f.next();
  const pending = f.gateway.process(job, controller.signal);
  await started.promise;
  controller.abort();
  await pending;
  expect(f.store.session(job.conversation)).toBeUndefined();
  expect(f.prompts).toEqual([]);
  expect(f.delivered).toEqual([]);
  expect(f.next().status).toBe("responding");
});

test("scheduled status lookups do not cross bot namespaces", () => {
  const f = fixture();
  f.gateway.accept(event());
  expect(f.store.jobStatus("another-bot", f.next().id)).toBeUndefined();
});

test("a failed poll stops the transcript watch and rejects the worker", async () => {
  const f = fixture();
  const watched = Promise.withResolvers<AbortSignal>();
  f.backend.transcript = async () => ({ cursor: "", entries: [] });
  f.backend.watch = async (_onSettled, signal) => {
    watched.resolve(signal);
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  };
  const ready = f.store.ready.bind(f.store);
  let polls = 0;
  f.store.ready = (...args) => {
    if (++polls === 2) throw new Error("database is locked");
    return ready(...args);
  };
  // Previously the worker waited forever for a watch that nothing aborted.
  await expect(f.gateway.work(new AbortController().signal)).rejects.toThrow(
    "database is locked",
  );
  expect((await watched.promise).aborted).toBe(true);
});

test("shutdown lets a running turn record its interruption before resolving", async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  f.backend.prompt = (_session, _text, signal) =>
    new Promise((_resolve, reject) => {
      started.resolve();
      signal.addEventListener(
        "abort",
        () => setTimeout(() => reject(new Error("stopped")), 20),
        { once: true },
      );
    });
  f.gateway.accept(event());
  const controller = new AbortController();
  const work = f.gateway.work(controller.signal);
  await started.promise;
  controller.abort();
  await work;
  // The turn settled inside the worker scope: its notice is durable.
  const job = f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 1)[0];
  expect(job?.status).toBe("responding");
  expect(job?.failure).toBe("interrupted");
});

test("a job that another writer finished during delivery is left as it is", async () => {
  const store = new Store(":memory:");
  stores.push(store);
  const lines: string[] = [];
  const posts: string[] = [];
  let job = 0;
  const gateway = new Gateway(
    bot(),
    identity,
    store,
    {
      async createSession() {
        return "session";
      },
      async prompt() {
        return "reply";
      },
      async close() {},
    },
    {
      async post(_channel, _thread, text) {
        posts.push(text);
        // Not a gateway path: the row ends while its chunk is in flight.
        expect(store.finish(job, "failed")).toBe(true);
      },
    },
    pino({ level: "error" }, { write: (line: string) => lines.push(line) }),
  );
  expect(gateway.accept(event())).toBe(true);
  const [queued] = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1);
  if (!queued) throw new Error("Expected a job");
  job = queued.id;
  await gateway.process(queued, new AbortController().signal);
  // The cursor write was refused and logged; the status was not overwritten.
  expect(posts).toEqual(["reply"]);
  expect(store.jobStatus(gateway.key, job)).toBe("failed");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('"transition":"sent"');
  expect(lines[0]).toContain("Job transition refused; nothing was written");
});
