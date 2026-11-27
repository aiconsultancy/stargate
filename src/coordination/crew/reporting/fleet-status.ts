import { isAbsolute } from "node:path";
import { Schema } from "effect";
import {
  crewStatusSchema,
  crewStatusSchemaWith,
  crewTaskTextLimit,
} from "../../../shared/crew-status";
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

/**
 * Internal, location-scoped RPC. The Fleet API also shows checkout paths that
 * crew task text contains. `taskText` asks for task text without redaction:
 * `unredacted` within the ordinary 180/80/400 limits, for any filter, or
 * `full`, up to 64,000 code points, for one member. Without it the answer is
 * ordinary, redacted status. Plugins older than the field reject it, and the
 * caller asks again without it.
 */
export const fleetCrewStatusInputSchema = exactStruct({
  member: Schema.optional(agentIDSchema),
  taskText: Schema.optional(Schema.Literals(["unredacted", "full"])),
}).check(
  Schema.makeFilter((input) =>
    input.taskText === "full" && input.member === undefined
      ? { path: ["member"], issue: "Full task text needs one member." }
      : undefined,
  ),
);

export type FleetCrewStatusInput = typeof fleetCrewStatusInputSchema.Type;

/** A member ID the plugin accepts; any other is never sent to it. */
export const isFleetMember = Schema.is(agentIDSchema);

const fullTextStatus = crewStatusSchemaWith({
  summary: crewTaskTextLimit,
  phase: crewTaskTextLimit,
  progress: crewTaskTextLimit,
}).status;

/** Ordinary status, as every caller that does not ask for full text gets it. */
export const fleetCrewStatusSchema = exactStruct({
  status: crewStatusSchema,
  metadata,
});

/** Unredacted task text within the ordinary limits. */
export const fleetCrewUnredactedStatusSchema = exactStruct({
  status: crewStatusSchema,
  metadata,
  taskText: Schema.Literal("unredacted"),
});

/** Raw task text; `taskText` tells the caller it is not redacted. */
export const fleetCrewFullStatusSchema = exactStruct({
  status: fullTextStatus,
  metadata,
  taskText: Schema.Literal("full"),
});

export const fleetCrewStatusOutputSchema = Schema.Union([
  fleetCrewStatusSchema,
  fleetCrewUnredactedStatusSchema,
  fleetCrewFullStatusSchema,
]);

export type FleetCrewStatus = typeof fleetCrewStatusOutputSchema.Type;

/** Local read result, not part of the plugin's RPC protocol. */
export type FleetCrewStatusRead =
  | { kind: "answer"; answer: FleetCrewStatus }
  | { kind: "unsupported"; answer?: FleetCrewStatus }
  | { kind: "unavailable" };

const index = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

const count = Schema.NullOr(index);

const fingerprintSchema = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{32}$/),
);

