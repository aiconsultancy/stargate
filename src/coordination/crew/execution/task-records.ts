import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { redactCredentials } from "../../../lib/credentials";
import { CrewError, type CrewID, type CrewTask } from "../pending";
import type { MemberActivityStore } from "../reporting/member-activity";
import type { ReportingStore } from "../reporting/reporting";

export type Peer = {
  crewID: CrewID;
  sessionID: string;
  status: "pending" | "ready";
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

export type AbandonExpected = Pick<
  CrewTask,
  "id" | "crewID" | "workerSessionID" | "originCaptainID" | "inputID"
> & { status: AbandonableStatus; controlID: string | null };

const abandonmentColumns = `taskID,crewID,workerSessionID,originCaptainID,inputID,
  abandonedBy,previousStatus,previousResult,reason,operationKey,clearedControlID,
  stop,stopDetail,createdAt,stoppedAt`;

// Controls held by operations in this process. An explicit captain override
// May clear a crash-held control, never one an operation here still holds.
const liveControls = new Set<string>();

/** Not a valid captain abandon key, so audits stay distinguishable. */
export const withdrawKey = "stargate:cancel";

const controlID = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/** Task ownership, worker controls and their durable recovery records. */
export class CrewTaskRecords {
  public constructor(
    private readonly db: Database,
    private readonly path: string,
    private readonly reporting: ReportingStore,
    private readonly activity: MemberActivityStore,
  ) {}

  public peer(crewID: CrewID): Peer | null {
    return this.db
      .query<Peer, [string]>("SELECT * FROM peers WHERE crewID=?")
      .get(crewID);
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

  public reserveTask(
    peer: Peer,
    captainID: string,
    text = "",
    originInputID: string | null = null,
  ): CrewTask | null {
    return this.db
      .transaction(() => {
        if (this.activeTask(peer.crewID) || this.controlled(peer.crewID)) {
          return null;
        }

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
        ) {
          throw new CrewError(
            "Task ownership or state changed; inspect again before reconciliation.",
          );
        }

        if (this.controlled(expected.crewID)) {
          throw new CrewError(
            "Worker control is reserved; do not steal it. Inspect before retrying.",
          );
        }

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

        if (control?.token !== token || !this.unchangedTask(task)) {
          throw new CrewError(
            "Task ownership changed before resume; inspect again.",
          );
        }

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
        ) {
          throw new CrewError(
            "Task ownership or state changed; inspect again. Nothing abandoned.",
          );
        }

        if (this.resumeBoundaries(task.id, true).length > 0) {
          throw new CrewError(
            "Resume admission is still unconfirmed. Inspect status before releasing the task.",
          );
        }

        const control = this.db
          .query<{ token: string }, [string]>(
            "SELECT token FROM worker_controls WHERE crewID=?",
          )
          .get(expected.crewID);

        const held = control ? controlID(control.token) : null;

        if (held !== expected.controlID) {
          throw new CrewError(
            held
              ? "Worker control is reserved. Pass its inspected controlID only if no Stargate operation can still hold it. Nothing abandoned."
              : "Expected worker control is gone; inspect again. Nothing abandoned.",
          );
        }

        if (control && liveControls.has(`${this.path}\0${control.token}`)) {
          throw new CrewError(
            "Worker control is held by an operation in this process; retry after it ends. Nothing abandoned.",
          );
        }

        if (control) {
          this.db
            .query("DELETE FROM worker_controls WHERE crewID=? AND token=?")
            .run(expected.crewID, control.token);
        }

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
        if (this.reporting.isReport(task.id)) {
          this.reporting.record(updated, "update", "Outcome uncertain");
        }

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

        if (row?.stop !== "pending") {
          return null;
        }

        if (liveControls.has(`${this.path}\0${row.controlToken}`)) {
          return null;
        }

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

        if (!row) {
          throw new CrewError("Abandon audit missing.");
        }

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
        if (this.controlled(crewID)) {
          throw new CrewError(
            "Worker control is reserved by another operation; inspect again. No Git change made.",
          );
        }

        const active = this.activeTask(crewID);

        if ((active?.id ?? null) !== expectedTaskID) {
          throw new CrewError(
            "Worker task slot changed since inspection; inspect again. No Git change made.",
          );
        }

        if (
          active &&
          ((active.status !== "completed" && active.status !== "uncertain") ||
            active.notifying)
        ) {
          throw new CrewError(
            "Worker has Stargate-active work; wait, or abandon it before changing the workspace. No Git change made.",
          );
        }

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
        ) {
          throw new CrewError(
            "Task ownership or state changed during verification; inspect again.",
          );
        }

        if (expected.result !== null && expected.result !== result) {
          throw new CrewError(
            "Retained task result conflicts; no state changed.",
          );
        }

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

        if (!audit) {
          throw new CrewError("Reconciliation audit missing.");
        }

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

  public reserveStatusRequest(id: string, task: CrewTask, captainID: string) {
    this.db
      .transaction(() => {
        if (!this.unchangedTask(task)) {
          throw new CrewError(
            "Task ownership changed before the status request; inspect again.",
          );
        }

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

  public reserveControl(crewID: string): string {
    return this.db
      .transaction(() => {
        if (this.controlled(crewID)) {
          throw new CrewError(
            "Worker control already reserved; reconcile crash-held controls manually.",
          );
        }

        const active = this.activeTask(crewID);

        if (active && (active.status !== "completed" || active.notifying)) {
          throw new CrewError(
            "Worker has running or uncertain work; control refused.",
          );
        }

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
        ) {
          return;
        }

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

        if (this.reporting.isReport(task.id)) {
          this.reporting.record(updated, "update", "Outcome uncertain");
        }

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

  public complete(id: string, workerSessionID: string, resultInput: string) {
    let result = resultInput;

    if (this.reporting.isReport(id)) {
      result = redactCredentials(result, 3000);
    }

    this.db
      .transaction(() => {
        const task = this.task(id);

        if (!task || task.workerSessionID !== workerSessionID) {
          throw new CrewError(
            "Only the assigned worker can complete this task.",
          );
        }

        if (task.status === "completed" && task.result === result) {
          return;
        }

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
        ) {
          throw new CrewError(
            "Task is not current. Inspect its state; do not replay work.",
          );
        }

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

  public recoverResult(expected: CrewTask, resultInput: string): CrewTask {
    let result = resultInput;

    if (this.reporting.isReport(expected.id)) {
      result = redactCredentials(result, 3000);
    }

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

    if (changed && task) {
      this.activity.phase(task, "cancelling");
    }

    return changed;
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
}
