import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type { OpenCodeClient } from "@opencode/client";
import { Schema } from "effect";
import type { ActivityItem } from "../src/backends/backend";
import { openCodeTurnObserver } from "../src/backends/opencode/activity";
import { configSchema } from "../src/config";
import {
  activityApi,
  activityPageBytes,
  createActivityHub,
  readActivity,
} from "../src/observability/dashboard/api/v1/activity";
import type { ApiV1Config } from "../src/observability/dashboard/api/v1/features";
import { startApiV1Server } from "../src/observability/dashboard/api/v1/server";
import { apiToken } from "../src/observability/dashboard/api/v1/token";
import type {
  ApiV1Source,
  V1ActivityItemPage,
  V1ActivityPagedItem,
  V1ActivityToolCall,
  V1AgentActivity,
} from "../src/observability/dashboard/api/v1/types";
import { bot } from "./fixtures";

const config: ApiV1Config = Schema.decodeUnknownSync(configSchema)({
  bots: [
    bot("captain"),
    {
      ...bot("pi"),
      slack: {
        appId: "A456",
        appTokenEnv: "PI_APP_TOKEN",
        botTokenEnv: "PI_BOT_TOKEN",
      },
      backend: { type: "pi-durable", model: "openai/local", directory: "/w" },
    },
  ],
  teams: [
    {
      id: "admiral",
      botClientId: "24651ef6-55ec-47a2-87bf-695f094ee7de",
      tenantId: "70baf6be-37eb-4532-8000-f71944694e71",
      socketPath: "/local/socket",
      access: { users: ["edb029d2-beff-4c27-808f-eadd1aa996f9"] },
      backend: {
        type: "opencode",
        directory: "/admiral",
        url: "http://127.0.0.1:4096",
      },
      fleetPolicy: {
        role: "rear_admiral",
        humanAccounts: ["operator"],
        assignedCheckout: "/admiral",
        capabilities: ["dispatch"],
      },
    },
  ],
});

const text = (value: string): ActivityItem => ({
  kind: "text",
  status: "completed",
  text: value,
});

const snapshot = (hub: ReturnType<typeof createActivityHub>, agent: string) => {
  const read = readActivity(hub, config, agent, new URLSearchParams());

  if (read.status !== 200 || !("turns" in read.body)) {
    throw new Error(`Unexpected read ${read.status}`);
  }

  return read.body;
};

async function until(condition: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out");
    }

    await wait(10);
  }
}

