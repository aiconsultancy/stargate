import { expect, test } from "bun:test";
import type { SessionLogItem } from "@opencode/client";
import { setImmediate, setTimeout as wait } from "node:timers/promises";
import { Schema } from "effect";
import type { TurnActivityLog } from "../src/backends/backend";
import { ChildExecutions } from "../src/backends/opencode/activity-child-executions";
import {
  type ActivityFamilyEvent,
  type ActivityFamilyReads,
  OpenCodeActivityFamilies,
  isActivityEvent,
} from "../src/backends/opencode/activity-family";
import { configSchema } from "../src/config";
import {
  activityFlushMs,
  createActivityHub,
  readActivity,
  readCrewActivity,
  subscribeActivity,
} from "../src/observability/dashboard/api/v1/activity";
import { bot } from "./fixtures";

const main = "ses_root";
const child = "ses_child";
const grandchild = "ses_grandchild";

function fixture(
  turnsPerAgent?: number,
  logGate?: Promise<void>,
  pending?: number,
  globalTurns?: number,
  readParent?: ActivityFamilyReads["parent"],
  worker?: "crew",
) {
  const stop = new AbortController();

  const hub = createActivityHub({
    ...(turnsPerAgent !== undefined && { turnsPerAgent }),
    ...(globalTurns !== undefined && { turns: globalTurns }),
  });

  const recorder = hub.recorder("officer");
  const crew = worker && hub.crewRecorder("officer");
  crew?.roster?.(["worker"]);
  const parents = new Map<string, string>();
  const reads: string[] = [];
  const active = new Set<string>();
  const logFrames = new Map<string, SessionLogItem[]>();
  const logReads: [string, number][] = [];
  let seq = 0;
  let now = 0;

  const families = new OpenCodeActivityFamilies(
    {
      signal: stop.signal,
      parent: async (id, signal) => {
        reads.push(id);

        return readParent ? readParent(id, signal) : parents.get(id);
      },
      active: async () =>
        Object.fromEntries([...active].map((id) => [id, { type: "running" }])),
      async *log(id, after) {
        logReads.push([id, after]);
        await logGate;
        yield* logFrames.get(id) ?? [];
      },
    },
    pending === undefined ? {} : { pending },
    () => now,
  );

  const root = (scope?: { active: boolean }, id = main) => {
    const log = crew
      ? crew.begin({
          member: "worker",
          project: null,
          session: { id, parent: null },
          task: { id: "task_fixture", inputId: "input_fixture", project: null },
        })
      : recorder.begin(undefined, id);

    families.track(id, log, scope);
    emit(
      "session.text.delta",
      id,
      { assistantMessageID: "answer", ordinal: 0, delta: "root is running" },
      log,
    );

    return log;
  };

  const emit = (
    type: ActivityFamilyEvent["type"],
    sessionID: string,
    data: object = {},
    owner?: TurnActivityLog,
    eventID?: string,
    replaySeq?: number,
  ) => {
    const durable =
      replaySeq ?? (type.startsWith("session.execution.") ? ++seq : undefined);

    seq = Math.max(seq, durable ?? 0);

    const event = {
      id: eventID,
      type,
      data: { sessionID, ...data },
      ...(durable !== undefined && {
        durable: {
          aggregateID: sessionID,
          seq: durable,
          version: 1,
        },
      }),
    } as unknown as ActivityFamilyEvent;

    const order = families.receive(event);

    if (owner && isActivityEvent(event)) {
      families.owned(owner, event, order);
    }
  };

  return {
    stop,
    hub,
    families,
    reads,
    active,
    logFrames,
    logReads,
    parents,
    root,
    emit,
    advance: (ms: number) => {
      now += ms;
    },
    turns: () => hub.turns(worker ? "officer/worker" : "officer")?.turns ?? [],
    settleRoot(log: TurnActivityLog) {
      families.settled(main, log);
      log.end("completed");
    },
    create: (id: string, parentID: string) =>
      emit("session.created", id, { parentID }),
    start: (id: string) => emit("session.execution.started", id),
    end: (id: string) => emit("session.execution.succeeded", id),
    delta: (id: string, delta: string, assistantMessageID = "answer") =>
      emit("session.text.delta", id, {
        assistantMessageID,
        ordinal: 0,
        delta,
      }),
    ended: (id: string, text: string, assistantMessageID: string) =>
      emit(
        "session.text.ended",
        id,
        { assistantMessageID, ordinal: 0, text },
        undefined,
        undefined,
        ++seq,
      ),
    call: (
      owner: TurnActivityLog,
      id: string,
      name = "subagent",
      parent = main,
    ) =>
      emit(
        "session.tool.input.started",
        parent,
        { assistantMessageID: "answer", id, name },
        owner,
      ),
    names: (
      owner: TurnActivityLog,
      id: string,
      sessionID: unknown,
      parent = main,
    ) =>
      emit(
        "session.tool.progress",
        parent,
        { assistantMessageID: "answer", id, metadata: { sessionID } },
        owner,
      ),
    called: (
      owner: TurnActivityLog,
      id: string,
      input: Record<string, unknown>,
    ) =>
      emit(
        "session.tool.called",
        main,
        { assistantMessageID: "answer", id, input, executed: true },
        owner,
      ),
  };
}

test("reconnect inspects all tracked children beyond the first read page", async () => {
  const f = fixture();
  f.root();
  const ids = Array.from({ length: 11 }, (_, index) => `ses_held_${index}`);

  for (const [index, id] of ids.entries()) {
    f.create(id, main);
    f.start(id);
    f.active.add(id);
    f.logFrames.set(id, [
      { type: "log.synced", aggregateID: id, seq: index + 1 },
    ]);
  }

  await f.families.reconnected();
  expect(f.logReads.map(([id]) => id)).toEqual(ids);
  expect(
    f
      .turns()
      .slice(1)
      .map(({ status }) => status),
  ).toEqual(ids.map(() => "running"));
  f.stop.abort();
});

