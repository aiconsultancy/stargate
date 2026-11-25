import { isAbsolute } from "node:path";
import { Schema } from "effect";
import { crewStatusSchema } from "../../../shared/crew-status";
import { HISTORY_PAGE, exactStruct } from "../../../shared/session-history";
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
