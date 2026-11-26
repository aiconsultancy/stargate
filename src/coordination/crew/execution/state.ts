import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { UpdateNotices } from "../../../automation/maintenance/update-notice";
import { canExpandCrew } from "./identity";
import { IrcSessions } from "../messaging/irc";
import {
  CrewTurnStore,
  MemberActivityStore,
} from "../reporting/member-activity";
import { MailRoutes } from "../messaging/messaging";
import {
  CrewError,
  type CrewID,
  type CrewTask,
  queuedPendingTask,
  reportTask,
} from "../pending";
import { CrewDrainRecords } from "./drain-records";

import { ReportingStore } from "../reporting/reporting";
import {
  type AbandonExpected,
  CrewTaskRecords,
  type Peer,
  type StatusRequest,
  type StopPhase,
  type TaskAbandonment,
  type TaskAssignment,
  type TaskReconciliation,
  assignmentPrompt,
} from "./task-records";

export { type CrewID, CrewError, type CrewTask } from "../pending";

export {
  type AbandonableStatus,
  type Peer,
  type StatusRequest,
  type StopPhase,
  type TaskAbandonment,
  type TaskReconciliation,
  withdrawKey,
} from "./task-records";

export type CrewNotice = { id: number; taskID: string; text: string };

export type CrewQuestionOffer = {
  token: string;
  taskID: string;
  workerSessionID: string;
  inputID: string;
  originCaptainID: string;
  formID: string;
  fingerprint: string;
  questionJSON: string;
  expires: number;
  notified: number;
  state: "offered" | "attempted";
  outcome: "answered" | "cancelled" | "uncertain" | null;
};

/** Greybeard: bounded captain-selected queue; no background scheduler. */
export const pendingTaskLimit = 100;

type QueuedTask = CrewTask & { text: string };

/** Bare assignments and report prompts have no generated preamble. */
const assignmentParts = (input: string | TaskAssignment): TaskAssignment =>
  typeof input === "string" ? { preamble: "", assignment: input } : input;

const tasksTable = (name: string) => `${name} (
          id TEXT PRIMARY KEY,
          crewID TEXT NOT NULL REFERENCES peers(crewID),
          workerSessionID TEXT NOT NULL,
          originCaptainID TEXT NOT NULL,
          originInputID TEXT,
          inputID TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK(status IN ('dispatching','running',
            'completed','cancelling','uncertain','abandoned','cancelled')),
          result TEXT,
          released INTEGER NOT NULL DEFAULT 0,
          notifying INTEGER NOT NULL DEFAULT 0
        )`;

export class CrewState {
  public readonly updateNotices: UpdateNotices;
  private readonly drainRecords: CrewDrainRecords;
  private readonly taskRecords: CrewTaskRecords;
  public readonly reporting: ReportingStore;
  public readonly activity: MemberActivityStore;
  public readonly turns: CrewTurnStore;
  public readonly mailRoutes: MailRoutes;
  public readonly ircSessions: IrcSessions;
  private constructor(
    public readonly path: string,
    private readonly db: Database,
    /** Configured root of a pinned team; not part of the crew identity. */
    public readonly captainSessionID?: string,
  ) {
    this.updateNotices = new UpdateNotices(db);
    this.drainRecords = new CrewDrainRecords(db, this.updateNotices);
    this.reporting = new ReportingStore(db, (id) => this.captainRoute(id));
    this.activity = new MemberActivityStore(db);
    this.turns = new CrewTurnStore(db);
    this.mailRoutes = new MailRoutes(db);
    this.ircSessions = new IrcSessions(db);
    this.taskRecords = new CrewTaskRecords(
      db,
      path,
      this.reporting,
      this.activity,
    );
  }

  public static async open(
    directory: string,
    namespace: string,
    fingerprint: string,
    legacyFingerprint?: string,
    allowCrewExpansion = false,
    captainSessionID?: string,
  ) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const hash = createHash("sha256").update(namespace).digest("hex");
    const path = join(directory, `crew-${hash}.sqlite`);
    const file = await open(path, "a", 0o600);
    await file.close();
    await chmod(path, 0o600);
    const db = new Database(path, { create: true, strict: true });