/** A shared OpenCode event stream that broadcasts to every subscriber. */
function eventStream() {
  const subscribers = new Set<(frame: unknown) => void>();

  const subscribe = (options?: { signal?: AbortSignal }) => ({
    async *[Symbol.asyncIterator]() {
      const queue: unknown[] = [{ type: "server.connected", data: {} }];
      let wake: (() => void) | undefined;

      const push = (frame: unknown) => {
        queue.push(frame);
        wake?.();
      };

      subscribers.add(push);
      options?.signal?.addEventListener("abort", () => wake?.());

      try {
        while (!options?.signal?.aborted) {
          const frame = queue.shift();

          if (frame !== undefined) {
            yield frame;
            continue;
          }

          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      } finally {
        subscribers.delete(push);
      }
    },
  });

  return {
    events: { subscribe } as unknown as OpenCodeClient["event"],
    emit(type: string, data: Record<string, unknown>) {
      for (const push of subscribers) {
        push({ type, data: { sessionID: "session", ...data } });
      }
    },
    subscribers: () => subscribers.size,
  };
}

test("two consecutive turns on one agent never mix", async () => {
  const hub = createActivityHub();
  const stream = eventStream();
  const observe = openCodeTurnObserver(hub.recorder("captain"));
  // Placement proof: each assistant message answers exactly one input.
  const answers: Record<string, string> = { a1: "in-1", a2: "in-2" };

  const source = {
    sessionID: "session",
    events: stream.events,
    owns: async (assistant: string, input: string) =>
      answers[assistant] === input,
  };

  const first = observe(source);
  await until(() => stream.subscribers() === 1);
  // An earlier input's answer still streaming in the session.
  stream.emit("session.text.delta", {
    assistantMessageID: "a0",
    ordinal: 0,
    delta: "EARLIER INPUT",
  });
  first.submitted("in-1");

  stream.emit("session.text.delta", {
    assistantMessageID: "a1",
    ordinal: 0,
    delta: "first reply",
  });
  stream.emit("session.text.delta", {
    sessionID: "other-session",
    assistantMessageID: "a1",
    ordinal: 0,
    delta: "OTHER SESSION",
  });
  // The next input's answer can start before this turn's prompt returns.
  stream.emit("session.text.delta", {
    assistantMessageID: "a2",
    ordinal: 0,
    delta: "NEXT TURN",
  });
  stream.emit("session.tool.input.started", {
    assistantMessageID: "a1",
    id: "call-1",
    name: "bash",
  });
  stream.emit("session.tool.called", {
    assistantMessageID: "a1",
    id: "call-1",
    tool: "bash",
    input: { command: "ls" },
    provider: { executed: false },
    executed: false,
  });
  stream.emit("session.tool.success", {
    assistantMessageID: "a1",
    id: "call-1",
    executed: true,
    content: [{ type: "text", text: "file.txt" }],
  });

  await until(() => {
    const turn = snapshot(hub, "captain").turns[0];

    return turn?.items.length === 2 && turn.items[1]?.status === "completed";
  });

  first.end("completed");

  const second = observe(source);
  second.submitted("in-2");
  stream.emit("session.text.delta", {
    assistantMessageID: "a2",
    ordinal: 0,
    delta: " continues",
  });
  // A trailing frame from the previous answer never joins this turn.
  stream.emit("session.text.delta", {
    assistantMessageID: "a1",
    ordinal: 1,
    delta: "LATE PREVIOUS",
  });

  await until(() => snapshot(hub, "captain").turns[1]?.items.length === 1);
  second.end("failed");
  await wait(600);

  const { turns, cursor } = snapshot(hub, "captain");
  expect(turns.map((turn) => turn.status)).toEqual(["completed", "failed"]);
  expect(turns[0]?.id).not.toBe(turns[1]?.id);
  expect(cursor.seq).toBeGreaterThanOrEqual(turns[1]?.seq ?? Infinity);

  const [one, two] = turns.map((turn) => JSON.stringify(turn.items));
  expect(one).toContain("first reply");
  expect(one).toContain("file.txt");
  expect(one).not.toContain("NEXT TURN");
  expect(one).not.toContain("EARLIER INPUT");
  // A trailing frame of the first answer stays with the first turn.
  expect(one).toContain("LATE PREVIOUS");
  expect(one).not.toContain("OTHER SESSION");
  expect(two).toContain("continues");
  expect(two).not.toContain("first reply");
  expect(two).not.toContain("LATE PREVIOUS");

  const tool = turns[0]?.items[1] as V1ActivityToolCall;
  expect(tool).toMatchObject({
    id: "i2",
    kind: "tool",
    callId: "call-1",
    name: "bash",
    status: "completed",
    input: { command: "ls" },
    executed: true,
    content: [{ type: "text", text: "file.txt" }],
  });
  expect(turns[0]?.items[0]).toMatchObject({ id: "i1", text: "first reply" });
  // Every subscriber detached once the turns settled.
  await until(() => stream.subscribers() === 0);
});

test("a large tool output pages back whole", () => {
  const hub = createActivityHub();
  const log = hub.recorder("captain").begin();
  // Multi-byte text across page edges must survive the split.
  const output = "é漢🚀 line of output\n".repeat(12_000);

  log.update("tool", 1, () => ({
    kind: "tool",
    callId: "call-big",
    name: "read",
    status: "completed",
    rawInput: '{"path":"big"}',
    input: { path: "big" },
    executed: true,
    metadata: null,
    content: [{ type: "text", text: output }],
    error: null,
  }));
  log.update("small", 2, () => text("small reply"));
  log.end("completed");

  const { turns } = snapshot(hub, "captain");
  const turn = turns[0];
  const paged = turn?.items[0] as V1ActivityPagedItem;
  expect(paged.paged.pages).toBeGreaterThan(1);
  expect(paged).toMatchObject({ kind: "tool", callId: "call-big" });
  expect(JSON.stringify(paged)).not.toContain("line of output");
  expect(turn?.items[1]).toMatchObject({ text: "small reply" });

  const pages: V1ActivityItemPage[] = [];

  for (let page = 0; page < paged.paged.pages; page++) {
    const read = readActivity(
      hub,
      config,
      "captain",
      new URLSearchParams({
        turn: turn?.id ?? "",
        item: paged.id,
        page: String(page),
      }),
    );

    expect(read.status).toBe(200);

    if (read.status === 200 && "data" in read.body) {
      pages.push(read.body);
    }
  }

  for (const page of pages) {
    expect(Buffer.byteLength(page.data)).toBeLessThanOrEqual(activityPageBytes);
    expect(page.seq).toBe(paged.seq);
  }

  const joined = pages.map((page) => page.data).join("");
  expect(Buffer.byteLength(joined)).toBe(paged.paged.bytes);

  const item = JSON.parse(joined) as V1ActivityToolCall;
  expect(item.content).toEqual([{ type: "text", text: output }]);
  expect(item.id).toBe(paged.id);

  const beyond = readActivity(
    hub,
    config,
    "captain",
    new URLSearchParams({
      turn: turn?.id ?? "",
      item: paged.id,
      page: String(paged.paged.pages),
    }),
  );

  expect(beyond.status).toBe(404);
});

test("eviction keeps whole turns", () => {
  let now = 1000;

  const hub = createActivityHub({
    turnsPerAgent: 3,
    turns: 5,
    now: () => now,
  });

  const run = (agent: string, label: string, end = true) => {
    const log = hub.recorder(agent).begin();

    for (let index = 0; index < 3; index++) {
      log.update(`k${index}`, now, () => text(`${label}-${index}`));
    }

    if (end) {
      log.end("completed");
    }

    now += 1;
  };

  // A running turn is never evicted, however old.
  run("captain", "running", false);

  for (let index = 0; index < 5; index++) {
    run("captain", `turn${index}`);
  }

  const kept = snapshot(hub, "captain").turns;
  expect(
    kept
      .map((turn) => turn.items[0])
      .map((item) => item && "text" in item && item.text),
  ).toEqual(["running-0", "turn3-0", "turn4-0"]);

  for (const turn of kept) {
    expect(turn.items).toHaveLength(3);
  }

  // The global cap drops the oldest ended turns first, across agents.
  run("admiral", "a0");
  run("admiral", "a1");
  run("admiral", "a2");
  expect(snapshot(hub, "captain").turns).toHaveLength(2);
  expect(snapshot(hub, "admiral").turns).toHaveLength(3);

  // Nothing expires with time: an idle officer keeps its last turns.
  now += 7 * 24 * 60 * 60_000;
  expect(snapshot(hub, "captain").turns).toHaveLength(2);
  expect(snapshot(hub, "admiral").turns).toHaveLength(3);

  const small = createActivityHub({ bytes: 1, now: () => now });
  const log = small.recorder("captain").begin();
  log.update("k", now, () => text("x".repeat(200)));
  log.end("completed");
  small.recorder("captain").begin();
  // Over the byte cap, whole ended turns go; content is never cut.
  expect(snapshot(small, "captain").turns.map((turn) => turn.status)).toEqual([
    "running",
  ]);
});

test("activity reads validate the agent and every parameter", () => {
  const hub = createActivityHub();
  const log = hub.recorder("captain").begin();
  log.update("k", 1, () => text("hello"));

  log.update(
    "step",
    2,
    () => ({
      kind: "step",
      status: "running",
      model: null,
      firstTokenAt: null,
      streamedAt: null,
      endedAt: null,
      finish: null,
      tokens: null,
      cost: null,
      error: null,
    }),
    (item) => {
      if (item.kind === "step") {
        item.status = "completed";
        item.cost = 0.5;
        item.tokens = {
          input: 10,
          output: 5,
          reasoning: 1,
          cacheRead: 2,
          cacheWrite: 0,
        };
      }
    },
  );

  const turnId = snapshot(hub, "captain").turns[0]?.id ?? "";

  const read = (agent: string, query: Record<string, string> | string) =>
    readActivity(hub, config, agent, new URLSearchParams(query)).status;

  expect(read("nobody", {})).toBe(404);
  expect(read("captain", { turn: turnId })).toBe(200);
  expect(read("captain", { turn: "zz-1" })).toBe(404);
  expect(read("captain", { turn: turnId, item: "i1" })).toBe(200);
  expect(read("captain", { turn: turnId, item: "i9" })).toBe(404);
  expect(read("captain", { turn: turnId, item: "i1", page: "1" })).toBe(404);

  for (const query of [
    "unknown=1",
    `turn=${turnId}&turn=${turnId}`,
    "turn=BAD!",
    "turn=",
    "item=i1",
    `turn=${turnId}&page=0`,
    `turn=${turnId}&item=x1`,
    `turn=${turnId}&item=i1&page=-1`,
    `turn=${turnId}&item=i1&page=01`,
    `turn=${turnId}&item=i1&page=1e3`,
  ]) {
    expect(read("captain", query)).toBe(400);
  }

  const turn = snapshot(hub, "captain").turns[0];
  expect(turn?.usage).toEqual({
    steps: 1,
    cost: 0.5,
    tokens: { input: 10, output: 5, reasoning: 1, cacheRead: 2, cacheWrite: 0 },
  });

  const admiral = readActivity(hub, config, "admiral", new URLSearchParams());
  const pi = readActivity(hub, config, "pi", new URLSearchParams());
  expect(admiral).toMatchObject({
    status: 200,
    body: {
      agent: { id: "admiral", role: "rear_admiral", collected: true },
      turns: [],
    },
  });
  expect(pi).toMatchObject({
    status: 200,
    body: { agent: { backend: "pi-durable", collected: false } },
  });
});

const source: ApiV1Source = {
  fleet: async () => {
    throw new Error("unused");
  },
  ship: async () => undefined,
  crew: async () => undefined,
  gatewayFeatures: () => [],
};

test("the activity route serves GET and HEAD, 404 and 400", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "stargate-activity-"));
  const shutdown = new AbortController();
  const hub = createActivityHub();
  const log = hub.recorder("captain").begin();
  log.update("k", 1, () => text("hello"));

  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null),
  });

  const listen = `127.0.0.1:${reservation.port}`;
  await reservation.stop(true);

  try {
    const server = await startApiV1Server({
      config: { listen },
      dataDirectory,
      source,
      diff: () => [],
      gateway: {
        version: "1.2.3",
        opencodeVersion: async () => null,
        startedAt: 1,
      },
      activity: activityApi(hub, () => config),
      signal: shutdown.signal,
    });

    const token = await apiToken(dataDirectory);

    const get = (path: string, method = "GET") =>
      fetch(new URL(path, server.url), {
        method,
        headers: { Authorization: `Bearer ${token}` },
      });

    try {
      const response = await get("/api/v1/agents/captain/activity");
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const body = (await response.json()) as V1AgentActivity;
      expect(body.agent).toEqual({
        id: "captain",
        role: "captain",
        backend: "opencode",
        collected: true,
      });
      expect(body.turns[0]?.items[0]).toMatchObject({ text: "hello" });
      expect(body.cursor.generation).toBe(hub.generation);

      const head = await get("/api/v1/agents/captain/activity", "HEAD");
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");

      expect((await get("/api/v1/agents/nobody/activity")).status).toBe(404);
      expect((await get("/api/v1/agents/nobody/activity", "HEAD")).status).toBe(
        404,
      );
      expect((await get("/api/v1/agents/%2F/activity")).status).toBe(404);
      expect(
        (await get("/api/v1/agents/captain/activity?bogus=1")).status,
      ).toBe(400);
      expect(
        (await fetch(new URL("/api/v1/agents/captain/activity", server.url)))
          .status,
      ).toBe(401);
    } finally {
      await server.stop();
    }
  } finally {
    shutdown.abort();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
