import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import {
  type AgentBackend,
  latestInput,
  type Transcript,
  TranscriptUnavailable,
} from "../src/backend";
import { Gateway, type SlackDelivery } from "../src/gateway";
import { backendFingerprint, botKey, conversationKey } from "../src/routing";
import { Store } from "../src/store";
import { repairTranscript } from "../src/transcript";
import { bot, event, identity } from "./fixtures";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function fixture(store = new Store(":memory:"), ownStore = true) {
  if (ownStore) cleanup.push(() => store.close());
  const config = bot();
  config.access.channels = ["*"];
  const prompts: { session: string; text: string }[] = [];
  const validated: string[] = [];
  const backend: AgentBackend = {
    sessionID: "original-captain",
    async createSession({ key }) {
      validated.push(key);
      return "original-captain";
    },
    async prompt(session, text) {
      prompts.push({ session, text });
      return `answer: ${text}`;
    },
    async close() {},
  };
  const posts: { channel: string; thread: string; text: string }[] = [];
  const slack: SlackDelivery = {
    async post(channel, thread, text) {
      posts.push({ channel, thread, text });
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
  cleanup.push(() => gateway.close());
  const signal = new AbortController().signal;
  const next = () => {
    const job = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1)[0];
    if (!job) throw new Error("Missing job");
    return job;
  };
  const drain = async () => {
    while (store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1).length)
      await gateway.process(next(), signal);
  };
  return {
    config,
    store,
    backend,
    slack,
    gateway,
    signal,
    next,
    drain,
    prompts,
    posts,
    validated,
  };
}

function source(channel: string, text: string, ts: string, thread?: string) {
  const request = event(text, ts);
  return {
    ...request,
    event: {
      ...request.event,
      channel,
      type: "message",
      ...(channel.startsWith("D") ? { channel_type: "im" } : {}),
      ...(thread ? { thread_ts: thread } : {}),
    },
  };
}

test("DM, two channels and cron use the original root without source mappings", async () => {
  const f = fixture();
  // Legacy roots are retained, never reused for captain turns.
  const legacy = conversationKey(f.gateway.key, "C123", "2.000");
  f.store.saveSession(legacy, "old-channel-root", "old-cursor");
  f.gateway.accept(source("D123", "dm", "1.000"));
  f.gateway.accept(source("C123", "<@UBOT> first", "2.000"));
  f.gateway.accept(source("C456", "<@UBOT> second", "3.000"));
  const scheduled = f.gateway.enqueueScheduled({
    runId: "daily",
    name: "Daily",
    channel: "C456",
    thread: "4.000",
    user: "U123",
    prompt: "cron",
  });
  await f.drain();
  expect(f.prompts.map((prompt) => prompt.session)).toEqual(
    Array(4).fill("original-captain"),
  );
  expect(f.posts.map(({ channel, thread }) => [channel, thread])).toEqual([
    ["D123", "1.000"],
    ["C123", "2.000"],
    ["C456", "3.000"],
    ["C456", "4.000"],
  ]);
  expect(f.store.session(legacy)).toBe("old-channel-root");
  expect(
    f.store.session(conversationKey(f.gateway.key, "D123", "1.000")),
  ).toBeUndefined();
  expect(scheduled && f.gateway.scheduledStatus(scheduled)).toBe("done");
});

test("pin leaves the old namespace and per-source follow-up admission intact", async () => {
  const config = bot();
  const before = backendFingerprint(config);
  if (config.backend.type !== "opencode") throw new Error("Expected OpenCode");
  config.backend.sessionID = "original-captain";
  expect(backendFingerprint(config)).toBe(before);
  expect(botKey(config, identity)).toBe(botKey(bot(), identity));
  const f = fixture();
  f.gateway.accept(source("C123", "<@UBOT> hello", "1.000"));
  await f.drain();
  expect(
    f.gateway.accept(source("C456", "unmentioned", "2.000", "1.000")),
  ).toBe(false);
  expect(
    f.gateway.accept(source("C123", "unmentioned", "2.000", "9.000")),
  ).toBe(false);
  expect(f.gateway.accept(source("C123", "follow", "2.000", "1.000"))).toBe(
    true,
  );
});

