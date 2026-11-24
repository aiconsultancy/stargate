import type { Database } from "bun:sqlite";
import type { UpdateNotices } from "../../../automation/maintenance/update-notice";
import { type CrewTask, queuedPendingTask } from "../pending";

/** Durable marks and notices for the crew maintenance drain. */
export class CrewDrainRecords {
  public constructor(
    private readonly db: Database,
    private readonly updateNotices: Pick<UpdateNotices, "queueExternalContext">,
  ) {}

  /** The caller must hold the task reservation transaction. */
  public markQueued(taskID: string, runID: string) {
    this.db
      .query(
        "INSERT OR IGNORE INTO maintenance_queued_tasks (taskID,runID) VALUES (?,?)",
      )
      .run(taskID, runID);
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

        if (!first) {
          return "unchanged" as const;
        }

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
}
