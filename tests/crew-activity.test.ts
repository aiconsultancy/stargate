import { afterEach, expect, test } from "bun:test";
import { setTimeout as wait } from "node:timers/promises";
import type { OpenCodeClient } from "@opencode/client";
import type {
  ActivityItem,
  ActivityOutcome,
  CrewTurnRecorder,
  CrewTurnStart,
  CrewTurnTask,
} from "../src/backends/backend";
import {
  type CrewActivityOptions,
  CrewActivityCollector,
} from "../src/backends/opencode/crew-activity";
import { witnessedExecutions } from "../src/backends/opencode/crew-executions";
import { Schema } from "effect";
import { configSchema } from "../src/config";
import {
  activityFlushMs,
  createActivityHub,
  crewSubject,
  readCrewActivity,
} from "../src/observability/dashboard/api/v1/activity";
import type { ApiV1Config } from "../src/observability/dashboard/api/v1/features";
import { MAX_CREW_CONTEXTS } from "../src/shared/session-history";
import { bot } from "./fixtures";
import type {
  CrewTurns,
  CrewTurnsInput,
} from "../src/coordination/crew/reporting/fleet-status";

const config: ApiV1Config = Schema.decodeUnknownSync(configSchema)({
  bots: [bot("captain")],
});

const stops: AbortController[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) {
    stop.abort();
  }
});

async function until(condition: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out");
    }

    await wait(5);
  }
}

/** A shared OpenCode event stream that broadcasts to every subscriber. */
function eventStream() {
  const subscribers = new Set<
    (frame: { type: string; data: unknown }) => void
  >();

  let subscriptions = 0;
  /** Ends every open subscription, as a dropped connection does. */
  const enders = new Set<() => void>();

  const subscribe = (options?: {
    signal?: AbortSignal;
    types?: readonly string[];
  }) => ({
    async *[Symbol.asyncIterator]() {
      const queue: unknown[] = [{ type: "server.connected", data: {} }];
      let wake: (() => void) | undefined;

      // Only the subscribed types, as the server sends.
      const push = (frame: { type: string; data: unknown }) => {
        if (options?.types && !options.types.includes(frame.type)) {
          return;
        }

        queue.push(frame);
        wake?.();
      };

      let ended = false;

      const end = () => {
        ended = true;
        wake?.();
      };

      subscribers.add(push);
      enders.add(end);
      subscriptions += 1;
      options?.signal?.addEventListener("abort", () => wake?.());

      try {
        while (!options?.signal?.aborted && !ended) {
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
        enders.delete(end);
      }
    },
  });

  return {
    events: { subscribe } as unknown as OpenCodeClient["event"],
    emit(
      type: string,
      data: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ) {
      for (const push of subscribers) {
        push({ type, data, ...extra });
      }
    },
    subscribers: () => subscribers.size,
    /** Drop the connection: frames emitted until the reattach are lost. */
    disconnect() {
      for (const end of enders) {
        end();
      }
    },
    /** Every subscription opened, counting each reattach. */
    subscriptions: () => subscriptions,
  };
}

type RecordedTurn = {
  start: CrewTurnStart;
  items: Map<string, ActivityItem>;
  attributed: CrewTurnTask[];
  ended: ActivityOutcome | undefined;
  startedAt: number | undefined;
  reconnects: number;
};

function fakeRecorder() {
  const turns: RecordedTurn[] = [];

  const recorder: CrewTurnRecorder = {
    begin(start, startedAt) {
      const turn: RecordedTurn = {
        start: structuredClone(start),
        items: new Map(),
        attributed: [],
        ended: undefined,
        startedAt,
        reconnects: 0,
      };

      turns.push(turn);

      return {
        update(key, _at, create, change) {
          let item = turn.items.get(key);

          if (!item) {
            item = create();
            turn.items.set(key, item);
          }

          change?.(item);
        },
        reconnected() {
          turn.reconnects += 1;
        },
        end(outcome) {
          turn.ended ??= outcome;
        },
        attribute(task) {
          turn.attributed.push(task);
        },
      };
    },
  };

  const text = (turn: RecordedTurn | undefined) =>
    [...(turn?.items.values() ?? [])]
      .map((item) => ("text" in item ? item.text : ""))
      .join("|");

  return { turns, recorder, text };
}

const peer = (member: string, workerSessionID: string) => ({
  member,
  project: null,
  workerSessionID,
  namespace: "crew",
});

const task = (
  taskID: string,
  workerSessionID: string,
  inputIDs: string[],
  member = "mario",
) => ({
  taskID,
  member,
  project: null,
  workerSessionID,
  originCaptainID: "captain-session",
  status: "running" as const,
  inputIDs,
});

/** A collector over a fake plugin whose reply can change between reads. */
function fixture(options: {
  turns: CrewTurns;
  owners: Record<string, string | undefined>;
  lookup?: (input: CrewTurnsInput) => Promise<CrewTurns>;
  collector?: Partial<CrewActivityOptions>;
  unsupported?: boolean;
  recorder?: CrewTurnRecorder;
  /** Delays an ownership answer. */
  hold?: (assistant: string) => Promise<void> | undefined;
}) {
  const stream = eventStream();
  const recorded = fakeRecorder();
  const reads: CrewTurnsInput[] = [];
  const state = { turns: options.turns };

  const collector = new CrewActivityCollector(
    options.recorder ?? recorded.recorder,
    {
      events: stream.events,
      turns: async (input) => {
        reads.push(input);

        if (options.unsupported) {
          throw Object.assign(new Error("missing"), {
            type: "rpc.method_not_found",
          });
        }

        return input.inputID !== undefined && options.lookup
          ? options.lookup(input)
          : state.turns;
      },
      owner: async (_session, assistant) => {
        await options.hold?.(assistant);

        return Object.hasOwn(options.owners, assistant)
          ? { input: options.owners[assistant] }
          : undefined;
      },
    },
    { refreshMs: 60_000, ...options.collector },
  );

  const stop = new AbortController();
  stops.push(stop);
  collector.start(stop.signal);

  const delta = (sessionID: string, assistant: string, value: string) => {
    stream.emit("session.text.delta", {
      sessionID,
      assistantMessageID: assistant,
      ordinal: 0,
      delta: value,
    });
  };

  const settle = (sessionID: string) => {
    stream.emit("session.execution.succeeded", { sessionID });
  };

  return { ...recorded, stream, collector, reads, state, delta, settle };
}

test("a task's turns are attributed by input, including a resumed task's second input", async () => {
  const { turns, stream, collector, delta, settle, reads, text } = fixture({
    turns: {
      peers: [peer("mario", "ses_mario")],
      tasks: [task("task_1", "ses_mario", ["in-1", "resume-1"])],
    },
    owners: { a1: "in-1", a2: "in-1", a3: "resume-1" },
  });

  await until(() => stream.subscribers() === 1);
  expect(collector.collected).toBe(true);

  delta("ses_mario", "a1", "first");
  await until(() => turns.length === 1);
  // A later assistant message of the same input joins its turn.
  delta("ses_mario", "a2", "second");
  await until(() => text(turns[0]).includes("second"));
  settle("ses_mario");
  await until(() => turns[0]?.ended === "completed");

  // The resume sends a new input; it continues the same task.
  delta("ses_mario", "a3", "resumed");
  await until(() => turns.length === 2);
  await until(() => text(turns[1]).includes("resumed"));

  expect(turns.map((turn) => turn.start)).toEqual([
    {
      member: "mario",
      project: null,
      session: { id: "ses_mario", parent: null },
      task: { id: "task_1", inputId: "in-1", project: null },
    },
    {
      member: "mario",
      project: null,
      session: { id: "ses_mario", parent: null },
      task: { id: "task_1", inputId: "resume-1", project: null },
    },
  ]);
  expect(text(turns[0])).toBe("first|second");
  expect(text(turns[1])).toBe("resumed");
  // Known inputs need no lookup.
  expect(reads.filter((read) => read.inputID !== undefined)).toEqual([]);
});

test("a DM turn has no task, after one lookup", async () => {
  const { turns, stream, delta, reads } = fixture({
    turns: {
      peers: [peer("mario", "ses_mario")],
      tasks: [task("task_1", "ses_mario", ["in-1"])],
    },
    owners: { d1: "dm-1", d2: "dm-1" },
    lookup: async () => ({ peers: [peer("mario", "ses_mario")], tasks: [] }),
  });

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "d1", "mail");
  await until(() => turns.length === 1);
  delta("ses_mario", "d2", "more mail");
  await wait(50);

  expect(turns).toHaveLength(1);
  expect(turns[0]?.start.task).toBeNull();
  expect(turns[0]?.attributed).toEqual([]);
  expect(reads.filter((read) => read.inputID !== undefined)).toEqual([
    { member: "mario", inputID: "dm-1" },
  ]);
});

