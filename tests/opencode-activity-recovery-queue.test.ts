import { expect, test } from "bun:test";
import type {
  SessionExecutionStarted,
  SessionTextEnded,
} from "@opencode/client";
import type { TurnActivityLog } from "../src/backends/backend";
import {
  ActivityRecoveryQueues,
  activityQueueDefaults,
} from "../src/backends/opencode/activity-recovery-queue";
import { maxActivityGapSlots } from "../src/backends/opencode/activity-replay-gap";

test("the provisional count cap evicts old hints without proving the surviving call", () => {
  const queue = new ActivityRecoveryQueues(
    { ...activityQueueDefaults, pending: 2 },
    () => 0,
    1,
    () => true,
    () => {},
  );

  const id = "ses_child";
  const pending = queue.candidate(id);

  const parent: TurnActivityLog = { update() {}, reconnected() {}, end() {} };

  for (let order = 1; order <= 3; order += 1) {
    queue.offerProof(pending, {
      session: "ses_parent",
      log: parent,
      callId: `call-${order}`,
      order,
      timing: { created: order, launch: "unknown" },
    });
  }

  expect(pending.provisional.map(({ callId }) => callId)).toEqual([
    "call-2",
    "call-3",
  ]);
  expect(pending.segments).toHaveLength(0);
  queue.enqueue(id, {
    event: { type: "session.execution.started", data: { sessionID: id } },
    at: 0,
    order: 4,
  });
  expect(queue.naming(pending, () => true)).toMatchObject({ ambiguous: true });
  queue.close();
});

test("a start arms expiry after the names-only candidate's timer has fired", async () => {
  const queue = new ActivityRecoveryQueues(
    { ...activityQueueDefaults, ttl: 20 },
    Date.now,
    1,
    () => false,
    () => {},
  );

  try {
    const id = "ses_child";
    const pending = queue.candidate(id);
    const parent: TurnActivityLog = { update() {}, reconnected() {}, end() {} };

    queue.offerProof(pending, {
      session: "ses_parent",
      log: parent,
      callId: "call-1",
      order: 1,
      timing: { created: 1, launch: "unknown" },
    });
    await Bun.sleep(40);
    expect(queue.peek(id)).toBe(pending);

    queue.enqueue(id, {
      event: { type: "session.execution.started", data: { sessionID: id } },
      at: Date.now(),
      order: 2,
    });
    await Bun.sleep(60);
    expect(queue.peek(id)).toBeUndefined();
  } finally {
    queue.close();
  }
});

test("late uses the head's deadline, not the earlier candidate deadline", () => {
  let now = 0;

  const queue = new ActivityRecoveryQueues(
    activityQueueDefaults,
    () => now,
    1,
    () => false,
    () => {},
  );

  try {
    const id = "ses_child";
    const pending = queue.candidate(id);

    const start = (order: number, at: number) => {
      now = at;
      queue.enqueue(id, {
        event: { type: "session.execution.started", data: { sessionID: id } },
        at,
        order,
      });
    };

    start(1, 1000);
    start(2, 2500);
    expect(pending.segments[1]?.first).toMatchObject({ order: 2 });
    expect(pending.segments[1]?.first.late).toBeUndefined();

    start(3, 3000);
    expect(pending.segments.at(-1)?.first).toMatchObject({
      order: 3,
      late: true,
    });
  } finally {
    queue.close();
  }
});

function recoveryFixture() {
  const id = "ses_child";

  type Event = SessionExecutionStarted | SessionTextEnded;

  const queue = new ActivityRecoveryQueues<Event>(
    { ...activityQueueDefaults, bytes: 0 },
    () => 0,
    1,
    () => true,
    () => {},
  );

  const pending = queue.candidate(id);

  const frame = (type: Event["type"], seq: number): Event => {
    const base = {
      id: `evt_${seq}`,
      created: 0,
      durable: { aggregateID: id, seq, version: 1 as const },
    };

    return type === "session.execution.started"
      ? { ...base, type, data: { sessionID: id } }
      : {
          ...base,
          type,
          data: {
            sessionID: id,
            assistantMessageID: "reply",
            ordinal: 0,
            text: "recovered",
          },
        };
  };

  const enqueue = (event: Event) =>
    queue.enqueue(id, { event, at: 0, order: event.durable.seq }, pending);

  return { id, queue, pending, frame, enqueue };
}

test("only the published segment bypasses the byte budget during recovery", async () => {
  const { id, queue, pending, frame, enqueue } = recoveryFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const early = frame("session.text.ended", 2);
  const live = frame("session.text.ended", 3);
  const later = frame("session.text.ended", 5);

  try {
    enqueue(frame("session.execution.started", 1));
    enqueue(early);
    queue.drain(id, pending, {
      signal: new AbortController().signal,
      async *read() {
        entered.resolve();
        await release.promise;
        yield early;
      },
      accepts: (event): event is typeof early => event === early,
      owned: () => true,
      replay() {},
      gap() {},
      lost() {},
      superseded() {},
    });
    await entered.promise;

    enqueue(live);
    enqueue(frame("session.execution.started", 4));
    enqueue(later);
    expect(pending.segments[0]?.frames.map(({ order }) => order)).toEqual([
      1, 3,
    ]);
    expect(pending.segments[1]?.frames.map(({ order }) => order)).toEqual([4]);
    expect(pending.segments[1]?.gap?.slots.has(5)).toBe(true);
  } finally {
    release.resolve();
    await queue.settleReads();
    queue.close();
  }
});

test("a successor recovers after its retired predecessor used every replay slot", async () => {
  const { id, queue, pending, frame, enqueue } = recoveryFixture();
  enqueue(frame("session.execution.started", 1));

  for (let seq = 2; seq < 2 + maxActivityGapSlots; seq += 1) {
    enqueue(frame("session.text.ended", seq));
  }

  const start = 2 + maxActivityGapSlots;
  enqueue(frame("session.execution.started", start));
  expect(pending.segments[0]?.gap?.slots.size).toBe(maxActivityGapSlots);
  queue.skip(id, pending);

  const omitted = frame("session.text.ended", start + 1);
  enqueue(omitted);
  const replayed: ReturnType<typeof frame>[] = [];
  let incomplete = false;

  queue.drain(id, pending, {
    signal: new AbortController().signal,
    async *read() {
      yield omitted;
    },
    accepts: (event): event is typeof omitted => event === omitted,
    owned: () => true,
    replay: (packets) => {
      replayed.push(...packets.map(({ event }) => event));
    },
    gap: () => {
      incomplete = true;
    },
    lost: () => {
      incomplete = true;
    },
    superseded() {},
  });
  await queue.settleReads();

  expect(replayed.map(({ type }) => type)).toEqual([
    "session.execution.started",
    "session.text.ended",
  ]);
  expect(incomplete).toBe(false);
  queue.close();
});
