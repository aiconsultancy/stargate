import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronStore } from "../src/cron/store";

const now = Date.parse("2026-01-01T00:00:00Z");
const scope = { botKey: "bot", channel: "C123", user: "U123" };

const input = {
  name: "Daily report",
  expression: "* * * * *",
  timezone: "UTC",
  prompt: "Private original prompt.",
};

const source = "/jobs/report.md";
const stores: CronStore[] = [];
const directories: string[] = [];

function open(path = ":memory:") {
  const store = new CronStore(path);
  stores.push(store);

  return store;
}

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "stargate-cronjob-"));
  directories.push(directory);

  return join(directory, "cron.sqlite");
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();

  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("file-backed cron controls", () => {
  test("runtime bindings reject changed configuration without changing schedules", () => {
    const path = databasePath();
    const store = open(path);
    const registration = JSON.stringify(["captain", "A123", "T123", "U123"]);

    const key = JSON.stringify([
      "captain",
      "A123",
      "T123",
      "U123",
      "fingerprint",
    ]);

    const signature = JSON.stringify({
      key,
      root: "/jobs",
      channel: "C123",
      user: "U123",
    });

    const owned = { ...scope, botKey: key };
    store.add(owned, input, now);
    const before = store.list(owned);
    store.bindRuntime(registration, signature);
    const restarted = open(path);
    expect(() =>
      restarted.assertRuntimeBinding(registration, signature, key),
    ).not.toThrow();
    expect(() =>
      restarted.assertRuntimeBinding(registration, "changed", key),
    ).toThrow("restart the gateway");
    expect(restarted.list(owned)).toEqual(before);
    expect(() => restarted.bindRuntime(registration, "x".repeat(8193))).toThrow(
      "Invalid cron runtime binding",
    );
    expect(() => restarted.assertRuntimeBinding("bad", signature, key)).toThrow(
      "Invalid cron runtime binding",
    );
    restarted.bindRuntime(registration, "changed");
    expect(() =>
      store.assertRuntimeBinding(registration, "changed", key),
    ).not.toThrow();
  });

  test("legacy fingerprint changes fail closed without exposing or rekeying old jobs", () => {
    const store = open();
    const tuple = ["captain", "A123", "T123", "U123"];
    const registration = JSON.stringify(tuple);
    const old = { ...scope, botKey: JSON.stringify([...tuple, "old"]) };
    const changed = JSON.stringify([...tuple, "new"]);
    store.add(old, input, now);
    const before = store.list(old);
    expect(() =>
      store.assertRuntimeBinding(registration, "signature", old.botKey),
    ).not.toThrow();
    expect(() =>
      store.assertRuntimeBinding(registration, "signature", changed),
    ).toThrow("Cron gateway configuration differs");
    expect(store.list(old)).toEqual(before);
    expect(store.list({ ...scope, botKey: changed })).toEqual([]);
    const unrelated = JSON.stringify(["other", "A123", "T123", "U123"]);
    expect(() =>
      store.assertRuntimeBinding(unrelated, "signature", "other"),
    ).not.toThrow();
  });

  test("advanced snapshots and metadata survive definition edits and restart", () => {
    const path = databasePath();
    const store = open(path);

    const options = {
      trigger: {
        type: "quota-reset" as const,
        provider: "claude" as const,
        window: "weekly" as const,
      },
      model: "claude/sonnet#high",
      once: false,
      arbiter: "chief",
    };

    const schedule = store.upsertFile(
      scope,
      { ...input, ...options, report: "daily" },
      source,
      false,
      now,
    );

    const accepted = store.claimDue(scope.botKey, schedule.nextAt)[0];

    if (!accepted) throw new Error("Expected advanced clock run");
    expect(accepted).toMatchObject(options);
    expect(store.list(scope)[0]).toMatchObject(options);
    expect(store.report(scope.botKey)[0]).toMatchObject(options);
    expect(store.recentRuns(scope.botKey)[0]).toMatchObject(options);
    expect(
      store.dailyResults(scope.botKey, now, now + 120_000)[0],
    ).toMatchObject(options);
    expect(
      store.add(scope, { ...input, ...options }, now, "advanced-add"),
    ).toMatchObject(options);
    expect(store.add(scope, input, now, "advanced-add")).toMatchObject(options);
    store.upsertFile(scope, input, source, false, now);
    expect(open(path).pending(scope.botKey)[0]).toEqual(accepted);
    expect(
      store.list(scope).find((row) => row.id === schedule.id),
    ).not.toHaveProperty("model");
    expect(store.recentRuns(scope.botKey)[0]).not.toHaveProperty("prompt");
  });

  test("once completion uses the accepted snapshot and never revives after file discovery", () => {
    const path = databasePath();
    const store = open(path);

    const schedule = store.upsertFile(
      scope,
      { ...input, once: true, report: "daily" },
      source,
      false,
      now,
    );

    const run = store.runNow(scope, schedule.id, now);

    if (!run) throw new Error("Expected once run");
    store.upsertFile(scope, input, source, false, now);
    store.finish(run.id, "done", now + 1);
    const restarted = open(path);
    expect(restarted.list(scope)).toEqual([]);
    expect(restarted.enabled(schedule.id, true)).toBe(false);
    restarted.upsertFile(
      scope,
      { ...input, once: true },
      source,
      false,
      now + 2,
    );
    expect(restarted.list(scope)).toEqual([]);
    expect(() => restarted.runNow(scope, schedule.id, now + 2)).toThrow(
      "not found",
    );
    expect(restarted.dailyResults(scope.botKey, now, now + 3)).toMatchObject([
      { id: run.id, status: "done", once: true },
    ]);
  });

  test("failed, blocked and canceled once runs do not consume a schedule", () => {
    const store = open();

    const schedule = store.upsertFile(
      scope,
      { ...input, once: true },
      source,
      false,
      now,
    );

    const failed = store.runNow(scope, schedule.id, now);

    if (!failed) throw new Error("Expected failed run");
    store.finish(failed.id, "failed", now);
    expect(store.enabled(schedule.id)).toBe(true);
    store.finish(failed.id, "done", now + 1);
    expect(store.enabled(schedule.id)).toBe(true);
    const blocked = store.runNow(scope, schedule.id, now + 1);

    if (!blocked) throw new Error("Expected blocked run");
    store.block(blocked.id);
    expect(store.enabled(schedule.id)).toBe(true);
    const dbPath = databasePath();
    const disk = open(dbPath);
    const canceled = disk.add(scope, { ...input, once: true }, now);
    const canceledRun = disk.runNow(scope, canceled.id, now);

    if (!canceledRun) throw new Error("Expected cancelable run");
    const db = new Database(dbPath);

    try {
      db.query("UPDATE cron_runs SET status='canceled' WHERE id=?").run(
        canceledRun.id,
      );
    } finally {
      db.close();
    }

    disk.finish(canceledRun.id, "done", now + 1);
    expect(disk.enabled(canceled.id)).toBe(true);
  });

  test("adding once to a definition cannot change an already accepted run", () => {
    const store = open();
    const schedule = store.upsertFile(scope, input, source, false, now);
    const run = store.runNow(scope, schedule.id, now);

    if (!run) throw new Error("Expected ordinary run");
    store.upsertFile(scope, { ...input, once: true }, source, false, now);
    store.finish(run.id, "done", now + 1);
    expect(store.enabled(schedule.id)).toBe(true);
  });

  test("evaluation receipts survive restart without duplicate claims or metadata leaks", () => {
    const path = databasePath();
    const store = open(path);

    const schedule = store.add(
      scope,
      { ...input, model: "claude/sonnet", report: "daily", once: true },
      now,
    );

    const run = store.runNow(scope, schedule.id, now);

    if (!run) throw new Error("Expected evaluation run");
    expect(store.claimEvaluation(run.id)).toBe(true);
    expect(store.claimEvaluation(run.id)).toBe(false);
    expect(store.runNow(scope, schedule.id, now)).toBeUndefined();
    expect(store.pending(scope.botKey)).toEqual([]);

    const evaluation = {
      text: "Private evaluator result.",
      model: "claude/sonnet",
      verdict: "ignore" as const,
    };

    expect(store.saveEvaluation(run.id, evaluation)).toBe(true);
    const restarted = open(path);
    expect(restarted.pending(scope.botKey)[0]).toEqual({ ...run, evaluation });
    expect(restarted.claimEvaluation(run.id)).toBe(false);
    expect(
      restarted.saveEvaluation(run.id, { ...evaluation, verdict: "act" }),
    ).toBe(false);
    expect(
      restarted.dailyResults(scope.botKey, now, now + 1)[0]?.evaluation,
    ).toEqual(evaluation);
    expect(JSON.stringify(restarted.recentRuns(scope.botKey))).not.toContain(
      evaluation.text,
    );
    restarted.finish(run.id, "done", now + 1);
    expect(restarted.enabled(schedule.id)).toBe(false);
  });

  test("interrupted tools-off evaluations fail per bot without replay and allow later runs", () => {
    const path = databasePath();
    const store = open(path);
    const other = { ...scope, botKey: "other" };

    for (const owner of [scope, other]) {
      const schedule = store.add(owner, { ...input, arbiter: "chief" }, now);
      const run = store.runNow(owner, schedule.id, now);

      if (!run) throw new Error("Expected evaluation run");
      expect(store.claimEvaluation(run.id)).toBe(true);
    }

    const restarted = open(path);
    expect(restarted.recoverEvaluations(scope.botKey)).toBe(1);
    expect(restarted.recoverEvaluations(scope.botKey)).toBe(0);
    expect(restarted.recentRuns(scope.botKey)[0]?.status).toBe("failed");
    expect(restarted.recentRuns("other")[0]?.status).toBe("evaluating");
    const failed = restarted.recentRuns(scope.botKey)[0];

    if (!failed) throw new Error("Expected failed run");
    expect(restarted.claimEvaluation(failed.id)).toBe(false);
    expect(
      restarted.saveEvaluation(failed.id, {
        text: "Late result",
        model: "claude/sonnet",
        verdict: "act",
      }),
    ).toBe(false);
    expect(restarted.runNow(scope, input.name, now + 60_000)).toBeDefined();
  });

  test("evaluation claims recheck availability and manual pause ownership", () => {
    const store = open();

    const schedule = store.upsertFile(
      scope,
      { ...input, model: "claude/sonnet" },
      source,
      true,
      now,
    );

    const run = store.runNow(scope, schedule.id, now);

    if (!run) throw new Error("Expected paused manual run");
    store.fileAvailability(scope.botKey, []);
    expect(store.claimEvaluation(run.id)).toBe(false);
    store.fileAvailability(scope.botKey, [source]);
    expect(store.claimEvaluation(run.id)).toBe(true);
    expect(() =>
      store.saveEvaluation(run.id, {
        text: "x".repeat(12_001),
        model: "claude/sonnet",
        verdict: "act",
      }),
    ).toThrow("Invalid cron evaluation state");
    store.block(run.id);
    expect(store.recentRuns(scope.botKey)[0]?.status).toBe("blocked");
  });

  test("corrupt options, accepted snapshots and evaluation receipts fail closed", () => {
    const path = databasePath();
    const store = open(path);
    const schedule = store.add(scope, input, now);
    const run = store.runNow(scope, schedule.id, now);

    if (!run) throw new Error("Expected run");
    const db = new Database(path);

    try {
      db.query("UPDATE cron_schedules SET options=? WHERE id=?").run(
        '{"once":1}',
        schedule.id,
      );
      expect(() => store.list(scope)).toThrow("Invalid cron options state");
      db.query("UPDATE cron_schedules SET options=NULL WHERE id=?").run(
        schedule.id,
      );
      db.query("UPDATE cron_runs SET snapshot=? WHERE id=?").run(
        JSON.stringify({ ...run, model: "invalid" }),
        run.id,
      );
      expect(() => store.pending(scope.botKey)).toThrow(
        "Invalid cron run state",
      );

      // Restore through the actual stored snapshot fields, not run-only metadata.
      const {
        id: _id,
        scheduleId: _scheduleId,
        dueAt: _dueAt,
        manual: _manual,
        status: _status,
        thread: _thread,
        jobId: _jobId,
        ...snapshot
      } = run;

      db.query("UPDATE cron_runs SET snapshot=?,evaluation=? WHERE id=?").run(
        JSON.stringify(snapshot),
        '{"text":"private","model":"claude/sonnet","verdict":"invalid"}',
        run.id,
      );
      expect(() => store.pending(scope.botKey)).toThrow(
        "Invalid cron run state",
      );
    } finally {
      db.close();
    }
  });

  test("additive upgrade preserves legacy schedules and pending join fallback", () => {
    const path = databasePath();
    const db = new Database(path);
    const id = crypto.randomUUID();
    const runId = crypto.randomUUID();
    db.exec(`
      CREATE TABLE cron_schedules (
        id TEXT PRIMARY KEY, botKey TEXT NOT NULL, channel TEXT NOT NULL,
        user TEXT NOT NULL, name TEXT NOT NULL, expression TEXT NOT NULL,
        timezone TEXT NOT NULL, prompt TEXT NOT NULL, nextAt INTEGER NOT NULL,
        createdAt INTEGER NOT NULL, removedAt INTEGER, requestId TEXT,
        UNIQUE(botKey, channel, user, requestId)
      );
      CREATE TABLE cron_runs (
        id TEXT PRIMARY KEY, scheduleId TEXT NOT NULL REFERENCES cron_schedules(id),
        dueAt INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        thread TEXT, jobId INTEGER, UNIQUE(scheduleId, dueAt)
      );
    `);
    db.query(`INSERT INTO cron_schedules
      (id,botKey,channel,user,name,expression,timezone,prompt,nextAt,createdAt)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      scope.botKey,
      scope.channel,
      scope.user,
      input.name,
      input.expression,
      input.timezone,
      input.prompt,
      now + 60_000,
      now,
    );
    db.query("INSERT INTO cron_runs(id,scheduleId,dueAt) VALUES (?,?,?)").run(
      runId,
      id,
      now,
    );
    db.close();
    const store = open(path);
    expect(store.list(scope)[0]).toMatchObject({
      id,
      source: null,
      paused: 0,
      available: 1,
      report: "immediate",
    });
    expect(store.pending(scope.botKey)[0]).toMatchObject({
      ...input,
      ...scope,
      id: runId,
      manual: false,
      source: null,
    });
    store.fileAvailability(scope.botKey, []);
    expect(store.enabled(id)).toBe(true);
    // Reopening an upgraded schema must remain idempotent.
    expect(open(path).pending(scope.botKey)).toEqual(
      store.pending(scope.botKey),
    );
    expect(store.add(scope, input, now)).toMatchObject({
      source: null,
      paused: 0,
      available: 1,
    });
    const upgraded = new Database(path);

    try {
      expect(
        upgraded
          .query("SELECT finishedAt FROM cron_runs WHERE id=?")
          .get(runId),
      ).toEqual({ finishedAt: null });
      upgraded
        .query("UPDATE cron_schedules SET report='daily' WHERE id=?")
        .run(id);
      upgraded
        .query("UPDATE cron_runs SET status='done' WHERE id=?")
        .run(runId);
    } finally {
      upgraded.close();
    }

    expect(store.dailyResults(scope.botKey, now, now + 1)).toMatchObject([
      { id: runId, status: "done", dueAt: now },
    ]);
    expect(store.dailyResults(scope.botKey, now + 1, now + 2)).toEqual([]);
  });

  test("file identity preserves occurrence, updates input, and retains tombstones", () => {
    const store = open();
    const first = store.upsertFile(scope, input, source, false, now);

    const updated = store.upsertFile(
      scope,
      { ...input, name: "New name", prompt: "Edited private prompt." },
      source,
      true,
      now + 70_000,
    );

    expect(updated).toMatchObject({
      id: first.id,
      nextAt: first.nextAt,
      createdAt: now,
      paused: 1,
      available: 1,
      source,
      name: "New name",
    });
    expect(
      store.upsertFile(scope, input, "/jobs/sub/../report.md", true, now).id,
    ).toBe(first.id);

    const rescheduled = store.upsertFile(
      scope,
      { ...input, expression: "*/5 * * * *" },
      source,
      false,
      now + 70_000,
    );

    expect(rescheduled.nextAt).toBe(now + 5 * 60_000);

    const rezoned = store.upsertFile(
      scope,
      { ...input, expression: "*/5 * * * *", timezone: "Europe/London" },
      source,
      false,
      now + 6 * 60_000,
    );

    expect(rezoned.nextAt).toBe(now + 10 * 60_000);
    expect(store.remove(scope, first.id)).toBe(true);
    expect(store.upsertFile(scope, input, source, false, now).id).toBe(
      first.id,
    );
    expect(store.list(scope)).toEqual([]);
    expect(store.enabled(first.id, true)).toBe(false);
    expect(() => store.runNow(scope, first.id, now)).toThrow();
  });

  test("file sources cannot transfer owner or channel, including after removal", () => {
    const store = open();
    const schedule = store.upsertFile(scope, input, source, false, now);

    for (const change of [{ channel: "C999" }, { user: "U999" }]) {
      expect(() =>
        store.upsertFile({ ...scope, ...change }, input, source, false, now),
      ).toThrow("ownership");
    }

    store.remove(scope, schedule.id);
    expect(() =>
      store.upsertFile({ ...scope, user: "U999" }, input, source, false, now),
    ).toThrow("ownership");
    expect(
      store.upsertFile({ ...scope, botKey: "other" }, input, source, false, now)
        .id,
    ).not.toBe(schedule.id);
  });

  test("missing or invalid files fail closed without affecting legacy or other bots", () => {
    const store = open();
    const legacy = store.add(scope, input, now);
    const missing = store.upsertFile(scope, input, source, false, now);
    const paused = store.upsertFile(scope, input, "/jobs/paused.md", true, now);

    const other = store.upsertFile(
      { ...scope, botKey: "other" },
      input,
      source,
      false,
      now,
    );

    store.fileAvailability(scope.botKey, ["/jobs/paused.md"]);
    expect(store.enabled(missing.id, true)).toBe(false);
    expect(store.enabled(paused.id)).toBe(false);
    expect(store.enabled(paused.id, true)).toBe(true);
    expect(store.enabled(legacy.id)).toBe(true);
    expect(store.enabled(other.id)).toBe(true);
    expect(
      store.claimDue(scope.botKey, now + 60_000).map((r) => r.scheduleId),
    ).toEqual([legacy.id]);
    expect(() => store.runNow(scope, missing.id, now)).toThrow();
    const manual = store.runNow(scope, paused.id, now);
    expect(manual?.manual).toBe(true);

    if (!manual) throw new Error("Expected paused manual run");
    expect(store.announcing(manual.id)).toBe(true);
    expect(() =>
      store.upsertFile(scope, { ...input, prompt: "" }, source, false, now),
    ).toThrow();
    expect(store.enabled(missing.id)).toBe(false);
    store.upsertFile(scope, input, source, false, now);
    expect(store.enabled(missing.id)).toBe(true);
    expect(store.list(scope).find((s) => s.id === missing.id)?.nextAt).toBe(
      now + 60_000,
    );
  });

  test("accepted scheduled and manual runs retain immutable input snapshots", () => {
    const path = databasePath();
    const store = open(path);
    const schedule = store.upsertFile(scope, input, source, false, now);
    const accepted = store.claimDue(scope.botKey, now + 60_000)[0];

    if (!accepted) throw new Error("Expected scheduled run");
    store.upsertFile(
      scope,
      { ...input, name: "Changed", prompt: "Changed private prompt." },
      source,
      false,
      now,
    );
    expect(open(path).pending(scope.botKey)[0]).toEqual(accepted);
    store.announcing(accepted.id);
    store.announced(accepted.id, "1.000");
    store.enqueued(accepted.id, 1);
    expect(store.queued(scope.botKey)[0]?.prompt).toBe(input.prompt);
    store.finish(accepted.id, "done");
    const manual = store.runNow(scope, schedule.id, now);

    if (!manual) throw new Error("Expected manual run");
    store.upsertFile(scope, input, source, false, now);
    expect(store.pending(scope.botKey)[0]).toEqual(manual);
    expect(manual.prompt).toBe("Changed private prompt.");
  });

  test("deferred preparation survives restart without announcement recovery", () => {
    const path = databasePath();
    const store = open(path);
    const schedule = store.add(scope, { ...input, report: "daily" }, now);
    const run = store.runNow(scope, schedule.id, now);

    if (!run) throw new Error("Expected manual run");
    expect(store.prepareDeferred(run.id)).toBe(true);
    const otherScope = { ...scope, botKey: "other" };
    const otherSchedule = store.add(otherScope, input, now);
    const otherRun = store.runNow(otherScope, otherSchedule.id, now);

    if (!otherRun) throw new Error("Expected other bot run");
    store.announcing(otherRun.id);
    const restarted = open(path);
    expect(restarted.recoverAnnouncements(scope.botKey)).toBe(0);
    expect(restarted.pending(scope.botKey)).toEqual([
      { ...run, status: "announced", thread: "" },
    ]);
    expect(restarted.prepareDeferred(run.id)).toBe(false);
    restarted.enqueued(run.id, 12);
    expect(store.prepareDeferred(run.id)).toBe(false);
    expect(store.queued(scope.botKey)[0]?.jobId).toBe(12);
    expect(store.pending("other")).toEqual([]);
    expect(store.queued("other")).toEqual([]);
    expect(restarted.recoverAnnouncements("other")).toBe(1);
  });

  test("deferred preparation rechecks removal, availability, and manual pause", () => {
    const store = open();
    const schedule = store.upsertFile(scope, input, source, false, now);
    const run = store.claimDue(scope.botKey, now + 60_000)[0];

    if (!run) throw new Error("Expected scheduled run");
    store.upsertFile(scope, input, source, true, now);
    expect(store.prepareDeferred(run.id)).toBe(false);
    store.upsertFile(scope, input, source, false, now);
    store.fileAvailability(scope.botKey, []);
    expect(store.prepareDeferred(run.id)).toBe(false);
    store.upsertFile(scope, input, source, false, now);
    expect(store.prepareDeferred(run.id)).toBe(true);
    store.finish(run.id, "done", now + 60_001);
    store.upsertFile(scope, input, source, true, now);
    const manual = store.runNow(scope, schedule.id, now + 60_002);

    if (!manual) throw new Error("Expected paused manual run");
    expect(store.prepareDeferred(manual.id)).toBe(true);
    store.finish(manual.id, "done", now + 60_003);
    const removed = store.runNow(scope, schedule.id, now + 60_004);

    if (!removed) throw new Error("Expected removable run");
    store.remove(scope, schedule.id);
    expect(store.prepareDeferred(removed.id)).toBe(false);
    expect(store.prepareDeferred(crypto.randomUUID())).toBe(false);
  });

  test("manual runs are immediate, preserve nextAt, deduplicate, and never overlap", () => {
    const path = databasePath();
    const store = open(path);
    const schedule = store.add(scope, input, now);
    const first = store.runNow(scope, input.name, now, "click-1");

    if (!first) throw new Error("Expected manual run");
    expect(first).toMatchObject({ ...input, dueAt: now, manual: true });
    expect(store.list(scope)[0]?.nextAt).toBe(schedule.nextAt);
    const second = open(path);
    expect(second.runNow(scope, schedule.id, now, "click-1")).toBeUndefined();
    expect(second.runNow(scope, schedule.id, now, "click-2")).toBeUndefined();
    expect(second.claimDue(scope.botKey, schedule.nextAt)).toEqual([]);
    store.finish(first.id, "done");
    expect(second.runNow(scope, schedule.id, now, "click-1")).toBeUndefined();
    const later = second.runNow(scope, schedule.id, now, "click-2");
    expect(later?.dueAt).toBe(now + 1);

    if (!later) throw new Error("Expected second manual run");
    second.finish(later.id, "failed");
    expect(store.runNow(scope, schedule.id, now)?.dueAt).toBe(now + 2);
  });

  test("run-now lookup is exact, owner-scoped, and rejects ambiguous names", () => {
    const store = open();
    const schedule = store.add(scope, input, now);

    for (const change of [
      { botKey: "other" },
      { channel: "C999" },
      { user: "U999" },
    ]) {
      expect(() =>
        store.runNow({ ...scope, ...change }, schedule.id, now, "same-click"),
      ).toThrow();
    }

    expect(() => store.runNow(scope, "Daily", now)).toThrow();
    store.add(scope, input, now);
    expect(() => store.runNow(scope, input.name, now)).toThrow("ambiguous");
    expect(
      store.runNow(scope, schedule.id, now, "same-click")?.scheduleId,
    ).toBe(schedule.id);
    const otherScope = { ...scope, user: "U999" };
    const otherSchedule = store.add(otherScope, input, now);
    expect(
      store.runNow(otherScope, otherSchedule.id, now, "same-click")?.scheduleId,
    ).toBe(otherSchedule.id);
  });

  test("safe boundary validation does not store invalid data", () => {
    const store = open();

    for (const path of ["relative.md", "", "/jobs/\0secret", "a".repeat(5000)])
      expect(() => store.upsertFile(scope, input, path, false, now)).toThrow(
        "Invalid cron file source.",
      );
    expect(() =>
      store.fileAvailability(scope.botKey, Array(101).fill(source)),
    ).toThrow();
    expect(() =>
      store.fileAvailability(scope.botKey, ["relative.md"]),
    ).toThrow();
    expect(() => store.fileAvailability("", [])).toThrow();
    const schedule = store.add(scope, input, now);
    expect(() => store.runNow(scope, schedule.id, now, " ")).toThrow();
    expect(() =>
      store.runNow(scope, schedule.id, now, `x${" ".repeat(255)}`),
    ).toThrow();
    expect(() => store.runNow(scope, schedule.id, Number.NaN)).toThrow();
    expect(() =>
      store.runNow(scope, schedule.id, Number.POSITIVE_INFINITY),
    ).toThrow();
    expect(store.pending(scope.botKey)).toEqual([]);
  });
});

describe("cron metadata reports", () => {
  test("daily result windows retain accepted modes, names, and all run states", () => {
    const store = open();

    const states = [
      "pending",
      "announcing",
      "announced",
      "queued",
      "blocked",
      "done",
      "failed",
      "canceled",
    ] as const;

    const expected = states.map((status, index) => {
      const job = store.upsertFile(
        scope,
        { ...input, report: "daily", name: `Daily ${index}` },
        `/jobs/daily-${index}.md`,
        false,
        now,
      );

      const run = store.runNow(scope, job.id, now + index);

      if (!run) throw new Error("Expected daily run");

      if (status === "done" || status === "failed")
        store.finish(run.id, status, now + index);
      else if (status === "canceled") store.remove(scope, job.id);
      else if (status !== "pending") {
        store.announcing(run.id);

        if (status !== "announcing") {
          store.announced(run.id, "1.000");

          if (status === "queued") store.enqueued(run.id, index);
          else if (status === "blocked") store.block(run.id);
        }
      }

      // Mode and name changes must not rewrite accepted report ownership.
      store.upsertFile(scope, input, `/jobs/daily-${index}.md`, false, now);

      return {
        id: run.id,
        scheduleId: job.id,
        name: `Daily ${index}`,
        channel: scope.channel,
        user: scope.user,
        status,
        jobId: status === "queued" ? index : null,
        dueAt: now + index,
        report: "daily" as const,
        manual: true,
      };
    });

    const immediate = store.upsertFile(
      scope,
      input,
      "/jobs/immediate.md",
      false,
      now,
    );

    store.runNow(scope, immediate.id, now);
    store.upsertFile(
      scope,
      { ...input, report: "daily" },
      "/jobs/immediate.md",
      false,
      now,
    );
    const other = { ...scope, botKey: "other" };
    const otherJob = store.add(other, { ...input, report: "daily" }, now);
    store.runNow(other, otherJob.id, now);
    expect(store.dailyResults(scope.botKey, now, now + 8)).toEqual(expected);
    expect(store.dailyResults(scope.botKey, now + 1, now + 7)).toEqual(
      expected.slice(0, 7),
    );
    expect(store.dailyResults(scope.botKey, now - 1, now)).toEqual([]);
    expect(store.dailyResults("other", now, now + 8)).toHaveLength(1);
    expect(() => store.dailyResults(scope.botKey, now, now)).toThrow();
    expect(() => store.dailyResults(scope.botKey, Number.NaN, now)).toThrow();
    expect(
      JSON.stringify(store.dailyResults(scope.botKey, now, now + 8)),
    ).not.toContain("prompt");
    expect(
      JSON.stringify(store.dailyResults(scope.botKey, now, now + 8)),
    ).not.toContain("source");
  });

  test("daily results include scheduled runs and remain bounded at 100", () => {
    const store = open();

    for (let index = 0; index < 101; index++)
      store.add(
        scope,
        { ...input, report: "daily", name: `Daily ${index}` },
        now,
      );
    expect(store.claimDue(scope.botKey, now + 60_000)).toHaveLength(100);
    expect(store.claimDue(scope.botKey, now + 60_000)).toHaveLength(1);
    const results = store.dailyResults(scope.botKey, now, now + 120_000);
    expect(results).toHaveLength(100);
    expect(
      results.every((run) => run.manual === false && run.report === "daily"),
    ).toBe(true);
  });

  test("overnight completions return next day once, without old terminal history", () => {
    const path = databasePath();
    const store = open(path);
    const day = 24 * 60 * 60_000;
    const cutoff = now + 8.5 * 60 * 60_000;
    const schedule = store.add(scope, { ...input, report: "daily" }, now);
    const run = store.runNow(scope, schedule.id, now);

    if (!run) throw new Error("Expected overnight run");
    store.prepareDeferred(run.id);
    store.enqueued(run.id, 7);
    expect(
      store.dailyResults(scope.botKey, cutoff - day, cutoff),
    ).toMatchObject([{ id: run.id, status: "queued" }]);
    // The next report must retain old, still-active work too.
    expect(
      store.dailyResults(scope.botKey, cutoff, cutoff + day),
    ).toMatchObject([{ id: run.id, status: "queued" }]);
    const finishedAt = cutoff + 1000;
    store.finish(run.id, "done", finishedAt);
    // A retry cannot move the completion window or change the outcome.
    store.finish(run.id, "failed", finishedAt + day);
    const restarted = open(path);
    expect(
      restarted.dailyResults(scope.botKey, cutoff, cutoff + day),
    ).toMatchObject([{ id: run.id, status: "done", jobId: 7 }]);
    expect(
      restarted.dailyResults(scope.botKey, cutoff + day, cutoff + 2 * day),
    ).toEqual([]);
    expect(restarted.dailyResults("other", cutoff, cutoff + day)).toEqual([]);
    const db = new Database(path, { readonly: true });

    try {
      expect(
        db.query("SELECT finishedAt FROM cron_runs WHERE id=?").get(run.id),
      ).toEqual({ finishedAt });
    } finally {
      db.close();
    }
  });

  test("completion bounds include the start, exclude the end and future dues", () => {
    const store = open();
    const schedule = store.add(scope, { ...input, report: "daily" }, now);
    const run = store.runNow(scope, schedule.id, now);

    if (!run) throw new Error("Expected daily run");
    store.finish(run.id, "failed", now + 1000);
    expect(
      store.dailyResults(scope.botKey, now + 1000, now + 2000),
    ).toMatchObject([{ id: run.id }]);
    expect(store.dailyResults(scope.botKey, now + 1, now + 1000)).toEqual([]);
    const future = store.runNow(scope, schedule.id, now + 4000);

    if (!future) throw new Error("Expected future run");
    store.finish(future.id, "done", now + 2000);
    expect(store.dailyResults(scope.botKey, now + 2000, now + 3000)).toEqual(
      [],
    );
  });

  test("reports bounded isolated metadata and last occurrence status, never body", () => {
    const store = open();
    const first = store.upsertFile(scope, input, source, true, now);
    const run = store.runNow(scope, first.id, now);

    if (!run) throw new Error("Expected manual run");
    store.finish(run.id, "done");
    store.upsertFile(scope, input, "/jobs/missing.md", false, now + 1);
    store.fileAvailability(scope.botKey, [source]);
    const removed = store.add(scope, input, now + 2);
    store.remove(scope, removed.id);
    store.add({ ...scope, botKey: "other" }, input, now);
    expect(store.report(scope.botKey)).toEqual([
      {
        id: first.id,
        name: input.name,
        channel: scope.channel,
        user: scope.user,
        paused: 1,
        available: 1,
        nextAt: first.nextAt,
        report: "immediate",
        lastRunAt: now,
        lastStatus: "done",
      },
      expect.objectContaining({
        available: 0,
        lastRunAt: null,
        lastStatus: null,
      }),
    ]);
    expect(JSON.stringify(store.report(scope.botKey))).not.toContain("prompt");
    expect(JSON.stringify(store.report(scope.botKey))).not.toContain(source);

    for (let index = 0; index < 105; index++)
      store.add(scope, { ...input, name: `Job ${index}` }, now + index);
    expect(store.report(scope.botKey)).toHaveLength(100);
    expect(store.report("other")).toHaveLength(1);
  });

  test("daily claim is durable before POST, owner-scoped, and never reclaimed", () => {
    const path = databasePath();
    const store = open(path);
    const date = "2026-01-01";
    expect(store.claimDailyReport(scope, date)).toBe(true);
    const restarted = open(path);
    expect(restarted.claimDailyReport(scope, date)).toBe(false);
    store.finishDailyReport(scope, date, "failed");
    expect(restarted.claimDailyReport(scope, date)).toBe(false);
    expect(store.claimDailyReport(scope, "2026-01-02")).toBe(true);
    store.finishDailyReport(scope, "2026-01-02", "done");
    expect(restarted.claimDailyReport(scope, "2026-01-02")).toBe(false);

    for (const change of [
      { botKey: "other" },
      { channel: "C999" },
      { user: "U999" },
    ])
      expect(store.claimDailyReport({ ...scope, ...change }, date)).toBe(true);
    store.finishDailyReport(scope, "2026-01-03", "done");
    expect(store.claimDailyReport(scope, "2026-01-03")).toBe(true);
  });

  test("daily dates validate calendar days and safe ownership", () => {
    const store = open();

    for (const date of ["2026-1-01", "2026-02-29", "2026-04-31", "2026-01-01x"])
      expect(() => store.claimDailyReport(scope, date)).toThrow(
        "Invalid cron report date.",
      );
    expect(() => store.finishDailyReport(scope, "", "done")).toThrow();
    expect(() =>
      store.claimDailyReport({ ...scope, user: "" }, "2026-01-01"),
    ).toThrow();
    expect(store.claimDailyReport(scope, "2028-02-29")).toBe(true);
  });
});
