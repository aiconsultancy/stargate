import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { Schema } from "effect";
import type { ActivityItem, CrewTurnStart } from "../src/backends/backend";
import { configSchema } from "../src/config";
import {
  activityApi,
  activityFlushMs,
  activityPageBytes,
  createActivityHub,
  readActivity,
  readCrewActivity,
  settledBytes,
  subscribeActivity,
} from "../src/observability/dashboard/api/v1/activity";
import type { ApiV1Config } from "../src/observability/dashboard/api/v1/features";
import { gatewayFeatures } from "../src/observability/dashboard/api/v1/features";
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
} from "../src/observability/dashboard/api/v1/types";
import { bot } from "./fixtures";

const config: ApiV1Config = Schema.decodeUnknownSync(configSchema)({
  bots: [bot("captain")],
});

type Hub = ReturnType<typeof createActivityHub>;

const text = (value: string): ActivityItem => ({
  kind: "text",
  status: "completed",
  text: value,
});

const start = (
  member: string,
  task: CrewTurnStart["task"] = null,
): CrewTurnStart => ({
  member,
  project: null,
  session: { id: `ses_${member}`, parent: null },
  task,
});

const decoder = new TextDecoder();

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

const flushed = () => wait(activityFlushMs * 2);

const read = (hub: Hub, member: string, query = "") =>
  readCrewActivity(hub, config, "captain", member, new URLSearchParams(query));

function snapshot(hub: Hub, member: string) {
  const result = read(hub, member);

  if (result.status !== 200 || !("turns" in result.body)) {
    throw new Error(`Unexpected read ${result.status}`);
  }

  return result.body;
}

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

test("a crew member's snapshot, turn and item pages", () => {
  const hub = createActivityHub();
  const crew = hub.crewRecorder("captain");

  // Before the crew plugin reports, any member reads as not collected.
  expect(snapshot(hub, "mario")).toEqual({
    agent: {
      id: "captain",
      role: "captain",
      backend: "opencode",
      collected: false,
      member: "mario",
    },
    turns: [],
    cursor: { generation: hub.generation, seq: 0 },
  });

  crew.roster?.(["mario", "luigi"]);
  const task = { id: "task_1", inputId: "msg_1", project: null };
  const log = crew.begin(start("mario", task));
  const control = "line\u0007 with a bell and \u001b[31m escape";
  log.update("a", 1, () => text(control));
  log.update("big", 2, () => text("x".repeat(activityPageBytes + 10)));

  const body = snapshot(hub, "mario");
  expect(body.agent.collected).toBe(true);
  expect(body.agent.member).toBe("mario");
  expect(body.turns).toHaveLength(1);
  const [turn] = body.turns;
  expect(turn?.task).toEqual(task);
  expect(turn?.session).toEqual({ id: "ses_mario", parent: null });
  expect(turn?.requests).toEqual([]);
  // Unredacted, with control characters kept.
  expect(turn?.items[0]).toMatchObject({ text: control });

  const paged = turn?.items[1];
  expect(paged && "paged" in paged ? paged.paged.pages : 0).toBe(2);

  const one = read(hub, "mario", `turn=${turn?.id}`);
  expect(one.status === 200 && "turns" in one.body && one.body.turns).toEqual(
    body.turns,
  );

  const pages = [0, 1].map((page) => {
    const result = read(hub, "mario", `turn=${turn?.id}&item=i2&page=${page}`);

    return result.status === 200 ? (result.body as V1ActivityItemPage) : null;
  });

  expect(pages[0]).toMatchObject({
    agent: "captain",
    member: "mario",
    turn: turn?.id,
    item: "i2",
    page: 0,
    pages: 2,
  });
  expect(
    JSON.parse(pages.map((page) => page?.data ?? "").join("")),
  ).toMatchObject({ id: "i2", text: "x".repeat(activityPageBytes + 10) });

  // Another member has its own subject.
  expect(snapshot(hub, "luigi").turns).toEqual([]);

  for (const query of [
    "item=i1",
    `turn=${turn?.id}&page=0`,
    "turn=BAD!",
    "bogus=1",
    `turn=${turn?.id}&turn=${turn?.id}`,
    `request=m1&turn=${turn?.id}`,
  ]) {
    expect([query, read(hub, "mario", query).status]).toEqual([query, 400]);
  }

  expect(read(hub, "mario", "turn=zz-1").status).toBe(404);
  expect(read(hub, "mario", `turn=${turn?.id}&item=i9`).status).toBe(404);
  expect(read(hub, "mario", `turn=${turn?.id}&item=i2&page=2`).status).toBe(
    404,
  );
  // Crew turns answer no IRC request.
  expect(read(hub, "mario", "request=m1").status).toBe(404);
  // While the plugin reports, a member without a peer or a turn is unknown.
  expect(read(hub, "peach").status).toBe(404);
  expect(read(hub, "Mario").status).toBe(404);
  expect(
    readCrewActivity(hub, config, "nobody", "mario", new URLSearchParams())
      .status,
  ).toBe(404);

  // A member whose peer went away keeps its retained turns.
  crew.roster?.(["luigi"]);
  expect(read(hub, "mario").status).toBe(200);
  // An older plugin: not collected, never an error.
  crew.roster?.(undefined);
  expect(snapshot(hub, "peach").agent.collected).toBe(false);
});

