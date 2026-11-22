import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { queuedPendingTask, reportTask } from "../../../crew/pending";
import { activeRuns } from "../../../cron/store";
import type { MaintenanceDrain } from "../../maintenance-drain";
import { unfinishedJobs } from "../../../gateway/store";
import { type Crew, crewDatabase, piDatabase } from "../crews";
import type { Reason } from "../exec";
import type { OpenCodeControl } from "../opencode";

/**
 * `gateway`: no gateway job is unfinished and no cron run is active or due.
 * Enough for a restart of the gateway alone.
 *
 * `stargate`: additionally no crew or Pi task runs and no Stargate-owned OpenCode
 * session has a running turn or a pending form or permission request.
 * Needed before OpenCode or the model proxy restarts. Stargate-owned: pinned
 * captain sessions (the gateway's and each crew plugin's), sessions in the
 * gateway's mappings, crew peers, crew IRC sessions, and their subagents. Other sessions on the shared server (the
 * operator's own work) never block maintenance; a restart interrupts them.
 */
export type IdleScope = "gateway" | "stargate";
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
  /** Admission is held by the maintenance barrier; queued work resumes later. */
  draining?: boolean;
  drainUnknown?: boolean;
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
  if (input.drainUnknown) return { idle: false, reason: "idle-unknown" };
  try {
    const sessions = new Set(input.pinnedSessions);
    read(
      join(input.dataDirectory, "stargate.sqlite"),
      (db) => {
        if (
          count(
            db,
            `SELECT COUNT(*) AS n FROM jobs WHERE status IN (${input.draining ? "'running','responding'" : unfinishedJobs})`,
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
      "SELECT COUNT(*) AS n FROM cron_schedules WHERE removedAt IS NULL AND available=1 AND paused=0 AND expression<>''";
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
          `SELECT COUNT(*) AS n FROM cron_runs WHERE status IN (${activeRuns})`,
        ),
      }),
      { due: 0, overdue: 0, runs: 0 },
    );
    let due = cron.due;
    if (cron.overdue && input.gatewayRunning && !(await input.gatewayRunning()))
      due -= cron.overdue;
    // Scheduled inputs remain durable. Their actual execution is represented
    // by a running gateway job, crew task or native session below.
    if (!input.draining && (due || cron.runs)) throw new Busy("busy-cron");
    if (input.scope === "gateway") return { idle: true };
    for (const crew of input.crews) {
      // The captain is no peer row; its pin can exist in the plugin profile
      // only, without a gateway pin or mapping.
      if (crew.captainSessionID) sessions.add(crew.captainSessionID);
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
            (!input.draining &&
              count(
                db,
                `SELECT COUNT(*) AS n FROM pending_tasks WHERE ${queuedPendingTask} AND ${reportTask("pending_tasks.id")}`,
              )) ||
            count(db, "SELECT COUNT(*) AS n FROM worker_controls")
          )
            throw new Busy("busy-crew");
          // Crew stores from before IRC have no `irc_sessions` table.
          const ircSessions = count(
            db,
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='irc_sessions'",
          );
          for (const row of db
            .query<{ id: string }, []>(
              `SELECT sessionID AS id FROM peers${ircSessions ? " UNION SELECT sessionID FROM irc_sessions" : ""}`,
            )
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
    if (sessions.size === 0) return { idle: true };
    const opencode = await input.connect();
    // A subagent belongs to the session that started it, at any depth.
    const parents = new Map<string, string | undefined>();
    const owned = async (id: string) => {
      let current: string | undefined = id;
      for (let depth = 0; current !== undefined && depth < 16; depth++) {
        if (sessions.has(current)) return true;
        if (!parents.has(current))
          parents.set(current, await opencode.parent(current, input.signal));
        current = parents.get(current);
      }
      // Deeper than any real session tree: unknown is busy.
      if (current !== undefined) throw new Error("Session ancestry too deep");
      return false;
    };
    for (const id of await opencode.active(input.signal))
      if (await owned(id)) return { idle: false, reason: "busy-opencode" };
    for (const id of await opencode.pendingInput(input.signal))
      if (await owned(id)) return { idle: false, reason: "pending-input" };
    return { idle: true };
  } catch (error) {
    if (error instanceof Busy) return { idle: false, reason: error.reason };
    return { idle: false, reason: "idle-unknown" };
  }
}

