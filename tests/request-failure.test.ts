import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import type { AgentBackend } from "../src/backend";
import { botSchema } from "../src/config";
import { Gateway, type SlackDelivery } from "../src/gateway";
import {
  failureContent,
  failureText,
  type RequestFailure,
} from "../src/request-failure";
import { SlackConnection } from "../src/slack";
import { Store } from "../src/store";
import { ThreadContextUnavailable } from "../src/thread-context";
import { bot, event, identity } from "./fixtures";

test("failures use one accessible collapsed box with a safe cause and next action", () => {
  for (const cause of [
    "timeout",
    "cancelled",
    "backend",
    "context",
    "interrupted",
  ] as const) {
    const content = failureContent(cause);
    expect(content.blocks).toHaveLength(1);
    expect(content.blocks[0]).toMatchObject({
      type: "container",
      title: { type: "plain_text", text: "Request status" },
      is_collapsible: true,
      default_collapsed: true,
      child_blocks: [
        {
          type: "section",
          text: { type: "plain_text", text: failureText(cause) },
        },
      ],
    });
    expect(content.text).toContain(failureText(cause));
    expect(content.text).toMatch(/Check|try again/);
  }
  expect(failureContent("timeout").text).toContain("time limit");
  expect(failureContent("cancelled").text).toContain("stop request");
  expect(failureContent("context").text).toContain("No agent turn was started");
});

test("default turn timeout is thirty minutes, with explicit values and the one-hour maximum preserved", () => {
  const config = bot();
  const { turnTimeoutMs: _timeout, ...input } = config;
  expect(botSchema.parse(input).turnTimeoutMs).toBe(1_800_000);
  expect(
    botSchema.parse({ ...input, turnTimeoutMs: 300_000 }).turnTimeoutMs,
  ).toBe(300_000);
  expect(
    botSchema.safeParse({ ...input, turnTimeoutMs: 3_600_001 }).success,
  ).toBe(false);
});

test("failure delivery replaces a preview and retries durable cause without rerunning the backend", async () => {
  const directory = await mkdtemp("/tmp/opencode/pogo-request-failure-");
  const path = join(directory, "state.sqlite");
  let store = new Store(path);
  let turns = 0;
  let sessions = 0;
  const backend: AgentBackend = {
    async createSession() {
      sessions++;
      return "captain";
    },
    async prompt() {
      turns++;
      throw new Error("PRIVATE SDK headers prompt token=secret");
    },
    async close() {},
  };
  const writes: { cause: RequestFailure; ts?: string }[] = [];
  let fail = true;
  const slack: SlackDelivery = {
    async post() {
      throw new Error("must use failure hook");
    },
    async failure(_channel, _thread, cause, ts) {
      writes.push({ cause, ...(ts ? { ts } : {}) });
      if (fail) throw new Error("Slack unavailable");
      return "preview";
    },
  };
  const gateway = new Gateway(
    bot(),
    identity,
    store,
    backend,
    slack,
    pino({ enabled: false }),
  );
  const next = () => {
    const job = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1)[0];
    if (!job) throw new Error("Missing job");
    return job;
  };
  try {
    gateway.accept(event());
    store.savePreview(next().id, 0, "preview");
    await gateway.process(next(), new AbortController().signal);
    expect(next()).toMatchObject({ status: "responding", failure: "backend" });
    expect(next().response).not.toContain("PRIVATE");
    fail = false;
    // Reopen SQLite and the gateway: no in-memory failure state is required.
    store.close();
    store = new Store(path);
    const retry = new Gateway(
      bot(),
      identity,
      store,
      backend,
      slack,
      pino({ enabled: false }),
    );
    await retry.process(next(), new AbortController().signal);
    await retry.close();
    expect(writes).toEqual([
      { cause: "backend", ts: "preview" },
      { cause: "backend", ts: "preview" },
    ]);
    expect(turns).toBe(1);
    expect(sessions).toBe(1);
  } finally {
    await gateway.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("timeout, shutdown, and context failures have distinct durable causes and plain adapter fallback", async () => {
  for (const cause of ["timeout", "interrupted", "context"] as const) {
    const store = new Store(":memory:");
    const config = bot();
    config.turnTimeoutMs = 1;
    const shutdown = new AbortController();
    let turns = 0;
    const backend: AgentBackend = {
      async createSession() {
        if (cause === "context") throw new ThreadContextUnavailable();
        return "captain";
      },
      async prompt(_session, _text, signal) {
        turns++;
        if (cause === "interrupted") shutdown.abort();
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
        });
        return "unreachable";
      },
      async close() {},
    };
    const texts: string[] = [];
    const gateway = new Gateway(
      config,
      identity,
      store,
      backend,
      {
        async post(_channel, _thread, text) {
          texts.push(text);
        },
      },
      pino({ enabled: false }),
    );
    try {
      gateway.accept(event());
      const job = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1)[0];
      if (!job) throw new Error("Missing job");
      await gateway.process(job, shutdown.signal);
      expect(store.failure(job.id)).toBe(cause);
      if (cause === "interrupted") {
        const pending = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1)[0];
        expect(pending?.failure).toBe("interrupted");
        if (pending)
          await gateway.process(pending, new AbortController().signal);
        expect(texts[0]).toContain("Pogo stopped");
      } else expect(texts).toEqual([failureText(cause)]);
      expect(turns).toBe(cause === "context" ? 0 : 1);
    } finally {
      await gateway.close();
      store.close();
    }
  }
});

test("native Slack failure hook edits a preview without a Stop button, and reports missing previews", async () => {
  const calls: { path: string; fields: URLSearchParams }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const fields = new URLSearchParams(await request.text());
      calls.push({ path: new URL(request.url).pathname, fields });
      return Response.json(
        fields.get("ts") === "missing"
          ? { ok: false, error: "message_not_found" }
          : { ok: true, ts: "2.000" },
      );
    },
  });
  const slack = new SlackConnection(
    "local-app-token",
    "local-bot-token",
    pino({ enabled: false }),
    { slackApiUrl: server.url.href },
  );
  try {
    await slack.failure("C123", "1.000", "timeout", "preview");
    expect(await slack.failure("C123", "1.000", "timeout", "missing")).toBe(
      false,
    );
    await slack.failure("C123", "1.000", "timeout");
    expect(calls.map(({ path }) => path)).toEqual([
      "/chat.update",
      "/chat.update",
      "/chat.postMessage",
    ]);
    for (const { fields } of calls) {
      expect(JSON.parse(fields.get("blocks") ?? "null")).toEqual(
        failureContent("timeout").blocks,
      );
      expect(fields.get("mrkdwn")).toBe("false");
      expect(fields.get("parse")).toBe("none");
      expect(fields.get("blocks")).not.toContain("pogo_stop");
    }
    expect(calls[2]?.fields.get("thread_ts")).toBe("1.000");
  } finally {
    await server.stop(true);
  }
});
