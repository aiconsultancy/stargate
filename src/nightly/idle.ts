import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
            count(db, "SELECT COUNT(*) AS n FROM pending_tasks") ||
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
