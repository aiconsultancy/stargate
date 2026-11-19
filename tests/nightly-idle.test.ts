import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { CrewState } from "../src/crew/state";
import { type CronRun, CronStore } from "../src/cron-store";
import { maintenanceSchema } from "../src/nightly/config";
import { type Crew, crewDatabase, piDatabase } from "../src/nightly/crews";
import {
  checkIdle,
  describeRunningWork,
  type IdleInput,
  queuedCrewTasks,
  waitForIdle,
} from "../src/nightly/idle";
import type { OpenCodeControl } from "../src/nightly/opencode";
import { bounds } from "../src/nightly/run";
import { jobStatuses, Store } from "../src/store";

const root = await mkdtemp(join(tmpdir(), "stargate-idle-"));
afterAll(() => rm(root, { recursive: true, force: true }));

const opencode = {
  active: [] as string[],
  /** Sessions with a pending form or permission request. */
  pending: [] as string[],
  /** Child session → parent session. */
  parents: {} as Record<string, string>,
  /** Sessions whose parent cannot be read. */
  unreadable: [] as string[],
  fail: false,
};
const control = {
  active: async () => opencode.active,
  pendingInput: async () => opencode.pending,
  parent: async (id: string) => {
    if (opencode.unreadable.includes(id)) throw new Error("unreadable");
    return opencode.parents[id];
  },
} as unknown as OpenCodeControl;
const connect = async () => {
  if (opencode.fail) throw new Error("down");
  return control;
};

let data: string;
let crew: Crew;
let count = 0;
const now = Date.parse("2026-11-12T00:05:00Z");

beforeEach(async () => {
  opencode.active = [];
  opencode.pending = [];
  opencode.parents = {};
  opencode.unreadable = [];
  opencode.fail = false;
  data = join(root, `case-${count++}`);
  await mkdir(data, { recursive: true });
  const store = new Store(join(data, "stargate.sqlite"));
  store.saveSession('["key","C1","1.0"]', "ses_captain");
  store.close();
  new CronStore(join(data, "cron.sqlite")).close();
  crew = {
    namespace: "ship",
    captainDirectory: join(data, "captain"),
    stateDirectory: join(data, "state"),
    roots: [],
    piMembers: ["twiki"],
  };
  await mkdir(join(crew.stateDirectory, "pi", "x"), { recursive: true });
  const db = new Database(crewDatabase(crew), { create: true });
  db.exec(`
    CREATE TABLE peers (crewID TEXT PRIMARY KEY, sessionID TEXT, status TEXT);
    CREATE TABLE pi_peers (sessionID TEXT PRIMARY KEY);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE pending_tasks (id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued', released INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE worker_controls (crewID TEXT PRIMARY KEY);
    CREATE TABLE activity_report_tasks (taskID TEXT PRIMARY KEY, captureID TEXT NOT NULL UNIQUE);
    INSERT INTO peers VALUES ('chief','ses_chief','ready');
    INSERT INTO tasks VALUES ('t1','completed');`);
  db.close();
  const pi = piDatabase(crew, "twiki");
  await mkdir(join(pi, ".."), { recursive: true });
  const piDb = new Database(pi, { create: true });
  piDb.exec(
    "CREATE TABLE tasks (id TEXT, status TEXT); INSERT INTO tasks VALUES ('a','terminal');",
  );
  piDb.close();
});

const input = (scope: IdleInput["scope"] = "stargate"): IdleInput => ({
  dataDirectory: data,
  crews: [crew],
  pinnedSessions: [],
  cronHorizonMs: 3_600_000,
  now,
  scope,
  connect,
  signal: AbortSignal.timeout(5000),
});
const exec = (path: string, sql: string) => {
  const db = new Database(path);
  db.exec(sql);
  db.close();
};