test.each([
  [7, "current"],
  [8, "current"],
  [8, "expired"],
  [8, "fenced"],
] as const)(
  "ancestry reads drain %i busy slots with a %s candidate",
  async (held, mode) => {
    const gate = Promise.withResolvers<void>();
    let active = 0;
    let peak = 0;

    const f = fixture(
      undefined,
      undefined,
      undefined,
      undefined,
      async (id) => {
        active += 1;
        peak = Math.max(peak, active);

        try {
          if (id === child) {
            return main;
          }

          await gate.promise;
        } finally {
          active -= 1;
        }

        return;
      },
    );

    const scope = { active: true };
    const root = f.root(scope);

    try {
      f.create(child, main);
      f.start(child);
      f.ended(child, "first transcript", "first");
      f.end(child);

      const ids = Array.from(
        { length: held },
        (_, index) => `ses_held_${index}`,
      );

      for (const id of ids) {
        f.call(root, id);
        f.names(root, id, id);
      }

      f.call(root, "relaunch");
      f.names(root, "relaunch", child);
      f.start(child);
      f.ended(child, "second transcript", "second");
      f.end(child);
      expect(f.reads).toEqual(held === 8 ? ids : [...ids, child]);

      if (mode === "expired") {
        f.advance(2001);
      } else if (mode === "fenced") {
        f.families.fence(main, scope);
      }

      gate.resolve();
      await setImmediate();
      expect(peak).toBe(8);
      expect(f.reads).toEqual(mode === "current" ? [...ids, child] : ids);

      const turns = f.turns();
      expect(turns[1]).toMatchObject({
        status: "completed",
        items: [{ text: "first transcript" }],
      });

      if (mode === "current") {
        expect(turns[2]).toMatchObject({
          session: {
            id: child,
            parent: { turnId: turns[0]?.id, callId: "relaunch" },
          },
          status: "completed",
          items: [{ text: "second transcript" }],
        });
      } else {
        expect(turns).toHaveLength(2);
      }
    } finally {
      gate.resolve();
      f.stop.abort();
    }
  },
);

test("reclassifying a child or fencing its peer marks its outcome lost", () => {
  for (const change of ["peer", "fence"]) {
    const f = fixture();
    const scope = { active: true };
    f.root(scope);
    f.create(child, main);
    f.start(child);

    if (change === "peer") {
      f.families.peer(child);
    } else {
      f.families.fence(main, scope);
    }

    expect(f.turns()[1]).toMatchObject({ status: "cancelled", lost: true });
    f.stop.abort();
  }
});

test("replays child frames after parent proof, in arrival order", async () => {
  const f = fixture();
  const root = f.root();
  f.parents.set(child, main);
  f.call(root, "launch");
  f.start(child);
  f.delta(child, "first");
  f.delta(child, " second");
  f.end(child);
  expect(f.turns()).toHaveLength(1);

  // Creation was missed. Only the already-owned native tool permits a read.
  f.settleRoot(root);
  f.names(root, "launch", child);
  await Promise.resolve();

  const [parent, observed] = f.turns();
  expect(f.reads).toEqual([child]);
  expect(observed).toMatchObject({
    session: { id: child, parent: { turnId: parent?.id, callId: "launch" } },
    requests: [],
    status: "completed",
    items: [{ kind: "text", text: "first second" }],
  });
  f.stop.abort();
});

test("an unrecoverable early frame leaves a visible child item", () => {
  const f = fixture();
  f.root();
  f.delta(child, "x".repeat(300_000));
  f.create(child, main);
  f.ended(child, "later output", "answer");
  expect(f.turns()[1]).toMatchObject({
    items: [
      { kind: "text", unavailable: ["activity.frames"] },
      { kind: "text", text: "later output" },
    ],
  });
  f.stop.abort();
});

test("a payload-oversized start still fences queued output from the old child", async () => {
  const gate = Promise.withResolvers<void>();
  const f = fixture(undefined, gate.promise);
  f.root();
  f.start(child);
  f.ended(child, "x".repeat(300_000), "old");
  f.create(child, main);
  expect(f.logReads).toHaveLength(1);

  // The log cannot recover this start. The live boundary itself must survive.
  f.emit("session.execution.started", child, { extra: "x".repeat(300_000) });
  f.ended(child, "not the old child's output", "new");
  gate.resolve();
  await f.families.reconnected();
  expect(f.turns()[1]).toMatchObject({
    status: "cancelled",
    lost: true,
    items: [{ unavailable: ["activity.frames"] }],
  });
  expect(f.turns()).toHaveLength(2);
  f.stop.abort();
});

test("a relaunch keeps its parent's naming proof while recovery is paused", async () => {
  const gate = Promise.withResolvers<void>();
  const f = fixture(undefined, gate.promise);
  const old = f.root();
  f.start(child);
  f.ended(child, "x".repeat(300_000), "old");
  f.create(child, main);
  expect(f.logReads).toHaveLength(1);
  f.end(child);
  f.settleRoot(old);

  const next = f.root();
  f.call(next, "relaunch");
  f.start(child);
  f.names(next, "relaunch", child);
  f.ended(child, "new execution", "new");
  f.end(child);
  gate.resolve();
  await f.families.reconnected();

  const [, previous, nextRoot, relaunched] = f.turns();
  expect(previous).toMatchObject({
    status: "completed",
    items: [{ unavailable: ["activity.frames"] }],
  });
  expect(relaunched).toMatchObject({
    session: { parent: { turnId: nextRoot?.id, callId: "relaunch" } },
    status: "completed",
    items: [{ text: "new execution" }],
  });
  f.stop.abort();
});

test("two relaunches bind delayed proof to their own starts during paused recovery", async () => {
  const gate = Promise.withResolvers<void>();
  const f = fixture(undefined, gate.promise);
  const old = f.root();
  f.start(child);
  f.ended(child, "x".repeat(300_000), "lost");
  f.create(child, main);
  expect(f.logReads).toHaveLength(1);
  f.end(child);
  f.settleRoot(old);

  const first = f.root();
  f.call(first, "first");
  f.start(child);
  f.ended(child, "first one", "a");
  f.ended(child, "first two", "b");
  f.end(child);
  f.settleRoot(first);

  const second = f.root();
  f.call(second, "second");
  f.start(child);
  f.names(second, "second", child);
  f.names(first, "first", child);
  f.ended(child, "second one", "c");
  f.ended(child, "second two", "d");
  f.end(child);
  gate.resolve();
  await f.families.reconnected();

  const [, original, firstRoot, secondRoot, firstChild, secondChild] =
    f.turns();

  expect(original?.items).toMatchObject([{ unavailable: ["activity.frames"] }]);
  expect(firstChild).toMatchObject({
    session: { parent: { turnId: firstRoot?.id, callId: "first" } },
    status: "completed",
    items: [{ text: "first one" }, { text: "first two" }],
  });
  expect(secondChild).toMatchObject({
    session: { parent: { turnId: secondRoot?.id, callId: "second" } },
    status: "completed",
    items: [{ text: "second one" }, { text: "second two" }],
  });
  f.stop.abort();
});

test("an expired naming proof still makes an overlapping relaunch ambiguous", async () => {
  const f = fixture();
  const root = f.root();
  f.parents.set(child, main);
  f.create(child, main);
  f.start(child);
  f.end(child);
  f.call(root, "expired");
  f.names(root, "expired", child);
  f.ended(child, "not a new execution", "unowned");
  await Promise.resolve();
  expect(f.turns()).toHaveLength(2);
  f.settleRoot(root);

  f.advance(2001);
  const next = f.root();
  f.call(next, "fresh");
  f.names(next, "fresh", child);
  f.start(child);
  f.ended(child, "new execution", "new");
  await Promise.resolve();
  expect(f.turns()[3]).toMatchObject({
    session: { parent: null },
    items: [{ text: "new execution" }],
  });
  f.stop.abort();
});

