import { Schema } from "effect";
import { exactStruct } from "./session-history";

/** Raw dispatch and stored task text bound, in code points. */
export const crewTaskTextLimit = 64_000;

/** Take the first `limit` code points without splitting a surrogate pair. */
export function codePointHead(text: string, limit: number) {
  const bound = Math.floor(limit);

  if (text.length <= bound) {
    return text;
  }

  if (Number.isNaN(bound) || bound <= 0) {
    return "";
  }

  let end = 0;
  let points = 0;

  for (const point of text) {
    end += point.length;
    points += 1;

    if (points >= bound) {
      break;
    }
  }

  return text.slice(0, end);
}

export function truncateCrewTaskText(text: string) {
  return codePointHead(text, crewTaskTextLimit);
}

export function isCrewTaskTextWithinLimit(text: string) {
  return codePointHead(text, crewTaskTextLimit).length === text.length;
}

/** The ordinary display bounds; the unredacted view counts code points. */
export const crewTaskTextLimits = {
  summary: 180,
  phase: 80,
  progress: 400,
} as const;

// Zod's string bounds counted code points; keep that unit at this boundary.
const maxCodePoints = (maximum: number) =>
  Schema.String.check(Schema.isMaxCodePoints(maximum));

const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

// Decoded statuses stay mutable records, as their callers use them.
const field = Schema.mutableKey;

export const crewStatusInputSchema = exactStruct({
  member: field(
    Schema.optional(
      Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/)),
    ),
  ),
});

const time = field(Schema.NullOr(count));

/** Code-point limits on task text, which the crew wrote. */
export type CrewTaskTextLimits = {
  summary: number;
  phase: number;
  progress: number;
};

/** Crew status, with the given task text limits. */
export function crewStatusSchemaWith(limits: CrewTaskTextLimits) {
  const task = exactStruct({
    id: field(maxCodePoints(100)),
    status: field(
      Schema.Literals([
        "queued",
        "cancelled",
        "dispatching",
        "running",
        "completed",
        "cancelling",
        "uncertain",
        "abandoned",
      ]),
    ),
    kind: field(Schema.Literals(["assignment", "report", "unknown"])),
    summary: field(maxCodePoints(limits.summary)),
    phase: field(maxCodePoints(limits.phase)),
    progress: field(maxCodePoints(limits.progress)),
    createdAt: time,
    startedAt: time,
    updatedAt: time,
    finishedAt: time,
  });

  const member = exactStruct({
    id: field(maxCodePoints(64)),
    /** Configured repository context; absent for the legacy single project. */
    project: field(
      Schema.optional(
        Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,47}$/)),
      ),
    ),
    name: field(maxCodePoints(100)),
    backend: field(Schema.Literals(["opencode", "pi-durable"])),
    provisioned: field(Schema.Literals(["unprovisioned", "pending", "ready"])),
    observed: field(Schema.Boolean),
    current: field(Schema.NullOr(task)),
    queuedCount: field(count),
    queued: field(
      Schema.mutable(Schema.Array(task)).check(Schema.isMaxLength(5)),
    ),
    lastOutcome: field(Schema.NullOr(task)),
    recent: field(
      Schema.mutable(Schema.Array(task)).check(Schema.isMaxLength(8)),
    ),
    recentCount: field(count),
  });

  const status = exactStruct({
    members: field(
      Schema.mutable(Schema.Array(member)).check(Schema.isMaxLength(20)),
    ),
    total: field(count),
    truncated: field(Schema.Boolean),
    /** Exact aggregate across every context, including rows after the page limit. */
    busy: field(Schema.optional(count.check(Schema.isLessThanOrEqualTo(50)))),
  }).check(
    Schema.makeFilter((status) => {
      const visible = status.members.filter((item) => item.current).length;

      return status.busy !== undefined &&
        (status.busy > status.total || status.busy < visible)
        ? {
            path: ["busy"],
            issue:
              "Busy count must include visible activity and cannot exceed total members.",
          }
        : undefined;
    }),
  );

  return { task, status };
}

/**
 * How crew status shows task text. `ordinary` redacts and bounds it,
 * `unredacted` only bounds it, and `full` returns it as stored.
 */
export type CrewTaskTextMode = "ordinary" | "unredacted" | "full";

const ordinary = crewStatusSchemaWith(crewTaskTextLimits);

export const crewStatusSchema = ordinary.status;

export type CrewStatus = typeof crewStatusSchema.Type;

export type CrewStatusInput = typeof crewStatusInputSchema.Type;

export type CrewStatusTask = typeof ordinary.task.Type;
