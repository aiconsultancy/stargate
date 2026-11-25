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
import { Result, Schema, SchemaTransformation } from "effect";
import {
  type CronAdvanced,
  type CronEvaluation,
  type CronQuotaEvent,
  type CronRunStatus,
  cronAdvancedOptions,
  cronAdvancedSchema,
  cronEvaluationSchema,
  cronQuotaEventSchema,
} from "./advanced";
import type { CronInput } from "./input";
import {
  settingsPattern,
  settingsStruct,
  settingsUUID,
} from "../../config/settings-schema";

/**
 * SQL list: runs that are not done, failed or canceled. One schedule has at
 * most one (the `cron_active` index); the maintenance idle gate counts them.
 */
export const activeRuns =
  "'pending','evaluating','announcing','announced','queued','blocked'";

export function openCronDatabase(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

    // Set privacy before SQLite creates WAL/SHM. Refuse symlink targets.
    const fd = openSync(
      path,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );

    try {
      if (!fstatSync(fd).isFile()) {
        throw new Error("Invalid cron database.");
      }

      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
  }

  const db = new Database(path, { create: true, strict: true });
  db.run(`
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
  db.transaction(() => {
    const column = (table: string, name: string, type: string) => {
      if (
        !db
          .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
          .all()
          .some((column) => column.name === name)
      ) {
        db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
    };

    column("cron_schedules", "source", "TEXT");
    column("cron_schedules", "paused", "INTEGER NOT NULL DEFAULT 0");
    column("cron_schedules", "available", "INTEGER NOT NULL DEFAULT 1");
    column("cron_schedules", "report", "TEXT NOT NULL DEFAULT 'immediate'");
    column("cron_schedules", "options", "TEXT");
    column("cron_runs", "snapshot", "TEXT");
    column("cron_runs", "manual", "INTEGER NOT NULL DEFAULT 0");
    column("cron_runs", "requestId", "TEXT");
    column("cron_runs", "finishedAt", "INTEGER");
    column("cron_runs", "evaluation", "TEXT");
    db.run(`
      DROP INDEX IF EXISTS cron_active;
      CREATE UNIQUE INDEX cron_active ON cron_runs(scheduleId)
        WHERE status IN (${activeRuns});
      CREATE TABLE IF NOT EXISTS cron_quota_state (
        botKey TEXT NOT NULL, provider TEXT NOT NULL, account TEXT NOT NULL,
        window TEXT NOT NULL, scope TEXT NOT NULL, resetAt INTEGER NOT NULL,
        cycleAt INTEGER NOT NULL,
        usedPercent REAL NOT NULL, observedAt INTEGER NOT NULL,
        PRIMARY KEY(botKey,provider,account,window,scope)
      );
      CREATE TABLE IF NOT EXISTS cron_runtime_bindings (
        registration TEXT PRIMARY KEY, signature TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cron_quota_receipts (
        scheduleId TEXT NOT NULL REFERENCES cron_schedules(id),
        provider TEXT NOT NULL, account TEXT NOT NULL, window TEXT NOT NULL,
        scope TEXT NOT NULL, resetAt INTEGER NOT NULL, type TEXT NOT NULL,
        PRIMARY KEY(scheduleId,provider,account,window,scope,resetAt,type)
      );
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
    column("cron_quota_state", "cycleAt", "INTEGER");
    db.run("UPDATE cron_quota_state SET cycleAt=resetAt WHERE cycleAt IS NULL");
  }).immediate();

  return db;
}

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
    evaluation?: CronEvaluation;
    quotaEvent?: CronQuotaEvent | undefined;
    report: "immediate" | "daily";
    status: CronRunStatus;
  };

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
  | "trigger"
  | "model"
  | "once"
  | "arbiter"
  | "evaluation"
>;

const decodeOptions = Schema.decodeUnknownSync(cronAdvancedSchema);

export const decodeEvaluation =
  Schema.decodeUnknownResult(cronEvaluationSchema);

export function advanced(input: CronAdvanced): CronAdvanced {
  const result: CronAdvanced = {};

  if (input.trigger !== undefined) {
    result.trigger = input.trigger;
  }

  if (input.model !== undefined) {
    result.model = input.model;
  }

  if (input.once !== undefined) {
    result.once = input.once;
  }

  if (input.arbiter !== undefined) {
    result.arbiter = input.arbiter;
  }

  return result;
}

export function readOptions(raw: string | null): CronAdvanced {
  try {
    return decodeOptions(raw === null ? {} : JSON.parse(raw));
  } catch {
    throw new Error("Invalid cron options state.");
  }
}