test("discarded relaunch proof cannot poison the same child after its peer is fenced", async () => {
  const f = fixture();

  try {
    const scope = { active: true };
    const old = f.root(scope);
    f.parents.set(child, main);
    f.create(child, main);
    f.start(child);
    f.end(child);
    f.call(old, "expired");
    f.names(old, "expired", child);
    f.settleRoot(old);
    await Promise.resolve();

    f.advance(2001);
    // Force the expired hint into discarded overflow before the fence.
    f.emit("session.created", "ses_unrelated");
    f.families.fence(main, scope);

    const next = f.root({ active: true });
    f.call(next, "fresh");
    f.names(next, "fresh", child);
    f.start(child);
    f.ended(child, "reused transcript", "new");
    await Promise.resolve();

    const [, , parent, result] = f.turns();
    expect(result).toMatchObject({
      session: { id: child, parent: { turnId: parent?.id, callId: "fresh" } },
      items: [{ text: "reused transcript" }],
    });
  } finally {
    f.stop.abort();
  }
});

test("name saturation does not charge standalone root quota for unattributed children", () => {
  const ids = Array.from({ length: 17 }, (_, index) => `ses_result_${index}`);
  const buckets = new Set(ids.map((id) => Bun.hash(id, 0n) % 512n));

  for (const globalTurns of [256, 18]) {
    for (const saturated of [false, true]) {
      const f = fixture(16, undefined, undefined, globalTurns);

      try {
        const sentinel = f.root(undefined, "ses_sentinel");
        sentinel.end("completed");
        const root = f.root({ active: true });

        if (saturated) {
          // Keep dropped queue proofs out of the result IDs' buckets: this
          // Exercises the full exact-name index and its saturation range.
          for (let i = 0, names = 0; names <= 512; i += 1) {
            const id = `ses_fill_${i}`;

            if (!buckets.has(Bun.hash(id, 0n) % 512n)) {
              names += 1;
              f.call(root, id);
              f.names(root, id, id);
            }
          }
        }

        for (const id of ids) {
          f.call(root, id);
          f.names(root, id, id);
          f.create(id, main);
          f.start(id);
          f.ended(id, `answer from ${id}`, "child-answer");
          f.end(id);
        }

        f.settleRoot(root);

        const turns = f.turns();
        const sessionIds = turns.map((turn) => turn.session?.id);

        if (globalTurns === 256) {
          expect(sessionIds).toEqual(["ses_sentinel", main, ...ids]);
        } else {
          expect(sessionIds).not.toContain("ses_sentinel");
          expect(turns).toHaveLength(18);
        }

        const rootId = turns.find(({ session }) => session?.id === main)?.id;

        for (const id of ids) {
          expect(turns.find(({ session }) => session?.id === id)).toMatchObject(
            {
              items: [{ text: `answer from ${id}` }],
              session: {
                parent: saturated ? null : { turnId: rootId, callId: id },
              },
            },
          );
        }
      } finally {
        f.stop.abort();
      }
    }
  }
});

test("discarded witnessed starts free the exact names of expired launch hints", () => {
  const f = fixture();
  const bucket = Bun.hash(child, 0n) % 512n;

  try {
    const scope = { active: true };
    const root = f.root(scope);
    const spent: string[] = [];

    for (let i = 0; spent.length < 512; i += 1) {
      const id = `ses_spent_${i}`;

      if (Bun.hash(id, 0n) % 512n !== bucket) {
        spent.push(id);
        f.call(root, id);
        f.names(root, id, id);
      }
    }

    f.settleRoot(root);
    f.advance(2001);

    for (const id of spent) {
      // We saw the start, but never learned the parent; no turn was admitted.
      f.start(id);
    }

    f.advance(2001);
    const next = f.root(scope);
    f.call(next, "fresh");
    f.names(next, "fresh", child);
    // A second distinct name exposes saturation even though a proof does
    // Not compete with its own order.
    f.call(next, "unrelated");
    f.names(next, "unrelated", "ses_unrelated");
    f.create(child, main);
    f.start(child);
    f.ended(child, "next transcript", "answer");

    const [, parent, result] = f.turns();
    expect(result).toMatchObject({
      session: { id: child, parent: { turnId: parent?.id, callId: "fresh" } },
      items: [{ text: "next transcript" }],
    });
  } finally {
    f.stop.abort();
  }
});

test.each(["expiry", "eviction"] as const)(
  "an unnamed call still competes after %s with only one naming hint left",
  async (loss) => {
    const f = fixture(
      undefined,
      undefined,
      loss === "eviction" ? 1 : undefined,
    );

    const root = f.root();
    f.parents.set(child, main);
    f.call(root, "competing");

    if (loss === "expiry") {
      f.advance(2001);
    }

    f.call(root, "surviving");
    f.start(child);
    f.names(root, "surviving", child);
    await Promise.resolve();
    f.names(root, "competing", child);
    f.ended(child, "unattributed", "answer");
    f.end(child);
    expect(f.turns()[1]).toMatchObject({
      session: { id: child, parent: null },
      items: [{ text: "unattributed" }],
    });
    f.stop.abort();
  },
);

test.each(["retained", "evicted"] as const)(
  "settlement preserves %s launch ambiguity until a witnessed start",
  async (mode) => {
    const f = fixture(undefined, undefined, mode === "evicted" ? 1 : undefined);
    const first = f.root();
    f.call(first, "older");
    f.call(first, "newer");
    f.settleRoot(first);

    const second = f.root();
    f.parents.set(child, main);
    f.call(second, "next");
    f.names(second, "next", child);
    f.start(child);
    f.ended(child, "visible without a link", "answer");
    f.end(child);
    await Promise.resolve();

    expect(f.turns()[2]).toMatchObject({
      session: { id: child, parent: null },
      status: "completed",
      items: [{ text: "visible without a link" }],
    });

    f.call(second, "after-start");
    f.names(second, "after-start", child);
    f.start(child);
    f.ended(child, "a new execution", "later");
    f.end(child);
    await Promise.resolve();

    const [, parent, , later] = f.turns();
    expect(later).toMatchObject({
      session: {
        id: child,
        parent: { turnId: parent?.id, callId: "after-start" },
      },
      items: [{ text: "a new execution" }],
    });
    f.stop.abort();
  },
);

