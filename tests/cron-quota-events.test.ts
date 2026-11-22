import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CronInput } from "../src/cron/input";
import { CronStore } from "../src/cron/store";
import type { QuotaSnapshot } from "../src/quota/quota";

const now = Date.parse("2026-01-01T00:00:00Z");
const hour = 3_600_000;
const scope = { botKey: "bot", channel: "C123", user: "U123" };
const stores: CronStore[] = [];
const directories: string[] = [];
function open(path = ":memory:") {
  const store = new CronStore(path);
  stores.push(store);
  return store;
}
function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "stargate-quota-"));
  directories.push(directory);
  return join(directory, "cron.sqlite");
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function job(trigger: NonNullable<CronInput["trigger"]>): CronInput {
  return {
    name: "Quota",
    expression: "",
    timezone: "UTC",
    prompt: "Check work.",
    trigger,
  };
}
const reset = job({ type: "quota-reset", provider: "claude" });
const thresholdTrigger = {
  type: "quota-threshold",
  provider: "claude",
  usedPercent: 80,
} as const;
const threshold = job(thresholdTrigger);
function observation(
  usedPercent = 10,
  resetAt = now + 60_000,
  observedAt = now,
): QuotaSnapshot {
  return {
    status: "ok",
    observedAt,
    cached: false,
    accounts: [
      {
        provider: "claude",
        account: "claude-1",
        status: "ok",
        observedAt,
        windows: [
          {
            window: "5h",
            scope: "subscription",
            usedPercent,
            resetAt,
            active: true,
            remainingPercent: Math.max(0, 100 - usedPercent),
          },
        ],
      },
    ],
  };
}

function account(snapshot: QuotaSnapshot) {
  const row = snapshot.accounts[0];
  if (!row) throw new Error("Expected quota account");
  return row;
}
function limit(snapshot: QuotaSnapshot) {
  const row = account(snapshot).windows[0];
  if (!row) throw new Error("Expected quota window");
  return row;
}

test("reset bootstraps silently, advances on manual reset, and survives reopening", () => {
  const path = databasePath();
  const store = open(path);
  store.upsertFile(scope, reset, "/jobs/reset.md", false, now);
  expect(store.claimDue(scope.botKey, now + 1)).toEqual([]);
  expect(store.claimQuota(scope.botKey, observation(), now)).toEqual([]);
  const changed = observation(0, now + 60_000 + hour, now + 1);
  const runs = store.claimQuota(scope.botKey, changed, now + 1);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    trigger: reset.trigger,
    expression: "",
    manual: false,
    quotaEvent: {
      type: "quota-reset",
      provider: "claude",
      account: "claude-1",
      window: "5h",
      scope: "subscription",
      usedPercent: 0,
      previousResetAt: now + 60_000,
      resetAt: now + 60_000 + hour,
      observedAt: now + 1,
    },
  });
  if (!runs[0]) throw new Error("Expected reset run");
  store.upsertFile(
    scope,
    { ...reset, prompt: "Changed definition." },
    "/jobs/reset.md",
    false,
    now + 1,
  );
  expect(open(path).pending(scope.botKey)).toEqual(runs);
  store.finish(runs[0].id, "done", now + 2);
  expect(open(path).claimQuota(scope.botKey, changed, now + 2)).toEqual([]);
  expect(
    store.claimQuota(
      scope.botKey,
      observation(0, now + 60_000 + hour, now + 3),
      now + 3,
    ),
  ).toEqual([]);
});

test("threshold fires initially high and only once per account reset cycle", () => {
  const path = databasePath();
  const store = open(path);
  store.add(scope, threshold, now);
  const first = store.claimQuota(scope.botKey, observation(80), now);
  expect(first).toHaveLength(1);
  expect(first[0]?.quotaEvent).toMatchObject({
    previousResetAt: null,
    resetAt: now + 60_000,
  });
  expect(open(path).pending(scope.botKey)).toEqual(first);
  if (!first[0]) throw new Error("Expected threshold run");
  store.finish(first[0].id, "done", now);
  const restarted = open(path);
  expect(
    restarted.claimQuota(
      scope.botKey,
      observation(90, now + 60_000, now + 1),
      now + 1,
    ),
  ).toEqual([]);
  expect(
    restarted.claimQuota(
      scope.botKey,
      observation(20, now + 60_000, now + 2),
      now + 2,
    ),
  ).toEqual([]);
  expect(
    restarted.claimQuota(
      scope.botKey,
      observation(85, now + 60_000, now + 3),
      now + 3,
    ),
  ).toEqual([]);
  expect(
    restarted.claimQuota(
      scope.botKey,
      observation(80, now + 60_000 + hour, now + 4),
      now + 4,
    ),
  ).toHaveLength(1);
});

