import { z } from "zod";

export const crewStatusInputSchema = z.strictObject({
  member: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
    .optional(),
});
const time = z.number().int().nonnegative().nullable();
const task = z.strictObject({
  id: z.string().max(100),
  status: z.enum([
    "queued",
    "cancelled",
    "dispatching",
    "running",
    "completed",
    "cancelling",
    "uncertain",
    "abandoned",
  ]),
  kind: z.enum(["assignment", "report", "unknown"]),
  summary: z.string().max(180),
  phase: z.string().max(80),
  progress: z.string().max(400),
  createdAt: time,
  startedAt: time,
  updatedAt: time,
  finishedAt: time,
});
export const crewStatusSchema = z.strictObject({
  members: z
    .array(
      z.strictObject({
        id: z.string().max(64),
        name: z.string().max(100),
        backend: z.enum(["opencode", "pi-durable"]),
        provisioned: z.enum(["unprovisioned", "pending", "ready"]),
        observed: z.boolean(),
        current: task.nullable(),
        queuedCount: z.number().int().nonnegative(),
        queued: z.array(task).max(5),
        lastOutcome: task.nullable(),
        recent: z.array(task).max(8),
        recentCount: z.number().int().nonnegative(),
      }),
    )
    .max(20),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type CrewStatus = z.infer<typeof crewStatusSchema>;
export type CrewStatusInput = z.infer<typeof crewStatusInputSchema>;
export type CrewStatusTask = z.infer<typeof task>;
