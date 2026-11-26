import { expect, expectTypeOf, test } from "bun:test";
import type { SessionEventDurable, SessionLogItem } from "@opencode/client";
import { setImmediate, setTimeout as wait } from "node:timers/promises";
import { Schema } from "effect";
import type { TurnActivityLog } from "../src/backends/backend";
import { ActivityCallEvidence } from "../src/backends/opencode/activity-call-evidence";
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
  const failedReads = new Set<"active" | "log">();
  const logFrames = new Map<string, SessionLogItem[]>();
  const logReads: [string, number][] = [];
  let seq = 0;
  let now = 0;
  let native = 0;

  const families = new OpenCodeActivityFamilies(
    {
      signal: stop.signal,
      parent: async (id, signal) => {
        reads.push(id);

        return readParent ? readParent(id, signal) : parents.get(id);
      },
      active: async () => {
        if (failedReads.has("active")) {
          throw new Error("active read failed");
        }

        return Object.fromEntries(
          [...active].map((id) => [id, { type: "running" }]),
        );
      },
      async *log(id, after) {
        if (failedReads.has("log")) {
          throw new Error("log read failed");
        }

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
    created: number | null = ++native,
  ) => {
    const durable =
      replaySeq ?? (type.startsWith("session.execution.") ? ++seq : undefined);

    seq = Math.max(seq, durable ?? 0);

    const event = {
      id: eventID,
      type,
      ...(created !== null && { created }),
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
    failedReads,
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

test("shared root reconciliation rejects an uncovered watermark for an officer writer", async () => {
  const f = fixture();

  try {
    // Officer prompts normally use input ownership, not this durable root path.
    const log = f.root();

    const root = {
      id: main,
      startSeq: 1,
      dropped: false,
      open: new Set([{ log }]),
    };

    f.active.add(main);
    f.logFrames.set(main, [{ type: "log.synced", aggregateID: main, seq: 5 }]);

    const lost: unknown[] = [];
    await f.families.reconcileRoots([root], (session, boundary) => {
      expect(session).toBe(root);
      lost.push(boundary);
      log.end("cancelled", true);
    });

    expect(f.logReads).toEqual([[main, 1]]);
    expect(lost).toEqual([undefined]);
    expect(f.turns()).toMatchObject([
      {
        session: { id: main, parent: null },
        status: "cancelled",
        lost: true,
        reconnects: 1,
      },
    ]);
  } finally {
    f.stop.abort();
  }
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

test("OpenCode durable frames require a numeric native timestamp", () => {
  expectTypeOf<SessionEventDurable>().toMatchTypeOf<{ created: number }>();
});

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

// IDs, timestamps and positions come from OpenCode 2.3.2 /api/event.
const nativeCall = {
  input: {
    id: "evt_219442341001DNGAJvvcSrL3k3",
    at: 1_795_720_225_601,
    seq: 54_344,
  },
  called: {
    id: "evt_219442346001MD0bHxySQU0Eyc",
    at: 1_795_720_225_606,
    seq: 54_346,
  },
};

function capturedCall(
  f: ReturnType<typeof fixture>,
  owner: TurnActivityLog,
  input: Record<string, unknown>,
  sawInput = true,
  times: { input: number | null; called: number | null } = {
    input: nativeCall.input.at,
    called: nativeCall.called.at,
  },
) {
  if (sawInput) {
    const { id, seq } = nativeCall.input;
    f.emit(
      "session.tool.input.started",
      main,
      {
        assistantMessageID: "answer",
        id: "launch",
        name: "subagent",
      },
      owner,
      id,
      seq,
      times.input,
    );
  }

  const { id, seq } = nativeCall.called;
  f.emit(
    "session.tool.called",
    main,
    {
      assistantMessageID: "answer",
      id: "launch",
      input,
      executed: true,
    },
    owner,
    id,
    seq,
    times.called,
  );
}

function nativeChild(
  f: ReturnType<typeof fixture>,
  id: string,
  seq: number,
  created: number | null,
  text: string,
) {
  f.emit(
    "session.execution.started",
    id,
    {},
    undefined,
    undefined,
    seq,
    created,
  );
  f.emit(
    "session.text.ended",
    id,
    {
      assistantMessageID: `answer-${seq}`,
      ordinal: 0,
      text,
    },
    undefined,
    undefined,
    seq + 1,
    (created ?? nativeCall.input.at) + 1,
  );
  f.emit(
    "session.execution.succeeded",
    id,
    {},
    undefined,
    undefined,
    seq + 2,
    (created ?? nativeCall.input.at) + 2,
  );
}

test.each([true, false])(
  "a genuine resume after 5,000 evictions attaches with input start seen: %p",
  async (sawInput) => {
    const f = fixture();

    try {
      evictChildren(f, 5000);
      const root = f.root();
      const id = "ses_old_0";
      const parent = f.turns()[0]?.id;
      f.parents.set(id, main);
      f.logFrames.set(id, [{ type: "log.synced", aggregateID: id, seq: 4 }]);
      capturedCall(f, root, { agent: "explore", sessionID: id }, sawInput);
      f.names(root, "launch", id);
      await setImmediate();
      // Equality with input.started is valid despite a later tool.called.
      nativeChild(
        f,
        id,
        4,
        sawInput ? nativeCall.input.at : nativeCall.called.at,
        "genuinely new",
      );
      await setImmediate();

      expect(f.turns().slice(1)).toMatchObject([
        {
          session: { id, parent: { turnId: parent, callId: "launch" } },
          status: "completed",
          items: [{ text: "genuinely new" }],
        },
      ]);
      expect(f.logReads).toEqual([]);
    } finally {
      f.stop.abort();
    }
  },
);

test.each([{ sessionID: "" }, { task_id: "" }])(
  "an empty resume field %j admits a new child after 5,000 evictions",
  async (input) => {
    const f = fixture();

    try {
      evictChildren(f, 5000);
      const root = f.root();
      f.parents.set(child, main);
      f.create(child, main);
      capturedCall(f, root, { agent: "explore", ...input }, true, {
        input: null,
        called: null,
      });
      f.names(root, "launch", child);
      await setImmediate();
      nativeChild(f, child, 1, nativeCall.called.at, "new child");
      await setImmediate();

      expect(f.turns()[1]).toMatchObject({
        session: { id: child, parent: { callId: "launch" } },
        status: "completed",
        items: [{ text: "new child" }],
      });
      expect(f.logReads).toEqual([]);
    } finally {
      f.stop.abort();
    }
  },
);

test.each([0, null])(
  "a resume called at %p cannot prove a compacted start",
  async (callTime) => {
    const f = fixture(undefined, undefined, 1, 1);

    try {
      evictChildren(f, 37);
      const root = f.root();
      const id = "ses_old_0";
      f.parents.set(id, main);
      capturedCall(f, root, { agent: "explore", sessionID: id }, true, {
        input: callTime,
        called: callTime,
      });
      f.names(root, "launch", id);
      await setImmediate();
      nativeChild(f, id, 1, 5, "uncertain replay");
      expect(f.turns()[1]).toMatchObject({
        session: { id, parent: null },
        lost: true,
        items: [{ text: "uncertain replay" }],
      });
    } finally {
      f.stop.abort();
    }
  },
);

test("an undated durable start is uncertain even for a brand-new child", () => {
  const f = fixture();

  try {
    const root = f.root();
    capturedCall(f, root, { agent: "explore" });
    f.names(root, "launch", child);
    f.create(child, main);
    nativeChild(f, child, 1, null, "undated launch");
    expect(f.turns()).toMatchObject([
      {
        items: [
          { callId: "launch", unavailable: ["activity.child-attribution"] },
        ],
      },
      {
        session: { id: child, parent: null },
        lost: true,
        items: [{ text: "undated launch" }],
      },
    ]);
  } finally {
    f.stop.abort();
  }
});

test("a background launch can start 30 s after its naming call succeeds", async () => {
  const f = fixture();

  try {
    const root = f.root();
    f.parents.set(child, main);
    capturedCall(f, root, { agent: "explore" });
    f.emit(
      "session.tool.success",
      main,
      {
        assistantMessageID: "answer",
        id: "launch",
        executed: true,
        metadata: { sessionID: child, status: "running" },
      },
      root,
      undefined,
      undefined,
      nativeCall.called.at + 1,
    );
    await setImmediate();
    f.advance(30_000);
    nativeChild(f, child, 1, nativeCall.called.at + 30_000, "background work");
    await setImmediate();
    expect(f.turns()[1]).toMatchObject({
      session: { id: child, parent: { callId: "launch" } },
      items: [{ text: "background work" }],
    });
  } finally {
    f.stop.abort();
  }
});

test("a late start retries ancestry but stays detached without a dated call", async () => {
  const f = fixture();

  try {
    const root = f.root();
    capturedCall(f, root, { agent: "explore" }, true, {
      input: null,
      called: null,
    });
    f.names(root, "launch", child);
    await setImmediate();
    expect(f.reads).toEqual([child]);

    f.advance(2500);
    f.parents.set(child, main);
    nativeChild(f, child, 1, nativeCall.called.at, "late work");
    await setImmediate();
    expect(f.reads).toEqual([child, child]);
    expect(f.turns()[1]).toMatchObject({
      session: { id: child, parent: null },
      lost: true,
      items: [{ text: "late work" }],
    });
  } finally {
    f.stop.abort();
  }
});

test("an undated resume call cannot prove a retained child's next start", async () => {
  const f = fixture();

  try {
    const root = f.root();
    f.create(child, main);
    f.start(child);
    f.end(child);
    f.parents.set(child, main);
    capturedCall(f, root, { agent: "explore", sessionID: child }, true, {
      input: null,
      called: null,
    });
    f.names(root, "launch", child);
    await setImmediate();
    nativeChild(f, child, 3, nativeCall.called.at, "undated resume");
    expect(f.turns()[2]).toMatchObject({
      session: { id: child, parent: null },
      lost: true,
      items: [{ text: "undated resume" }],
    });
  } finally {
    f.stop.abort();
  }
});

test("a late name cannot link an open child that started before the native call", () => {
  const f = fixture();

  try {
    const root = f.root();
    capturedCall(f, root, { agent: "explore" });
    f.create(child, main);
    f.emit(
      "session.execution.started",
      child,
      {},
      undefined,
      undefined,
      1,
      nativeCall.input.at - 1,
    );
    f.names(root, "launch", child);
    f.ended(child, "already running", "existing-answer");
    f.end(child);
    expect(f.turns()[1]).toMatchObject({
      session: { id: child, parent: { callId: null } },
      status: "completed",
      items: [{ text: "already running" }],
    });
  } finally {
    f.stop.abort();
  }
});

test("replayed creation and start past the exact fence never attach to the current root", () => {
  const f = fixture();

  try {
    evictChildren(f, 5000);
    f.root();
    const id = "ses_old_0";
    f.emit(
      "session.created",
      id,
      { parentID: main },
      undefined,
      undefined,
      0,
      2,
    );
    nativeChild(f, id, 1, 3, "replayed transcript");

    expect(f.turns()[1]).toMatchObject({
      session: { id, parent: null },
      status: "cancelled",
      lost: true,
      requests: [],
      items: [{ text: "replayed transcript" }],
    });
  } finally {
    f.stop.abort();
  }
});

test.each([true, false])(
  "a named start after 2.5 s is still visible with proven time: %p",
  async (proven) => {
    const f = fixture();

    try {
      const root = f.root();
      f.parents.set(child, main);
      capturedCall(f, root, { agent: "explore" });
      f.create(child, main);
      f.names(root, "launch", child);
      await setImmediate();
      f.advance(2500);
      f.delta(main, " still running");
      nativeChild(
        f,
        child,
        2,
        proven ? nativeCall.called.at : 0,
        "late transcript",
      );
      await setImmediate();

      expect(f.turns()[1]).toMatchObject({
        session: { id: child, parent: proven ? { callId: "launch" } : null },
        status: proven ? "completed" : "cancelled",
        ...(!proven && { lost: true }),
        items: [{ text: "late transcript" }],
      });
    } finally {
      f.stop.abort();
    }
  },
);

test.each([nativeCall.input.at - 1, 0, null, NaN, Infinity, -1])(
  "a replayed start with native time %p is visible and uncertain",
  async (created) => {
    const f = fixture(undefined, undefined, 1, 1);

    try {
      evictChildren(f, 37);
      const root = f.root();
      const id = "ses_old_0";
      f.parents.set(id, main);
      // An old or undated start cannot spend even a new-launch proof.
      capturedCall(f, root, { agent: "explore" });
      f.names(root, "launch", id);
      await setImmediate();
      nativeChild(f, id, 1, created, "uncertain transcript");
      await setImmediate();

      expect(f.turns()).toMatchObject([
        {
          items: [
            { callId: "launch", unavailable: ["activity.child-attribution"] },
          ],
        },
        {
          session: { id, parent: null },
          status: "cancelled",
          lost: true,
          items: [{ text: "uncertain transcript" }],
        },
      ]);
      nativeChild(f, id, 4, nativeCall.called.at + 1, "proven transcript");
      await setImmediate();
      expect(f.turns()[0]?.items[0]).not.toHaveProperty("unavailable");
      expect(f.turns()[2]).toMatchObject({
        session: { id, parent: { callId: "launch" } },
        status: "completed",
        items: [{ text: "proven transcript" }],
      });
      expect(f.logReads).toEqual([]);
    } finally {
      f.stop.abort();
    }
  },
);

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
  "%s Fleet activity shows unproven frames detached until native time proves a later start",
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

      f.emit("session.execution.started", id, {}, undefined, undefined, 1, 2);
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
        logReads: [],
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

test("a child evicted without a sequence boundary contributes its latest native time", () => {
  const hub = createActivityHub({ turnsPerAgent: 1, turns: 1 });
  const recorder = hub.recorder("officer");
  const history = new ChildExecutions<{ log: TurnActivityLog }>(1);

  for (const [id, times] of [
    ["ses_unsequenced", [7, 10, 8]],
    ["ses_other", [11]],
  ] as const) {
    const parent = recorder.begin();
    const log = parent.child?.(null, id);

    if (!log) {
      throw new Error("Expected child writer");
    }

    const child = { log };
    history.admitted(id, child);

    for (const time of times) {
      history.advance(id, child, undefined, time);
    }

    log.end("completed");
    parent.end("completed");
  }

  expect(history.needsFreshness("ses_unsequenced", undefined)).toBe(true);
  expect(history.needsFreshness("ses_old", 10)).toBe(true);
  expect(history.needsFreshness("ses_new", 11)).toBe(false);
  expect(history.possiblyReplayed("ses_unsequenced", undefined)).toBe(false);
});

test("a compacted undated boundary uses the latest observed native time", () => {
  const hub = createActivityHub({ turnsPerAgent: 1, turns: 1 });
  const recorder = hub.recorder("officer");
  const history = new ChildExecutions<{ log: TurnActivityLog }>(1);

  for (let index = 0; index < 12; index += 1) {
    const id = `ses_untimed_${index}`;
    const parent = recorder.begin();
    const log = parent.child?.(null, id);

    if (!log) {
      throw new Error("Expected child writer");
    }

    const child = { log };
    history.admitted(id, child);
    history.advance(id, child, 1, index === 11 ? 50 : undefined);
    log.end("completed");
    parent.end("completed");
  }

  expect(history.needsFreshness("ses_untimed_0", 5)).toBe(true);
  expect(history.needsFreshness("ses_untimed_0", 50)).toBe(true);
  expect(history.needsFreshness("ses_new", 51)).toBe(false);
});

test("untimed compaction requires freshness proof until native time is observed", () => {
  const hub = createActivityHub({ turnsPerAgent: 1, turns: 1 });
  const recorder = hub.recorder("officer");
  const history = new ChildExecutions<{ log: TurnActivityLog }>(1);

  for (let index = 0; index < 12; index += 1) {
    const id = `ses_untimed_${index}`;
    const parent = recorder.begin();
    const log = parent.child?.(null, id);

    if (!log) {
      throw new Error("Expected child writer");
    }

    const child = { log };
    history.admitted(id, child);
    history.advance(id, child, 1);
    log.end("completed");
    parent.end("completed");
  }

  expect(history.possiblyReplayed("ses_untimed_0", 1)).toBe(false);
  expect(history.needsFreshness("ses_untimed_0", 5)).toBe(true);
  history.observeNativeTime(50);
  expect(history.needsFreshness("ses_untimed_0", 50)).toBe(true);
  expect(history.needsFreshness("ses_new", 51)).toBe(false);
});

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

test.each(["officer", "crew"] as const)(
  "%s child reconnect requires every durable position covered by the watermark",
  async (subject) => {
    const f = fixture(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      subject === "crew" ? "crew" : undefined,
    );

    const covered = "ses_covered";
    const sparse = "ses_sparse";

    try {
      f.root(subject === "crew" ? { active: true } : undefined);

      for (const [id, seqs] of [
        [child, []],
        [covered, [2, 3]],
        [sparse, [3]],
      ] as const) {
        f.create(id, main);
        f.emit("session.execution.started", id, {}, undefined, undefined, 1);
        f.active.add(id);
        f.logFrames.set(id, [
          ...seqs.map((seq): SessionLogItem => ({
            id: `${id}-${seq}`,
            type: "session.text.ended",
            created: seq + 10,
            data: {
              sessionID: id,
              assistantMessageID: "covered-answer",
              ordinal: 0,
              text: "not replayed",
            },
            durable: { aggregateID: id, seq, version: 1 },
          })),
          { type: "log.synced", aggregateID: id, seq: 3 },
        ]);
      }

      await f.families.reconnected();
      const reconnect = f.turns().slice(1);
      f.ended(child, "replacement transcript", "next-answer");
      expect({ reconnect, oldItems: f.turns()[1]?.items }).toMatchObject({
        reconnect: [
          { status: "cancelled", lost: true },
          { status: "running", items: [] },
          { status: "cancelled", lost: true },
        ],
        oldItems: [],
      });
    } finally {
      f.stop.abort();
    }
  },
);

test.each(["old terminal", "new start"] as const)(
  "a reconnect that reads the %s admits the same buffered live start exactly once",
  async (boundary) => {
    const f = fixture();
    const startID = "replacement-start";

    try {
      const root = f.root();
      f.parents.set(child, main);
      f.create(child, main);
      f.emit("session.execution.started", child, {}, undefined, undefined, 1);
      f.logFrames.set(child, [
        {
          id: boundary === "new start" ? startID : "old-terminal",
          type:
            boundary === "new start"
              ? "session.execution.started"
              : "session.execution.succeeded",
          created: boundary === "new start" ? 23 : 18,
          data: { sessionID: child },
          durable: {
            aggregateID: child,
            seq: boundary === "new start" ? 3 : 2,
            version: 1,
          },
        },
      ]);

      await f.families.reconnected();
      expect(f.turns()[1]).toMatchObject(
        boundary === "new start"
          ? { status: "cancelled", lost: true }
          : { status: "completed" },
      );

      f.call(root, "retry");
      f.called(root, "retry", { agent: "explore", sessionID: child });
      f.names(root, "retry", child);
      await setImmediate();

      for (let seen = 0; seen < 2; seen += 1) {
        f.emit(
          "session.execution.started",
          child,
          {},
          undefined,
          startID,
          3,
          23,
        );
      }

      f.ended(child, "new transcript", "new-answer");
      f.end(child);
      expect(f.turns().slice(2)).toMatchObject([
        {
          session: { id: child, parent: { callId: "retry" } },
          status: "completed",
          items: [{ text: "new transcript" }],
        },
      ]);
    } finally {
      f.stop.abort();
    }
  },
);

test("reconnect can recover a proven native child outcome without replaying items", async () => {
  const f = fixture();
  f.root();
  f.create(child, main);
  f.start(child);
  f.ended(child, "first period", "first-answer");
  f.active.add(child);
  f.logFrames.set(child, [
    {
      type: "session.execution.succeeded",
      id: "settled",
      created: 2,
      durable: { aggregateID: child, seq: 3, version: 1 },
      data: { sessionID: child },
    },
    { type: "log.synced", aggregateID: child, seq: 9 },
  ]);
  await f.families.reconnected();
  expect(f.turns()[1]).toMatchObject({
    status: "completed",
    items: [{ text: "first period" }],
    reconnects: 1,
  });
  expect(f.turns()[1]?.lost).toBeUndefined();
  f.stop.abort();
});

async function postLossStart(
  boundary: "started" | "succeeded",
  pending?: number,
) {
  const f = fixture(undefined, undefined, pending);
  const root = f.root();
  f.parents.set(child, main);
  f.create(child, main);
  f.emit("session.execution.started", child, {}, undefined, undefined, 1, 10);
  const replacement = boundary === "started";
  f.logFrames.set(child, [
    {
      id: replacement ? "replacement" : "terminal",
      type: `session.execution.${boundary}`,
      created: replacement ? 23 : 18,
      data: { sessionID: child },
      durable: { aggregateID: child, seq: replacement ? 3 : 2, version: 1 },
    },
  ]);
  await f.families.reconnected();
  f.call(root, "retry");
  f.called(root, "retry", { agent: "explore", sessionID: child });

  return { f, root };
}

test.each([
  { earlier: "none", nameAt: 2100 },
  { earlier: "queued", nameAt: 2100 },
  { earlier: "queued", nameAt: 3899 },
  { earlier: "queued", nameAt: 3901 },
  { earlier: "recovering", nameAt: 3899 },
  { earlier: "recovering", nameAt: 3901 },
] as const)("a post-loss start gets its own naming window: %j", async (row) => {
  const gate = Promise.withResolvers<void>();
  const { earlier, nameAt } = row;
  const recovering = earlier === "recovering";
  const f = fixture(undefined, recovering ? gate.promise : undefined);

  try {
    const root = f.root();
    f.parents.set(child, main);
    f.create(child, main);
    f.emit("session.execution.started", child, {}, undefined, undefined, 1, 10);
    f.failedReads.add("log");
    await f.families.reconnected();
    f.failedReads.delete("log");

    if (earlier !== "none") {
      f.emit(
        "session.execution.started",
        child,
        {},
        undefined,
        "unnamed",
        3,
        23,
      );
      f.ended(child, "unnamed transcript", "unnamed-answer");

      if (recovering) {
        // Hold the first segment's durable recovery, then leave its slot missing.
        f.ended(child, "x".repeat(256 * 1024), "missing-answer");
        await setImmediate();
        expect(f.logReads).toEqual([[child, 4]]);
      }

      f.end(child);
    }

    f.advance(1900);
    f.call(root, "fresh-retry");
    f.called(root, "fresh-retry", { agent: "explore", sessionID: child });
    f.emit(
      "session.execution.started",
      child,
      {},
      undefined,
      "fresh-start",
      7,
      41,
    );
    f.ended(child, "new transcript", "new-answer");

    let afterFirstDeadline: ReturnType<typeof f.turns> | undefined;

    if (earlier === "queued") {
      expect(f.turns()).toHaveLength(2);
      f.advance(100);
      f.delta(main, "tick");
      afterFirstDeadline = f.turns().slice(2);
    }

    f.advance(nameAt - (earlier === "queued" ? 2000 : 1900));
    f.names(root, "fresh-retry", child);
    f.end(child);

    if (recovering) {
      // A name seen in time remains valid when the earlier read releases late.
      f.advance(2000);
      gate.resolve();
    }

    await setImmediate();

    const turns = f.turns().slice(2);
    const namedInTime = nameAt < 3900;

    const next = {
      session: {
        id: child,
        parent: namedInTime ? { callId: "fresh-retry" } : null,
      },
      status: namedInTime ? "completed" : "cancelled",
      ...(!namedInTime && { lost: true }),
      items: [{ text: "new transcript" }],
    };

    const detached = {
      session: { id: child, parent: null },
      status: "cancelled",
      lost: true,
    };

    expect(turns).toMatchObject(earlier === "none" ? [next] : [detached, next]);
    expect(turns.at(-1)?.lost).toBe(namedInTime ? undefined : true);

    if (earlier === "queued" && namedInTime) {
      expect(afterFirstDeadline).toMatchObject([detached]);
    }

    if (earlier !== "none") {
      const items = turns[0]?.items;
      expect(items).toHaveLength(recovering ? 2 : 1);
      expect(items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: "unnamed transcript" }),
          ...(recovering
            ? [expect.objectContaining({ unavailable: ["activity.frames"] })]
            : []),
        ]),
      );
    }
  } finally {
    gate.resolve();
    f.stop.abort();
  }
});

test.each(["started", "succeeded"] as const)(
  "reconnect log %s still lets a resume name arrive after the live start",
  async (boundary) => {
    const { f, root } = await postLossStart(boundary);

    try {
      expect(f.turns()[1]).toMatchObject(
        boundary === "started"
          ? { status: "cancelled", lost: true }
          : { status: "completed" },
      );
      f.emit(
        "session.execution.started",
        child,
        {},
        undefined,
        "replacement",
        3,
        23,
      );
      f.names(root, "retry", child);
      await setImmediate();
      f.ended(child, "new transcript", "new-answer");
      f.end(child);
      expect(f.turns().slice(2)).toMatchObject([
        {
          session: { id: child, parent: { callId: "retry" } },
          status: "completed",
          items: [{ text: "new transcript" }],
        },
      ]);
      expect(f.turns()[2]?.lost).toBeUndefined();
    } finally {
      f.stop.abort();
    }
  },
);

test.each(["timeout", "capacity", "bytes", "lifecycle"] as const)(
  "a post-loss start with no name publishes one detached turn when the %s budget ends",
  async (limit) => {
    const { f, root } = await postLossStart("started", 1);

    try {
      f.emit(
        "session.execution.started",
        child,
        {},
        undefined,
        "replacement",
        3,
        23,
      );
      f.delta(child, "held output", "answer");
      expect(f.turns()).toHaveLength(2);

      if (limit === "lifecycle") {
        for (let boundary = 0; boundary < 64; boundary += 1) {
          f.end(child);
        }
      } else if (limit === "bytes") {
        f.delta(child, "x".repeat(256 * 1024), "oversized");
      } else {
        f.end(child);
        expect(f.turns()).toHaveLength(2);

        if (limit === "timeout") {
          f.advance(2000);
          f.delta(main, "tick");
        } else {
          f.delta(grandchild, "new candidate");
        }
      }

      if (limit === "bytes") {
        f.end(child);
      }

      f.names(root, "retry", child);
      await setImmediate();
      f.emit(
        "session.execution.started",
        child,
        {},
        undefined,
        "replacement",
        3,
        23,
      );
      expect(f.turns().slice(2)).toMatchObject([
        {
          session: { id: child, parent: null },
          requests: [],
          status: "cancelled",
          lost: true,
        },
      ]);
      expect(f.turns()[2]?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: "held output" }),
          ...(limit === "bytes" || limit === "lifecycle"
            ? [expect.objectContaining({ unavailable: ["activity.frames"] })]
            : []),
        ]),
      );
    } finally {
      f.stop.abort();
    }
  },
);