    try {
      db.run(`
        PRAGMA busy_timeout=5000;
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS identity (value TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS peers (
          crewID TEXT PRIMARY KEY,
          sessionID TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK(status IN ('pending','ready'))
        );
        CREATE TABLE ${tasksTable("IF NOT EXISTS tasks")};
        CREATE UNIQUE INDEX IF NOT EXISTS active_worker
          ON tasks(crewID) WHERE released=0;
        CREATE TABLE IF NOT EXISTS notices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          taskID TEXT NOT NULL REFERENCES tasks(id), text TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mail_cursors (
          sessionID TEXT NOT NULL, taskID TEXT NOT NULL REFERENCES tasks(id),
          sequence INTEGER NOT NULL, PRIMARY KEY(sessionID,taskID)
        );
        CREATE TABLE IF NOT EXISTS pending_tasks (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          crewID TEXT NOT NULL REFERENCES peers(crewID),
          workerSessionID TEXT NOT NULL,
          originCaptainID TEXT NOT NULL,
          originInputID TEXT,
          inputID TEXT NOT NULL UNIQUE,
          text TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('queued','cancelled')) DEFAULT 'queued',
          result TEXT DEFAULT NULL,
          released INTEGER NOT NULL DEFAULT 0,
          notifying INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS pending_worker ON pending_tasks(crewID,status,sequence);
        CREATE TABLE IF NOT EXISTS worker_controls (
          crewID TEXT PRIMARY KEY REFERENCES peers(crewID), token TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS task_resume_attempts (
          taskID TEXT NOT NULL REFERENCES tasks(id),
          idleAt INTEGER NOT NULL,
          requestedBy TEXT NOT NULL,
          requestedAt INTEGER NOT NULL,
          admitted INTEGER NOT NULL DEFAULT 0 CHECK(admitted IN (0,1)),
          PRIMARY KEY (taskID, idleAt)
        );
        CREATE TABLE IF NOT EXISTS task_reconciliations (
          taskID TEXT PRIMARY KEY REFERENCES tasks(id),
          workerSessionID TEXT NOT NULL, originCaptainID TEXT NOT NULL,
          inputID TEXT NOT NULL, reconciledBy TEXT NOT NULL,
          previousStatus TEXT NOT NULL CHECK(previousStatus='uncertain'),
          previousResult TEXT, resultMessageID TEXT NOT NULL,
          inputSha256 TEXT NOT NULL, resultSha256 TEXT NOT NULL,
          reason TEXT NOT NULL, createdAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS crew_status_requests (
          id TEXT PRIMARY KEY, taskID TEXT NOT NULL REFERENCES tasks(id),
          captainID TEXT NOT NULL, workerSessionID TEXT NOT NULL,
          receiptID TEXT UNIQUE
        );
        CREATE TABLE IF NOT EXISTS crew_questions (
          token TEXT PRIMARY KEY, taskID TEXT NOT NULL REFERENCES tasks(id),
          workerSessionID TEXT NOT NULL, inputID TEXT NOT NULL,
          originCaptainID TEXT NOT NULL, formID TEXT NOT NULL,
          fingerprint TEXT NOT NULL, questionJSON TEXT NOT NULL,
          expires INTEGER NOT NULL, notified INTEGER NOT NULL DEFAULT 0,
          state TEXT NOT NULL CHECK(state IN ('offered','attempted')),
          outcome TEXT CHECK(outcome IN ('answered','cancelled','uncertain')),
          UNIQUE(taskID,formID)
        );
        CREATE TABLE IF NOT EXISTS crew_question_consumer (
          slot INTEGER PRIMARY KEY CHECK(slot=1), captain TEXT NOT NULL,
          daemonPID INTEGER NOT NULL, seenAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pi_peers (
          sessionID TEXT PRIMARY KEY REFERENCES peers(sessionID),
          conversationID TEXT
        );
        CREATE TABLE IF NOT EXISTS task_abandonments (
          taskID TEXT PRIMARY KEY REFERENCES tasks(id),
          crewID TEXT NOT NULL, workerSessionID TEXT NOT NULL,
          originCaptainID TEXT NOT NULL, inputID TEXT NOT NULL,
          abandonedBy TEXT NOT NULL,
          previousStatus TEXT NOT NULL CHECK(previousStatus IN
            ('dispatching','running','cancelling','uncertain')),
          previousResult TEXT, reason TEXT NOT NULL,
          operationKey TEXT NOT NULL, clearedControlID TEXT,
          controlToken TEXT NOT NULL,
          stop TEXT NOT NULL CHECK(stop IN ('pending','confirmed','unconfirmed')),
          stopDetail TEXT, createdAt INTEGER NOT NULL, stoppedAt INTEGER
        );
        CREATE TABLE IF NOT EXISTS pi_task_conversations (
          taskID TEXT PRIMARY KEY REFERENCES tasks(id),
          conversationID TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS maintenance_queued_tasks (
          taskID TEXT PRIMARY KEY, runID TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS drain_notice_receipts (
          sessionID TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(sessionID,id)
        );
      `);

      const legacyPeers = /CHECK\s*\(\s*crewID\s+IN\s*\(/i.test(
        db
          .query<{ sql: string }, []>(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='peers'",
          )
          .get()?.sql ?? "",
      );

      // Older state predates the terminal abandoned/cancelled task statuses.
      const legacyTasks = !(
        db
          .query<{ sql: string }, []>(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'",
          )
          .get()?.sql ?? ""
      ).includes("'abandoned'");

      if ((allowCrewExpansion && legacyPeers) || legacyTasks) {
        db.run("PRAGMA foreign_keys=OFF");
      }

      db.transaction(() => {
        const identity = db
          .query<{ value: string }, []>("SELECT value FROM identity")
          .get();

        const expansion =
          identity &&
          allowCrewExpansion &&
          canExpandCrew(identity.value, fingerprint);

        if (
          identity &&
          identity.value !== fingerprint &&
          identity.value !== legacyFingerprint &&
          !expansion
        ) {
          throw new CrewError(
            "Crew configuration changed. Restore its original identity and directories or use a new namespace; do not delete state.",
          );
        }

        if (expansion && legacyPeers) {
          // Rebuild only the obsolete fixed-roster constraint; child IDs and
          // Every existing row remain unchanged in this same transaction.
          db.run(`
            CREATE TABLE peers_expansion (
              crewID TEXT PRIMARY KEY,
              sessionID TEXT NOT NULL UNIQUE,
              status TEXT NOT NULL CHECK(status IN ('pending','ready'))
            );
            INSERT INTO peers_expansion SELECT crewID,sessionID,status FROM peers;
            DROP TABLE peers;
            ALTER TABLE peers_expansion RENAME TO peers;
          `);

          if (db.query("PRAGMA foreign_key_check").all().length > 0) {
            throw new CrewError(
              "Crew expansion failed its reference check; original state retained.",
            );
          }
        }

        if (legacyTasks) {
          // Widen only the status CHECK. Every row, rowid (recent-order key)
          // And referencing table stays as is; legacy uncertain stays uncertain.
          const columns =
            "rowid,id,crewID,workerSessionID,originCaptainID,inputID,status,result,released,notifying";

          db.run(`
            CREATE TABLE ${tasksTable("tasks_terminal")};
            INSERT INTO tasks_terminal (${columns}) SELECT ${columns} FROM tasks;
            DROP TABLE tasks;
            ALTER TABLE tasks_terminal RENAME TO tasks;
            CREATE UNIQUE INDEX IF NOT EXISTS active_worker
              ON tasks(crewID) WHERE released=0;
          `);

          if (db.query("PRAGMA foreign_key_check").all().length > 0) {
            throw new CrewError(
              "Crew task status upgrade failed its reference check; original state retained.",
            );
          }
        }

        // Add provenance after legacy rebuilds; retained rows stay untagged.
        for (const table of ["tasks", "pending_tasks"]) {
          if (
            !db
              .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
              .all()
              .some((column) => column.name === "originInputID")
          ) {
            db.run(`ALTER TABLE ${table} ADD COLUMN originInputID TEXT`);
          }
        }

        if (identity && identity.value !== fingerprint) {
          db.query("UPDATE identity SET value=? WHERE value=?").run(
            fingerprint,
            identity.value,
          );
        }

        if (!identity) {
          db.query("INSERT INTO identity VALUES (?)").run(fingerprint);
        }
      }).immediate();
      db.run("PRAGMA foreign_keys=ON");

      return new CrewState(path, db, captainSessionID);
    } catch (error) {
      db.close();

      if (error instanceof CrewError) {
        throw error;
      }

      throw new CrewError(
        "Crew state unavailable. Check private state directory access; do not delete state.",
      );
    }
  }

  public peerBySession(sessionID: string): Peer | null {
    return this.db
      .query<Peer, [string]>("SELECT * FROM peers WHERE sessionID=?")
      .get(sessionID);
  }

  /**
   * Pinned teams only: the configured root, or an earlier root that this
   * team's stored evidence records as a captain. Never a worker, an empty
   * context, or an unknown session.
   */
  public captainLineage(id: string): boolean {
    const pin = this.captainSessionID;

    if (!pin || !id || this.peerBySession(id)) {
      return false;
    }

    return (
      id === pin ||
      this.db
        .query(`SELECT 1 FROM tasks WHERE originCaptainID=?1
          UNION ALL SELECT 1 FROM pending_tasks WHERE originCaptainID=?1
          UNION ALL SELECT 1 FROM crew_status_requests WHERE captainID=?1
          UNION ALL SELECT 1 FROM mail_routes WHERE captainID=?1 AND sender=?1
          LIMIT 1`)
        .get(id) !== null
    );
  }

  /** Mail, wakes and journal context for stored lineage use the pinned root. */
  public captainRoute(id: string): string {
    return this.captainLineage(id) ? (this.captainSessionID ?? id) : id;
  }

  /** Caller must be an authenticated captain; the pin inherits lineage. */
  public requestedStatus(taskID: string, captainID: string): boolean {
    return this.db
      .query<{ captainID: string }, [string]>(
        "SELECT captainID FROM crew_status_requests WHERE taskID=?",
      )
      .all(taskID)
      .some(
        (request) =>
          request.captainID === captainID ||
          (captainID === this.captainSessionID &&
            this.captainLineage(request.captainID)),
      );
  }

  public reservePeer(crewID: CrewID): Peer {
    return this.db
      .transaction(() => {
        this.db
          .query("INSERT OR IGNORE INTO peers VALUES (?,?,'pending')")
          .run(crewID, `ses_${randomUUID().replaceAll("-", "")}`);
        const peer = this.peer(crewID);

        if (!peer) {
          throw new CrewError("Crew reservation failed. Inspect crew state.");
        }

        return peer;
      })
      .immediate();
  }

  public readyPeer(crewID: CrewID) {
    this.db.query("UPDATE peers SET status='ready' WHERE crewID=?").run(crewID);
  }

  public piPeer(sessionID: string) {
    return this.db
      .query<{ conversationID: string | null }, [string]>(
        "SELECT conversationID FROM pi_peers WHERE sessionID=?",
      )
      .get(sessionID);
  }

  public reservePiPeer(sessionID: string): boolean {
    return (
      this.db
        .query("INSERT OR IGNORE INTO pi_peers(sessionID) VALUES (?)")
        .run(sessionID).changes === 1
    );
  }

  public readyPiPeer(sessionID: string, conversationID: string) {
    if (
      this.db
        .query(
          "UPDATE pi_peers SET conversationID=? WHERE sessionID=? AND conversationID IS NULL",
        )
        .run(conversationID, sessionID).changes !== 1
    ) {
      throw new CrewError(
        "Pi conversation reservation changed; inspect crew state.",
      );
    }
  }

  /** Persist before native admission. Idempotent for the same conversation;
   * only the current, unreleased dispatching/running task may bind.
   */
  public savePiTaskConversation(taskID: string, conversationID: string) {
    this.db
      .transaction(() => {
        const task = this.db
          .query<CrewTask, [string]>("SELECT * FROM tasks WHERE id=?")
          .get(taskID);

        const saved = this.piTaskConversation(taskID);

        if (saved === conversationID) {
          return;
        }

        if (
          saved !== undefined ||
          task?.released !== 0 ||
          (task.status !== "dispatching" && task.status !== "running") ||
          this.activeTask(task.crewID)?.id !== task.id
        ) {
          throw new CrewError(
            "Pi task conversation binding refused: task is not current or is bound elsewhere.",
          );
        }

        this.db
          .query("INSERT INTO pi_task_conversations VALUES (?,?)")
          .run(taskID, conversationID);
      })
      .immediate();
  }

  public piTaskConversation(taskID: string): string | undefined {
    return (
      this.db
        .query<{ conversationID: string }, [string]>(
          "SELECT conversationID FROM pi_task_conversations WHERE taskID=?",
        )
        .get(taskID)?.conversationID ?? undefined
    );
  }

  /** History authorization is a state read, never task reconciliation. */
  public piOwnsConversation(
    sessionID: string,
    conversationID: string,
  ): boolean {
    return Boolean(
      this.db
        .query(`SELECT 1 FROM pi_peers
      WHERE sessionID=?1 AND conversationID=?2
      UNION ALL SELECT 1 FROM pi_task_conversations c JOIN tasks t ON t.id=c.taskID
      JOIN peers p ON p.sessionID=t.workerSessionID AND p.crewID=t.crewID
      WHERE p.sessionID=?1 AND c.conversationID=?2 LIMIT 1`)
        .get(sessionID, conversationID),
    );
  }

  /** Distinct recorded task/report conversations; bounded keyset pagination. */
  public piHistoryConversations(
    sessionID: string,
    after: string,
    limit: number,
    updatedSince: number | null = null,
  ) {
    return this.db
      .query<
        { conversationID: string; title: string; updatedAt: number | null },
        [string, string, number, number | null]
      >(
        `SELECT c.conversationID, MAX(CASE WHEN ${reportTask("t.id")}
        THEN 'report' ELSE 'task' END) AS title, MAX(a.updatedAt) AS updatedAt
      FROM pi_task_conversations c JOIN tasks t ON t.id=c.taskID
      LEFT JOIN member_activity a ON a.taskID=t.id
      JOIN peers p ON p.sessionID=t.workerSessionID AND p.crewID=t.crewID
      JOIN pi_peers pi ON pi.sessionID=p.sessionID
      WHERE p.sessionID=?1 AND c.conversationID<>pi.conversationID
        AND c.conversationID>?2
      GROUP BY c.conversationID
      HAVING ?4 IS NULL OR MAX(a.updatedAt)>=?4
      ORDER BY CASE WHEN ?4 IS NOT NULL THEN MAX(a.updatedAt) END DESC,
        c.conversationID LIMIT ?3`,
      )
      .all(sessionID, after, limit, updatedSince);
  }

  /** Share gateway presence across the daemon's separate plugin locations. */
  public noteCrewQuestionConsumer(at: number) {
    if (!this.captainSessionID) {
      return;
    }

    this.db
      .query(`INSERT INTO crew_question_consumer VALUES (1,?,?,?)
        ON CONFLICT(slot) DO UPDATE SET captain=excluded.captain,
        daemonPID=excluded.daemonPID, seenAt=excluded.seenAt`)
      .run(this.captainSessionID, process.pid, at);
  }

  public hasCrewQuestionConsumer(at: number, leaseMs: number) {
    return (
      !!this.captainSessionID &&
      this.db
        .query(`SELECT 1 FROM crew_question_consumer
          WHERE slot=1 AND captain=? AND daemonPID=? AND seenAt>? AND seenAt<=?`)
        .get(this.captainSessionID, process.pid, at - leaseMs, at) !== null
    );
  }

  public offerCrewQuestion(offer: CrewQuestionOffer): CrewQuestionOffer | null {
    this.db
      .query(`INSERT OR IGNORE INTO crew_questions
      (token,taskID,workerSessionID,inputID,originCaptainID,formID,
       fingerprint,questionJSON,expires,notified,state,outcome)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        offer.token,
        offer.taskID,
        offer.workerSessionID,
        offer.inputID,
        offer.originCaptainID,
        offer.formID,
        offer.fingerprint,
        offer.questionJSON,
        offer.expires,
        offer.notified,
        offer.state,
        offer.outcome,
      );

    return this.db
      .query<CrewQuestionOffer, [string, string]>(
        "SELECT * FROM crew_questions WHERE taskID=? AND formID=?",
      )
      .get(offer.taskID, offer.formID);
  }

  public crewQuestion(token: string): CrewQuestionOffer | null {
    return this.db
      .query<CrewQuestionOffer, [string]>(
        "SELECT * FROM crew_questions WHERE token=?",
      )
      .get(token);
  }

  public crewQuestionOffers(taskID: string): CrewQuestionOffer[] {
    return this.db
      .query<CrewQuestionOffer, [string]>(
        `SELECT * FROM crew_questions WHERE taskID=?
        ORDER BY CASE WHEN state='attempted' AND outcome IS NULL THEN 0
          WHEN state='offered' THEN 1 ELSE 2 END,formID LIMIT 16`,
      )
      .all(taskID);
  }

  public crewQuestionNotified(token: string) {
    this.db
      .query("UPDATE crew_questions SET notified=1 WHERE token=?")
      .run(token);
  }

  /** The write lease survives crashes; native requests are never replayed. */
  public claimCrewQuestion(
    token: string,
    now: number,
    expired = false,
  ): boolean {
    return (
      this.db
        .query(`UPDATE crew_questions SET state='attempted'
      WHERE token=?1 AND state='offered' AND
        (CASE WHEN ?3 THEN expires<=?2 ELSE expires>?2 END)
      AND EXISTS (SELECT 1 FROM tasks t JOIN peers p ON p.crewID=t.crewID
        AND p.sessionID=t.workerSessionID AND p.status='ready'
        WHERE t.id=crew_questions.taskID AND t.released=0
        AND t.status='running'
        AND t.workerSessionID=crew_questions.workerSessionID
        AND t.inputID=crew_questions.inputID
        AND t.originCaptainID=crew_questions.originCaptainID)`)
        .run(token, now, Number(expired)).changes === 1
    );
  }

  public crewQuestionOutcome(
    token: string,
    outcome: NonNullable<CrewQuestionOffer["outcome"]>,
  ) {
    this.db
      .query(`UPDATE crew_questions SET outcome=?
      WHERE token=? AND state='attempted' AND (outcome IS NULL OR outcome='uncertain')`)
      .run(outcome, token);
  }

  public queuedTasks(crewID: string): CrewTask[] {
    return this.db
      .query<CrewTask, [string]>(
        `SELECT id,crewID,workerSessionID,originCaptainID,originInputID,inputID,status,result,released,notifying
         FROM pending_tasks WHERE crewID=? AND ${queuedPendingTask} ORDER BY sequence`,
      )
      .all(crewID);
  }

  public enqueue(
    peer: Peer,
    captainID: string,
    input: string | TaskAssignment,
    reportCaptureID?: string,
    originInputID: string | null = null,
    { drainRunID }: { drainRunID?: string } = {},
  ): CrewTask {
    const parts = assignmentParts(input);
    // The queue's text column holds the ready-to-send prompt, as in old rows.
    // The activity row takes the assignment separately below.
    const prompt = assignmentPrompt(parts);

    return this.db
      .transaction(() => {
        if (reportCaptureID) {
          const capture = this.reporting.owned(captainID, reportCaptureID);
          const previous = this.reporting.reportTaskID(reportCaptureID);

          if (previous) {
            const task = this.task(previous);

            if (!task) {
              throw new CrewError("Reporting task reservation missing.");
            }

            return task;
          }

          if (
            capture.status !== "summarizing" ||
            capture.reporterID !== peer.crewID
          ) {
            throw new CrewError(
              "Reporting capture is not eligible for admission.",
            );
          }

          const active = this.activeTask(peer.crewID);

          if (
            this.controlled(peer.crewID) ||
            (active && (active.status !== "completed" || active.notifying))
          ) {
            throw new CrewError(
              "Summary skipped: reporter is busy or uncertain.",
            );
          }
        }

        const count =
          this.db
            .query<{ count: number }, [string]>(
              `SELECT COUNT(*) AS count FROM pending_tasks WHERE crewID=? AND ${queuedPendingTask}`,
            )
            .get(peer.crewID)?.count ?? 0;

        if (count >= pendingTaskLimit) {
          throw new CrewError(
            `Worker queue full: limit ${pendingTaskLimit} pending tasks per worker.`,
          );
        }

        const id = `task_${randomUUID()}`;
        this.db
          .query(
            `INSERT INTO pending_tasks (id,crewID,workerSessionID,originCaptainID,originInputID,inputID,text) VALUES (?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            peer.crewID,
            peer.sessionID,
            captainID,
            originInputID,
            `msg_${randomUUID()}`,
            prompt,
          );
        const task = this.task(id);

        if (!task) {
          throw new CrewError("Queue reservation failed.");
        }

        if (drainRunID) {
          this.drainRecords.markQueued(id, drainRunID);
        }

        if (reportCaptureID) {
          this.reporting.markReport(id, reportCaptureID);
        } else {
          this.reporting.assignment(task, prompt);
        }

        this.activity.assignment(task, parts.assignment, !!reportCaptureID);

        return task;
      })
      .immediate();
  }

