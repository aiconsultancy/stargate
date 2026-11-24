import { Result, Schema } from "effect";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type NotificationInput,
  NotificationStore,
  notificationInputSchema,
} from "../src/notifications/preferences/notification-store";

const now = Date.parse("2026-11-17T12:00:00Z");
const until = "2026-11-17T13:00:00.000Z";
const deadline = Date.parse(until);

const thread = {
  scope: "thread",
  channel: "C123",
  thread_ts: "1794922711.668079",
} as const;

const channel = { scope: "channel", channel: "C123" } as const;
const stores: NotificationStore[] = [];
const directories: string[] = [];

function open(path = ":memory:") {
  const store = new NotificationStore(path);
  stores.push(store);

  return store;
}

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "stargate-notifications-"));
  directories.push(directory);

  return join(directory, "private", "notifications.sqlite");
}

function operate(
  store: NotificationStore,
  input: NotificationInput,
  id = "op-1",
  time = now,
  registration = "captain-a",
) {
  return store.operate(registration, input, {
    id,
    caller: "captain-session-a",
    now: time,
  });
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("notificationInputSchema", () => {
  test("accepts explicit targets and normalizes equivalent offset instants", () => {
    for (const target of [thread, channel]) {
      expect(
        Schema.decodeUnknownSync(notificationInputSchema)({
          op: "status",
          ...target,
        }),
      ).toEqual({
        op: "status",
        ...target,
      });
      expect(
        Schema.decodeUnknownSync(notificationInputSchema)({
          op: "mute",
          ...target,
          mute_until: "2026-11-17T15:00:00+02:00",
        }),
      ).toEqual({ op: "mute", ...target, mute_until: until });
      expect(
        Result.isSuccess(
          Schema.decodeUnknownResult(notificationInputSchema)({
            op: "unmute",
            ...target,
          }),
        ),
      ).toBe(true);
    }

    expect(
      Schema.decodeUnknownSync(notificationInputSchema)({ op: "list" }),
    ).toEqual({
      op: "list",
    });
    expect(
      Schema.decodeUnknownSync(notificationInputSchema)({ op: "clear_all" }),
    ).toEqual({
      op: "clear_all",
    });
  });

  test("rejects missing/wrong scopes, DMs, wildcards, timestamps and extras", () => {
    for (const input of [
      { op: "mute" },
      { op: "mute", channel: "C123", thread_ts: thread.thread_ts },
      { op: "mute", ...thread, scope: "all" },
      { op: "mute", scope: "thread", channel: "C123" },
      { op: "status", ...channel, thread_ts: thread.thread_ts },
      { op: "unmute", ...channel, channel: "D123" },
      { op: "mute", ...channel, channel: "*" },
      { op: "mute", ...channel, channel: "C123*" },
      { op: "status", ...thread, thread_ts: "1" },
      { op: "status", ...thread, thread_ts: "1.1234567" },
      { op: "status", ...thread, thread_ts: "12345678901234567.1" },
      { op: "status", ...thread, thread_ts: "1.a" },
      { op: "mute", ...thread, reason: "x".repeat(201) },
      { op: "status", ...thread, reason: "not supported" },
      { op: "clear_all", ...channel },
      { op: "list", ...channel },
      { op: "mute", ...channel, registration: "captain-b" },
      { op: "mute", ...channel, caller: "other" },
      { op: "mute", ...channel, configPath: "/secret" },
      { op: "mute", ...channel, sessionID: "other" },
    ]) {
      expect(
        Result.isSuccess(
          Schema.decodeUnknownResult(notificationInputSchema)(input),
        ),
      ).toBe(false);
    }

    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(notificationInputSchema)({
          op: "mute",
          ...thread,
          thread_ts: "1234567890123456.123456",
        }),
      ),
    ).toBe(true);
  });

  test("rejects invalid/timezone-free expiries and expiry on non-mute ops", () => {
    for (const value of [
      "17:00",
      "2026-11-17T13:00:00",
      "2026-11-17",
      "2026-02-30T13:00:00Z",
      "2026-11-17T25:00:00Z",
      "2026-11-17T13:00:00+99:00",
      "Infinity",
      "2026-11-17T13:00Z",
    ]) {
      expect(
        Result.isSuccess(
          Schema.decodeUnknownResult(notificationInputSchema)({
            op: "mute",
            ...channel,
            mute_until: value,
          }),
        ),
      ).toBe(false);
    }

    for (const input of [
      { op: "unmute", ...channel },
      { op: "status", ...thread },
      { op: "list" },
      { op: "clear_all" },
    ]) {
      expect(
        Result.isSuccess(
          Schema.decodeUnknownResult(notificationInputSchema)({
            ...input,
            mute_until: until,
          }),
        ),
      ).toBe(false);
    }
  });
});

