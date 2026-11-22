import type { Database } from "bun:sqlite";
import { redactCredentials } from "../../lib/credentials";
import {
  type CrewStatusTask,
  crewAssignmentText,
} from "../../shared/crew-status";

type Activity = Omit<CrewStatusTask, "id" | "status">;

type ActivityTask = {
  id: string;
  crewID: string;
  status: CrewStatusTask["status"];
};

/** Independent of turn captures: includes the reporter's own work.
 * greybeard: latest visible snapshot, not a transcript or Pi session browser.
 */
export class MemberActivityStore {
  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS member_activity (
        taskID TEXT PRIMARY KEY, crewID TEXT NOT NULL,
        kind TEXT NOT NULL, summary TEXT NOT NULL,
        phase TEXT NOT NULL, progress TEXT NOT NULL DEFAULT '',
        createdAt INTEGER, startedAt INTEGER, updatedAt INTEGER,
        finishedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS member_activity_order
        ON member_activity(crewID,updatedAt);
      CREATE INDEX IF NOT EXISTS member_task_history ON tasks(crewID);
    `);
  }

  assignment<T extends ActivityTask>(task: T, text: string, report = false) {
    const now = Date.now();
    this.db
      .query(`INSERT INTO member_activity
      (taskID,crewID,kind,summary,phase,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?)`)
      .run(
        task.id,
        task.crewID,
        report ? "report" : "assignment",
        report
          ? "Prepare crew activity report"
          : redactCredentials(crewAssignmentText(text), 180),
        task.status,
        now,
        now,
      );
    this.trim(task.crewID);
  }

  phase<T extends ActivityTask>(task: T, phase: string) {
    const now = Date.now();

    const terminal = [
      "completed",
      "uncertain",
      "cancelled",
      "abandoned",
    ].includes(task.status);

    // Legacy tasks keep unknown creation/start times. Never backfill invented times.
    this.db
      .query(`INSERT INTO member_activity
      (taskID,crewID,kind,summary,phase,updatedAt,finishedAt)
      VALUES (?,?,'unknown','Task detail unavailable',?,?,?)
      ON CONFLICT(taskID) DO UPDATE SET phase=excluded.phase,
        updatedAt=excluded.updatedAt,
        startedAt=CASE WHEN ?='running' THEN COALESCE(member_activity.startedAt,?)
          ELSE member_activity.startedAt END,
        finishedAt=CASE WHEN ? THEN ? ELSE member_activity.finishedAt END`)
      .run(
        task.id,
        task.crewID,
        phase,
        now,
        terminal ? now : null,
        phase,
        now,
        terminal,
        now,
      );
    this.trim(task.crewID);
  }

  progress(taskID: string, text: string) {
    const safe = redactCredentials(text, 64_000).slice(-400);
    this.db
      .query(`UPDATE member_activity SET progress=?,updatedAt=?
      WHERE taskID=? AND progress<>?`)
      .run(safe, Date.now(), taskID, safe);
  }

  task(task: Pick<ActivityTask, "id" | "status">): CrewStatusTask {
    const activity = this.db
      .query<Activity, [string]>(`SELECT kind,summary,phase,
      progress,createdAt,startedAt,updatedAt,finishedAt
      FROM member_activity WHERE taskID=?`)
      .get(task.id);

    // Known local decision; the external native stop is reported separately.
    const stop =
      task.status === "abandoned"
        ? this.db
            .query<{ stop: string }, [string]>(
              "SELECT stop FROM task_abandonments WHERE taskID=?",
            )
            .get(task.id)?.stop
        : undefined;

    return {
      id: task.id,
      status: task.status,
      ...(activity ?? {
        kind: "unknown",
        summary: "Task detail unavailable",
        phase: task.status,
        progress: "",
        createdAt: null,
        startedAt: null,
        updatedAt: null,
        finishedAt: null,
      }),
      // Expiry can cancel queued reports directly. Durable task state wins over
      // An older lifecycle label; reading must not write a repair event.
      phase:
        activity?.phase === "Execution failed; outcome uncertain" &&
        task.status === "uncertain"
          ? activity.phase
          : stop && stop !== "confirmed"
            ? `abandoned; native stop ${stop}`
            : task.status,
    };
  }

  read(crewID: string) {
    const queued = this.db
      .query<Pick<ActivityTask, "id" | "status">, [string]>(
        `SELECT id,status FROM pending_tasks WHERE crewID=? AND status='queued'
       ORDER BY sequence LIMIT 5`,
      )
      .all(crewID);

    const queuedCount =
      this.db
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) AS count FROM pending_tasks WHERE crewID=? AND status='queued'`,
        )
        .get(crewID)?.count ?? 0;

    const terminal = `SELECT t.id,t.status,COALESCE(a.finishedAt,a.updatedAt,0) AS time,
      t.rowid AS sequence FROM tasks t LEFT JOIN member_activity a ON a.taskID=t.id
      WHERE t.crewID=? AND t.status IN ('completed','uncertain','abandoned','cancelled')
      UNION ALL SELECT p.id,p.status,COALESCE(a.finishedAt,a.updatedAt,0),p.sequence
      FROM pending_tasks p LEFT JOIN member_activity a ON a.taskID=p.id
      WHERE p.crewID=? AND p.status='cancelled'`;

    const recent = this.db
      .query<Pick<ActivityTask, "id" | "status">, [string, string]>(
        `SELECT id,status FROM (${terminal}) ORDER BY time DESC,sequence DESC LIMIT 8`,
      )
      .all(crewID, crewID)
      .map((task) => this.task(task));

    const recentCount =
      this.db
        .query<{ count: number }, [string, string]>(
          `SELECT COUNT(*) AS count FROM (${terminal})`,
        )
        .get(crewID, crewID)?.count ?? 0;

    return {
      queued: queued.map((task) => this.task(task)),
      queuedCount,
      lastOutcome: recent[0] ?? null,
      recent,
      recentCount,
    };
  }

  private trim(crewID: string) {
    // Retain active/queued metadata and 12 recent tasks per member. Task/result,
    // Mail and turn-capture histories are never removed by this bounded view.
    this.db
      .query(`DELETE FROM member_activity WHERE crewID=?
      AND taskID NOT IN (SELECT id FROM tasks WHERE crewID=? AND released=0)
      AND taskID NOT IN (SELECT id FROM pending_tasks WHERE crewID=? AND status='queued')
      AND taskID NOT IN (SELECT taskID FROM member_activity WHERE crewID=?
        AND taskID IN (SELECT id FROM tasks WHERE crewID=?
          AND status IN ('completed','uncertain','abandoned','cancelled')
          UNION SELECT id FROM pending_tasks WHERE crewID=? AND status='cancelled')
        ORDER BY updatedAt DESC,rowid DESC LIMIT 12)`)
      .run(crewID, crewID, crewID, crewID, crewID, crewID);
  }
}