  /** Called only after SDK idle confirmation. Snapshot guards concurrent reuse. */
  public promote(
    id: string,
    previousID: string | null,
  ): { task: CrewTask; text: string } | null {
    return this.db
      .transaction(() => {
        const queued = this.db
          .query<QueuedTask, [string]>(
            `SELECT * FROM pending_tasks WHERE id=? AND ${queuedPendingTask}`,
          )
          .get(id);

        if (queued?.status !== "queued" || this.controlled(queued.crewID)) {
          return null;
        }

        const active = this.activeTask(queued.crewID);

        if ((active?.id ?? null) !== previousID) {
          return null;
        }

        if (active && !this.release(active.id)) {
          return null;
        }

        this.db
          .query(
            `INSERT INTO tasks (id,crewID,workerSessionID,originCaptainID,originInputID,inputID,status) VALUES (?,?,?,?,?,?,'dispatching')`,
          )
          .run(
            queued.id,
            queued.crewID,
            queued.workerSessionID,
            queued.originCaptainID,
            queued.originInputID,
            queued.inputID,
          );
        this.db.query("DELETE FROM pending_tasks WHERE id=?").run(id);
        const task = this.task(id);

        if (!task) {
          throw new CrewError("Queue promotion failed.");
        }

        this.activity.phase(task, "dispatching");

        return { task, text: queued.text };
      })
      .immediate();
  }