/** Deadline evidence: identifiers and fixed reasons only, never inputs/results. */
export async function describeRunningWork(
  input: IdleInput,
): Promise<NonNullable<MaintenanceDrain["stragglers"]>> {
  const work: NonNullable<MaintenanceDrain["stragglers"]> = [];
  const sessions = new Set(input.pinnedSessions);
  const unknown = () => work.push({ reason: "idle-unknown" });
  if (input.drainUnknown) unknown();
  try {
    read(
      join(input.dataDirectory, "stargate.sqlite"),
      (db) => {
        for (const row of db
          .query<{ id: string }, []>(
            "SELECT DISTINCT session_id AS id FROM sessions",
          )
          .all())
          sessions.add(row.id);
        for (const row of db
          .query<{ sessionID: string | null }, []>(
            "SELECT DISTINCT s.session_id AS sessionID FROM jobs j LEFT JOIN sessions s ON s.conversation=j.conversation WHERE j.status IN ('running','responding')",
          )
          .all())
          work.push({
            ...(row.sessionID ? { sessionID: row.sessionID } : {}),
            reason: "busy-gateway",
          });
      },
      undefined,
    );
  } catch {
    unknown();
  }
  for (const crew of input.crews) {
    if (crew.captainSessionID) sessions.add(crew.captainSessionID);
    try {
      read(
        crewDatabase(crew),
        (db) => {
          for (const row of db
            .query<{ sessionID: string }, []>("SELECT sessionID FROM peers")
            .all())
            sessions.add(row.sessionID);
          if (
            count(
              db,
              "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='irc_sessions'",
            )
          )
            for (const row of db
              .query<{ sessionID: string }, []>(
                "SELECT sessionID FROM irc_sessions",
              )
              .all())
              sessions.add(row.sessionID);
          for (const row of db
            .query<{ taskID: string; sessionID: string }, []>(
              "SELECT id AS taskID,workerSessionID AS sessionID FROM tasks WHERE status IN ('dispatching','running','cancelling')",
            )
            .all())
            work.push({ ...row, reason: "busy-crew" });
          if (count(db, "SELECT COUNT(*) AS n FROM worker_controls"))
            work.push({ reason: "busy-crew" });
        },
        undefined,
      );
      for (const member of crew.piMembers)
        read(
          piDatabase(crew, member),
          (db) => {
            for (const row of db
              .query<{ taskID: string }, []>(
                "SELECT id AS taskID FROM tasks WHERE status<>'terminal'",
              )
              .all())
              work.push({ ...row, reason: "busy-pi" });
          },
          undefined,
        );
    } catch {
      unknown();
    }
  }
  if (sessions.size) {
    try {
      const control = await input.connect();
      const owned = async (id: string) => {
        let current: string | undefined = id;
        for (let depth = 0; current !== undefined && depth < 16; depth++) {
          if (sessions.has(current)) return true;
          current = await control.parent(current, input.signal);
        }
        if (current !== undefined) throw new Error("Session ancestry too deep");
        return false;
      };
      for (const sessionID of await control.active(input.signal))
        if (await owned(sessionID))
          work.push({ sessionID, reason: "busy-opencode" });
      for (const sessionID of await control.pendingInput(input.signal))
        if (await owned(sessionID))
          work.push({ sessionID, reason: "pending-input" });
    } catch {
      unknown();
    }
  }
  return [
    ...new Map(work.map((item) => [JSON.stringify(item), item])).values(),
  ].slice(0, 1000);
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
    : `Ask the captain to run stargate_crew status ${task.taskID}`;
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