test.each(["lost", "settled", "name first"] as const)(
  "a relaunch takes its late name after a %s reconnect with an active read failure",
  async (mode) => {
    const f = fixture();

    try {
      const root = f.root();
      f.parents.set(child, main);
      f.create(child, main);
      f.start(child);
      f.ended(child, "first period", "first");

      if (mode === "settled") {
        f.end(child);
      }

      f.failedReads.add("active");
      await f.families.reconnected();
      f.call(root, "retry");
      f.called(root, "retry", { agent: "explore", sessionID: child });

      if (mode === "name first") {
        f.names(root, "retry", child);
      }

      f.start(child);

      if (mode !== "name first") {
        f.names(root, "retry", child);
      }

      await setImmediate();
      f.ended(child, "relaunch output", "second");
      f.end(child);
      expect(f.turns().slice(1)).toMatchObject([
        {
          status: mode === "settled" ? "completed" : "cancelled",
          items: [{ text: "first period" }],
        },
        {
          status: "completed",
          session: { parent: { callId: "retry" } },
          items: [{ text: "relaunch output" }],
        },
      ]);
      expect(f.turns()[2]?.lost).toBeUndefined();
    } finally {
      f.stop.abort();
    }
  },
);

test.each(["active", "log", "unproven", "no retention"] as const)(
  "%s reconnect loss leaves later live output visible without attribution",
  async (reason) => {
    const f = fixture(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "crew",
    );

    try {
      const root = f.root({ active: true });
      f.call(root, "initial");
      f.called(root, "initial", { agent: "explore" });
      f.names(root, "initial", child);
      f.create(child, main);
      f.emit(
        "session.execution.started",
        child,
        {},
        undefined,
        undefined,
        1,
        reason === "unproven" ? null : 20,
      );
      f.ended(child, "before reconnect", "first-answer");
      f.active.add(child);
      f.logFrames.set(child, [
        {
          type: "log.synced",
          aggregateID: child,
          seq: reason === "no retention" ? 9 : 2,
        },
      ]);

      if (reason === "active" || reason === "log") {
        f.failedReads.add(reason);
      }

      await f.families.reconnected();
      expect(f.turns()[1]).toMatchObject({ status: "cancelled", lost: true });
      f.emit(
        "session.text.ended",
        child,
        {
          assistantMessageID: "first-answer",
          ordinal: 0,
          text: "replayed",
        },
        undefined,
        undefined,
        2,
      );
      f.delta(child, "transient continuation", "next-answer");
      f.advance(2500);
      f.emit(
        "session.text.ended",
        child,
        {
          assistantMessageID: "first-answer",
          ordinal: 1,
          text: "after reconnect",
        },
        undefined,
        undefined,
        10,
      );
      f.end(child);
      await setImmediate();
      f.advance(5000);
      f.delta(main, "tick");

      expect(f.turns().slice(1)).toMatchObject([
        {
          status: "cancelled",
          lost: true,
          items: [{ text: "before reconnect" }],
        },
        {
          status: "cancelled",
          lost: true,
          session: { id: child, parent: null },
          task: null,
          requests: [],
          items: [
            { text: "transient continuation" },
            { text: "after reconnect" },
          ],
        },
      ]);
    } finally {
      f.stop.abort();
    }
  },
);

