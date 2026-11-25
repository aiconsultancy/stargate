import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Schema } from "effect";
import type { ActivityItem } from "../src/backends/backend";
import { configSchema } from "../src/config";
import {
  activityApi,
  activityFlushMs,
  activityPageBytes,
  createActivityHub,
  readActivity,
  subscribeActivity,
} from "../src/observability/dashboard/api/v1/activity";
import { createEventStreams } from "../src/observability/dashboard/api/v1/events";
import type { ApiV1Config } from "../src/observability/dashboard/api/v1/features";
import { startApiV1Server } from "../src/observability/dashboard/api/v1/server";
import { apiToken } from "../src/observability/dashboard/api/v1/token";
import type {
  ApiV1Source,
  V1ActivityItem,
  V1ActivityItemPage,
  V1ActivityPagedItem,
  V1ActivityTurnSummary,
  V1AgentActivity,
  V1AgentActivityEvent,
  V1Fleet,
  V1Host,
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
});

type Hub = ReturnType<typeof createActivityHub>;

const text = (value: string): ActivityItem => ({
  kind: "text",
  status: "completed",
  text: value,
});

const decoder = new TextDecoder();

/** The `agent-activity` frames in a stream's text, in order. */
function activityEvents(stream: string) {
  return stream
    .split("\n\n")
    .filter((frame) => frame.startsWith("event: agent-activity\n"))
    .map(
      (frame) =>
        JSON.parse(
          frame.slice("event: agent-activity\ndata: ".length),
        ) as V1AgentActivityEvent,
    );
}

/** Watch through the route's own subscription, collecting the raw bytes. */
function watch(hub: Hub, query: string) {
  const subscription = subscribeActivity(
    hub,
    config,
    new URLSearchParams(query),
  );

  if (subscription.status !== 200) {
    throw new Error(`Unexpected subscription ${subscription.status}`);
  }

  let received = "";

  const stop = subscription.watch((bytes) => {
    received += decoder.decode(bytes);
  });

  return {
    stop,
    text: () => received,
    events: () => activityEvents(received),
  };
}

const flushed = () => wait(activityFlushMs * 2);

const snapshot = (hub: Hub, agent: string) => {
  const read = readActivity(hub, config, agent, new URLSearchParams());

  if (read.status !== 200 || !("turns" in read.body)) {
    throw new Error(`Unexpected read ${read.status}`);
  }

  return read.body;
};

/** Turns and items by ID, as a client following the recipe keeps them. */
type Model = Map<
  string,
  {
    turn: V1ActivityTurnSummary;
    items: Map<string, V1ActivityItem | V1ActivityPagedItem>;
  }
>;

function modelOf(activity: V1AgentActivity): Model {
  return new Map(
    activity.turns.map(({ items, ...turn }) => [
      turn.id,
      { turn, items: new Map(items.map((item) => [item.id, item])) },
    ]),
  );
}

function apply(model: Model, event: V1AgentActivityEvent) {
  const { change } = event;

  if (change.type === "item") {
    model.get(event.turnId)?.items.set(change.item.id, change.item);

    return;
  }

  const entry = model.get(event.turnId);

  if (entry) {
    entry.turn = change.turn;
  } else {
    model.set(event.turnId, { turn: change.turn, items: new Map() });
  }
}