test("an evicted named call does not compete for a different child", async () => {
  const f = fixture(undefined, undefined, 1);
  const root = f.root();
  f.parents.set(child, main);
  f.call(root, "first");
  f.names(root, "first", child);
  f.start(child);
  f.end(child);
  await Promise.resolve();
  expect(f.turns()[1]?.session?.parent?.callId).toBe("first");

  f.parents.set(grandchild, main);
  f.call(root, "second");
  f.names(root, "second", grandchild);
  f.start(grandchild);
  f.ended(grandchild, "unique child output", "answer");
  f.end(grandchild);
  await Promise.resolve();

  const [parent, , observed] = f.turns();
  expect(observed).toMatchObject({
    session: {
      id: grandchild,
      parent: { turnId: parent?.id, callId: "second" },
    },
    status: "completed",
    items: [{ text: "unique child output" }],
  });
  f.stop.abort();
});

test("fenced launch evidence does not compete in a new peer incarnation", async () => {
  const f = fixture(undefined, undefined, 1);
  const scope = { active: true };
  const old = f.root(scope);
  f.call(old, "older");
  f.call(old, "newer");
  f.settleRoot(old);
  f.families.fence(main, scope);

  const current = f.root({ active: true });
  f.parents.set(child, main);
  f.call(current, "current");
  f.names(current, "current", child);
  f.start(child);
  await Promise.resolve();

  const [, parent, observed] = f.turns();
  expect(observed?.session?.parent).toMatchObject({
    turnId: parent?.id,
    callId: "current",
  });
  f.stop.abort();
});

test("call capacity across parents preserves unresolved evidence in overflow", async () => {
  const f = fixture(undefined, undefined, 1);
  const old = f.root();
  f.call(old, "older");
  f.settleRoot(old);

  // Churn both exact parent slots and exact eviction ranges.
  for (let index = 0; index < 10; index++) {
    const id = `ses_other_${index}`;
    const root = f.root(undefined, id);
    f.call(root, "other", "subagent", id);
  }

  const current = f.root();
  f.parents.set(child, main);
  f.call(current, "current");
  f.names(current, "current", child);
  f.start(child);
  f.ended(child, "visible after overflow", "answer");
  f.end(child);
  await Promise.resolve();

  expect(f.turns().at(-1)).toMatchObject({
    session: { id: child, parent: null },
    items: [{ text: "visible after overflow" }],
  });
  f.stop.abort();
});

test.each([
  [512, grandchild, true],
  [513, grandchild, true],
  [513, main, false],
] as const)(
  "after %i names from %s, a reused child's link is proven: %p",
  async (count, nativeParent, linked) => {
    const f = fixture();
    const root = f.root({ active: true });

    try {
      f.parents.set(child, main);
      f.call(root, "first");
      f.names(root, "first", child);
      f.start(child);
      f.end(child);
      await Promise.resolve();
      expect(f.turns()[1]?.session?.parent?.callId).toBe("first");

      f.create(grandchild, main);
      f.start(grandchild);

      if (nativeParent !== main) {
        f.call(root, "relaunch");
      }

      for (let index = 0; index < count; index++) {
        const id = `noise-${index}`;
        const owner = nativeParent === main ? root : undefined;

        f.emit(
          "session.tool.input.started",
          nativeParent,
          {
            assistantMessageID: "answer",
            id,
            name: "subagent",
          },
          owner,
        );
        f.emit(
          "session.tool.progress",
          nativeParent,
          {
            assistantMessageID: "answer",
            id,
            metadata: { sessionID: `ses_noise_${index}` },
          },
          owner,
        );
      }

      await setImmediate();

      if (nativeParent === main) {
        // Keep this exact call open rather than overflowing the per-log call slots.
        f.call(root, "relaunch");
      }

      f.names(root, "relaunch", child);
      f.start(child);
      f.ended(child, "relaunch output", "relaunch-answer");
      f.end(child);
      await Promise.resolve();

      const turns = f.turns();
      const executions = turns.filter((turn) => turn.session?.id === child);
      expect(executions).toHaveLength(2);
      expect(executions[1]).toMatchObject({
        session: {
          id: child,
          parent: linked ? { turnId: turns[0]?.id, callId: "relaunch" } : null,
        },
        status: "completed",
        items: [{ text: "relaunch output" }],
      });
    } finally {
      f.stop.abort();
    }
  },
);

test.each(["live", "paused recovery"] as const)(
  "a call opened before the previous terminal names the next start during %s",
  async (mode) => {
    const gate = Promise.withResolvers<void>();
    const paused = mode === "paused recovery";
    const f = fixture(undefined, paused ? gate.promise : undefined);
    const root = f.root();
    f.parents.set(child, main);
    f.start(child);

    if (paused) {
      f.ended(child, "x".repeat(300_000), "original");
    }

    f.create(child, main);
    expect(f.logReads).toHaveLength(paused ? 1 : 0);
    f.call(root, "next");
    f.names(root, "next", child);
    f.end(child);
    f.start(child);
    f.ended(child, "next output", "next");
    f.end(child);
    gate.resolve();
    await f.families.reconnected();

    expect(f.turns()[2]).toMatchObject({
      session: { parent: { callId: "next" } },
      status: "completed",
      items: [{ text: "next output" }],
    });
    f.stop.abort();
  },
);

test("parallel calls naming the same start preserve an unattributed transcript", async () => {
  const f = fixture();
  const first = f.root();
  const second = f.root();
  f.parents.set(child, main);
  f.call(first, "first");
  f.call(second, "second");
  f.names(second, "second", child);
  f.names(first, "first", child);
  f.start(child);
  f.ended(child, "unattributed output", "unattributed");
  f.end(child);
  await Promise.resolve();
  expect(f.turns()[2]).toMatchObject({
    session: { id: child, parent: null },
    status: "completed",
    items: [{ text: "unattributed output" }],
  });

  f.call(second, "fresh");
  f.names(second, "fresh", child);
  f.start(child);
  f.ended(child, "attributed output", "attributed");
  await Promise.resolve();
  expect(f.turns()[3]).toMatchObject({
    session: { parent: { turnId: f.turns()[1]?.id, callId: "fresh" } },
    items: [{ text: "attributed output" }],
  });
  f.stop.abort();
});

test("a slow competing name cannot retroactively attach an ambiguous start", async () => {
  const f = fixture();
  const first = f.root();
  const second = f.root();
  f.parents.set(child, main);
  f.call(first, "first");
  f.call(second, "second");
  f.start(child);
  f.names(first, "first", child);
  await Promise.resolve();
  f.ended(child, "first output", "a");
  f.names(second, "second", child);
  f.ended(child, "second output", "b");
  f.end(child);
  expect(f.turns()[2]).toMatchObject({
    session: { id: child, parent: null },
    items: [{ text: "first output" }, { text: "second output" }],
  });
  f.stop.abort();
});

