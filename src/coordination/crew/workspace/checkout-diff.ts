import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, stat, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type CheckoutDiff,
  type CheckoutDiffFile,
  type CheckoutDiffInput,
  type DiffEntry,
  DiffOutputParser,
  type DiffPlan,
  type DiffSide,
  diffLimits,
  utf8Prefix,
} from "../reporting/fleet-status";
import {
  type CheckoutGit,
  type Git,
  type Head,
  type Origin,
  type StatusPaths,
  fingerprintOf,
  gitUnavailable,
  name,
  output,
} from "./git-state";
import {
  type IsolatedCheckout,
  type IsolatedStream,
  WorktreeChanged,
  readWorktree,
  worktreeSize,
} from "./git-status";

// Crew diffs, computed as the captain on request: never on a poll.

const fileError = (error: unknown) =>
  error instanceof Error && "code" in error ? error.code : undefined;

const renameLimit = 1000;
const zeroMode = "000000";
const gitlinkMode = "160000";
const symlinkMode = "120000";

type Snapshot = {
  fingerprint: string;
  head: Head;
  origin: Origin | null;
  /**
   * Untracked paths keyed by the bytes Git wrote, one latin1 character per
   * byte, so two names that decode alike stay two. Each keeps the decoded
   * path readers see; `nested` marks a nested repository, shown as `dir/`.
   */
  untracked: Map<string, { path: string; nested: boolean }>;
};

/** A path's raw bytes as a key, one latin1 character per byte. */
const byteKey = (bytes: Buffer) => bytes.toString("latin1");

/** A Git diff entry, or an untracked path Git is not asked to index. */
type PassEntry = DiffEntry & { unindexed?: true };

/** Each `??` entry, keyed by its path's raw bytes. */
function untrackedOf(entries: StatusPaths[]) {
  const untracked: Snapshot["untracked"] = new Map();

  for (const { code, path, bytes } of entries) {
    if (code === "??") {
      const nested = path.endsWith("/");

      untracked.set(byteKey(nested ? bytes.subarray(0, -1) : bytes), {
        path: nested ? path.slice(0, -1) : path,
        nested,
      });
    }
  }

  return untracked;
}

/** HEAD, the fingerprint and untracked paths, sampled while HEAD stays put. */
async function snapshot(git: Git, directory: string): Promise<Snapshot> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const guarded = await git.guard(async (head) => {
      const read = await fingerprintOf(git, directory, head);

      if (!read.fingerprint) {
        throw new Error(gitUnavailable);
      }

      return {
        fingerprint: read.fingerprint,
        head,
        origin: read.origin,
        untracked: untrackedOf(read.entries),
      };
    });

    if (guarded.kind === "sample") {
      return guarded.value;
    }
  }

  throw new Error("Git HEAD keeps moving");
}

const statuses: Partial<Record<string, CheckoutDiffFile["status"]>> = {
  A: "added",
  D: "removed",
  R: "renamed",
};

/** Git's status letter; `-M` without `-C` never reports a copy. */
const diffStatus = (entry: DiffEntry) => statuses[entry.status] ?? "modified";

function describe(
  entry: DiffEntry,
  untracked: Snapshot["untracked"],
  size: number | undefined,
): CheckoutDiffFile {
  const mode = entry.status === "D" ? entry.oldMode : entry.newMode;

  const kind =
    entry.oldMode === gitlinkMode || entry.newMode === gitlinkMode
      ? ("submodule" as const)
      : mode === symlinkMode
        ? ("symlink" as const)
        : undefined;

  return {
    path: entry.path,
    previousPath: entry.status === "R" ? entry.previousPath : null,
    status: diffStatus(entry),
    additions: entry.additions,
    deletions: entry.deletions,
    ...(untracked.has(byteKey(entry.pathBytes)) && {
      untracked: true as const,
    }),
    ...(entry.additions === null && { binary: true as const }),
    ...(size !== undefined && { size }),
    patch: null,
    ...(kind && { kind }),
  };
}

/** One page of an entry's hunks from `offset`, cut between characters. */
function patchPage(entry: DiffEntry, offset: number, limit: number) {
  const bytes = Buffer.concat(entry.kept);
  const end = utf8Prefix(bytes, limit, offset + entry.keptBytes >= entry.size);
  const next = offset + end;

  return {
    patch: bytes.subarray(0, end).toString("utf8"),
    ...(next < entry.size && { patchNext: next }),
  };
}

/** Byte order, as Git sorts paths. */
const byPath = (entries: DiffEntry[]) =>
  entries
    .map((entry, index) => ({ key: entry.pathBytes, index }))
    .toSorted((a, b) => Buffer.compare(a.key, b.key))
    .map(({ index }) => index);

