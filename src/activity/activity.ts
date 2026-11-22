import { Schema } from "effect";
import {
  settingsDefault,
  settingsPattern,
  settingsStruct,
} from "../config/settings-schema";

export const crewActivitySchema = settingsStruct({
  detail: Schema.Literals(["off", "summary", "detailed"]).pipe(
    settingsDefault("off"),
  ),
  reporter: Schema.optional(
    Schema.String.check(settingsPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/)),
  ),
});
export type CrewActivitySettings = typeof crewActivitySchema.Type;

export const activityEntrySchema = settingsStruct({
  id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  taskID: Schema.optional(
    Schema.String.check(Schema.isMinCodePoints(1), Schema.isMaxCodePoints(100)),
  ),
  member: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(100),
  ),
  kind: Schema.Literals(["assignment", "update", "message", "result", "note"]),
  text: Schema.String.check(Schema.isMaxCodePoints(1500)),
});
export const activitySnapshotSchema = settingsStruct({
  id: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(100),
  ),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  status: Schema.Literals([
    "collecting",
    "summarizing",
    "complete",
    "unavailable",
    "cancelled",
  ]),
  reporter: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(100),
  ),
  summary: Schema.String.check(Schema.isMaxCodePoints(3000)),
  summaryCurrent: Schema.optional(Schema.Boolean),
  entries: Schema.mutable(Schema.Array(activityEntrySchema)).check(
    Schema.isMaxLength(8),
  ),
  truncated: Schema.Boolean,
});
export type ActivitySnapshot = typeof activitySnapshotSchema.Type;
export type ActivityView = ActivitySnapshot & {
  detail: "summary" | "detailed";
};

/** Optional backend capability; scoped to one accepted captain request. */
export interface ActivityWatch {
  id?: string;
  read(signal: AbortSignal, passive?: boolean): Promise<ActivitySnapshot>;
  finish(signal: AbortSignal): Promise<ActivitySnapshot>;
  cancel(signal: AbortSignal): Promise<void>;
}