test("stale peers and other namespaces' sessions are ignored", async () => {
  const fake = fixture({
    turns: {
      peers: [peer("mario", "ses_old")],
      tasks: [task("task_1", "ses_old", ["in-1"])],
    },
    owners: { a1: "in-1", a2: "in-2", x1: "in-x" },
    collector: { refreshMs: 20 },
  });

  const { turns, stream, delta, state, reads } = fake;
  await until(() => stream.subscribers() === 1);

  // A session of another namespace (same member name) is not this plugin's peer.
  delta("ses_other_namespace", "x1", "OTHER NAMESPACE");

  delta("ses_old", "a1", "old");
  await until(() => turns.length === 1);

  // The peer session is replaced; the old one drops out at the next refresh.
  state.turns = {
    peers: [peer("mario", "ses_new")],
    tasks: [task("task_2", "ses_new", ["in-2"])],
  };
  const refreshes = reads.length;
  await until(() => reads.length > refreshes + 1);

  expect(turns[0]?.ended).toBe("cancelled");
  delta("ses_old", "a1", "STALE");
  delta("ses_new", "a2", "new");
  await until(() => turns.length === 2);
  await wait(50);

  expect(turns.map((turn) => turn.start.session.id)).toEqual([
    "ses_old",
    "ses_new",
  ]);
  expect(turns[1]?.start.task).toEqual({
    id: "task_2",
    inputId: "in-2",
    project: null,
  });
  expect(fake.text(turns[0])).toBe("old");
});

test("a task of another worker session is not attributed", async () => {
  const { turns, stream, delta, settle, reads } = fixture({
    turns: {
      peers: [peer("mario", "ses_mario"), peer("luigi", "ses_luigi")],
      tasks: [
        task("task_other_session", "ses_elsewhere", ["in-1"]),
        task("task_luigi", "ses_luigi", ["in-2"], "luigi"),
      ],
    },
    owners: { a1: "in-1", a2: "in-2" },
  });

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a1", "one");
  await until(() => turns.length === 1);
  settle("ses_mario");
  // Luigi's input, answered in Mario's session: another member's task.
  delta("ses_mario", "a2", "two");
  await until(() => turns.length === 2);

  expect(turns.map((turn) => turn.start.task)).toEqual([null, null]);
  expect(reads.filter((read) => read.inputID !== undefined)).toEqual([]);
});

test("an older plugin without crewTurns is not collected", async () => {
  const { stream, collector, reads } = fixture({
    turns: { peers: [], tasks: [] },
    owners: {},
    unsupported: true,
  });

  await until(() => reads.length === 1);
  await wait(20);

  expect(collector.collected).toBe(false);
  // Nothing to collect: no event subscription.
  expect(stream.subscribers()).toBe(0);
});

test("frames wait at most the buffer time for a slow lookup", async () => {
  const lookup = Promise.withResolvers<CrewTurns>();

  const { turns, stream, delta, text } = fixture({
    turns: { peers: [peer("mario", "ses_mario")], tasks: [] },
    owners: { a1: "late-task-input" },
    lookup: () => lookup.promise,
    collector: { bufferMs: 50, readMs: 5000 },
  });

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a1", "waiting");
  await wait(20);
  expect(turns).toHaveLength(0);

  // The bound passed: the turn starts unattributed with its frames.
  await until(() => turns.length === 1);
  expect(turns[0]?.start.task).toBeNull();
  expect(text(turns[0])).toBe("waiting");

  lookup.resolve({
    peers: [peer("mario", "ses_mario")],
    tasks: [task("task_late", "ses_mario", ["late-task-input"])],
  });

  await until(() => turns[0]?.attributed.length === 1);
  expect(turns[0]?.attributed).toEqual([
    { id: "task_late", inputId: "late-task-input", project: null },
  ]);
});

test("frames wait at most the buffer size for a slow lookup", async () => {
  const lookup = Promise.withResolvers<CrewTurns>();

  const { turns, stream, delta, text } = fixture({
    turns: { peers: [peer("mario", "ses_mario")], tasks: [] },
    owners: { a1: "dm" },
    lookup: () => lookup.promise,
    collector: { bufferMs: 60_000, bufferBytes: 1024, readMs: 5000 },
  });

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a1", "small");
  await wait(20);
  expect(turns).toHaveLength(0);

  delta("ses_mario", "a1", "x".repeat(2048));
  await until(() => turns.length === 1);
  expect(text(turns[0])).toStartWith("small");
  lookup.resolve({ peers: [peer("mario", "ses_mario")], tasks: [] });
  await wait(20);
  expect(turns[0]?.attributed).toEqual([]);
});

test("the Fleet API serves collected crew turns with their tasks", async () => {
  const hub = createActivityHub();

  const { stream, delta, settle } = fixture({
    turns: {
      peers: [peer("mario", "ses_mario")],
      tasks: [task("task_1", "ses_mario", ["in-1"])],
    },
    owners: { a1: "in-1", d1: "dm-1" },
    lookup: async () => ({ peers: [peer("mario", "ses_mario")], tasks: [] }),
    recorder: hub.crewRecorder("captain"),
  });

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a1", "task work");
  await until(() => hub.retains(crewSubject("captain", "mario")));
  settle("ses_mario");
  delta("ses_mario", "d1", "mail");

  const read = () => {
    const result = readCrewActivity(
      hub,
      config,
      "captain",
      "mario",
      new URLSearchParams(),
    );

    if (result.status !== 200 || !("turns" in result.body)) {
      throw new Error(`Unexpected read ${result.status}`);
    }

    return result.body;
  };

  await until(() => read().turns.length === 2);
  const body = read();
  expect(body.agent).toMatchObject({ collected: true, member: "mario" });
  expect(body.turns.map((turn) => turn.task)).toEqual([
    { id: "task_1", inputId: "in-1", project: null },
    null,
  ]);
  expect(body.turns[0]?.status).toBe("completed");
  expect(body.turns[0]?.items[0]).toMatchObject({ text: "task work" });
  // Not a current peer while the plugin reports.
  expect(
    readCrewActivity(hub, config, "captain", "luigi", new URLSearchParams())
      .status,
  ).toBe(404);
});