/** Windows of a whole stream's output, stopping Git once it has them. */
async function capture(
  stream: IsolatedStream,
  args: string[],
  from: number,
  length: number,
) {
  const kept: Buffer[] = [];
  let seen = 0;
  let keptBytes = 0;

  const code = await stream(args, {}, (chunk) => {
    const start = Math.max(from, seen);
    const end = Math.min(from + length, seen + chunk.length);

    if (start < end) {
      kept.push(Buffer.from(chunk.subarray(start - seen, end - seen)));
      keptBytes += end - start;
    }

    seen += chunk.length;

    return keptBytes < length;
  });

  if (code !== 0 && keptBytes < length) {
    throw new Error(gitUnavailable);
  }

  return Buffer.concat(kept);
}

/** New-side sizes from the worktree; others from the object store. */
async function sizes(
  stream: IsolatedStream,
  directory: string,
  worktree: boolean,
  entries: PassEntry[],
) {
  const result: (number | undefined)[] = [];
  const blobs: { index: number; oid: string }[] = [];

  for (const [index, entry] of entries.entries()) {
    const removed = entry.newMode === zeroMode;

    if (opaque(entry)) {
      continue;
    }

    if (worktree && !removed) {
      // Never through a linked directory, which may lead out of the checkout.
      result[index] = await worktreeSize(directory, entry.pathBytes).catch(
        (): undefined => {},
      );
    } else {
      blobs.push({ index, oid: removed ? entry.oldOid : entry.newOid });
    }
  }

  if (blobs.length > 0) {
    let text = "";

    const code = await stream(
      ["cat-file", "--batch-check=%(objectsize)"],
      {},
      (chunk) => {
        text += chunk.toString("utf8");

        return true;
      },
      blobs.map(({ oid }) => `${oid}\n`).join(""),
    );

    const lines = text.split("\n");

    if (code !== 0 || lines.length !== blobs.length + 1) {
      throw new Error(gitUnavailable);
    }

    for (const [position, { index }] of blobs.entries()) {
      const line = lines[position] ?? "";
      result[index] = /^\d+$/.test(line) ? Number(line) : undefined;
    }
  }

  return result;
}

/**
 * Git failed the intent-to-add step outright. A path may have gone since the
 * snapshot, so the next snapshot decides whether this is a change.
 */
class IntentFailed extends Error {
  public constructor() {
    super("Untracked files unavailable");
  }
}

/**
 * Index a copy of the checkout's index with untracked files as intent-to-add.
 * A nested repository never reaches Git: some versions index it as a gitlink
 * that `git diff` then cannot read, and Git never runs inside it.
 */
