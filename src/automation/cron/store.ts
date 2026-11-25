import type { Database } from "bun:sqlite";
import { Option, Result, Schema } from "effect";
import {
  type CronEvaluation,
  type CronQuotaEvent,
  type CronReportRow,
} from "./advanced";
import { type CronInput, validateCronInput } from "./input";
import { claimDailyReport, finishDailyReport } from "./report-receipts";
import {
  type QuotaObservation,
  quotaObservationSchema,
} from "../../backends/quota/quota";
import {
  type CronDailyResult,
  type CronRun,
  type CronSchedule,
  type CronScope,
  type RunRow,
  type ScheduleRow,
  activeRuns,
  advanced,
  checkBotKey,
  checkRequestId,
  checkScope,
  checkTime,
  decodeEvaluation,
  decodeSnapshot,
  openCronDatabase,
  readOptions,
  readRun,
  readSchedule,
  runtimeRegistration,
  sourceSchema,
  sourcesSchema,
  validDestinationScope,
  validNameOrId,
  validUUID,
} from "./database";

export type { CronEvaluation, CronReportRow } from "./advanced";

export type {
  CronDailyResult,
  CronRun,
  CronSchedule,
  CronScope,
} from "./database";

export { activeRuns } from "./database";

const runSelect = `SELECT s.botKey,s.channel,s.user,s.name,s.expression,
  s.timezone,s.prompt,s.source,s.report,r.id,r.scheduleId,r.dueAt,r.status,
  r.thread,r.jobId,r.snapshot,r.manual,r.evaluation
  FROM cron_runs r JOIN cron_schedules s ON s.id=r.scheduleId`;

export class CronStore {
  private readonly db: Database;

  public constructor(path: string) {
    this.db = openCronDatabase(path);
  }

  public add(
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
            .query<ScheduleRow, [string, string, string, string]>(
              `SELECT * FROM cron_schedules
            WHERE botKey=? AND channel=? AND user=? AND requestId=?`,
            )
            .get(scope.botKey, scope.channel, scope.user, requestId);

          if (existing) {
            return readSchedule(existing);
          }
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
        (id,botKey,channel,user,name,expression,timezone,prompt,nextAt,createdAt,requestId,report,options)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
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
            JSON.stringify(advanced(input)),
          );

