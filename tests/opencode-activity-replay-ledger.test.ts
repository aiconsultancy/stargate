import { expect, test } from "bun:test";
import { ActivitySequenceWindow } from "../src/backends/opencode/activity-replay-ledger";

test("a hole does not exhaust the durable sequence ledger for an ordered tail", () => {
  const window = new ActivitySequenceWindow(10);
  expect(window.record(11)).toBe("new");

  for (let seq = 13; seq < 50_013; seq += 1) {
    expect(window.record(seq)).toBe("new");
  }

  for (let seq = 50_012; seq >= 13; seq -= 1) {
    expect(window.record(seq)).toBe("duplicate");
  }

  expect(window.record(10)).toBe("duplicate");
  expect(window.record(11)).toBe("duplicate");
  expect(window.record(12)).toBe("new");
  expect(window.record(12)).toBe("duplicate");
});

test("out-of-order neighbours extend and merge runs even at the run limit", () => {
  const window = new ActivitySequenceWindow(0);

  for (let index = 1; index <= 8192; index += 1) {
    expect(window.record(3 * index)).toBe("new");
  }

  const isolated = 3 * 8193;
  expect(window.record(isolated)).toBe("untracked");
  expect(window.record(5)).toBe("new");
  expect(window.record(5)).toBe("duplicate");
  expect(window.record(isolated)).toBe("untracked");
  expect(window.record(4)).toBe("new");
  expect(window.record(4)).toBe("duplicate");
  expect(window.record(6)).toBe("duplicate");
  expect(window.record(isolated)).toBe("new");
  expect(window.record(isolated)).toBe("duplicate");
});
