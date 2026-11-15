import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import type { AgentBackend } from "../src/backend";
import { botSchema } from "../src/config";
import { containsCredential } from "../src/credentials";
import { Gateway, type SlackDelivery } from "../src/gateway";
import {
  BackendFailure,
  failureContent,
  failureText,
  providerFailure,
  type RequestFailure,
  statusKind,
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
    "history",
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
  const directory = await mkdtemp("/tmp/opencode/stargate-request-failure-");
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
        expect(texts[0]).toContain("Stargate stopped");
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
      expect(fields.get("blocks")).not.toContain("stargate_stop");
    }
    expect(calls[2]?.fields.get("thread_ts")).toBe("1.000");
  } finally {
    await server.stop(true);
  }
});

test("each backend failure category has one specific line and an honest work statement", () => {
  const cases: [BackendFailure, string, string][] = [
    [
      new BackendFailure("quota", { status: 429, ran: false }),
      "Provider quota reached",
      "The model provider refused this request: quota or rate limit reached (HTTP 429). Try again after it resets, or switch model. Nothing ran. You can send the request again.",
    ],
    [
      new BackendFailure("auth", { status: 401, ran: false }),
      "Provider credentials rejected",
      "The model provider refused this request: its credentials were rejected (HTTP 401). An operator must check the provider credentials. Nothing ran. You can send the request again.",
    ],
    [
      new BackendFailure("model", { status: 404, ran: false }),
      "Model unavailable",
      "The model provider refused this request: the configured model is not available (HTTP 404). An operator must check the model setting. Nothing ran. You can send the request again.",
    ],
    [
      new BackendFailure("timeout", { status: 504, ran: true }),
      "Provider timeout",
      "The model provider did not answer in time (HTTP 504). Try again later. Work may have run; it was not repeated. Check agent state before trying again.",
    ],
    [
      new BackendFailure("network", { ran: false }),
      "Provider unreachable",
      "Stargate could not reach the model provider or its proxy. An operator must check that it is running. Nothing ran. You can send the request again.",
    ],
    [
      new BackendFailure("crash", { ran: true }),
      "Agent process stopped",
      "The agent process stopped before it gave a result. Work may have run; it was not repeated. Check agent state before trying again.",
    ],
    [
      new BackendFailure("provider", { status: 503, ran: true }),
      "Provider error",
      "The model provider failed (HTTP 503). Try again later. Work may have run; it was not repeated. Check agent state before trying again.",
    ],
  ];
  for (const [failure, title, text] of cases) {
    expect(failureText(failure.failure)).toBe(text);
    expect(failureContent(failure.failure).blocks[0]?.subtitle.text).toBe(
      title,
    );
    expect(providerFailure(failure.failure)).toEqual({
      kind: failure.kind,
      status: failure.status,
      ran: failure.ran,
    });
  }
  // No status seen: the line has no number.
  expect(
    failureText(new BackendFailure("quota", { ran: true }).failure),
  ).toContain("quota or rate limit reached. Try again");
});

test("a provider cause carries a category, a status and a flag, never text", () => {
  expect(new BackendFailure("quota", { status: 429, ran: false }).failure).toBe(
    "provider:quota:429:idle",
  );
  // An impossible status is dropped, not stored.
  for (const status of [0, 42, 600, 429.5, Number.NaN])
    expect(new BackendFailure("provider", { status, ran: true }).failure).toBe(
      "provider:provider:0:ran",
    );
  for (const text of [
    "provider:quota:429:idle:extra",
    "provider:quota:4290:idle",
    "provider:secret:429:idle",
    "provider:quota:429:maybe",
    "provider:quota:xoxb-1:idle",
  ])
    expect(providerFailure(text)).toBeUndefined();
  expect(
    [402, 429, 401, 403, 404, 408, 504, 400, 500, 529].map(statusKind),
  ).toEqual([
    "quota",
    "quota",
    "auth",
    "auth",
    "model",
    "timeout",
    "timeout",
    "provider",
    "provider",
    "provider",
  ]);
});

test("the gateway reports the category in the card and in the log, never provider text", async () => {
  // What the provider and its proxy said; none of it may leave the adapter.
  const secrets = [
    "sk-ant-api03-secretvalue",
    "xoxb-123-secret",
    "Bearer abcdef123456",
    "account_id=acct_42",
    "https://user:pass@proxy.example/v1?key=secret",
    "claude-fable-5-2 are in cooldown",
  ];
  const store = new Store(":memory:");
  const lines: string[] = [];
  const cards: RequestFailure[] = [];
  const posts: string[] = [];
  const failure = Object.assign(
    new BackendFailure("quota", { status: 429, ran: false }),
    { body: secrets.join(" "), stack: secrets.join("\n") },
  );
  const gateway = new Gateway(
    bot(),
    identity,
    store,
    {
      async createSession() {
        return "session";
      },
      async prompt() {
        throw failure;
      },
      async close() {},
    },
    {
      async post(_channel, _thread, text) {
        posts.push(text);
      },
      async failure(_channel, _thread, cause) {
        cards.push(cause);
      },
    },
    pino({ level: "warn" }, { write: (line: string) => lines.push(line) }),
  );
  try {
    expect(gateway.accept(event())).toBe(true);
    const [job] = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1);
    if (!job) throw new Error("Expected a job");
    await gateway.process(job, new AbortController().signal);
    expect(cards).toEqual(["provider:quota:429:idle"]);
    expect(store.failure(job.id)).toBe("provider:quota:429:idle");
    expect(store.replies(gateway.key, job.conversation)).toEqual([
      [failureText("provider:quota:429:idle")],
    ]);
    const logged = lines.join("");
    expect(logged).toContain('"failure":"quota"');
    expect(logged).toContain('"status":429');
    expect(logged).toContain('"backend":"opencode"');
    expect(logged).toContain('"ran":false');
    const visible = [
      logged,
      ...posts,
      ...cards.map((cause) => JSON.stringify(failureContent(cause))),
      JSON.stringify(store.replies(gateway.key, job.conversation)),
    ].join("\n");
    for (const secret of secrets) expect(visible).not.toContain(secret);
    expect(containsCredential(visible)).toBe(false);
  } finally {
    store.close();
  }
});

test("a failure without a category keeps the generic card and names no status", async () => {
  const store = new Store(":memory:");
  const lines: string[] = [];
  const gateway = new Gateway(
    bot(),
    identity,
    store,
    {
      async createSession() {
        return "session";
      },
      async prompt() {
        throw new Error("PRIVATE sk-ant-api03-secretvalue");
      },
      async close() {},
    },
    { async post() {} },
    pino({ level: "warn" }, { write: (line: string) => lines.push(line) }),
  );
  try {
    gateway.accept(event());
    const [job] = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1);
    if (!job) throw new Error("Expected a job");
    await gateway.process(job, new AbortController().signal);
    expect(store.failure(job.id)).toBe("backend");
    const logged = lines.join("");
    expect(logged).toContain('"failure":"backend"');
    expect(logged).not.toContain("status");
    expect(logged).not.toContain("PRIVATE");
  } finally {
    store.close();
  }
});