test("an unproven later start cannot advance the last proven post-loss cursor", async () => {
  const f = fixture();

  try {
    const root = f.root();
    f.parents.set(child, main);
    f.create(child, main);
    f.start(child);
    f.end(child);
    f.call(root, "retry");
    f.called(root, "retry", { agent: "explore", sessionID: child });
    f.names(root, "retry", child);
    f.emit(
      "session.execution.started",
      child,
      {},
      undefined,
      undefined,
      5,
      null,
    );
    await setImmediate();
    expect(f.turns()[2]).toMatchObject({
      session: { id: child, parent: null },
      status: "running",
    });
    await f.families.reconnected();

    // This trailing frame was between the proven terminal and the undated start.
    f.emit(
      "session.text.ended",
      child,
      {
        assistantMessageID: "tail",
        ordinal: 0,
        text: "unobserved tail",
      },
      undefined,
      undefined,
      4,
    );
    f.end(child);
    expect(f.turns().slice(2)).toMatchObject([
      { status: "cancelled", lost: true, items: [] },
      {
        session: { id: child, parent: null },
        status: "cancelled",
        lost: true,
        items: [{ text: "unobserved tail" }],
      },
    ]);
  } finally {
    f.stop.abort();
  }
});

test("discarding post-loss output whose parent is fenced marks a gap on the lost turn", async () => {
  const f = fixture();

  try {
    const scope = { active: true };
    f.root(scope);
    f.create(child, main);
    f.start(child);
    f.ended(child, "before loss", "answer");
    await f.families.reconnected();
    f.families.fence(main, scope);
    f.delta(child, "cannot publish", "answer");
    expect(f.turns()[1]?.items).toMatchObject([{ text: "before loss" }]);
    f.advance(2000);
    f.delta(main, "tick");

    expect(f.turns().slice(1)).toMatchObject([
      {
        status: "cancelled",
        lost: true,
        items: [{ text: "before loss" }, { unavailable: ["activity.frames"] }],
      },
    ]);
  } finally {
    f.stop.abort();
  }
});