  public cancelQueued(id: string, captainID: string): boolean {
    const cancelled =
      this.db
        .query(
          "UPDATE pending_tasks SET status='cancelled',released=1 WHERE id=? AND originCaptainID=? AND status='queued'",
        )
        .run(id, captainID).changes === 1;

    const task = this.task(id);

    if (cancelled && task) {
      this.reporting.record(task, "update", "Cancelled");
      this.activity.phase(task, "cancelled");
    }

    return cancelled;
  }

  public drainQueued(): CrewTask[] {
    return this.drainRecords.drainQueued();
  }

  public queueDrainNotice(
    sessionID: string,
    id: string,
    text: string,
    scope: string,
  ): "queued" | "unchanged" {
    return this.drainRecords.queueDrainNotice(sessionID, id, text, scope);
  }

  public notice(taskID: string, text: string) {
    this.db
      .query("INSERT INTO notices(taskID,text) VALUES (?,?)")
      .run(taskID, text);
  }

  public noticeOnce(messageID: string, taskID: string, text: string) {
    this.db
      .transaction(() => {
        if (this.mailRoutes.notice(messageID)) {
          this.notice(taskID, text);
        }
      })
      .immediate();
  }

  public notices(taskID: string, after: number): CrewNotice[] {
    return this.db
      .query<CrewNotice, [string, number]>(
        "SELECT * FROM notices WHERE taskID=? AND id>? ORDER BY id",
      )
      .all(taskID, after);
  }