test("threshold crossing consumes paused, unavailable and busy events without backlog", () => {
  const store = open();
  const paused = store.upsertFile(
    scope,
    threshold,
    "/jobs/paused.md",
    true,
    now,
  );
  const missing = store.upsertFile(
    scope,
    threshold,
    "/jobs/missing.md",
    false,
    now,
  );
  const busy = store.add(scope, threshold, now);
  const manual = store.runNow(scope, busy.id, now);
  if (!manual) throw new Error("Expected manual run");
  store.fileAvailability(scope.botKey, ["/jobs/paused.md"]);
  expect(store.claimQuota(scope.botKey, observation(20), now)).toEqual([]);
  expect(
    store.claimQuota(
      scope.botKey,
      observation(85, now + 60_000, now + 1),
      now + 1,
    ),
  ).toEqual([]);
  store.upsertFile(scope, threshold, "/jobs/paused.md", false, now + 2);
  store.upsertFile(scope, threshold, "/jobs/missing.md", false, now + 2);
  store.finish(manual.id, "done", now + 2);
  expect(store.enabled(paused.id)).toBe(true);
  expect(store.enabled(missing.id)).toBe(true);
  expect(
    store.claimQuota(
      scope.botKey,
      observation(90, now + 60_000, now + 2),
      now + 2,
    ),
  ).toEqual([]);
  expect(
    store.claimQuota(
      scope.botKey,
      observation(85, now + 60_000 + hour, now + 3),
      now + 3,
    ),
  ).toHaveLength(3);
});

test("paused bootstrap high is consumed and reset bootstrap never replays", () => {
  const store = open();
  store.upsertFile(scope, threshold, "/jobs/high.md", true, now);
  store.upsertFile(scope, reset, "/jobs/reset.md", true, now);
  expect(store.claimQuota(scope.botKey, observation(90), now)).toEqual([]);
  store.upsertFile(scope, threshold, "/jobs/high.md", false, now);
  store.upsertFile(scope, reset, "/jobs/reset.md", false, now);
  expect(
    store.claimQuota(
      scope.botKey,
      observation(90, now + 60_000, now + 1),
      now + 1,
    ),
  ).toEqual([]);
});

test("invalid, stale, inactive and out-of-order observations cannot change baseline", () => {
  const store = open();
  store.add(scope, reset, now);
  store.claimQuota(scope.botKey, observation(10, now + 600_000), now);
  const invalid: QuotaSnapshot[] = [];
  for (const mutate of [
    (s: QuotaSnapshot) => {
      account(s).status = "unavailable";
    },
    (s: QuotaSnapshot) => {
      account(s).observedAt = now - 120_001;
    },
    (s: QuotaSnapshot) => {
      account(s).observedAt = now + 2;
    },
    (s: QuotaSnapshot) => {
      limit(s).active = false;
    },
    (s: QuotaSnapshot) => {
      limit(s).usedPercent = null;
    },
    (s: QuotaSnapshot) => {
      limit(s).resetAt = null;
    },
    (s: QuotaSnapshot) => {
      limit(s).resetAt = now;
    },
  ]) {
    const snapshot = observation(10, now + 900_000, now + 1);
    mutate(snapshot);
    invalid.push(snapshot);
  }
  for (const snapshot of invalid)
    expect(store.claimQuota(scope.botKey, snapshot, now + 1)).toEqual([]);
  expect(
    store.claimQuota(
      scope.botKey,
      observation(10, now + 500_000, now + 2),
      now + 2,
    ),
  ).toEqual([]);
  expect(
    store.claimQuota(
      scope.botKey,
      observation(10, now + 700_000, now - 1),
      now + 2,
    ),
  ).toEqual([]);
  expect(
    store.claimQuota(
      scope.botKey,
      observation(5, now + 500_000 + hour, now + 3),
      now + 3,
    ),
  ).toHaveLength(1);
});

