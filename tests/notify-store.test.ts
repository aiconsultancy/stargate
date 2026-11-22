import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  Destination,
  NotificationInput,
  Source,
} from "../src/notifications/ingest/model";
import { NotifyStore } from "../src/notifications/ingest/store";

const root = process.env["TMPDIR"] ?? "/home/jack/.cache/tmp/opencode";
const directories: string[] = [];
const stores: NotifyStore[] = [];
function fixture(limits: ConstructorParameters<typeof NotifyStore>[1] = {}) {
  const directory = mkdtempSync(join(root, "notify-store-"));
  directories.push(directory);
  const path = join(directory, "notify.sqlite");
  const store = new NotifyStore(path, limits);
  stores.push(store);
  return { path, store };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const source: Source = {
  adapter: "http",
  principal: "ci",
  audience: "internal",
  topics: ["release.*"],
};
const destination: Destination = {
  transport: "slack",
  registrationId: "pegasus",
  appId: "AONE",
  workspaceId: "TONE",
  botUserId: "UONE",
  channel: "CONE",
  audience: "internal",
};
const input = (title = "Ready"): NotificationInput => ({
  schema: 1,
  topic: "release.desktop",
  occurredAt: "2026-11-19T02:00:00Z",
  payload: { title },
});
function rows(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    return {
      outbox: db.query("SELECT * FROM notify_outbox ORDER BY id").all(),
      dedup: db.query("SELECT * FROM notify_dedup ORDER BY rowid").all(),
    };
  } finally {
    db.close();
  }
}

test("dedup precedes full capacities and resolution, including zero matches", () => {
  const { store, path } = fixture({ outboxRows: 1, dedupRecords: 1 });
  const accepted = store.admit(
    source,
    input(),
    () => [destination, { ...destination }],
    100,
  );
  expect(accepted.duplicate).toBe(false);
  expect(
    store.admit(
      source,
      input(),
      () => {
        throw new Error("must not resolve duplicates");
      },
      200,
    ),
  ).toEqual({ ...accepted, duplicate: true });
  expect(rows(path).outbox).toHaveLength(1);
  expect(() =>
    store.admit(
      source,
      input("new"),
      () => [{ ...destination, channel: "CTWO" }],
      201,
    ),
  ).toThrow();
  expect(rows(path).dedup).toHaveLength(1);
  const zero = fixture({ dedupRecords: 1 });
  const empty = zero.store.admit(source, input(), () => [], 100);
  expect(zero.store.admit(source, input(), () => [destination], 200)).toEqual({
    ...empty,
    duplicate: true,
  });
  expect(rows(zero.path).outbox).toHaveLength(0);
  expect(rows(zero.path).dedup).toHaveLength(1);
});

test.each(["dedup", "fanout", "eviction"])(
  "%s write failure rolls back full transaction",
  (point) => {
    const { store, path } = fixture({ perDestination: 1 });
    store.admit(source, input("old"), () => [destination], 100);
    const before = rows(path);
    const db = new Database(path);
    try {
      const trigger =
        point === "dedup"
          ? "CREATE TRIGGER fail AFTER INSERT ON notify_dedup BEGIN SELECT RAISE(ABORT,'test'); END"
          : point === "fanout"
            ? "CREATE TRIGGER fail AFTER INSERT ON notify_outbox WHEN json_extract(NEW.destination,'$.channel')='CTWO' BEGIN SELECT RAISE(ABORT,'test'); END"
            : "CREATE TRIGGER fail AFTER DELETE ON notify_outbox BEGIN SELECT RAISE(ABORT,'test'); END";
      db.exec(trigger);
      expect(() =>
        store.admit(
          source,
          input("new"),
          () => [destination, { ...destination, channel: "CTWO" }],
          200,
        ),
      ).toThrow();
      expect(rows(path)).toEqual(before);
    } finally {
      db.close();
    }
  },
);

