import type { Database } from "bun:sqlite";
import { pendingJobs, unfinishedJobs } from "./job-status";
import { type StoredJob, decodeStoredJob } from "./row-codec";
import type { Job } from "./store-types";

export class QueueAdmission {
  public constructor(private readonly db: Database) {}

  public ready(
    botKey: string,
    now: number,
    limit: number,
    serial = false,
    holdQueued = false,
    pinnedSession?: string,
  ): Job[] {
    return this.db
      .query<StoredJob, (string | number | null)[]>(`SELECT j.* FROM jobs j
      LEFT JOIN compaction_holds held ON held.session_id=COALESCE(
        ?, (SELECT session_id FROM sessions WHERE conversation=j.conversation)
      )
      WHERE botKey = ? AND status IN ('queued','responding') AND retry_at <= ?
      ${holdQueued ? "AND status='responding'" : ""}
      AND (j.status!='queued' OR (held.session_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM jobs active WHERE active.status='running' AND active.pinned_session=?
      )))
      AND NOT EXISTS (SELECT 1 FROM jobs earlier
        WHERE earlier.conversation=j.conversation AND earlier.id < j.id
         AND earlier.status IN (${unfinishedJobs})
         AND NOT (held.session_id IS NOT NULL AND j.status='responding' AND earlier.status='queued')
         AND NOT (j.notification_context IS NULL AND earlier.status='queued'
           AND earlier.notification_held=1 AND (earlier.retry_at>? OR j.status='responding')))
      AND NOT (j.notification_held=1 AND EXISTS (SELECT 1 FROM jobs later
        WHERE later.conversation=j.conversation AND later.id>j.id
        AND later.status IN ('running','responding')))
      ${
        serial
          ? `AND (j.status!='queued' OR NOT EXISTS
        (SELECT 1 FROM jobs pending WHERE pending.botKey=j.botKey
        AND pending.id<j.id AND pending.status IN (${pendingJobs})
        AND NOT (j.notification_context IS NULL AND pending.status='queued'
          AND pending.notification_held=1 AND pending.retry_at>?)))`
          : ""
      }
      ORDER BY id LIMIT ?`)
      .all(
        pinnedSession ?? null,
        botKey,
        now,
        pinnedSession ?? null,
        now,
        ...(serial ? [now] : []),
        limit,
      )
      .map((item) => decodeStoredJob(item));
  }

  /** Hold native intake without changing delivery or replaying submitted input. */
  public holdCompaction(session: string, unsubmittedJob?: number) {
    return this.db.transaction(() => {
      const recorded =
        this.db
          .query(
            "INSERT OR IGNORE INTO compaction_holds (session_id) VALUES (?)",
          )
          .run(session).changes > 0;

      const requeued =
        unsubmittedJob !== undefined &&
        this.db
          .query(`UPDATE jobs SET status='queued',started=0
            WHERE id=? AND status='running' AND cancel_requested=0 AND input IS NULL`)
          .run(unsubmittedJob).changes > 0;

      return { recorded, requeued };
    })();
  }

  public running(id: number, expectedText?: string, pinnedSession?: string) {
    // IRC and Teams can have different registration keys for one native pin.
    // Admit only one turn at a time so a compaction hold wins before the next.
    return (
      this.db
        .query(
          `UPDATE jobs SET status='running',notification_held=0,pinned_session=$pin
           WHERE id=$id AND status='queued' AND cancel_requested=0
             AND ($expected IS NULL OR text=$expected)
             AND NOT EXISTS (SELECT 1 FROM jobs active
               WHERE active.status='running' AND active.pinned_session=$pin)
             AND NOT EXISTS (SELECT 1 FROM compaction_holds h WHERE h.session_id=COALESCE(
               $pin, (SELECT session_id FROM sessions WHERE sessions.conversation=jobs.conversation)
             ))`,
        )
        .run({
          $id: id,
          $expected: expectedText ?? null,
          $pin: pinnedSession ?? null,
        }).changes > 0
    );
  }
}
