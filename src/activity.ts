import { z } from "zod";

export const crewActivitySchema = z.strictObject({
  detail: z.enum(["off", "summary", "detailed"]).default("off"),
  reporter: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
    .default("twiki"),
});
export type CrewActivitySettings = z.infer<typeof crewActivitySchema>;

export const activityEntrySchema = z.strictObject({
  id: z.number().int().nonnegative(),
  taskID: z.string().min(1).max(100),
  member: z.string().min(1).max(100),
  kind: z.enum(["assignment", "update", "message", "result"]),
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
  entries: z.array(activityEntrySchema).max(8),
  truncated: z.boolean(),
});
export type ActivitySnapshot = z.infer<typeof activitySnapshotSchema>;
export type ActivityView = ActivitySnapshot & {
  detail: "summary" | "detailed";
};

/** Optional backend capability; scoped to one accepted captain request. */
export interface ActivityWatch {
  read(signal: AbortSignal): Promise<ActivitySnapshot>;
  finish(signal: AbortSignal): Promise<ActivitySnapshot>;
  cancel(signal: AbortSignal): Promise<void>;
}
