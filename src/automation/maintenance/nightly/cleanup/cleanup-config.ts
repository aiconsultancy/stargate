import { isAbsolute } from "node:path";
import { Schema } from "effect";
import {
  settingsDefault,
  settingsPattern,
  settingsRefine,
  settingsStruct,
} from "../../../../config/settings-schema";

const path = Schema.String.check(Schema.isMinCodePoints(1))
  .check(Schema.isMaxCodePoints(4096))
  .check(settingsRefine(isAbsolute, { message: "Use an absolute path" }))
  .check(
    settingsRefine(
      (value) =>
        !Array.from(value).some(
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

export const cleanupReasonSchema = Schema.Literals([
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

const bytes = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export const cleanupItemSchema = settingsStruct({
  kind: Schema.Literals(["scratch", "branch", "worktree"]),
  path,
  status: Schema.Literals(["planned", "removed", "skipped", "failed"]),
  reason: cleanupReasonSchema,
  size: bytes,
  /** Milliseconds since epoch; 0 means unavailable (never deletion evidence). */
  newestMtime: bytes,
  branch: Schema.optional(
    Schema.String.check(
      Schema.isMinCodePoints(1),
      Schema.isMaxCodePoints(1024),
    ),
  ),
  tip: Schema.optional(
    Schema.String.check(settingsPattern(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/)),
  ),
});

export const cleanupResultSchema = settingsStruct({
  items: Schema.mutable(Schema.Array(cleanupItemSchema)).check(
    Schema.isMaxLength(500),
  ),
  freedBytes: bytes,
  plannedBytes: bytes,
});

export type CleanupReason = typeof cleanupReasonSchema.Type;

export type CleanupItem = typeof cleanupItemSchema.Type;

export type CleanupResult = typeof cleanupResultSchema.Type;
