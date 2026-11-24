import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeMaintenanceDrain,
  claimMaintenanceDrain,
  DrainRuntime,
  drainNoticeText,
  type MaintenanceDrain,
  maintenanceDraining,
  maintenanceDrainSchema,
  readDrainParticipants,
  readMaintenanceDrain,
  registerDrainParticipant,
  writeMaintenanceDrain,
} from "../src/automation/maintenance/maintenance-drain";
import type { DrainParticipant } from "../src/automation/maintenance/maintenance-drain";
import type { Crew } from "../src/automation/maintenance/nightly/crews";

export type DrainCrewParity<
  T extends ((<U>() => U extends DrainParticipant["crews"][number]
    ? 1
    : 2) extends <U>() => U extends Crew ? 1 : 2
    ? true
    : false) = true,
> = T;

const cleanup: string[] = [];

afterEach(async () => {
  for (const path of cleanup.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

const directory = async () => {
  const path = await mkdtemp(join(tmpdir(), "stargate-drain-"));
  cleanup.push(path);

  return join(path, "drain");
};

const record = (extra: Partial<MaintenanceDrain> = {}): MaintenanceDrain => ({
  schema: "stargate.maintenance.drain.v1",
  runID: "run-1",
  pid: process.pid,
  job: "nightly",
  services: ["gateway"],
  startedAt: Date.now() - 1000,
  deadlineAt: Date.now() - 500,
  phase: "draining",
  ...extra,
});

test("advance notice names the planned time and completion says restart complete", () => {
  const notice = record();
  expect(drainNoticeText(notice)).toContain(
    new Date(notice.deadlineAt).toISOString(),
  );
  expect(
    drainNoticeText({ ...notice, phase: "completed" }).toLowerCase(),
  ).toContain("restart complete");
});

test("the host control lock excludes another owner and releases without stale-file deletion", async () => {
  const dir = await directory();
  await mkdir(dir, { recursive: true });
  const lock = new Database(join(dir, "drain.lock.sqlite"), { create: true });

  try {
    lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
    await expect(claimMaintenanceDrain(record(), dir)).rejects.toThrow();
    expect(readMaintenanceDrain(dir)).toBeNull();
  } finally {
    lock.close();
  }

  await claimMaintenanceDrain(record(), dir);
  expect(maintenanceDraining(dir)).toBe(true);
});

test("a newly claimed barrier takes effect even inside the same gateway poll tick", async () => {
  const dir = await directory();
  const now = Date.now();

  const control = new DrainRuntime({
    dataDirectory: "/data/race",
    pinnedSessions: () => [],
    discover: async () => [],
    warn: () => {},
    directory: dir,
    now: () => now,
  });

  expect(control.held()).toBe(false);
  await claimMaintenanceDrain(record({ startedAt: now }), dir);
  expect(control.held()).toBe(true);
  await control.close();
});

test("a restarted gateway holds queued work until its completion notice is queued", async () => {
  const dir = await directory();

  const notice = record({
    startedAt: Date.now(),
    deadlineAt: Date.now() + 60_000,
  });

  await claimMaintenanceDrain(notice, dir);
  await writeMaintenanceDrain({ ...notice, phase: "completed" }, dir);
  const sent = Promise.withResolvers<void>();

  const control = new DrainRuntime({
    dataDirectory: "/data/restarted",
    pinnedSessions: () => [],
    discover: async () => [],
    warn: () => {},
    directory: dir,
  });

  control.attach({
    broadcast: async () => {
      await sent.promise;

      return [];
    },
  });
  await control.start();
  expect(control.held()).toBe(true);
  control.tick();
  expect(control.held()).toBe(true);
  sent.resolve();
  await (control as unknown as { running?: Promise<void> }).running;
  expect(control.held()).toBe(false);
  await control.close();
});

test("restart resumption remains eligible beyond a five-minute occupied worker", async () => {
  const dir = await directory();
  let clock = Date.now();
  let resumes = 0;

  const control = new DrainRuntime({
    dataDirectory: "/data/long",
    pinnedSessions: () => [],
    discover: async () => [],
    warn: () => {},
    directory: dir,
    now: () => clock,
  });

  control.attach({
    broadcast: async () => [],
    resume: async () => {
      resumes++;

      return { remaining: 1 };
    },
  });
  await control.start();

  for (let i = 0; i < 65; i++) {
    clock += 6000;
    control.tick();
    await (control as unknown as { running?: Promise<void> }).running;
  }

  expect(resumes).toBe(65);
  await control.close();
});

/** A pid that has exited: never reused within the test. */
async function deadPid() {
  const child = Bun.spawn(["true"]);
  await child.exited;

  return child.pid;
}

test("an expired deadline never releases a live owner; terminal phases and dead owners do", async () => {
  const dir = await directory();
  expect(maintenanceDraining(dir)).toBe(false);
  await claimMaintenanceDrain(record(), dir);
  expect(maintenanceDraining(dir)).toBe(true);
  await writeMaintenanceDrain(record({ phase: "restarting" }), dir);
  expect(maintenanceDraining(dir)).toBe(true);
  expect(activeMaintenanceDrain(dir)?.phase).toBe("restarting");
  await writeMaintenanceDrain(record({ phase: "completed" }), dir);
  expect(maintenanceDraining(dir)).toBe(false);
  expect(readMaintenanceDrain(dir)?.phase).toBe("completed");
  await expect(
    writeMaintenanceDrain(record({ phase: "draining" }), dir),
  ).rejects.toThrow();
  const dead = await deadPid();
  await writeFile(
    join(dir, "drain.json"),
    JSON.stringify(record({ runID: "run-2", pid: dead })),
  );
  expect(maintenanceDraining(dir)).toBe(false);
  expect(readMaintenanceDrain(dir)?.runID).toBe("run-2");
  // The stale owner is replaced; a live different owner is not.
  await claimMaintenanceDrain(record({ runID: "run-3" }), dir);
  await expect(
    claimMaintenanceDrain(record({ runID: "run-4", pid: process.ppid }), dir),
  ).rejects.toThrow();
  await expect(
    writeMaintenanceDrain(record({ runID: "run-4" }), dir),
  ).rejects.toThrow();
});

test("a malformed marker neither freezes the host nor breaks claiming", async () => {
  const dir = await directory();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "drain.json"), "{not json");
  expect(maintenanceDraining(dir)).toBe(false);
  expect(readMaintenanceDrain(dir)).toBeNull();
  await claimMaintenanceDrain(record(), dir);
  expect(maintenanceDraining(dir)).toBe(true);
  expect(maintenanceDrainSchema).toBeDefined();
});

test("participants: live only, deduplicated, own entry visible before acknowledgement", async () => {
  const dir = await directory();

  const crews = [
    {
      namespace: "ns",
      captainDirectory: "/c",
      stateDirectory: "/s",
      roots: [],
      piMembers: [],
    },
  ];

  const handle = await registerDrainParticipant(
    { dataDirectory: "/data/a", crews, pinnedSessions: ["ses_a"] },
    dir,
  );

  expect(readDrainParticipants(dir)).toHaveLength(1);
  expect(readDrainParticipants(dir)[0]?.noticeStatus).toBeUndefined();
  await handle.update({
    noticeRunID: "r",
    noticePhase: "draining",
    noticeStatus: "queued",
  });
  expect(readDrainParticipants(dir)[0]).toMatchObject({
    pid: process.pid,
    dataDirectory: "/data/a",
    noticeStatus: "queued",
  });
  // Stale pid files are ignored and never mistaken for a participant.
  const dead = await deadPid();
  await writeFile(
    join(dir, "participants", "stale.json"),
    JSON.stringify({
      schema: "stargate.maintenance.participant.v1",
      registeredAt: Date.now(),
      participant: {
        pid: dead,
        dataDirectory: "/data/b",
        crews: [],
        pinnedSessions: [],
      },
    }),
  );
  expect(readDrainParticipants(dir).map((p) => p.dataDirectory)).toEqual([
    "/data/a",
  ]);
  await handle.close();
  expect(readDrainParticipants(dir)).toEqual([]);
});

test("runtime holds starts until the end notice is queued, then pumps resume", async () => {
  const dir = await directory();
  let clock = Date.now();
  const broadcasts: string[] = [];
  let resumed = 0;

  const control = new DrainRuntime({
    dataDirectory: "/data/a",
    pinnedSessions: () => [],
    discover: async () => [],
    warn: () => {},
    directory: dir,
    now: () => clock,
  });

  control.attach({
    async broadcast(record) {
      broadcasts.push(record.phase);

      return [{ sessionID: "ses_a", status: "queued" }];
    },
    async resume() {
      resumed++;

      return { remaining: 0 };
    },
  });
  await control.start();

  const step = async () => {
    clock += 6000;
    control.tick();
    await (control as unknown as { running?: Promise<void> }).running;
  };

  await claimMaintenanceDrain(record({ startedAt: clock }), dir);
  expect(control.held()).toBe(true);
  await step();
  expect(broadcasts).toEqual(["draining"]);
  expect(readDrainParticipants(dir)[0]).toMatchObject({
    noticeRunID: "run-1",
    noticePhase: "draining",
    noticeStatus: "queued",
  });
  await step();
  expect(broadcasts).toEqual(["draining"]); // Once only
  await writeMaintenanceDrain(
    record({ startedAt: clock, phase: "completed" }),
    dir,
  );
  // Marker is inactive but the end notice is not yet queued: still held.
  clock += 1000;
  expect(control.held()).toBe(true);
  await step();
  expect(broadcasts).toEqual(["draining", "completed"]);
  expect(control.held()).toBe(false);
  await step();
  expect(resumed).toBe(1);
  await control.close();
});

test("a dead owner is announced as aborted and releases the runtime", async () => {
  const dir = await directory();
  let clock = Date.now();
  const phases: string[] = [];

  const control = new DrainRuntime({
    dataDirectory: "/data/a",
    pinnedSessions: () => [],
    discover: async () => [],
    warn: () => {},
    directory: dir,
    now: () => clock,
  });

  control.attach({
    async broadcast(record) {
      phases.push(record.phase);

      return [];
    },
  });
  await control.start();
  await claimMaintenanceDrain(record({ startedAt: clock }), dir);
  clock += 6000;
  control.tick();
  await (control as unknown as { running?: Promise<void> }).running;
  const dead = await deadPid();
  await writeFile(
    join(dir, "drain.json"),
    JSON.stringify(record({ pid: dead, startedAt: clock })),
  );
  clock += 6000;
  control.tick();
  await (control as unknown as { running?: Promise<void> }).running;
  expect(phases).toEqual(["draining", "aborted"]);
  expect(control.held()).toBe(false);
  await control.close();
});