test("an older crew plugin reads as not collected through the Fleet API", async () => {
  const hub = createActivityHub();
  const recorder = hub.crewRecorder("captain");
  recorder.roster?.(["mario"]);

  const { reads } = fixture({
    turns: { peers: [], tasks: [] },
    owners: {},
    unsupported: true,
    recorder,
  });

  await until(() => reads.length === 1);
  await until(() => hub.crew("captain") === undefined);

  const result = readCrewActivity(
    hub,
    config,
    "captain",
    "mario",
    new URLSearchParams(),
  );

  expect(result.status).toBe(200);
  expect(
    result.status === 200 && "agent" in result.body && result.body.agent,
  ).toMatchObject({ collected: false, member: "mario" });
});

test("a late ownership lookup never ends a newer execution's turn", async () => {
  const held = Promise.withResolvers<void>();

  const { turns, stream, delta, settle, text } = fixture({
    turns: {
      peers: [peer("mario", "ses_mario")],
      tasks: [
        task("task_a", "ses_mario", ["in-a"]),
        task("task_b", "ses_mario", ["in-b"]),
      ],
    },
    owners: { a1: "in-a", b1: "in-b" },
    hold: (assistant) => (assistant === "a1" ? held.promise : undefined),
    collector: { bufferMs: 60_000 },
  });

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a1", "a");
  await wait(5);
  stream.emit("session.execution.failed", { sessionID: "ses_mario" });
  delta("ses_mario", "b1", "b");
  await until(() => turns.length === 1);
  expect(turns[0]?.start.task?.id).toBe("task_b");

  held.resolve();
  await until(() => turns.length === 2);
  await wait(20);

  // A opened as its own turn and ended with its own outcome; B still runs.
  expect(turns[1]?.start.task?.id).toBe("task_a");
  expect(turns[1]?.ended).toBe("failed");
  expect(text(turns[1])).toBe("a");
  expect(turns[0]?.ended).toBeUndefined();
  expect(text(turns[0])).toBe("b");
  // Each starts at its first frame, though A opened second.
  expect(turns[1]?.startedAt ?? Infinity).toBeLessThan(
    turns[0]?.startedAt ?? 0,
  );

  settle("ses_mario");
  await until(() => turns[0]?.ended === "completed");
});

test("held frames, resolutions and lookups stay bounded, and refresh is not starved", async () => {
  const lookups = Promise.withResolvers<void>();
  const sessions = ["ses_a", "ses_b", "ses_c"];
  const recorded = fakeRecorder();
  const limits = { pendingBytes: 4000, resolving: 3 };
  let collector: CrewActivityCollector | undefined;
  let lookupsInFlight = 0;
  let maxLookups = 0;
  let maxHeld = 0;
  let maxResolving = 0;

  const sample = () => {
    const load = collector?.load;
    maxHeld = Math.max(maxHeld, load?.heldBytes ?? 0);
    maxResolving = Math.max(maxResolving, load?.resolving ?? 0);
  };

  const recorder: CrewTurnRecorder = {
    begin(start, startedAt) {
      const log = recorded.recorder.begin(start, startedAt);

      return {
        ...log,
        update(...args) {
          sample();
          log.update(...args);
        },
      };
    },
  };

  const assistants = sessions.flatMap((session, index) =>
    Array.from({ length: index === 0 ? 70 : 20 }, (_, n) => ({
      session,
      id: `${session}-m${n}`,
    })),
  );

  const fake = fixture({
    turns: {
      peers: sessions.map((session, index) => peer(`m${index}`, session)),
      tasks: [],
    },
    owners: Object.fromEntries(assistants.map(({ id }) => [id, `in-${id}`])),
    lookup: async () => {
      lookupsInFlight += 1;
      maxLookups = Math.max(maxLookups, lookupsInFlight);
      await lookups.promise;
      lookupsInFlight -= 1;

      return { peers: [], tasks: [] };
    },
    recorder,
    collector: { bufferMs: 60_000, readMs: 60_000, refreshMs: 20, ...limits },
  });

  collector = fake.collector;
  await until(() => fake.stream.subscribers() === 1);
  // Two bytes per character: a UTF-16 count would halve the held size.
  const marker = (id: string) => `${id}:${"é".repeat(300)}`;

  for (const { session, id } of assistants) {
    fake.delta(session, id, marker(id));
    await wait(0);
    sample();
  }

  // Lookups are stuck, yet the peer refresh keeps its own pace.
  const refreshes = () =>
    fake.reads.filter((read) => read.inputID === undefined).length;

  const before = refreshes();
  await wait(150);
  expect(refreshes()).toBeGreaterThan(before + 2);
  expect(maxHeld).toBeLessThanOrEqual(limits.pendingBytes);
  expect(maxHeld).toBeGreaterThan(0);
  expect(maxResolving).toBeLessThanOrEqual(limits.resolving);
  expect(maxLookups).toBeLessThanOrEqual(1);
  expect(fake.collector.load.lookups).toBeLessThanOrEqual(limits.resolving);

  lookups.resolve();

  // Every frame reached a turn: none was dropped by a bound or an eviction.
  const texts = () =>
    recorded.turns.map((turn) => recorded.text(turn)).join("|");

  await until(() => assistants.every(({ id }) => texts().includes(marker(id))));
  await until(() => fake.collector.load.heldBytes === 0);
});

test("a failed lookup is asked again, and a later answer links the existing turn", async () => {
  let calls = 0;

  const { turns, stream, delta, reads } = fixture({
    turns: { peers: [peer("mario", "ses_mario")], tasks: [] },
    owners: { a1: "in-x", a2: "in-x" },
    lookup: async () => {
      calls += 1;

      if (calls === 1) {
        throw new Error("transport closed");
      }

      return {
        peers: [peer("mario", "ses_mario")],
        tasks: [task("task_x", "ses_mario", ["in-x"])],
      };
    },
    collector: { bufferMs: 50 },
  });

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a1", "one");
  await until(() => turns.length === 1);
  expect(turns[0]?.start.task).toBeNull();

  // Not a confirmed miss: the next message asks again.
  delta("ses_mario", "a2", "two");
  await until(() => turns[0]?.attributed.length === 1);
  await wait(20);

  expect(turns).toHaveLength(1);
  expect(turns[0]?.attributed).toEqual([
    { id: "task_x", inputId: "in-x", project: null },
  ]);
  expect(reads.filter((read) => read.inputID !== undefined)).toHaveLength(2);
});

test("a session whose identity changes is fenced, with late resolutions", async () => {
  const held = Promise.withResolvers<void>();

  const fake = fixture({
    turns: {
      peers: [peer("mario", "ses_mario")],
      tasks: [task("task_1", "ses_mario", ["in-1"])],
    },
    owners: { a0: "in-1", a1: "in-1", a2: "in-1" },
    hold: (assistant) => (assistant === "a1" ? held.promise : undefined),
    collector: { refreshMs: 20, bufferMs: 60_000 },
  });

  const { turns, stream, delta, state, reads } = fake;
  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a0", "zero");
  await until(() => turns.length === 1);
  delta("ses_mario", "a1", "LATE");

  // The same session now claims another crew namespace.
  state.turns = {
    peers: [{ ...peer("mario", "ses_mario"), namespace: "other" }],
    tasks: [],
  };

  const refreshes = reads.length;
  await until(() => reads.length > refreshes + 2);
  expect(turns[0]?.ended).toBe("cancelled");

  held.resolve();
  delta("ses_mario", "a2", "AFTER");
  await wait(50);

  expect(turns).toHaveLength(1);
  expect(fake.text(turns[0])).toBe("zero");
});