async function intentIndex(
  checkout: IsolatedCheckout,
  stream: IsolatedStream,
  untracked: Snapshot["untracked"],
) {
  const index = join(checkout.gitDir, "index");
  const objects = join(checkout.gitDir, "objects");
  await mkdir(join(objects, "info"), { recursive: true });
  await mkdir(join(objects, "pack"));

  const copied = await copyFile(checkout.index, index).then(
    () => true,
    (error: unknown) => {
      // An unborn checkout with nothing staged has no index yet.
      if (fileError(error) !== "ENOENT") {
        throw error;
      }

      return false;
    },
  );

  // The copy keeps the index's time, so a file changed in the same tick
  // As the index is still compared by content, never taken as clean.
  if (copied) {
    const { atime, mtime } = await stat(checkout.index);
    await utimes(index, atime, mtime);
  }

  // A split index names a shared index, which Git reads from its own
  // Directory: copy it there, so nothing touches the checkout's.
  const shared = dirname(checkout.index);

  for (const name of await readdir(shared)) {
    if (/^sharedindex\.(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(name)) {
      await copyFile(join(shared, name), join(checkout.gitDir, name));
    }
  }

  // Any object goes to the private store; the checkout's is read-only here.
  const env = {
    GIT_INDEX_FILE: index,
    GIT_OBJECT_DIRECTORY: objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: checkout.objects,
  };

  const files = new Set(
    [...untracked].flatMap(([bytes, { nested }]) => (nested ? [] : [bytes])),
  );

  const unindexed = (indexed: Set<string>) => ({
    env,
    unindexed: refused(untracked, indexed, checkout.format),
  });

  if (files.size === 0) {
    return unindexed(files);
  }

  // Status's own bytes: a path need not be valid UTF-8.
  const paths = Buffer.from(
    [...files].map((path) => `${path}\0`).join(""),
    "latin1",
  );

  const add = checkout.command([
    "-c",
    "core.splitIndex=false",
    "add",
    "--intent-to-add",
    "--ignore-errors",
    "--pathspec-from-file=-",
    "--pathspec-file-nul",
  ]);

  // Status's own paths, literally: `*` or a leading `:` is no pattern.
  const code = await stream(
    add.args,
    { ...add.env, ...env, GIT_LITERAL_PATHSPECS: "1" },
    () => true,
    paths,
  );

  if (code === 0) {
    return unindexed(files);
  }

  // 128 indexed nothing; the caller's next snapshot tells whether it moved.
  if (code === 128) {
    throw new IntentFailed();
  }

  // 1 means Git refused some paths, such as `.GIT/…`, and indexed the rest;
  // Anything else indexed nothing.
  if (code !== 1) {
    throw new Error("Untracked files unavailable");
  }

  // Which were refused: ls-files takes no path list, so read the index.
  const indexed = new Set<string>();
  const read = checkout.command(["ls-files", "-z", "--cached"]);
  let rest = Buffer.alloc(0);

  const listed = await stream(read.args, { ...read.env, ...env }, (chunk) => {
    rest = Buffer.concat([rest, chunk]);

    for (let nul = rest.indexOf(0); nul >= 0; nul = rest.indexOf(0)) {
      // Matched by bytes, as the untracked paths are keyed.
      const path = rest.subarray(0, nul).toString("latin1");
      rest = rest.subarray(nul + 1);

      if (files.has(path)) {
        indexed.add(path);
      }
    }

    return true;
  });

  if (listed !== 0) {
    throw new Error("Untracked files unavailable");
  }

  return unindexed(indexed);
}

/**
 * Untracked paths outside Git's index: nested repositories, and files Git
 * refused. Each is listed all the same, with neither patch nor content:
 * nothing status shows is left out (SUB-70).
 */
function refused(
  untracked: Snapshot["untracked"],
  indexed: Set<string>,
  format: IsolatedCheckout["format"],
): PassEntry[] {
  const none = "0".repeat(format === "sha256" ? 64 : 40);

  return [...untracked].flatMap(([bytes, { path, nested }]): PassEntry[] =>
    !nested && indexed.has(bytes)
      ? []
      : [
          {
            status: "A",
            oldMode: zeroMode,
            // A nested repository is a submodule to be.
            newMode: nested ? gitlinkMode : "100644",
            oldOid: none,
            newOid: none,
            path,
            pathBytes: Buffer.from(bytes, "latin1"),
            previousPath: null,
            additions: 0,
            deletions: 0,
            size: 0,
            kept: [],
            keptBytes: 0,
            unindexed: true,
          },
        ],
  );
}

type Pass = {
  directory: string;
  entries: PassEntry[];
  snapshot: Snapshot;
  base: Origin | null;
  stream: IsolatedStream;
  worktree: boolean;
};

/**
 * Run Git's diff once for the mode, then build the answer from it. With a
 * planner, patches are read too, keeping the windows it plans.
 */
async function diffPass<T>(
  git: Git,
  directory: string,
  mode: CheckoutDiffInput["mode"],
  state: Snapshot,
  build: (pass: Pass) => Promise<T>,
  planner?: (entries: PassEntry[]) => DiffPlan,
) {
  const patches = planner !== undefined;
  const head = state.head.oid;
  let base: Origin | null = null;

  if (head && state.origin) {
    const result = await git.command(["merge-base", state.origin.commit, head]);

    const commit = result?.stdout.trim() ?? "";

    if (result?.code === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
      base = { ref: state.origin.ref, commit };
    } else if (!(result?.code === 1 && commit === "")) {
      throw new Error(gitUnavailable);
    }
  }

  return git.isolated(head, async (checkout, stream) => {
    const empty = createHash(checkout.format).update("tree 0\0").digest("hex");
    const worktree = mode !== "committed";
    const old = mode === "working" ? (head ?? empty) : (base?.commit ?? empty);

    const { env, unindexed } = worktree
      ? await intentIndex(checkout, stream, state.untracked)
      : { env: {}, unindexed: [] };

    // Git's entries, then the untracked paths outside its index.
    const all = (entries: DiffEntry[]): PassEntry[] => [
      ...entries,
      ...unindexed,
    ];

    // Only Git's own entries have hunks to plan.
    const parser = new DiffOutputParser(
      patches,
      planner &&
        ((entries) =>
          new Map(
            [...planner(all(entries))].filter(
              ([index]) => index < entries.length,
            ),
          )),
    );

    const diff = checkout.command([
      "diff",
      "--raw",
      "--numstat",
      ...(patches ? ["-p"] : []),
      "-z",
      "--no-abbrev",
      "-M",
      `-l${renameLimit}`,
      "--ignore-submodules=dirty",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-relative",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      old,
      ...(worktree ? [] : [head ?? empty]),
      "--",
    ]);

    const code = await stream(diff.args, { ...diff.env, ...env }, (chunk) =>
      parser.feed(chunk),
    );

    if (!parser.done && code !== 0) {
      throw new Error(gitUnavailable);
    }

    parser.end();

    return build({
      directory,
      entries: all(parser.entries),
      snapshot: state,
      base,
      stream,
      worktree,
    });
  });
}

async function listPage(
  pass: Pass,
  start: number,
  order: number[],
): Promise<CheckoutDiff> {
  const { entries, snapshot: state } = pass;
  const page = order.slice(start, start + diffLimits.files);
  const files: { entry: DiffEntry; file: CheckoutDiffFile }[] = [];
  let used = 0;

  for (const index of page) {
    const entry = entries[index];

    if (!entry) {
      continue;
    }

    const patch =
      entry.size > 0 ? patchPage(entry, 0, diffLimits.inlinePatch) : undefined;

    const bytes = Buffer.byteLength(patch?.patch ?? "");

    // End the page before the file that would pass its budget.
    if (files.length > 0 && used + bytes > diffLimits.listPatches) {
      break;
    }

    used += bytes;
    files.push({
      entry,
      file: { ...describe(entry, state.untracked, undefined), ...patch },
    });
  }

  const sized = await sizes(
    pass.stream,
    pass.directory,
    pass.worktree,
    files.map(({ entry }) => entry),
  );

  const next = start + files.length;

  const total = (pick: "additions" | "deletions") =>
    entries.reduce((sum, entry) => sum + (entry[pick] ?? 0), 0);

  return {
    kind: "list",
    fingerprint: state.fingerprint,
    unstable: false,
    branch: name(
      state.head.ref?.startsWith("refs/heads/")
        ? state.head.ref.slice("refs/heads/".length)
        : null,
    ),
    base: pass.base,
    head: state.head.oid,
    total: entries.length,
    additions: total("additions"),
    deletions: total("deletions"),
    files: files.map(({ file }, index) => {
      const size = sized[index];

      return size === undefined ? file : { ...file, size };
    }),
    next: next < entries.length ? next : null,
  };
}

/** A page of a blob from the object store. */
async function readBlob(
  git: Git,
  stream: IsolatedStream,
  oid: string,
  offset: number,
) {
  const size = Number(
    (await output(git, ["cat-file", "-s", oid]))?.trim() ?? "",
  );

  if (!Number.isSafeInteger(size)) {
    throw new Error(gitUnavailable);
  }

  if (offset > size) {
    return;
  }

  const length = Math.min(diffLimits.page, size - offset);

  const data =
    length === 0
      ? Buffer.alloc(0)
      : await capture(stream, ["cat-file", "blob", oid], offset, length);

  return { size, data };
}

const isSubmodule = (entry: DiffEntry) =>
  entry.oldMode === gitlinkMode || entry.newMode === gitlinkMode;

/** No bytes of its own: a submodule, or a path Git would not index. */
const opaque = (entry: PassEntry) =>
  entry.unindexed === true || isSubmodule(entry);

/** A page of one side's bytes: a worktree file, a link's text or a blob. */
async function contentPage(
  git: Git,
  pass: Pass,
  entry: PassEntry,
  requested: DiffSide | undefined,
  offset: number,
): Promise<CheckoutDiff> {
  const { snapshot: state, directory } = pass;
  const absent = { kind: "absent" as const, fingerprint: state.fingerprint };
  const side = requested ?? (entry.status === "D" ? "old" : "new");

  // An opaque entry has no bytes of its own; an added file has no old side.
  if (
    (side === "old" ? entry.oldMode : entry.newMode) === zeroMode ||
    opaque(entry)
  ) {
    return absent;
  }

  const page =
    side === "new" && pass.worktree
      ? await readWorktree(directory, entry.pathBytes, offset, diffLimits.page)
      : await readBlob(
          git,
          pass.stream,
          side === "old" ? entry.oldOid : entry.newOid,
          offset,
        );

  if (!page) {
    return absent;
  }

  const [size] = await sizes(pass.stream, directory, pass.worktree, [entry]);
  const end = offset + page.data.length;

  return {
    kind: "content",
    fingerprint: state.fingerprint,
    file: describe(entry, state.untracked, size),
    side,
    offset,
    size: page.size,
    data: page.data.toString("base64"),
    next: end < page.size ? end : null,
  };
}

function computeDiff(
  git: Git,
  directory: string,
  input: CheckoutDiffInput,
  state: Snapshot,
): Promise<CheckoutDiff> {
  const { request, mode } = input;
  const absent = { kind: "absent" as const, fingerprint: state.fingerprint };

  if (request.kind === "list") {
    const window = { from: 0, to: diffLimits.inlinePatch + 4 };

    return diffPass(
      git,
      directory,
      mode,
      state,
      async (pass) =>
        request.start > 0 && request.start >= pass.entries.length
          ? absent
          : listPage(pass, request.start, byPath(pass.entries)),
      (entries) =>
        new Map(
          byPath(entries)
            .slice(request.start, request.start + diffLimits.files)
            .map((index) => [index, window]),
        ),
    );
  }

  const find = (entries: DiffEntry[]) =>
    entries.findIndex((entry) => entry.path === request.path);

  if (request.kind === "patch") {
    let target = -1;

    return diffPass(
      git,
      directory,
      mode,
      state,
      async (pass) => {
        const entry = pass.entries[target];

        if (
          !entry ||
          request.offset > entry.size ||
          (request.offset === entry.size && entry.size > 0)
        ) {
          return absent;
        }

        // Without hunks, such as a binary file, the file's bytes answer.
        if (entry.size === 0 && !opaque(entry)) {
          return contentPage(git, pass, entry, undefined, 0);
        }

        const [size] = await sizes(pass.stream, directory, pass.worktree, [
          entry,
        ]);

        const file = describe(entry, state.untracked, size);

        return {
          kind: "patch",
          fingerprint: state.fingerprint,
          file:
            entry.size === 0
              ? file
              : {
                  ...file,
                  ...patchPage(entry, request.offset, diffLimits.page),
                },
        };
      },
      (entries) => {
        target = find(entries);

        return new Map(
          target < 0
            ? []
            : [
                [
                  target,
                  {
                    from: request.offset,
                    to: request.offset + diffLimits.page + 4,
                  },
                ],
              ],
        );
      },
    );
  }

  return diffPass(git, directory, mode, state, async (pass) => {
    const entry = pass.entries[find(pass.entries)];

    return entry
      ? contentPage(git, pass, entry, request.side, request.offset)
      : absent;
  });
}

export type CheckoutDiffReader = (
  directory: string,
  input: CheckoutDiffInput,
  signal: AbortSignal,
) => Promise<CheckoutDiff>;

/**
 * Crew diffs read as the captain. The fingerprint is sampled before and
 * after: when it moves, the diff is computed once more, then a list is
 * marked unstable and anything pinned to `at` is stale.
 */
export function createCheckoutDiffReader(
  open: CheckoutGit,
): CheckoutDiffReader {
  return async (directory, input, signal) => {
    try {
      if (!(await stat(directory)).isDirectory()) {
        throw new Error(gitUnavailable);
      }
    } catch (error) {
      if (fileError(error) === "ENOENT") {
        return { kind: "missing" };
      }

      throw error;
    }

    const git = open(directory, signal);

    const top = await git.command([
      "rev-parse",
      "--is-inside-work-tree",
      "--show-prefix",
    ]);

    if (!top) {
      throw new Error(gitUnavailable);
    }

    // Not a checkout's top level: crew Git state reports no checkout here.
    if (top.code !== 0 || top.stdout !== "true\n\n") {
      return { kind: "missing" };
    }

    let state = await snapshot(git, directory);

    for (let attempt = 0; ; attempt++) {
      if (input.at !== undefined && state.fingerprint !== input.at) {
        return { kind: "stale", fingerprint: state.fingerprint };
      }

      // A file that shrank while read, or one gone before the intent-to-add
      // Step, is a change like any other: the next snapshot shows it.
      const result = await computeDiff(git, directory, input, state).catch(
        (error: unknown) => {
          if (
            error instanceof WorktreeChanged ||
            error instanceof IntentFailed
          ) {
            return error;
          }

          throw error;
        },
      );

      const after = await snapshot(git, directory);

      if (after.fingerprint === state.fingerprint) {
        if (result instanceof IntentFailed) {
          throw result;
        }

        if (!(result instanceof WorktreeChanged)) {
          return result;
        }
      }

      if (attempt > 0) {
        return !(result instanceof Error) &&
          result.kind === "list" &&
          input.at === undefined
          ? { ...result, unstable: true }
          : { kind: "stale", fingerprint: after.fingerprint };
      }

      state = after;
    }
  };
}
