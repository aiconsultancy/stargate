import { Schema } from "effect";
import { z } from "zod";
import {
  settingsDefault,
  settingsPattern,
  settingsStruct,
} from "./settings-schema";

export const crewActivitySchema = settingsStruct({
  detail: Schema.Literals(["off", "summary", "detailed"]).pipe(
    settingsDefault("off"),
  ),
  reporter: Schema.optional(
    Schema.String.check(settingsPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/)),
  ),
});
export type CrewActivitySettings = typeof crewActivitySchema.Type;

export const activityEntrySchema = z.strictObject({
  id: z.number().int().nonnegative(),
  taskID: z.string().min(1).max(100).optional(),
  member: z.string().min(1).max(100),
  kind: z.enum(["assignment", "update", "message", "result", "note"]),
  text: z.string().max(1500),
});
export const activitySnapshotSchema = z.strictObject({
  id: z.string().min(1).max(100),
  revision: z.number().int().nonnegative(),
  status: z.enum([
    "collecting",
    "summarizing",
    "complete",
    "unavailable",
    "cancelled",
  ]),
  reporter: z.string().min(1).max(100),
  summary: z.string().max(3000),
  summaryCurrent: z.boolean().optional(),
  entries: z.array(activityEntrySchema).max(8),
  truncated: z.boolean(),
});
export type ActivitySnapshot = z.infer<typeof activitySnapshotSchema>;
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
