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
export const crewStatusSchema = z
  .strictObject({
    members: z
      .array(
        z.strictObject({
          id: z.string().max(64),
          /** Configured repository context; absent for the legacy single project. */
          project: z
            .string()
            .regex(/^[a-z][a-z0-9_-]{0,47}$/)
            .optional(),
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
    /** Exact aggregate across every context, including rows after the page limit. */
    busy: z.number().int().min(0).max(50).optional(),
  })
  .superRefine((status, context) => {
    const visible = status.members.filter((member) => member.current).length;
    if (
      status.busy !== undefined &&
      (status.busy > status.total || status.busy < visible)
    )
      context.addIssue({
        code: "custom",
        path: ["busy"],
        message:
          "Busy count must include visible activity and cannot exceed total members.",
      });
  });
export type CrewStatus = z.infer<typeof crewStatusSchema>;
export type CrewStatusInput = z.infer<typeof crewStatusInputSchema>;
export type CrewStatusTask = z.infer<typeof task>;

/** Multi-project dispatch adds a worktree preamble for the worker, outside
 * the assignment itself. Older retained summaries may end inside it. */
export function crewAssignmentText(text: string): string {
  if (
    !/^Configured Stargate project: [a-z][a-z0-9_-]*\.\nUse only your permanent worktree: /.test(
      text,
    )
  )
    return text;
  const start = text.indexOf("\n\n");
  return start < 0 ? "Project assignment" : text.slice(start + 2);
}