test("among parallel calls only the native parent may name the child", async () => {
  const f = fixture();
  const foreign = f.root(undefined, grandchild);
  const native = f.root();
  f.parents.set(child, main);
  f.call(foreign, "foreign", "subagent", grandchild);
  f.call(native, "native");
  f.names(foreign, "foreign", child, grandchild);
  f.names(native, "native", child);
  f.start(child);
  f.ended(child, "native output", "native");
  await Promise.resolve();
  expect(f.turns()[2]).toMatchObject({
    session: { parent: { turnId: f.turns()[1]?.id, callId: "native" } },
    items: [{ text: "native output" }],
  });
  f.stop.abort();
});

test("overflowing lifecycle slots invalidates ownership until a fresh start", async () => {
  const gate = Promise.withResolvers<void>();
  const f = fixture(undefined, gate.promise);
  const root = f.root();
  f.parents.set(child, main);
  f.start(child);
  f.ended(child, "x".repeat(300_000), "old");
  f.create(child, main);

  for (let index = 0; index < 65; index += 1) {
    f.start(child);
  }

  f.ended(child, "unprovable", "new");
  gate.resolve();
  await f.families.reconnected();
  f.ended(child, "still unprovable", "new");
  expect(f.turns()[1]).toMatchObject({
    status: "cancelled",
    lost: true,
    items: [{ unavailable: ["activity.frames"] }],
  });
  expect(f.turns()).toHaveLength(2);

  f.call(root, "fresh");
  f.names(root, "fresh", child);
  await Promise.resolve();
  f.start(child);
  f.ended(child, "fresh output", "new");
  expect(f.turns()[2]).toMatchObject({ items: [{ text: "fresh output" }] });
  f.stop.abort();
});

test("a failed content read keeps held text and a witnessed child outcome", async () => {
  const gate = Promise.withResolvers<void>();
  const f = fixture(undefined, gate.promise);
  f.root();
  f.start(child);
  f.ended(child, "x".repeat(300_000), "old");
  f.create(child, main);
  expect(f.logReads).toHaveLength(1);
  f.ended(child, "queued output", "new");
  f.end(child);
  gate.reject(new Error("fixture read failed"));
  await f.families.reconnected();
  const turn = f.turns()[1];

  expect(turn).toMatchObject({
    status: "completed",
    items: [{ unavailable: ["activity.frames"] }, { text: "queued output" }],
  });
  expect(turn?.lost).toBeUndefined();
  f.stop.abort();
});

test("fills a child call ID only from the owning turn", () => {
  const f = fixture();
  const root = f.root();
  f.call(root, "launch");
  f.call(root, "not-subagent", "shell");
  f.create(child, main);
  f.start(child);
  const other = f.root();
  const link = () => f.turns()[1]?.session?.parent?.callId;
  f.call(other, "other");
  f.names(other, "other", child);
  f.names(root, "not-subagent", child);
  f.names(root, "launch", { session: child });
  expect(link()).toBeNull();

  f.names(root, "launch", child);
  expect(link()).toBe("launch");
  f.stop.abort();
});

test("admits a grandchild only after its parent and rejects foreign sessions", () => {
  const f = fixture();
  f.root();
  f.start(child);
  f.create(grandchild, child);
  f.start(grandchild);
  f.delta(grandchild, "nested");
  f.create("ses_foreign", "ses_untracked");
  f.start("ses_foreign");
  f.create("ses_self", "ses_self");
  f.start("ses_self");
  expect(f.turns()).toHaveLength(1);

  f.create(child, main);
  const [root, parent, nested] = f.turns();
  expect(f.turns()).toHaveLength(3);
  expect(parent?.session).toMatchObject({
    id: child,
    parent: { turnId: root?.id, callId: null },
  });
  expect(nested).toMatchObject({
    session: { id: grandchild, parent: { turnId: parent?.id, callId: null } },
    items: [{ kind: "text", text: "nested" }],
  });
  f.stop.abort();
});

test("keeps the running child and leaves the next start unlinked when two calls fit", async () => {
  const f = fixture();
  f.parents.set(child, main);
  const root = f.root();
  f.call(root, "first");
  f.create(child, main);
  f.names(root, "first", child);
  f.start(child);
  f.settleRoot(root);
  const later = f.root();
  f.call(later, "joined");
  f.names(later, "joined", child);
  f.delta(child, "still first");
  f.end(child);
  f.call(later, "new-period");
  f.names(later, "new-period", child);
  f.start(child);
  f.ended(child, "new output", "new-answer");
  await Promise.resolve();

  const [firstRoot, first, , next] = f.turns();
  expect(first).toMatchObject({
    session: { parent: { turnId: firstRoot?.id, callId: "first" } },
    items: [{ text: "still first" }],
  });
  expect(next).toMatchObject({
    session: { parent: null },
    items: [{ text: "new output" }],
  });
  f.stop.abort();
});

test("routes late child deltas to their own execution and deduplicates native event IDs", async () => {
  const f = fixture();
  const first = f.root();
  f.parents.set(child, main);
  f.call(first, "first");
  f.create(child, main);
  f.names(first, "first", child);
  f.start(child);

  const delta = (assistantMessageID: string, eventID: string, delta: string) =>
    f.emit(
      "session.text.delta",
      child,
      { assistantMessageID, ordinal: 0, delta },
      undefined,
      eventID,
    );

  delta("old", "evt_original", "old");
  delta("old", "evt_original", "old");
  f.end(child);
  f.settleRoot(first);

  const next = f.root();
  f.call(next, "next");
  f.names(next, "next", child);
  f.start(child);
  await Promise.resolve();
  f.ended(child, "new", "new");
  delta("old", "evt_old_late", " late");
  delta("old", "evt_old_late", " late");
  // Equal payloads from different native event IDs are not duplicate events.
  delta("old", "evt_old_distinct", " late");

  const [firstRoot, oldChild, nextRoot, newChild] = f.turns();
  expect(oldChild).toMatchObject({
    session: { parent: { turnId: firstRoot?.id, callId: "first" } },
    items: [{ text: "old late late" }],
    status: "completed",
  });
  expect(newChild).toMatchObject({
    session: { parent: { turnId: nextRoot?.id, callId: "next" } },
    items: [{ text: "new" }],
  });
  f.stop.abort();
});

test("settling a child keeps only a short exact window for late delta IDs", () => {
  const f = fixture();
  f.root();
  f.create(child, main);
  f.start(child);

  const id = (index: number) =>
    `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`;

  const delta = (eventID: string, text: string) =>
    f.emit(
      "session.text.delta",
      child,
      { assistantMessageID: "answer", ordinal: 0, delta: text },
      undefined,
      eventID,
    );

  for (let index = 0; index < 65; index += 1) {
    delta(id(index), "a");
  }

  f.end(child);
  delta(id(64), "duplicate");
  delta(`${id(64)}\n`, " distinct");
  delta(id(0), " expired");
  delta("x".repeat(1025), " oversized ID");
  expect(f.turns()[1]).toMatchObject({
    items: [{ text: `${"a".repeat(65)} distinct expired oversized ID` }],
  });
  f.stop.abort();
});

