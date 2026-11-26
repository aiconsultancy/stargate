import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { connect } from "node:net";
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
  settledBytes,
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
      ...bot("claude"),
      slack: {
        appId: "A789",
        appTokenEnv: "CLAUDE_APP_TOKEN",
        botTokenEnv: "CLAUDE_BOT_TOKEN",
      },
      backend: {
        type: "claude",
        model: "claude-sonnet-5-5",
        directory: "/w",
        provider: {
          baseURL: "http://127.0.0.1:8317/v1",
          apiKeyEnv: "CLAUDE_PROVIDER_KEY",
        },
      },
    },
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

  const requests = [
    { channel: "#Bridge", msgid: "wire-A" },
    { channel: "#Bridge", msgid: "wire-B" },
  ];

  const log = hub.recorder("captain").begin(requests);

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
  expect(events[0]?.change).toMatchObject({
    type: "turn-started",
    turn: { requests },
  });
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
    change: {
      type: "turn-ended",
      turn: { status: "failed", seq: 53, requests },
    },
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
  const requests = [{ channel: "#Bridge", msgid: "own-request" }];
  const own = recorder.begin(requests);
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
  expect(events[1]?.change).toMatchObject({ turn: { requests } });
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

test("over HTTP, a refused subscription answers its status and never takes a viewer place, even at capacity", async () => {
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

    for (let i = 1; i < 8; i++) {
      await open();
    }

    // All eight places are taken, yet a bad subscription gets its own status.
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

    // A valid subscription finds no place.
    expect((await get("/api/v1/events?agent=captain")).status).toBe(503);
    expect((await get("/api/v1/events")).status).toBe(503);
    // Reads still answer at stream capacity.
    expect((await get("/api/v1/agents/captain/activity")).status).toBe(200);

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

test("activity frames go one at a time and never past a viewer's 256 KiB queue", async () => {
  const hub = createActivityHub();
  const streams = eventStreams();

  const subscription = subscribeActivity(
    hub,
    config,
    new URLSearchParams("agent=captain"),
  );

  if (subscription.status !== 200) {
    throw new Error("Unexpected refusal");
  }

  const sizes: number[] = [];
  let accepted: number | undefined;

  try {
    const stream = streams.open(new AbortController().signal, (send) => {
      const stop = subscription.watch((bytes) => {
        sizes.push(bytes.length);
        send(bytes);
      });

      return () => {
        // The frame that did not fit is the last one handed over.
        accepted ??= sizes.slice(0, -1).reduce((sum, size) => sum + size, 0);
        stop();
      };
    });

    if (!stream) {
      throw new Error("Cannot open event stream");
    }

    // Six inline items just under 64 KiB, all in one flush, with no reader.
    const log = hub.recorder("captain").begin();
    const chunk = "x".repeat(activityPageBytes - 512);

    for (let i = 0; i < 6; i++) {
      log.update(`k${i}`, i, () => text(chunk));
    }

    await flushed();

    // Each frame arrived on its own, inline, and the viewer was closed.
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThan(activityPageBytes + 1024);
    expect(accepted).toBeDefined();
    expect(accepted ?? Infinity).toBeLessThanOrEqual(256 * 1024);

    const reader = stream.getReader();
    expect(String(await reader.read().catch((error) => error))).toContain(
      "backed up",
    );
  } finally {
    streams.stop();
  }
});

test("Claude family changes converge with the snapshot after the child and root settle", async () => {
  const hub = createActivityHub();
  const viewer = watch(hub, "agent=claude");
  const requests = [{ channel: "#Bridge", msgid: "claude-request" }];

  const usage = {
    steps: 1,
    tokens: { input: 2, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0.25,
  };

  try {
    const root = hub.recorder("claude").begin(requests, "root");
    const initial = snapshot(hub, "claude");
    const parent = { turnId: initial.turns[0]?.id ?? "", callId: "agent-call" };
    const child = root.child?.(parent.callId, "child");
    expect(child).toBeDefined();
    child?.update("oversized", 1, () => ({
      ...text("\u0001" + "x".repeat(activityPageBytes)),
      unavailable: ["after-turn"],
    }));
    child?.update("encrypted", 2, () => ({
      kind: "reasoning",
      status: "completed",
      text: "",
      unavailable: ["text"],
    }));
    child?.setUsage?.(usage);
    await flushed();

    child?.end("completed");
    root.setUsage?.(usage);
    root.end("completed");
    await flushed();

    const events = viewer.events();
    const final = snapshot(hub, "claude");
    const childId = final.turns[1]?.id ?? "";
    expect(
      events.map(({ seq, turnId, change }) => [seq, turnId, change.type]),
    ).toEqual([
      [1, parent.turnId, "turn-started"],
      [2, childId, "turn-started"],
      [3, childId, "item"],
      [4, childId, "item"],
      [5, childId, "turn-updated"],
      [6, childId, "turn-ended"],
      [8, parent.turnId, "turn-ended"],
    ]);
    const common = { agentId: "claude", generation: initial.cursor.generation };
    expect(
      events.every(
        (event) =>
          event.agentId === common.agentId &&
          event.generation === common.generation,
      ),
    ).toBe(true);
    const childSummary = { requests: [], session: { id: "child", parent } };
    expect(events[0]?.change).toMatchObject({
      turn: {
        requests,
        session: { id: "root", parent: null },
        status: "running",
      },
    });
    expect(events[1]?.change).toMatchObject({
      turn: { ...childSummary, usage: null },
    });
    expect(events[2]?.change).toMatchObject({
      item: { unavailable: ["after-turn"], paged: { pages: 2 } },
    });
    expect(events[3]?.change).toMatchObject({
      item: { kind: "reasoning", text: "", unavailable: ["text"] },
    });
    expect(events[4]?.change).toMatchObject({
      turn: { ...childSummary, status: "running", usage },
    });
    expect(events[5]?.change).toMatchObject({
      turn: { ...childSummary, status: "completed", usage },
    });

    const joined = modelOf(initial);

    for (const event of events.filter(({ seq }) => seq > initial.cursor.seq)) {
      apply(joined, event);
    }

    expect(joined).toEqual(modelOf(final));
    expect(events.at(-1)?.seq).toBe(final.cursor.seq);
  } finally {
    viewer.stop();
  }
});

test("a Claude root subscription follows child changes in sequence order", async () => {
  const hub = createActivityHub();
  const recorder = hub.recorder("claude");
  const root = recorder.begin(undefined, "root");
  const rootId = snapshot(hub, "claude").turns[0]?.id ?? "";
  const viewer = watch(hub, `agent=claude&turn=${rootId}`);

  try {
    const child = root.child?.("call", "child");
    const childId = snapshot(hub, "claude").turns[1]?.id ?? "";
    const unrelated = recorder.begin();
    unrelated.end("completed");
    child?.update("reply", 1, () => text("child output"));
    child?.end("completed");
    root.end("completed");
    await flushed();

    expect(
      viewer
        .events()
        .map(({ seq, turnId, change }) => [seq, turnId, change.type]),
    ).toEqual([
      [2, childId, "turn-started"],
      [5, childId, "item"],
      [6, childId, "turn-ended"],
      [7, rootId, "turn-ended"],
    ]);
  } finally {
    viewer.stop();
  }
});

test("a Claude child subscription follows only that child's events in sequence order", async () => {
  const hub = createActivityHub();
  const root = hub.recorder("claude").begin(undefined, "root");
  const child = root.child?.("call", "child");
  const childId = snapshot(hub, "claude").turns[1]?.id ?? "";
  const viewer = watch(hub, `agent=claude&turn=${childId}`);

  try {
    const sibling = root.child?.("other-call", "sibling");
    root.update("reply", 1, () => text("root output"));
    child?.update("reply", 2, () => text("child output"));
    sibling?.update("reply", 3, () => text("sibling output"));
    child?.update("another", 4, () => text("more child output"));
    sibling?.end("completed");
    child?.end("completed");
    root.end("completed");
    await flushed();

    expect(
      viewer
        .events()
        .map(({ seq, turnId, change }) => [seq, turnId, change.type]),
    ).toEqual([
      [5, childId, "item"],
      [7, childId, "item"],
      [9, childId, "turn-ended"],
    ]);
  } finally {
    viewer.stop();
  }
});

/** Each event's turn session and change type. */
const sessionEvents = (events: V1AgentActivityEvent[]) => {
  const sessions = new Map<string, string | undefined>();

  for (const { change } of events) {
    if (change.type !== "item") {
      sessions.set(change.turn.id, change.turn.session?.id);
    }
  }

  return events.map(({ turnId, change }) => [
    sessions.get(turnId) ?? turnId,
    change.type,
  ]);
};

test("a root's scoped watch follows a child admitted unlinked after its eviction", async () => {
  const hub = createActivityHub({ bytes: 1000 });
  const recorder = hub.recorder("claude");
  const parent = recorder.begin(undefined, "parent");
  const parentId = snapshot(hub, "claude").turns[0]?.id ?? "";
  const viewer = watch(hub, `agent=claude&turn=${parentId}`);

  try {
    parent.end("completed");
    // The parent outgrows the budget; the batch window has not measured it.
    parent.update("late", 1, () => text("x".repeat(5000)));
    const child = parent.child?.("call", "child");
    recorder.begin(undefined, "unrelated").end("completed");
    child?.update("k", 2, () => text("child"));
    child?.end("completed");
    await flushed();

    // Drained first, the parent goes and the child begins as its own root.
    expect(snapshot(hub, "claude").turns[0]?.session).toEqual({
      id: "child",
      parent: null,
    });
    expect(sessionEvents(viewer.events())).toEqual([
      ["parent", "turn-ended"],
      ["parent", "item"],
      ["child", "turn-started"],
      ["child", "item"],
      ["child", "turn-ended"],
    ]);
    expect(viewer.text()).not.toContain('"audience"');
    // A new watch of the evicted parent answers as before.
    expect(
      subscribeActivity(
        hub,
        config,
        new URLSearchParams(`agent=claude&turn=${parentId}`),
      ).status,
    ).toBe(404);
  } finally {
    viewer.stop();
  }
});

test("a root's scoped watch follows nested children of an unlinked child", async () => {
  const hub = createActivityHub({ bytes: 1000 });
  const parent = hub.recorder("claude").begin(undefined, "parent");
  const parentId = snapshot(hub, "claude").turns[0]?.id ?? "";
  const viewer = watch(hub, `agent=claude&turn=${parentId}`);

  try {
    parent.end("completed");
    parent.update("late", 1, () => text("x".repeat(5000)));
    const child = parent.child?.("call", "child");
    // Linked under the unlinked child, which is retained.
    const linked = child?.child?.("call", "linked");
    linked?.update("k", 2, () => text("linked"));
    linked?.end("completed");
    child?.end("completed");
    // The child's family goes the same way: its own late child is unlinked.
    child?.update("late", 3, () => text("y".repeat(5000)));
    const unlinked = child?.child?.("call", "unlinked");
    unlinked?.update("k", 4, () => text("unlinked"));
    await flushed();

    expect(snapshot(hub, "claude").turns.map(({ session }) => session)).toEqual(
      [{ id: "unlinked", parent: null }],
    );
    expect(
      sessionEvents(viewer.events()).filter(
        ([session]) => session !== "parent",
      ),
    ).toEqual([
      ["child", "turn-started"],
      ["linked", "turn-started"],
      ["linked", "item"],
      ["linked", "turn-ended"],
      ["child", "turn-ended"],
      ["child", "item"],
      ["unlinked", "turn-started"],
      ["unlinked", "item"],
    ]);
  } finally {
    viewer.stop();
  }
});

test("a further split keeps live root watches but not a closed inherited watch", async () => {
  let measured: Parameters<typeof settledBytes>[0] | undefined;

  const hub = createActivityHub({
    bytes: 1000,
    measure(turn) {
      measured = turn;

      return settledBytes(turn);
    },
  });

  const parent = hub.recorder("claude").begin(undefined, "parent");
  const parentId = snapshot(hub, "claude").turns[0]?.id ?? "";
  const ancestor = watch(hub, `agent=claude&turn=${parentId}`);
  const closing = watch(hub, `agent=claude&turn=${parentId}`);

  try {
    const oversize = "x".repeat(5000);
    parent.end("completed");
    parent.update("late", 1, () => text(oversize));
    const child = parent.child?.("call", "child");
    const childId = snapshot(hub, "claude").turns[0]?.id ?? "";
    const current = watch(hub, `agent=claude&turn=${childId}`);

    try {
      await flushed();
      expect(sessionEvents(closing.events())).toContainEqual([
        "child",
        "turn-started",
      ]);
      closing.stop();
      const received = closing.text();

      child?.end("completed");
      child?.update("late", 2, () => text(oversize));
      child?.child?.("call", "grandchild").end("completed");
      await flushed();

      for (const viewer of [ancestor, current]) {
        expect(sessionEvents(viewer.events()).slice(-2)).toEqual([
          ["grandchild", "turn-started"],
          ["grandchild", "turn-ended"],
        ]);
      }

      expect(closing.text()).toBe(received);
      expect(measured?.session).toEqual({ id: "grandchild", parent: null });
      expect(measured?.audience?.size).toBe(2);
    } finally {
      current.stop();
    }
  } finally {
    closing.stop();
    ancestor.stop();
  }
});

test("evicting a Claude family before the flush preserves both ends and the link", async () => {
  const hub = createActivityHub({ bytes: 10 });
  const viewer = watch(hub, "agent=claude");

  try {
    const root = hub.recorder("claude").begin(undefined, "root");
    const child = root.child?.("call", "child");
    const [rootTurn, childTurn] = snapshot(hub, "claude").turns;

    if (!rootTurn || !childTurn) {
      throw new Error("Expected a Claude family before eviction");
    }

    child?.update("text", 1, () => text("\u0001child output"));
    child?.end("completed");
    root.end("completed");
    const empty = snapshot(hub, "claude");
    expect(empty.turns).toEqual([]);
    await flushed();

    const events = viewer.events();
    expect(events.map(({ turnId, change }) => [turnId, change.type])).toEqual([
      [rootTurn.id, "turn-started"],
      [childTurn.id, "turn-started"],
      [childTurn.id, "item"],
      [childTurn.id, "turn-ended"],
      [rootTurn.id, "turn-ended"],
    ]);
    expect(events[1]?.change).toMatchObject({
      turn: { session: { parent: { turnId: rootTurn.id, callId: "call" } } },
    });
    expect(events[2]?.change).toMatchObject({
      item: { text: "\u0001child output" },
    });
    expect(events.filter(({ seq }) => seq > empty.cursor.seq)).toEqual([]);
  } finally {
    viewer.stop();
  }
});

test("a turn evicted as it ends still sends its end", async () => {
  // Any ended turn is over this byte budget, so it goes at once.
  const hub = createActivityHub({ bytes: 10 });
  const viewer = watch(hub, "agent=captain");

  try {
    const log = hub.recorder("captain").begin();
    log.update("a", 1, () => text("a reply well over ten bytes"));
    log.end("failed");
    expect(snapshot(hub, "captain").turns).toEqual([]);
    await flushed();

    const events = viewer.events();
    expect(events.map((event) => event.change.type)).toEqual([
      "turn-started",
      "item",
      "turn-ended",
    ]);

    const ended = events.at(-1)?.change;
    expect(ended?.type === "turn-ended" && ended.turn.status).toBe("failed");
    expect(snapshot(hub, "captain").turns).toEqual([]);
  } finally {
    viewer.stop();
  }
});

test("each lifecycle event shows the turn as it was at its own seq", async () => {
  let clock = 100;
  const hub = createActivityHub({ now: () => clock });
  const viewer = watch(hub, "agent=captain");

  const requests = [{ channel: "#Bridge", msgid: "wire-request" }];

  try {
    // Start, reconnect and end all inside one flush window.
    const log = hub.recorder("captain").begin(requests);
    clock = 110;
    log.update("a", 110, () => text("one"));
    clock = 120;
    log.reconnected();
    clock = 130;
    log.end("completed");
    await flushed();

    const events = viewer.events();

    const turns = events.flatMap((event) =>
      event.change.type === "item"
        ? []
        : [
            {
              type: event.change.type,
              seq: event.seq,
              turn: event.change.turn,
            },
          ],
    );

    // The reconnect and the end share a key: the end, as recorded, wins.
    expect(turns).toEqual([
      {
        type: "turn-started",
        seq: 1,
        turn: {
          id: turns[0]?.turn.id ?? "",
          seq: 1,
          status: "running",
          startedAt: 100,
          updatedAt: 100,
          endedAt: null,
          reconnects: 0,
          requests,
          usage: null,
        },
      },
      {
        type: "turn-ended",
        seq: 4,
        turn: {
          id: turns[0]?.turn.id ?? "",
          seq: 4,
          status: "completed",
          startedAt: 100,
          updatedAt: 130,
          endedAt: 130,
          reconnects: 1,
          requests,
          usage: null,
        },
      },
    ]);

    const item = events.find((event) => event.change.type === "item");
    expect(item?.seq).toBe(2);
  } finally {
    viewer.stop();
  }
});

test("over HTTP, a viewer that never reads frees its place once it overflows", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "stargate-activity-"));
  const shutdown = new AbortController();
  const hub = createActivityHub();
  const server = await listen(dataDirectory, hub, shutdown.signal);
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const url = new URL(server.url);

  const stalled = connect({
    host: url.hostname,
    port: Number(url.port),
  });

  const connected = new Promise<void>((resolve, reject) => {
    stalled.once("connect", resolve);
    stalled.once("error", reject);
  });

  try {
    const token = await apiToken(dataDirectory);

    const get = (path: string) =>
      fetch(new URL(path, server.url), {
        headers: { Authorization: `Bearer ${token}` },
      });

    // Seven plain viewers that read, and one activity viewer that never does.
    for (let i = 0; i < 7; i++) {
      const plain = await get("/api/v1/events");
      expect(plain.status).toBe(200);
      const reader = plain.body?.getReader();

      if (reader) {
        readers.push(reader);
      }
    }

    await connected;
    stalled.on("error", () => {});
    stalled.write(
      `GET /api/v1/events?agent=captain HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\n\r\n`,
    );
    stalled.pause();

    const ninth = async () => {
      const response = await get("/api/v1/events?agent=captain");

      if (response.status === 200) {
        readers.push(
          response.body?.getReader() ?? new ReadableStream().getReader(),
        );
      } else {
        await response.body?.cancel();
      }

      return response.status;
    };

    // Wait until the stalled viewer holds the eighth place.
    const deadline = Date.now() + 5000;

    while (
      (await get("/api/v1/agents/captain/activity")).status !== 200 ||
      (await ninth()) !== 503
    ) {
      if (Date.now() > deadline) {
        throw new Error("The stalled viewer never took a place");
      }
    }

    // Fill the socket and then the queue; the collector never waits.
    const log = hub.recorder("captain").begin();
    const chunk = "y".repeat(activityPageBytes - 512);
    const started = Date.now();
    let status = 503;

    // Each flush fits an empty queue, so only a stalled socket overflows it.
    for (let round = 0; round < 400 && status !== 200; round++) {
      for (let i = 0; i < 3; i++) {
        log.update(`r${round}-${i}`, round, () => text(chunk));
      }

      await wait(activityFlushMs + 20);
      status = round % 4 === 3 ? await ninth() : 503;
    }

    expect(status).toBe(200);
    // Well before the 60-second socket timeout.
    expect(Date.now() - started).toBeLessThan(30_000);
  } finally {
    stalled.destroy();

    for (const reader of readers) {
      await reader.cancel().catch(() => {});
    }

    await server.stop();
    shutdown.abort();
    await rm(dataDirectory, { recursive: true, force: true });
  }
}, 60_000);

function eventStreams() {
  return createEventStreams(
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
}

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