test("global capacity failure restores tentative pending eviction", () => {
  const { store, path } = fixture({ perDestination: 1, outboxRows: 1 });
  store.admit(source, input("old"), () => [destination], 100);
  const before = rows(path);
  expect(() =>
    store.admit(
      source,
      input("new"),
      () => [destination, { ...destination, channel: "CTWO" }],
      200,
    ),
  ).toThrow();
  expect(rows(path)).toEqual(before);
});

test("pending oldest eviction preserves leased rows and all-leased refuses", () => {
  const { store, path } = fixture({ perDestination: 2 });
  store.admit(source, input("active"), () => [destination], 100);
  const claim = store.claim(100);
  expect(claim?.attempts).toBe(1);
  if (!claim) throw new Error("expected claim");
  store.admit(source, input("pending-old"), () => [destination], 101);
  store.admit(source, input("pending-new"), () => [destination], 102);
  expect(rows(path).outbox).toHaveLength(2);
  const db = new Database(path, { readonly: true });
  try {
    expect(
      db
        .query<{ title: string }, []>(
          "SELECT json_extract(payload,'$.title') AS title FROM notify_outbox ORDER BY id",
        )
        .all(),
    ).toEqual([{ title: "active" }, { title: "pending-new" }]);
  } finally {
    db.close();
  }
  expect(store.claim(100000)).toBeUndefined();
  expect(() => store.recover(100000)).toThrow();
  expect(() => store.close()).toThrow();
  store.settle(claim, { state: "sent" }, 100001);
  const one = fixture({ perDestination: 1 });
  one.store.admit(source, input(), () => [destination], 100);
  const leased = one.store.claim(100);
  if (!leased) throw new Error("expected claim");
  const before = rows(one.path);
  expect(() =>
    one.store.admit(source, input("new"), () => [destination], 101),
  ).toThrow();
  expect(rows(one.path)).toEqual(before);
  one.store.settle(leased, { state: "refused", retryable: false }, 102);
});

test("dedup retention protects outstanding events and permits bounded late copies", () => {
  const { store, path } = fixture({ dedupRecords: 1, dedupMs: 100 });
  const event = input();
  store.admit(source, event, () => [destination], 100);
  expect(() => store.admit(source, input("next"), () => [], 250)).toThrow();
  expect(rows(path).dedup).toHaveLength(1);
  const claim = store.claim(250);
  if (!claim) throw new Error("expected claim");
  store.settle(claim, { state: "sent" }, 251);
  store.claim(252);
  expect(rows(path).dedup).toHaveLength(0);
  expect(store.admit(source, event, () => [], 253).duplicate).toBe(false);
  expect(store.admit(source, input("newer"), () => [], 254).duplicate).toBe(
    false,
  );
  expect(rows(path).dedup).toHaveLength(1);
});

test("claims persist attempts, isolate destinations, honor RetryAfter and stop at age/attempt bounds", () => {
  const { store, path } = fixture();
  store.admit(
    source,
    input(),
    () => [destination, { ...destination, channel: "CTWO" }],
    100,
  );
  const first = store.claim(100);
  const second = store.claim(100);
  if (!first || !second) throw new Error("two destinations must progress");
  expect(first.destination.channel).not.toBe(second.destination.channel);
  store.settle(
    first,
    { state: "refused", retryable: true, retryAfterMs: 10000 },
    101,
  );
  store.settle(second, { state: "sent" }, 102);
  expect(store.claim(10100)).toBeUndefined();
  const retry = store.claim(10101);
  expect(retry?.attempts).toBe(2);
  if (!retry) throw new Error("retry due");
  store.settle(retry, { state: "unknown" }, 10102);
  expect(store.claim(12101)).toBeUndefined();
  const third = store.claim(12102);
  expect(third?.attempts).toBe(3);
  if (!third) throw new Error("third due");
  store.settle(third, { state: "unknown" }, 12103);
  expect(rows(path).outbox).toHaveLength(0);
  expect(store.claim(999999)).toBeUndefined();
  const aged = fixture({ maxAgeMs: 100 });
  aged.store.admit(source, input(), () => [destination], 100);
  expect(aged.store.claim(200)).toBeUndefined();
  expect(rows(aged.path).outbox).toHaveLength(0);
});