test("subscribe, snapshot and events join with no gap or duplicate", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "stargate-activity-"));
  const shutdown = new AbortController();
  const hub = createActivityHub();
  const server = await listen(dataDirectory, hub, shutdown.signal);

  try {
    const token = await apiToken(dataDirectory);

    const get = (path: string) =>
      fetch(new URL(path, server.url), {
        headers: { Authorization: `Bearer ${token}` },
      });

    const stream = await get("/api/v1/events?agent=captain");
    expect(stream.status).toBe(200);
    expect(stream.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = stream.body?.getReader();

    if (!reader) {
      throw new Error("No stream body");
    }

    // Changes before and after the snapshot, and one coalesced across it.
    const log = hub.recorder("captain").begin();
    log.update("a", 1, () => text("one"));
    log.update("b", 2, () => text("two"));

    const before = (await (
      await get("/api/v1/agents/captain/activity")
    ).json()) as V1AgentActivity;

    log.update(
      "b",
      3,
      () => text(""),
      (item) => {
        if (item.kind === "text") {
          item.text = "two, changed";
        }
      },
    );
    log.update("c", 4, () => text("three"));
    await flushed();
    log.update("d", 5, () => text("four"));
    log.end("completed");

    let received = "";

    while (
      !activityEvents(received).some((e) => e.change.type === "turn-ended")
    ) {
      const chunk = await reader.read();

      if (chunk.done) {
        throw new Error("The stream closed early");
      }

      received += decoder.decode(chunk.value, { stream: true });
    }

    await reader.cancel();
    const events = activityEvents(received);
    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual([...new Set(seqs)].toSorted((a, b) => a - b));
    expect(events.every((e) => e.generation === before.cursor.generation)).toBe(
      true,
    );

    const model = modelOf(before);

    for (const event of events) {
      if (event.seq > before.cursor.seq) {
        apply(model, event);
      }
    }

    expect(model).toEqual(modelOf(snapshot(hub, "captain")));
    expect(
      events.filter((e) => e.seq > before.cursor.seq).map((e) => e.change.type),
    ).toEqual(["item", "item", "item", "turn-ended"]);
  } finally {
    await server.stop();
    shutdown.abort();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("coalescing sends each item's latest value with its latest seq", async () => {
  const hub = createActivityHub();
  const viewer = watch(hub, "agent=captain");
  const log = hub.recorder("captain").begin();

  for (let i = 0; i < 50; i++) {
    log.update(
      "k",
      i,
      () => text(""),
      (item) => {
        if (item.kind === "text") {
          item.text += String(i % 10);
        }
      },
    );
  }

  log.update("other", 60, () => text("x"));
  await flushed();

  const events = viewer.events();
  const turn = snapshot(hub, "captain").turns[0];
  expect(events.map((e) => e.change.type)).toEqual([
    "turn-started",
    "item",
    "item",
  ]);
  const change = events[1]?.change;
  expect(change?.type === "item" ? change.item : undefined).toEqual(
    turn?.items[0],
  );
  expect(events[1]?.seq).toBe(turn?.items[0]?.seq ?? -1);
  expect(events[1]?.seq).toBe(51);
  expect(events[2]?.seq).toBe(52);
  expect(events[1]?.at).toBe(49);

  // Nothing more without a change; then only the newer value.
  await flushed();
  expect(viewer.events()).toHaveLength(3);
  log.end("failed");
  await flushed();
  expect(viewer.events().at(-1)).toMatchObject({
    seq: 53,
    change: { type: "turn-ended", turn: { status: "failed", seq: 53 } },
  });
  viewer.stop();
});

test("a large item arrives paged and its pages read back whole", async () => {
  const hub = createActivityHub();
  const viewer = watch(hub, "agent=captain");
  const log = hub.recorder("captain").begin();
  const output = `${"é".repeat(activityPageBytes)}-end`;

  log.update("call", 1, () => ({
    kind: "tool",
    status: "completed",
    callId: "call-1",
    name: "bash",
    input: null,
    rawInput: "",
    executed: true,
    metadata: { output },
    content: null,
    error: null,
  }));
  await flushed();

  const event = viewer.events().find((e) => e.change.type === "item");
  const change = event?.change;

  if (change?.type !== "item" || !("paged" in change.item)) {
    throw new Error("Expected a paged item");
  }

  expect(change.item).toMatchObject({
    id: "i1",
    kind: "tool",
    callId: "call-1",
    name: "bash",
  });
  expect(viewer.text().length).toBeLessThan(activityPageBytes);

  let json = "";

  for (let page = 0; page < change.item.paged.pages; page++) {
    const read = readActivity(
      hub,
      config,
      "captain",
      new URLSearchParams({
        turn: event?.turnId ?? "",
        item: change.item.id,
        page: String(page),
      }),
    );

    const body = read.status === 200 ? (read.body as V1ActivityItemPage) : null;
    expect(body?.seq).toBe(event?.seq ?? -1);
    json += body?.data ?? "";
  }

  expect(Buffer.byteLength(json)).toBe(change.item.paged.bytes);
  expect(JSON.parse(json)).toMatchObject({ metadata: { output } });
  viewer.stop();
});

test("two viewers see the same sequence, and an unwatched agent costs nothing", async () => {
  const hub = createActivityHub();
  const first = watch(hub, "agent=captain");
  const second = watch(hub, "agent=pi&agent=captain");
  const quiet = hub.recorder("pi").begin();
  const log = hub.recorder("captain").begin();

  for (let i = 0; i < 5; i++) {
    log.update(`k${i}`, i, () => text(String(i)));
    quiet.update("p", i, () => text("pi"));
    await wait(activityFlushMs / 3);
  }

  log.end("completed");
  await flushed();

  const captain = second.events().filter((e) => e.agentId === "captain");
  expect(first.events().length).toBe(7);
  expect(captain).toEqual(first.events());
  const pi = second.events().filter((e) => e.agentId === "pi");
  expect(pi[0]?.change.type).toBe("turn-started");
  expect(pi.at(-1)?.change).toMatchObject({ item: { text: "pi" } });
  first.stop();
  second.stop();

  // With no viewer left, a change is never read or encoded.
  let reads = 0;
  const later = hub.recorder("captain").begin();

  later.update("counted", 1, () => ({
    kind: "text",
    status: "streaming",
    get text() {
      reads += 1;

      return "x";
    },
  }));
  await flushed();
  expect(reads).toBe(0);

  const viewer = watch(hub, "agent=captain");
  later.update("counted", 2, () => text(""));
  await flushed();
  expect(reads).toBeGreaterThan(0);
  viewer.stop();
});

test("a turn-scoped stream never sees a neighbouring turn", async () => {
  const hub = createActivityHub();
  const recorder = hub.recorder("captain");
  const own = recorder.begin();
  const turnId = snapshot(hub, "captain").turns[0]?.id ?? "";
  const viewer = watch(hub, `agent=captain&turn=${turnId}`);
  const neighbour = recorder.begin();

  own.update("a", 1, () => text("mine"));
  neighbour.update("a", 1, () => text("theirs"));
  neighbour.end("completed");
  own.reconnected();
  await flushed();
  own.end("cancelled");
  await flushed();

  const events = viewer.events();
  expect(events.map((e) => e.change.type)).toEqual([
    "item",
    "turn-updated",
    "turn-ended",
  ]);
  expect(events.at(-1)?.change).toMatchObject({
    turn: { status: "cancelled", reconnects: 1 },
  });
  expect(events.every((e) => e.turnId === turnId)).toBe(true);
  expect(viewer.text()).not.toContain("theirs");
  viewer.stop();
});

test("a restart changes the generation, and seq starts again", async () => {
  const before = createActivityHub();
  const viewer = watch(before, "agent=captain");
  before
    .recorder("captain")
    .begin()
    .update("a", 1, () => text("x"));
  await flushed();
  viewer.stop();

  const after = createActivityHub();
  const next = watch(after, "agent=captain");
  after.recorder("captain").begin();
  await flushed();
  next.stop();

  const [old] = viewer.events();
  const [fresh] = next.events();
  expect(old?.generation).toBe(before.generation);
  expect(fresh?.generation).toBe(after.generation);
  expect(fresh?.generation).not.toBe(old?.generation);
  expect(fresh?.seq).toBe(1);
  expect(snapshot(after, "captain").cursor).toEqual({
    generation: after.generation,
    seq: 1,
  });
});

test("activity subscriptions validate before a stream is opened", () => {
  const hub = createActivityHub();
  hub.recorder("captain").begin();
  const turnId = snapshot(hub, "captain").turns[0]?.id ?? "";

  const status = (query: string) =>
    subscribeActivity(hub, config, new URLSearchParams(query)).status;

  expect(status("agent=captain")).toBe(200);
  expect(status("agent=captain&agent=pi")).toBe(200);
  expect(status(`agent=captain&turn=${turnId}`)).toBe(200);
  expect(status(`turn=${turnId}&agent=captain`)).toBe(200);

  for (const query of [
    "turn=x",
    "agent=captain&agent=captain",
    "agent=Captain",
    "agent=",
    "agent=captain&bogus=1",
    "agent=captain&turn=",
    "agent=captain&turn=BAD!",
    `agent=captain&turn=${turnId}&turn=${turnId}`,
    `agent=captain&agent=pi&turn=${turnId}`,
    Array.from({ length: 9 }, (_, i) => `agent=a${i}`).join("&"),
  ]) {
    expect([query, status(query)]).toEqual([query, 400]);
  }

  expect(status("agent=nobody")).toBe(404);
  expect(status("agent=captain&agent=nobody")).toBe(404);
  expect(status("agent=pi&turn=zz-1")).toBe(404);
  expect(status(`agent=pi&turn=${turnId}`)).toBe(404);
});

test("over HTTP, a refused subscription never takes a viewer place", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "stargate-activity-"));
  const shutdown = new AbortController();
  const hub = createActivityHub();
  const server = await listen(dataDirectory, hub, shutdown.signal);
  const streams: ReadableStreamDefaultReader<Uint8Array>[] = [];

  try {
    const token = await apiToken(dataDirectory);

    const get = (path: string, method = "GET") =>
      fetch(new URL(path, server.url), {
        method,
        headers: { Authorization: `Bearer ${token}` },
      });

    // A stream without `agent` ignores its query and never sends activity.
    const plain = await get("/api/v1/events?bogus=1&agents=captain");
    expect(plain.status).toBe(200);
    const reader = plain.body?.getReader();

    if (!reader) {
      throw new Error("No stream body");
    }

    streams.push(reader);
    let received = "";

    while (!received.includes("event: fleet\n")) {
      const chunk = await reader.read();
      received += decoder.decode(chunk.value ?? new Uint8Array());
    }

    const log = hub.recorder("captain").begin();
    log.update("a", 1, () => text("secret"));
    log.end("completed");
    await flushed();

    const open = async () => {
      const viewer = await get("/api/v1/events?agent=captain");
      expect(viewer.status).toBe(200);
      const body = viewer.body?.getReader();

      if (body) {
        streams.push(body);
      }
    };

    for (let i = 1; i < 7; i++) {
      await open();
    }

    // Seven streams are open: refusals leave the eighth place free.
    for (let i = 0; i < 3; i++) {
      expect((await get("/api/v1/events?agent=captain&x=1")).status).toBe(400);
      expect((await get("/api/v1/events?turn=a")).status).toBe(400);
      expect((await get("/api/v1/events?agent=x&agent=x", "HEAD")).status).toBe(
        400,
      );
      expect((await get("/api/v1/events?agent=nobody")).status).toBe(404);
      expect((await get("/api/v1/events?agent=captain&turn=zz-1")).status).toBe(
        404,
      );
    }

    await open();
    expect((await get("/api/v1/events?agent=captain")).status).toBe(503);

    // The plain stream's text so far holds no activity frame.
    const more = await Promise.race([reader.read(), wait(50)]);

    if (more && "value" in more && more.value) {
      received += decoder.decode(more.value);
    }

    expect(received).not.toContain("agent-activity");
    expect(received).not.toContain("secret");
  } finally {
    for (const stream of streams) {
      await stream.cancel().catch(() => {});
    }

    await server.stop();
    shutdown.abort();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("a viewer that backs up is closed while the collector carries on", async () => {
  const hub = createActivityHub();

  const streams = createEventStreams(
    {
      ...source,
      diff: () => [],
      readHost: async () => host,
      snapshotHost: () => host,
      completeFleet: async (fleet) => ({ ...fleet, host, gateway }),
      fallbackFleet: (fleet) => ({ ...fleet, host, gateway }),
    },
    { pollMs: 1000, hostMs: 1000, heartbeatMs: 1000 },
  );

  const subscription = (query: string) => {
    const result = subscribeActivity(hub, config, new URLSearchParams(query));

    if (result.status !== 200) {
      throw new Error("Unexpected refusal");
    }

    return result.watch;
  };

  try {
    const slow = streams.open(
      new AbortController().signal,
      subscription("agent=captain"),
    );

    const steady = watch(hub, "agent=captain");

    if (!slow) {
      throw new Error("Cannot open event stream");
    }

    const log = hub.recorder("captain").begin();
    const chunk = "x".repeat(activityPageBytes - 1024);

    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 5; i++) {
        log.update(`k${round}-${i}`, round, () => text(chunk));
      }

      await flushed();
    }

    const reader = slow.getReader();
    let error: unknown;

    try {
      while (!(await reader.read()).done) {
        /* Drain what was queued before the close. */
      }
    } catch (caught) {
      error = caught;
    }

    expect(String(error)).toContain("backed up");

    // The collector and other viewers carry on.
    log.update("after", 9, () => text("still here"));
    log.end("completed");
    await flushed();
    expect(snapshot(hub, "captain").turns[0]?.items).toHaveLength(16);
    expect(steady.events().at(-1)?.change.type).toBe("turn-ended");
    expect(steady.text()).toContain("still here");
    steady.stop();
  } finally {
    streams.stop();
  }
});

