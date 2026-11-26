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
    });
  }

  expect(pending.provisional.map(({ proof }) => proof.callId)).toEqual([
    "call-2",
    "call-3",
  ]);
  expect(pending.segments).toHaveLength(0);
  queue.enqueue(id, {
    event: { type: "session.execution.started", data: { sessionID: id } },
    at: 0,
    order: 4,
  });
  expect(pending.segments[0]).toMatchObject({ proofOverflow: true });
  queue.close();
});

test("a successor recovers after its retired predecessor used every replay slot", async () => {
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
  const replayed: Event[] = [];
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
