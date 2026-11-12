import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { CronStore } from "../src/cron-store";
import { type Crew, crewDatabase, piDatabase } from "../src/nightly/crews";
import { checkIdle, type IdleInput, waitForIdle } from "../src/nightly/idle";
import type { OpenCodeControl } from "../src/nightly/opencode";
import { Store } from "../src/store";

const root = await mkdtemp("/tmp/opencode/pogo-idle-");
afterAll(() => rm(root, { recursive: true, force: true }));

const opencode = {
  active: [] as string[],
  pending: false,
  fail: false,
};
const control = {
  active: async () => opencode.active,
  pendingInput: async () => opencode.pending,
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
  opencode.pending = false;
  opencode.fail = false;
  data = join(root, `case-${count++}`);
  await mkdir(data, { recursive: true });
  const store = new Store(join(data, "pogo.sqlite"));
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
    CREATE TABLE pending_tasks (id TEXT PRIMARY KEY);
    CREATE TABLE worker_controls (crewID TEXT PRIMARY KEY);
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

const input = (scope: "pogo" | "server" = "pogo"): IdleInput => ({
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
  test("idle when no work is queued, due or running", async () => {
    expect(await checkIdle(input())).toEqual({ idle: true });
    expect(await checkIdle(input("server"))).toEqual({ idle: true });
  });

  test("gateway jobs block", async () => {
    const store = new Store(join(data, "pogo.sqlite"));
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

  test("crew tasks, queued assignments, controllers and Pi tasks block", async () => {
    const path = crewDatabase(crew);
    for (const sql of [
      "UPDATE tasks SET status='running'",
      "UPDATE tasks SET status='completed'; INSERT INTO pending_tasks VALUES ('p')",
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

  test("OpenCode activity: Pogo sessions for pogo scope, any session for server scope", async () => {
    opencode.active = ["ses_operator"];
    expect((await checkIdle(input("pogo"))).idle).toBe(true);
    expect(await checkIdle(input("server"))).toEqual({
      idle: false,
      reason: "busy-opencode",
    });
    opencode.active = ["ses_chief"];
    expect(await checkIdle(input("pogo"))).toEqual({
      idle: false,
      reason: "busy-opencode",
    });
    opencode.active = [];
    opencode.pending = true;
    expect(await checkIdle(input("server"))).toEqual({
      idle: false,
      reason: "pending-input",
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
