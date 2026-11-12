import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { queuedPendingTask, reportTask } from "../crew/pending";
import { type Crew, crewDatabase, piDatabase } from "./crews";
import type { Reason } from "./exec";
import type { OpenCodeControl } from "./opencode";

/**
 * `pogo`: the gateway, its cron, crew and Pi work, and Pogo-owned OpenCode
 * sessions are idle. `server`: additionally no session on the shared OpenCode
 * server is running and no form or permission request is pending, because a
 * server restart interrupts every session.
 */
export type IdleScope = "pogo" | "server";
export type IdleResult = { idle: true } | { idle: false; reason: Reason };

export type IdleInput = {
  dataDirectory: string;
  crews: readonly Crew[];
  /** Operator-pinned captain sessions from the gateway configuration. */
  pinnedSessions: readonly string[];
  cronHorizonMs: number;
  now: number;
  scope: IdleScope;
  connect: () => Promise<OpenCodeControl>;
  signal: AbortSignal;
  /**
   * Whether the gateway advances its cron schedules: a ready, live process.
   * Overdue schedules of a stopped or crash-looping gateway are not pending
   * work. An unknown state must answer true (busy-safe); without this
   * function, overdue schedules count.
   */
  gatewayRunning?: () => Promise<boolean>;
};

class Busy extends Error {
  constructor(readonly reason: Reason) {
    super(reason);
  }
}

