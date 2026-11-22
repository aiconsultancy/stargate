import { expect, test } from "bun:test";
import pino from "pino";
import type { AgentBackend, Transcript } from "../src/backend";
import { Gateway, type SlackDelivery } from "../src/gateway/gateway";
import { type ReplyChunk, slackContent } from "../src/shared/slack-format";
import { type Job, Store } from "../src/gateway/store";
import { LiveReply } from "../src/gateway/streaming";
import { bot, event, identity } from "./fixtures";

type Post = { text: string; content: unknown; unit: unknown };

/** Deterministic stand-in: one prepared chunk per paragraph. */
function recorder() {
  const prepared: { text: string; unbounded: boolean | undefined }[] = [];
  const posts: Post[] = [];
  const updates: { text: string; content: unknown }[] = [];
  const slack: SlackDelivery & { failNext: number } = {
    failNext: 0,
    prepareReply(text, unbounded) {
      prepared.push({ text, unbounded });
      return text.split("\n\n").map((part) => ({
        text: part,
        content: slackContent(part),
      }));
    },
    async post(_channel, _thread, text, _stop, unit, content) {
      if (slack.failNext-- > 0) throw new Error("Slack unavailable");
      posts.push({ text, content, unit });
      return `${posts.length}.000`;
    },
    async update(_channel, _ts, text, _stop, content) {
      updates.push({ text, content });
    },
    async remove() {},
  };
  return { slack, prepared, posts, updates };
}

function gatewayWith(
  slack: SlackDelivery,
  options: { store?: Store; backend?: Partial<AgentBackend> } = {},
) {
  const store = options.store ?? new Store(":memory:");
  const backend: AgentBackend = {
    async createSession() {
      return "session";
    },
    async prompt() {
      return "First paragraph.\n\nSecond `<@U123>` paragraph.";
    },
    async close() {},
    ...options.backend,
  };
  const gateway = new Gateway(
    bot(),
    identity,
    store,
    backend,
    slack,
    pino({ enabled: false }),
  );
  const next = () => store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1)[0];
  return { store, gateway, next, signal: new AbortController().signal };
}

function pending(next: () => Job | undefined) {
  const job = next();
  if (!job) throw new Error("Missing job");
  return job;
}

test("final reply is prepared once from the full answer and keeps content through retry", async () => {
  const r = recorder();
  const f = gatewayWith(r.slack);
  f.gateway.accept(event());
  r.slack.failNext = 1;
  await f.gateway.process(pending(f.next), f.signal);
  // Delivery failed after persistence: the retry reads the stored payload.
  const retry = pending(
    () => f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 1)[0],
  );
  expect(JSON.parse(retry.response ?? "[]")).toEqual([
    { text: "First paragraph.", content: slackContent("First paragraph.") },
    {
      text: "Second `<@U123>` paragraph.",
      content: slackContent("Second `<@U123>` paragraph."),
    },
  ]);
  await f.gateway.process(retry, f.signal);
  expect(r.prepared).toEqual([
    {
      text: "First paragraph.\n\nSecond `<@U123>` paragraph.",
      unbounded: false,
    },
  ]);
  expect(r.posts.map(({ text, content }) => ({ text, content }))).toEqual([
    { text: "First paragraph.", content: slackContent("First paragraph.") },
    {
      text: "Second `<@U123>` paragraph.",
      content: slackContent("Second `<@U123>` paragraph."),
    },
  ]);
  f.store.close();
});

test("stored string chunks stay plain and are never classified again", async () => {
  const r = recorder();
  const f = gatewayWith(r.slack);
  f.gateway.accept(event());
  const job = pending(f.next);
  f.store.running(job.id);
  f.store.respond(job.id, ["old one", "old two"]);
  const stored = pending(
    () => f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 1)[0],
  );
  await f.gateway.process(stored, f.signal);
  expect(r.prepared).toEqual([]);
  expect(r.posts.map(({ text, content }) => ({ text, content }))).toEqual([
    { text: "old one", content: undefined },
    { text: "old two", content: undefined },
  ]);
  f.store.close();
});

test("a delivery without prepareReply still receives plain string chunks", async () => {
  const texts: [string, unknown][] = [];
  const f = gatewayWith({
    async post(_channel, _thread, text, _stop, _unit, content) {
      texts.push([text, content]);
      return "1.000";
    },
  });
  f.gateway.accept(event());
  await f.gateway.process(pending(f.next), f.signal);
  expect(texts).toEqual([[expect.stringContaining("Second"), undefined]]);
  f.store.close();
});

