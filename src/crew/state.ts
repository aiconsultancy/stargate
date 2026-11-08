import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { canExpandCrew } from "./identity";
import { MemberActivityStore } from "./member-activity";
import { MailRoutes } from "./messaging";
import { ReportingStore, redactActivity } from "./reporting";
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
  inputID: string;
  status:
    | "queued"
    | "cancelled"
    | "dispatching"
    | "running"
    | "completed"
    | "cancelling"
    | "uncertain";
  result: string | null;
  released: number;
  notifying: number;
};
export type CrewNotice = { id: number; taskID: string; text: string };
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

export class CrewError extends Error {}

/** greybeard: bounded FIFO, polled by its captain; no background scheduler. */
export const pendingTaskLimit = 100;
type QueuedTask = CrewTask & { text: string };

export class CrewState {
  readonly reporting: ReportingStore;
  readonly activity: MemberActivityStore;
  readonly mailRoutes: MailRoutes;
  private constructor(
    readonly path: string,
    private readonly db: Database,
  ) {
    this.reporting = new ReportingStore(db);
    this.activity = new MemberActivityStore(db);
    this.mailRoutes = new MailRoutes(db);
  }

  static async open(
    directory: string,
    namespace: string,
    fingerprint: string,
    legacyFingerprint?: string,
    allowCrewExpansion = false,
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
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          crewID TEXT NOT NULL REFERENCES peers(crewID),
          workerSessionID TEXT NOT NULL,
          originCaptainID TEXT NOT NULL,
          inputID TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK(status IN
            ('dispatching','running','completed','cancelling','uncertain')),
          result TEXT,
          released INTEGER NOT NULL DEFAULT 0,
          notifying INTEGER NOT NULL DEFAULT 0
        );
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
        CREATE TABLE IF NOT EXISTS pi_peers (
          sessionID TEXT PRIMARY KEY REFERENCES peers(sessionID),
          conversationID TEXT
        );
      `);
      const legacyPeers = /CHECK\s*\(\s*crewID\s+IN\s*\(/i.test(
        db
          .query<{ sql: string }, []>(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='peers'",
          )
          .get()?.sql ?? "",
      );
      if (allowCrewExpansion && legacyPeers) db.exec("PRAGMA foreign_keys=OFF");
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
          // every existing row remain unchanged in this same transaction.
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
        if (identity && identity.value !== fingerprint)
          db.query("UPDATE identity SET value=? WHERE value=?").run(
            fingerprint,
            identity.value,
          );
        if (!identity)
          db.query("INSERT INTO identity VALUES (?)").run(fingerprint);
      }).immediate();
      db.exec("PRAGMA foreign_keys=ON");
      return new CrewState(path, db);
    } catch (error) {
      db.close();
      if (error instanceof CrewError) throw error;
      throw new CrewError(
        "Crew state unavailable. Check private state directory access; do not delete state.",
      );
    }
  }

  peer(crewID: CrewID): Peer | null {
    return this.db
      .query<Peer, [string]>("SELECT * FROM peers WHERE crewID=?")
      .get(crewID);
  }

  peerBySession(sessionID: string): Peer | null {
    return this.db
      .query<Peer, [string]>("SELECT * FROM peers WHERE sessionID=?")
      .get(sessionID);
  }

  reservePeer(crewID: CrewID): Peer {
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

  readyPeer(crewID: CrewID) {
    this.db.query("UPDATE peers SET status='ready' WHERE crewID=?").run(crewID);
  }

  piPeer(sessionID: string) {
    return this.db
      .query<{ conversationID: string | null }, [string]>(
        "SELECT conversationID FROM pi_peers WHERE sessionID=?",
      )
      .get(sessionID);
  }

  reservePiPeer(sessionID: string): boolean {
    return (
      this.db
        .query("INSERT OR IGNORE INTO pi_peers(sessionID) VALUES (?)")
        .run(sessionID).changes === 1
    );
  }

  readyPiPeer(sessionID: string, conversationID: string) {
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

  task(id: string): CrewTask | null {
    return (
      this.db
        .query<CrewTask, [string]>("SELECT * FROM tasks WHERE id=?")
        .get(id) ??
      this.db
        .query<CrewTask, [string]>(
          `SELECT id,crewID,workerSessionID,originCaptainID,inputID,status,result,released,notifying FROM pending_tasks WHERE id=?`,
        )
        .get(id)
    );
  }

  activeTask(crewID: CrewID): CrewTask | null {
    return this.db
      .query<CrewTask, [string]>(
        "SELECT * FROM tasks WHERE crewID=? AND released=0",
      )
      .get(crewID);
  }

  reserveTask(peer: Peer, captainID: string, text = ""): CrewTask | null {
    return this.db
      .transaction(() => {
        if (
          this.activeTask(peer.crewID) ||
          this.controlled(peer.crewID) ||
          this.nextQueued(peer.crewID)
        )
          return null;
        const id = `task_${randomUUID()}`;
        this.db
          .query(`INSERT INTO tasks
        (id,crewID,workerSessionID,originCaptainID,inputID,status)
        VALUES (?,?,?,?,?,'dispatching')`)
          .run(
            id,
            peer.crewID,
            peer.sessionID,
            captainID,
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

  controlled(crewID: string): boolean {
    return Boolean(
      this.db.query("SELECT 1 FROM worker_controls WHERE crewID=?").get(crewID),
    );
  }

  queuedTasks(crewID: string): CrewTask[] {
    return this.db
      .query<CrewTask, [string]>(
        `SELECT id,crewID,workerSessionID,originCaptainID,inputID,status,result,released,notifying
         FROM pending_tasks WHERE crewID=? AND status='queued' ORDER BY sequence`,
      )
      .all(crewID);
  }

  reconciliation(taskID: string): TaskReconciliation | null {
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

  reserveReconciliation(expected: CrewTask): string {
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
        const token = randomUUID();
        this.db
          .query("INSERT INTO worker_controls VALUES (?,?)")
          .run(expected.crewID, token);
        return token;
      })
      .immediate();
  }

  finishReconciliation(
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

  statusRequest(id: string): StatusRequest | null {
    return this.db
      .query<StatusRequest, [string]>(
        "SELECT * FROM crew_status_requests WHERE id=?1 OR receiptID=?1",
      )
      .get(id);
  }

  requestedStatus(taskID: string, captainID: string): boolean {
    return Boolean(
      this.db
        .query(
          "SELECT 1 FROM crew_status_requests WHERE taskID=? AND captainID=?",
        )
        .get(taskID, captainID),
    );
  }

  reserveStatusRequest(id: string, task: CrewTask, captainID: string) {
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

  statusRequestReceipt(id: string, receiptID: string) {
    this.db
      .query("UPDATE crew_status_requests SET receiptID=? WHERE id=?")
      .run(receiptID, id);
  }

  private nextQueued(crewID: string): QueuedTask | null {
    return this.db
      .query<QueuedTask, [string]>(
        "SELECT * FROM pending_tasks WHERE crewID=? AND status='queued' ORDER BY sequence LIMIT 1",
      )
      .get(crewID);
  }

  hasQueued(crewID: string): boolean {
    return !!this.nextQueued(crewID);
  }

  enqueue(
    peer: Peer,
    captainID: string,
    text: string,
    reportCaptureID?: string,
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
            this.nextQueued(peer.crewID) ||
            (active && (active.status !== "completed" || active.notifying))
          )
            throw new CrewError(
              "Summary skipped: reporter is busy or uncertain.",
            );
        }
        const count =
          this.db
            .query<{ count: number }, [string]>(
              "SELECT COUNT(*) AS count FROM pending_tasks WHERE crewID=? AND status='queued'",
            )
            .get(peer.crewID)?.count ?? 0;
        if (count >= pendingTaskLimit)
          throw new CrewError(
            `Worker queue full: limit ${pendingTaskLimit} pending tasks per worker.`,
          );
        const id = `task_${randomUUID()}`;
        this.db
          .query(
            `INSERT INTO pending_tasks (id,crewID,workerSessionID,originCaptainID,inputID,text) VALUES (?,?,?,?,?,?)`,
          )
          .run(
            id,
            peer.crewID,
            peer.sessionID,
            captainID,
            `msg_${randomUUID()}`,
            text,
          );
        const task = this.task(id);
        if (!task) throw new CrewError("Queue reservation failed.");
        if (reportCaptureID) this.reporting.markReport(id, reportCaptureID);
        else this.reporting.assignment(task, text);
        this.activity.assignment(task, text, !!reportCaptureID);
        return task;
      })
      .immediate();
  }

  /** Called only after SDK idle confirmation. Snapshot guards concurrent reuse. */
  promote(
    id: string,
    previousID: string | null,
  ): { task: CrewTask; text: string } | null {
    return this.db
      .transaction(() => {
        const queued = this.task(id);
        if (queued?.status !== "queued" || this.controlled(queued.crewID))
          return null;
        const head = this.nextQueued(queued.crewID);
        const active = this.activeTask(queued.crewID);
        if (head?.id !== id || (active?.id ?? null) !== previousID) return null;
        if (active && !this.release(active.id)) return null;
        this.db
          .query(
            `INSERT INTO tasks (id,crewID,workerSessionID,originCaptainID,inputID,status) VALUES (?,?,?,?,?,'dispatching')`,
          )
          .run(
            head.id,
            head.crewID,
            head.workerSessionID,
            head.originCaptainID,
            head.inputID,
          );
        this.db.query("DELETE FROM pending_tasks WHERE id=?").run(id);
        const task = this.task(id);
        if (!task) throw new CrewError("Queue promotion failed.");
        this.activity.phase(task, "dispatching");
        return { task, text: head.text };
      })
      .immediate();
  }

  cancelQueued(id: string, captainID: string): boolean {
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

  reserveControl(crewID: string): string {
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
        const token = randomUUID();
        this.db
          .query("INSERT INTO worker_controls VALUES (?,?)")
          .run(crewID, token);
        return token;
      })
      .immediate();
  }

  releaseControl(crewID: string, token: string) {
    this.db
      .query("DELETE FROM worker_controls WHERE crewID=? AND token=?")
      .run(crewID, token);
  }

  running(id: string) {
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

  uncertain(id: string, phase = "uncertain") {
    const changed = this.db
      .query(
        "UPDATE tasks SET status='uncertain' WHERE id=? AND status NOT IN ('completed','uncertain')",
      )
      .run(id);
    const task = this.task(id);
    if (changed.changes && task) {
      this.reporting.record(task, "update", "Outcome uncertain");
      this.activity.phase(task, phase);
    }
  }

  complete(id: string, workerSessionID: string, result: string) {
    if (this.reporting.isReport(id)) result = redactActivity(result, 3000);
    return this.db
      .transaction(() => {
        const task = this.task(id);
        if (!task || task.workerSessionID !== workerSessionID)
          throw new CrewError(
            "Only the assigned worker can complete this task.",
          );
        if (task.status === "completed" && task.result === result) return;
        if (task.status !== "dispatching" && task.status !== "running")
          throw new CrewError(
            "Task is not running. Inspect uncertain state; do not replay work.",
          );
        this.db
          .query("UPDATE tasks SET status='completed',result=? WHERE id=?")
          .run(result, id);
        this.reporting.record(task, "result", result);
        this.activity.phase({ ...task, status: "completed" }, "completed");
      })
      .immediate();
  }

  recoverResult(expected: CrewTask, result: string): CrewTask {
    if (this.reporting.isReport(expected.id))
      result = redactActivity(result, 3000);
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

  release(id: string): boolean {
    return (
      this.db
        .query(`UPDATE tasks SET released=1
      WHERE id=? AND status='completed' AND notifying=0`)
        .run(id).changes === 1
    );
  }

  beginCancel(id: string, captainID: string): boolean {
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

  notice(taskID: string, text: string) {
    this.db
      .query("INSERT INTO notices(taskID,text) VALUES (?,?)")
      .run(taskID, text);
  }

  noticeOnce(messageID: string, taskID: string, text: string) {
    this.db
      .transaction(() => {
        if (this.mailRoutes.notice(messageID)) this.notice(taskID, text);
      })
      .immediate();
  }

  notices(taskID: string, after: number): CrewNotice[] {
    return this.db
      .query<CrewNotice, [string, number]>(
        "SELECT * FROM notices WHERE taskID=? AND id>? ORDER BY id",
      )
      .all(taskID, after);
  }

  beginNotify(taskID: string): boolean {
    return (
      this.db
        .query(`UPDATE tasks SET notifying=notifying+1 WHERE id=?
      AND released=0 AND status IN ('dispatching','running')`)
        .run(taskID).changes === 1
    );
  }

  endNotify(taskID: string) {
    this.db
      .query(
        "UPDATE tasks SET notifying=notifying-1 WHERE id=? AND notifying>0",
      )
      .run(taskID);
  }

  mailCursor(sessionID: string, taskID: string, acknowledged?: number): number {
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

  close() {
    this.db.close();
  }
}