test("a completed child cursor outlives candidate expiry and reconnect", async () => {
  const f = fixture();
  const first = f.root();
  f.parents.set(child, main);
  f.create(child, main);
  f.start(child);
  f.delta(child, "one");
  f.end(child);
  f.settleRoot(first);

  // Churn the bounded wait list before expiring it, without evicting the family.
  for (let index = 0; index <= 128; index += 1) {
    f.start(`ses_unproven_${index}`);
  }

  f.advance(3000);
  await f.families.reconnected();

  const next = f.root();
  f.call(next, "next");
  f.names(next, "next", child);
  f.emit("session.execution.started", child, {}, undefined, undefined, 1);
  f.emit("session.text.delta", child, {
    assistantMessageID: "new",
    ordinal: 0,
    delta: "not yet",
  });
  await Promise.resolve();
  expect(f.turns()).toHaveLength(3);

  f.start(child);
  f.ended(child, "two", "new");
  expect(f.turns()[3]).toMatchObject({ items: [{ text: "two" }] });
  f.stop.abort();
});

test("reconnect cannot readmit a start discarded before parent proof", async () => {
  const f = fixture();
  const old = f.root();
  f.start(child);
  f.settleRoot(old);
  await f.families.reconnected();

  const next = f.root();
  f.parents.set(child, main);
  f.call(next, "next");
  f.names(next, "next", child);
  await Promise.resolve();
  f.emit("session.execution.started", child, {}, undefined, undefined, 1);
  f.ended(child, "old late output", "old-assistant");
  expect(f.turns()).toHaveLength(2);

  f.start(child);
  f.delta(child, "stale output without an admitted prior writer", "unseen-old");
  f.ended(child, "new", "new-assistant");
  expect(f.turns()[2]).toMatchObject({ items: [{ text: "new" }] });
  f.stop.abort();
});

test("a running root keeps all 513 children until oversize-first family eviction", async () => {
  const f = fixture();
  const sentinel = f.root();
  f.settleRoot(sentinel);
  const sentinelID = f.turns()[0]?.id ?? "missing sentinel";
  const root = f.root();
  const rootID = f.turns()[1]?.id;

  const children = Array.from(
    { length: 513 },
    (_, index) => `ses_bulk_${index}`,
  );

  const first = "ses_bulk_0";

  try {
    for (const [index, id] of children.entries()) {
      f.create(id, main);
      f.start(id);
      f.delta(id, `live ${index}`, "old-assistant");
      f.delta(id, " complete", "old-assistant");
      f.end(id);
    }

    const turns = f.turns();
    expect(turns).toHaveLength(515);
    expect(turns[1]?.status).toBe("running");

    for (const [index, id] of children.entries()) {
      expect(turns[index + 2]).toMatchObject({
        session: { id, parent: { turnId: rootID } },
        status: "completed",
        items: [{ text: `live ${index} complete` }],
      });
    }

    f.settleRoot(root);
    expect(f.turns().map(({ id }) => id)).toEqual([sentinelID]);

    const next = f.root();
    f.parents.set(first, main);
    f.call(next, "next");
    f.names(next, "next", first);
    f.start(first);
    await setImmediate();

    f.delta(first, "late compacted output", "old-assistant");
    f.emit(
      "session.text.ended",
      first,
      {
        assistantMessageID: "old-unseen",
        ordinal: 0,
        text: "late durable output",
      },
      undefined,
      undefined,
      2,
    );
    expect(f.turns()[2]).toMatchObject({ session: { id: first }, items: [] });

    f.emit(
      "session.text.started",
      first,
      { assistantMessageID: "fresh", ordinal: 0 },
      undefined,
      undefined,
      1600,
    );
    f.delta(first, "new live output", "fresh");
    expect(f.turns()[2]).toMatchObject({
      items: [{ text: "new live output" }],
    });
    f.end(first);
  } finally {
    f.stop.abort();
  }
});

test.each([512, 513])(
  "an evicted family of %i children cannot spend a new call on durable replay",
  async (count) => {
    const f = fixture();

    try {
      const firstRoot = f.root();

      for (let index = 0; index < count; index += 1) {
        const id = `ses_old_${index}`;
        f.create(id, main);
        f.start(id);
        f.ended(id, `old-${index}`, `old-id-${index}`);
        f.end(id);
      }

      f.settleRoot(firstRoot);
      expect(f.turns()).toHaveLength(0);
      await f.families.reconnected();

      const id = "ses_old_0";
      const root = f.root();
      const parent = f.turns()[0]?.id;
      f.parents.set(id, main);
      f.call(root, "new");
      f.names(root, "new", id);
      await setImmediate();

      f.emit("session.execution.started", id, {}, undefined, undefined, 1);
      f.emit(
        "session.text.ended",
        id,
        { assistantMessageID: "old-id-0", ordinal: 0, text: "old-0" },
        undefined,
        undefined,
        2,
      );
      f.emit("session.execution.succeeded", id, {}, undefined, undefined, 3);
      const afterReplay = f.turns().slice(1);

      // Native sequence numbers are per session, not system-wide.
      f.emit("session.execution.started", id, {}, undefined, undefined, 4);
      f.emit("session.execution.succeeded", id, {}, undefined, undefined, 3);
      f.emit(
        "session.text.started",
        id,
        { assistantMessageID: "new-id", ordinal: 0 },
        undefined,
        undefined,
        5,
      );
      f.delta(id, "new transcript", "new-id");
      const live = f.turns().at(-1)?.items;
      f.emit("session.execution.succeeded", id, {}, undefined, undefined, 6);
      await setImmediate();

      expect({ afterReplay, live, children: f.turns().slice(1) }).toMatchObject(
        {
          afterReplay: [],
          live: [{ text: "new transcript" }],
          children: [
            {
              session: { id, parent: { turnId: parent, callId: "new" } },
              status: "completed",
              items: [{ text: "new transcript" }],
            },
          ],
        },
      );
    } finally {
      f.stop.abort();
    }
  },
);

function evictChildren(f: ReturnType<typeof fixture>, count: number) {
  const root = f.root();

  for (let index = 0; index < count; index += 1) {
    const id = `ses_old_${index}`;
    f.create(id, main);
    f.start(id);
    f.ended(id, `old-${index}`, `old-id-${index}`);
    f.end(id);
  }

  f.settleRoot(root);
  expect(f.turns()).toHaveLength(0);
}