test("closing tears collection down: late callbacks begin nothing", async () => {
  const lookup = Promise.withResolvers<CrewTurns>();
  const recorded = fakeRecorder();
  const rosters: (readonly string[] | undefined)[] = [];

  const { stream, delta } = fixture({
    turns: {
      peers: [peer("mario", "ses_mario")],
      tasks: [task("task_1", "ses_mario", ["in-1"])],
    },
    owners: { a1: "in-1", a2: "in-2" },
    lookup: () => lookup.promise,
    collector: { bufferMs: 100, readMs: 5000 },
    recorder: {
      ...recorded.recorder,
      roster(members) {
        rosters.push(members);
      },
    },
  });

  await until(() => stream.subscribers() === 1);
  // One open turn.
  delta("ses_mario", "a1", "open");
  await until(() => recorded.turns.length === 1);
  // One buffered message, waiting on a deferred lookup.
  delta("ses_mario", "a2", "buffered");
  await wait(20);
  expect(recorded.turns).toHaveLength(1);

  stops.at(-1)?.abort();
  lookup.resolve({
    peers: [peer("mario", "ses_mario")],
    tasks: [task("task_2", "ses_mario", ["in-2"])],
  });
  // Past the buffer deadline.
  await wait(200);

  expect(recorded.turns).toHaveLength(1);
  expect(recorded.turns[0]?.ended).toBe("cancelled");
  expect(recorded.turns[0]?.attributed).toEqual([]);
  expect(recorded.text(recorded.turns[0])).toBe("open");
  expect(stream.subscribers()).toBe(0);
  expect(rosters.at(-1)).toBeUndefined();
});

test("turns the hub evicted are no longer held by the collector", async () => {
  const hub = createActivityHub({ turns: 1 });
  const subject = crewSubject("captain", "mario");

  const { stream, delta, settle, collector } = fixture({
    turns: {
      peers: [peer("mario", "ses_mario")],
      tasks: [task("task_2", "ses_mario", ["in-2"])],
    },
    // The first input has no task: it waits unattributed.
    owners: { a1: "dm-1", a2: "in-2" },
    lookup: async () => ({ peers: [peer("mario", "ses_mario")], tasks: [] }),
    recorder: hub.crewRecorder("captain"),
  });

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a1", "first");
  await until(() => hub.retains(subject));
  settle("ses_mario");
  await until(() => hub.turns(subject)?.turns[0]?.status === "completed");
  const [first] = hub.turns(subject)?.turns ?? [];

  delta("ses_mario", "a2", "second");
  await until(() => hub.turns(subject)?.turns.length === 2);
  settle("ses_mario");
  // The global limit evicts the first turn when the second settles.
  await until(() => hub.turns(subject)?.turns.length === 1);
  expect(hub.turns(subject)?.turns[0]?.id).not.toBe(first?.id);

  expect(collector.load.turns).toBe(1);
  // A late frame of the evicted message changes nothing.
  delta("ses_mario", "a1", "late");
  await wait(20);
  expect(hub.turns(subject)?.turns.map((turn) => turn.items.length)).toEqual([
    1,
  ]);
  expect(collector.load.turns).toBe(1);
});

test("a steer inside a running execution joins the task's turn until it settles", async () => {
  const { turns, stream, delta, text } = fixture({
    turns: {
      peers: [peer("mario", "ses_mario")],
      tasks: [task("task_1", "ses_mario", ["in-1"])],
    },
    owners: { a1: "in-1", d1: "dm-1" },
    lookup: async () => ({ peers: [peer("mario", "ses_mario")], tasks: [] }),
  });

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a1", "task");
  await until(() => turns.length === 1);
  // A steered DM, answered in the same execution.
  delta("ses_mario", "d1", "steer");
  await until(() => text(turns[0]).includes("steer"));
  expect(turns[0]?.ended).toBeUndefined();
  stream.emit("session.execution.failed", { sessionID: "ses_mario" });
  await until(() => turns[0]?.ended !== undefined);

  expect(turns).toHaveLength(1);
  expect(turns[0]?.start.task).toEqual({
    id: "task_1",
    inputId: "in-1",
    project: null,
  });
  expect(turns[0]?.ended).toBe("failed");
  expect(text(turns[0])).toBe("task|steer");
});

test("another task's input mid-execution opens a turn, and neither ends early", async () => {
  const { turns, stream, delta } = fixture({
    turns: {
      peers: [peer("mario", "ses_mario")],
      tasks: [
        task("task_1", "ses_mario", ["in-1"]),
        task("task_2", "ses_mario", ["in-2"]),
      ],
    },
    owners: { a1: "in-1", b1: "in-2" },
  });

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a1", "one");
  await until(() => turns.length === 1);
  delta("ses_mario", "b1", "two");
  await until(() => turns.length === 2);
  await wait(20);
  expect(turns.map((turn) => turn.ended)).toEqual([undefined, undefined]);

  stream.emit("session.execution.failed", { sessionID: "ses_mario" });
  await until(() => turns.every((turn) => turn.ended === "failed"));
  expect(turns.map((turn) => turn.start.task?.id)).toEqual([
    "task_1",
    "task_2",
  ]);
});

test("an unproven message of the same execution stays in the task's turn", async () => {
  const held = Promise.withResolvers<void>();

  const { turns, stream, delta, settle, text } = fixture({
    turns: {
      peers: [peer("mario", "ses_mario")],
      tasks: [task("task_1", "ses_mario", ["in-1"])],
    },
    owners: { a1: "in-1", d1: "dm-1" },
    hold: (assistant) => (assistant === "d1" ? held.promise : undefined),
    lookup: async () => ({ peers: [peer("mario", "ses_mario")], tasks: [] }),
    collector: { bufferMs: 50 },
  });

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a1", "task");
  await until(() => turns.length === 1);
  // Past the buffer time, its owner still unknown: it joins and is shown.
  delta("ses_mario", "d1", "unproven");
  await until(() => text(turns[0]).includes("unproven"));

  // It resolves to a DM, and is never moved.
  held.resolve();
  await wait(50);
  settle("ses_mario");
  await until(() => turns[0]?.ended !== undefined);

  expect(turns).toHaveLength(1);
  expect(turns[0]?.start.task?.id).toBe("task_1");
  expect(turns[0]?.attributed).toEqual([]);
  expect(turns[0]?.ended).toBe("completed");
  expect(text(turns[0])).toBe("task|unproven");
});

test("an unproven message of a later execution opens its own turn", async () => {
  const held = Promise.withResolvers<void>();

  const { turns, stream, delta, settle, text } = fixture({
    turns: {
      peers: [peer("mario", "ses_mario")],
      tasks: [task("task_1", "ses_mario", ["in-1"])],
    },
    owners: { a1: "in-1", d1: "dm-1" },
    hold: (assistant) => (assistant === "d1" ? held.promise : undefined),
    lookup: async () => ({ peers: [peer("mario", "ses_mario")], tasks: [] }),
    collector: { bufferMs: 50 },
  });

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a1", "task");
  await until(() => turns.length === 1);
  settle("ses_mario");
  await until(() => turns[0]?.ended === "completed");

  delta("ses_mario", "d1", "later");
  await until(() => turns.length === 2);
  expect(turns[1]?.start.task).toBeNull();
  held.resolve();
  await wait(50);

  expect(text(turns[0])).toBe("task");
  expect(text(turns[1])).toBe("later");
  expect(turns[1]?.ended).toBeUndefined();
  settle("ses_mario");
  await until(() => turns[1]?.ended === "completed");
});