test("a named replacement cannot reopen the lost writer for an old assistant message", async () => {
  const f = fixture();

  try {
    const root = f.root();
    f.parents.set(child, main);
    f.create(child, main);
    f.start(child);
    f.ended(child, "before loss", "old-answer");
    await f.families.reconnected();
    f.call(root, "retry");
    f.called(root, "retry", { agent: "explore", sessionID: child });
    f.names(root, "retry", child);
    f.start(child);
    await setImmediate();
    expect(f.turns()[2]).toMatchObject({
      session: { parent: { callId: "retry" } },
    });

    f.delta(child, "should not rewrite the lost period", "old-answer");
    f.ended(child, "replacement output", "new-answer");
    f.end(child);
    expect(f.turns().slice(1)).toMatchObject([
      { status: "cancelled", lost: true, items: [{ text: "before loss" }] },
      { status: "completed", items: [{ text: "replacement output" }] },
    ]);
  } finally {
    f.stop.abort();
  }
});

test("published child retains and pages live content during early log recovery", async () => {
  const gate = Promise.withResolvers<void>();
  const f = fixture(undefined, gate.promise);
  const early = "early".repeat(60_000);
  const live = "live".repeat(75_000);
  const end = { assistantMessageID: "answer", ordinal: 0, text: early };

  try {
    const root = f.root();
    f.parents.set(child, main);
    f.call(root, "retry");
    f.called(root, "retry", { agent: "explore", sessionID: child });
    f.names(root, "retry", child);
    f.emit("session.execution.started", child, {}, undefined, undefined, 3);
    f.emit("session.text.ended", child, end, undefined, "early", 4);
    f.logFrames.set(child, [
      {
        id: "early",
        type: "session.text.ended",
        created: 20,
        data: { sessionID: child, ...end },
        durable: { aggregateID: child, seq: 4, version: 1 },
      },
    ]);
    await setImmediate();
    expect(f.logReads).toEqual([[child, 3]]);
    expect(f.turns()[1]).toMatchObject({
      session: { id: child, parent: { callId: "retry" } },
      status: "running",
    });

    f.emit("session.text.ended", child, end, undefined, "early", 4);
    f.emit("session.text.delta", child, {
      assistantMessageID: "answer",
      ordinal: 1,
      delta: live,
    });
    f.emit("session.execution.interrupted", child, {}, undefined, undefined, 5);
    gate.resolve();
    await setImmediate();
    const turn = f.turns()[1];
    expect(turn).toMatchObject({
      status: "cancelled",
      items: [
        { paged: { pages: expect.any(Number) } },
        { paged: { pages: expect.any(Number) } },
      ],
    });

    if (!turn) {
      throw new Error("Missing published child");
    }

    for (const [index, prefix] of ["early", "live"].entries()) {
      const item = turn?.items[index];
      const page = item && f.hub.page("officer", turn.id, item.id, 0);
      expect(page).toMatchObject({ item: item?.id });
      expect(JSON.stringify(page)).toContain(prefix.repeat(10));
    }
  } finally {
    gate.resolve();
    f.stop.abort();
  }
});

test("name saturation survives a live parent but not retirement plus writer eviction", () => {
  const hub = createActivityHub({ turnsPerAgent: 1 });
  const recorder = hub.recorder("officer");
  const calls = new ActivityCallEvidence(1);
  const scope = { active: true };
  const window = { after: 0, through: 6, except: 0 };

  const parents = Array.from(
    { length: 300 },
    (_, index) => `ses_parent_${index}`,
  );

  for (const id of parents) {
    const log = recorder.begin(undefined, id);

    for (let order = 1; order <= 5; order += 1) {
      const childID = `${id}-kid-${order}`;
      calls.open(id, scope, log, childID, order);
      calls.name(id, scope, log, childID, childID);
    }

    for (let order = 1; order <= 5; order += 1) {
      calls.retire(id, scope, `${id}-kid-${order}`, 6);
    }

    expect(calls.competing(id, scope, `${id}-kid-5`, window)).toBe(true);
    log.end("completed");
  }

  recorder.begin(undefined, "ses_final");
  expect(
    parents.filter((id) => calls.competing(id, scope, `${id}-kid-5`, window)),
  ).toEqual([]);
});