/** Read-only query; a missing database has no work. */
function read<T>(path: string, query: (db: Database) => T, empty: T): T {
  if (!existsSync(path)) return empty;
  const db = new Database(path, { readonly: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return query(db);
  } finally {
    db.close();
  }
}

const count = (db: Database, sql: string, ...args: number[]) =>
  db.query<{ n: number }, number[]>(sql).get(...args)?.n ?? 0;

/** Never interrupts or changes work: it only observes. Unknown is busy. */
export async function checkIdle(input: IdleInput): Promise<IdleResult> {
  try {
    const sessions = new Set(input.pinnedSessions);
    read(
      join(input.dataDirectory, "pogo.sqlite"),
      (db) => {
        if (
          count(
            db,
            "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running','responding')",
          )
        )
          throw new Busy("busy-gateway");
        for (const row of db
          .query<{ id: string }, []>(
            "SELECT DISTINCT session_id AS id FROM sessions",
          )
          .all())
          sessions.add(row.id);
      },
      undefined,
    );
    const schedules =
      "SELECT COUNT(*) AS n FROM cron_schedules WHERE removedAt IS NULL AND available=1 AND paused=0";
    const cron = read(
      join(input.dataDirectory, "cron.sqlite"),
      (db) => ({
        due: count(
          db,
          `${schedules} AND nextAt<=?`,
          input.now + input.cronHorizonMs,
        ),
        overdue: count(db, `${schedules} AND nextAt<?`, input.now),
        runs: count(
          db,
          "SELECT COUNT(*) AS n FROM cron_runs WHERE status IN ('pending','announcing','announced','queued','blocked')",
        ),
      }),
      { due: 0, overdue: 0, runs: 0 },
    );
    let due = cron.due;
    if (cron.overdue && input.gatewayRunning && !(await input.gatewayRunning()))
      due -= cron.overdue;
    if (due || cron.runs) throw new Busy("busy-cron");
    for (const crew of input.crews) {
      read(
        crewDatabase(crew),
        (db) => {
          if (
            count(
              db,
              "SELECT COUNT(*) AS n FROM tasks WHERE status IN ('dispatching','running','cancelling')",
            ) ||
            // Queued report tasks only: the gateway can admit them without a
            // captain turn. An ordinary queued assignment starts only inside
            // a captain turn, which the session check below sees. Cancelled
            // rows are terminal.
            count(
              db,
              `SELECT COUNT(*) AS n FROM pending_tasks WHERE ${queuedPendingTask} AND ${reportTask("pending_tasks.id")}`,
            ) ||
            count(db, "SELECT COUNT(*) AS n FROM worker_controls")
          )
            throw new Busy("busy-crew");
          for (const row of db
            .query<{ id: string }, []>("SELECT sessionID AS id FROM peers")
            .all())
            sessions.add(row.id);
        },
        undefined,
      );
      for (const member of crew.piMembers)
        read(
          piDatabase(crew, member),
          (db) => {
            if (
              count(
                db,
                "SELECT COUNT(*) AS n FROM tasks WHERE status<>'terminal'",
              )
            )
              throw new Busy("busy-pi");
          },
          undefined,
        );
    }
    if (input.scope === "pogo" && sessions.size === 0) return { idle: true };
    const opencode = await input.connect();
    const active = await opencode.active(input.signal);
    if (
      input.scope === "server"
        ? active.length > 0
        : active.some((id) => sessions.has(id))
    )
      return { idle: false, reason: "busy-opencode" };
    if (input.scope === "server" && (await opencode.pendingInput(input.signal)))
      return { idle: false, reason: "pending-input" };
    return { idle: true };
  } catch (error) {
    if (error instanceof Busy) return { idle: false, reason: error.reason };
    return { idle: false, reason: "idle-unknown" };
  }
}

export type QueuedCrewTask = {
  taskID: string;
  crew: string;
  originCaptain: string;
  /** The origin is the crew's pinned captain (not an earlier session). */
  originIsPin: boolean;
  /** An activity-report task: it blocks the gate; the gateway admits it. */
  report: boolean;
};

/** What resolves a queued task; the same words in reports and droid posts. */
export function queuedTaskAction(task: QueuedCrewTask) {
  return task.report
    ? "Activity report: the gateway admits or cancels it; it blocks maintenance while queued"
    : `Ask the captain to run pogo_crew status ${task.taskID}`;
}

/**
 * Queued crew tasks, for reports: IDs and origins only, never the task
 * text. Every queued task is listed, also the ordinary assignments that do
 * not block the gate: one starts only when its captain asks for its status,
 * so a forgotten one (for example from an earlier captain session) waits
 * until the operator asks. Unreadable state lists nothing; the gate itself
 * treats it as busy.
 */
export function queuedCrewTasks(crews: readonly Crew[]): QueuedCrewTask[] {
  const id = /^[A-Za-z0-9_-]{1,100}$/;
  const session = /^ses_[A-Za-z0-9]{1,250}$/;
  const list: QueuedCrewTask[] = [];
  for (const crew of crews) {
    try {
      const rows = read(
        crewDatabase(crew),
        (db) =>
          db
            .query<
              { id: string; crewID: string; origin: string; report: number },
              []
            >(
              `SELECT id, crewID, originCaptainID AS origin, ${reportTask("pending_tasks.id")} AS report FROM pending_tasks WHERE ${queuedPendingTask} ORDER BY sequence LIMIT 50`,
            )
            .all(),
        [],
      );
      for (const row of rows)
        if (id.test(row.id) && id.test(row.crewID) && session.test(row.origin))
          list.push({
            taskID: row.id,
            crew: row.crewID,
            originCaptain: row.origin,
            originIsPin: row.origin === crew.captainSessionID,
            report: row.report === 1,
          });
    } catch {
      // Reported as busy by the gate; nothing to name here.
    }
  }
  return list.slice(0, 50);
}

/**
 * Poll until idle or until `until`. Returns the last result. Waiting never
 * changes queued work; a deferral leaves everything for the next night.
 */
export async function waitForIdle(
  input: Omit<IdleInput, "now">,
  until: number,
  pollMs: number,
  clock: {
    now(): number;
    sleep(ms: number, signal: AbortSignal): Promise<void>;
  },
): Promise<IdleResult> {
  for (;;) {
    const result = await checkIdle({ ...input, now: clock.now() });
    if (result.idle || clock.now() + pollMs >= until || input.signal.aborted)
      return result;
    await clock.sleep(pollMs, input.signal);
  }
}
