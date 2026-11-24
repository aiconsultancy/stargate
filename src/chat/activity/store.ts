import type { Database } from "bun:sqlite";
import { Schema } from "effect";
import { settingsStruct } from "../../config/settings-schema";

const activityProgress = settingsStruct({
  ts: Schema.optional(Schema.String),
  capture: Schema.String,
  revision: Schema.Int,
  done: Schema.Boolean,
});

export type ActivityProgress = typeof activityProgress.Type;

export class ActivityRecords {
  public constructor(private readonly db: Database) {}

  public activity(id: number): ActivityProgress | undefined {
    const raw = this.db
      .query<{ activity: string | null }, [number]>(
        "SELECT activity FROM jobs WHERE id=?",
      )
      .get(id)?.activity;

    return raw
      ? Schema.decodeUnknownSync(activityProgress)(JSON.parse(raw))
      : undefined;
  }

  public saveActivity(id: number, progress: ActivityProgress) {
    this.db
      .query("UPDATE jobs SET activity=? WHERE id=?")
      .run(
        JSON.stringify(Schema.decodeUnknownSync(activityProgress)(progress)),
        id,
      );
  }
}