describe("idle gate", () => {
  test("an unknown host participant cannot establish drain idle", async () => {
    expect(
      await checkIdle({ ...input(), draining: true, drainUnknown: true }),
    ).toEqual({ idle: false, reason: "idle-unknown" });
  });
  test("drain deadline names running task/session without copying task text", async () => {
    exec(
      crewDatabase(crew),
      "ALTER TABLE tasks ADD COLUMN workerSessionID TEXT; UPDATE tasks SET status='running', workerSessionID='ses_chief' WHERE id='t1'",
    );
    opencode.active = ["ses_child", "ses_unrelated"];
    opencode.parents = { ses_child: "ses_chief" };
    expect(await describeRunningWork(input())).toEqual([
      { taskID: "t1", sessionID: "ses_chief", reason: "busy-crew" },
      { sessionID: "ses_child", reason: "busy-opencode" },
    ]);
  });
  test("drain holds queued gateway and cron work without treating it as running", async () => {
    const store = new Store(join(data, "stargate.sqlite"));
    store.enqueue({
      eventId: "drain-queued",
      botKey: "key",
      conversation: '["key","C1","1.0"]',
      channel: "C1",
      thread: "1.0",
      user: "U1",
      text: "after restart",
    });
    store.close();
    exec(
      join(data, "cron.sqlite"),
      `INSERT INTO cron_schedules (id,botKey,channel,user,name,expression,timezone,prompt,nextAt,createdAt)
       VALUES ('drain','key','C1','U1','n','0 2 * * *','UTC','p',${now},0);
       INSERT INTO cron_runs (id,scheduleId,dueAt) VALUES ('drain-run','drain',${now})`,
    );
    expect(await checkIdle(input())).toEqual({
      idle: false,
      reason: "busy-gateway",
    });
    expect(await checkIdle({ ...input(), draining: true })).toEqual({
      idle: true,
    });
    exec(join(data, "stargate.sqlite"), "UPDATE jobs SET status='running'");
    expect(await checkIdle({ ...input(), draining: true })).toEqual({
      idle: false,
      reason: "busy-gateway",
    });
  });

  test("maintenance drain defaults off with a ten-minute validated deadline", () => {
    expect(Schema.decodeUnknownSync(maintenanceSchema)({}).drain).toEqual({
      enabled: false,
      deadlineMinutes: 10,
    });
    for (const deadlineMinutes of [0, -1, 1.5, 1441])
      expect(() =>
        Schema.decodeUnknownSync(maintenanceSchema)({
          drain: { enabled: true, deadlineMinutes },
        }),
      ).toThrow();
  });
  test("idle when no work is queued, due or running", async () => {
    expect(await checkIdle(input())).toEqual({ idle: true });
    expect(await checkIdle(input("gateway"))).toEqual({ idle: true });
  });

  test("gateway jobs block", async () => {
    const store = new Store(join(data, "stargate.sqlite"));
    store.enqueue({
      eventId: "E1",
      botKey: "key",
      conversation: '["key","C1","1.0"]',
      channel: "C1",
      thread: "1.0",
      user: "U1",
      text: "hello",
    });
    store.close();
    expect(await checkIdle(input())).toEqual({
      idle: false,
      reason: "busy-gateway",
    });
  });

  test("every unfinished job status blocks; finished ones do not", async () => {
    const store = new Store(join(data, "stargate.sqlite"));
    store.enqueue({
      eventId: "E1",
      botKey: "key",
      conversation: '["key","C1","1.0"]',
      channel: "C1",
      thread: "1.0",
      user: "U1",
      text: "hello",
    });
    store.close();
    for (const status of jobStatuses) {
      exec(join(data, "stargate.sqlite"), `UPDATE jobs SET status='${status}'`);
      expect((await checkIdle(input())).idle).toBe(
        status === "done" || status === "failed",
      );
    }
  });

  test("every active cron run status blocks; finished ones do not", async () => {
    exec(
      join(data, "cron.sqlite"),
      `INSERT INTO cron_schedules (id,botKey,channel,user,name,expression,timezone,prompt,nextAt,createdAt)
       VALUES ('s','k','C1','U1','n','0 2 * * *','UTC','p',${now + 86_400_000},0);
       INSERT INTO cron_runs (id,scheduleId,dueAt) VALUES ('r','s',${now})`,
    );
    const statuses: Record<CronRun["status"], boolean> = {
      pending: false,
      announcing: false,
      announced: false,
      queued: false,
      blocked: false,
      done: true,
      failed: true,
      canceled: true,
    };
    for (const [status, idle] of Object.entries(statuses)) {
      exec(
        join(data, "cron.sqlite"),
        `UPDATE cron_runs SET status='${status}'`,
      );
      expect((await checkIdle(input())).idle).toBe(idle);
    }
  });

  test("cron work blocks only within the horizon", async () => {
    const schedule = (nextAt: number) =>
      exec(
        join(data, "cron.sqlite"),
        `INSERT INTO cron_schedules (id,botKey,channel,user,name,expression,timezone,prompt,nextAt,createdAt)
         VALUES ('s${nextAt}','k','C1','U1','n','0 2 * * *','UTC','p',${nextAt},0)`,
      );
    schedule(now + 2 * 3_600_000);
    expect((await checkIdle(input())).idle).toBe(true);
    schedule(now + 30 * 60_000);
    expect(await checkIdle(input())).toEqual({
      idle: false,
      reason: "busy-cron",
    });
  });

  test("overdue schedules count only while the gateway runs", async () => {
    exec(
      join(data, "cron.sqlite"),
      `INSERT INTO cron_schedules (id,botKey,channel,user,name,expression,timezone,prompt,nextAt,createdAt)
       VALUES ('late','k','C1','U1','n','0 2 * * *','UTC','p',${now - 3_600_000},0)`,
    );
    const stopped = { ...input(), gatewayRunning: async () => false };
    const running = { ...input(), gatewayRunning: async () => true };
    // Only a running gateway advances nextAt; a stopped one never will.
    expect(await checkIdle(stopped)).toEqual({ idle: true });
    expect(await checkIdle(running)).toEqual({
      idle: false,
      reason: "busy-cron",
    });
    // Due soon: it runs when the gateway starts, so it still counts.
    exec(
      join(data, "cron.sqlite"),
      `INSERT INTO cron_schedules (id,botKey,channel,user,name,expression,timezone,prompt,nextAt,createdAt)
       VALUES ('soon','k','C1','U1','n','0 2 * * *','UTC','p',${now + 60_000},0)`,
    );
    expect(await checkIdle(stopped)).toEqual({
      idle: false,
      reason: "busy-cron",
    });
    // Unknown gateway state is busy.
    exec(
      join(data, "cron.sqlite"),
      "DELETE FROM cron_schedules WHERE id='soon'",
    );
    expect(
      await checkIdle({
        ...input(),
        gatewayRunning: async () => {
          throw new Error("no bus");
        },
      }),
    ).toEqual({ idle: false, reason: "idle-unknown" });
  });

  test("queued and cancelled assignments do not block; only a captain turn starts them", async () => {
    // The engine's own store, not a hand-made table.
    const real: Crew = {
      namespace: "real-ship",
      captainDirectory: join(data, "captain"),
      stateDirectory: join(data, "real-state"),
      roots: [],
      piMembers: [],
    };
    const state = await CrewState.open(
      real.stateDirectory,
      real.namespace,
      "fingerprint",
    );
    try {
      const peer = state.reservePeer("chief");
      const first = state.enqueue(peer, "captain", "first");
      const second = state.enqueue(peer, "captain", "second");
      const gate = () => checkIdle({ ...input(), crews: [real] });
      // An ordinary assignment starts only via stargate_crew status/wait, inside
      // a captain turn, which the gate sees as an active session.
      expect(await gate()).toEqual({ idle: true });
      expect(state.cancelQueued(first.id, "captain")).toBe(true);
      expect(state.cancelQueued(second.id, "captain")).toBe(true);
      expect(state.queuedTasks(peer.crewID)).toEqual([]);
      expect(await gate()).toEqual({ idle: true });
    } finally {
      state.close();
    }
  });

  test("Galactica shape: a queued task from an earlier captain is idle but named", async () => {
    const real: Crew = {
      namespace: "galactica",
      captainDirectory: join(data, "captain"),
      stateDirectory: join(data, "galactica-state"),
      roots: [],
      piMembers: [],
      captainSessionID: "ses_pinned",
    };
    const state = await CrewState.open(
      real.stateDirectory,
      real.namespace,
      "fingerprint",
    );
    try {
      const chief = state.reservePeer("chief");
      const rows = Array.from({ length: 5 }, (_, i) =>
        state.enqueue(chief, "ses_e49d787old", `secret task text ${i}`),
      );
      for (const row of rows.slice(0, 4))
        expect(state.cancelQueued(row.id, "ses_e49d787old")).toBe(true);
      const queued = rows[4];
      if (!queued) throw new Error("no queued task");
      expect(await checkIdle({ ...input(), crews: [real] })).toEqual({
        idle: true,
      });
      const listed = queuedCrewTasks([real]);
      expect(listed).toEqual([
        {
          taskID: queued.id,
          crew: "chief",
          originCaptain: "ses_e49d787old",
          originIsPin: false,
          report: false,
        },
      ]);
      expect(JSON.stringify(listed)).not.toContain("secret task text");
      // From the pinned captain: named as such.
      const own = state.enqueue(chief, "ses_pinned", "more");
      expect(queuedCrewTasks([real]).at(-1)).toMatchObject({
        taskID: own.id,
        originIsPin: true,
      });
      // A captain turn is what starts it, and that turn is busy.
      opencode.active = ["ses_pinned"];
      expect(
        await checkIdle({
          ...input(),
          crews: [real],
          pinnedSessions: ["ses_pinned"],
        }),
      ).toEqual({
        idle: false,
        reason: "busy-opencode",
      });
    } finally {
      state.close();
    }
  });

  test("a queued activity-report task blocks: the gateway can admit it without a turn", async () => {
    const real: Crew = {
      namespace: "report-ship",
      captainDirectory: join(data, "captain"),
      stateDirectory: join(data, "report-state"),
      roots: [],
      piMembers: ["twiki"],
    };
    const state = await CrewState.open(
      real.stateDirectory,
      real.namespace,
      "fingerprint",
    );
    try {
      const capture = state.reporting.start("ses_captain", "req-1", "twiki");
      state.reporting.finish(capture);
      const report = state.enqueue(
        state.reservePeer("twiki"),
        "ses_captain",
        "summary prompt",
        capture.id,
      );
      expect(state.reporting.isReport(report.id)).toBe(true);
      expect(await checkIdle({ ...input(), crews: [real] })).toEqual({
        idle: false,
        reason: "busy-crew",
      });
      expect(queuedCrewTasks([real])).toMatchObject([
        { taskID: report.id, report: true },
      ]);
    } finally {
      state.close();
    }
  });

  test("an hourly cron blocks only near its run; the gate passes after it", async () => {
    const horizon =
      Schema.decodeUnknownSync(maintenanceSchema)({}).idle.cronHorizonMinutes *
      60_000;
    const cron = join(data, "cron.sqlite");
    const at = (time: string) => Date.parse(`2026-11-12T${time}Z`);
    // `15 * * * *`, as on Galactica: a run is never more than an hour away.
    exec(
      cron,
      `INSERT INTO cron_schedules (id,botKey,channel,user,name,expression,timezone,prompt,nextAt,createdAt)
       VALUES ('hourly','k','C1','U1','n','15 * * * *','UTC','p',${at("00:15:00")},0)`,
    );
    let time = now;
    const clock = {
      now: () => time,
      async sleep(ms: number) {
        time += ms;
        // The gateway claims the 00:15 run and finishes it two minutes later.
        if (time >= at("00:15:00") && time < at("00:17:00"))
          exec(
            cron,
            `UPDATE cron_schedules SET nextAt=${at("01:15:00")};
             INSERT OR IGNORE INTO cron_runs (id,scheduleId,dueAt) VALUES ('r1','hourly',${at("00:15:00")})`,
          );
        if (time >= at("00:17:00"))
          exec(cron, "UPDATE cron_runs SET status='done' WHERE id='r1'");
      },
    };
    const result = await waitForIdle(
      { ...input(), cronHorizonMs: horizon },
      at("00:50:00"),
      30_000,
      clock,
    );
    expect(result).toEqual({ idle: true });
    expect(time).toBeGreaterThanOrEqual(at("00:17:00"));
    expect(time).toBeLessThan(at("00:20:00"));
  });

  test("the default cron horizon covers the longest disruptive step", () => {
    const horizon =
      Schema.decodeUnknownSync(maintenanceSchema)({}).idle.cronHorizonMinutes *
      60_000;
    expect(horizon).toBeLessThan(60 * 60_000);
    expect(horizon).toBeGreaterThanOrEqual(
      bounds.openCodeRestart + bounds.openCodeVerify,
    );
    expect(horizon).toBeGreaterThanOrEqual(bounds.start + bounds.ready);
    expect(horizon).toBeGreaterThanOrEqual(
      bounds.proxyRestart + bounds.proxyHealth,
    );
  });

  test("crew tasks, queued report tasks, controllers and Pi tasks block", async () => {
    const path = crewDatabase(crew);
    for (const sql of [
      "UPDATE tasks SET status='running'",
      // A queued activity-report task (the engine's marker row).
      "UPDATE tasks SET status='completed'; INSERT INTO pending_tasks (id) VALUES ('p'); INSERT INTO activity_report_tasks VALUES ('p','c')",
      "DELETE FROM pending_tasks; INSERT INTO worker_controls VALUES ('chief')",
    ]) {
      exec(path, sql);
      expect(await checkIdle(input())).toEqual({
        idle: false,
        reason: "busy-crew",
      });
    }
    exec(path, "DELETE FROM worker_controls");
    exec(piDatabase(crew, "twiki"), "UPDATE tasks SET status='running'");
    expect(await checkIdle(input())).toEqual({
      idle: false,
      reason: "busy-pi",
    });
  });

  test("another user's OpenCode session never blocks", async () => {
    // The operator's own session on the shared server, with a pending form.
    opencode.active = ["ses_operator"];
    opencode.pending = ["ses_operator"];
    opencode.parents = { ses_operator: "ses_operator_root" };
    expect(await checkIdle(input())).toEqual({ idle: true });
  });

  test("every Stargate-owned OpenCode session blocks while it runs or waits for input", async () => {
    const busy = { idle: false, reason: "busy-opencode" } as const;
    // A gateway session mapping and a crew peer.
    for (const session of ["ses_captain", "ses_chief"]) {
      opencode.active = [session];
      expect(await checkIdle(input())).toEqual(busy);
    }
    // An operator-pinned captain session.
    opencode.active = ["ses_pinned"];
    expect((await checkIdle(input())).idle).toBe(true);
    expect(
      await checkIdle({ ...input(), pinnedSessions: ["ses_pinned"] }),
    ).toEqual(busy);
    // A crew IRC session bound in the crew store.
    exec(
      crewDatabase(crew),
      `CREATE TABLE irc_sessions (sessionID TEXT PRIMARY KEY, crewID TEXT NOT NULL);
       INSERT INTO irc_sessions VALUES ('ses_irc_chief','chief')`,
    );
    opencode.active = ["ses_irc_chief"];
    expect(await checkIdle(input())).toEqual(busy);
    // A subagent of a Stargate session, at any depth.
    opencode.active = ["ses_grandchild"];
    opencode.parents = { ses_grandchild: "ses_child", ses_child: "ses_chief" };
    expect(await checkIdle(input())).toEqual(busy);
    // A pending form or permission request of a Stargate session.
    opencode.active = [];
    opencode.pending = ["ses_child"];
    expect(await checkIdle(input())).toEqual({
      idle: false,
      reason: "pending-input",
    });
    opencode.pending = [];
    expect(await checkIdle(input())).toEqual({ idle: true });
  });

  test("a captain pinned only in the crew plugin profile is Stargate-owned", async () => {
    // No gateway mapping, no backend pin and no peer row for this captain.
    exec(join(data, "stargate.sqlite"), "DELETE FROM sessions");
    exec(crewDatabase(crew), "DELETE FROM peers");
    const pinned = { ...crew, captainSessionID: "ses_plugin_captain" };
    opencode.active = ["ses_plugin_captain"];
    expect(await checkIdle(input())).toEqual({ idle: true });
    expect(await checkIdle({ ...input(), crews: [pinned] })).toEqual({
      idle: false,
      reason: "busy-opencode",
    });
    // A pending request of one of its subagents.
    opencode.active = [];
    opencode.pending = ["ses_sub"];
    opencode.parents = { ses_sub: "ses_plugin_captain" };
    expect(await checkIdle({ ...input(), crews: [pinned] })).toEqual({
      idle: false,
      reason: "pending-input",
    });
    opencode.pending = [];
    expect(await checkIdle({ ...input(), crews: [pinned] })).toEqual({
      idle: true,
    });
  });

  test("a session whose owner cannot be read is busy", async () => {
    opencode.active = ["ses_unknown"];
    opencode.unreadable = ["ses_unknown"];
    expect(await checkIdle(input())).toEqual({
      idle: false,
      reason: "idle-unknown",
    });
  });

  test("gateway scope reads gateway jobs and cron only", async () => {
    // Crew work, a running Stargate session and an unreachable OpenCode server.
    exec(crewDatabase(crew), "UPDATE tasks SET status='running'");
    exec(piDatabase(crew, "twiki"), "UPDATE tasks SET status='running'");
    opencode.active = ["ses_chief"];
    opencode.fail = true;
    expect((await checkIdle(input())).idle).toBe(false);
    expect(await checkIdle(input("gateway"))).toEqual({ idle: true });
    exec(
      join(data, "cron.sqlite"),
      `INSERT INTO cron_schedules (id,botKey,channel,user,name,expression,timezone,prompt,nextAt,createdAt)
       VALUES ('soon','k','C1','U1','n','0 2 * * *','UTC','p',${now + 60_000},0)`,
    );
    expect(await checkIdle(input("gateway"))).toEqual({
      idle: false,
      reason: "busy-cron",
    });
    exec(join(data, "cron.sqlite"), "DELETE FROM cron_schedules");
    const store = new Store(join(data, "stargate.sqlite"));
    store.enqueue({
      eventId: "E1",
      botKey: "key",
      conversation: '["key","C1","1.0"]',
      channel: "C1",
      thread: "1.0",
      user: "U1",
      text: "hello",
    });
    store.close();
    expect(await checkIdle(input("gateway"))).toEqual({
      idle: false,
      reason: "busy-gateway",
    });
  });

  test("unknown state is never idle", async () => {
    opencode.fail = true;
    expect(await checkIdle(input())).toEqual({
      idle: false,
      reason: "idle-unknown",
    });
    opencode.fail = false;
    exec(crewDatabase(crew), "DROP TABLE worker_controls");
    expect(await checkIdle(input())).toEqual({
      idle: false,
      reason: "idle-unknown",
    });
  });

  test("waits until idle, or defers at the deadline without touching work", async () => {
    let time = now;
    const clock = {
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
        if (time >= now + 60_000) opencode.active = [];
      },
    };
    opencode.active = ["ses_chief"];
    const { now: _, ...rest } = input();
    expect(await waitForIdle(rest, now + 600_000, 30_000, clock)).toEqual({
      idle: true,
    });
    expect(time).toBe(now + 60_000);
    opencode.active = ["ses_captain"];
    time = now;
    const busy = await waitForIdle(rest, now + 60_000, 30_000, {
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
      },
    });
    expect(busy).toEqual({ idle: false, reason: "busy-opencode" });
  });
});