const oid = Schema.String.check(
  Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
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
  /** Changes with anything a crew diff shows: equal to the diff's own. */
  fingerprint: Schema.optional(fingerprintSchema),
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

/** Limits of one crew diff answer; see docs/api.md. */
export const diffLimits = {
  files: 1000,
  inlinePatch: 64 * 1024,
  listPatches: 4 * 1024 * 1024,
  page: 1024 * 1024,
};

const repositoryPath = Schema.String.check(Schema.isBetweenCodePoints(1, 4096));

export const diffModeSchema = Schema.Literals([
  "branch",
  "committed",
  "working",
]);

export type DiffMode = typeof diffModeSchema.Type;

export const diffSideSchema = Schema.Literals(["old", "new"]);

export type DiffSide = typeof diffSideSchema.Type;

export const checkoutDiffFileSchema = exactStruct({
  path: repositoryPath,
  previousPath: Schema.NullOr(repositoryPath),
  status: Schema.Literals(["added", "removed", "modified", "renamed"]),
  /** Null when binary. */
  additions: count,
  deletions: count,
  untracked: Schema.optional(Schema.Literal(true)),
  binary: Schema.optional(Schema.Literal(true)),
  /** The new side's size, or the old side's for a removed file. */
  size: Schema.optional(index),
  /** Hunks only; a page of them when long. */
  patch: Schema.NullOr(
    Schema.String.check(Schema.isMaxLength(diffLimits.page)),
  ),
  /** The byte offset in the whole patch where the next page starts. */
  patchNext: Schema.optional(index),
  kind: Schema.optional(Schema.Literals(["submodule", "symlink"])),
});

export type CheckoutDiffFile = typeof checkoutDiffFileSchema.Type;

/** Internal RPC: the worktree comes from the plugin's configuration only. */
export const checkoutDiffInputSchema = exactStruct({
  member: agentIDSchema,
  /** Null for the default project. */
  project: Schema.NullOr(effectProjectKeySchema),
  mode: diffModeSchema,
  /** The fingerprint the answer must match; else `stale`. */
  at: Schema.optional(fingerprintSchema),
  request: Schema.Union([
    exactStruct({ kind: Schema.Literal("list"), start: index }),
    exactStruct({
      kind: Schema.Literal("patch"),
      path: repositoryPath,
      offset: index,
    }),
    exactStruct({
      kind: Schema.Literal("content"),
      path: repositoryPath,
      side: Schema.optional(diffSideSchema),
      offset: index,
    }),
  ]),
});

export type CheckoutDiffInput = typeof checkoutDiffInputSchema.Type;

export const checkoutDiffSchema = Schema.Union([
  /** No such member, project or checkout. */
  exactStruct({ kind: Schema.Literal("missing") }),
  /** The checkout no longer matches `at`. */
  exactStruct({
    kind: Schema.Literal("stale"),
    fingerprint: fingerprintSchema,
  }),
  /** Not an entry of this diff, or the entry has no such side. */
  exactStruct({
    kind: Schema.Literal("absent"),
    fingerprint: fingerprintSchema,
  }),
  exactStruct({
    kind: Schema.Literal("list"),
    fingerprint: fingerprintSchema,
    unstable: Schema.Boolean,
    branch: Schema.NullOr(
      Schema.String.check(Schema.isBetweenCodePoints(1, 255)),
    ),
    base: Schema.NullOr(
      exactStruct({
        ref: Schema.String.check(Schema.isBetweenCodePoints(1, 255)),
        commit: oid,
      }),
    ),
    head: Schema.NullOr(oid),
    total: index,
    additions: index,
    deletions: index,
    files: Schema.Array(checkoutDiffFileSchema).check(
      Schema.isMaxLength(diffLimits.files),
    ),
    /** The index in the whole list where the next page starts. */
    next: Schema.NullOr(index),
  }),
  exactStruct({
    kind: Schema.Literal("patch"),
    fingerprint: fingerprintSchema,
    file: checkoutDiffFileSchema,
  }),
  exactStruct({
    kind: Schema.Literal("content"),
    fingerprint: fingerprintSchema,
    file: checkoutDiffFileSchema,
    side: diffSideSchema,
    offset: index,
    size: index,
    data: Schema.String.check(
      Schema.isMaxLength(Math.ceil(diffLimits.page / 3) * 4),
    ),
    next: Schema.NullOr(index),
  }),
]);

export type CheckoutDiff = typeof checkoutDiffSchema.Type;

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

export type StatusEntry = { code: string; path: string; from?: string };

/** Entries of `git status --porcelain=v1 -z` output; null when malformed. */
export function statusEntries(output: string): StatusEntry[] | null {
  if (output === "") {
    return [];
  }

  const records = output.split("\0");

  if (records.pop() !== "") {
    return null;
  }

  const entries: StatusEntry[] = [];

  for (let index = 0; index < records.length; index++) {
    const record = records[index];

    if (!record || !/^[ MTADRCU?!]{2} .+/s.test(record)) {
      return null;
    }

    const entry: StatusEntry = {
      code: record.slice(0, 2),
      path: record.slice(3),
    };

    // In porcelain -z, a rename/copy has a second NUL-delimited path.
    if (/^[RC]|^.[RC]/.test(record)) {
      const from = records[++index];

      if (!from) {
        return null;
      }

      entry.from = from;
    }

    entries.push(entry);
  }

  return entries;
}

/** Paths in `git status --porcelain=v1 -z` output; null when malformed. */
export function countChangedPaths(output: string): number | null {
  return statusEntries(output)?.length ?? null;
}

/** A sequence's length at `at`: 0 when invalid, -1 when cut off by the end. */
function utf8Sequence(bytes: Uint8Array, at: number) {
  const lead = bytes[at] ?? 0;

  if (lead < 0x80) {
    return 1;
  }

  const length =
    lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xf0 && lead <= 0xf4
          ? 4
          : 0;

  for (let offset = 1; offset < length; offset++) {
    if (at + offset >= bytes.length) {
      return -1;
    }

    const next = bytes[at + offset] ?? 0;

    // The second byte's range excludes overlong forms and surrogates.
    const [low, high] =
      offset > 1
        ? [0x80, 0xbf]
        : lead === 0xe0
          ? [0xa0, 0xbf]
          : lead === 0xed
            ? [0x80, 0x9f]
            : lead === 0xf0
              ? [0x90, 0xbf]
              : lead === 0xf4
                ? [0x80, 0x8f]
                : [0x80, 0xbf];

    if (next < low || next > high) {
      return 0;
    }
  }

  return length;
}

/**
 * The longest prefix of `bytes` that decodes to at most `limit` UTF-8 bytes
 * and ends between characters. An invalid byte counts as its replacement
 * character. `final` says that nothing follows `bytes`.
 */
export function utf8Prefix(bytes: Uint8Array, limit: number, final: boolean) {
  let end = 0;
  let size = 0;

  while (end < bytes.length) {
    const length = utf8Sequence(bytes, end);

    if (length < 0 && !final) {
      break;
    }

    const [raw, cost] = length > 0 ? [length, length] : [1, 3];

    if (size + cost > limit) {
      break;
    }

    end += raw;
    size += cost;
  }

  return end;
}
