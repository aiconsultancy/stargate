import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import pino from "pino";
import type { AgentBackend } from "../src/backends/backend";
import {
  claimMaintenanceDrain,
  type MaintenanceDrain,
  readDrainParticipants,
  writeMaintenanceDrain,
} from "../src/maintenance/maintenance-drain";
import {
  type RuntimeDependencies,
  type SlackApp,
  serve,
} from "../src/app/runtime";
import { bot, identity } from "./fixtures";

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(25);
  expect(check()).toBe(true);
}

test("a runtime registers before work, observes the marker through its poll, acknowledges, then resumes", async () => {
  const root = await mkdtemp(join(tmpdir(), "stargate-drain-runtime-"));
  const directory = join(root, "drain");
  const started = Promise.withResolvers<void>();
  const phases: string[] = [];
  let resumes = 0;

  const dependencies: RuntimeDependencies = {
    drain: { directory },
    slack: () =>
      ({
        async identity() {
          return identity;
        },
        async start() {
          started.resolve();
        },
        async close() {},
        async post() {
          return "9.000";
        },
        async announce() {
          return "9.000";
        },
        cronUI: { async open() {}, async push() {}, async update() {} },
        crewUI: {
          async open() {
            return "V1";
          },
          async update() {},
        },
      }) satisfies SlackApp,
    backend: async () =>
      ({
        async createSession() {
          return "session";
        },
        async prompt() {
          return "ok";
        },
        async close() {},
        async maintenanceNotice(record: MaintenanceDrain) {
          phases.push(record.phase);

          return [{ sessionID: "ses_pin", status: "queued" as const }];
        },
        async resumeMaintenance() {
          resumes++;

          return { resumed: 0, remaining: 0 };
        },
      }) satisfies AgentBackend,
  };

  const dataDirectory = join(root, "data");
  const controller = new AbortController();

  const running = Effect.runPromise(
    serve(
      { dataDirectory, bots: [bot()] },
      pino({ level: "silent" }),
      controller.signal,
      dependencies,
    ),
  );

  try {
    await started.promise;
    // Registered before workers, and visible before any acknowledgement.
    expect(
      readDrainParticipants(directory).map((p) => p.dataDirectory),
    ).toEqual([dataDirectory]);
    await until(() => resumes >= 1); // Restart pickup, no marker

    const record: MaintenanceDrain = {
      schema: "stargate.maintenance.drain.v1",
      runID: "run-rt",
      pid: process.pid,
      job: "nightly",
      services: ["gateway"],
      startedAt: Date.now(),
      deadlineAt: Date.now() + 60_000,
      phase: "draining",
    };

    await claimMaintenanceDrain(record, directory);
    await until(
      () => readDrainParticipants(directory)[0]?.noticeStatus === "queued",
    );
    expect(phases).toEqual(["draining"]);
    const before = resumes;
    await writeMaintenanceDrain({ ...record, phase: "completed" }, directory);
    await until(() => phases.length === 2 && resumes > before);
    expect(phases).toEqual(["draining", "completed"]);
    expect(readDrainParticipants(directory)[0]).toMatchObject({
      noticeRunID: "run-rt",
      noticePhase: "completed",
      noticeStatus: "queued",
    });
  } finally {
    controller.abort();
    await running;
    expect(readDrainParticipants(directory)).toEqual([]);
    await rm(root, { recursive: true, force: true });
  }
});