test("crew turns keep their own per-member limit beside an officer's", () => {
  const hub = createActivityHub({ turnsPerAgent: 3 });
  const crew = hub.crewRecorder("captain");

  for (let index = 0; index < 5; index++) {
    hub.recorder("captain").begin().end("completed");
    crew.begin(start("mario")).end("completed");
  }

  const officer = readActivity(hub, config, "captain", new URLSearchParams());

  if (officer.status !== 200 || !("turns" in officer.body)) {
    throw new Error("Unexpected officer read");
  }

  expect(officer.body.turns).toHaveLength(3);
  expect(officer.body.agent.member).toBeUndefined();
  expect(snapshot(hub, "mario").turns).toHaveLength(3);
  // Each subject counts its own seq.
  expect(snapshot(hub, "mario").cursor.seq).toBe(10);
});

test("crew and officer families share the global settled budget", async () => {
  const hub = createActivityHub({ turns: 2, turnsPerAgent: 16 });
  const crew = hub.crewRecorder("captain");
  crew.roster?.(["mario", "luigi"]);

  const officer = () =>
    readActivity(hub, config, "captain", new URLSearchParams());

  hub.recorder("captain").begin().end("completed");
  crew.begin(start("mario")).end("completed");
  // A running family spends none of the settled budget.
  const running = crew.begin(start("luigi"));
  running.update("a", 1, () => text("still working"));
  crew.begin(start("mario")).end("failed");

  const read = officer();
  expect(
    read.status === 200 && "turns" in read.body && read.body.turns,
  ).toEqual([]);
  expect(snapshot(hub, "mario").turns.map(({ status }) => status)).toEqual([
    "completed",
    "failed",
  ]);
  expect(snapshot(hub, "luigi").turns).toHaveLength(1);

  // A crew turn's task is part of its settled size.
  const sized = createActivityHub({ bytes: 1024 });

  const long = {
    id: `task_${"x".repeat(2048)}`,
    inputId: "msg_1",
    project: null,
  };

  sized.crewRecorder("captain").begin(start("mario", long)).end("completed");
  sized.crewRecorder("captain").begin(start("luigi")).end("completed");

  const kept = (member: string) =>
    readCrewActivity(sized, config, "captain", member, new URLSearchParams());

  const [mario, luigi] = [kept("mario"), kept("luigi")];
  expect(
    mario.status === 200 && "turns" in mario.body && mario.body.turns,
  ).toEqual([]);
  expect(
    luigi.status === 200 && "turns" in luigi.body && luigi.body.turns.length,
  ).toBe(1);

  // A crew turn subscription follows its turn by root.
  const subscription = subscribeActivity(
    hub,
    config,
    new URLSearchParams(
      `crew=captain/luigi&turn=${snapshot(hub, "luigi").turns[0]?.id}`,
    ),
  );

  if (subscription.status !== 200) {
    throw new Error("Unexpected subscription");
  }

  let received = "";

  const stop = subscription.watch((bytes) => {
    received += decoder.decode(bytes);
  });

  running.update("b", 2, () => text("more"));
  await flushed();
  stop();
  expect(activityEvents(received).map((event) => event.member)).toEqual([
    "luigi",
  ]);
});

