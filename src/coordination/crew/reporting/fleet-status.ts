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

/** One changed path in `git diff --raw --numstat -z [-p]` output. */
export type DiffEntry = {
  status: string;
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
  path: string;
  previousPath: string | null;
  additions: number | null;
  deletions: number | null;
  /** Bytes of hunks, after the file headers. */
  size: number;
  /** The kept bytes of the hunks, from the planned offset. */
  kept: Buffer[];
  keptBytes: number;
};

/** Bytes of each entry's hunks to keep, by entry index in Git's order. */
export type DiffPlan = Map<number, { from: number; to: number }>;

const rawRecord =
  /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([ACDMRTUX])(\d{0,3})$/;

const numstatRecord = /^(\d+|-)\t(\d+|-)\t/;
const sectionStart = Buffer.from("diff --git ");
const hunkStart = Buffer.from("@@ ");

/**
 * Parse Git's raw, numstat and patch output as it streams, in one pass. Raw
 * and numstat records come first, then a NUL, then one patch section a path;
 * a type change has two. Only the planned hunk bytes are kept.
 */
export class DiffOutputParser {
  public readonly entries: DiffEntry[] = [];
  private header = true;
  private partial: Buffer | undefined;
  private paths:
    | { entry: DiffEntry; left: number; numstat: boolean }
    | undefined;
  private numstat = 0;
  private plan: DiffPlan = new Map();
  private last = -1;
  private current = -1;
  private sectionsLeft = 0;
  private inHunks = false;
  private lineStart = true;
  private stash: Buffer | undefined;
  private stopped = false;

  public constructor(
    private readonly patches: boolean,
    private readonly planner: (entries: DiffEntry[]) => DiffPlan = () =>
      new Map(),
  ) {}

  /** Every planned entry is read and Git was told to stop. */
  public get done() {
    return this.stopped;
  }

  /** False once every planned entry is read: Git may then stop. */
  public feed(chunk: Buffer): boolean {
    let rest = chunk;

    if (this.header) {
      const consumed = this.feedHeader(chunk);

      if (consumed < 0) {
        return true;
      }

      this.header = false;
      this.plan = this.planner(this.entries);
      this.last = Math.max(-1, ...this.plan.keys());
      rest = chunk.subarray(consumed);
    }

    if (!this.stopped) {
      this.feedPatch(rest);
    }

    return !this.stopped;
  }

  /** Check that the output was whole: call when Git exits unstopped. */
  public end() {
    if (this.stopped) {
      return;
    }

    if (this.header) {
      if (this.partial || this.paths) {
        throw new Error("Git diff output ended early");
      }

      if (
        this.numstat !== this.entries.length ||
        (this.patches && this.entries.length > 0)
      ) {
        throw new Error("Git diff output is incomplete");
      }

      return;
    }

    if (this.stash) {
      const stash = this.stash;
      this.stash = undefined;
      this.line(stash, 0, stash.length, false);
    }

    if (this.current !== this.entries.length - 1 || this.sectionsLeft !== 0) {
      throw new Error("Git diff sections do not match its records");
    }
  }

  private feedHeader(chunk: Buffer) {
    let position = 0;

    for (;;) {
      const nul = chunk.indexOf(0, position);

      if (nul === -1) {
        const tail = chunk.subarray(position);

        if (tail.length > 0) {
          this.partial = this.partial
            ? Buffer.concat([this.partial, tail])
            : Buffer.from(tail);
        }

        if ((this.partial?.length ?? 0) > 64 * 1024) {
          throw new Error("Git diff record too long");
        }

        return -1;
      }

      const piece = chunk.subarray(position, nul);
      const token = this.partial ? Buffer.concat([this.partial, piece]) : piece;
      this.partial = undefined;
      position = nul + 1;

      if (this.token(token)) {
        return position;
      }
    }
  }

