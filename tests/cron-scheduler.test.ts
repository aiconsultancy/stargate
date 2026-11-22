import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import {
  CronScheduler,
  type ScheduledInput,
  type SchedulerGateway,
} from "../src/cron/index";
import { CronStore } from "../src/cron/store";
import { botKey } from "../src/gateway/routing";
import { bot, identity } from "./fixtures";

const now = Date.parse("2026-01-01T00:00:00Z");

const input = {
  name: "Report",
  expression: "* * * * *",
  timezone: "UTC",
  prompt: "Prepare private report.",
};

const stores: CronStore[] = [];
const directories: string[] = [];
const signal = new AbortController().signal;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "stargate-cron-scheduler-"));
  directories.push(directory);
  const path = join(directory, "cron.sqlite");
  const config = bot();

  const scope = {
    botKey: botKey(config, identity),
    channel: "C123",
    user: "U123",
  };

  const store = new CronStore(path);
  stores.push(store);
  const roots: string[] = [];

  const jobs = new Map<
    string,
    { id: number; input: ScheduledInput; status: "running" | "done" | "failed" }
  >();

  const gateway: SchedulerGateway = {
    enqueueScheduled(value) {
      const existing = jobs.get(value.runId);

      if (existing) return existing.id;
      const id = jobs.size + 1;
      jobs.set(value.runId, { id, input: value, status: "running" });

      return id;
    },
    scheduledStatus(id) {
      return [...jobs.values()].find((job) => job.id === id)?.status;
    },
  };

  const slack = {
    async announce(_channel: string, text: string, _signal: AbortSignal) {
      roots.push(text);

      return `${roots.length}.000`;
    },
  };

  const log = pino({ level: "silent" });

  const scheduler = () =>
    new CronScheduler(config, identity, store, gateway, slack, log);

  function rows() {
    const db = new Database(path, { readonly: true });

    try {
      return db
        .query<{ status: string; thread: string | null }, []>(
          "SELECT status,thread FROM cron_runs ORDER BY dueAt,id",
        )
        .all();
    } finally {
      db.close();
    }
  }

  return { config, scope, store, roots, jobs, gateway, slack, scheduler, rows };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();

  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("CronScheduler", () => {
  test("announces before durable queue admission; never overlaps until terminal", async () => {
    const f = fixture();
    f.store.add(f.scope, input, now);
    const worker = f.scheduler();
    await worker.tick(now, signal);
    expect(f.roots).toEqual([]);
    await worker.tick(now + 60_000, signal);
    expect(f.roots).toEqual(["Scheduled task: Report"]);
    const job = [...f.jobs.values()][0];
    expect(job?.input.thread).toBe("1.000");
    expect(job?.input.prompt).toBe(input.prompt);
    expect(f.rows()).toEqual([{ status: "queued", thread: "1.000" }]);
    await worker.tick(now + 120_000, signal);
    expect(f.jobs.size).toBe(1);

    if (!job) throw new Error("Expected queued job");
    job.status = "done";
    await worker.tick(now + 180_000, signal);
    expect(f.jobs.size).toBe(2);
    expect(f.roots).toHaveLength(2);
  });

  test("restart coalesces missed intervals and does not enqueue running work twice", async () => {
    const f = fixture();
    f.store.add(f.scope, input, now);
    const later = now + 86_400_000;
    await f.scheduler().tick(later, signal);
    await f.scheduler().tick(later, signal);
    expect(f.jobs.size).toBe(1);
    expect(f.roots).toHaveLength(1);
    expect(f.store.list(f.scope)[0]?.nextAt).toBe(later + 60_000);
  });

  test("crash before root POST never reposts that occurrence", async () => {
    const f = fixture();
    f.store.add(f.scope, input, now);
    const run = f.store.claimDue(f.scope.botKey, now + 60_000)[0];

    if (!run) throw new Error("Expected due run");
    f.store.announcing(run.id);
    await f.scheduler().tick(now + 60_000, signal);
    expect(f.roots).toEqual([]);
    expect(f.jobs.size).toBe(0);
    expect(f.rows()[0]?.status).toBe("failed");
    await f.scheduler().tick(now + 120_000, signal);
    expect(f.jobs.size).toBe(1);
  });

  test("ambiguous POST failure gets no retry; next recurrence still works", async () => {
    const f = fixture();
    f.store.add(f.scope, input, now);
    f.slack.announce = async () => {
      throw new Error("secret transport payload");
    };

    const worker = f.scheduler();
    await worker.tick(now + 60_000, signal);
    await worker.tick(now + 60_000, signal);
    expect(f.rows()).toEqual([{ status: "failed", thread: null }]);
    expect(f.jobs.size).toBe(0);
    f.slack.announce = async () => "2.000";
    await worker.tick(now + 120_000, signal);
    expect(f.jobs.size).toBe(1);
  });

  test("crash after root persistence resumes queue admission without another POST", async () => {
    const f = fixture();
    f.store.add(f.scope, input, now);
    const run = f.store.claimDue(f.scope.botKey, now + 60_000)[0];

    if (!run) throw new Error("Expected due run");
    f.store.announcing(run.id);
    f.store.announced(run.id, "5.000");
    // Simulate a crash after queue commit but before cron's enqueued write.
    f.gateway.enqueueScheduled({
      runId: run.id,
      channel: run.channel,
      user: run.user,
      prompt: run.prompt,
      thread: "5.000",
      name: run.name,
    });
    await f.scheduler().tick(now + 60_000, signal);
    expect(f.jobs.size).toBe(1);
    expect(f.roots).toEqual([]);
    expect(f.rows()).toEqual([{ status: "queued", thread: "5.000" }]);
  });

  test("denied due and pending work fails closed", async () => {
    const f = fixture();
    f.store.add(f.scope, input, now);
    f.store.claimDue(f.scope.botKey, now + 60_000);
    f.config.access.deniedUsers.push("U123");
    await f.scheduler().tick(now + 60_000, signal);
    expect(f.roots).toEqual([]);
    expect(f.jobs.size).toBe(0);
    f.config.access.deniedUsers = [];
    f.config.access.deniedChannels.push("C123");
    await f.scheduler().tick(now + 120_000, signal);
    expect(f.jobs.size).toBe(0);
    expect(f.rows().every((row) => row.status === "failed")).toBe(true);
  });

  test("policy revoked while announcing prevents queue admission", async () => {
    const f = fixture();
    f.store.add(f.scope, input, now);
    f.slack.announce = async () => {
      f.config.access.deniedUsers.push("U123");

      return "1.000";
    };

    await f.scheduler().tick(now + 60_000, signal);
    expect(f.jobs.size).toBe(0);
    expect(f.rows()[0]?.status).toBe("failed");
  });

  test("removing a schedule while announcing prevents enqueue and all future runs", async () => {
    const f = fixture();
    const schedule = f.store.add(f.scope, input, now);
    f.slack.announce = async () => {
      f.store.remove(f.scope, schedule.id);

      return "1.000";
    };

    const worker = f.scheduler();
    await worker.tick(now + 60_000, signal);
    await worker.tick(now + 120_000, signal);
    expect(f.jobs.size).toBe(0);
    expect(f.rows()[0]?.status).toBe("canceled");
  });

  test("shutdown preserves saved root and resumes without reannouncing", async () => {
    const f = fixture();
    f.store.add(f.scope, input, now);
    const shutdown = new AbortController();
    f.slack.announce = async () => {
      shutdown.abort();

      return "9.000";
    };

    await f.scheduler().tick(now + 60_000, shutdown.signal);
    expect(f.rows()).toEqual([{ status: "announced", thread: "9.000" }]);
    expect(f.jobs.size).toBe(0);
    await f.scheduler().tick(now + 60_000, signal);
    expect(f.jobs.size).toBe(1);
    expect([...f.jobs.values()][0]?.input.thread).toBe("9.000");
    await f.scheduler().work(shutdown.signal);
  });

  test("already aborted ticks neither claim nor deliver", async () => {
    const f = fixture();
    f.store.add(f.scope, input, now);
    const shutdown = new AbortController();
    shutdown.abort();
    await f.scheduler().tick(now + 60_000, shutdown.signal);
    expect(f.rows()).toEqual([]);
    expect(f.roots).toEqual([]);
  });

  test("unknown queue state and thrown queue admission hold instead of replaying", async () => {
    const f = fixture();
    f.store.add(f.scope, input, now);
    const worker = f.scheduler();
    await worker.tick(now + 60_000, signal);
    f.jobs.clear();
    await worker.tick(now + 120_000, signal);
    await worker.tick(now + 180_000, signal);
    expect(f.roots).toHaveLength(1);
    expect(f.rows()[0]?.status).toBe("blocked");
    const other = fixture();
    other.store.add(other.scope, input, now);
    other.gateway.enqueueScheduled = () => {
      throw new Error("uncertain write");
    };

    const otherWorker = other.scheduler();
    await otherWorker.tick(now + 60_000, signal);
    await otherWorker.tick(now + 120_000, signal);
    expect(other.roots).toHaveLength(1);
    expect(other.rows()[0]?.status).toBe("blocked");
  });

  test("queue rejection finishes the run, and concurrent ticks share one claim", async () => {
    const f = fixture();
    f.store.add(f.scope, input, now);
    f.gateway.enqueueScheduled = () => undefined;
    const worker = f.scheduler();
    await Promise.all([
      worker.tick(now + 60_000, signal),
      worker.tick(now + 60_000, signal),
    ]);
    expect(f.roots).toHaveLength(1);
    expect(f.rows()[0]?.status).toBe("failed");
  });

  test("status polling reaches later batches behind long-running jobs", async () => {
    const f = fixture();

    for (let index = 0; index < 101; index++) f.store.add(f.scope, input, now);
    const worker = f.scheduler();
    await worker.tick(now + 60_000, signal);
    await worker.tick(now + 60_000, signal);
    expect(f.jobs.size).toBe(101);

    const firstBatch = new Set(
      f.store.queued(f.scope.botKey).map((run) => run.id),
    );

    const last = [...f.jobs.values()].find(
      (job) => !firstBatch.has(job.input.runId),
    );

    if (!last) throw new Error("Expected later queued run");
    last.status = "done";

    // A batch added behind the cursor waits for the next complete scan.
    for (let pass = 0; pass < 3; pass++)
      await worker.tick(now + 60_000, signal);
    expect(f.rows().filter((row) => row.status === "done")).toHaveLength(1);
  });
});