test("a joined message's late owner never names or moves the turn", async () => {
  const held = {
    d1: Promise.withResolvers<void>(),
    a2: Promise.withResolvers<void>(),
  };

  const { turns, stream, delta, settle, text } = fixture({
    turns: {
      peers: [peer("mario", "ses_mario")],
      tasks: [task("task_1", "ses_mario", ["in-1"])],
    },
    owners: { d1: "dm-1", a2: "in-1" },
    hold: (assistant) =>
      assistant === "d1" || assistant === "a2"
        ? held[assistant].promise
        : undefined,
    lookup: async () => ({ peers: [peer("mario", "ses_mario")], tasks: [] }),
    collector: { bufferMs: 50 },
  });

  await until(() => stream.subscribers() === 1);
  // Both unproven past the buffer time: the second joins the first's turn.
  delta("ses_mario", "d1", "dm");
  await until(() => turns.length === 1);
  delta("ses_mario", "a2", "task");
  await until(() => text(turns[0]).includes("task"));

  // The joined message resolves first, to a task's input.
  held.a2.resolve();
  await wait(50);
  held.d1.resolve();
  await wait(50);
  settle("ses_mario");
  await until(() => turns[0]?.ended !== undefined);

  expect(turns).toHaveLength(1);
  expect(turns[0]?.attributed).toEqual([]);
  expect(text(turns[0])).toBe("dm|task");
});

test("the roster names collected members apart from known Pi members", async () => {
  const recorded = fakeRecorder();
  const rosters: [readonly string[] | undefined, readonly string[]][] = [];

  fixture({
    turns: {
      members: [
        { member: "mario", collected: true },
        { member: "luigi", collected: true },
        { member: "toad", collected: false },
      ],
      peers: [peer("mario", "ses_mario")],
      tasks: [],
    },
    owners: {},
    recorder: {
      ...recorded.recorder,
      roster(members, uncollected = []) {
        rosters.push([members, uncollected]);
      },
    },
  });

  await until(() => rosters.length > 0);
  expect(rosters[0]).toEqual([["mario", "luigi"], ["toad"]]);
});

test("a crew at its member limit with one ready peer is read whole", async () => {
  const hub = createActivityHub();

  const members = Array.from({ length: MAX_CREW_CONTEXTS }, (_, index) => ({
    member: `m${index}`,
    collected: true,
  }));

  fixture({
    turns: { members, peers: [peer("m0", "ses_m0")], tasks: [] },
    owners: {},
    recorder: hub.crewRecorder("captain"),
  });

  await until(() => hub.crew("captain")?.size === MAX_CREW_CONTEXTS);

  const read = readCrewActivity(
    hub,
    config,
    "captain",
    `m${MAX_CREW_CONTEXTS - 1}`,
    new URLSearchParams(),
  );

  expect(
    read.status === 200 && "agent" in read.body && read.body.agent,
  ).toEqual(
    expect.objectContaining({
      member: `m${MAX_CREW_CONTEXTS - 1}`,
      collected: true,
    }),
  );
});

/** Two tasks of mario's session, and ownership answers held on demand. */
function ordered(
  owners: Record<string, string | undefined>,
  holding: string[],
  collector: Partial<CrewActivityOptions> = {},
) {
  const held = new Map(
    holding.map((assistant) => [assistant, Promise.withResolvers<void>()]),
  );

  const f = fixture({
    turns: {
      peers: [peer("mario", "ses_mario")],
      tasks: [
        task("task_1", "ses_mario", ["in-1"]),
        task("task_2", "ses_mario", ["in-2"]),
      ],
    },
    owners,
    hold: (assistant) => held.get(assistant)?.promise,
    lookup: async () => ({ peers: [peer("mario", "ses_mario")], tasks: [] }),
    collector,
  });

  const release = (assistant: string) => held.get(assistant)?.resolve();

  return { ...f, release };
}

test("a steer proven first still joins the task message that arrived before it", async () => {
  const { turns, stream, delta, text, release } = ordered(
    { a1: "in-1", d1: "dm-1" },
    ["a1"],
    { bufferMs: 1000 },
  );

  await until(() => stream.subscribers() === 1);
  const first = Date.now();
  delta("ses_mario", "a1", "task");
  await wait(20);
  const second = Date.now();
  delta("ses_mario", "d1", "steer");
  // The steer is proven, but waits for the earlier message.
  await wait(50);
  expect(turns).toHaveLength(0);
  release("a1");
  await until(() => text(turns[0]) === "task|steer");
  stream.emit("session.execution.failed", { sessionID: "ses_mario" });
  await until(() => turns[0]?.ended !== undefined);

  expect(turns).toHaveLength(1);
  expect(turns[0]?.start.task?.id).toBe("task_1");
  expect(turns[0]?.startedAt).toBeGreaterThanOrEqual(first);
  expect(turns[0]?.startedAt).toBeLessThan(second);
  expect(turns[0]?.ended).toBe("failed");
});

test("a task's second message proven first leaves the turn to its first", async () => {
  const { turns, stream, delta, text, release } = ordered(
    { a1: "in-1", a2: "in-1" },
    ["a1"],
    { bufferMs: 1000 },
  );

  await until(() => stream.subscribers() === 1);
  const first = Date.now();
  delta("ses_mario", "a1", "one");
  await wait(20);
  const second = Date.now();
  delta("ses_mario", "a2", "two");
  await wait(50);
  release("a1");
  await until(() => text(turns[0]) === "one|two");

  expect(turns).toHaveLength(1);
  expect(turns[0]?.start.task?.id).toBe("task_1");
  expect(turns[0]?.startedAt).toBeGreaterThanOrEqual(first);
  expect(turns[0]?.startedAt).toBeLessThan(second);
});

test("a proven task never joins a turn whose opener is still unproven", async () => {
  const { turns, stream, delta, text, release } = ordered(
    { a1: "in-1", b1: "in-2" },
    ["a1"],
    { bufferMs: 100 },
  );

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a1", "a");
  // Unproven at its buffer time: it opens unattributed.
  await until(() => turns.length === 1);
  delta("ses_mario", "b1", "b");
  // Held behind the resolving opener, then a turn of its own.
  await until(() => turns.length === 2);
  release("a1");
  await until(() => turns[0]?.attributed.length === 1);
  delta("ses_mario", "b1", "+");

  expect(turns[0]?.start.task).toBeNull();
  expect(turns[0]?.attributed.map((entry) => entry.id)).toEqual(["task_1"]);
  expect(text(turns[0])).toBe("a");
  expect(turns[1]?.start.task?.id).toBe("task_2");
  await until(() => text(turns[1]) === "b+");
  expect(text(turns[0])).toBe("a");
});

test("a byte bound places the earlier messages of its execution first", async () => {
  const { turns, stream, delta, text, release } = ordered(
    { a1: "in-1", a2: "in-1" },
    ["a1", "a2"],
    { bufferMs: 1000, bufferBytes: 400 },
  );

  await until(() => stream.subscribers() === 1);
  const first = Date.now();
  delta("ses_mario", "a1", "small");
  await wait(20);
  delta("ses_mario", "a2", "x".repeat(500));
  await until(() => turns.length > 0 && text(turns[0]).includes("x"));
  release("a1");
  release("a2");
  await until(() => turns[0]?.attributed.length === 1);

  expect(turns).toHaveLength(1);
  expect(text(turns[0])).toBe(`small|${"x".repeat(500)}`);
  expect(turns[0]?.startedAt).toBeLessThan(first + 20);
});

test("an unproven message joins the execution's latest turn", async () => {
  const { turns, stream, delta, text, release } = ordered(
    { a1: "in-1", b1: "in-2", b2: "in-2" },
    ["b2"],
    { bufferMs: 100 },
  );

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a1", "one");
  await until(() => turns.length === 1);
  delta("ses_mario", "b1", "two");
  await until(() => turns.length === 2);
  // Held past the buffer time: it joins task 2's turn, the latest.
  delta("ses_mario", "b2", "two-more");
  await until(() => text(turns[1]).includes("two-more"));
  release("b2");

  expect(text(turns[0])).toBe("one");
  expect(turns[1]?.start.task?.id).toBe("task_2");
});

