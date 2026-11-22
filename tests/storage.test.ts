import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockInstance } from "../src/app/runtime";
import { JobTransitionRefused, Store } from "../src/gateway/store";

test("state survives reopening and exclusive lock prevents two owners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-test-"));
  try {
    const path = join(directory, "stargate.sqlite");
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
  const directory = await mkdtemp(join(tmpdir(), "stargate-cancel-"));
  const path = join(directory, "stargate.sqlite");
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

function queued(store: Store, eventId = "event") {
  store.enqueue({
    eventId,
    botKey: "bot",
    conversation: `thread-${eventId}`,
    channel: "C123",
    thread: "1.000",
    user: "U123",
    text: "hello",
  });
  const job = store.queuedJob("bot", eventId);
  if (!job) throw new Error("missing job");
  return job.id;
}

test("a reply is stored only for a running job", () => {
  const store = new Store(":memory:");
  try {
    const id = queued(store);
    expect(() => store.respond(id, ["early"])).toThrow(JobTransitionRefused);
    expect(store.jobStatus("bot", id)).toBe("queued");
    expect(store.running(id)).toBe(true);
    expect(store.respond(id, ["reply"])).toEqual(["reply"]);
    // A second reply cannot replace a stored one, also after delivery.
    expect(() => store.respond(id, ["again"])).toThrow(JobTransitionRefused);
    expect(store.finish(id)).toBe(true);
    expect(() => store.respond(id, ["late"])).toThrow(JobTransitionRefused);
    expect(store.jobStatus("bot", id)).toBe("done");
    expect(store.replies("bot", "thread-event")).toEqual([["reply"]]);
  } finally {
    store.close();
  }
});

test("only a stored reply is finished; a queued job can only fail", () => {
  const store = new Store(":memory:");
  try {
    const id = queued(store);
    expect(store.finish(id)).toBe(false);
    expect(store.jobStatus("bot", id)).toBe("queued");
    store.running(id);
    expect(store.finish(id)).toBe(false);
    expect(store.finish(id, "failed")).toBe(false);
    expect(store.jobStatus("bot", id)).toBe("running");
    store.respond(id, ["reply"]);
    expect(store.finish(id)).toBe(true);
    // Finished is final for `finish`.
    expect(store.finish(id, "failed")).toBe(false);
    expect(store.jobStatus("bot", id)).toBe("done");
    // Access removed before the turn: the queued request fails.
    const refused = queued(store, "refused");
    expect(store.finish(refused, "failed")).toBe(true);
    expect(store.jobStatus("bot", refused)).toBe("failed");
  } finally {
    store.close();
  }
});

test("the delivery cursor and retry apply only to a stored reply", () => {
  const store = new Store(":memory:");
  try {
    const id = queued(store);
    const row = () => store.ready("bot", Number.MAX_SAFE_INTEGER, 1)[0];
    expect(store.sent(id, 1)).toBe(false);
    expect(store.retry(id, 5)).toBe(false);
    store.running(id);
    expect(store.sent(id, 1)).toBe(false);
    expect(store.retry(id, 5)).toBe(false);
    store.respond(id, ["one", "two"]);
    // Past the last chunk is refused; the cursor never moves back.
    expect(store.sent(id, 3)).toBe(false);
    expect(store.sent(id, 1)).toBe(true);
    expect(store.sent(id, 0)).toBe(false);
    expect(row()).toMatchObject({ sent: 1, attempts: 0 });
    expect(store.retry(id, 5)).toBe(true);
    expect(row()).toMatchObject({ sent: 1, attempts: 1 });
    expect(store.sent(id, 2)).toBe(true);
    store.finish(id);
    expect(store.sent(id, 2)).toBe(false);
    expect(store.retry(id, 5)).toBe(false);
  } finally {
    store.close();
  }
});