  /** True at the NUL that ends the records. */
  private token(token: Buffer) {
    const text = token.toString("utf8");

    if (this.paths) {
      const { entry, numstat } = this.paths;
      const left = --this.paths.left;

      if (!text) {
        throw new Error("Empty path in Git diff output");
      }

      if (numstat) {
        if (text !== (left === 1 ? entry.previousPath : entry.path)) {
          throw new Error("Git numstat does not match its raw records");
        }
      } else if (left === 1) {
        entry.previousPath = text;
      } else {
        entry.path = text;
      }

      if (left === 0) {
        this.paths = undefined;
      }

      return false;
    }

    if (!text) {
      if (
        !this.patches ||
        this.entries.length === 0 ||
        this.numstat !== this.entries.length
      ) {
        throw new Error("Unexpected Git diff separator");
      }

      return true;
    }

    const raw = rawRecord.exec(text);

    if (raw) {
      const [
        ,
        oldMode = "",
        newMode = "",
        oldOid = "",
        newOid = "",
        status = "",
      ] = raw;

      if (this.numstat > 0) {
        throw new Error("Raw record after numstat in Git diff output");
      }

      const entry: DiffEntry = {
        status,
        oldMode,
        newMode,
        oldOid,
        newOid,
        path: "",
        previousPath: null,
        additions: null,
        deletions: null,
        size: 0,
        kept: [],
        keptBytes: 0,
      };

      this.entries.push(entry);
      this.paths = {
        entry,
        left: status === "R" || status === "C" ? 2 : 1,
        numstat: false,
      };

      return false;
    }

    const numstat = numstatRecord.exec(text);
    const entry = this.entries[this.numstat++];

    if (!numstat || !entry) {
      throw new Error("Malformed Git diff record");
    }

    const [whole, additions = "", deletions = ""] = numstat;
    entry.additions = additions === "-" ? null : Number(additions);
    entry.deletions = deletions === "-" ? null : Number(deletions);
    const path = text.slice(whole.length);

    if (!path) {
      this.paths = { entry, left: 2, numstat: true };
    } else if (path !== entry.path) {
      throw new Error("Git numstat does not match its raw records");
    }

    return false;
  }

  private feedPatch(chunk: Buffer) {
    let bytes = chunk;

    if (this.stash) {
      bytes = Buffer.concat([this.stash, chunk]);
      this.stash = undefined;
    }

    let position = 0;

    while (position < bytes.length && !this.stopped) {
      const newline = bytes.indexOf(10, position);
      const end = newline === -1 ? bytes.length : newline + 1;

      // Keep a short line start to classify it with the next chunk.
      if (
        this.lineStart &&
        newline === -1 &&
        end - position < sectionStart.length
      ) {
        this.stash = Buffer.from(bytes.subarray(position));

        return;
      }

      this.line(bytes, position, end, newline !== -1);
      position = end;
    }
  }

  private line(bytes: Buffer, start: number, end: number, complete: boolean) {
    if (this.lineStart) {
      if (startsWith(bytes, start, end, sectionStart)) {
        this.section();

        if (this.stopped) {
          return;
        }
      } else if (!this.inHunks && startsWith(bytes, start, end, hunkStart)) {
        this.inHunks = true;
      }
    }

    if (this.inHunks) {
      this.keep(bytes.subarray(start, end));
    }

    this.lineStart = complete;
  }

  private section() {
    if (this.sectionsLeft > 0) {
      this.sectionsLeft--;
    } else {
      this.current++;
      const entry = this.entries[this.current];

      if (!entry) {
        throw new Error("More Git diff sections than records");
      }

      if (this.current > this.last) {
        this.stopped = true;

        return;
      }

      // A type change is a deletion and a creation.
      this.sectionsLeft = entry.status === "T" ? 1 : 0;
    }

    this.inHunks = false;
  }

  private keep(bytes: Buffer) {
    const entry = this.entries[this.current];

    if (!entry) {
      throw new Error("Git diff hunk outside a section");
    }

    const start = entry.size;
    entry.size += bytes.length;
    const window = this.plan.get(this.current);

    if (!window) {
      return;
    }

    const from = Math.max(window.from, start);
    const to = Math.min(window.to, entry.size);

    if (from < to) {
      entry.kept.push(Buffer.from(bytes.subarray(from - start, to - start)));
      entry.keptBytes += to - from;
    }
  }
}

function startsWith(bytes: Buffer, start: number, end: number, prefix: Buffer) {
  return (
    end - start >= prefix.length &&
    bytes.compare(prefix, 0, prefix.length, start, start + prefix.length) === 0
  );
}