test("a proven task after an unprovable opener opens its own turn", async () => {
  const { turns, stream, delta, text } = ordered(
    { a1: undefined, a2: "in-1" },
    [],
  );

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a1", "unknown");
  await until(() => turns.length === 1);
  delta("ses_mario", "a2", "task");
  await until(() => turns.length === 2);

  expect(turns[0]?.start.task).toBeNull();
  expect(turns[0]?.attributed).toEqual([]);
  expect(text(turns[0])).toBe("unknown");
  expect(turns[1]?.start.task?.id).toBe("task_1");
  expect(text(turns[1])).toBe("task");
});

test("a proven task held behind a resolving opener joins it once proven the same", async () => {
  const { turns, stream, delta, text, release } = ordered(
    { a1: "in-1", a2: "in-1" },
    ["a1"],
    { bufferMs: 100 },
  );

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a1", "one");
  await until(() => turns.length === 1);
  delta("ses_mario", "a2", "two");
  await wait(30);
  // Held: not yet in the unproven turn.
  expect(text(turns[0])).toBe("one");
  release("a1");
  await until(() => text(turns[0]) === "one|two");
  await wait(150);

  expect(turns).toHaveLength(1);
  expect(turns[0]?.attributed.map((entry) => entry.id)).toEqual(["task_1"]);
});

const started = (stream: ReturnType<typeof eventStream>, seq: number) => {
  stream.emit(
    "session.execution.started",
    { sessionID: "ses_mario" },
    { durable: { aggregateID: "ses_mario", seq, version: 1 } },
  );
};

test("a native start after a missed settle ends the open turns cancelled", async () => {
  const { turns, stream, delta, settle, text } = ordered(
    { a1: "in-1", d1: "dm-1", a2: "in-1" },
    [],
  );

  await until(() => stream.subscribers() === 1);
  started(stream, 1);
  delta("ses_mario", "a1", "a");
  await until(() => turns.length === 1);
  // A's settle never arrives; B's start does.
  started(stream, 5);
  await until(() => turns[0]?.ended !== undefined);
  delta("ses_mario", "d1", "dm");
  await until(() => turns.length === 2);
  delta("ses_mario", "a2", "b");
  await until(() => text(turns.at(-1)) === "b");
  settle("ses_mario");
  await until(() => turns.every((turn) => turn.ended !== undefined));

  expect(turns[0]?.ended).toBe("cancelled");
  expect(text(turns[0])).toBe("a");
  // B's DM and its task continuation: B's own turns, with B's outcome.
  expect(turns.slice(1).map((turn) => [turn.ended, text(turn)])).toEqual([
    ["completed", "dm"],
    ["completed", "b"],
  ]);
  expect(turns[2]?.start.task?.id).toBe("task_1");
});

test("a repeated native start never splits an execution", async () => {
  const { turns, stream, delta, settle, text } = ordered(
    { a1: "in-1", a2: "in-1" },
    [],
  );

  await until(() => stream.subscribers() === 1);
  // No open turn: a start changes nothing.
  started(stream, 1);
  delta("ses_mario", "a1", "one");
  await until(() => turns.length === 1);
  started(stream, 1);
  delta("ses_mario", "a2", "two");
  await until(() => text(turns[0]) === "one|two");
  expect(turns[0]?.ended).toBeUndefined();
  settle("ses_mario");
  await until(() => turns[0]?.ended !== undefined);

  expect(turns).toHaveLength(1);
  expect(turns[0]?.ended).toBe("completed");
});

test("a late frame that evicts its own turn leaves nothing to write to", async () => {
  const hub = createActivityHub({ bytes: 1500 });
  const subject = crewSubject("captain", "mario");

  const { stream, delta, settle, collector } = fixture({
    turns: {
      peers: [peer("mario", "ses_mario")],
      tasks: [task("task_1", "ses_mario", ["in-1"])],
    },
    owners: { a1: "in-1" },
    recorder: hub.crewRecorder("captain"),
  });

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a1", "first");
  await until(() => hub.retains(subject));
  settle("ses_mario");
  await until(() => hub.turns(subject)?.turns[0]?.status === "completed");

  // A late frame past the byte budget evicts the settled turn itself.
  // The hub evicts it when its measurement window ends, and says so.
  delta("ses_mario", "a1", "x".repeat(2000));
  await until(() => !hub.retains(subject));
  expect(collector.load.turns).toBe(0);

  const frames: unknown[] = [];
  const stop = hub.watch(subject, (batch) => frames.push(...batch));
  // A second frame before any refresh.
  delta("ses_mario", "a1", "again");
  await wait(activityFlushMs * 3);
  stop();

  expect(frames).toEqual([]);
  expect(hub.retains(subject)).toBe(false);
  expect(collector.load.turns).toBe(0);
});

test("a native start ends an execution whose messages are all still waiting", async () => {
  const { turns, stream, delta, text, release } = ordered(
    { a1: "in-1", d1: "dm-1" },
    ["a1"],
    { bufferMs: 1000 },
  );

  await until(() => stream.subscribers() === 1);
  started(stream, 1);
  delta("ses_mario", "a1", "a");
  await wait(20);
  // A's settle is missed while its only message waits; B starts.
  started(stream, 5);
  delta("ses_mario", "d1", "steer");
  await until(() => turns.length === 1);
  stream.emit("session.execution.failed", { sessionID: "ses_mario" });
  await until(() => turns[0]?.ended !== undefined);
  release("a1");
  await until(() => turns.length === 2 && turns[1]?.ended !== undefined);

  const a = turns.find((turn) => text(turn) === "a");
  const b = turns.find((turn) => text(turn) === "steer");
  expect(turns).toHaveLength(2);
  expect(a?.ended).toBe("cancelled");
  expect(a?.start.task?.id).toBe("task_1");
  expect(b?.ended).toBe("failed");
  expect(b?.start.task).toBeNull();
});

const boundary = (
  stream: ReturnType<typeof eventStream>,
  type: string,
  seq: number,
) => {
  stream.emit(
    type,
    { sessionID: "ses_mario" },
    { durable: { aggregateID: "ses_mario", seq, version: 1 } },
  );
};

const succeeded = "session.execution.succeeded";

test("a late settlement of an earlier execution never ends the next one", async () => {
  const { turns, stream, delta, text } = ordered(
    { a1: "in-1", d1: "dm-1" },
    [],
  );

  await until(() => stream.subscribers() === 1);
  started(stream, 1);
  delta("ses_mario", "a1", "a");
  await until(() => turns.length === 1);
  // B starts after A's settle was missed; A's settle then arrives late.
  started(stream, 5);
  delta("ses_mario", "d1", "b");
  await until(() => turns.length === 2);
  boundary(stream, succeeded, 3);
  await wait(50);

  expect(turns[0]?.ended).toBe("cancelled");
  expect(text(turns[1])).toBe("b");
  expect(turns[1]?.ended).toBeUndefined();
  boundary(stream, "session.execution.failed", 7);
  await until(() => turns[1]?.ended !== undefined);
  expect(turns[1]?.ended).toBe("failed");
});

