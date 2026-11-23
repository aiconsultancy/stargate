import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { redactCredentials } from "../../lib/credentials";
import { UpdateNotices } from "../../maintenance/update-notice";
import { canExpandCrew } from "./identity";
import { IrcSessions } from "../messaging/irc";
import { MemberActivityStore } from "../reporting/member-activity";
import { MailRoutes } from "../messaging/messaging";
import { CrewError, queuedPendingTask, reportTask } from "../pending";

export { CrewError } from "../pending";

import { ReportingStore } from "../reporting/reporting";

export type CrewID = string;

export type Peer = {
  crewID: CrewID;
  sessionID: string;
  status: "pending" | "ready";
};

export type CrewTask = {
  id: string;
  crewID: CrewID;
  workerSessionID: string;
  originCaptainID: string;
  originInputID: string | null;
  inputID: string;
  status:
    | "queued"
    | "cancelled"
    | "dispatching"
    | "running"
    | "completed"
    | "cancelling"
    | "uncertain"
    /** Captain released it without a result; external stop is in the audit. */
    | "abandoned";
  result: string | null;
  released: number;
  notifying: number;
};

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

export type TaskReconciliation = {
  taskID: string;
  workerSessionID: string;
  originCaptainID: string;
  inputID: string;
  reconciledBy: string;
  previousStatus: "uncertain";
  previousResult: string | null;
  resultMessageID: string;
  inputSha256: string;
  resultSha256: string;
  reason: string;
  createdAt: number;
};

export type StatusRequest = {
  id: string;
  taskID: string;
  captainID: string;
  workerSessionID: string;
  receiptID: string | null;
};

export type AbandonableStatus =
  | "dispatching"
  | "running"
  | "cancelling"
  | "uncertain";

/** Pending: local abandon committed, native stop attempt not yet recorded. */
export type StopPhase = "pending" | "confirmed" | "unconfirmed";

export type TaskAbandonment = {
  taskID: string;
  crewID: string;
  workerSessionID: string;
  originCaptainID: string;
  inputID: string;
  abandonedBy: string;
  previousStatus: AbandonableStatus;
  previousResult: string | null;
  reason: string;
  operationKey: string;
  clearedControlID: string | null;
  stop: StopPhase;
  stopDetail: string | null;
  createdAt: number;
  stoppedAt: number | null;
};

type AbandonExpected = Pick<
  CrewTask,
  "id" | "crewID" | "workerSessionID" | "originCaptainID" | "inputID"
> & { status: AbandonableStatus; controlID: string | null };

/** Greybeard: bounded captain-selected queue; no background scheduler. */
export const pendingTaskLimit = 100;

type QueuedTask = CrewTask & { text: string };

const abandonmentColumns = `taskID,crewID,workerSessionID,originCaptainID,inputID,
  abandonedBy,previousStatus,previousResult,reason,operationKey,clearedControlID,
  stop,stopDetail,createdAt,stoppedAt`;

// Controls held by operations in this process. An explicit captain override
// May clear a crash-held control, never one an operation here still holds.
const liveControls = new Set<string>();

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

/** Not a valid captain abandon key, so audits stay distinguishable. */
export const withdrawKey = "stargate:cancel";