test("brand-new child sessions can still start at 1 after 5,000 evictions", async () => {
  const f = fixture();

  try {
    evictChildren(f, 5000);
    const root = f.root();
    const named = "ses_named_new";
    const created = "ses_created_new";
    f.parents.set(named, main);
    f.call(root, "brand-new");
    f.called(root, "brand-new", { agent: "explore", prompt: "fixture" });
    f.names(root, "brand-new", named);
    f.create(created, main);

    for (const id of [created, named]) {
      f.emit("session.execution.started", id, {}, undefined, undefined, 1);
      f.delta(id, `new ${id}`);
      f.emit("session.execution.succeeded", id, {}, undefined, undefined, 2);
    }

    await setImmediate();
    expect(f.logReads).toEqual([]);
    expect(f.turns().slice(1)).toMatchObject([
      {
        session: { id: created },
        status: "completed",
        items: [{ text: `new ${created}` }],
      },
      {
        session: { id: named, parent: { callId: "brand-new" } },
        status: "completed",
        items: [{ text: `new ${named}` }],
      },
    ]);
  } finally {
    f.stop.abort();
  }
});

test.each(["officer", "crew"] as const)(
  "%s Fleet activity shows unproven frames detached until a native checkpoint proves a later start",
  async (subject) => {
    const f = fixture(
      undefined,
      undefined,
      1,
      1,
      undefined,
      subject === "crew" ? "crew" : undefined,
    );

    const config = Schema.decodeUnknownSync(configSchema)({
      bots: [bot("officer")],
    });

    const query = new URLSearchParams(
      subject === "crew" ? "crew=officer/worker" : "agent=officer",
    );

    const read = () =>
      subject === "crew"
        ? readCrewActivity(
            f.hub,
            config,
            "officer",
            "worker",
            new URLSearchParams(),
          )
        : readActivity(f.hub, config, "officer", new URLSearchParams());

    const readTurns = () => {
      const result = read();

      if (result.status !== 200 || !("turns" in result.body)) {
        throw new Error(`Unexpected activity status ${result.status}`);
      }

      return result.body.turns;
    };

    // With one pending slot, four exact retired entries and 32 compacted positions fit.
    evictChildren(f, 37);
    const subscription = subscribeActivity(f.hub, config, query);

    if (subscription.status !== 200) {
      throw new Error(`Unexpected subscription status ${subscription.status}`);
    }

    const decoder = new TextDecoder();
    let stream = "";

    const unwatch = subscription.watch((bytes) => {
      stream += decoder.decode(bytes);
    });

    try {
      const id = "ses_old_0";
      const root = f.root({ active: true });
      const parent = f.turns()[0]?.id;
      f.parents.set(id, main);
      f.logFrames.set(id, [{ type: "log.synced", aggregateID: id, seq: 3 }]);
      f.call(root, "resume");
      f.called(root, "resume", { agent: "explore", sessionID: id });
      f.names(root, "resume", id);
      await setImmediate();

      f.emit("session.execution.started", id, {}, undefined, undefined, 1);
      f.emit(
        "session.text.ended",
        id,
        { assistantMessageID: "old-id-0", ordinal: 0, text: "old-0" },
        undefined,
        undefined,
        2,
      );
      f.emit("session.execution.succeeded", id, {}, undefined, undefined, 3);
      await setImmediate();

      const [marked, uncertain] = readTurns();
      expect({ marked, logReads: f.logReads }).toMatchObject({
        marked: {
          items: [
            { callId: "resume", unavailable: ["activity.child-attribution"] },
          ],
        },
        logReads: [[id, Number.MAX_SAFE_INTEGER]],
      });
      expect(uncertain).toMatchObject({
        session: { id, parent: null },
        requests: [],
        ...(subject === "crew" && { task: null }),
        status: "cancelled",
        lost: true,
        items: [{ text: "old-0" }],
      });
      await wait(activityFlushMs * 2);
      expect(stream).toContain('"unavailable":["activity.child-attribution"]');
      expect(stream).toContain('"text":"old-0"');
      expect(stream).toContain('"lost":true');
      stream = "";

      f.emit("session.execution.started", id, {}, undefined, undefined, 4);
      f.emit(
        "session.text.ended",
        id,
        { assistantMessageID: "fresh", ordinal: 0, text: "new transcript" },
        undefined,
        undefined,
        5,
      );
      f.emit("session.execution.succeeded", id, {}, undefined, undefined, 6);

      const [cleared, detached, fresh] = readTurns();
      expect(cleared?.items[0]).toMatchObject({ callId: "resume" });
      expect(cleared?.items[0]).not.toHaveProperty("unavailable");
      expect(detached?.id).toBe(uncertain?.id);
      expect(fresh).toMatchObject({
        session: { id, parent: { turnId: parent, callId: "resume" } },
        status: "completed",
        items: [{ text: "new transcript" }],
      });
      await wait(activityFlushMs * 2);
      expect(stream).toContain('"callId":"resume"');
      expect(stream).toContain('"text":"new transcript"');
      expect(stream).not.toContain(
        '"unavailable":["activity.child-attribution"]',
      );
      expect(stream).not.toContain("old-0");
    } finally {
      unwatch();
      f.stop.abort();
    }
  },
);

test("family eviction replaces child writer associations with tombstones immediately", () => {
  const hub = createActivityHub({ turnsPerAgent: 1 });
  const recorder = hub.recorder("officer");
  const parent = recorder.begin();
  const log = parent.child?.(null, child);

  if (!log) {
    throw new Error("Expected child writer");
  }

  const execution = { log, lower: 1 };
  const history = new ChildExecutions<typeof execution>(1);
  history.admitted(child, execution);
  history.remember(child, execution, "assistant-id");
  history.settled(child, execution, 6);
  expect(history.owner(child, "assistant-id", undefined)).toBe(execution);
  expect(history.owner(child, "unseen", 4)).toBe(execution);
  parent.end("completed");
  log.end("completed");
  const next = recorder.begin();
  expect(history.owner(child, "assistant-id", undefined)).toBeNull();
  expect(history.owner(child, "unseen", 4)).toBeNull();
  expect(history.get(child)?.latest).toBeUndefined();

  const replacement = next.child?.(null, grandchild);

  if (!replacement) {
    throw new Error("Expected replacement writer");
  }

  history.admitted(grandchild, { log: replacement, lower: 1 });
  expect(history.mayHaveCompacted(child)).toBe(false);
  replacement.end("completed");
  next.end("completed");
  recorder.begin();
  expect(history.get(child)).toBeUndefined();
  expect(history.mayHaveCompacted(child)).toBe(true);
  expect(history.mayHaveCompacted(grandchild)).toBe(false);
});

test("late items from an evicted child execution do not enter its replacement", async () => {
  const f = fixture(1);
  const old = f.root();
  f.parents.set(child, main);
  f.create(child, main);
  f.start(child);
  f.delta(child, "old", "old-assistant");
  f.end(child);
  f.settleRoot(old);

  const next = f.root();
  expect(f.turns()).toHaveLength(1);
  f.call(next, "next");
  f.names(next, "next", child);
  f.start(child);
  await Promise.resolve();
  f.delta(child, "late", "old-assistant");
  f.ended(child, "new", "new-assistant");
  expect(f.turns()[1]).toMatchObject({ items: [{ text: "new" }] });
  f.stop.abort();
});

