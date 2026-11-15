import { Database } from "bun:sqlite";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { type CronInput, validateCronInput } from "./cron";

export type CronScope = { botKey: string; channel: string; user: string };
export type CronSchedule = CronInput &
  CronScope & {
    id: string;
    nextAt: number;
    createdAt: number;
    source: string | null;
    paused: number;
    available: number;
    report: "immediate" | "daily";
  };
export type CronRun = CronInput &
  CronScope & {
    id: string;
    scheduleId: string;
    dueAt: number;
    thread: string | null;
    jobId: number | null;
    source: string | null;
    manual: boolean;
    report: "immediate" | "daily";
    status:
      | "pending"
      | "announcing"
      | "announced"
      | "queued"
      | "blocked"
      | "done"
      | "failed"
      | "canceled";
  };

export type CronReportRow = Pick<
  CronSchedule,
  | "id"
  | "name"
  | "channel"
  | "user"
  | "paused"
  | "available"
  | "nextAt"
  | "report"
> & { lastRunAt: number | null; lastStatus: CronRun["status"] | null };

export type CronDailyResult = Pick<
  CronRun,
  | "id"
  | "scheduleId"
  | "name"
  | "channel"
  | "user"
  | "status"
  | "jobId"
  | "dueAt"
  | "report"
  | "manual"
>;

/**
 * SQL list: runs that are not done, failed or canceled. One schedule has at
 * most one (the `cron_active` index); the maintenance idle gate counts them.
 */
export const activeRuns =
  "'pending','announcing','announced','queued','blocked'";

const botKeySchema = z.string().min(1).max(2048);
const scopeSchema = z.strictObject({
  botKey: botKeySchema,
  channel: z.string().regex(/^[CDG][A-Z0-9]+$/),
  user: z.string().regex(/^[UW][A-Z0-9]+$/),
});
const sourceSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value) && !value.includes("\0"))
  .transform((value) => resolve(value));
const snapshotSchema = scopeSchema.extend({
  name: z.string().min(1).max(80),
  expression: z.string().min(1).max(100),
  timezone: z.string().min(1).max(100),
  prompt: z.string().min(1).max(12_000),
  source: sourceSchema.nullable(),
  report: z.enum(["immediate", "daily"]),
});
type RunRow = Omit<CronRun, "manual"> & {
  manual: number;
  snapshot: string | null;
};

const runSelect = `SELECT s.botKey,s.channel,s.user,s.name,s.expression,
  s.timezone,s.prompt,s.source,s.report,r.id,r.scheduleId,r.dueAt,r.status,
  r.thread,r.jobId,r.snapshot,r.manual
  FROM cron_runs r JOIN cron_schedules s ON s.id=r.scheduleId`;

function readRun({ snapshot, manual, ...run }: RunRow): CronRun {
  if (snapshot === null) return { ...run, manual: manual === 1 };
  try {
    return {
      ...run,
      ...snapshotSchema.parse(JSON.parse(snapshot)),
      manual: manual === 1,
    };
  } catch {
    throw new Error("Invalid cron run state.");
  }
}

function checkScope(scope: CronScope) {
  if (!scopeSchema.safeParse(scope).success)
    throw new Error("Invalid cron ownership scope.");
}

function checkBotKey(botKey: string) {
  if (!botKeySchema.safeParse(botKey).success)
    throw new Error("Invalid cron bot scope.");
}

function checkRequestId(requestId: string | undefined) {
  if (
    requestId !== undefined &&
    !z
      .string()
      .max(255)
      .refine((value) => value.trim().length > 0)
      .safeParse(requestId).success
  )
    throw new Error("Invalid cron request identifier.");
}

function checkTime(now: number) {
  if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime()))
    throw new Error("Invalid cron reference time.");
}

function checkReportDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error("Invalid cron report date.");
  const parsed = new Date(`${date}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  )
    throw new Error("Invalid cron report date.");
}

export class CronStore {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // Set privacy before SQLite creates WAL/SHM. Refuse symlink targets.
      const fd = openSync(
        path,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        if (!fstatSync(fd).isFile()) throw new Error("Invalid cron database.");
        fchmodSync(fd, 0o600);
      } finally {
        closeSync(fd);
      }
    }
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS cron_schedules (
        id TEXT PRIMARY KEY, botKey TEXT NOT NULL, channel TEXT NOT NULL,
        user TEXT NOT NULL, name TEXT NOT NULL, expression TEXT NOT NULL,
        timezone TEXT NOT NULL, prompt TEXT NOT NULL, nextAt INTEGER NOT NULL,
        createdAt INTEGER NOT NULL, removedAt INTEGER, requestId TEXT,
        UNIQUE(botKey, channel, user, requestId)
      );
      CREATE INDEX IF NOT EXISTS cron_due
        ON cron_schedules(botKey, removedAt, nextAt);
      CREATE TABLE IF NOT EXISTS cron_runs (
        id TEXT PRIMARY KEY,
        scheduleId TEXT NOT NULL REFERENCES cron_schedules(id),
        dueAt INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        thread TEXT, jobId INTEGER, UNIQUE(scheduleId, dueAt)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS cron_active ON cron_runs(scheduleId)
        WHERE status IN (${activeRuns});
    `);
    // Additive and atomic: old runs keep NULL snapshots and their join fallback.
    this.db
      .transaction(() => {
        const column = (table: string, name: string, type: string) => {
          if (
            !this.db
              .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
              .all()
              .some((column) => column.name === name)
          )
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
        };
        column("cron_schedules", "source", "TEXT");
        column("cron_schedules", "paused", "INTEGER NOT NULL DEFAULT 0");
        column("cron_schedules", "available", "INTEGER NOT NULL DEFAULT 1");
        column("cron_schedules", "report", "TEXT NOT NULL DEFAULT 'immediate'");
        column("cron_runs", "snapshot", "TEXT");
        column("cron_runs", "manual", "INTEGER NOT NULL DEFAULT 0");
        column("cron_runs", "requestId", "TEXT");
        column("cron_runs", "finishedAt", "INTEGER");
        this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS cron_source
          ON cron_schedules(botKey,source) WHERE source IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS cron_run_request
          ON cron_runs(scheduleId,requestId) WHERE requestId IS NOT NULL;
        CREATE TABLE IF NOT EXISTS cron_daily_reports (
          botKey TEXT NOT NULL, channel TEXT NOT NULL, user TEXT NOT NULL,
          date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'announcing',
          PRIMARY KEY(botKey,channel,user,date)
        );
      `);
      })
      .immediate();
  }

  add(
    scope: CronScope,
    raw: CronInput,
    now = Date.now(),
    requestId?: string,
  ): CronSchedule {
    checkScope(scope);
    checkTime(now);
    const { input, nextAt } = validateCronInput(raw, now);
    checkRequestId(requestId);
    return this.db
      .transaction(() => {
        if (requestId !== undefined) {
          const existing = this.db
            .query<CronSchedule, [string, string, string, string]>(
              `SELECT * FROM cron_schedules
            WHERE botKey=? AND channel=? AND user=? AND requestId=?`,
            )
            .get(scope.botKey, scope.channel, scope.user, requestId);
          if (existing) return existing;
        }
        const schedule = {
          ...scope,
          ...input,
          id: crypto.randomUUID(),
          nextAt,
          createdAt: now,
          source: null,
          paused: 0,
          available: 1,
          report: input.report ?? "immediate",
        };
        this.db
          .query(`INSERT INTO cron_schedules
        (id,botKey,channel,user,name,expression,timezone,prompt,nextAt,createdAt,requestId,report)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            schedule.id,
            scope.botKey,
            scope.channel,
            scope.user,
            input.name,
            input.expression,
            input.timezone,
            input.prompt,
            nextAt,
            now,
            requestId ?? null,
            schedule.report,
          );
        return schedule;
      })
      .immediate();
  }

  upsertFile(
    scope: CronScope,
    raw: CronInput,
    source: string,
    paused: boolean,
    now = Date.now(),
  ): CronSchedule {
    checkScope(scope);
    checkTime(now);
    const parsedSource = sourceSchema.safeParse(source);
    if (!parsedSource.success) throw new Error("Invalid cron file source.");
    if (typeof paused !== "boolean")
      throw new Error("Invalid cron pause state.");
    const { input, nextAt } = validateCronInput(raw, now);
    return this.db
      .transaction(() => {
        const existing = this.db
          .query<CronSchedule, [string, string]>(
            "SELECT * FROM cron_schedules WHERE botKey=? AND source=?",
          )
          .get(scope.botKey, parsedSource.data);
        if (
          existing &&
          (existing.channel !== scope.channel || existing.user !== scope.user)
        )
          throw new Error("Cron file ownership cannot change.");
        const schedule: CronSchedule = {
          ...scope,
          ...input,
          id: existing?.id ?? crypto.randomUUID(),
          createdAt: existing?.createdAt ?? now,
          nextAt:
            existing?.expression === input.expression &&
            existing.timezone === input.timezone
              ? existing.nextAt
              : nextAt,
          source: parsedSource.data,
          paused: paused ? 1 : 0,
          available: 1,
          report: input.report ?? "immediate",
        };
        // Updating content never clears removedAt or transfers ownership.
        this.db
          .query(`INSERT INTO cron_schedules
        (id,botKey,channel,user,name,expression,timezone,prompt,nextAt,createdAt,
         source,paused,available,report)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,
          expression=excluded.expression,timezone=excluded.timezone,
          prompt=excluded.prompt,nextAt=excluded.nextAt,paused=excluded.paused,
          available=1,report=excluded.report`)
          .run(
            schedule.id,
            scope.botKey,
            scope.channel,
            scope.user,
            input.name,
            input.expression,
            input.timezone,
            input.prompt,
            schedule.nextAt,
            schedule.createdAt,
            schedule.source,
            schedule.paused,
            schedule.available,
            schedule.report,
          );
        return schedule;
      })
      .immediate();
  }

  fileAvailability(botKey: string, sources: readonly string[]): void {
    checkBotKey(botKey);
    const parsed = z.array(sourceSchema).max(100).safeParse(sources);
    if (!parsed.success) throw new Error("Invalid cron file sources.");
    this.db
      .transaction(() => {
        this.db
          .query(
            "UPDATE cron_schedules SET available=0 WHERE botKey=? AND source IS NOT NULL",
          )
          .run(botKey);
        const available = this.db.query(
          "UPDATE cron_schedules SET available=1 WHERE botKey=? AND source=?",
        );
        for (const source of new Set(parsed.data))
          available.run(botKey, source);
      })
      .immediate();
  }

  /** Undefined means duplicate request or active work; neither is accepted again. */
  runNow(
    scope: CronScope,
    nameOrId: string,
    now = Date.now(),
    requestId?: string,
  ): CronRun | undefined {
    checkScope(scope);
    checkTime(now);
    checkRequestId(requestId);
    if (!z.string().min(1).max(80).safeParse(nameOrId).success)
      throw new Error("Invalid cron name or identifier.");
    const field = z.uuid().safeParse(nameOrId).success ? "id" : "name";
    return this.db
      .transaction(() => {
        const matches = this.db
          .query<CronSchedule, [string, string, string, string]>(
            `SELECT * FROM cron_schedules WHERE botKey=? AND channel=? AND user=?
          AND removedAt IS NULL AND ${field}=? LIMIT 2`,
          )
          .all(scope.botKey, scope.channel, scope.user, nameOrId);
        if (matches.length > 1)
          throw new Error("Cron name is ambiguous; use its ID.");
        const schedule = matches[0];
        if (!schedule) throw new Error("Cron job not found.");
        if (schedule.available !== 1)
          throw new Error("Cron job is unavailable.");
        if (
          requestId !== undefined &&
          this.db
            .query("SELECT 1 FROM cron_runs WHERE scheduleId=? AND requestId=?")
            .get(schedule.id, requestId)
        )
          return undefined;
        if (
          this.db
            .query(`SELECT 1 FROM cron_runs WHERE scheduleId=?
        AND status IN (${activeRuns})`)
            .get(schedule.id)
        )
          return undefined;
        // Keep UNIQUE(scheduleId,dueAt), including repeated calls in one millisecond.
        let dueAt = now;
        const used = this.db.query(
          "SELECT 1 FROM cron_runs WHERE scheduleId=? AND dueAt=?",
        );
        while (used.get(schedule.id, dueAt)) dueAt++;
        checkTime(dueAt);
        return this.createRun(schedule, dueAt, true, requestId);
      })
      .immediate();
  }

  private createRun(
    schedule: CronSchedule,
    dueAt: number,
    manual: boolean,
    requestId?: string,
  ): CronRun | undefined {
    const parsed = snapshotSchema.safeParse({
      botKey: schedule.botKey,
      channel: schedule.channel,
      user: schedule.user,
      name: schedule.name,
      expression: schedule.expression,
      timezone: schedule.timezone,
      prompt: schedule.prompt,
      source: schedule.source,
      report: schedule.report,
    });
    if (!parsed.success) throw new Error("Invalid cron run state.");
    const snapshot = parsed.data;
    const id = crypto.randomUUID();
    const inserted = this.db
      .query(`INSERT OR IGNORE INTO cron_runs
      (id,scheduleId,dueAt,snapshot,manual,requestId) VALUES (?,?,?,?,?,?)`)
      .run(
        id,
        schedule.id,
        dueAt,
        JSON.stringify(snapshot),
        manual ? 1 : 0,
        requestId ?? null,
      ).changes;
    return inserted
      ? {
          ...snapshot,
          id,
          scheduleId: schedule.id,
          dueAt,
          manual,
          status: "pending",
          thread: null,
          jobId: null,
        }
      : undefined;
  }

  list(scope: CronScope, page = 0): CronSchedule[] {
    checkScope(scope);
    if (!Number.isSafeInteger(page) || page < 0 || page > 1_000_000)
      throw new Error("Invalid cron page.");
    return this.db
      .query<CronSchedule, [string, string, string, number]>(
        `SELECT * FROM cron_schedules
        WHERE botKey=? AND channel=? AND user=? AND removedAt IS NULL
        ORDER BY createdAt,id LIMIT 10 OFFSET ?`,
      )
      .all(scope.botKey, scope.channel, scope.user, page * 10);
  }

  remove(scope: CronScope, id: string): boolean {
    checkScope(scope);
    if (!z.uuid().safeParse(id).success) return false;
    return this.db
      .transaction(() => {
        const removed = this.db
          .query(`UPDATE cron_schedules SET removedAt=?
        WHERE id=? AND botKey=? AND channel=? AND user=? AND removedAt IS NULL`)
          .run(Date.now(), id, scope.botKey, scope.channel, scope.user).changes;
        if (removed)
          this.db
            .query(`UPDATE cron_runs SET status='canceled' WHERE scheduleId=?
          AND status IN ('pending','announcing','announced','blocked')`)
            .run(id);
        return removed > 0;
      })
      .immediate();
  }

  enabled(id: string, manual = false): boolean {
    return (
      this.db
        .query(`SELECT 1 FROM cron_schedules WHERE id=? AND removedAt IS NULL
          AND available=1 AND (paused=0 OR ?=1)`)
        .get(id, manual === true ? 1 : 0) !== null
    );
  }

  /** Claim once and move nextAt past now atomically, skipping missed intervals. */
  claimDue(botKey: string, now: number): CronRun[] {
    checkBotKey(botKey);
    checkTime(now);
    return this.db
      .transaction(() => {
        const due = this.db
          .query<CronSchedule, [string, number]>(
            `SELECT * FROM cron_schedules
          WHERE botKey=? AND removedAt IS NULL AND available=1 AND paused=0 AND nextAt<=?
          ORDER BY nextAt,id LIMIT 100`,
          )
          .all(botKey, now);
        const claimed: CronRun[] = [];
        for (const schedule of due) {
          const { nextAt } = validateCronInput(
            {
              name: schedule.name,
              expression: schedule.expression,
              timezone: schedule.timezone,
              prompt: schedule.prompt,
            },
            now,
          );
          this.db
            .query("UPDATE cron_schedules SET nextAt=? WHERE id=?")
            .run(nextAt, schedule.id);
          const run = this.createRun(schedule, schedule.nextAt, false);
          if (run) claimed.push(run);
        }
        return claimed;
      })
      .immediate();
  }

  private runs(botKey: string, status: string, after = ""): CronRun[] {
    return this.db
      .query<RunRow, [string, string]>(
        `${runSelect}
        WHERE s.botKey=? AND r.status IN (${status}) AND r.id>?
        ORDER BY r.id LIMIT 100`,
      )
      .all(botKey, after)
      .map(readRun);
  }

  pending(botKey: string): CronRun[] {
    return this.runs(botKey, "'pending','announced'");
  }

  queued(botKey: string, after = ""): CronRun[] {
    return this.runs(botKey, "'queued'", after);
  }

  report(botKey: string): CronReportRow[] {
    checkBotKey(botKey);
    return this.db
      .query<CronReportRow, [string]>(`
      SELECT s.id,s.name,s.channel,s.user,s.paused,s.available,s.nextAt,s.report,
        r.dueAt AS lastRunAt,r.status AS lastStatus
      FROM cron_schedules s LEFT JOIN cron_runs r ON r.id=(
        SELECT id FROM cron_runs WHERE scheduleId=s.id ORDER BY dueAt DESC,id LIMIT 1
      ) WHERE s.botKey=? AND s.removedAt IS NULL
      ORDER BY s.createdAt,s.id LIMIT 100`)
      .all(botKey);
  }

  /** Newest runs for an operator view: metadata only, never prompts. */
  recentRuns(botKey: string, limit = 20) {
    checkBotKey(botKey);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid cron run limit.");
    return this.db
      .query<
        {
          id: string;
          name: string;
          status: CronRun["status"];
          dueAt: number;
          finishedAt: number | null;
          manual: number;
          report: "immediate" | "daily";
        },
        [string, number]
      >(`SELECT r.id,COALESCE(json_extract(r.snapshot,'$.name'),s.name) AS name,
        r.status,r.dueAt,r.finishedAt,r.manual,
        COALESCE(json_extract(r.snapshot,'$.report'),s.report) AS report
      FROM cron_runs r JOIN cron_schedules s ON s.id=r.scheduleId
      WHERE s.botKey=? ORDER BY r.dueAt DESC,r.id LIMIT ?`)
      .all(botKey, limit)
      .map((run) => ({ ...run, manual: run.manual === 1 }));
  }

  /** Include occurrences, completions, and older active work before until. */
  dailyResults(
    botKey: string,
    since: number,
    until: number,
  ): CronDailyResult[] {
    checkBotKey(botKey);
    checkTime(since);
    checkTime(until);
    if (until <= since) throw new Error("Invalid cron report window.");
    return this.db
      .query<RunRow, [string, number, number, number, number]>(`${runSelect}
      WHERE s.botKey=? AND r.dueAt<? AND (
        r.dueAt>=? OR (r.finishedAt>=? AND r.finishedAt<?)
        OR r.status IN (${activeRuns}))
        AND COALESCE(json_extract(r.snapshot,'$.report'),s.report)='daily'
      ORDER BY r.dueAt,r.id LIMIT 100`)
      .all(botKey, until, since, since, until)
      .map(readRun)
      .map(
        ({
          id,
          scheduleId,
          name,
          channel,
          user,
          status,
          jobId,
          dueAt,
          report,
          manual,
        }) => ({
          id,
          scheduleId,
          name,
          channel,
          user,
          status,
          jobId,
          dueAt,
          report,
          manual,
        }),
      );
  }

  claimDailyReport(scope: CronScope, date: string): boolean {
    checkScope(scope);
    checkReportDate(date);
    return (
      this.db
        .query(`INSERT OR IGNORE INTO cron_daily_reports
      (botKey,channel,user,date) VALUES (?,?,?,?)`)
        .run(scope.botKey, scope.channel, scope.user, date).changes > 0
    );
  }

  finishDailyReport(
    scope: CronScope,
    date: string,
    status: "done" | "failed",
  ): void {
    checkScope(scope);
    checkReportDate(date);
    if (status !== "done" && status !== "failed")
      throw new Error("Invalid cron report status.");
    this.db
      .query(`UPDATE cron_daily_reports SET status=?
      WHERE botKey=? AND channel=? AND user=? AND date=? AND status='announcing'`)
      .run(status, scope.botKey, scope.channel, scope.user, date);
  }

  recoverAnnouncements(botKey: string): number {
    return this.db
      .query(`UPDATE cron_runs SET status='failed' WHERE status='announcing'
      AND scheduleId IN (SELECT id FROM cron_schedules WHERE botKey=?)`)
      .run(botKey).changes;
  }

  announcing(id: string): boolean {
    return (
      this.db
        .query(`UPDATE cron_runs SET status='announcing' WHERE id=?
        AND status='pending'
        AND scheduleId IN (SELECT id FROM cron_schedules WHERE removedAt IS NULL
          AND available=1 AND (paused=0 OR cron_runs.manual=1))`)
        .run(id).changes > 0
    );
  }

  /** No Slack POST: persist a queue-ready run without an uncertain announcement. */
  prepareDeferred(id: string): boolean {
    return (
      this.db
        .query(`UPDATE cron_runs SET status='announced',thread='' WHERE id=?
        AND status='pending'
        AND scheduleId IN (SELECT id FROM cron_schedules WHERE removedAt IS NULL
          AND available=1 AND (paused=0 OR cron_runs.manual=1))`)
        .run(id).changes > 0
    );
  }

  announced(id: string, thread: string): boolean {
    return (
      this.db
        .query(`UPDATE cron_runs SET status='announced',thread=?
        WHERE id=? AND status='announcing'`)
        .run(thread, id).changes > 0
    );
  }

  enqueued(id: string, jobId: number) {
    this.db
      .query(`UPDATE cron_runs SET status='queued',jobId=?
      WHERE id=? AND status='announced'`)
      .run(jobId, id);
  }

  finish(id: string, status: "done" | "failed", now = Date.now()) {
    checkTime(now);
    if (status !== "done" && status !== "failed")
      throw new Error("Invalid cron run status.");
    this.db
      .query(`UPDATE cron_runs SET status=?,finishedAt=? WHERE id=?
        AND status IN (${activeRuns})`)
      .run(status, now, id);
  }

  block(id: string) {
    this.db
      .query(`UPDATE cron_runs SET status='blocked' WHERE id=?
      AND status IN ('announced','queued')`)
      .run(id);
  }

  close() {
    this.db.close();
  }
}