test("a late task attribution is a turn update", async () => {
  const hub = createActivityHub();
  const crew = hub.crewRecorder("captain");
  crew.roster?.(["mario"]);

  const subscription = subscribeActivity(
    hub,
    config,
    new URLSearchParams("crew=captain/mario"),
  );

  if (subscription.status !== 200) {
    throw new Error("Unexpected subscription");
  }

  let received = "";

  const stop = subscription.watch((bytes) => {
    received += decoder.decode(bytes);
  });

  const log = crew.begin(start("mario"));
  log.update("a", 1, () => text("work"));
  await flushed();
  const task = { id: "task_2", inputId: "msg_2", project: "web" };
  log.attribute(task);
  // Only once: a turn that has its task keeps it.
  log.attribute({ ...task, id: "task_3" });
  await flushed();
  stop();

  const events = activityEvents(received);
  expect(events.every((event) => event.agentId === "captain")).toBe(true);
  expect(events.every((event) => event.member === "mario")).toBe(true);
  expect(events.map((event) => event.change.type)).toEqual([
    "turn-started",
    "item",
    "turn-updated",
  ]);

  const updated = events.at(-1)?.change;
  expect(updated && "turn" in updated ? updated.turn.task : null).toEqual(task);
  expect(snapshot(hub, "mario").turns[0]?.task).toEqual(task);
});

test("crew subscriptions validate before a stream is opened", () => {
  const hub = createActivityHub();
  const crew = hub.crewRecorder("captain");
  crew.roster?.(["mario"]);
  crew.begin(start("mario"));
  const turnId = snapshot(hub, "mario").turns[0]?.id ?? "";

  const status = (query: string) =>
    subscribeActivity(hub, config, new URLSearchParams(query)).status;

  expect(status("crew=captain/mario")).toBe(200);
  expect(status("crew=captain/mario&agent=captain")).toBe(200);
  expect(status(`crew=captain/mario&turn=${turnId}`)).toBe(200);

  for (const query of [
    "crew=captain",
    "crew=captain/",
    "crew=/mario",
    "crew=captain/mario/x",
    "crew=Captain/mario",
    "crew=captain/mario&crew=captain/mario",
    `crew=captain/mario&agent=captain&turn=${turnId}`,
    // Eight subjects at most, agents and crew members together.
    [
      ...Array.from({ length: 4 }, (_, i) => `agent=a${i}`),
      ...Array.from({ length: 5 }, (_, i) => `crew=captain/m${i}`),
    ].join("&"),
  ]) {
    expect([query, status(query)]).toEqual([query, 400]);
  }

  expect(status("crew=nobody/mario")).toBe(404);
  expect(status("crew=captain/peach")).toBe(404);
  expect(status("crew=captain/mario&agent=nobody")).toBe(404);
  expect(status("crew=captain/mario&turn=zz-1")).toBe(404);
  // A crew turn is not the officer's.
  expect(status(`agent=captain&turn=${turnId}`)).toBe(404);
});