test("first requests from concurrent sources share one execution slot", async () => {
  const f = fixture();
  const first = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  let active = 0;
  let maximum = 0;
  f.backend.prompt = async (session, text) => {
    f.prompts.push({ session, text });
    maximum = Math.max(maximum, ++active);
    if (text === "first") {
      first.resolve();
      await release.promise;
    }
    active--;
    if (text === "second") done.resolve();
    return text;
  };
  f.gateway.accept(source("D123", "first", "1.000"));
  f.gateway.accept(source("C123", "<@UBOT> second", "2.000"));
  const stop = new AbortController();
  const work = f.gateway.work(stop.signal);
  await first.promise;
  // One poll already considered both source jobs.
  expect(f.prompts.map(({ text }) => text)).toEqual(["first"]);
  release.resolve();
  await done.promise;
  stop.abort();
  await work;
  expect(maximum).toBe(1);
});

test("thread context is first-source scoped even though the pinned root exists", async () => {
  const f = fixture();
  f.config.threadContext = true;
  const contexts: string[] = [];
  f.slack.threadContext = async ({ channel }) => {
    contexts.push(channel);
    return {
      messages: [{ author: "requester", text: channel }],
      truncated: false,
    };
  };
  for (const channel of ["C123", "C456"]) {
    f.gateway.accept(source(channel, "<@UBOT> summarize", "3.000", "1.000"));
    await f.drain();
    f.gateway.accept(source(channel, "continue", "4.000", "1.000"));
    await f.drain();
  }
  expect(contexts).toEqual(["C123", "C456"]);
  expect(f.prompts[0]?.text).toContain('"text":"C123"');
  expect(f.prompts[2]?.text).toContain('"text":"C456"');
});

test("captain repair fails closed instead of using a legacy thread root", async () => {
  const f = fixture();
  f.backend.transcript = async (): Promise<Transcript> => ({
    cursor: "",
    entries: [],
  });
  await expect(
    repairTranscript({
      store: f.store,
      backend: f.backend,
      botKey: f.gateway.key,
      channel: "C123",
      thread: "1.000",
      since: "old",
      apply: true,
    }),
  ).rejects.toThrow("Captain-scoped transcript repair unsupported");
});

function nativeFixture(store?: Store, ownStore = true) {
  const f = fixture(store, ownStore);
  type Message = {
    id: string;
    kind: "input" | "assistant" | "synthetic";
    text: string;
    settled: boolean;
  };
  const history: Message[] = [];
  let serial = 0;
  let input: string | undefined;
  let broken = false;
  const add = (kind: Message["kind"], text = "", settled = true) => {
    const id = `native-${++serial}`;
    history.push({ id, kind, text, settled });
    return id;
  };
  let turn = async (text: string, _signal: AbortSignal) => {
    const answer = `answer: ${text}`;
    add("assistant", answer);
    return answer;
  };
  f.backend.prompt = async (session, text, signal, _onText, onInput) => {
    f.prompts.push({ session, text });
    input = `native-${serial + 1}`;
    onInput?.(input);
    add("input");
    return turn(text, signal);
  };
  f.backend.transcript = async (_session, cursor) => {
    if (broken) throw new Error("History unreadable");
    const after = cursor === latestInput ? input : cursor;
    if (cursor === latestInput && after === undefined)
      throw new TranscriptUnavailable("cursor");
    const open = history.findIndex((message) => !message.settled);
    const done = open < 0 ? history : history.slice(0, open);
    if (after === undefined)
      return { cursor: done.at(-1)?.id ?? "", entries: [] };
    const index =
      after === "" ? -1 : done.findIndex((message) => message.id === after);
    if (after !== "" && index < 0) throw new TranscriptUnavailable("cursor");
    let boundary: string | undefined;
    const entries = done.slice(index + 1).flatMap((message) => {
      if (message.kind === "input") boundary = message.id;
      return message.kind === "assistant" && message.text
        ? [
            {
              id: message.id,
              text: message.text,
              created: 1,
              ...(boundary ? { input: boundary } : {}),
            },
          ]
        : [];
    });
    return {
      cursor: done.at(-1)?.id ?? after,
      entries,
      ...(boundary ? { input: boundary } : {}),
      ...(open < 0 ? {} : { pending: true }),
    };
  };
  return {
    ...f,
    history,
    add,
    setTurn(next: typeof turn) {
      turn = next;
    },
    breakReads(value: boolean) {
      broken = value;
    },
    async settle(session = "original-captain") {
      f.gateway.settle(session);
      await f.gateway.catchUp(f.signal);
      await f.drain();
    },
  };
}

