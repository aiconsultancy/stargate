import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronStore } from "../src/automation/cron/store";

const now = Date.parse("2026-01-01T00:00:00Z");
const scope = { botKey: "bot", channel: "C123", user: "U123" };

const input = {
  name: "Report",
  expression: "* * * * *",
  timezone: "UTC",
  prompt: "Prepare report.",
};

const stores: CronStore[] = [];
const directories: string[] = [];

function open(path = ":memory:") {
  const store = new CronStore(path);
  stores.push(store);

  return store;
}

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "stargate-cron-"));
  directories.push(directory);

  return join(directory, "cron.sqlite");
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CronStore", () => {
  test("persists private schedules, UUIDs, and stable ten-item pages", () => {
    const path = databasePath();
    const first = open(path);

    for (let index = 0; index < 12; index++) {
      first.add(scope, { ...input, name: `Report ${index}` }, now + index);
    }

    const store = open(path);
    const page = store.list(scope);
    expect(page).toHaveLength(10);
    expect(store.list(scope, 1)).toHaveLength(2);
    expect(store.list(scope)).toEqual(page);
    expect(page[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}-shm`).mode & 0o777).toBe(0o600);
  });

  test("enforces ownership for listing and removal", () => {
    const store = open();
    const schedule = store.add(scope, input, now);

    for (const change of [
      { botKey: "other" },
      { channel: "C999" },
      { user: "U999" },
    ]) {
      expect(store.list({ ...scope, ...change })).toEqual([]);
      expect(store.remove({ ...scope, ...change }, schedule.id)).toBe(false);
    }

    expect(store.remove(scope, "invalid")).toBe(false);
    expect(store.remove(scope, schedule.id)).toBe(true);
    expect(store.remove(scope, schedule.id)).toBe(false);
    expect(store.list(scope)).toEqual([]);
  });

  test("validates add, scope, and page; submission IDs deduplicate per owner", () => {
    const store = open();
    const first = store.add(scope, input, now, "view-1");
    expect(store.add(scope, input, now + 1000, "view-1").id).toBe(first.id);
    expect(store.list(scope)).toHaveLength(1);
    expect(
      store.add({ ...scope, user: "U999" }, input, now, "view-1").id,
    ).not.toBe(first.id);
    expect(() => store.add(scope, { ...input, prompt: "" }, now)).toThrow();
    expect(() => store.add({ ...scope, user: "" }, input, now)).toThrow();
    expect(() => store.list(scope, -1)).toThrow();
    expect(() => store.list(scope, 0.5)).toThrow();
  });

  test("claims and advances atomically, coalesces downtime, isolates bots", () => {
    const path = databasePath();
    const first = open(path);
    first.add(scope, input, now);
    first.add({ ...scope, botKey: "other" }, input, now);
    const second = open(path);
    const later = now + 24 * 60 * 60_000;
    const claimed = first.claimDue(scope.botKey, later);
    expect(claimed).toHaveLength(1);
    expect(second.claimDue(scope.botKey, later)).toEqual([]);
    expect(first.list(scope)[0]?.nextAt).toBe(later + 60_000);
    expect(first.pending(scope.botKey)).toHaveLength(1);
    expect(first.claimDue("other", later)).toHaveLength(1);
    // Still-running work suppresses another occurrence without postponing
    // NextAt forever or accumulating one row for each missed minute.
    expect(second.claimDue(scope.botKey, later + 60_000)).toEqual([]);
    expect(first.list(scope)[0]?.nextAt).toBe(later + 120_000);
  });

  test("terminal completion permits future claims; removing cancels pending", () => {
    const store = open();
    const schedule = store.add(scope, input, now);
    const run = store.claimDue(scope.botKey, now + 60_000)[0];

    if (!run) {
      throw new Error("Expected due run");
    }

    expect(store.announcing(run.id)).toBe(true);
    expect(store.announced(run.id, "1.000")).toBe(true);
    store.enqueued(run.id, 7);
    expect(store.queued(scope.botKey)[0]?.jobId).toBe(7);
    store.finish(run.id, "done");
    expect(store.claimDue(scope.botKey, now + 120_000)).toHaveLength(1);
    expect(store.remove(scope, schedule.id)).toBe(true);
    expect(store.pending(scope.botKey)).toEqual([]);
    expect(store.claimDue(scope.botKey, now + 180_000)).toEqual([]);
  });

  test("ambiguous announcing recovery is bot-scoped and never reposts", () => {
    const store = open();

    for (const botKey of [scope.botKey, "other"]) {
      store.add({ ...scope, botKey }, input, now);
      const run = store.claimDue(botKey, now + 60_000)[0];

      if (!run) {
        throw new Error("Expected due run");
      }

      store.announcing(run.id);
    }

    expect(store.recoverAnnouncements(scope.botKey)).toBe(1);
    expect(store.recoverAnnouncements(scope.botKey)).toBe(0);
    expect(store.pending(scope.botKey)).toEqual([]);
    expect(store.recoverAnnouncements("other")).toBe(1);
  });

  test("removal does not undo a queued job", () => {
    const path = databasePath();
    const store = open(path);
    const schedule = store.add(scope, input, now);
    const run = store.claimDue(scope.botKey, now + 60_000)[0];

    if (!run) {
      throw new Error("Expected due run");
    }

    store.announcing(run.id);
    store.announced(run.id, "1.000");
    store.enqueued(run.id, 7);
    expect(store.remove(scope, schedule.id)).toBe(true);
    const db = new Database(path, { readonly: true });

    try {
      expect(
        db.query("SELECT status FROM cron_runs WHERE id=?").get(run.id),
      ).toEqual({ status: "queued" });
    } finally {
      db.close();
    }
  });
});