const controlID = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export class CrewState {
  public readonly updateNotices: UpdateNotices;
  public readonly reporting: ReportingStore;
  public readonly activity: MemberActivityStore;
  public readonly mailRoutes: MailRoutes;
  public readonly ircSessions: IrcSessions;
  private constructor(
    public readonly path: string,
    private readonly db: Database,
    /** Configured root of a pinned team; not part of the crew identity. */
    public readonly captainSessionID?: string,
  ) {
    this.updateNotices = new UpdateNotices(db);
    this.reporting = new ReportingStore(db, (id) => this.captainRoute(id));
    this.activity = new MemberActivityStore(db);
    this.mailRoutes = new MailRoutes(db);
    this.ircSessions = new IrcSessions(db);
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
      db.exec(`
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
      const legacyTasks = !/'abandoned'/.test(
        db
          .query<{ sql: string }, []>(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'",
          )
          .get()?.sql ?? "",
      );

      if ((allowCrewExpansion && legacyPeers) || legacyTasks)
        db.exec("PRAGMA foreign_keys=OFF");
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
        )
          throw new CrewError(
            "Crew configuration changed. Restore its original identity and directories or use a new namespace; do not delete state.",
          );

        if (expansion && legacyPeers) {
          // Rebuild only the obsolete fixed-roster constraint; child IDs and
          // Every existing row remain unchanged in this same transaction.
          db.exec(`
            CREATE TABLE peers_expansion (
              crewID TEXT PRIMARY KEY,
              sessionID TEXT NOT NULL UNIQUE,
              status TEXT NOT NULL CHECK(status IN ('pending','ready'))
            );
            INSERT INTO peers_expansion SELECT crewID,sessionID,status FROM peers;
            DROP TABLE peers;
            ALTER TABLE peers_expansion RENAME TO peers;
          `);

          if (db.query("PRAGMA foreign_key_check").all().length)
            throw new CrewError(
              "Crew expansion failed its reference check; original state retained.",
            );
        }

        if (legacyTasks) {
          // Widen only the status CHECK. Every row, rowid (recent-order key)
          // And referencing table stays as is; legacy uncertain stays uncertain.
          const columns =
            "rowid,id,crewID,workerSessionID,originCaptainID,inputID,status,result,released,notifying";

          db.exec(`
            CREATE TABLE ${tasksTable("tasks_terminal")};
            INSERT INTO tasks_terminal (${columns}) SELECT ${columns} FROM tasks;
            DROP TABLE tasks;
            ALTER TABLE tasks_terminal RENAME TO tasks;
            CREATE UNIQUE INDEX IF NOT EXISTS active_worker
              ON tasks(crewID) WHERE released=0;
          `);

          if (db.query("PRAGMA foreign_key_check").all().length)
            throw new CrewError(
              "Crew task status upgrade failed its reference check; original state retained.",
            );
        }

        // Add provenance after legacy rebuilds; retained rows stay untagged.
        for (const table of ["tasks", "pending_tasks"]) {
          if (
            !db
              .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
              .all()
              .some((column) => column.name === "originInputID")
          )
            db.exec(`ALTER TABLE ${table} ADD COLUMN originInputID TEXT`);
        }

        if (identity && identity.value !== fingerprint)
          db.query("UPDATE identity SET value=? WHERE value=?").run(
            fingerprint,
            identity.value,
          );

        if (!identity)
          db.query("INSERT INTO identity VALUES (?)").run(fingerprint);
      }).immediate();
      db.exec("PRAGMA foreign_keys=ON");

      return new CrewState(path, db, captainSessionID);
    } catch (error) {
      db.close();

      if (error instanceof CrewError) throw error;
      throw new CrewError(
        "Crew state unavailable. Check private state directory access; do not delete state.",
      );
    }
  }

  public peer(crewID: CrewID): Peer | null {
    return this.db
      .query<Peer, [string]>("SELECT * FROM peers WHERE crewID=?")
      .get(crewID);
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

    if (!pin || !id || this.peerBySession(id)) return false;

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

  public reservePeer(crewID: CrewID): Peer {
    return this.db
      .transaction(() => {
        this.db
          .query("INSERT OR IGNORE INTO peers VALUES (?,?,'pending')")
          .run(crewID, `ses_${randomUUID().replaceAll("-", "")}`);
        const peer = this.peer(crewID);

        if (!peer)
          throw new CrewError("Crew reservation failed. Inspect crew state.");

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
    )
      throw new CrewError(
        "Pi conversation reservation changed; inspect crew state.",
      );
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

        if (saved === conversationID) return;

        if (
          saved !== undefined ||
          !task ||
          task.released !== 0 ||
          (task.status !== "dispatching" && task.status !== "running") ||
          this.activeTask(task.crewID)?.id !== task.id
        )
          throw new CrewError(
            "Pi task conversation binding refused: task is not current or is bound elsewhere.",
          );
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

  public task(id: string): CrewTask | null {
    return (
      this.db
        .query<CrewTask, [string]>("SELECT * FROM tasks WHERE id=?")
        .get(id) ??
      this.db
        .query<CrewTask, [string]>(
          `SELECT id,crewID,workerSessionID,originCaptainID,originInputID,inputID,status,result,released,notifying FROM pending_tasks WHERE id=?`,
        )
        .get(id)
    );
  }

  public activeTask(crewID: CrewID): CrewTask | null {
    return this.db
      .query<CrewTask, [string]>(
        "SELECT * FROM tasks WHERE crewID=? AND released=0",
      )
      .get(crewID);
  }

  /** Share gateway presence across the daemon's separate plugin locations. */
  public noteCrewQuestionConsumer(at: number) {
    if (!this.captainSessionID) return;
    this.db
      .query(`INSERT INTO crew_question_consumer VALUES (1,?,?,?)
        ON CONFLICT(slot) DO UPDATE SET captain=excluded.captain,
        daemonPID=excluded.daemonPID, seenAt=excluded.seenAt`)
      .run(this.captainSessionID, process.pid, at);
  }

  public hasCrewQuestionConsumer(at: number, leaseMs: number) {
    return (
      !!this.captainSessionID &&
      !!this.db
        .query(`SELECT 1 FROM crew_question_consumer
          WHERE slot=1 AND captain=? AND daemonPID=? AND seenAt>? AND seenAt<=?`)
        .get(this.captainSessionID, process.pid, at - leaseMs, at)
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

  public reserveTask(
    peer: Peer,
    captainID: string,
    text = "",
    originInputID: string | null = null,
  ): CrewTask | null {
    return this.db
      .transaction(() => {
        if (this.activeTask(peer.crewID) || this.controlled(peer.crewID))
          return null;
        const id = `task_${randomUUID()}`;
        this.db
          .query(`INSERT INTO tasks
        (id,crewID,workerSessionID,originCaptainID,originInputID,inputID,status)
        VALUES (?,?,?,?,?,?,'dispatching')`)
          .run(
            id,
            peer.crewID,
            peer.sessionID,
            captainID,
            originInputID,
            `msg_${randomUUID()}`,
          );
        const task = this.task(id);

        if (task) {
          this.reporting.assignment(task, text);
          this.activity.assignment(task, text);
        }

        return task;
      })
      .immediate();
  }

  public controlled(crewID: string): boolean {
    return Boolean(
      this.db.query("SELECT 1 FROM worker_controls WHERE crewID=?").get(crewID),
    );
  }

  public queuedTasks(crewID: string): CrewTask[] {
    return this.db
      .query<CrewTask, [string]>(
        `SELECT id,crewID,workerSessionID,originCaptainID,originInputID,inputID,status,result,released,notifying
         FROM pending_tasks WHERE crewID=? AND ${queuedPendingTask} ORDER BY sequence`,
      )
      .all(crewID);
  }

  public reconciliation(taskID: string): TaskReconciliation | null {
    return this.db
      .query<TaskReconciliation, [string]>(
        "SELECT * FROM task_reconciliations WHERE taskID=?",
      )
      .get(taskID);
  }

  private unchangedTask(expected: CrewTask): boolean {
    const task = this.activeTask(expected.crewID);

    return (
      !!task &&
      task.id === expected.id &&
      task.workerSessionID === expected.workerSessionID &&
      task.originCaptainID === expected.originCaptainID &&
      task.inputID === expected.inputID &&
      task.status === expected.status &&
      task.result === expected.result &&
      task.released === expected.released &&
      task.notifying === expected.notifying &&
      this.peer(expected.crewID)?.sessionID === expected.workerSessionID
    );
  }

  public reserveReconciliation(expected: CrewTask): string {
    return this.db
      .transaction(() => {
        if (
          expected.status !== "uncertain" ||
          expected.released !== 0 ||
          expected.notifying !== 0 ||
          !this.unchangedTask(expected)
        )
          throw new CrewError(
            "Task ownership or state changed; inspect again before reconciliation.",
          );

        if (this.controlled(expected.crewID))
          throw new CrewError(
            "Worker control is reserved; do not steal it. Inspect before retrying.",
          );

        return this.insertControl(expected.crewID);
      })
      .immediate();
  }

  public resumeBoundaries(taskID: string, unconfirmedOnly = false): number[] {
    return this.db
      .query<{ idleAt: number }, [string, number]>(
        "SELECT idleAt FROM task_resume_attempts WHERE taskID=? AND (?=0 OR admitted=0)",
      )
      .all(taskID, Number(unconfirmedOnly))
      .map(({ idleAt }) => idleAt);
  }

  public confirmResumeAttempt(taskID: string, idleAt: number): void {
    this.db
      .query(
        "UPDATE task_resume_attempts SET admitted=1 WHERE taskID=? AND idleAt=?",
      )
      .run(taskID, idleAt);
  }

  public resumeAttempted(taskID: string, idleAt: number): boolean {
    return (
      this.db
        .query("SELECT 1 FROM task_resume_attempts WHERE taskID=? AND idleAt=?")
        .get(taskID, idleAt) !== null
    );
  }

  /** Record the identity before admission or a retry of that same input. */
  public recordResumeAttempt(
    task: CrewTask,
    token: string,
    idleAt: number,
    captainID: string,
  ): void {
    this.db
      .transaction(() => {
        const control = this.db
          .query<{ token: string }, [string]>(
            "SELECT token FROM worker_controls WHERE crewID=?",
          )
          .get(task.crewID);

        if (control?.token !== token || !this.unchangedTask(task))
          throw new CrewError(
            "Task ownership changed before resume; inspect again.",
          );
        this.db
          .query(`INSERT OR IGNORE INTO task_resume_attempts
        (taskID,idleAt,requestedBy,requestedAt) VALUES (?,?,?,?)`)
          .run(task.id, idleAt, captainID, Date.now());
      })
      .immediate();
  }

  private insertControl(crewID: string): string {
    const token = randomUUID();
    this.db
      .query("INSERT INTO worker_controls VALUES (?,?)")
      .run(crewID, token);
    liveControls.add(`${this.path}\0${token}`);

    return token;
  }

  /** Hash only; the token itself stays private to its holder. */
  public controlID(crewID: string): string | null {
    const row = this.db
      .query<{ token: string }, [string]>(
        "SELECT token FROM worker_controls WHERE crewID=?",
      )
      .get(crewID);

    return row ? controlID(row.token) : null;
  }

  public abandonment(taskID: string): TaskAbandonment | null {
    return this.db
      .query<TaskAbandonment, [string]>(
        `SELECT ${abandonmentColumns} FROM task_abandonments WHERE taskID=?`,
      )
      .get(taskID);
  }

  /** Releases the slot and holds the control for the stop attempt. History,
   * result, notices and mail stay intact; the outcome remains uncertain.
   */
  public beginAbandon(
    expected: AbandonExpected,
    audit: Pick<TaskAbandonment, "abandonedBy" | "reason" | "operationKey">,
  ): string {
    return this.db
      .transaction(() => {
        const task = this.activeTask(expected.crewID);

        if (
          !task ||
          task.id !== expected.id ||
          task.status !== expected.status ||
          task.workerSessionID !== expected.workerSessionID ||
          task.originCaptainID !== expected.originCaptainID ||
          task.inputID !== expected.inputID ||
          this.peer(expected.crewID)?.sessionID !== expected.workerSessionID
        )
          throw new CrewError(
            "Task ownership or state changed; inspect again. Nothing abandoned.",
          );

        if (this.resumeBoundaries(task.id, true).length)
          throw new CrewError(
            "Resume admission is still unconfirmed. Inspect status before releasing the task.",
          );

        const control = this.db
          .query<{ token: string }, [string]>(
            "SELECT token FROM worker_controls WHERE crewID=?",
          )
          .get(expected.crewID);

        const held = control ? controlID(control.token) : null;

        if (held !== expected.controlID)
          throw new CrewError(
            held
              ? "Worker control is reserved. Pass its inspected controlID only if no Stargate operation can still hold it. Nothing abandoned."
              : "Expected worker control is gone; inspect again. Nothing abandoned.",
          );

        if (control && liveControls.has(`${this.path}\0${control.token}`))
          throw new CrewError(
            "Worker control is held by an operation in this process; retry after it ends. Nothing abandoned.",
          );

        if (control)
          this.db
            .query("DELETE FROM worker_controls WHERE crewID=? AND token=?")
            .run(expected.crewID, control.token);
        const token = this.insertControl(expected.crewID);
        this.db
          .query(
            "UPDATE tasks SET status='abandoned',released=1 WHERE id=? AND released=0",
          )
          .run(task.id);
        this.db
          .query(`INSERT INTO task_abandonments
            (taskID,crewID,workerSessionID,originCaptainID,inputID,abandonedBy,
             previousStatus,previousResult,reason,operationKey,clearedControlID,
             controlToken,stop,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`)
          .run(
            task.id,
            task.crewID,
            task.workerSessionID,
            task.originCaptainID,
            task.inputID,
            audit.abandonedBy,
            expected.status,
            task.result,
            audit.reason,
            audit.operationKey,
            held,
            token,
            Date.now(),
          );
        const updated = { ...task, status: "abandoned" as const, released: 1 };

        // Report captures end as unavailable; the work's outcome stays unknown.
        if (this.reporting.isReport(task.id))
          this.reporting.record(updated, "update", "Outcome uncertain");
        this.reporting.record(updated, "update", "Abandoned by captain");
        this.activity.phase(updated, "abandoned");

        return token;
      })
      .immediate();
  }

  /** Crash recovery: retry only a pending stop whose own control remains. */
  public resumeAbandon(taskID: string): string | null {
    return this.db
      .transaction(() => {
        const row = this.db
          .query<
            { crewID: string; controlToken: string; stop: StopPhase },
            [string]
          >(
            "SELECT crewID,controlToken,stop FROM task_abandonments WHERE taskID=?",
          )
          .get(taskID);

        if (row?.stop !== "pending") return null;

        if (liveControls.has(`${this.path}\0${row.controlToken}`)) return null;

        const control = this.db
          .query<{ token: string }, [string]>(
            "SELECT token FROM worker_controls WHERE crewID=?",
          )
          .get(row.crewID);

        if (control?.token === row.controlToken) {
          liveControls.add(`${this.path}\0${row.controlToken}`);

          return row.controlToken;
        }

        this.db
          .query(`UPDATE task_abandonments SET stop='unconfirmed',stoppedAt=?,
            stopDetail='Stop attempt did not finish and its control is gone; not retried.'
            WHERE taskID=? AND stop='pending'`)
          .run(Date.now(), taskID);

        return null;
      })
      .immediate();
  }

  public finishAbandon(
    taskID: string,
    token: string,
    stop: Exclude<StopPhase, "pending">,
    detail: string,
  ) {
    this.db
      .transaction(() => {
        const row = this.db
          .query<{ crewID: string }, [string, string]>(
            "SELECT crewID FROM task_abandonments WHERE taskID=? AND controlToken=?",
          )
          .get(taskID, token);

        if (!row) throw new CrewError("Abandon audit missing.");
        this.db
          .query(`UPDATE task_abandonments SET stop=?,stopDetail=?,stoppedAt=?
            WHERE taskID=? AND stop='pending'`)
          .run(stop, detail.slice(0, 500), Date.now(), taskID);
        this.releaseControl(row.crewID, token);
      })
      .immediate();
  }

  /** Workspace changes share the dispatch slot. Uncertain or completed work
   * may stay assigned; Stargate-active work must be stopped or abandoned first.
   */
  public reserveWorkspace(
    crewID: string,
    expectedTaskID: string | null,
  ): string {
    return this.db
      .transaction(() => {
        if (this.controlled(crewID))
          throw new CrewError(
            "Worker control is reserved by another operation; inspect again. No Git change made.",
          );
        const active = this.activeTask(crewID);

        if ((active?.id ?? null) !== expectedTaskID)
          throw new CrewError(
            "Worker task slot changed since inspection; inspect again. No Git change made.",
          );

        if (
          active &&
          ((active.status !== "completed" && active.status !== "uncertain") ||
            active.notifying)
        )
          throw new CrewError(
            "Worker has Stargate-active work; wait, or abandon it before changing the workspace. No Git change made.",
          );

        return this.insertControl(crewID);
      })
      .immediate();
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
    return this.db
      .transaction(() => {
        const control = this.db
          .query<{ token: string }, [string]>(
            "SELECT token FROM worker_controls WHERE crewID=?",
          )
          .get(expected.crewID);

        if (
          expected.status !== "uncertain" ||
          expected.released !== 0 ||
          expected.notifying !== 0 ||
          control?.token !== token ||
          !this.unchangedTask(expected)
        )
          throw new CrewError(
            "Task ownership or state changed during verification; inspect again.",
          );

        if (expected.result !== null && expected.result !== result)
          throw new CrewError(
            "Retained task result conflicts; no state changed.",
          );
        this.db
          .query(`INSERT INTO task_reconciliations
            (taskID,workerSessionID,originCaptainID,inputID,reconciledBy,
             previousStatus,previousResult,resultMessageID,inputSha256,
             resultSha256,reason,createdAt)
            VALUES (?,?,?,?,?,'uncertain',?,?,?,?,?,?)`)
          .run(
            expected.id,
            expected.workerSessionID,
            expected.originCaptainID,
            expected.inputID,
            evidence.reconciledBy,
            expected.result,
            evidence.resultMessageID,
            evidence.inputSha256,
            evidence.resultSha256,
            evidence.reason,
            Date.now(),
          );
        this.db
          .query("UPDATE tasks SET status='completed',result=? WHERE id=?")
          .run(result, expected.id);
        this.reporting.record(expected, "result", result);
        const audit = this.reconciliation(expected.id);

        if (!audit) throw new CrewError("Reconciliation audit missing.");

        return audit;
      })
      .immediate();
  }

  public statusRequest(id: string): StatusRequest | null {
    return this.db
      .query<StatusRequest, [string]>(
        "SELECT * FROM crew_status_requests WHERE id=?1 OR receiptID=?1",
      )
      .get(id);
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

  public reserveStatusRequest(id: string, task: CrewTask, captainID: string) {
    this.db
      .transaction(() => {
        if (!this.unchangedTask(task))
          throw new CrewError(
            "Task ownership changed before the status request; inspect again.",
          );
        this.db
          .query(`INSERT OR IGNORE INTO crew_status_requests
            (id,taskID,captainID,workerSessionID) VALUES (?,?,?,?)`)
          .run(id, task.id, captainID, task.workerSessionID);
      })
      .immediate();
  }

  public statusRequestReceipt(id: string, receiptID: string) {
    this.db
      .query("UPDATE crew_status_requests SET receiptID=? WHERE id=?")
      .run(receiptID, id);
  }

  public enqueue(
    peer: Peer,
    captainID: string,
    text: string,
    reportCaptureID?: string,
    originInputID: string | null = null,
    /** Marks a task queued by a maintenance drain, for automatic resume. */
    drainRunID?: string,
  ): CrewTask {
    return this.db
      .transaction(() => {
        if (reportCaptureID) {
          const capture = this.reporting.owned(captainID, reportCaptureID);
          const previous = this.reporting.reportTaskID(reportCaptureID);

          if (previous) {
            const task = this.task(previous);

            if (!task)
              throw new CrewError("Reporting task reservation missing.");

            return task;
          }

          if (
            capture.status !== "summarizing" ||
            capture.reporterID !== peer.crewID
          )
            throw new CrewError(
              "Reporting capture is not eligible for admission.",
            );
          const active = this.activeTask(peer.crewID);

          if (
            this.controlled(peer.crewID) ||
            (active && (active.status !== "completed" || active.notifying))
          )
            throw new CrewError(
              "Summary skipped: reporter is busy or uncertain.",
            );
        }

        const count =
          this.db
            .query<{ count: number }, [string]>(
              `SELECT COUNT(*) AS count FROM pending_tasks WHERE crewID=? AND ${queuedPendingTask}`,
            )
            .get(peer.crewID)?.count ?? 0;

        if (count >= pendingTaskLimit)
          throw new CrewError(
            `Worker queue full: limit ${pendingTaskLimit} pending tasks per worker.`,
          );
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
            text,
          );
        const task = this.task(id);

        if (!task) throw new CrewError("Queue reservation failed.");

        if (drainRunID)
          this.db
            .query(
              "INSERT OR IGNORE INTO maintenance_queued_tasks (taskID,runID) VALUES (?,?)",
            )
            .run(id, drainRunID);

        if (reportCaptureID) this.reporting.markReport(id, reportCaptureID);
        else this.reporting.assignment(task, text);
        this.activity.assignment(task, text, !!reportCaptureID);

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

        if (queued?.status !== "queued" || this.controlled(queued.crewID))
          return null;
        const active = this.activeTask(queued.crewID);

        if ((active?.id ?? null) !== previousID) return null;

        if (active && !this.release(active.id)) return null;
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

        if (!task) throw new CrewError("Queue promotion failed.");
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

  /** Drain-queued tasks still waiting, oldest first; spent marks are pruned. */
  public drainQueued(): CrewTask[] {
    this.db
      .query(
        `DELETE FROM maintenance_queued_tasks WHERE taskID NOT IN
         (SELECT id FROM pending_tasks WHERE ${queuedPendingTask})`,
      )
      .run();

    return this.db
      .query<CrewTask, []>(
        `SELECT p.id,p.crewID,p.workerSessionID,p.originCaptainID,p.originInputID,p.inputID,p.status,p.result,p.released,p.notifying
         FROM pending_tasks p JOIN maintenance_queued_tasks m ON m.taskID=p.id
         WHERE p.status='queued' ORDER BY p.sequence`,
      )
      .all();
  }

  /**
   * Passive context for one session, once per ID even after it was consumed.
   * An unread older drain notice is withdrawn: only the newest phase remains.
   */
  public queueDrainNotice(
    sessionID: string,
    id: string,
    text: string,
    scope: string,
  ): "queued" | "unchanged" {
    return this.db
      .transaction(() => {
        const first =
          this.db
            .query(
              "INSERT OR IGNORE INTO drain_notice_receipts (sessionID,id) VALUES (?,?)",
            )
            .run(sessionID, id).changes === 1;

        if (!first) return "unchanged" as const;
        this.db
          .query(
            "DELETE FROM update_notice_context WHERE scope=? AND sessionID=? AND id LIKE 'drain\\_%' ESCAPE '\\'",
          )
          .run(scope, sessionID);
        this.updateNotices.queueExternalContext(sessionID, id, text, scope);

        return "queued" as const;
      })
      .immediate();
  }

  public reserveControl(crewID: string): string {
    return this.db
      .transaction(() => {
        if (this.controlled(crewID))
          throw new CrewError(
            "Worker control already reserved; reconcile crash-held controls manually.",
          );
        const active = this.activeTask(crewID);

        if (active && (active.status !== "completed" || active.notifying))
          throw new CrewError(
            "Worker has running or uncertain work; control refused.",
          );

        return this.insertControl(crewID);
      })
      .immediate();
  }

  public releaseControl(crewID: string, token: string) {
    liveControls.delete(`${this.path}\0${token}`);
    this.db
      .query("DELETE FROM worker_controls WHERE crewID=? AND token=?")
      .run(crewID, token);
  }

  public running(id: string) {
    const changed = this.db
      .query(
        "UPDATE tasks SET status='running' WHERE id=? AND status='dispatching'",
      )
      .run(id);

    const task = this.task(id);

    if (changed.changes && task) {
      this.reporting.record(task, "update", "Running");
      this.activity.phase(task, "running");
    }
  }

  /** Exact native evidence (own input queued or placed, worker active) shows
   * an uncertain task is still admitted. CAS; never while a control is held.
   */
  public readmit(expected: CrewTask, controlToken?: string): CrewTask {
    return this.db
      .transaction(() => {
        const changed = this.db
          .query(`UPDATE tasks SET status='running'
            WHERE id=? AND crewID=? AND workerSessionID=? AND originCaptainID=?
            AND inputID=? AND status='uncertain' AND released=0 AND notifying=0
            AND NOT EXISTS (SELECT 1 FROM task_resume_attempts WHERE taskID=tasks.id AND admitted=0)
            AND NOT EXISTS (SELECT 1 FROM worker_controls WHERE crewID=? AND token IS NOT ?)`)
          .run(
            expected.id,
            expected.crewID,
            expected.workerSessionID,
            expected.originCaptainID,
            expected.inputID,
            expected.crewID,
            controlToken ?? null,
          );

        const task = this.task(expected.id) ?? expected;

        if (changed.changes) {
          this.reporting.record(
            task,
            "update",
            "Running: native input matched",
          );
          this.activity.phase(task, "running");
        }

        return task;
      })
      .immediate();
  }

  /** Cancel proved the own input never ran: release the slot with a
   * confirmed-stop audit instead of leaving an uncertain blocker.
   * `captainID` is the stored origin; `actor` is the cancelling captain.
   */
  public withdrawCancelled(
    expected: CrewTask,
    captainID: string,
    detail: string,
    actor = captainID,
  ) {
    this.db
      .transaction(() => {
        const task = this.activeTask(expected.crewID);

        if (
          task?.id !== expected.id ||
          task.status !== "cancelling" ||
          task.originCaptainID !== captainID ||
          task.inputID !== expected.inputID ||
          this.controlled(expected.crewID)
        )
          return;
        const now = Date.now();
        this.db
          .query("UPDATE tasks SET status='cancelled',released=1 WHERE id=?")
          .run(task.id);
        this.db
          .query(`INSERT INTO task_abandonments
            (taskID,crewID,workerSessionID,originCaptainID,inputID,abandonedBy,
             previousStatus,previousResult,reason,operationKey,controlToken,
             stop,stopDetail,createdAt,stoppedAt)
            VALUES (?,?,?,?,?,?,'cancelling',?,?,?,?,'confirmed',?,?,?)`)
          .run(
            task.id,
            task.crewID,
            task.workerSessionID,
            task.originCaptainID,
            task.inputID,
            actor,
            task.result,
            "Wait cancelled before native execution.",
            withdrawKey,
            randomUUID(),
            detail.slice(0, 500),
            now,
            now,
          );
        const updated = { ...task, status: "cancelled" as const, released: 1 };

        if (this.reporting.isReport(task.id))
          this.reporting.record(updated, "update", "Outcome uncertain");
        this.reporting.record(updated, "update", "Cancelled before execution");
        this.activity.phase(updated, "cancelled");
      })
      .immediate();
  }

  public uncertain(id: string, phase = "uncertain") {
    const changed = this.db
      .query(
        "UPDATE tasks SET status='uncertain' WHERE id=? AND released=0 AND status NOT IN ('completed','uncertain')",
      )
      .run(id);

    const task = this.task(id);

    if (changed.changes && task) {
      this.reporting.record(task, "update", "Outcome uncertain");
      this.activity.phase(task, phase);
    }
  }

  public complete(id: string, workerSessionID: string, result: string) {
    if (this.reporting.isReport(id)) result = redactCredentials(result, 3000);

    return this.db
      .transaction(() => {
        const task = this.task(id);

        if (!task || task.workerSessionID !== workerSessionID)
          throw new CrewError(
            "Only the assigned worker can complete this task.",
          );

        if (task.status === "completed" && task.result === result) return;

        // A failed observation does not void the worker's own answer, but an
        // Abandoned, released or replaced task can never be completed.
        const current =
          task.released === 0 &&
          this.activeTask(task.crewID)?.id === task.id &&
          this.peer(task.crewID)?.sessionID === workerSessionID;

        if (
          !current ||
          (task.status !== "dispatching" &&
            task.status !== "running" &&
            task.status !== "uncertain")
        )
          throw new CrewError(
            "Task is not current. Inspect its state; do not replay work.",
          );
        this.db
          .query(
            "UPDATE tasks SET status='completed',result=? WHERE id=? AND released=0",
          )
          .run(result, id);
        this.reporting.record(task, "result", result);
        this.activity.phase({ ...task, status: "completed" }, "completed");
      })
      .immediate();
  }

  public recoverResult(expected: CrewTask, result: string): CrewTask {
    if (this.reporting.isReport(expected.id))
      result = redactCredentials(result, 3000);

    return this.db
      .transaction(() => {
        const changed = this.db
          .query(`UPDATE tasks SET status='completed',result=?
        WHERE id=? AND crewID=? AND workerSessionID=? AND originCaptainID=?
        AND inputID=? AND status=? AND status IN ('running','uncertain') AND released=0`)
          .run(
            result,
            expected.id,
            expected.crewID,
            expected.workerSessionID,
            expected.originCaptainID,
            expected.inputID,
            expected.status,
          );

        const task = this.task(expected.id) ?? expected;

        if (changed.changes) {
          this.reporting.record(task, "result", result);
          this.activity.phase(task, "completed");
        }

        return task;
      })
      .immediate();
  }

  public release(id: string): boolean {
    return (
      this.db
        .query(`UPDATE tasks SET released=1
      WHERE id=? AND status='completed' AND notifying=0
          AND NOT EXISTS (SELECT 1 FROM task_resume_attempts WHERE taskID=tasks.id AND admitted=0)`)
        .run(id).changes === 1
    );
  }

  public beginCancel(id: string, captainID: string): boolean {
    const changed =
      this.db
        .query(`UPDATE tasks SET status='cancelling'
      WHERE id=? AND originCaptainID=? AND released=0
      AND status IN ('dispatching','running')`)
        .run(id, captainID).changes === 1;

    const task = this.task(id);

    if (changed && task) this.activity.phase(task, "cancelling");

    return changed;
  }

  public notice(taskID: string, text: string) {
    this.db
      .query("INSERT INTO notices(taskID,text) VALUES (?,?)")
      .run(taskID, text);
  }

  public noticeOnce(messageID: string, taskID: string, text: string) {
    this.db
      .transaction(() => {
        if (this.mailRoutes.notice(messageID)) this.notice(taskID, text);
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

  public beginNotify(taskID: string): boolean {
    return (
      this.db
        .query(`UPDATE tasks SET notifying=notifying+1 WHERE id=?
      AND released=0 AND status IN ('dispatching','running')`)
        .run(taskID).changes === 1
    );
  }

  public endNotify(taskID: string) {
    this.db
      .query(
        "UPDATE tasks SET notifying=notifying-1 WHERE id=? AND notifying>0",
      )
      .run(taskID);
  }

  public mailCursor(
    sessionID: string,
    taskID: string,
    acknowledged?: number,
  ): number {
    return this.db
      .transaction(() => {
        if (acknowledged !== undefined)
          this.db
            .query(`INSERT INTO mail_cursors VALUES (?,?,?)
          ON CONFLICT(sessionID,taskID) DO UPDATE
          SET sequence=MAX(sequence,excluded.sequence)`)
            .run(sessionID, taskID, acknowledged);

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

  public close() {
    this.db.close();
  }
}