test("one cursor routes prior continuation and current answer to their own sources", async () => {
  const f = nativeFixture();
  f.gateway.accept(source("D123", "first", "1.000"));
  await f.drain();
  f.add("synthetic");
  f.add("assistant", "DM background completion");
  // Queuing a channel request must not make it own the earlier DM update.
  f.gateway.accept(source("C123", "<@UBOT> second", "2.000"));
  await f.drain();
  expect(f.posts).toEqual([
    { channel: "D123", thread: "1.000", text: "answer: first" },
    { channel: "C123", thread: "2.000", text: "answer: second" },
    { channel: "D123", thread: "1.000", text: "DM background completion" },
  ]);
  await f.settle();
  await f.settle();
  expect(f.posts).toHaveLength(3);
  expect(f.prompts).toHaveLength(2);
});

test("native UI input clears Slack ownership, including an input with no output", async () => {
  const f = nativeFixture();
  f.gateway.accept(source("D123", "first", "1.000"));
  await f.drain();
  f.add("input", "native UI");
  await f.settle();
  expect(
    f.store.captainCursor(f.gateway.key, "original-captain").owner,
  ).toBeNull();
  f.add("assistant", "Private UI output");
  await f.settle();
  f.add("input", "more UI");
  f.add("assistant", "More private UI output");
  f.gateway.accept(source("C123", "<@UBOT> second", "2.000"));
  await f.drain();
  expect(f.posts.map((post) => post.text)).toEqual([
    "answer: first",
    "answer: second",
  ]);
});

test("a source turn excludes interleaved native UI output", async () => {
  const f = nativeFixture();
  f.setTurn(async () => {
    f.add("assistant", "Own answer");
    f.add("input", "UI instruction");
    f.add("assistant", "Private UI answer");
    return "Own answer";
  });
  f.gateway.accept(source("D123", "first", "1.000"));
  await f.drain();
  expect(f.posts.map((post) => post.text)).toEqual(["Own answer"]);
  await f.settle();
  expect(f.posts).toHaveLength(1);
});

test("legacy mappings never broadcast; matching original cursor retains one owner", async () => {
  const f = nativeFixture();
  const old = f.add("assistant", "Already delivered");
  f.gateway.accept(source("D123", "old", "1.000"));
  const job = f.next();
  f.store.running(job.id);
  f.store.saveSession(job.conversation, "original-captain", old);
  f.store.respond(job.id, ["Already delivered"]);
  f.store.finish(job.id);
  for (const [channel, thread, session] of [
    ["C123", "2.000", "other-root"],
    ["C456", "3.000", "other-root-2"],
  ]) {
    if (!channel || !thread || !session) throw new Error("Missing fixture");
    f.gateway.accept(source(channel, "<@UBOT> old", thread));
    const other = f.next();
    f.store.saveSession(other.conversation, session, "old-cursor");
    f.store.respond(other.id, ["Old channel answer"]);
    f.store.finish(other.id);
  }
  f.add("assistant", "Late original completion");
  await f.settle("other-root");
  expect(f.posts).toEqual([]);
  await f.settle();
  await f.settle();
  expect(f.posts).toEqual([
    { channel: "D123", thread: "1.000", text: "Late original completion" },
  ]);
  expect(f.store.session(job.conversation)).toBe("original-captain");
});

test("unreadable final history defers owned delivery and retries without a prompt", async () => {
  const f = nativeFixture();
  f.setTurn(async () => {
    f.add("assistant", "Owned deferred answer");
    f.breakReads(true);
    return "Owned deferred answer";
  });
  f.gateway.accept(source("D123", "first", "1.000"));
  await f.drain();
  expect(f.posts.some((post) => post.text === "Owned deferred answer")).toBe(
    false,
  );
  f.breakReads(false);
  await f.gateway.catchUp(f.signal);
  await f.drain();
  await f.settle();
  expect(
    f.posts.filter((post) => post.text === "Owned deferred answer"),
  ).toHaveLength(1);
  expect(f.prompts).toHaveLength(1);
});