test("a durable frame behind a higher sequence is applied once", () => {
  const f = fixture();
  f.root();
  f.create(child, main);
  f.start(child);

  for (const [seq, delta] of [
    [6, "six"],
    [4, " four"],
    [4, " duplicate"],
  ] as const) {
    f.emit(
      "session.text.delta",
      child,
      { assistantMessageID: "answer", ordinal: 0, delta },
      undefined,
      undefined,
      seq,
    );
  }

  expect(f.turns()[1]).toMatchObject({ items: [{ text: "six four" }] });
  f.stop.abort();
});

test("sparse durable replay overflow preserves output and exposes uncertainty", () => {
  const f = fixture();
  f.root();
  f.create(child, main);
  f.start(child);

  for (let index = 0; index <= 8192; index += 1) {
    f.emit(
      "session.text.delta",
      child,
      { assistantMessageID: "answer", ordinal: 0, delta: "a" },
      undefined,
      undefined,
      4 + 2 * index,
    );
  }

  expect(f.turns()[1]).toMatchObject({
    items: [{ text: "a".repeat(8193) }, { unavailable: ["activity.frames"] }],
  });
  f.stop.abort();
});

test("a long child keeps every durable frame and non-durable delta", () => {
  const f = fixture();
  f.root();
  f.create(child, main);
  f.start(child);
  const assistantMessageID = "message".repeat(45);
  const n = 8200;

  for (let index = 0; index < n; index += 1) {
    f.emit(
      "session.text.delta",
      child,
      { assistantMessageID, ordinal: 0, delta: "a" },
      undefined,
      undefined,
      index + 2,
    );
    f.emit(
      "session.text.delta",
      child,
      { assistantMessageID, ordinal: 0, delta: "b" },
      undefined,
      `event-${index}-${assistantMessageID}`,
    );
  }

  expect(f.turns()[1]).toMatchObject({ items: [{ text: "ab".repeat(n) }] });
  f.ended(child, "ab".repeat(n) + "!", assistantMessageID);
  expect(f.turns()[1]).toMatchObject({
    items: [{ text: "ab".repeat(n) + "!" }],
  });
  f.stop.abort();
});

test("an unproven late delta cannot appear in a reused execution", async () => {
  const f = fixture();
  const old = f.root();
  f.parents.set(child, main);
  f.create(child, main);
  f.start(child);
  f.emit("session.execution.succeeded", child, {}, undefined, undefined, 8);
  f.settleRoot(old);
  const next = f.root();
  f.call(next, "next");
  f.names(next, "next", child);
  f.start(child);
  await Promise.resolve();

  f.delta(child, "unproven old", "unseen");
  expect(f.turns()[3]).toMatchObject({ items: [] });
  f.emit(
    "session.text.ended",
    child,
    { assistantMessageID: "unseen", ordinal: 0, text: "old complete" },
    undefined,
    undefined,
    4,
  );
  f.ended(child, "new complete", "new");
  expect(f.turns()[1]).toMatchObject({ items: [{ text: "old complete" }] });
  expect(f.turns()[3]).toMatchObject({ items: [{ text: "new complete" }] });
  f.stop.abort();
});

test("a witnessed child interval routes a first-seen durable message to the old parent", async () => {
  const f = fixture();
  const first = f.root();
  f.parents.set(child, main);
  f.create(child, main);
  f.start(child);
  f.emit("session.execution.succeeded", child, {}, undefined, undefined, 8);
  f.settleRoot(first);

  const next = f.root();
  f.call(next, "next");
  f.names(next, "next", child);
  f.start(child);
  await Promise.resolve();
  f.ended(child, "new", "new-assistant");

  const late = { assistantMessageID: "late", ordinal: 0, delta: "old" };
  f.emit("session.text.delta", child, late, undefined, undefined, 4);
  f.emit("session.text.delta", child, late, undefined, undefined, 4);
  expect(f.turns()[1]).toMatchObject({
    status: "completed",
    items: [{ text: "old" }],
  });
  expect(f.turns()[3]).toMatchObject({
    status: "running",
    items: [{ text: "new" }],
  });
  f.stop.abort();
});

test("drops expired unproven frames and marks an unobserved outcome lost on reconnect", async () => {
  const f = fixture();
  f.root();
  f.delta(child, "expired");
  f.advance(2001);
  f.create(child, main);
  f.start(child);
  f.delta(child, "retained");
  await f.families.reconnected();
  expect(f.turns()[1]).toMatchObject({
    status: "cancelled",
    lost: true,
    reconnects: 1,
    items: [{ text: "retained" }],
  });
  f.stop.abort();
});

test("does not use a tool name or a newly unique root to override native ancestry", async () => {
  const f = fixture();
  const root = f.root();
  const overlap = f.root();
  f.create(child, main);
  f.start(child);
  f.delta(child, "ambiguous until proven");
  f.settleRoot(overlap);
  f.delta(child, " still ambiguous");

  f.parents.set("ses_foreign", "ses_foreign_parent");
  f.call(root, "forged-relationship");
  f.names(root, "forged-relationship", "ses_foreign");
  f.start("ses_foreign");
  await Promise.resolve();
  expect(f.reads).toEqual(["ses_foreign"]);
  expect(f.turns()).toHaveLength(2);
  f.stop.abort();
});

test("reconnect only keeps a running child if its durable period is unchanged", async () => {
  const f = fixture();
  f.root();
  f.create(child, main);
  f.start(child);
  f.active.add(child);
  f.logFrames.set(child, [{ type: "log.synced", aggregateID: child, seq: 1 }]);
  await f.families.reconnected();
  expect(f.turns()[1]?.status).toBe("running");
  expect(f.logReads).toEqual([[child, 1]]);

  f.logFrames.set(child, [
    {
      type: "session.execution.started",
      id: "next-start",
      created: 2,
      durable: { aggregateID: child, seq: 2, version: 1 },
      data: { sessionID: child },
    },
  ]);
  await f.families.reconnected();
  expect(f.turns()[1]).toMatchObject({ status: "cancelled", lost: true });
  f.stop.abort();
});

test("reconnect can recover a proven native child outcome without replaying items", async () => {
  const f = fixture();
  f.root();
  f.create(child, main);
  f.start(child);
  f.logFrames.set(child, [
    {
      type: "session.execution.succeeded",
      id: "settled",
      created: 2,
      durable: { aggregateID: child, seq: 2, version: 1 },
      data: { sessionID: child },
    },
  ]);
  await f.families.reconnected();
  expect(f.turns()[1]).toMatchObject({
    status: "completed",
    items: [],
    reconnects: 1,
  });
  expect(f.turns()[1]?.lost).toBeUndefined();
  f.stop.abort();
});