test("a replayed settlement changes nothing once the next execution opened", async () => {
  const { turns, stream, delta } = ordered(
    { a1: "in-1", b1: "in-2", c1: "dm-1" },
    [],
  );

  await until(() => stream.subscribers() === 1);
  started(stream, 1);
  delta("ses_mario", "a1", "a");
  await until(() => turns.length === 1);
  boundary(stream, succeeded, 2);
  started(stream, 3);
  delta("ses_mario", "b1", "b");
  await until(() => turns.length === 2);
  boundary(stream, succeeded, 4);
  started(stream, 5);
  delta("ses_mario", "c1", "c");
  await until(() => turns.length === 3);
  // B's settle again, replayed after C opened.
  boundary(stream, succeeded, 4);
  await wait(50);

  expect(turns.map((turn) => turn.ended)).toEqual([
    "completed",
    "completed",
    undefined,
  ]);
});

test("a replayed start older than many boundaries changes nothing", async () => {
  const { turns, stream, delta } = ordered({ a1: "in-1" }, []);

  await until(() => stream.subscribers() === 1);

  // 17 executions with no output: 34 boundaries.
  for (let execution = 0; execution < 17; execution++) {
    started(stream, 2 * execution + 1);
    boundary(stream, succeeded, 2 * execution + 2);
  }

  started(stream, 35);
  delta("ses_mario", "a1", "a");
  await until(() => turns.length === 1);
  started(stream, 1);
  await wait(50);

  expect(turns).toHaveLength(1);
  expect(turns[0]?.ended).toBeUndefined();
});

test("a start without a durable sequence is applied and never reattaches", async () => {
  const { turns, stream, delta } = ordered({ a1: "in-1" }, []);

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a1", "a");
  await until(() => turns.length === 1);
  stream.emit("session.execution.started", { sessionID: "ses_mario" });
  await until(() => turns[0]?.ended !== undefined);
  await wait(400);

  expect(turns[0]?.ended).toBe("cancelled");
  expect(turns[0]?.reconnects).toBe(0);
  expect(stream.subscriptions()).toBe(1);
});

test("placed frames are let go while their resolutions still run or wait", async () => {
  const held = Promise.withResolvers<void>();
  const assistants = Array.from({ length: 6 }, (_, n) => `a${n}`);

  const fake = fixture({
    turns: { peers: [peer("mario", "ses_mario")], tasks: [] },
    owners: Object.fromEntries(assistants.map((id) => [id, `in-${id}`])),
    // Every ownership slot stays taken.
    hold: () => held.promise,
    collector: { bufferMs: 60_000, bufferBytes: 1000, resolving: 2 },
  });

  await until(() => fake.stream.subscribers() === 1);
  const large = (id: string) => `${id}:${"x".repeat(2000)}`;

  // Each frame is over the byte bound: placed at once, unattributed.
  for (const id of assistants) {
    fake.delta("ses_mario", id, large(id));
    await wait(0);
  }

  const texts = () => fake.turns.map((turn) => fake.text(turn)).join("|");
  await until(() => assistants.every((id) => texts().includes(large(id))));

  const { load } = fake.collector;
  expect(load.resolving).toBe(2);
  expect(load.deferred).toBe(4);
  expect(load.heldBytes).toBe(0);
  expect(load.resolvingFrames).toBe(0);
  held.resolve();
});

test("a late change to one turn that evicts another is forgotten before any refresh", async () => {
  const hub = createActivityHub({ bytes: 1500 });
  const subject = crewSubject("captain", "mario");
  const ids = () => hub.turns(subject)?.turns.map((turn) => turn.id) ?? [];

  const { stream, delta, settle, collector } = fixture({
    turns: { peers: [peer("mario", "ses_mario")], tasks: [] },
    owners: { a1: "in-1", b1: "in-2" },
    recorder: hub.crewRecorder("captain"),
  });

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a1", "first");
  await until(() => ids().length === 1);
  settle("ses_mario");
  delta("ses_mario", "b1", "second");
  await until(() => ids().length === 2);
  settle("ses_mario");
  await until(() => hub.turns(subject)?.turns[1]?.status === "completed");
  const [a, b] = ids();
  expect(collector.load.turns).toBe(2);

  // B grows late: the budget evicts A, the older settled turn.
  delta("ses_mario", "b1", "x".repeat(1150));
  await until(() => !ids().includes(a ?? ""));

  expect(ids()).toHaveLength(1);
  expect(ids()[0]).toBe(b ?? "");
  expect(collector.load.turns).toBe(1);
});

test("held frames replayed onto a settled turn that evict it are forgotten before any refresh", async () => {
  const hub = createActivityHub({ bytes: 1500 });
  const subject = crewSubject("captain", "mario");
  const held = Promise.withResolvers<void>();

  const { stream, delta, settle, collector } = fixture({
    turns: {
      peers: [peer("mario", "ses_mario")],
      tasks: [task("task_1", "ses_mario", ["in-1"])],
    },
    owners: { a1: "in-1", a2: "in-1" },
    hold: (assistant) => (assistant === "a2" ? held.promise : undefined),
    recorder: hub.crewRecorder("captain"),
    collector: { bufferMs: 60_000 },
  });

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a1", "first");
  await until(() => hub.retains(subject));
  // A second message of the same execution waits for its owner.
  delta("ses_mario", "a2", "x".repeat(2000));
  settle("ses_mario");
  await until(() => hub.turns(subject)?.turns[0]?.status === "completed");
  expect(collector.load.turns).toBe(1);

  // Proven after the settle, it joins the settled turn and evicts it.
  held.resolve();
  await until(() => !hub.retains(subject));

  expect(collector.load.turns).toBe(0);
});

test("a message first seen after its execution settled stays in that execution", async () => {
  const { turns, stream, delta, text } = ordered(
    { a1: "in-1", a2: "in-1", b1: "in-2" },
    [],
  );

  await until(() => stream.subscribers() === 1);
  started(stream, 1);
  delta("ses_mario", "a1", "a");
  await until(() => turns.length === 1);
  boundary(stream, succeeded, 10);
  await until(() => turns[0]?.ended !== undefined);
  // A's second message, committed before its settle, is first seen now.
  stream.emit(
    "session.text.started",
    { sessionID: "ses_mario", assistantMessageID: "a2", ordinal: 0 },
    { durable: { aggregateID: "ses_mario", seq: 5, version: 1 } },
  );
  delta("ses_mario", "a2", "late");
  await until(() => text(turns[0]).includes("late"));
  // The next execution's start finds nothing of its own to cancel.
  started(stream, 11);
  delta("ses_mario", "b1", "b");
  await until(() => turns.length === 2);
  await wait(50);

  expect(turns[0]?.ended).toBe("completed");
  expect(text(turns[1])).toBe("b");
  expect(turns[1]?.ended).toBeUndefined();
});

/** A message first seen through a frame at durable sequence `seq`. */
const lateText = (
  stream: ReturnType<typeof eventStream>,
  assistant: string,
  seq: number,
) => {
  stream.emit(
    "session.text.started",
    { sessionID: "ses_mario", assistantMessageID: assistant, ordinal: 0 },
    { durable: { aggregateID: "ses_mario", seq, version: 1 } },
  );
};

