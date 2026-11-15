import { isAbsolute } from "node:path";
import { z } from "zod";

const path = z
  .string()
  .min(1)
  .max(4096)
  .refine(isAbsolute, "Use an absolute path")
  .refine(
    (value) =>
      ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
    "No control characters",
  );

/** Cleanup has separate standing approval; enabling maintenance does not enable it. */
export const cleanupSchema = z.strictObject({
  enabled: z.boolean().default(false),
  olderThanDays: z.number().int().min(1).max(3650).default(5),
  scratchRoots: z.array(path).max(32).default([]),
  repositories: z.array(path).max(32).default([]),
  protectedPaths: z.array(path).max(256).default([]),
});
export type CleanupSettings = z.infer<typeof cleanupSchema>;

export const cleanupReasonSchema = z.enum([
  "stale",
  "merged",
  "pushed",
  "protected",
  "recent",
  "retained",
  "symlink",
  "unsafe-path",
  "in-use",
  "use-unknown",
  "dirty",
  "unpushed",
  "git-unknown",
  "locked",
  "primary",
  "checked-out",
  "fetch-failed",
  "changed",
  "metadata-unknown",
  "scan-limit",
  "aborted",
  "deadline",
  "command-failed",
  "audit-failed",
  "gate-failed",
]);
export const cleanupItemSchema = z.strictObject({
  kind: z.enum(["scratch", "branch", "worktree"]),
  path,
  status: z.enum(["planned", "removed", "skipped", "failed"]),
  reason: cleanupReasonSchema,
  size: z.number().nonnegative().finite(),
  /** Milliseconds since epoch; 0 means unavailable (never deletion evidence). */
  newestMtime: z.number().nonnegative().finite(),
  branch: z.string().min(1).max(1024).optional(),
  tip: z
    .string()
    .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/)
    .optional(),
});
export const cleanupResultSchema = z.strictObject({
  items: z.array(cleanupItemSchema).max(500),
  freedBytes: z.number().nonnegative().finite(),
  plannedBytes: z.number().nonnegative().finite(),
});
export type CleanupReason = z.infer<typeof cleanupReasonSchema>;
export type CleanupItem = z.infer<typeof cleanupItemSchema>;
export type CleanupResult = z.infer<typeof cleanupResultSchema>;