test("delivery retries keep the exact destination and never read or prompt again", async () => {
  const f = nativeFixture();
  const post = f.slack.post;
  f.slack.post = async () => {
    throw new Error("Slack unavailable");
  };
  f.gateway.accept(source("D123", "first", "1.000"));
  await f.gateway.process(f.next(), f.signal);
  f.backend.transcript = async () => {
    throw new Error("No retry reads");
  };
  f.slack.post = post;
  await f.gateway.process(f.next(), f.signal);
  expect(f.posts).toEqual([
    { channel: "D123", thread: "1.000", text: "answer: first" },
  ]);
  expect(f.prompts).toHaveLength(1);
});

test("a new running source cannot steal legacy ownership before native admission", async () => {
  const f = nativeFixture();
  const head = f.add("assistant", "Old answer");
  f.gateway.accept(source("D123", "old", "1.000"));
  const old = f.next();
  f.store.running(old.id);
  f.store.saveSession(old.conversation, "original-captain", head);
  f.store.respond(old.id, ["Old answer"]);
  f.store.finish(old.id);
  f.add("assistant", "Old continuation");
  f.gateway.accept(source("D123", "next", "2.000", "1.000"));
  await f.drain();
  expect(f.posts.map((post) => post.text)).toEqual([
    "answer: next",
    "Old continuation",
  ]);
});

test("pending completion remains eligible without a new request or watch event", async () => {
  const f = nativeFixture();
  f.setTurn(async () => {
    f.add("assistant", "Still settling", false);
    return "Still settling";
  });
  f.gateway.accept(source("D123", "first", "1.000"));
  await f.drain();
  await f.gateway.catchUp(f.signal); // Still pending; do not lose the retry.
  for (const message of f.history) message.settled = true;
  await f.gateway.catchUp(f.signal);
  await f.drain();
  expect(f.posts.filter((post) => post.text === "Still settling")).toHaveLength(
    1,
  );
  expect(f.prompts).toHaveLength(1);
});

test("lost captain cursor re-anchors current ownership, not the previous source", async () => {
  const f = nativeFixture();
  f.gateway.accept(source("D123", "first", "1.000"));
  await f.drain();
  f.history.pop(); // Native revert removes the accounted-for assistant message.
  f.add("assistant", "Unplaceable continuation");
  f.gateway.accept(source("C123", "<@UBOT> second", "2.000"));
  await f.drain();
  expect(f.posts).toEqual([
    { channel: "D123", thread: "1.000", text: "answer: first" },
    { channel: "C123", thread: "2.000", text: "answer: second" },
  ]);
});

test("restart preserves source jobs, input ownership and the one delivery cursor", async () => {
  const directory = await mkdtemp("/tmp/opencode/pogo-captain-");
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "pogo.sqlite");
  const first = new Store(path);
  const f = nativeFixture(first, false);
  f.gateway.accept(source("D123", "first", "1.000"));
  await f.drain();
  const cursor = first.captainCursor(f.gateway.key, "original-captain");
  await f.gateway.close();
  first.close();
  f.add("synthetic");
  f.add("assistant", "Completed during restart");
  const reopened = new Store(path);
  cleanup.push(() => reopened.close());
  const gateway = new Gateway(
    f.config,
    identity,
    reopened,
    f.backend,
    f.slack,
    pino({ enabled: false }),
  );
  cleanup.push(() => gateway.close());
  expect(reopened.captainCursor(gateway.key, "original-captain")).toEqual(
    cursor,
  );
  gateway.settle();
  await gateway.catchUp(f.signal);
  const pending = reopened.ready(gateway.key, Date.now(), 10);
  for (const job of pending) await gateway.process(job, f.signal);
  gateway.settle();
  await gateway.catchUp(f.signal);
  expect(reopened.ready(gateway.key, Date.now(), 10)).toEqual([]);
  expect(f.posts).toEqual([
    { channel: "D123", thread: "1.000", text: "answer: first" },
    { channel: "D123", thread: "1.000", text: "Completed during restart" },
  ]);
  expect(f.prompts).toHaveLength(1);
});

