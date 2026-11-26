import { isAbsolute } from "node:path";
import { Schema } from "effect";
import { crewStatusSchema } from "../../../shared/crew-status";
import {
  HISTORY_PAGE,
  MAX_CREW_CONTEXTS,
  exactStruct,
} from "../../../shared/session-history";
import { effectProjectKeySchema } from "../protocol/project-key";
import { agentIDSchema } from "../team";

const directory = Schema.String.check(
  Schema.isBetweenCodePoints(1, 4096),
  Schema.makeFilter((path) => isAbsolute(path) && !path.includes("\0")),
);

const metadata = exactStruct({
  projectDirectory: directory,
  contexts: Schema.Array(
    exactStruct({
      member: agentIDSchema,
      project: Schema.NullOr(effectProjectKeySchema),
      directory,
      role: Schema.optional(Schema.String.check(Schema.isMaxCodePoints(1000))),
      model: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
    }),
  ).check(Schema.isMaxLength(20)),
});

/** Internal, location-scoped RPC. The Fleet API also shows checkout paths that crew task text contains. */
export const fleetCrewStatusInputSchema = exactStruct({
  member: Schema.optional(agentIDSchema),
});

export const fleetCrewStatusSchema = exactStruct({
  status: crewStatusSchema,
  metadata,
});

export type FleetCrewStatus = typeof fleetCrewStatusSchema.Type;

const count = Schema.NullOr(
  Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);

/**
 * Git state of one checkout, read by the captain's crew plugin as the user
 * that owns the worktree. The gateway may run as another user that cannot
 * read the captain's home.
 */
export const crewGitStateSchema = exactStruct({
  branch: Schema.NullOr(
    Schema.String.check(Schema.isBetweenCodePoints(1, 255)),
  ),
  /** Full object ID of HEAD; null for an unborn branch. */
  commit: Schema.NullOr(
    Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)),
  ),
  /** The upstream, or the remote default branch, compared against. */
  base: Schema.NullOr(Schema.String.check(Schema.isBetweenCodePoints(1, 255))),
  ahead: count,
  behind: count,
  /** Changed, added, deleted and untracked paths; ignored files excluded. */
  changedFiles: count,
  /** The `origin` URL without any user information. */
  remote: Schema.NullOr(
    Schema.String.check(Schema.isBetweenCodePoints(1, 2048)),
  ),
  checkedAt: Schema.Finite,
  /** A fixed reason when the read failed; the other fields are then null. */
  error: Schema.optional(Schema.String.check(Schema.isMaxCodePoints(200))),
});

export type CrewGitState = typeof crewGitStateSchema.Type;

export const crewGitInputSchema = exactStruct({
  /** Only this member's contexts. */
  member: Schema.optional(agentIDSchema),
  /** False reads only the captain's project checkout. Default true. */
  crew: Schema.optional(Schema.Boolean),
});

export type CrewGitInput = typeof crewGitInputSchema.Type;

export const crewGitSchema = exactStruct({
  /** The captain's default project checkout. */
  project: exactStruct({ directory, git: Schema.NullOr(crewGitStateSchema) }),
  contexts: Schema.Array(
    exactStruct({
      member: agentIDSchema,
      project: Schema.NullOr(effectProjectKeySchema),
      directory,
      /** Null when the checkout does not exist yet. */
      git: Schema.NullOr(crewGitStateSchema),
    }),
  ).check(Schema.isMaxLength(HISTORY_PAGE)),
});

export type CrewGit = typeof crewGitSchema.Type;

/** Settled tasks kept per member and project, newest first. */
export const settledTasksPerMember = 16;

/** The original input plus the latest resume inputs. */
export const maxTaskInputs = 64;

const nativeID = Schema.String.check(Schema.isBetweenCodePoints(1, 256));

const taskStatusSchema = Schema.Literals([
  "dispatching",
  "running",
  "cancelling",
  "uncertain",
  "completed",
  "abandoned",
  "cancelled",
]);

/** Internal, location-scoped RPC that attributes crew turns to tasks. */
export const crewTurnsInputSchema = exactStruct({
  /** Only this member's peers and tasks. */
  member: Schema.optional(agentIDSchema),
  /** Only the task, of any age, that has used this input. */
  inputID: Schema.optional(nativeID),
});

export type CrewTurnsInput = typeof crewTurnsInputSchema.Type;

export const crewTurnsSchema = exactStruct({
  /**
   * Every configured crew member, and whether its current backend is one
   * the gateway collects (OpenCode); absent from older plugins. At most
   * `MAX_CREW_CONTEXTS`, the configuration's load-time bound.
   */
  members: Schema.optional(
    Schema.Array(
      exactStruct({ member: agentIDSchema, collected: Schema.Boolean }),
    ).check(Schema.isMaxLength(MAX_CREW_CONTEXTS)),
  ),
  /**
   * Each current peer worker session of this plugin's team: at most one per
   * member context (member and project).
   */
  peers: Schema.Array(
    exactStruct({
      member: agentIDSchema,
      /** Null for the captain's default project. */
      project: Schema.NullOr(effectProjectKeySchema),
      workerSessionID: nativeID,
      namespace: nativeID,
    }),
  ).check(Schema.isMaxLength(MAX_CREW_CONTEXTS)),
  /**
   * Running, dispatching, cancelling and uncertain tasks, plus the latest
   * settled tasks per member and project; with `inputID`, only its task.
   * At most `settledTasksPerMember + 1` per member context.
   */
  tasks: Schema.Array(
    exactStruct({
      taskID: nativeID,
      member: agentIDSchema,
      project: Schema.NullOr(effectProjectKeySchema),
      workerSessionID: nativeID,
      originCaptainID: nativeID,
      status: taskStatusSchema,
      /** Every input sent for the task: the assignment first, then resumes. */
      inputIDs: Schema.Array(nativeID).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(maxTaskInputs),
      ),
    }),
  ).check(Schema.isMaxLength(MAX_CREW_CONTEXTS * (settledTasksPerMember + 1))),
});

export type CrewTurns = typeof crewTurnsSchema.Type;

export type CrewTurnsTask = CrewTurns["tasks"][number];

// Git output parsers shared by the crew plugin's and the gateway's readers.

/** `rev-list --left-right --count base...HEAD`; null when malformed. */
export function parseAheadBehind(output: string) {
  const match = /^(\d+)[\t ]+(\d+)$/.exec(output.trim());

  if (!match) {
    return null;
  }

  // The command compares base...HEAD, so the left side is behind.
  const behind = Number(match[1]);
  const ahead = Number(match[2]);

  return Number.isSafeInteger(ahead) && Number.isSafeInteger(behind)
    ? { ahead, behind }
    : null;
}

/** Paths in `git status --porcelain=v1 -z` output; null when malformed. */
export function countChangedPaths(output: string): number | null {
  if (output === "") {
    return 0;
  }

  const entries = output.split("\0");

  if (entries.pop() !== "") {
    return null;
  }

  let count = 0;

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];

    if (!entry || !/^[ MTADRCU?!]{2} .+/s.test(entry)) {
      return null;
    }

    // In porcelain -z, a rename/copy has a second NUL-delimited path.
    if (/^[RC]|^.[RC]/.test(entry) && !entries[++index]) {
      return null;
    }

    count++;
  }

  return count;
}