describe("NotificationStore", () => {
  test("absent settings preserve normal delivery", () => {
    const store = open();
    expect(
      store.status("captain-a", thread.channel, thread.thread_ts, now),
    ).toEqual({
      mode: "normal",
      channel: { state: "absent", mute_until: null },
      thread: { state: "absent", mute_until: null },
    });
    expect(operate(store, { op: "status", ...thread })).toMatchObject({
      target: thread,
      current: { mode: "normal" },
    });
  });

  test("isolates registration, channel and thread", () => {
    const store = open();
    operate(store, { op: "mute", ...thread });
    expect(store.status("captain-a", "C123", thread.thread_ts, now).mode).toBe(
      "addressed-only",
    );

    for (const [registration, targetChannel, targetThread] of [
      ["captain-b", "C123", thread.thread_ts],
      ["captain-a", "G123", thread.thread_ts],
      ["captain-a", "C123", "1794922711.1"],
    ]) {
      expect(
        store.status(registration ?? "", targetChannel ?? "", targetThread, now)
          .mode,
      ).toBe("normal");
    }

    expect(
      operate(store, { op: "list" }, "read", now, "captain-b"),
    ).toMatchObject({
      settings: [],
    });
  });

  test("expiry is strict, retained, normalized and independent by scope", () => {
    const store = open();
    operate(store, {
      op: "mute",
      ...thread,
      mute_until: "2026-11-17T15:00:00+02:00",
    });
    expect(
      store.status("captain-a", "C123", thread.thread_ts, deadline - 1),
    ).toMatchObject({
      mode: "addressed-only",
      thread: { state: "active", mute_until: until },
    });

    for (const time of [deadline, deadline + 1]) {
      expect(
        store.status("captain-a", "C123", thread.thread_ts, time),
      ).toMatchObject({
        mode: "normal",
        thread: { state: "expired", mute_until: until },
      });
    }

    operate(store, { op: "mute", ...channel }, "channel-mute");
    expect(
      store.status("captain-a", "C123", thread.thread_ts, deadline),
    ).toMatchObject({
      mode: "addressed-only",
      channel: { state: "active", mute_until: null },
      thread: { state: "expired", mute_until: until },
    });
    expect(operate(store, { op: "list" }, "read", deadline)).toMatchObject({
      settings: [
        { setting: { state: "active" } },
        { setting: { state: "expired" } },
      ],
    });
  });

  test("rejects elapsed deadline at commit rather than schema parse", () => {
    const store = open();

    const input = Schema.decodeUnknownSync(notificationInputSchema)({
      op: "mute",
      ...thread,
      mute_until: until,
    });

    for (const time of [deadline, deadline + 1]) {
      expect(() => operate(store, input, "expired", time)).toThrow(
        "Notification mute expiry has elapsed.",
      );
    }

    expect(store.status("captain-a", "C123", thread.thread_ts, now).mode).toBe(
      "normal",
    );
    expect(operate(store, input, "expired", now)).toMatchObject({
      replay: false,
    });
  });

  test("unmuting thread cannot override channel; unmuting channel leaves thread", () => {
    const store = open();
    operate(store, { op: "mute", ...channel }, "channel");
    operate(store, { op: "mute", ...thread }, "thread");
    expect(
      operate(store, { op: "unmute", ...thread }, "unthread"),
    ).toMatchObject({
      changed: true,
      current: {
        mode: "addressed-only",
        channel: { state: "active" },
        thread: { state: "absent" },
      },
    });
    operate(store, { op: "mute", ...thread }, "remute");
    expect(
      operate(store, { op: "unmute", ...channel }, "unchannel"),
    ).toMatchObject({
      current: { mode: "normal", channel: { state: "absent" } },
    });
    expect(
      store.status("captain-a", "C123", thread.thread_ts, now),
    ).toMatchObject({
      mode: "addressed-only",
      thread: { state: "active" },
    });
  });

  test("new mute replaces timed settings; intentional repeats are no-change", () => {
    const store = open();
    operate(store, { op: "mute", ...thread, mute_until: until });
    expect(
      operate(store, { op: "mute", ...thread }, "indefinite"),
    ).toMatchObject({ changed: true });
    expect(
      store.status("captain-a", "C123", thread.thread_ts, deadline),
    ).toMatchObject({
      thread: { state: "active", mute_until: null },
    });
    expect(operate(store, { op: "mute", ...thread }, "again")).toMatchObject({
      changed: false,
      replay: false,
    });
    operate(store, { op: "unmute", ...thread }, "unmute");
    expect(
      operate(store, { op: "unmute", ...thread }, "again-unmute"),
    ).toMatchObject({ changed: false });
  });

  test("captures injected clock once after acquiring the write lock, including stale retries", () => {
    const path = databasePath();
    const store = open(path);
    const probe = new Database(path);
    probe.exec("PRAGMA busy_timeout = 0");
    let time = deadline - 1;
    let calls = 0;

    const clock = () => {
      calls++;
      let locked = false;

      try {
        probe.exec("BEGIN IMMEDIATE");
        probe.exec("ROLLBACK");
      } catch {
        locked = true;
      }

      expect(locked).toBe(true);

      return time;
    };

    const input = { op: "mute", ...thread, mute_until: until } as const;
    const context = { id: "timed", caller: "captain-session-a", now: clock };

    try {
      const first = store.operate("captain-a", input, context);
      expect(calls).toBe(1);
      expect(first).toMatchObject({
        receipt: {
          at: deadline - 1,
          snapshot: { thread: { state: "active" } },
        },
        current: { thread: { state: "active" } },
      });
      time = deadline;
      expect(() =>
        store.operate("captain-a", input, { ...context, id: "late" }),
      ).toThrow("Notification mute expiry has elapsed.");
      expect(calls).toBe(2);
      time = deadline + 1;
      const replay = store.operate("captain-a", input, context);
      expect(calls).toBe(3);
      expect(replay).toMatchObject({
        replay: true,
        current: {
          mode: "normal",
          thread: { state: "expired", mute_until: until },
        },
      });
      expect(replay).toHaveProperty("receipt", Reflect.get(first, "receipt"));
      expect(
        probe
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM notification_receipts",
          )
          .get()?.count,
      ).toBe(1);
    } finally {
      probe.close();
    }
  });

  test("read operations evaluate the injected clock for each read", () => {
    const store = open();
    operate(store, { op: "mute", ...thread, mute_until: until });
    let calls = 0;

    const context = {
      id: "read",
      caller: "captain-session-a",
      now: () => {
        calls++;

        return deadline;
      },
    };

    expect(
      store.operate("captain-a", { op: "status", ...thread }, context),
    ).toMatchObject({
      current: { mode: "normal", thread: { state: "expired" } },
    });
    expect(calls).toBe(1);
    expect(store.operate("captain-a", { op: "list" }, context)).toMatchObject({
      settings: [{ setting: { state: "expired" } }],
    });
    expect(calls).toBe(2);
  });

  test("old mute retry returns original receipt plus current absent state", () => {
    const store = open();

    const input = {
      op: "mute",
      ...thread,
      mute_until: until,
      reason: "handoff",
    } as const;

    const first = operate(store, input);
    operate(store, { op: "unmute", ...thread }, "unmute");
    const replay = operate(store, input, "op-1", deadline + 1);
    expect(replay).toMatchObject({
      replay: true,
      changed: true,
      current: { mode: "normal", thread: { state: "absent" } },
    });
    expect(replay).toHaveProperty("receipt", Reflect.get(first, "receipt"));
  });

  test("retry after expiry never extends deadline and newer setting wins", () => {
    const store = open();
    const input = { op: "mute", ...thread, mute_until: until } as const;
    operate(store, input);
    expect(operate(store, input, "op-1", deadline)).toMatchObject({
      replay: true,
      current: {
        mode: "normal",
        thread: { state: "expired", mute_until: until },
      },
    });
    operate(store, { op: "mute", ...thread }, "new", deadline);
    expect(operate(store, input, "op-1", deadline + 1)).toMatchObject({
      replay: true,
      current: { thread: { state: "active", mute_until: null } },
    });
  });

  test("same-ID mismatches fail safely and IDs remain registration scoped", () => {
    const store = open();
    operate(store, { op: "mute", ...thread });

    for (const input of [
      { op: "unmute", ...thread },
      { op: "mute", ...channel },
      { op: "mute", ...thread, reason: "secret reason" },
    ] as const) {
      expect(() => operate(store, input)).toThrow(
        "Notification operation identity conflict.",
      );
    }

    expect(() =>
      store.operate(
        "captain-a",
        { op: "mute", ...thread },
        {
          id: "op-1",
          caller: "another-caller",
          now,
        },
      ),
    ).toThrow("Notification operation identity conflict.");
    expect(
      operate(store, { op: "mute", ...thread }, "op-1", now, "captain-b"),
    ).toMatchObject({ replay: false });
    expect(store.status("captain-a", "C123", thread.thread_ts, now).mode).toBe(
      "addressed-only",
    );
  });

  test("clear_all counts expired and active settings and preserves other owner", () => {
    const store = open();
    operate(store, { op: "mute", ...thread, mute_until: until }, "thread");
    operate(store, { op: "mute", ...channel }, "channel");
    operate(store, { op: "mute", ...channel }, "channel", now, "captain-b");
    expect(
      operate(
        store,
        { op: "clear_all", reason: "operator request" },
        "clear",
        deadline,
      ),
    ).toMatchObject({
      replay: false,
      changed: true,
      cleared: { thread: 1, channel: 1 },
      current: { settings: [], counts: { thread: 0, channel: 0 } },
    });
    expect(store.status("captain-b", "C123", undefined, deadline).mode).toBe(
      "addressed-only",
    );
    expect(
      operate(store, { op: "clear_all" }, "clear-again", deadline),
    ).toMatchObject({
      changed: false,
      cleared: { thread: 0, channel: 0 },
    });
  });

  test("replaying old clear cannot remove newer mute", () => {
    const store = open();
    operate(store, { op: "mute", ...thread });
    const first = operate(store, { op: "clear_all" }, "clear");
    operate(store, { op: "mute", ...channel }, "new");
    const replay = operate(store, { op: "clear_all" }, "clear", now + 1);
    expect(replay).toHaveProperty("receipt", Reflect.get(first, "receipt"));
    expect(replay).toMatchObject({
      replay: true,
      cleared: { thread: 1, channel: 0 },
      current: {
        settings: [{ target: channel, setting: { state: "active" } }],
      },
    });
    expect(store.status("captain-a", "C123", undefined, now).mode).toBe(
      "addressed-only",
    );
  });

  test("persists preferences and audit receipts through close/reopen", () => {
    const path = databasePath();
    const first = open(path);

    const input = {
      op: "mute",
      ...thread,
      mute_until: until,
      reason: "handoff",
    } as const;

    const result = operate(first, input);
    first.close();
    stores.splice(stores.indexOf(first), 1);
    const second = open(path);
    expect(operate(second, input, "op-1", deadline)).toMatchObject({
      replay: true,
      current: { thread: { state: "expired", mute_until: until } },
    });
    expect(operate(second, input, "op-1", deadline)).toHaveProperty(
      "receipt",
      Reflect.get(result, "receipt"),
    );
    const db = new Database(path);

    try {
      expect(
        db
          .query("SELECT action,caller,at,reason FROM notification_receipts")
          .get(),
      ).toEqual({
        action: "mute",
        caller: "captain-session-a",
        at: now,
        reason: "handoff",
      });
    } finally {
      db.close();
    }
  });

  test("creates private files/directory and repairs existing file permissions", () => {
    const path = databasePath();
    open(path);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);

    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }

    chmodSync(path, 0o644);
    open(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("rejects symlink/non-file database targets with fixed safe errors", () => {
    const path = databasePath();
    mkdirSync(dirname(path), { recursive: true });
    const target = join(dirname(path), "secret.sqlite");
    writeFileSync(target, "private data");
    symlinkSync(target, path);
    expect(() => new NotificationStore(path)).toThrow(
      "Notification store unavailable.",
    );
    expect(() => new NotificationStore(dirname(path))).toThrow(
      "Notification store unavailable.",
    );
  });

  test("validates mutation identities, registrations, times and read targets", () => {
    const store = open();

    for (const change of [
      { id: "" },
      { id: " " },
      { id: "x".repeat(256) },
      { caller: "" },
      { caller: " " },
      { caller: "x".repeat(257) },
      { now: Number.NaN },
      { now: Infinity },
      { now: 1.5 },
    ]) {
      expect(() =>
        store.operate(
          "captain-a",
          { op: "mute", ...thread },
          {
            id: "valid",
            caller: "valid",
            now,
            ...change,
          },
        ),
      ).toThrow("Invalid notification request.");
    }

    for (const registration of ["", " ", "x".repeat(2049)]) {
      expect(() => store.status(registration, "C123", undefined, now)).toThrow(
        "Invalid notification request.",
      );
    }

    expect(() => store.status("captain-a", "D123", undefined, now)).toThrow(
      "Invalid notification request.",
    );
    expect(() => store.status("captain-a", "C123", "bad", now)).toThrow(
      "Invalid notification request.",
    );
    expect(operate(store, { op: "list" })).toMatchObject({ settings: [] });
  });

  test("lists bounded keyset pages and rejects invalid/cross-registration cursor", () => {
    const store = open();

    for (let index = 0; index < 52; index++) {
      operate(
        store,
        {
          op: "mute",
          scope: "channel",
          channel: `C${index.toString().padStart(3, "0")}`,
        },
        `mute-${index}`,
      );
    }

    const first = operate(store, { op: "list" });

    if (first.op !== "list" || first.cursor === null) {
      throw new Error("Missing list cursor");
    }

    expect(first.settings).toHaveLength(50);
    operate(
      store,
      { op: "unmute", scope: "channel", channel: "C000" },
      "remove-before-cursor",
    );
    const second = operate(store, { op: "list", cursor: first.cursor });
    expect(second).toMatchObject({
      settings: [
        { target: { channel: "C050" } },
        { target: { channel: "C051" } },
      ],
      cursor: null,
    });

    for (const cursor of ["invalid", "e30", "a".repeat(1025)]) {
      expect(() => operate(store, { op: "list", cursor })).toThrow(
        "Invalid notification request.",
      );
    }

    expect(() =>
      operate(
        store,
        { op: "list", cursor: first.cursor ?? "" },
        "read",
        now,
        "captain-b",
      ),
    ).toThrow("Invalid notification request.");
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(notificationInputSchema)({
          op: "list",
          cursor: "",
        }),
      ),
    ).toBe(false);
  });

  test("receipt write failure rolls back mute and clear_all with no partial change", () => {
    const path = databasePath();
    const store = open(path);
    operate(store, { op: "mute", ...channel }, "channel");
    operate(store, { op: "mute", ...thread }, "thread");
    const db = new Database(path);

    try {
      db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON notification_receipts
        BEGIN SELECT RAISE(ABORT, 'secret sqlite failure'); END;`);
      expect(() => operate(store, { op: "clear_all" }, "clear")).toThrow(
        "Notification store operation failed.",
      );
      expect(operate(store, { op: "list" })).toMatchObject({
        counts: { thread: 1, channel: 1 },
      });
      expect(() =>
        operate(
          store,
          { op: "mute", scope: "channel", channel: "C999" },
          "fail-mute",
        ),
      ).toThrow("Notification store operation failed.");
      expect(store.status("captain-a", "C999", undefined, now).mode).toBe(
        "normal",
      );
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM notification_receipts",
          )
          .get()?.count,
      ).toBe(2);
      db.exec("DROP TRIGGER fail_receipt");
      expect(operate(store, { op: "clear_all" }, "clear")).toMatchObject({
        replay: false,
        cleared: { thread: 1, channel: 1 },
      });
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM notification_receipts",
          )
          .get()?.count,
      ).toBe(3);
    } finally {
      db.close();
    }
  });
});