  public mailCursor(
    sessionID: string,
    taskID: string,
    acknowledged?: number,
  ): number {
    return this.db
      .transaction(() => {
        if (acknowledged !== undefined) {
          this.db
            .query(`INSERT INTO mail_cursors VALUES (?,?,?)
          ON CONFLICT(sessionID,taskID) DO UPDATE
          SET sequence=MAX(sequence,excluded.sequence)`)
            .run(sessionID, taskID, acknowledged);
        }

        return (
          this.db
            .query<{ sequence: number }, [string, string]>(
              "SELECT sequence FROM mail_cursors WHERE sessionID=? AND taskID=?",
            )
            .get(sessionID, taskID)?.sequence ?? 0
        );
      })
      .immediate();
  }

  public peer(crewID: CrewID): Peer | null {
    return this.taskRecords.peer(crewID);
  }

  public task(id: string): CrewTask | null {
    return this.taskRecords.task(id);
  }

  public activeTask(crewID: CrewID): CrewTask | null {
    return this.taskRecords.activeTask(crewID);
  }

  public reserveTask(
    peer: Peer,
    captainID: string,
    input: string | TaskAssignment = "",
    originInputID: string | null = null,
  ): CrewTask | null {
    return this.taskRecords.reserveTask(
      peer,
      captainID,
      assignmentParts(input),
      originInputID,
    );
  }