test("fractional RetryAfter rounds up and remains due-safe after reopen", () => {
  const { store, path } = fixture();
  store.admit(source, input(), () => [destination], 100);
  const first = store.claim(100);
  if (!first) throw new Error("expected first claim");
  store.settle(
    first,
    { state: "refused", retryable: true, retryAfterMs: 10000.5 },
    101,
  );
  store.close();
  const reopened = new NotifyStore(path);
  stores.push(reopened);
  reopened.recover(200);
  expect(rows(path).outbox[0]).toMatchObject({ nextAt: 10102, attempts: 1 });
  expect(reopened.claim(10101)).toBeUndefined();
  const retry = reopened.claim(10102);
  if (!retry) throw new Error("expected retry at rounded deadline");
  expect(retry.attempts).toBe(2);
  reopened.settle(retry, { state: "sent" }, 10103);
});

test.each(["attempts", "age"])(
  "restart drops %s-exhausted durable rows without another claim",
  (bound) => {
    const { store, path } = fixture(bound === "age" ? { maxAgeMs: 100 } : {});
    store.admit(source, input(), () => [destination], 100);
    store.close();
    const db = new Database(path);
    try {
      db.query(
        "UPDATE notify_outbox SET state='leased',attempts=?,leaseEnd=60100",
      ).run(bound === "attempts" ? 3 : 1);
    } finally {
      db.close();
    }
    const reopened = new NotifyStore(
      path,
      bound === "age" ? { maxAgeMs: 100 } : {},
    );
    stores.push(reopened);
    reopened.recover(200);
    expect(reopened.claim(200)).toBeUndefined();
    expect(rows(path).outbox).toHaveLength(0);
    expect(rows(path).dedup).toHaveLength(1);
    expect(reopened.counters.dropped).toBe(1);
  },
);

test("private database and sidecars precede SQLite WAL, even with permissive umask", () => {
  const old = process.umask(0);
  try {
    const { path } = fixture();
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(lstatSync(`${path}-wal`).mode & 0o777).toBe(0o600);
    expect(lstatSync(`${path}-shm`).mode & 0o777).toBe(0o600);
  } finally {
    process.umask(old);
  }
});

test("unknown versions and corrupt databases preserve bytes, symlinks refuse", () => {
  const directory = mkdtempSync(join(root, "notify-refuse-"));
  directories.push(directory);
  for (const name of ["unknown", "corrupt"]) {
    const path = join(directory, name);
    if (name === "unknown") {
      const db = new Database(path);
      db.exec(
        "PRAGMA user_version=99; CREATE TABLE precious(value TEXT); INSERT INTO precious VALUES('keep')",
      );
      db.close();
    } else writeFileSync(path, "not a SQLite database");
    const before = readFileSync(path);
    expect(() => new NotifyStore(path)).toThrow();
    expect(readFileSync(path)).toEqual(before);
  }
  const target = join(directory, "target");
  writeFileSync(target, "keep");
  const link = join(directory, "link");
  symlinkSync(target, link);
  expect(() => new NotifyStore(link)).toThrow();
  expect(readFileSync(target, "utf8")).toBe("keep");
  const side = join(directory, "side.sqlite");
  writeFileSync(side, "");
  symlinkSync(target, `${side}-wal`);
  expect(() => new NotifyStore(side)).toThrow();
  const linkedDirectory = join(directory, "linked");
  const realDirectory = join(directory, "real");
  mkdirSync(realDirectory);
  chmodSync(realDirectory, 0o700);
  symlinkSync(realDirectory, linkedDirectory);
  expect(
    () => new NotifyStore(join(linkedDirectory, "notify.sqlite")),
  ).toThrow();
});

test("corrupt persisted payload refuses startup before any recovery write", () => {
  const { store, path } = fixture();
  store.admit(source, input(), () => [destination], 100);
  store.close();
  const db = new Database(path);
  db.exec("UPDATE notify_outbox SET payload='not JSON'");
  db.close();
  const before = readFileSync(path);
  expect(() => {
    const reopened = new NotifyStore(path);
    reopened.close();
  }).toThrow();
  expect(readFileSync(path)).toEqual(before);
});
