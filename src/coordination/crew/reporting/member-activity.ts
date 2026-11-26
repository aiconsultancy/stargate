import type { Database } from "bun:sqlite";
import { resumeMessageID } from "../message-protocol";
import { redactCredentials } from "../../../lib/credentials";
import {
  type CrewTurns,
  type CrewTurnsInput,
  type CrewTurnsTask,
  maxTaskInputs,
  settledTasksPerMember,
} from "./fleet-status";
import {
  type CrewStatusTask,
  type CrewTaskTextMode,
  crewTaskTextLimit,
  crewTaskTextLimits,
} from "../../../shared/crew-status";

type Activity = Omit<CrewStatusTask, "id" | "status">;

/**
 * A stored row. `maskedProgress` is the ordinary view of progress that was
 * longer than the store keeps, masked from the uncut text; null otherwise.
 */
type StoredActivity = Activity & { maskedProgress: string | null };

/**
 * The first `limit` code points. Only twice that many UTF-16 units are
 * scanned, and the cut never splits a surrogate pair.
 */
function head(text: string, limit: number) {
  return text.length <= limit
    ? text
    : Array.from(text.slice(0, 2 * limit))
        .slice(0, limit)
        .join("");
}

/** The last `limit` code points, scanning at most twice that many units. */
function tail(text: string, limit: number) {
  return text.length <= limit
    ? text
    : Array.from(text.slice(-2 * limit))
        .slice(-limit)
        .join("");
}

/** The start of a summary, cut to the stored task text limit. */
export function activityText(text: string) {
  return head(text, crewTaskTextLimit);
}

/**
 * The newest progress as a producer may buffer it before the store: twice
 * the stored limit, so the store still masks with the masker's whole
 * window before it makes the final cut.
 */
export function activityProgressBuffer(text: string) {
  return tail(text, 2 * crewTaskTextLimit);
}

function maskTaskText(text: string, limit: number, keep: "head" | "tail") {
  // Control stripping can expose a credential the first pass did not see.
  const scanLimit = keep === "tail" ? 2 * crewTaskTextLimit : crewTaskTextLimit;
  const stripped = redactCredentials(text, scanLimit, keep);

  return redactCredentials(stripped, limit, keep).toWellFormed();
}

/** Ordinary progress, masked and bounded: from uncut text when it is cut. */
const maskProgress = (text: string) =>
  maskTaskText(text, crewTaskTextLimits.progress, "tail");

/**
 * How ordinary crew status shows stored text: redacted and bounded, exactly
 * as the store held it before it kept raw text. Rows written then are
 * already redacted, and redacting them again leaves them unchanged. Cut
 * progress shows its copy masked before the cut.
 */
function maskedActivity({
  maskedProgress,
  ...activity
}: StoredActivity): Activity {
  return {
    ...activity,
    summary: maskTaskText(activity.summary, crewTaskTextLimits.summary, "head"),
    progress: maskedProgress ?? maskProgress(activity.progress),
  };
}

/**
 * The ordinary bounds and ends (the summary's start, the progress tail)
 * without redaction or control stripping.
 */
function unredactedActivity({
  maskedProgress: _,
  ...activity
}: StoredActivity): Activity {
  return {
    ...activity,
    summary: head(activity.summary, crewTaskTextLimits.summary),
    progress: tail(activity.progress, crewTaskTextLimits.progress),
  };
}

const shown = {
  ordinary: maskedActivity,
  unredacted: unredactedActivity,
  full: ({ maskedProgress: _, ...activity }: StoredActivity) => activity,
} satisfies Record<CrewTaskTextMode, (stored: StoredActivity) => Activity>;

type ActivityTask = {
  id: string;
  crewID: string;
  status: CrewStatusTask["status"];
};

/** Independent of turn captures: includes the reporter's own work.
 * greybeard: latest visible snapshot, not a transcript or Pi session browser.
 */