test("a late message joins the settled execution its sequence proves", async () => {
  const { turns, stream, delta, text } = ordered(
    { a1: "in-1", a2: "in-1", b1: "in-2", b2: "in-2" },
    [],
  );

  await until(() => stream.subscribers() === 1);
  started(stream, 1);
  delta("ses_mario", "a1", "a");
  await until(() => turns.length === 1);
  boundary(stream, succeeded, 10);
  await until(() => turns[0]?.ended !== undefined);
  started(stream, 11);
  delta("ses_mario", "b1", "b");
  await until(() => turns.length === 2);
  boundary(stream, "session.execution.failed", 20);
  await until(() => turns[1]?.ended !== undefined);

  // Each first seen after both settled: 5 is A's, 15 is B's.
  lateText(stream, "a2", 5);
  delta("ses_mario", "a2", "late-a");
  lateText(stream, "b2", 15);
  delta("ses_mario", "b2", "late-b");
  await until(
    () =>
      text(turns[0]).includes("late-a") && text(turns[1]).includes("late-b"),
  );
  await wait(50);

  expect(turns).toHaveLength(2);
  expect(turns.map((turn) => turn.ended)).toEqual(["completed", "failed"]);
  expect(text(turns[0])).toBe("a|late-a");
  expect(text(turns[1])).toBe("b|late-b");
});

test("a late message whose execution was trimmed joins the current one", async () => {
  const count = witnessedExecutions + 1;

  const { turns, stream, delta, text } = ordered(
    Object.fromEntries(
      [...Array.from({ length: count }, (_, i) => `e${i}`), "kept", "old"].map(
        (id) => [id, `dm-${id}`],
      ),
    ),
    [],
  );

  await until(() => stream.subscribers() === 1);

  for (let index = 0; index < count; index++) {
    started(stream, 10 * index + 1);
    delta("ses_mario", `e${index}`, `e${index}`);
    await until(() => turns.length === index + 1);
    boundary(stream, succeeded, 10 * index + 9);
    await until(() => turns[index]?.ended !== undefined);
  }

  // Inside the oldest retained execution: it joins it.
  lateText(stream, "kept", 15);
  delta("ses_mario", "kept", "kept");
  await until(() => text(turns[1]).includes("kept"));
  // Inside the first execution's bounds, which are no longer remembered.
  lateText(stream, "old", 5);
  delta("ses_mario", "old", "late");
  await until(() => turns.length === count + 1);
  await wait(50);

  expect(text(turns[1])).toBe("e1|kept");
  expect(turns[1]?.ended).toBe("completed");
  expect(text(turns[count])).toBe("late");
  expect(turns[count]?.ended).toBeUndefined();
  expect(turns.slice(2, count).map((turn) => text(turn))).toEqual(
    Array.from({ length: count - 2 }, (_, i) => `e${i + 2}`),
  );
});

test("a late message of an execution whose start was never seen borrows nothing", async () => {
  const { turns, stream, delta, text } = ordered(
    { a1: "in-1", a2: "in-1" },
    [],
  );

  await until(() => stream.subscribers() === 1);
  // No native start: the execution's lower bound is unknown.
  delta("ses_mario", "a1", "a");
  await until(() => turns.length === 1);
  boundary(stream, "session.execution.failed", 10);
  await until(() => turns[0]?.ended !== undefined);
  lateText(stream, "a2", 5);
  delta("ses_mario", "a2", "late");
  await until(() => turns.length === 2);
  await wait(50);

  expect(text(turns[0])).toBe("a");
  expect(turns[0]?.ended).toBe("failed");
  expect(text(turns[1])).toBe("late");
  expect(turns[1]?.ended).toBeUndefined();
});

// Regression guard: it passes on 59683c3 too.
test("a message forced past the held bound stops counting at once", async () => {
  const { turns, stream, delta, text, collector } = ordered(
    { a1: "in-1", a2: "in-1" },
    ["a1", "a2"],
    { bufferMs: 5000, pendingBytes: 300 },
  );

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a1", "x".repeat(100));
  delta("ses_mario", "a2", "y".repeat(250));
  await until(() => turns.length === 1 && text(turns[0]).includes("y"));

  // Placement released each forced message: nothing stays counted.
  expect(collector.load.heldBytes).toBe(0);
  expect(collector.load.unplaced).toBe(0);
  expect(stream.subscriptions()).toBe(1);
});

test("a forced message left unplaced is let go, and its later frames dropped", async () => {
  const { turns, stream, delta, collector, release } = ordered(
    { a1: "in-1", a2: "in-1" },
    ["a1", "a2"],
    { bufferMs: 5000, pendingBytes: 300 },
  );

  // Break the invariant: a force that places nothing.
  const force: unknown = Reflect.get(collector, "force");
  Reflect.set(collector, "force", () => {});

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a1", "x".repeat(100));
  delta("ses_mario", "a2", "y".repeat(250));
  await until(() => collector.load.unplaced === 2);
  expect(collector.load.heldBytes).toBe(0);

  // Later frames of the let-go messages are dropped, never held uncounted.
  Reflect.set(collector, "force", force);
  delta("ses_mario", "a1", "late");
  delta("ses_mario", "a2", "late");
  release("a1");
  release("a2");
  await until(
    () => collector.load.resolving === 0 && collector.load.lookups === 0,
  );
  await wait(50);

  expect(collector.load.heldBytes).toBe(0);
  expect(collector.load.unplaced).toBe(2);
  expect(turns).toHaveLength(0);
  expect(stream.subscriptions()).toBe(1);
});

// Regression guard: it passes on 59683c3 too.
test("a message placed before its owner is proven never moves or renames its turn", async () => {
  const { turns, stream, delta, text, release, collector } = ordered(
    { a1: "in-1", a2: "in-2" },
    ["a2"],
    { bufferMs: 50 },
  );

  await until(() => stream.subscribers() === 1);
  delta("ses_mario", "a1", "a");
  await until(() => turns[0]?.start.task?.id === "task_1");
  // Unproven past its buffer time: it joins task 1's turn.
  delta("ses_mario", "a2", "b");
  await until(() => text(turns[0]).includes("b"));
  const attributed = structuredClone(turns[0]?.attributed);
  // It then proves to answer task 2.
  release("a2");
  await until(
    () => collector.load.resolving === 0 && collector.load.lookups === 0,
  );

  expect(turns).toHaveLength(1);
  expect(text(turns[0])).toBe("a|b");
  expect(turns[0]?.start.task?.id).toBe("task_1");
  expect(turns[0]?.attributed).toEqual(attributed ?? []);
});

test("a reconnect leaves no interval spanning the gap, and keeps those before it", async () => {
  const { turns, stream, delta, text } = ordered(
    { a1: "in-1", a2: "in-1", c1: "dm-c", b1: "dm-b" },
    [],
  );

  await until(() => stream.subscribers() === 1);
  started(stream, 1);
  delta("ses_mario", "a1", "a");
  await until(() => turns.length === 1);
  boundary(stream, succeeded, 10);
  await until(() => turns[0]?.ended !== undefined);

  // The gap: B runs at 11 to 20 and C starts at 21, all unseen.
  stream.disconnect();
  await until(() => stream.subscriptions() === 2 && stream.subscribers() === 1);

  // C settles at 30 with no witnessed start: no interval is recorded.
  delta("ses_mario", "c1", "c");
  await until(() => turns.length === 2);
  boundary(stream, "session.execution.failed", 30);
  await until(() => turns[1]?.ended !== undefined);

  // B's late message is unprovable: the current execution, no outcome.
  lateText(stream, "b1", 15);
  delta("ses_mario", "b1", "late-b");
  await until(() => turns.length === 3);
  // A's interval, completed before the gap, still holds.
  lateText(stream, "a2", 5);
  delta("ses_mario", "a2", "late-a");
  await until(() => text(turns[0]).includes("late-a"));
  await wait(50);

  expect(text(turns[0])).toBe("a|late-a");
  expect(turns[0]?.ended).toBe("completed");
  expect(text(turns[1])).toBe("c");
  expect(turns[1]?.ended).toBe("failed");
  expect(text(turns[2])).toBe("late-b");
  expect(turns[2]?.ended).toBeUndefined();
});
