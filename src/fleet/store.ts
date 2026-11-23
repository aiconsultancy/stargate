import type { Database } from "bun:sqlite";
import { Schema } from "effect";
import { type NativeMaker, nativeMakerSchema } from "./protocol";

export class FleetRecords<TStored, TJob> {
  public constructor(
    private readonly db: Database,
    private readonly decodeStoredJob: (row: TStored) => TJob,
  ) {}

  public pendingFleetJobs(botKey: string): TJob[] {
    return this.db
      .query<TStored, [string]>(
        "SELECT * FROM jobs WHERE botKey=? AND json_extract(fleet_context,'$.kind')='assignment' AND fleet_exported=0 ORDER BY id LIMIT 100",
      )
      .all(botKey)
      .map((item) => this.decodeStoredJob(item));
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
