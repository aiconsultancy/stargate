import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { lockInstance } from "../src/runtime";
import { Store } from "../src/store";

test("state survives reopening and exclusive lock prevents two owners", async () => {
  const directory = await mkdtemp("/tmp/opencode/pogo-test-");
  try {
    const path = join(directory, "pogo.sqlite");
    const lock = lockInstance(join(directory, "lock.sqlite"));
    try {
      expect(() => lockInstance(join(directory, "lock.sqlite"))).toThrow(
        "already using",
      );
    } finally {
      lock.close();
    }
    const reopenedLock = lockInstance(join(directory, "lock.sqlite"));
    reopenedLock.close();
    const store = new Store(path);
    store.enqueue({
      eventId: "event",
      botKey: "bot",
      conversation: "thread",
      channel: "C123",
      thread: "1.000",
      user: "U123",
      text: "hello",
    });
    store.saveSession("thread", "session");
    store.close();
    const reopened = new Store(path);
    try {
      expect(reopened.session("thread")).toBe("session");
      expect(reopened.ready("bot", 0, 1)[0]?.text).toBe("hello");
      expect(reopened.ready("other-bot", 0, 1)).toEqual([]);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