const host: V1Host = {
  hostname: "example",
  platform: "linux",
  arch: "arm64",
  uptimeSec: 100,
  cpu: { cores: 4, usage: 0.3, load: [0.1, 0.2, 0.3] },
  memory: { totalBytes: 4096, availableBytes: 1024 },
  disks: [],
  sampledAt: 1,
};

const gateway: V1Fleet["gateway"] = {
  version: "1.2.3",
  startedAt: 1,
  bunVersion: Bun.version,
  opencodeVersion: null,
  features: [],
};

const source: ApiV1Source = {
  fleet: async () => ({
    apiVersion: 1,
    generatedAt: 1,
    name: "Example",
    admiral: null,
    ships: [],
    longestIdle: null,
  }),
  ship: async () => undefined,
  crew: async () => undefined,
  gatewayFeatures: () => [],
};

async function listen(dataDirectory: string, hub: Hub, signal: AbortSignal) {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null),
  });

  const address = `127.0.0.1:${reservation.port}`;
  await reservation.stop(true);

  const server = await startApiV1Server({
    config: { listen: address },
    dataDirectory,
    source,
    diff: () => [],
    gateway: {
      version: "1.2.3",
      opencodeVersion: async () => null,
      startedAt: 1,
    },
    activity: activityApi(hub, () => config),
    signal,
  });

  return server;
}