  public controlled(crewID: string): boolean {
    return this.taskRecords.controlled(crewID);
  }

  public reconciliation(taskID: string): TaskReconciliation | null {
    return this.taskRecords.reconciliation(taskID);
  }

  public reserveReconciliation(expected: CrewTask): string {
    return this.taskRecords.reserveReconciliation(expected);
  }

  public resumeBoundaries(taskID: string, unconfirmedOnly = false): number[] {
    return this.taskRecords.resumeBoundaries(taskID, unconfirmedOnly);
  }

  public confirmResumeAttempt(taskID: string, idleAt: number): void {
    this.taskRecords.confirmResumeAttempt(taskID, idleAt);
  }

  public resumeAttempted(taskID: string, idleAt: number): boolean {
    return this.taskRecords.resumeAttempted(taskID, idleAt);
  }

  public recordResumeAttempt(
    task: CrewTask,
    token: string,
    idleAt: number,
    captainID: string,
  ): void {
    this.taskRecords.recordResumeAttempt(task, token, idleAt, captainID);
  }

  public controlID(crewID: string): string | null {
    return this.taskRecords.controlID(crewID);
  }

  public abandonment(taskID: string): TaskAbandonment | null {
    return this.taskRecords.abandonment(taskID);
  }

  public beginAbandon(
    expected: AbandonExpected,
    audit: Pick<TaskAbandonment, "abandonedBy" | "reason" | "operationKey">,
  ): string {
    return this.taskRecords.beginAbandon(expected, audit);
  }

