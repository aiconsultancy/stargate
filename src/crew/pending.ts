/**
 * The `pending_tasks` rows that can still start. The engine lists, counts
 * and promotes only queued rows; a promoted row moves to `tasks`, and a
 * cancelled row (`status='cancelled'`, always with `released=1`) is
 * terminal. `notifying` never changes on pending rows: only running tasks
 * notify. Shared by the engine and the maintenance idle gate, which reads
 * the crew store directly.
 */
export const queuedPendingTask = "status='queued'";

/**
 * SQL predicate: the task `column` names is an activity-report task. The
 * engine's own marker is a row in `activity_report_tasks`
 * (`ReportingStore.markReport`). Only these queued tasks can start without a
 * captain turn: the gateway's activity delivery admits them after a turn and
 * when it starts (`ReportingStore.advance` → `CrewEngine.progressReport`).
 * An ordinary queued assignment starts only through the captain's
 * `stargate_crew` status or wait.
 */
export const reportTask = (column: string) =>
  `EXISTS (SELECT 1 FROM activity_report_tasks r WHERE r.taskID=${column})`;