test("subsecond jitter and backward drift do not reset or rearm thresholds after reopening", () => {
  const path = databasePath();
  const store = open(path);
  store.add(scope, reset, now);
  store.add(scope, threshold, now);
  const rawResetAt = now + 5 * hour;
  const bootstrap = store.claimQuota(
    scope.botKey,
    observation(90, rawResetAt),
    now,
  );
  expect(bootstrap).toHaveLength(1);
  if (!bootstrap[0]) throw new Error("Expected threshold run");
  expect(bootstrap[0].quotaEvent?.type).toBe("quota-threshold");
  store.finish(bootstrap[0].id, "done", now);
  for (const [offset, used, at] of [
    [499, 90, now + 1],
    [998, 0, now + 2],
    [-200, 90, now + 3],
  ] as const)
    expect(
      open(path).claimQuota(
        scope.botKey,
        observation(used, rawResetAt + offset, at),
        at,
      ),
    ).toEqual([]);
  // A non-stale backwards timestamp becomes the next raw baseline.
  const next = open(path).claimQuota(
    scope.botKey,
    observation(85, rawResetAt - 200 + hour, now + 4),
    now + 4,
  );
  expect(next).toHaveLength(2);
  for (const run of next) {
    expect(run.quotaEvent).toMatchObject({
      previousResetAt: rawResetAt - 200,
      resetAt: rawResetAt - 200 + hour,
    });
    store.finish(run.id, "done", now + 4);
  }
  expect(
    store.claimQuota(
      scope.botKey,
      observation(90, rawResetAt - 200, now + 5),
      now + 5,
    ),
  ).toEqual([]);
  // A later qualified reset must get fresh receipts if raw deadlines repeat.
  expect(
    open(path).claimQuota(
      scope.botKey,
      observation(85, rawResetAt - 200 + hour, now + 6),
      now + 6,
    ),
  ).toHaveLength(2);
});

