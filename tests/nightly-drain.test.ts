import { expect, test } from "bun:test";
import { waitForMaintenanceDrain } from "../src/maintenance/nightly/drain";
import type { IdleInput } from "../src/maintenance/nightly/idle";

test("drain observes idle only after notices, then proceeds without waiting for the deadline", async () => {
  let now = 1000;
  let notified = false;
  let polls = 0;
  const outcome = await waitForMaintenanceDrain({
    deadlineAt: 61_000,
    pollMs: 5000,
    signal: new AbortController().signal,
    targets: () => [{} as IdleInput],
    announced: () => notified,
    clock: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        notified = true;
      },
    },
    observe: async () => {
      polls++;
      return { idle: true };
    },
    describe: async () => [],
  });
  expect(outcome).toEqual({ outcome: "idle", stragglers: [] });
  expect(polls).toBe(2);
  expect(now).toBe(6000);
});

test("drain reaches its deadline, names stragglers and permits the restart", async () => {
  let now = 0;
  const stragglers = [
    { taskID: "task_running", sessionID: "ses_worker", reason: "busy-crew" },
  ];
  const outcome = await waitForMaintenanceDrain({
    deadlineAt: 600_000,
    pollMs: 30_000,
    signal: new AbortController().signal,
    targets: () => [{} as IdleInput],
    announced: () => true,
    clock: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
    observe: async () => ({ idle: false, reason: "busy-crew" }),
    describe: async () => stragglers,
  });
  expect(now).toBe(600_000);
  expect(outcome).toEqual({ outcome: "deadline", stragglers });
});

test("drain includes other installation targets and respects cancellation", async () => {
  const signal = new AbortController();
  let observed = 0;
  await expect(
    waitForMaintenanceDrain({
      deadlineAt: 60_000,
      pollMs: 5000,
      signal: signal.signal,
      targets: () => [{} as IdleInput, {} as IdleInput],
      announced: () => true,
      clock: {
        now: () => 0,
        sleep: async () => {
          signal.abort();
        },
      },
      observe: async () => {
        observed++;
        return { idle: false, reason: "busy-opencode" };
      },
      describe: async () => [],
    }),
  ).rejects.toThrow();
  expect(observed).toBe(2);
});
