/**
 * Job lifecycle. Each method below is one transition and its SQL guard is
 * the check: a transition from any other status writes nothing.
 *
 * - queued → running: `running` (not after an accepted Stop).
 * - queued → responding: an accepted Stop (`cancel`, `cancelTurn`).
 * - running → responding: `respond` (throws `JobTransitionRefused` from
 *   another status), or `recover` after a restart.
 * - responding → done or failed: `finish`, after delivery or its last retry.
 * - failed → responding: `appendTranscript` requeues a `transcript:*` row.
 * - queued → failed: `finish`, when access was removed before the turn.
 *
 * While responding, `sent` moves the delivery cursor forward and `retry`
 * delays the next attempt. `finish`, `sent` and `retry` return false when
 * the status refused them.
 *
 * A row with `deferDelivery` has no delivery: it goes to `done` at once.
 */
export const jobStatuses = [
  "queued",
  "running",
  "responding",
  "done",
  "failed",
] as const;

export type JobStatus = (typeof jobStatuses)[number];
