import { Database } from "bun:sqlite";
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

test("migration preserves old jobs and accepted Stop survives database reopen", async () => {
  const directory = await mkdtemp("/tmp/opencode/pogo-cancel-");
  const path = join(directory, "pogo.sqlite");
  try {
    const initial = new Store(path);
    initial.enqueue({
      eventId: "event",
      botKey: "bot",
      conversation: "thread",
      channel: "C123",
      thread: "1.000",
      user: "U123",
      text: "Original prompt",
    });
    initial.saveSession("thread", "session");
    initial.savePreview(1, 0, "2.000");
    initial.close();
    // Recreate the pre-feature schema without discarding existing rows.
    const legacy = new Database(path);
    legacy.exec("ALTER TABLE jobs DROP COLUMN cancel_requested");
    legacy.close();
    const migrated = new Store(path);
    expect(migrated.ready("bot", 0, 1)[0]?.text).toBe("Original prompt");
    migrated.running(1);
    expect(
      migrated.cancel("bot", {
        id: 1,
        user: "U123",
        channel: "C123",
        thread: "1.000",
        ts: "2.000",
      }),
    ).toBe(true);
    migrated.close();
    const reopened = new Store(path);
    try {
      expect(reopened.interruptedSessions("bot")).toEqual(["session"]);
      reopened.recover("bot");
      expect(reopened.ready("bot", 0, 1)[0]?.response).toContain(
        "stop request",
      );
      expect(reopened.session("thread")).toBe("session");
      expect(reopened.previews(1)).toEqual([{ part: 0, ts: "2.000" }]);
      expect(reopened.running(1)).toBe(false);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