export type ScheduleRow = CronSchedule & { options: string | null };

export function readSchedule({ options, ...row }: ScheduleRow): CronSchedule {
  return { ...row, ...readOptions(options) };
}

const botKeySchema = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(2048),
);

const channelSchema = Schema.String.check(settingsPattern(/^[CDG][A-Z0-9]+$/));
const userSchema = Schema.String.check(settingsPattern(/^[UW][A-Z0-9]+$/));

const scopeFields = {
  botKey: botKeySchema,
  channel: channelSchema,
  user: userSchema,
};

const scopeSchema = settingsStruct(scopeFields);

const destinationScopeSchema = settingsStruct({
  botKey: botKeySchema,
  channel: Schema.optional(channelSchema),
  user: Schema.optional(userSchema),
});

export const sourceSchema = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(4096),
  Schema.makeFilter((value) => isAbsolute(value) && !value.includes("\0")),
).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (value) => resolve(value),
      encode: (value) => value,
    }),
  ),
);

export const sourcesSchema = Schema.Array(sourceSchema).check(
  Schema.isMaxLength(100),
);

const snapshotSchema = settingsStruct({
  ...scopeFields,
  name: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(80),
  ),
  expression: Schema.String.check(Schema.isMaxCodePoints(100)),
  timezone: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(100),
  ),
  prompt: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(12_000),
  ),
  source: Schema.NullOr(sourceSchema),
  report: Schema.Literals(["immediate", "daily"]),
  ...cronAdvancedOptions,
  quotaEvent: Schema.optional(cronQuotaEventSchema),
}).check(
  Schema.makeFilter(
    (row) => row.expression.length > 0 || row.trigger !== undefined,
  ),
);

const requestIdSchema = Schema.String.check(
  Schema.isMaxCodePoints(255),
  Schema.makeFilter((value) => value.trim().length > 0),
);

const nameOrIdSchema = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(80),
);

const signatureSchema = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(8192),
);

const registrationSchema = Schema.Array(
  Schema.String.check(Schema.isMinCodePoints(1), Schema.isMaxCodePoints(2048)),
).check(Schema.isBetweenLength(4, 4));

export const decodeSnapshot = Schema.decodeUnknownResult(snapshotSchema);

const isValid =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  (value: unknown) =>
    Result.isSuccess(Schema.decodeUnknownResult(schema)(value));

const validScope = isValid(scopeSchema);
export const validDestinationScope = isValid(destinationScopeSchema);
const validBotKey = isValid(botKeySchema);
const validRequestId = isValid(requestIdSchema);
export const validNameOrId = isValid(nameOrIdSchema);
const validSignature = isValid(signatureSchema);
export const validUUID = isValid(settingsUUID);

export type RunRow = Omit<CronRun, "manual" | "evaluation"> & {
  manual: number;
  snapshot: string | null;
  evaluation: string | null;
};

export function readRun({
  snapshot,
  manual,
  evaluation,
  ...run
}: RunRow): CronRun {
  try {
    return {
      ...run,
      ...(snapshot !== null &&
        Schema.decodeUnknownSync(snapshotSchema)(JSON.parse(snapshot))),
      manual: manual === 1,
      ...(evaluation !== null && {
        evaluation: Schema.decodeUnknownSync(cronEvaluationSchema)(
          JSON.parse(evaluation),
        ),
      }),
    };
  } catch {
    throw new Error("Invalid cron run state.");
  }
}

export function checkScope(scope: CronScope) {
  if (!validScope(scope)) {
    throw new Error("Invalid cron ownership scope.");
  }
}

export function checkBotKey(botKey: string) {
  if (!validBotKey(botKey)) {
    throw new Error("Invalid cron bot scope.");
  }
}

export function checkRequestId(requestId: string | undefined) {
  if (requestId !== undefined && !validRequestId(requestId)) {
    throw new Error("Invalid cron request identifier.");
  }
}

export function checkTime(now: number) {
  if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) {
    throw new Error("Invalid cron reference time.");
  }
}

export function runtimeRegistration(
  registration: string,
  signature: string,
): string {
  try {
    if (registration.length > 8192 || !validSignature(signature)) {
      throw new Error("Invalid cron runtime registration or signature.");
    }

    return JSON.stringify(
      Schema.decodeUnknownSync(registrationSchema)(JSON.parse(registration)),
    );
  } catch {
    throw new Error("Invalid cron runtime binding.");
  }
}
