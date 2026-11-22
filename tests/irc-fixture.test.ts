import { expect, onTestFinished, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { until } from "./irc-fixture";

test("IRC poll timeout reports its predicate, elapsed time and last state", async () => {
  await expect(
    until(() => false, 1, "connections joined", {
      state: () => ({ captain: true, chief: false, audit: true }),
    }),
  ).rejects.toThrow(
    /connections joined after \d+ ms.*last state:.*"chief":false/,
  );
});

test("IRC poll teardown stops polling without resuming an ended test", () => {
  let calls = 0;
  let resumed = false;
  void until(() => {
    calls++;
    return false;
  }, 1000).then(
    () => {
      resumed = true;
    },
    () => {
      resumed = true;
    },
  );
  onTestFinished(async () => {
    const stoppedAt = calls;
    await delay(30);
    expect(calls).toBe(stoppedAt);
    expect(resumed).toBe(false);
  });
});

test("IRC poll abort at teardown start stops before resource cleanup", async () => {
  const lifetime = new AbortController();
  let calls = 0;
  let resumed = false;
  void until(
    () => {
      calls++;
      return false;
    },
    1000,
    "cleanup",
    { signal: lifetime.signal },
  ).then(
    () => {
      resumed = true;
    },
    () => {
      resumed = true;
    },
  );
  lifetime.abort();
  const stoppedAt = calls;
  await delay(30);
  expect(calls).toBe(stoppedAt);
  expect(resumed).toBe(false);
});