  public resumeAbandon(taskID: string): string | null {
    return this.taskRecords.resumeAbandon(taskID);
  }

  public finishAbandon(
    taskID: string,
    token: string,
    stop: Exclude<StopPhase, "pending">,
    detail: string,
  ) {
    this.taskRecords.finishAbandon(taskID, token, stop, detail);
  }

  public reserveWorkspace(
    crewID: string,
    expectedTaskID: string | null,
  ): string {
    return this.taskRecords.reserveWorkspace(crewID, expectedTaskID);
  }

  public finishReconciliation(
    expected: CrewTask,
    token: string,
    result: string,
    evidence: Pick<
      TaskReconciliation,
      | "reconciledBy"
      | "resultMessageID"
      | "inputSha256"
      | "resultSha256"
      | "reason"
    >,
  ): TaskReconciliation {
    return this.taskRecords.finishReconciliation(
      expected,
      token,
      result,
      evidence,
    );
  }

  public statusRequest(id: string): StatusRequest | null {
    return this.taskRecords.statusRequest(id);
  }

  public reserveStatusRequest(id: string, task: CrewTask, captainID: string) {
    this.taskRecords.reserveStatusRequest(id, task, captainID);
  }

  public statusRequestReceipt(id: string, receiptID: string) {
    this.taskRecords.statusRequestReceipt(id, receiptID);
  }

