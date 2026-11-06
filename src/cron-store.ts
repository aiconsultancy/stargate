import { Database } from "bun:sqlite";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { type CronInput, validateCronInput } from "./cron";

export type CronScope = { botKey: string; channel: string; user: string };
export type CronSchedule = CronInput &
  CronScope & { id: string; nextAt: number; createdAt: number };
export type CronRun = CronInput &
  CronScope & {
    id: string;
    scheduleId: string;
    dueAt: number;
    thread: string | null;
    jobId: number | null;
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

const scopeSchema = z.strictObject({
  botKey: z.string().min(1).max(2048),
  channel: z.string().regex(/^[CDG][A-Z0-9]+$/),
  user: z.string().regex(/^[UW][A-Z0-9]+$/),
});

function checkScope(scope: CronScope) {
  if (!scopeSchema.safeParse(scope).success)
    throw new Error("Invalid cron ownership scope.");
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
        WHERE status IN ('pending','announcing','announced','queued','blocked');
    `);
  }

  add(
    scope: CronScope,
    raw: CronInput,
    now = Date.now(),
    requestId?: string,
  ): CronSchedule {
    checkScope(scope);
    const { input, nextAt } = validateCronInput(raw, now);
    if (
      requestId !== undefined &&
      (!requestId.trim() || requestId.length > 255)
    )
      throw new Error("Invalid cron request identifier.");
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
        };
        this.db
          .query(`INSERT INTO cron_schedules
        (id,botKey,channel,user,name,expression,timezone,prompt,nextAt,createdAt,requestId)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
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
          );
        return schedule;
      })
      .immediate();
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

  enabled(id: string): boolean {
    return (
      this.db
        .query("SELECT 1 FROM cron_schedules WHERE id=? AND removedAt IS NULL")
        .get(id) !== null
    );
  }

  /** Claim once and move nextAt past now atomically, skipping missed intervals. */
  claimDue(botKey: string, now: number): CronRun[] {
    return this.db
      .transaction(() => {
        const due = this.db
          .query<CronSchedule, [string, number]>(
            `SELECT * FROM cron_schedules
          WHERE botKey=? AND removedAt IS NULL AND nextAt<=?
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
          const id = crypto.randomUUID();
          const inserted = this.db
            .query(`INSERT OR IGNORE INTO cron_runs(id,scheduleId,dueAt)
          VALUES (?,?,?)`)
            .run(id, schedule.id, schedule.nextAt).changes;
          if (inserted)
            claimed.push({
              ...schedule,
              id,
              scheduleId: schedule.id,
              dueAt: schedule.nextAt,
              status: "pending",
              thread: null,
              jobId: null,
            });
        }
        return claimed;
      })
      .immediate();
  }

  private runs(botKey: string, status: string, after = ""): CronRun[] {
    return this.db
      .query<CronRun, [string, string]>(
        `SELECT s.botKey,s.channel,s.user,s.name,s.expression,s.timezone,s.prompt,r.*
        FROM cron_runs r JOIN cron_schedules s ON s.id=r.scheduleId
        WHERE s.botKey=? AND r.status IN (${status}) AND r.id>?
        ORDER BY r.id LIMIT 100`,
      )
      .all(botKey, after);
  }

  pending(botKey: string): CronRun[] {
    return this.runs(botKey, "'pending','announced'");
  }

  queued(botKey: string, after = ""): CronRun[] {
    return this.runs(botKey, "'queued'", after);
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
        AND scheduleId IN (SELECT id FROM cron_schedules WHERE removedAt IS NULL)`)
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

  finish(id: string, status: "done" | "failed") {
    this.db
      .query(`UPDATE cron_runs SET status=? WHERE id=? AND status!='canceled'`)
      .run(status, id);
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