export class MemberActivityStore {
  public constructor(private readonly db: Database) {
    db.run(`
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

    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(member_activity)")
      .all();

    // Only added: rows written before keep masking on read.
    if (!columns.some((column) => column.name === "maskedProgress")) {
      db.run("ALTER TABLE member_activity ADD COLUMN maskedProgress TEXT");
    }
  }

  public assignment<T extends ActivityTask>(
    task: T,
    text: string,
    report = false,
    /** Only the dispatcher's own prefix is excluded, never matching user text. */
    assignmentStart = 0,
  ) {
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
          : activityText(text.slice(assignmentStart)),
        task.status,
        now,
        now,
      );
    this.trim(task.crewID);
  }

  public phase<T extends ActivityTask>(task: T, phase: string) {
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

  /**
   * The store makes the only cut: the last 64,000 code points, raw, for the
   * full view. Progress that is cut keeps its ordinary view masked from the
   * uncut text, so a credential the cut splits is still masked there.
   */
  public progress(taskID: string, text: string) {
    const raw = tail(text, crewTaskTextLimit);
    const masked = raw === text ? null : maskProgress(text);
    this.db
      .query(`UPDATE member_activity SET progress=?,maskedProgress=?,updatedAt=?
      WHERE taskID=? AND (progress<>? OR maskedProgress IS NOT ?)`)
      .run(raw, masked, Date.now(), taskID, raw, masked);
  }

  /** Task text as `mode` shows it; ordinary status redacts and bounds it. */
  public task(
    task: Pick<ActivityTask, "id" | "status">,
    mode: CrewTaskTextMode = "ordinary",
  ): CrewStatusTask {
    const stored = this.db
      .query<StoredActivity, [string]>(`SELECT kind,summary,phase,
      progress,maskedProgress,createdAt,startedAt,updatedAt,finishedAt
      FROM member_activity WHERE taskID=?`)
      .get(task.id);

    const activity = stored && shown[mode](stored);

    // Known local decision; the external native stop is reported separately.
    const stop =
      task.status === "abandoned"
        ? this.db
            .query<{ stop: string }, [string]>(
              "SELECT stop FROM task_abandonments WHERE taskID=?",
            )
            .get(task.id)?.stop
        : undefined;

    // Expiry can cancel queued reports directly. Durable task state wins over
    // An older lifecycle label; reading must not write a repair event.
    const phase =
      activity?.phase === "Execution failed; outcome uncertain" &&
      task.status === "uncertain"
        ? activity.phase
        : stop && stop !== "confirmed"
          ? `abandoned; native stop ${stop}`
          : task.status;

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
      phase: head(
        phase,
        mode === "full" ? crewTaskTextLimit : crewTaskTextLimits.phase,
      ),
    };
  }

  public read(crewID: string, mode: CrewTaskTextMode = "ordinary") {
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
      .map((task) => this.task(task, mode));

    const recentCount =
      this.db
        .query<{ count: number }, [string, string]>(
          `SELECT COUNT(*) AS count FROM (${terminal})`,
        )
        .get(crewID, crewID)?.count ?? 0;

    return {
      queued: queued.map((task) => this.task(task, mode)),
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

type TaskRow = {
  id: string;
  crewID: string;
  workerSessionID: string;
  originCaptainID: string;
  inputID: string;
  status: CrewTurnsTask["status"];
};

const columns = "id,crewID,workerSessionID,originCaptainID,inputID,status";

const settled = new Set<string>(["completed", "abandoned", "cancelled"]);

/** Each member's latest tasks read for recent tasks and resume lookups. */
export const crewTurnTaskWindow = 64;

/** Resume boundaries recomputed by one input lookup. */
const resumeScan = 4096;

/**
 * Read-only task inputs of one crew state. A task's own assignment input is
 * `tasks.inputID`; each resume sends one more input whose ID derives from
 * the task and its recorded idle boundary (`task_resume_attempts`).
 * Answered questions reply to the native form and send no input.
 */
export class CrewTurnStore {
  public constructor(private readonly db: Database) {}

  /** Ready peers of `members`, the configured OpenCode roster. */
  public peers(members: ReadonlySet<string>, member?: string) {
    return this.db
      .query<{ crewID: string; sessionID: string }, [string | null]>(
        `SELECT crewID,sessionID FROM peers
        WHERE status='ready' AND (?1 IS NULL OR crewID=?1) ORDER BY crewID`,
      )
      .all(member ?? null)
      .filter(({ crewID }) => members.has(crewID));
  }

  /** A member's latest tasks, newest first, through `tasks(crewID)`. */
  public latest(member: string, limit = crewTurnTaskWindow) {
    return this.db
      .query<TaskRow & { position: number }, [string, number]>(
        `SELECT ${columns},rowid AS position FROM tasks
        WHERE crewID=? ORDER BY rowid DESC LIMIT ?`,
      )
      .all(member, limit);
  }

  /**
   * Active tasks and the latest settled ones of each member, at most
   * `settledTasksPerMember + 1`, newest active first, from each member's
   * latest tasks only: an older uncertain task is not listed.
   */
  public recent(members: readonly string[]) {
    return members.flatMap((member) => {
      const rows = this.latest(member);

      return [
        ...rows.filter(({ status }) => !settled.has(status)),
        ...rows
          .filter(({ status }) => settled.has(status))
          .slice(0, settledTasksPerMember),
      ]
        .slice(0, settledTasksPerMember + 1)
        .toSorted((a, b) => a.position - b.position)
        .map((row) => this.withInputs(row));
    });
  }

  /**
   * The task that has used `inputID`: an assignment of any age, or a resume
   * of one of the member's latest tasks (all members' with no member).
   * Older tasks' resume inputs are not attributed.
   */
  public byInput(inputID: string, member?: string) {
    const own = this.db
      .query<TaskRow, [string, string | null]>(
        `SELECT ${columns} FROM tasks WHERE inputID=?1 AND (?2 IS NULL OR crewID=?2)`,
      )
      .get(inputID, member ?? null);

    if (own) {
      return [this.withInputs(own)];
    }

    // Resume input IDs are hashes; recompute each recorded boundary.
    const latest =
      member === undefined
        ? `SELECT ${columns} FROM tasks ORDER BY rowid DESC LIMIT ?2`
        : `SELECT ${columns} FROM tasks WHERE crewID=?1 ORDER BY rowid DESC LIMIT ?2`;

    const resumed = this.db
      .query<TaskRow & { idleAt: number }, [string | null, number, number]>(
        `SELECT t.id,t.crewID,t.workerSessionID,t.originCaptainID,t.inputID,
          t.status,r.idleAt
        FROM (${latest}) t JOIN task_resume_attempts r ON r.taskID=t.id
        ORDER BY r.idleAt DESC LIMIT ?3`,
      )
      .all(member ?? null, crewTurnTaskWindow, resumeScan)
      .find((row) => resumeMessageID(row, row.idleAt) === inputID);

    return resumed ? [this.withInputs(resumed, inputID)] : [];
  }

  /** `matched`, a resume older than the latest ones, replaces the oldest. */
  private withInputs(row: TaskRow, matched?: string) {
    const resumes = this.db
      .query<{ idleAt: number }, [string, number]>(
        "SELECT idleAt FROM task_resume_attempts WHERE taskID=? ORDER BY idleAt DESC LIMIT ?",
      )
      .all(row.id, maxTaskInputs - 1)
      .toReversed()
      .map(({ idleAt }) => resumeMessageID(row, idleAt));

    if (matched !== undefined && !resumes.includes(matched)) {
      resumes.splice(0, resumes.length + 2 > maxTaskInputs ? 1 : 0, matched);
    }

    return {
      taskID: row.id,
      member: row.crewID,
      workerSessionID: row.workerSessionID,
      originCaptainID: row.originCaptainID,
      status: row.status,
      inputIDs: [row.inputID, ...resumes],
    };
  }
}

/** Each project context's crew state, with its key and namespace. */
export type CrewTurnContext = {
  project: string | null;
  namespace: string;
  /** The context's configured OpenCode members; others are never peers. */
  members: ReadonlySet<string>;
  /** Every configured member, OpenCode or not. */
  known?: ReadonlySet<string>;
  turns: CrewTurnStore;
};

export function crewTurns(
  contexts: readonly CrewTurnContext[],
  input: CrewTurnsInput,
): CrewTurns {
  const peers = contexts.map((context) => ({
    context,
    peers: context.turns.peers(context.members, input.member),
  }));

  const collected = new Map<string, boolean>();

  for (const { members, known } of contexts) {
    for (const member of [...(known ?? []), ...members]) {
      if (input.member === undefined || input.member === member) {
        collected.set(
          member,
          collected.get(member) === true || members.has(member),
        );
      }
    }
  }

  return {
    members: [...collected].map(([member, collected]) => ({
      member,
      collected,
    })),
    peers: peers.flatMap(({ context: { project, namespace }, peers }) =>
      peers.map((peer) => ({
        member: peer.crewID,
        project,
        workerSessionID: peer.sessionID,
        namespace,
      })),
    ),
    tasks: peers.flatMap(({ context: { project, turns, members }, peers }) =>
      (input.inputID === undefined
        ? turns.recent(peers.map(({ crewID }) => crewID))
        : input.member === undefined || members.has(input.member)
          ? turns.byInput(input.inputID, input.member)
          : []
      ).map((task) => ({ ...task, project })),
    ),
  };
}