        return schedule;
      })
      .immediate();
  }

  /** Gateway-owned fence. Management tools may check it, never replace it. */
  public bindRuntime(registration: string, signature: string): void {
    const key = runtimeRegistration(registration, signature);
    this.db
      .query(`INSERT INTO cron_runtime_bindings (registration,signature) VALUES (?,?)
      ON CONFLICT(registration) DO UPDATE SET signature=excluded.signature`)
      .run(key, signature);
  }

  public assertRuntimeBinding(
    registration: string,
    signature: string,
    botKey: string,
  ): void {
    const key = runtimeRegistration(registration, signature);
    checkBotKey(botKey);

    const binding = this.db
      .query<{ signature: string }, [string]>(
        "SELECT signature FROM cron_runtime_bindings WHERE registration=?",
      )
      .get(key);

    const different = binding
      ? binding.signature !== signature
      : this.db
          .query(`SELECT 1 FROM cron_schedules WHERE removedAt IS NULL AND botKey<>?
          AND CASE WHEN json_valid(botKey) THEN json_array(
            json_extract(botKey,'$[0]'),json_extract(botKey,'$[1]'),
            json_extract(botKey,'$[2]'),json_extract(botKey,'$[3]')) ELSE NULL END=? LIMIT 1`)
          .get(botKey, key) !== null;

    if (different) {
      throw new Error(
        "Cron gateway configuration differs; restart the gateway before managing jobs.",
      );
    }
  }

  public upsertFile(
    scope: CronScope,
    raw: CronInput,
    source: string,
    paused: boolean,
    now = Date.now(),
  ): CronSchedule {
    checkScope(scope);
    checkTime(now);
    const parsedSource = Schema.decodeUnknownResult(sourceSchema)(source);

    if (Result.isFailure(parsedSource)) {
      throw new Error("Invalid cron file source.");
    }

    if (typeof paused !== "boolean") {
      throw new Error("Invalid cron pause state.");
    }

    const { input, nextAt } = validateCronInput(raw, now);

    return this.db
      .transaction(() => {
        const existing = this.db
          .query<ScheduleRow, [string, string]>(
            "SELECT * FROM cron_schedules WHERE botKey=? AND source=?",
          )
          .get(scope.botKey, parsedSource.success);

        if (
          existing &&
          (existing.channel !== scope.channel || existing.user !== scope.user)
        ) {
          throw new Error("Cron file ownership cannot change.");
        }

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
          source: parsedSource.success,
          paused: paused ? 1 : 0,
          available: 1,
          report: input.report ?? "immediate",
        };

        // Updating content never clears removedAt or transfers ownership.
        this.db
          .query(`INSERT INTO cron_schedules
        (id,botKey,channel,user,name,expression,timezone,prompt,nextAt,createdAt,
         source,paused,available,report,options)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,
          expression=excluded.expression,timezone=excluded.timezone,
          prompt=excluded.prompt,nextAt=excluded.nextAt,paused=excluded.paused,
          available=1,report=excluded.report,options=excluded.options`)
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
            JSON.stringify(advanced(input)),
          );

        return schedule;
      })
      .immediate();
  }

  public fileAvailability(botKey: string, sources: readonly string[]): void {
    checkBotKey(botKey);
    const parsed = Schema.decodeUnknownResult(sourcesSchema)(sources);

    if (Result.isFailure(parsed)) {
      throw new Error("Invalid cron file sources.");
    }

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

        for (const source of new Set(parsed.success)) {
          available.run(botKey, source);
        }
      })
      .immediate();
  }

  /** Undefined means duplicate request or active work; neither is accepted again. */
  public runNow(
    scope: CronScope,
    nameOrId: string,
    now = Date.now(),
    requestId?: string,
  ): CronRun | undefined {
    checkScope(scope);
    checkTime(now);
    checkRequestId(requestId);

    if (!validNameOrId(nameOrId)) {
      throw new Error("Invalid cron name or identifier.");
    }

    const field = validUUID(nameOrId) ? "id" : "name";

    return this.db
      .transaction(() => {
        const matches = this.db
          .query<ScheduleRow, [string, string, string, string]>(
            `SELECT * FROM cron_schedules WHERE botKey=? AND channel=? AND user=?
          AND removedAt IS NULL AND ${field}=? LIMIT 2`,
          )
          .all(scope.botKey, scope.channel, scope.user, nameOrId);

        if (matches.length > 1) {
          throw new Error("Cron name is ambiguous; use its ID.");
        }

        const row = matches[0];

        if (!row) {
          throw new Error("Cron job not found.");
        }

        const schedule = readSchedule(row);

        if (schedule.available !== 1) {
          throw new Error("Cron job is unavailable.");
        }

        if (
          requestId !== undefined &&
          this.db
            .query("SELECT 1 FROM cron_runs WHERE scheduleId=? AND requestId=?")
            .get(schedule.id, requestId) !== null
        ) {
          return;
        }

        if (
          this.db
            .query(`SELECT 1 FROM cron_runs WHERE scheduleId=?
        AND status IN (${activeRuns})`)
            .get(schedule.id) !== null
        ) {
          return;
        }

        // Keep UNIQUE(scheduleId,dueAt), including repeated calls in one millisecond.
        return this.createRun(
          schedule,
          this.uniqueDueAt(schedule.id, now),
          true,
          requestId,
        );
      })
      .immediate();
  }

  private createRun(
    schedule: CronSchedule,
    dueAt: number,
    manual: boolean,
    requestId?: string,
    quotaEvent?: CronQuotaEvent,
  ): CronRun | undefined {
    const parsed = decodeSnapshot({
      botKey: schedule.botKey,
      channel: schedule.channel,
      user: schedule.user,
      name: schedule.name,
      expression: schedule.expression,
      timezone: schedule.timezone,
      prompt: schedule.prompt,
      source: schedule.source,
      report: schedule.report,
      ...advanced(schedule),
      ...(quotaEvent !== undefined && { quotaEvent }),
    });

    if (Result.isFailure(parsed)) {
      throw new Error("Invalid cron run state.");
    }

    const snapshot = parsed.success;
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

  private uniqueDueAt(scheduleId: string, now: number): number {
    let dueAt = now;

    const used = this.db.query(
      "SELECT 1 FROM cron_runs WHERE scheduleId=? AND dueAt=?",
    );

    while (used.get(scheduleId, dueAt) !== null) {
      dueAt++;
    }

    checkTime(dueAt);

    return dueAt;
  }

  /** Consume fresh quota observations and matching events before admitting work. */
  public claimQuota(
    botKey: string,
    snapshot: QuotaObservation,
    now: number,
  ): CronRun[] {
    checkBotKey(botKey);
    checkTime(now);
    const parsed = Schema.decodeUnknownOption(quotaObservationSchema)(snapshot);

    if (
      Option.isNone(parsed) ||
      !["ok", "partial"].includes(parsed.value.status)
    ) {
      return [];
    }

    const fresh = (observedAt: number) =>
      observedAt <= now && now - observedAt <= 120_000;

    if (!fresh(parsed.value.observedAt)) {
      return [];
    }

    return this.db
      .transaction(() => {
        const claimed: CronRun[] = [];

        for (const account of parsed.value.accounts) {
          // Alias fallback supports legacy observations. Runtime readers supply
          // A stable private identity, so display order never changes receipts.
          const accountKey = account.identity ?? account.account;
          const observedAt = account.observedAt;

          if (
            account.status !== "ok" ||
            observedAt === null ||
            !fresh(observedAt)
          ) {
            continue;
          }

          for (const window of account.windows) {
            const { resetAt, usedPercent } = window;

            if (
              window.active === false ||
              resetAt === null ||
              resetAt <= now ||
              usedPercent === null
            ) {
              continue;
            }

            const key = [
              botKey,
              account.provider,
              accountKey,
              window.window,
              window.scope,
            ] as const;

            const previous = this.db
              .query<
                {
                  resetAt: number;
                  cycleAt: number;
                  usedPercent: number;
                  observedAt: number;
                },
                [string, string, string, string, string]
              >(
                "SELECT resetAt,cycleAt,usedPercent,observedAt FROM cron_quota_state WHERE botKey=? AND provider=? AND account=? AND window=? AND scope=?",
              )
              .get(...key);

            if (previous && observedAt <= previous.observedAt) {
              continue;
            }

            const reset =
              previous !== null &&
              resetAt - previous.resetAt >= 3_600_000 &&
              (previous.usedPercent - usedPercent >= 5 ||
                previous.resetAt <= now);

            // Raw deadlines can drift in either direction. Only a qualified
            // Reset starts a new receipt cycle, even if raw timestamps repeat.
            const cycleAt = previous
              ? reset
                ? Math.max(resetAt, previous.cycleAt + 1)
                : previous.cycleAt
              : resetAt;

            this.db
              .query(`INSERT INTO cron_quota_state
            (botKey,provider,account,window,scope,resetAt,cycleAt,usedPercent,observedAt) VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(botKey,provider,account,window,scope) DO UPDATE SET
              resetAt=excluded.resetAt,cycleAt=excluded.cycleAt,usedPercent=excluded.usedPercent,observedAt=excluded.observedAt`)
              .run(...key, resetAt, cycleAt, usedPercent, observedAt);

            const matching = `s.botKey=? AND s.removedAt IS NULL
              AND json_extract(s.options,'$.trigger.provider')=?
              AND (json_extract(s.options,'$.trigger.window') IS NULL
                OR json_extract(s.options,'$.trigger.window')=?)
              AND COALESCE(json_extract(s.options,'$.trigger.scope'),'subscription')=?
              AND ((json_extract(s.options,'$.trigger.type')='quota-reset' AND ?=1)
                OR (json_extract(s.options,'$.trigger.type')='quota-threshold'
                  AND json_extract(s.options,'$.trigger.usedPercent')<=?))`;

            const matchArgs = [
              botKey,
              account.provider,
              window.window,
              window.scope,
              reset ? 1 : 0,
              usedPercent,
            ] as const;

            const schedules = this.db
              .query<
                ScheduleRow,
                [
                  string,
                  string,
                  string,
                  string,
                  number,
                  number,
                  string,
                  string,
                  string,
                  string,
                  number,
                  number,
                ]
              >(
                `SELECT s.* FROM cron_schedules s WHERE ${matching}
                AND s.paused=0 AND s.available=1
                AND NOT EXISTS (SELECT 1 FROM cron_runs r WHERE r.scheduleId=s.id AND r.status IN (${activeRuns}))
                AND NOT EXISTS (SELECT 1 FROM cron_quota_receipts q WHERE q.scheduleId=s.id
                  AND q.provider=? AND q.account=? AND q.window=? AND q.scope=? AND q.resetAt=?
                  AND q.type=json_extract(s.options,'$.trigger.type'))
                ORDER BY s.createdAt,s.id LIMIT ?`,
              )
              .all(
                ...matchArgs,
                account.provider,
                accountKey,
                window.window,
                window.scope,
                cycleAt,
                100 - claimed.length,
              )
              .map((row) => readSchedule(row));

            for (const schedule of schedules) {
              if (!schedule.trigger) {
                throw new Error("Invalid cron quota trigger state.");
              }

              const run = this.createRun(
                schedule,
                this.uniqueDueAt(schedule.id, now),
                false,
                undefined,
                {
                  type: schedule.trigger.type,
                  provider: account.provider,
                  account: account.account,
                  window: window.window,
                  scope: window.scope,
                  usedPercent,
                  previousResetAt: previous?.resetAt ?? null,
                  resetAt,
                  observedAt,
                },
              );

              if (run) {
                claimed.push(run);
              }
            }

            // Consume all matches, including paused, unavailable, busy and
            // Overflow jobs. The 100-run poll cap must not create a backlog.
            // Removed jobs cannot return, so they need no further receipts.
            // Receipt resetAt stores cycleAt; run payloads retain raw deadlines.
            this.db
              .query(`INSERT OR IGNORE INTO cron_quota_receipts
              (scheduleId,provider,account,window,scope,resetAt,type)
              SELECT s.id,?,?,?,?,?,json_extract(s.options,'$.trigger.type')
              FROM cron_schedules s WHERE ${matching}`)
              .run(
                account.provider,
                accountKey,
                window.window,
                window.scope,
                cycleAt,
                ...matchArgs,
              );
          }
        }

        return claimed;
      })
      .immediate();
  }

  public list(scope: CronScope, page = 0): CronSchedule[] {
    checkScope(scope);

    if (!Number.isSafeInteger(page) || page < 0 || page > 1_000_000) {
      throw new Error("Invalid cron page.");
    }

    return this.db
      .query<ScheduleRow, [string, string, string, number]>(
        `SELECT * FROM cron_schedules
        WHERE botKey=? AND channel=? AND user=? AND removedAt IS NULL
        ORDER BY createdAt,id LIMIT 10 OFFSET ?`,
      )
      .all(scope.botKey, scope.channel, scope.user, page * 10)
      .map((row) => readSchedule(row));
  }

  public listDestinations(
    scope: {
      botKey: string;
      channel?: string | undefined;
      user?: string | undefined;
    },
    page = 0,
  ): CronSchedule[] {
    if (!validDestinationScope(scope)) {
      throw new Error("Invalid cron ownership scope.");
    }

    if (!Number.isSafeInteger(page) || page < 0 || page > 1_000_000) {
      throw new Error("Invalid cron page.");
    }

    const channel = scope.channel ?? null;
    const user = scope.user ?? null;

    return this.db
      .query<
        ScheduleRow,
        [
          string,
          string | null,
          string | null,
          string | null,
          string | null,
          number,
        ]
      >(
        `SELECT * FROM cron_schedules
        WHERE botKey=? AND (? IS NULL OR channel=?) AND (? IS NULL OR user=?)
          AND removedAt IS NULL ORDER BY createdAt,id LIMIT 10 OFFSET ?`,
      )
      .all(scope.botKey, channel, channel, user, user, page * 10)
      .map((row) => readSchedule(row));
  }

  public findDestination(botKey: string, id: string): CronSchedule | undefined {
    checkBotKey(botKey);

    if (!validUUID(id)) {
      return undefined;
    }

    const row = this.db
      .query<ScheduleRow, [string, string]>(
        "SELECT * FROM cron_schedules WHERE botKey=? AND id=? AND removedAt IS NULL",
      )
      .get(botKey, id);

    return row ? readSchedule(row) : undefined;
  }

  public remove(scope: CronScope, id: string): boolean {
    checkScope(scope);

    if (!validUUID(id)) {
      return false;
    }

    return this.db
      .transaction(() => {
        const removed = this.db
          .query(`UPDATE cron_schedules SET removedAt=?
        WHERE id=? AND botKey=? AND channel=? AND user=? AND removedAt IS NULL`)
          .run(Date.now(), id, scope.botKey, scope.channel, scope.user).changes;

        if (removed) {
          this.db
            .query(`UPDATE cron_runs SET status='canceled' WHERE scheduleId=?
          AND status IN ('pending','evaluating','announcing','announced','blocked')`)
            .run(id);
        }

        return removed > 0;
      })
      .immediate();
  }

  public enabled(id: string, manual = false): boolean {
    return (
      this.db
        .query(`SELECT 1 FROM cron_schedules WHERE id=? AND removedAt IS NULL
          AND available=1 AND (paused=0 OR ?=1)`)
        .get(id, manual ? 1 : 0) !== null
    );
  }

  /** Claim once and move nextAt past now atomically, skipping missed intervals. */
  public claimDue(botKey: string, now: number): CronRun[] {
    checkBotKey(botKey);
    checkTime(now);

    return this.db
      .transaction(() => {
        const due = this.db
          .query<ScheduleRow, [string, number]>(
            `SELECT * FROM cron_schedules
          WHERE botKey=? AND removedAt IS NULL AND available=1 AND paused=0 AND expression<>'' AND nextAt<=?
          ORDER BY nextAt,id LIMIT 100`,
          )
          .all(botKey, now)
          .map((row) => readSchedule(row));

        const claimed: CronRun[] = [];

        for (const schedule of due) {
          const { nextAt } = validateCronInput(
            {
              name: schedule.name,
              expression: schedule.expression,
              timezone: schedule.timezone,
              prompt: schedule.prompt,
              ...advanced(schedule),
            },
            now,
          );

          this.db
            .query("UPDATE cron_schedules SET nextAt=? WHERE id=?")
            .run(nextAt, schedule.id);

          const run = this.createRun(
            schedule,
            this.uniqueDueAt(schedule.id, schedule.nextAt),
            false,
          );

          if (run) {
            claimed.push(run);
          }
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
      .map((row) => readRun(row));
  }

  public pending(botKey: string): CronRun[] {
    return this.runs(botKey, "'pending','announced'");
  }

  public queued(botKey: string, after = ""): CronRun[] {
    return this.runs(botKey, "'queued'", after);
  }

  public report(botKey: string): CronReportRow[] {
    checkBotKey(botKey);

    return this.db
      .query<CronReportRow & { options: string | null }, [string]>(`
      SELECT s.id,s.name,s.channel,s.user,s.paused,s.available,s.nextAt,s.report,
        r.dueAt AS lastRunAt,r.status AS lastStatus,s.options
      FROM cron_schedules s LEFT JOIN cron_runs r ON r.id=(
        SELECT id FROM cron_runs WHERE scheduleId=s.id ORDER BY dueAt DESC,id LIMIT 1
      ) WHERE s.botKey=? AND s.removedAt IS NULL
      ORDER BY s.createdAt,s.id LIMIT 100`)
      .all(botKey)
      .map(({ options, ...row }) => ({ ...row, ...readOptions(options) }));
  }

  /** Newest runs for an operator view: metadata only, never prompts. */
  public recentRuns(botKey: string, limit = 20) {
    checkBotKey(botKey);

    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Invalid cron run limit.");
    }

    return this.db
      .query<
        RunRow & { finishedAt: number | null },
        [string, number]
      >(`${runSelect.replace("SELECT ", "SELECT r.finishedAt,")}
      WHERE s.botKey=? ORDER BY r.dueAt DESC,r.id LIMIT ?`)
      .all(botKey, limit)
      .map((row) => {
        const run = readRun(row);

        return {
          id: run.id,
          name: run.name,
          status: run.status,
          dueAt: run.dueAt,
          finishedAt: row.finishedAt,
          manual: run.manual,
          report: run.report,
          ...advanced(run),
        };
      });
  }

  /** Include occurrences, completions, and older active work before until. */
  public dailyResults(
    botKey: string,
    since: number,
    until: number,
  ): CronDailyResult[] {
    checkBotKey(botKey);
    checkTime(since);
    checkTime(until);

    if (until <= since) {
      throw new Error("Invalid cron report window.");
    }

    return this.db
      .query<RunRow, [string, number, number, number, number]>(`${runSelect}
      WHERE s.botKey=? AND r.dueAt<? AND (
        r.dueAt>=? OR (r.finishedAt>=? AND r.finishedAt<?)
        OR r.status IN (${activeRuns}))
        AND COALESCE(json_extract(r.snapshot,'$.report'),s.report)='daily'
      ORDER BY r.dueAt,r.id LIMIT 100`)
      .all(botKey, until, since, since, until)
      .map((row) => readRun(row))
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
          evaluation,
          ...run
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
          ...advanced(run),
          ...(evaluation !== undefined && { evaluation }),
        }),
      );
  }

  public claimDailyReport(scope: CronScope, date: string): boolean {
    checkScope(scope);

    return claimDailyReport(this.db, scope, date);
  }

  public finishDailyReport(
    scope: CronScope,
    date: string,
    status: "done" | "failed",
  ): void {
    checkScope(scope);
    finishDailyReport(this.db, scope, date, status);
  }

  public recoverAnnouncements(botKey: string): number {
    return this.db
      .query(`UPDATE cron_runs SET status='failed' WHERE status='announcing'
      AND scheduleId IN (SELECT id FROM cron_schedules WHERE botKey=?)`)
      .run(botKey).changes;
  }

  public claimEvaluation(id: string): boolean {
    return (
      this.db
        .query(`UPDATE cron_runs SET status='evaluating' WHERE id=?
      AND status='pending' AND evaluation IS NULL
      AND scheduleId IN (SELECT id FROM cron_schedules WHERE removedAt IS NULL
        AND available=1 AND (paused=0 OR cron_runs.manual=1))`)
        .run(id).changes > 0
    );
  }

  public saveEvaluation(id: string, evaluation: CronEvaluation): boolean {
    const parsed = decodeEvaluation(evaluation);

    if (Result.isFailure(parsed)) {
      throw new Error("Invalid cron evaluation state.");
    }

    return (
      this.db
        .query(`UPDATE cron_runs SET status='pending',evaluation=?
      WHERE id=? AND status='evaluating' AND evaluation IS NULL`)
        .run(JSON.stringify(parsed.success), id).changes > 0
    );
  }

  public recoverEvaluations(botKey: string, now = Date.now()): number {
    checkBotKey(botKey);
    checkTime(now);

    return this.db
      .query(`UPDATE cron_runs SET status='failed',finishedAt=? WHERE status='evaluating'
      AND scheduleId IN (SELECT id FROM cron_schedules WHERE botKey=?)`)
      .run(now, botKey).changes;
  }

  public announcing(id: string): boolean {
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
  public prepareDeferred(id: string): boolean {
    return (
      this.db
        .query(`UPDATE cron_runs SET status='announced',thread='' WHERE id=?
        AND status='pending'
        AND scheduleId IN (SELECT id FROM cron_schedules WHERE removedAt IS NULL
          AND available=1 AND (paused=0 OR cron_runs.manual=1))`)
        .run(id).changes > 0
    );
  }

  public announced(id: string, thread: string): boolean {
    return (
      this.db
        .query(`UPDATE cron_runs SET status='announced',thread=?
        WHERE id=? AND status='announcing'`)
        .run(thread, id).changes > 0
    );
  }

  public enqueued(id: string, jobId: number) {
    this.db
      .query(`UPDATE cron_runs SET status='queued',jobId=?
      WHERE id=? AND status='announced'`)
      .run(jobId, id);
  }

  public finish(id: string, status: "done" | "failed", now = Date.now()) {
    checkTime(now);

    if (status !== "done" && status !== "failed") {
      throw new Error("Invalid cron run status.");
    }

    this.db
      .transaction(() => {
        const changed = this.db
          .query(`UPDATE cron_runs SET status=?,finishedAt=? WHERE id=?
        AND status IN (${activeRuns})`)
          .run(status, now, id).changes;

        if (changed && status === "done") {
          const row = this.db
            .query<RunRow, [string]>(`${runSelect} WHERE r.id=?`)
            .get(id);

          if (row && readRun(row).once === true) {
            this.db
              .query(
                "UPDATE cron_schedules SET removedAt=? WHERE id=? AND removedAt IS NULL",
              )
              .run(now, row.scheduleId);
          }
        }
      })
      .immediate();
  }

  public block(id: string) {
    this.db
      .query(`UPDATE cron_runs SET status='blocked' WHERE id=?
      AND status IN ('pending','evaluating','announced','queued')`)
      .run(id);
  }

  public close() {
    this.db.close();
  }
}