test("over HTTP, a crew snapshot and its events join into a fresh snapshot", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "stargate-crew-act-"));
  const shutdown = new AbortController();
  const hub = createActivityHub();
  const server = await listen(dataDirectory, hub, shutdown.signal);

  try {
    const token = await apiToken(dataDirectory);

    const get = (path: string) =>
      fetch(new URL(path, server.url), {
        headers: { Authorization: `Bearer ${token}` },
      });

    const crew = hub.crewRecorder("captain");
    crew.roster?.(["mario"]);

    expect(
      (await get("/api/v1/ships/captain/crew/peach/activity")).status,
    ).toBe(404);
    expect(
      (await get("/api/v1/ships/captain/crew/mario/activity?x=1")).status,
    ).toBe(400);
    expect((await get("/api/v1/events?crew=captain/peach")).status).toBe(404);
    expect((await get("/api/v1/events?crew=captain")).status).toBe(400);

    const stream = await get("/api/v1/events?crew=captain/mario");
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();

    if (!reader) {
      throw new Error("No stream body");
    }

    const log = crew.begin(start("mario"));
    log.update("a", 1, () => text("one"));
    // An officer turn on the same captain is another subject.
    hub
      .recorder("captain")
      .begin()
      .update("o", 1, () => text("officer"));

    const before = (await (
      await get("/api/v1/ships/captain/crew/mario/activity")
    ).json()) as V1AgentActivity;

    expect(before.agent).toMatchObject({ id: "captain", member: "mario" });
    log.update(
      "a",
      2,
      () => text(""),
      (item) => {
        if (item.kind === "text") {
          item.text = "one, changed";
        }
      },
    );
    log.attribute({ id: "task_1", inputId: "msg_1", project: null });
    log.update("b", 3, () => text("two"));
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
    expect(received).not.toContain("officer");
    expect(events.every((e) => e.member === "mario")).toBe(true);

    const model = modelOf(before);

    for (const event of events) {
      if (event.seq > before.cursor.seq) {
        apply(model, event);
      }
    }

    expect(model).toEqual(modelOf(snapshot(hub, "mario")));
  } finally {
    await server.stop();
    shutdown.abort();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("crew activity is on whenever the Fleet API is", () => {
  const feature = (value: ApiV1Config) =>
    gatewayFeatures(value).find((entry) => entry.key === "api.crewActivity");

  expect(feature(config)).toMatchObject({
    enabled: false,
    defaultEnabled: true,
  });
  expect(
    feature({ ...config, api: { listen: "unix" } } as ApiV1Config),
  ).toMatchObject({ enabled: true });
});

const reads: Pick<ApiV1Source, "fleet" | "ship" | "crew"> = {
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
};

const source: ApiV1Source = {
  ...reads,
  officer: reads,
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

  return startApiV1Server({
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
}

test("empty subjects are reclaimed, and seq and turn IDs never go back", () => {
  const hub = createActivityHub({ turns: 1 });
  const crew = hub.crewRecorder("captain");

  // An older plugin admits any well-formed member; watching leaves nothing.
  for (let index = 0; index < 200; index++) {
    hub.watch(`captain/m${index}`, () => {})();
  }

  expect(hub.subjects).toBe(0);

  crew.begin(start("mario")).end("completed");
  const before = snapshot(hub, "mario");
  const [first] = before.turns;
  // The global limit evicts mario's only turn.
  crew.begin(start("luigi")).end("completed");
  expect(snapshot(hub, "mario").turns).toEqual([]);
  expect(hub.subjects).toBe(1);
  expect(snapshot(hub, "mario").cursor.seq).toBeGreaterThanOrEqual(
    before.cursor.seq,
  );

  crew.begin(start("mario")).end("completed");
  const after = snapshot(hub, "mario");
  expect(after.cursor.seq).toBeGreaterThan(before.cursor.seq);
  expect(after.turns[0]?.seq).toBeGreaterThan(before.cursor.seq);
  expect(after.turns[0]?.id).not.toBe(first?.id);
  expect(hub.subjects).toBe(1);
});

test("a late attribution is an update, never an end, in or after the end's window", async () => {
  const hub = createActivityHub();
  const crew = hub.crewRecorder("captain");
  crew.roster?.(["mario"]);
  const model = modelOf(snapshot(hub, "mario"));
  let received = "";

  const stop = hub.watch("captain/mario", (frames) => {
    for (const frame of frames) {
      received += decoder.decode(frame.bytes);
    }
  });

  const task = { id: "task_1", inputId: "msg_1", project: null };
  // Attributed after its end was sent.
  const late = crew.begin(start("mario"));
  late.update("a", 1, () => text("one"));
  await flushed();
  late.end("completed");
  await flushed();
  late.attribute(task);
  await flushed();
  // Attributed just before its end, in the same window.
  const close = crew.begin(start("mario"));
  await flushed();
  close.attribute({ ...task, id: "task_2" });
  close.end("failed");
  await flushed();
  stop();

  const events = activityEvents(received);

  expect(
    events.map(({ change }) =>
      change.type === "item"
        ? "item"
        : `${change.type}:${change.turn.status}:${change.turn.task?.id ?? "-"}`,
    ),
  ).toEqual([
    "turn-started:running:-",
    "item",
    "turn-ended:completed:-",
    "turn-updated:completed:task_1",
    "turn-started:running:-",
    "turn-updated:running:task_2",
    "turn-ended:failed:task_2",
  ]);

  for (const event of events) {
    apply(model, event);
  }

  expect(model).toEqual(modelOf(snapshot(hub, "mario")));
});

test("changes after a turn ended count toward the settled budget", async () => {
  const hub = createActivityHub({ bytes: 4096 });
  const crew = hub.crewRecorder("captain");
  crew.roster?.(["mario"]);
  const log = crew.begin(start("mario"));
  log.update("a", 1, () => text("small"));
  log.end("completed");
  expect(snapshot(hub, "mario").turns).toHaveLength(1);

  // Frames proven after the end grow it past the budget.
  for (let index = 0; index < 4; index++) {
    log.update(
      "a",
      2 + index,
      () => text(""),
      (item) => {
        if (item.kind === "text") {
          item.text += "x".repeat(1024);
        }
      },
    );
  }

  // Measured at the end of the batch's window.
  await wait(activityFlushMs * 2);
  expect(snapshot(hub, "mario").turns).toEqual([]);
});

test("a crew turn starts when its first frame was observed", () => {
  const hub = createActivityHub({ now: () => 1000 });
  const crew = hub.crewRecorder("captain");
  crew.begin(start("mario"), 400).end("completed");
  crew.begin(start("mario")).end("completed");

  expect(snapshot(hub, "mario").turns.map((turn) => turn.startedAt)).toEqual([
    400, 1000,
  ]);
});

test("a replacement recorder fences the retired one, whose turns still settle", () => {
  const hub = createActivityHub();
  const retired = hub.crewRecorder("captain");
  retired.roster?.(["mario"]);
  const open = retired.begin(start("mario"));

  // The replacement backend writes: the retired one is fenced.
  const next = hub.crewRecorder("captain");
  next.roster?.(["mario", "luigi"]);
  const fenced = retired.begin(start("mario"));
  fenced.update("a", 1, () => text("duplicate"));
  fenced.end("completed");
  // Its teardown neither clears the roster nor loses its open turn.
  retired.roster?.(undefined);
  open.end("cancelled");

  expect(fenced.retained?.()).toBe(false);
  expect(hub.crew("captain")).toEqual(new Set(["mario", "luigi"]));
  expect(snapshot(hub, "mario").turns.map((turn) => turn.status)).toEqual([
    "cancelled",
  ]);
});

test("a mixed crew: OpenCode collected, a known Pi member not, others unknown", () => {
  const hub = createActivityHub();
  const crew = hub.crewRecorder("captain");
  crew.roster?.(["mario"], ["toad"]);

  expect(read(hub, "mario").status).toBe(200);
  expect(snapshot(hub, "mario").agent.collected).toBe(true);
  // A Pi worker the plugin knows: its turns are not collected.
  expect(read(hub, "toad").status).toBe(200);
  expect(snapshot(hub, "toad").agent.collected).toBe(false);
  expect(read(hub, "peach").status).toBe(404);
  expect(
    subscribeActivity(hub, config, new URLSearchParams("crew=captain/toad"))
      .status,
  ).toBe(200);
});

test("a rear admiral has no crew route, but keeps its officer feed", () => {
  const admiralConfig: ApiV1Config = Schema.decodeUnknownSync(configSchema)({
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

  const hub = createActivityHub();
  const crew = hub.crewRecorder("admiral");
  crew.roster?.(["mario"]);
  crew.begin(start("mario")).end("completed");
  hub.recorder("admiral").begin([]).end("completed");

  expect(
    readCrewActivity(
      hub,
      admiralConfig,
      "admiral",
      "mario",
      new URLSearchParams(),
    ).status,
  ).toBe(404);
  expect(
    subscribeActivity(
      hub,
      admiralConfig,
      new URLSearchParams("crew=admiral/mario"),
    ).status,
  ).toBe(404);

  const officer = readActivity(
    hub,
    admiralConfig,
    "admiral",
    new URLSearchParams(),
  );

  expect(officer.status).toBe(200);
  expect(
    subscribeActivity(hub, admiralConfig, new URLSearchParams("agent=admiral"))
      .status,
  ).toBe(200);
});

test("collected follows each member's current configured backend", () => {
  const hub = createActivityHub();
  const crew = hub.crewRecorder("captain");
  crew.roster?.(["mario", "luigi"], []);
  crew.begin(start("toad")).end("completed");

  // A configured OpenCode member with no peer session and no turn yet.
  expect(read(hub, "luigi").status).toBe(200);
  expect(snapshot(hub, "luigi").agent.collected).toBe(true);
  expect(snapshot(hub, "luigi").turns).toEqual([]);

  // Toad moved to Pi: no longer collected, its OpenCode turns still readable.
  crew.roster?.(["mario", "luigi"], ["toad"]);
  expect(snapshot(hub, "toad").agent.collected).toBe(false);
  expect(snapshot(hub, "toad").turns.map((turn) => turn.status)).toEqual([
    "completed",
  ]);
  expect(read(hub, "peach").status).toBe(404);
});

test("an evicted turn's log accepts no further change", async () => {
  const hub = createActivityHub({ turns: 1 });
  const crew = hub.crewRecorder("captain");
  const old = crew.begin(start("mario"));
  old.end("completed");
  crew.begin(start("mario")).end("completed");
  expect(old.retained?.()).toBe(false);

  const frames: unknown[] = [];
  const stop = hub.watch("captain/mario", (batch) => frames.push(...batch));
  old.update("late", 1, () => text("late"));
  old.attribute({ id: "task_1", inputId: "in-1", project: null });
  old.reconnected();
  await wait(activityFlushMs * 3);
  stop();

  expect(frames).toEqual([]);
  expect(snapshot(hub, "mario").turns).toHaveLength(1);
  expect(snapshot(hub, "mario").turns[0]?.task).toBeNull();
});

const lateStep: ActivityItem = {
  kind: "step",
  status: "completed",
  model: null,
  firstTokenAt: null,
  streamedAt: null,
  endedAt: null,
  finish: null,
  tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  cost: 0.5,
  error: null,
};

/** A hub whose settled-turn measurements are counted and recorded. */
function measured(limits: { bytes?: number; turns?: number } = {}) {
  const sizes: number[] = [];

  const hub = createActivityHub({
    now: () => 1000,
    ...limits,
    measure: (turn) => {
      const size = settledBytes(turn);
      sizes.push(size);

      return size;
    },
  });

  return { hub, sizes, log: hub.crewRecorder("captain").begin(start("mario")) };
}

test("a late change is measured whole: separators and usage count", async () => {
  // The size of the turn had the step come before its end.
  const early = measured();
  early.log.update("a", 1000, () => text("a"));
  early.log.update("b", 1000, () => lateStep);
  early.log.end("completed");
  const [size = 0] = early.sizes;

  const run = async (bytes: number) => {
    const { log, sizes } = measured({ bytes });
    log.update("a", 1000, () => text("a"));
    log.end("completed");
    log.update("b", 1000, () => lateStep);
    await wait(activityFlushMs * 2);

    return { retained: log.retained?.(), sizes };
  };

  // The step arrived after the end: the same JSON, so the same threshold.
  const kept = await run(size);
  expect(kept.retained).toBe(true);
  expect(kept.sizes.at(-1)).toBe(size);
  expect((await run(size - 1)).retained).toBe(false);
});

test("a burst of late changes is measured once per window", async () => {
  const { log, sizes } = measured();
  log.update("a", 1000, () => text(""));
  log.end("completed");
  expect(sizes).toHaveLength(1);

  for (let index = 0; index < 200; index += 1) {
    log.update(
      "a",
      1000,
      () => text(""),
      (item) => {
        if (item.kind === "text") {
          item.text += "x";
        }
      },
    );
  }

  log.setUsage?.({
    steps: 1,
    tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
  });

  // Not yet: the window is still open.
  expect(sizes).toHaveLength(1);
  await wait(activityFlushMs * 2);
  expect(sizes).toHaveLength(2);

  // The next burst is the next window's single measurement.
  log.update(
    "a",
    1000,
    () => text(""),
    (item) => {
      if (item.kind === "text") {
        item.text += "y";
      }
    },
  );
  await wait(activityFlushMs * 2);
  expect(sizes).toHaveLength(3);
});

test("a late change over the byte budget evicts after its window", async () => {
  const early = measured();
  early.log.update("a", 1000, () => text("a"));
  early.log.end("completed");
  const [size = 0] = early.sizes;

  const { hub, log } = measured({ bytes: size + 10 });
  log.update("a", 1000, () => text("a"));
  log.end("completed");
  log.update("b", 1000, () => text("x".repeat(100)));

  // Retained, and still writable, until the window measures it.
  expect(log.retained?.()).toBe(true);
  await wait(activityFlushMs * 2);
  expect(log.retained?.()).toBe(false);
  expect(hub.retains("captain/mario")).toBe(false);

  // Evicted by count: measured first, once, and never again after.
  const again = measured({ turns: 1 });
  again.log.update("a", 1000, () => text("a"));
  again.log.end("completed");
  again.log.update("b", 1000, () => text("y"));
  again.hub.crewRecorder("captain").begin(start("luigi")).end("completed");
  expect(again.log.retained?.()).toBe(false);
  // Mario's end, his late change before Luigi's begin evicts, Luigi's end.
  expect(again.sizes).toHaveLength(3);
  await wait(activityFlushMs * 2);
  expect(again.sizes).toHaveLength(3);
});

test("a late shrink is measured before the next end evicts by bytes", async () => {
  const shapes = {
    a: "a",
    small: "s",
    big: "b".repeat(400),
    c: "c".repeat(600),
  };

  const probe = measured();
  const sizes = new Map<string, number>();

  for (const [name, value] of Object.entries(shapes)) {
    const log = probe.hub.crewRecorder("captain").begin(start("mario"));
    log.update("t", 1000, () => text(value));
    log.end("completed");
    sizes.set(name, probe.sizes.at(-1) ?? 0);
  }

  const size = (name: string) => sizes.get(name) ?? 0;
  // A, B (shrunk) and C fit exactly; A, B (as it ended) and C do not.
  const bytes = size("a") + size("small") + size("c");
  expect(size("a") + size("big") + size("c")).toBeGreaterThan(bytes);

  const { hub } = measured({ bytes });
  const recorder = hub.crewRecorder("captain");

  const ended = (value: string) => {
    const log = recorder.begin(start("mario"));
    log.update("t", 1000, () => text(value));
    log.end("completed");

    return log;
  };

  const a = ended(shapes.a);
  const b = ended(shapes.big);
  // B's late result shrinks it; C ends before the batch window closes.
  b.update(
    "t",
    1000,
    () => text(""),
    (item) => {
      if (item.kind === "text") {
        item.text = shapes.small;
      }
    },
  );
  const c = ended(shapes.c);

  expect([a, b, c].map((log) => log.retained?.())).toEqual([true, true, true]);
  await wait(activityFlushMs * 2);
  expect([a, b, c].map((log) => log.retained?.())).toEqual([true, true, true]);
});