  public reserveControl(crewID: string): string {
    return this.taskRecords.reserveControl(crewID);
  }

  /** Release the model-control lock and reserve the checked admission in one write. */
  public admitAfterControl<T>(
    crewID: string,
    token: string,
    admit: () => T,
  ): T {
    return this.db
      .transaction(() => {
        this.releaseControl(crewID, token);

        return admit();
      })
      .immediate();
  }

  public releaseControl(crewID: string, token: string) {
    this.taskRecords.releaseControl(crewID, token);
  }

  public running(id: string) {
    this.taskRecords.running(id);
  }

  public readmit(expected: CrewTask, controlToken?: string): CrewTask {
    return this.taskRecords.readmit(expected, controlToken);
  }

  public withdrawCancelled(
    expected: CrewTask,
    captainID: string,
    detail: string,
    actor = captainID,
  ) {
    this.taskRecords.withdrawCancelled(expected, captainID, detail, actor);
  }

  public uncertain(id: string, phase = "uncertain") {
    this.taskRecords.uncertain(id, phase);
  }

  public complete(id: string, workerSessionID: string, resultInput: string) {
    this.taskRecords.complete(id, workerSessionID, resultInput);
  }

  public recoverResult(expected: CrewTask, resultInput: string): CrewTask {
    return this.taskRecords.recoverResult(expected, resultInput);
  }

  public release(id: string): boolean {
    return this.taskRecords.release(id);
  }

  public beginCancel(id: string, captainID: string): boolean {
    return this.taskRecords.beginCancel(id, captainID);
  }

  public beginNotify(taskID: string): boolean {
    return this.taskRecords.beginNotify(taskID);
  }

  public endNotify(taskID: string) {
    this.taskRecords.endNotify(taskID);
  }

  public close() {
    this.db.close();
  }
}
