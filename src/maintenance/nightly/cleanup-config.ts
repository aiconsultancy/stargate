import { isAbsolute } from "node:path";
import { Schema } from "effect";
import { z } from "zod";
import { legacySetting } from "../../config/settings-legacy";
import {
  settingsDefault,
  settingsRefine,
  settingsStruct,
} from "../../config/settings-schema";

const path = Schema.String.check(Schema.isMinCodePoints(1))
  .check(Schema.isMaxCodePoints(4096))
  .check(settingsRefine(isAbsolute, { message: "Use an absolute path" }))
  .check(
    settingsRefine(
      (value) =>
        ![...value].some(
          (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
        ),
      { message: "No control characters" },
    ),
  );

/** Cleanup has separate standing approval; enabling maintenance does not enable it. */
export const cleanupSchema = settingsStruct({
  enabled: Schema.Boolean.pipe(settingsDefault(false)),
  olderThanDays: Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(1))
    .check(Schema.isLessThanOrEqualTo(3650))
    .pipe(settingsDefault(5)),
  scratchRoots: Schema.mutable(Schema.Array(path))
    .check(Schema.isMaxLength(32))
    .pipe(settingsDefault([])),
  repositories: Schema.mutable(Schema.Array(path))
    .check(Schema.isMaxLength(32))
    .pipe(settingsDefault([])),
  protectedPaths: Schema.mutable(Schema.Array(path))
    .check(Schema.isMaxLength(256))
    .pipe(settingsDefault([])),
});
export type CleanupSettings = typeof cleanupSchema.Type;

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
  path: legacySetting(path),
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