test("live previews prepare each whole snapshot once and hand chunks their content", async () => {
  const r = recorder();
  const store = new Store(":memory:");
  const gateway = new Gateway(
    bot(),
    identity,
    store,
    {
      async createSession() {
        return "session";
      },
      async prompt() {
        return "";
      },
      async close() {},
    },
    r.slack,
    pino({ enabled: false }),
  );
  gateway.accept(event());
  const job = pending(
    () => store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1)[0],
  );
  const live = new LiveReply(
    job,
    store,
    r.slack,
    new AbortController().signal,
    pino({ enabled: false }),
    { intervalMs: 0 },
  );
  live.push("One\n\nTwo");
  while (r.posts.length < 2) await Bun.sleep(1);
  live.push("One\n\nTwo\n\nThree");
  while (r.posts.length < 3) await Bun.sleep(1);
  await live.close();
  expect(r.prepared.map((call) => call.text)).toEqual([
    "One\n\nTwo",
    "One\n\nTwo\n\nThree",
  ]);
  expect(r.posts.map(({ text, content }) => ({ text, content }))).toEqual([
    { text: "One", content: slackContent("One") },
    { text: "Two", content: slackContent("Two") },
    { text: "Three", content: slackContent("Three") },
  ]);
  // Unchanged chunks are not rewritten.
  expect(r.updates).toEqual([]);
  store.close();
});

test("live previews update existing chunks with their classified content", async () => {
  const r = recorder();
  const store = new Store(":memory:");
  const gateway = new Gateway(
    bot(),
    identity,
    store,
    {
      async createSession() {
        return "session";
      },
      async prompt() {
        return "";
      },
      async close() {},
    },
    r.slack,
    pino({ enabled: false }),
  );
  gateway.accept(event());
  const job = pending(
    () => store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1)[0],
  );
  store.savePreview(job.id, 0, "9.000");
  const live = new LiveReply(
    job,
    store,
    r.slack,
    new AbortController().signal,
    pino({ enabled: false }),
    { intervalMs: 0 },
  );
  live.push("`<@U123>` text");
  await live.close();
  expect(r.updates).toEqual([
    { text: "`<@U123>` text", content: slackContent("`<@U123>` text") },
  ]);
  expect(r.prepared).toHaveLength(1);
  store.close();
});

test("transcript catch-up prepares each reply whole and persists its chunks", async () => {
  const r = recorder();
  const entries: { id: string; text: string; created: number }[] = [];
  const f = gatewayWith(r.slack, {
    backend: {
      async prompt() {
        entries.push({ id: "m1", text: "Turn answer.", created: 1 });
        return "Turn answer.";
      },
      async transcript(_session, cursor): Promise<Transcript> {
        const after = entries.findIndex((entry) => entry.id === cursor) + 1;
        return {
          cursor: entries.at(-1)?.id ?? "",
          entries: cursor === undefined ? [] : entries.slice(after),
        };
      },
    },
  });
  f.gateway.accept(event());
  const turn = pending(f.next);
  await f.gateway.process(turn, f.signal);
  r.prepared.length = 0;
  r.posts.length = 0;
  entries.push(
    { id: "m2", text: "Late one.\n\nWith two parts.", created: 2 },
    { id: "m3", text: "Late two.", created: 3 },
  );
  f.gateway.settle("session");
  await f.gateway.catchUp(f.signal);
  // Each settled reply is its own source; the batch is not concatenated.
  const rows = f.store.transcriptRows(f.gateway.key, turn.conversation);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows)
    for (const chunk of row.response) expect(typeof chunk).toBe("object");
  expect(r.prepared.every((call) => call.unbounded === true)).toBe(true);
  const preparedCount = r.prepared.length;
  for (let job = f.next(); job; job = f.next())
    await f.gateway.process(job, f.signal);
  expect(r.prepared).toHaveLength(preparedCount);
  expect(r.posts.every((post) => post.content !== undefined)).toBe(true);
  f.store.close();
});

test("store text readers map prepared chunks to display text", () => {
  const store = new Store(":memory:");
  const key = "bot";
  const chunks: ReplyChunk[] = [
    { text: "Prepared", content: slackContent("Prepared") },
    "Plain",
  ];
  store.enqueue({
    eventId: "C123:1.000",
    botKey: key,
    conversation: "c",
    channel: "C123",
    thread: "1.000",
    user: "U123",
    text: "hi",
  });
  const job = store.ready(key, Number.MAX_SAFE_INTEGER, 1)[0];
  if (!job) throw new Error("Missing job");
  store.running(job.id);
  expect(store.respond(job.id, chunks)).toEqual(chunks);
  expect(store.scheduledResult(key, job.id)?.text).toBe("Prepared\n\nPlain");
  expect(store.replies(key, "c")).toEqual([chunks]);
  store.close();
});
