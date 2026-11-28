import type { Database } from "bun:sqlite";
import { Schema } from "effect";
import {
  FleetError,
  type NativeMaker,
  nativeMakerSchema,
} from "../coordination/fleet/protocol";
import { type StoredJob, decodeStoredJob } from "./row-codec";
import type { Job } from "./store-types";

export class FleetJobRecords {
  public constructor(private readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS fleet_deferred_results (
      job INTEGER PRIMARY KEY, task TEXT NOT NULL, expires INTEGER NOT NULL
    )`);
  }

  public deferResult(job: number, task: string) {
    this.db
      .transaction(() => {
        const current = this.deferredResult(job);

        if (current) {
          if (current.task !== task) {
            throw new FleetError(
              "This assignment already has a different deferred task.",
            );
          }

          return;
        }

        this.db
          .query("INSERT INTO fleet_deferred_results VALUES (?,?,?)")
          .run(job, task, Date.now() + 24 * 60 * 60 * 1000);
      })
      .immediate();
  }

  public deferredResult(job: number) {
    return this.db
      .query<{ task: string; expires: number }, [number]>(
        "SELECT task,expires FROM fleet_deferred_results WHERE job=?",
      )
      .get(job);
  }

  public pendingFleetJobs(botKey: string): Job[] {
    return this.db
      .query<StoredJob, [string]>(
        "SELECT * FROM jobs WHERE botKey=? AND json_extract(fleet_context,'$.kind')='assignment' AND fleet_exported=0 ORDER BY id IN (SELECT job FROM fleet_deferred_results), id LIMIT 100",
      )
      .all(botKey)
      .map((item) => decodeStoredJob(item));
  }

  public fleetPublished(id: number) {
    this.db
      .query(
        "UPDATE jobs SET fleet_exported=1 WHERE id=? AND json_extract(fleet_context,'$.kind')='assignment'",
      )
      .run(id);
  }

  public saveMakers(id: number, makers: NativeMaker[]) {
    this.db
      .query("UPDATE jobs SET makers=? WHERE id=? AND makers IS NULL")
      .run(
        JSON.stringify(
          Schema.decodeUnknownSync(
            Schema.mutable(Schema.Array(nativeMakerSchema)).check(
              Schema.isMaxLength(100),
            ),
          )(makers),
        ),
        id,
      );
  }
}