test("Stop still requires the exact requester, source and preview", async () => {
  const f = nativeFixture();
  const started = Promise.withResolvers<void>();
  f.setTurn(async (_text, signal) => {
    f.add("assistant", "Owned progress");
    started.resolve();
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  });
  f.slack.update = async () => true;
  f.gateway.accept(source("D123", "first", "1.000"));
  const job = f.next();
  f.store.savePreview(job.id, 0, "100.000");
  const work = f.gateway.process(job, f.signal);
  await started.promise;
  const stop = {
    type: "block_actions",
    api_app_id: "A123",
    team: { id: "T123" },
    user: { id: "U123" },
    channel: { id: "D123" },
    container: { type: "message", channel_id: "D123", message_ts: "100.000" },
    message: { user: "UBOT", ts: "100.000", thread_ts: "1.000" },
    actions: [
      { type: "button", action_id: "pogo_stop", value: String(job.id) },
    ],
  };
  expect(f.gateway.cancel({ ...stop, user: { id: "UOTHER" } })).toBe(false);
  expect(f.gateway.cancel({ ...stop, channel: { id: "C123" } })).toBe(false);
  expect(f.gateway.cancel(stop)).toBe(true);
  await work;
  expect(f.store.failure(job.id)).toBe("cancelled");
  f.add("assistant", "Late owned completion");
  await f.settle();
  expect(f.posts.at(-1)).toEqual({
    channel: "D123",
    thread: "1.000",
    text: "Late owned completion",
  });
  expect(f.prompts).toHaveLength(1);
});

test("recovery interrupts only the proven captain owner, never legacy or native UI work", async () => {
  for (const [uiOwns, guarded] of [
    [false, true],
    [true, true],
    [false, false],
  ]) {
    const f = nativeFixture();
    f.gateway.accept(source("D123", "interrupted", "1.000"));
    const job = f.next();
    f.store.running(job.id);
    f.store.saveSession(job.conversation, "legacy-other-root", "old-cursor");
    f.store.captainCursor(f.gateway.key, "original-captain");
    const input = f.add("input");
    f.store.saveInput(f.gateway.key, job.id, input, "original-captain");
    // A settled transcript stops here and hides the later raw UI input.
    f.add("assistant", "Unmarked Pogo output", false);
    if (uiOwns) f.add("input", "native UI instruction");
    const interrupted: string[] = [];
    f.backend.interrupt = async (session) => {
      throw new Error(`Broad interruption is not ownership proof: ${session}`);
    };
    if (guarded)
      f.backend.interruptInput = async (session, expected) => {
        expect(session).toBe("original-captain");
        expect(expected).toBe(input);
        const latest = f.history.findLast(
          (message) => message.kind === "input",
        );
        if (latest?.id === expected) interrupted.push(session);
      };
    const delivered = Promise.withResolvers<void>();
    const post = f.slack.post;
    f.slack.post = async (channel, thread, text) => {
      await post(channel, thread, text);
      delivered.resolve();
    };
    const stop = new AbortController();
    const work = f.gateway.work(stop.signal);
    await delivered.promise;
    stop.abort();
    await work;
    expect(interrupted).toEqual(!uiOwns && guarded ? ["original-captain"] : []);
    expect(f.prompts).toEqual([]);
    expect(f.store.failure(job.id)).toBe("interrupted");
    expect(f.store.session(job.conversation)).toBe("legacy-other-root");
  }
});

test("an allocated input not readable yet keeps catch-up eligible", async () => {
  const f = nativeFixture();
  f.breakReads(true); // Initial baseline and final history both unavailable.
  f.setTurn(async () => {
    f.add("assistant", "Deferred after admission");
    return "Deferred after admission";
  });
  f.gateway.accept(source("D123", "first", "1.000"));
  await f.drain();
  f.breakReads(false);
  const transcript = f.backend.transcript;
  if (!transcript) throw new Error("Missing transcript");
  let pending = true;
  f.backend.transcript = async (session, cursor, signal) => {
    if (pending) throw new TranscriptUnavailable("cursor");
    return transcript(session, cursor, signal);
  };
  await f.gateway.catchUp(f.signal);
  pending = false;
  await f.settle(); // A settle event must not remain permanently suppressed.
  expect(
    f.posts.filter((post) => post.text === "Deferred after admission"),
  ).toHaveLength(1);
  expect(f.prompts).toHaveLength(1);
});