test("existing quota state backfills the receipt cycle without replaying thresholds", () => {
  const path = databasePath();
  const rawResetAt = now + 5 * hour;
  const db = new Database(path);
  try {
    db.exec(`CREATE TABLE cron_quota_state (
      botKey TEXT NOT NULL, provider TEXT NOT NULL, account TEXT NOT NULL,
      window TEXT NOT NULL, scope TEXT NOT NULL, resetAt INTEGER NOT NULL,
      usedPercent REAL NOT NULL, observedAt INTEGER NOT NULL,
      PRIMARY KEY(botKey,provider,account,window,scope)
    )`);
    db.query("INSERT INTO cron_quota_state VALUES (?,?,?,?,?,?,?,?)").run(
      scope.botKey,
      "claude",
      "claude-1",
      "5h",
      "subscription",
      rawResetAt,
      90,
      now,
    );
    const store = open(path);
    const schedule = store.add(scope, threshold, now);
    db.query("INSERT INTO cron_quota_receipts VALUES (?,?,?,?,?,?,?)").run(
      schedule.id,
      "claude",
      "claude-1",
      "5h",
      "subscription",
      rawResetAt,
      "quota-threshold",
    );
    expect(
      store.claimQuota(
        scope.botKey,
        observation(90, rawResetAt + 499, now + 1),
        now + 1,
      ),
    ).toEqual([]);
    expect(
      open(path).claimQuota(
        scope.botKey,
        observation(90, rawResetAt + 2 * hour, now + 2),
        now + 2,
      ),
    ).toEqual([]);
    expect(
      store.claimQuota(
        scope.botKey,
        observation(85, rawResetAt + 3 * hour, now + 3),
        now + 3,
      ),
    ).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("multi-hour reset drift without a sufficient usage drop stays in the same cycle", () => {
  const store = open();
  store.add(scope, reset, now);
  store.add(scope, threshold, now);
  const rawResetAt = now + 5 * hour;
  expect(
    store.claimQuota(scope.botKey, observation(0, rawResetAt), now),
  ).toEqual([]);
  for (const [used, hours, at] of [
    [2, 7, now + 1],
    [0, 9, now + 2],
    [90, 11, now + 3],
  ] as const) {
    const runs = store.claimQuota(
      scope.botKey,
      observation(used, now + hours * hour, at),
      at,
    );
    if (used < 80) expect(runs).toEqual([]);
    else {
      expect(runs).toHaveLength(1);
      if (!runs[0]) throw new Error("Expected threshold run");
      expect(runs[0].quotaEvent).toMatchObject({
        type: "quota-threshold",
        previousResetAt: now + 9 * hour,
        resetAt: now + 11 * hour,
      });
      store.finish(runs[0].id, "done", at);
    }
  }
  expect(
    store.claimQuota(
      scope.botKey,
      observation(90, now + 13 * hour, now + 4),
      now + 4,
    ),
  ).toEqual([]);
});

test("weekly reset after the previous deadline fires once without a usage drop", () => {
  const path = databasePath();
  const store = open(path);
  store.add(
    scope,
    job({ type: "quota-reset", provider: "claude", window: "weekly" }),
    now,
  );
  const previousResetAt = now + 60_000;
  const weekly = observation(1, previousResetAt);
  limit(weekly).window = "weekly";
  expect(store.claimQuota(scope.botKey, weekly, now)).toEqual([]);
  const at = previousResetAt;
  const nextResetAt = previousResetAt + 7 * 24 * hour;
  const next = observation(2, nextResetAt, at);
  limit(next).window = "weekly";
  const runs = open(path).claimQuota(scope.botKey, next, at);
  expect(runs).toHaveLength(1);
  if (!runs[0]) throw new Error("Expected weekly reset run");
  expect(runs[0].quotaEvent).toMatchObject({
    previousResetAt,
    resetAt: nextResetAt,
    usedPercent: 2,
  });
  store.finish(runs[0].id, "done", at);
  expect(open(path).claimQuota(scope.botKey, next, at + 1)).toEqual([]);
  const drift = observation(2, nextResetAt + 2 * hour, at + 2);
  limit(drift).window = "weekly";
  expect(open(path).claimQuota(scope.botKey, drift, at + 2)).toEqual([]);
});

test("provider, account, window, scope and bot observations stay isolated", () => {
  const store = open();
  const defaultJob = store.add(scope, threshold, now);
  const weekly = store.add(
    scope,
    job({ ...thresholdTrigger, window: "weekly" }),
    now,
  );
  const opus = store.add(
    scope,
    job({ ...thresholdTrigger, scope: "opus" }),
    now,
  );
  const codex = store.add(
    scope,
    job({ type: "quota-threshold", provider: "codex", usedPercent: 80 }),
    now,
  );
  const other = store.add({ ...scope, botKey: "other" }, threshold, now);
  const snapshot = observation(90);
  limit(snapshot).scope = "opus";
  const op = store.claimQuota(scope.botKey, snapshot, now);
  expect(op.map((run) => run.scheduleId)).toEqual([opus.id]);
  if (!op[0]) throw new Error("Expected subset run");
  store.finish(op[0].id, "done", now);
  const weeklySnapshot = observation(90, now + 60_000, now + 1);
  limit(weeklySnapshot).window = "weekly";
  expect(
    store
      .claimQuota(scope.botKey, weeklySnapshot, now + 1)
      .map((run) => run.scheduleId)
      .sort(),
  ).toEqual([weekly.id, defaultJob.id].sort());
  for (const run of store.pending(scope.botKey))
    store.finish(run.id, "done", now + 1);
  const secondAccount = observation(90, now + 60_000, now + 2);
  account(secondAccount).account = "claude-2";
  expect(
    store
      .claimQuota(scope.botKey, secondAccount, now + 2)
      .map((run) => run.scheduleId),
  ).toEqual([defaultJob.id]);
  expect(
    store
      .claimQuota("other", observation(90), now)
      .map((run) => run.scheduleId),
  ).toEqual([other.id]);
  const codexSnapshot = observation(90);
  account(codexSnapshot).provider = "codex";
  account(codexSnapshot).account = "codex-1";
  expect(
    store
      .claimQuota(scope.botKey, codexSnapshot, now)
      .map((run) => run.scheduleId),
  ).toEqual([codex.id]);
});

test("state, receipt and admission roll back together on a storage error", () => {
  const path = databasePath();
  const store = open(path);
  store.add(scope, threshold, now);
  const db = new Database(path);
  try {
    db.exec(
      "CREATE TRIGGER reject_run BEFORE INSERT ON cron_runs BEGIN SELECT RAISE(ABORT,'test admission failure'); END",
    );
    expect(() => store.claimQuota(scope.botKey, observation(90), now)).toThrow(
      "test admission failure",
    );
    db.exec("DROP TRIGGER reject_run");
    expect(store.claimQuota(scope.botKey, observation(90), now)).toHaveLength(
      1,
    );
  } finally {
    db.close();
  }
});

test("same-instant manual, clock and quota runs retain unique occurrence identities", () => {
  const store = open();
  const schedule = store.add(
    scope,
    { ...threshold, expression: "* * * * *" },
    now,
  );
  const at = now + 60_000;
  const manual = store.runNow(scope, schedule.id, at);
  if (!manual) throw new Error("Expected manual run");
  store.finish(manual.id, "done", at);
  const clock = store.claimDue(scope.botKey, at)[0];
  expect(clock?.dueAt).toBe(at + 1);
  if (!clock) throw new Error("Expected clock run");
  store.finish(clock.id, "done", at);
  expect(
    store.claimQuota(scope.botKey, observation(90, at + 60_000, at), at)[0]
      ?.dueAt,
  ).toBe(at + 2);
});

test("quota admission stays bounded without paused rows hiding eligible jobs or replaying overflow", () => {
  const store = open();
  for (let index = 0; index < 100; index++)
    store.upsertFile(scope, threshold, `/jobs/paused-${index}.md`, true, now);
  for (let index = 0; index < 101; index++)
    store.add(scope, threshold, now + 1);
  const admitted = store.claimQuota(scope.botKey, observation(90), now + 2);
  expect(admitted).toHaveLength(100);
  for (const run of admitted) store.finish(run.id, "done", now + 2);
  store.upsertFile(scope, threshold, "/jobs/paused-0.md", false, now + 3);
  expect(
    store.claimQuota(
      scope.botKey,
      observation(90, now + 60_000, now + 3),
      now + 3,
    ),
  ).toEqual([]);
});
