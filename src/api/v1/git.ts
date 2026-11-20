import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import {
  copyFile,
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Semaphore } from "effect";
import { containsCredential } from "../../credentials";
import { abortable, runAbortable } from "../../effect";
import { readWithDeadline } from "../../read-deadline";
import { readCommand } from "./command";
import { githubRepository, isGitHubRepositoryName } from "./github-repository";
import type { V1Git } from "./types";

const ttl = 15_000;
const timeout = 2_000;
const statusDirectoryName = "stargate-git-status";
const statusDirectoryPrefix = `${statusDirectoryName}-`;
const staleDirectoryAge = 24 * 60 * 60_000;
const mib = 1024 * 1024;
const indexLimit = 128 * mib;
const patternsLimit = mib;
const metadataLimit = 192 * mib;

class MetadataLimitExceeded extends Error {}

// Kept in their own module so config.ts can validate repository names without
// pulling this file, which looks up its own location, into the crew plugin's
// digest.
export { githubRepository, isGitHubRepositoryName };

export function parseAheadBehind(output: string) {
  const match = /^(\d+)[\t ]+(\d+)$/.exec(output.trim());
  if (!match) return null;
  // The command compares base...HEAD, so the left side is behind.
  const behind = Number(match[1]);
  const ahead = Number(match[2]);
  return Number.isSafeInteger(ahead) && Number.isSafeInteger(behind)
    ? { ahead, behind }
    : null;
}

export function countChangedPaths(output: string): number | null {
  if (output === "") return 0;
  const entries = output.split("\0");
  if (entries.pop() !== "") return null;
  let count = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry || !/^[ MTADRCU?!]{2} .+/s.test(entry)) return null;
    // In porcelain -z, a rename/copy has a second NUL-delimited path.
    if (/^[RC]|^.[RC]/.test(entry) && !entries[++index]) return null;
    count++;
  }
  return count;
}

const safeRef = (ref: string) =>
  ref.length <= 255 && !containsCredential(ref) ? ref : null;

const statusSettings =
  /^(core\.(filemode|ignorecase|symlinks|precomposeunicode|autocrlf|eol|sparsecheckout|sparsecheckoutcone|checkstat|trustctime|ignorestat)|(diff|status)\.renames)$/;

function statusOptions(output: string) {
  const options: string[] = [];
  for (const entry of output.split("\0")) {
    if (!entry) continue;
    const [key, value = "true", ...rest] = entry.split("\n");
    if (key && statusSettings.test(key) && !rest.length)
      options.push("-c", `${key}=${value}`);
  }
  return options;
}

const metadataFlags =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function fileError(error: unknown) {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

async function openStatusFile(source: string, roots: string[]) {
  // Resolve links first, then prevent the open from following a replacement
  // symlink in any component of the canonical path.
  const path = await realpath(source);
  if (
    !roots.some((root) => {
      const child = relative(root, path);
      return (
        child &&
        child !== ".." &&
        !child.startsWith(`..${sep}`) &&
        !isAbsolute(child)
      );
    })
  )
    return undefined;
  if (process.platform === "darwin") {
    const noFollowAny = 0x20000000; // Darwin O_NOFOLLOW_ANY
    return open(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollowAny);
  }
  if (process.platform !== "linux") return undefined;
  // Linux exposes directory descriptors through procfs. Open each component
  // relative to its pinned parent, forbidding symlinks at each step.
  const parts = path.split(sep).slice(1);
  const name = parts.pop();
  if (!name) return undefined;
  const directoryFlags = metadataFlags | constants.O_DIRECTORY;
  let parent = await open(sep, directoryFlags);
  try {
    for (const part of parts) {
      const next = await open(
        `/proc/self/fd/${parent.fd}/${part}`,
        directoryFlags,
      );
      await parent.close();
      parent = next;
    }
    return await open(`/proc/self/fd/${parent.fd}/${name}`, metadataFlags);
  } finally {
    await parent.close();
  }
}

async function cloneIndex(file: FileHandle, target: string) {
  if (process.platform !== "linux") return false;
  // Clone the already-open file. Reopening its checkout path would race a
  // replacement between the size check and clone.
  return copyFile(
    `/proc/self/fd/${file.fd}`,
    target,
    constants.COPYFILE_FICLONE_FORCE,
  ).then(
    () => true,
    () => false,
  );
}

async function copyStatusFile(
  openSource: () => Promise<FileHandle | undefined>,
  target: string,
  signal: AbortSignal,
  limit: number,
  budget: { remaining: number },
  kind: "primary" | "shared" | "pattern",
) {
  signal.throwIfAborted();
  const file = await openSource().catch((error: unknown) => {
    signal.throwIfAborted();
    if (
      kind === "pattern" ||
      (kind === "primary" && fileError(error) === "ENOENT")
    )
      return undefined;
    throw error;
  });
  if (!file) return false;
  let copied = 0;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) {
      if (kind === "pattern") return false;
      throw new Error("Git metadata unavailable");
    }
    if (metadata.size > limit || metadata.size > budget.remaining)
      throw new MetadataLimitExceeded();
    if (kind !== "pattern" && (await cloneIndex(file, target))) {
      const { size } = await stat(target);
      if (size > limit || size > budget.remaining)
        throw new MetadataLimitExceeded();
      budget.remaining -= size;
    } else {
      // Larger blocks avoid a read and write round trip for each 64 KiB of index.
      const highWaterMark = limit === indexLimit ? mib : 64 * 1024;
      await pipeline(
        file.createReadStream({ autoClose: false, highWaterMark }),
        async function* (chunks: AsyncIterable<Buffer>) {
          let remaining = limit;
          for await (const chunk of chunks) {
            signal.throwIfAborted();
            remaining -= chunk.byteLength;
            budget.remaining -= chunk.byteLength;
            copied += chunk.byteLength;
            if (remaining < 0 || budget.remaining < 0)
              throw new MetadataLimitExceeded();
            yield chunk;
          }
        },
        createWriteStream(target, { highWaterMark }),
        { signal },
      );
    }
    signal.throwIfAborted();
    // Git uses the index mtime to decide which same-timestamp files to rehash.
    // Round down so the copy can never make a racy entry appear older.
    await utimes(target, metadata.atime, Math.floor(metadata.mtimeMs / 1_000));
    return true;
  } catch (error) {
    signal.throwIfAborted();
    if (kind !== "pattern" || error instanceof MetadataLimitExceeded)
      throw error;
    await rm(target, { force: true });
    budget.remaining += copied;
    return false;
  } finally {
    await file.close();
  }
}

type RunGit = (...args: string[]) => Promise<{ code: number; stdout: string }>;

async function privateStatusDirectory(path: string) {
  const metadata = await lstat(path).catch(() => undefined);
  if (
    metadata?.isDirectory() &&
    (metadata.mode & 0o777) === 0o700 &&
    metadata.uid === process.getuid?.()
  )
    return metadata;
  return undefined;
}

async function createStatusDirectory(
  checkout: string,
  dataDirectory?: string,
  temporaryDirectory: () => string = tmpdir,
) {
  const root = await realpath(checkout);
  // The private snapshot would appear as untracked files inside the worktree.
  const outsideCheckout = (path: string) => {
    const child = relative(root, path);
    return child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child);
  };
  // The chosen root and its ancestors must be protected from replacement by
  // other users. A sticky world-writable root such as /tmp is fine.
  const create = async (directory: string) => {
    const parent = join(await realpath(directory), statusDirectoryName);
    if (!outsideCheckout(parent)) return undefined;
    await mkdir(parent, { mode: 0o700 }).catch((error: unknown) => {
      if (fileError(error) !== "EEXIST") throw error;
    });
    if (!(await privateStatusDirectory(parent))) return undefined;
    const canonical = await realpath(parent);
    return outsideCheckout(canonical)
      ? mkdtemp(join(canonical, statusDirectoryPrefix))
      : undefined;
  };
  if (dataDirectory) {
    try {
      const path = await create(dataDirectory);
      if (path) return path;
    } catch (error) {
      if (
        !["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EROFS"].includes(
          String(fileError(error)),
        )
      )
        throw error;
    }
  }
  const path = await create(temporaryDirectory());
  if (!path)
    throw new Error("No private Git status directory outside checkout");
  return path;
}

async function removeStatusDirectory(path: string) {
  await rm(path, { recursive: true, force: true }).catch(() => {});
}

async function sweepStatusDirectories(root: string) {
  const canonical = await realpath(root).catch(() => undefined);
  if (!canonical) return;
  const directory = join(canonical, statusDirectoryName);
  if (!(await privateStatusDirectory(directory))) return;
  const cutoff = Date.now() - staleDirectoryAge;
  const names = await readdir(directory).catch(() => []);
  for (const name of names) {
    if (
      !name.startsWith(statusDirectoryPrefix) ||
      !/^[a-z\d]{6}$/i.test(name.slice(statusDirectoryPrefix.length))
    )
      continue;
    const path = join(directory, name);
    const metadata = await privateStatusDirectory(path);
    if (metadata && metadata.mtimeMs < cutoff)
      await removeStatusDirectory(path);
  }
}

async function readSharedIndexName(
  gitDir: string,
  format: "sha1" | "sha256",
  signal: AbortSignal,
  command: typeof readCommand,
) {
  signal.throwIfAborted();
  const result = await command(
    [
      process.execPath,
      "--no-env-file",
      "--config=/dev/null",
      join(import.meta.dir, "git-index.ts"),
      join(gitDir, "index"),
      format,
    ],
    { cwd: gitDir, env: {}, timeout, signal },
  );
  signal.throwIfAborted();
  if (result?.code !== 0) throw new Error("Invalid Git index");
  const name = result.stdout;
  if (!name) return undefined;
  if (
    !/^sharedindex\.[a-f0-9]+$/.test(name) ||
    name.length !== "sharedindex.".length + (format === "sha1" ? 40 : 64)
  )
    throw new Error("Invalid Git index");
  return name;
}

async function prepareStatus(
  directory: string,
  head: string | undefined,
  signal: AbortSignal,
  run: RunGit,
  runWithEnv: (env: NodeJS.ProcessEnv, ...args: string[]) => ReturnType<RunGit>,
  command: typeof readCommand,
  ownDirectory: (path: string) => void,
  dataDirectory?: string,
  temporaryDirectory?: () => string,
) {
  const [paths, settings, excludes] = await Promise.all([
    run(
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
      "--git-path",
      "index",
      "--git-path",
      "info/exclude",
      "--git-path",
      "info/sparse-checkout",
      "--absolute-git-dir",
      "--git-common-dir",
      "--show-object-format",
    ),
    run("config", "--null", "--get-regexp", statusSettings.source),
    runWithEnv(
      { HOME: homedir() },
      "config",
      "--null",
      "--path",
      "--get",
      "core.excludesFile",
    ),
  ]);
  const [
    objects,
    index,
    exclude,
    sparse,
    checkoutGit,
    commonGit,
    format,
    ...rest
  ] = paths.stdout.trimEnd().split("\n");
  const [excludesPath, terminator, ...extraExcludes] =
    excludes.stdout.split("\0");
  if (
    paths.code !== 0 ||
    (settings.code !== 0 && !(settings.code === 1 && !settings.stdout)) ||
    !objects ||
    !isAbsolute(objects) ||
    !index ||
    !isAbsolute(index) ||
    !exclude ||
    !isAbsolute(exclude) ||
    !sparse ||
    !isAbsolute(sparse) ||
    !checkoutGit ||
    !isAbsolute(checkoutGit) ||
    !commonGit ||
    !isAbsolute(commonGit) ||
    (format !== "sha1" && format !== "sha256") ||
    rest.length
  )
    throw new Error("Git metadata unavailable");

  // Status only sees this repository's config, HEAD, index and object store.
  // Never copy executable settings, hooks, info/attributes or a commondir.
  const gitDir = await createStatusDirectory(
    directory,
    dataDirectory,
    temporaryDirectory,
  );
  ownDirectory(gitDir);
  signal.throwIfAborted();
  const configuredExcludes =
    excludes.code === 0 &&
    terminator === "" &&
    !extraExcludes.length &&
    excludesPath &&
    resolve(directory, excludesPath);
  const copiedExcludes = "info/configured-excludes";
  const budget = { remaining: metadataLimit };
  const roots = await Promise.all(
    [directory, checkoutGit, commonGit].map((path) => realpath(path)),
  );
  const snapshotIndex = (
    source: string,
    target: string,
    kind: "primary" | "shared",
  ) =>
    copyStatusFile(
      async () => {
        const file = await openStatusFile(source, roots);
        if (!file) throw new Error("Git metadata unavailable");
        return file;
      },
      join(gitDir, target),
      signal,
      indexLimit,
      budget,
      kind,
    );
  await mkdir(join(gitDir, "objects", "info"), { recursive: true });
  await mkdir(join(gitDir, "info"));
  await mkdir(join(gitDir, "refs"));
  if (await snapshotIndex(index, "index", "primary")) {
    const shared = await readSharedIndexName(gitDir, format, signal, command);
    if (shared)
      await snapshotIndex(join(dirname(index), shared), shared, "shared");
  }
  const snapshotPattern = (source: string, target: string) =>
    copyStatusFile(
      () => openStatusFile(source, roots),
      join(gitDir, target),
      signal,
      patternsLimit,
      budget,
      "pattern",
    );
  const files = await Promise.allSettled([
    writeFile(
      join(gitDir, "HEAD"),
      head ? `${head}\n` : "ref: refs/heads/unborn\n",
    ),
    writeFile(
      join(gitDir, "config"),
      format === "sha256"
        ? "[core]\nrepositoryformatversion = 1\n[extensions]\nobjectformat = sha256\n"
        : "[core]\nrepositoryformatversion = 0\n",
    ),
    writeFile(join(gitDir, "objects", "info", "alternates"), `${objects}\n`),
    snapshotPattern(exclude, "info/exclude"),
    snapshotPattern(sparse, "info/sparse-checkout"),
    configuredExcludes && snapshotPattern(configuredExcludes, copiedExcludes),
  ]);
  for (const file of files) if (file.status === "rejected") throw file.reason;
  return {
    env: {
      GIT_DIR: gitDir,
      GIT_WORK_TREE: directory,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_ATTR_SOURCE: createHash(format).update("tree 0\0").digest("hex"),
    },
    args: [
      ...statusOptions(settings.stdout),
      "-c",
      `core.excludesFile=${join(gitDir, copiedExcludes)}`,
      "-c",
      "core.attributesFile=/dev/null",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      // Count changed gitlinks without reading submodule worktree configuration.
      "--ignore-submodules=dirty",
    ],
  };
}

async function readHeadRef(run: RunGit) {
  const ref = await run("symbolic-ref", "-q", "HEAD");
  if (ref.code === 1) return "HEAD"; // Detached.
  const name = ref.stdout.trim();
  if (ref.code !== 0 || !name.startsWith("refs/"))
    throw new Error("Git HEAD unavailable");
  return name;
}

async function readCommit(run: RunGit, ref: string) {
  const revision = await run("rev-parse", "--verify", "--end-of-options", ref);
  if (revision.code !== 0) return undefined;
  const oid = revision.stdout.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))
    throw new Error("Git HEAD unavailable");
  return oid;
}

function emptyState(checkedAt: number): V1Git {
  return {
    branch: null,
    head: null,
    base: null,
    ahead: null,
    behind: null,
    changedFiles: null,
    repository: null,
    checkedAt,
  };
}

async function inspect(
  directory: string,
  now: () => number,
  signal: AbortSignal,
  command: typeof readCommand,
  ownDirectory: (path: string) => void,
  dataDirectory?: string,
  temporaryDirectory?: () => string,
): Promise<V1Git | null> {
  const state = emptyState(now());
  let deadline = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
  const runWithEnv = async (
    overrides: NodeJS.ProcessEnv,
    ...args: string[]
  ) => {
    deadline.throwIfAborted();
    const result = await command(
      [
        "git",
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        cwd: directory,
        env: {
          PATH: process.env["PATH"],
          GIT_ALLOW_PROTOCOL: "",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_NO_LAZY_FETCH: "1",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
          ...overrides,
        },
        timeout,
        signal: deadline,
      },
    );
    deadline.throwIfAborted();
    if (!result) throw new Error("Git unavailable");
    return result;
  };
  const run = (...args: string[]) => runWithEnv({}, ...args);
  try {
    try {
      if (!(await stat(directory)).isDirectory()) return null;
    } catch (error) {
      if (fileError(error) === "ENOENT") return null;
      throw error;
    }
    const root = await run(
      "rev-parse",
      "--is-inside-work-tree",
      "--show-prefix",
    );
    if (root.code !== 0 || root.stdout !== "true\n\n")
      throw new Error("Checkout root unavailable");
    const branchRef = await readHeadRef(run);
    const branch = branchRef.startsWith("refs/heads/")
      ? branchRef.slice("refs/heads/".length)
      : null;
    const [oid, upstream] = await Promise.all([
      readCommit(run, branchRef),
      branch
        ? run(
            "rev-parse",
            "--verify",
            "--abbrev-ref",
            "--symbolic-full-name",
            "--end-of-options",
            `${branch}@{upstream}`,
          )
        : undefined,
    ]);
    const base =
      upstream?.code === 0
        ? upstream
        : await run(
            "symbolic-ref",
            "--short",
            "-q",
            "refs/remotes/origin/HEAD",
          );
    const baseRef = base.code === 0 ? base.stdout.trim() : null;
    deadline = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
    const status = await prepareStatus(
      directory,
      oid,
      deadline,
      run,
      runWithEnv,
      command,
      ownDirectory,
      dataDirectory,
      temporaryDirectory,
    );
    deadline.throwIfAborted();
    // Snapshot I/O and index inspection have a separate budget from status.
    deadline = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
    const changed = await runWithEnv(status.env, ...status.args);
    const changedFiles =
      changed.code === 0 ? countChangedPaths(changed.stdout) : null;
    if (changedFiles === null) throw new Error("Git state unavailable");
    const branchName = branch && safeRef(branch);
    const [remote, head] = await Promise.all([
      run("remote", "get-url", "origin"),
      oid ? run("rev-parse", "--short", "--verify", oid) : null,
    ]);
    const abbreviation = head?.code === 0 ? head.stdout.trim() : "";
    let counts: ReturnType<typeof parseAheadBehind> = null;
    if (baseRef && oid) {
      const result = await run(
        "rev-list",
        "--left-right",
        "--count",
        "--end-of-options",
        `${baseRef}...${oid}`,
        "--",
      );
      counts = result.code === 0 ? parseAheadBehind(result.stdout) : null;
      if (!counts) throw new Error("Git comparison unavailable");
    }
    if (
      branchRef !== (await readHeadRef(run)) ||
      oid !== (await readCommit(run, "HEAD"))
    )
      throw new Error("Git HEAD changed during status read");
    return {
      ...state,
      branch: branchName,
      head:
        oid?.startsWith(abbreviation) && /^[a-f0-9]{4,64}$/.test(abbreviation)
          ? abbreviation
          : null,
      base: baseRef ? safeRef(baseRef) : null,
      ...counts,
      changedFiles,
      repository:
        remote.code === 0 ? githubRepository(remote.stdout.trim()) : null,
      checkedAt: now(),
    };
  } catch (error) {
    signal.throwIfAborted();
    return {
      ...state,
      checkedAt: now(),
      error: deadline.aborted
        ? "Git read timed out."
        : error instanceof MetadataLimitExceeded
          ? "Git metadata exceeds the status read limit."
          : "Git state unavailable.",
    };
  }
}

export function createGitReader(
  now: () => number = Date.now,
  command = readCommand,
  dataDirectory?: string,
  temporaryDirectory: () => string = tmpdir,
  // Cache expiry and read timing use a monotonic clock, so a wall-clock change
  // cannot stretch or shrink cache lifetimes. `now` only stamps `checkedAt`.
  monotonic: () => number = () => performance.now(),
  // The whole read's budget, waiting for a slot included. A timeout counts as
  // the checkout's own when it got a slot with at least half of it left.
  readMs: number = 2 * timeout,
) {
  const permits = Semaphore.makeUnsafe(4);
  const cache = new Map<string, { expiresAt: number; value: V1Git | null }>();
  let sweptAt = Number.NEGATIVE_INFINITY;
  function cacheResult(directory: string, value: V1Git | null, ms = ttl) {
    const at = monotonic();
    // Sweep at most once a second, so a burst of results stays linear.
    if (at - sweptAt >= 1_000) {
      sweptAt = at;
      for (const [path, entry] of cache)
        if (entry.expiresAt <= at) cache.delete(path);
    }
    cache.set(directory, { expiresAt: at + ms, value });
    return value;
  }
  void runAbortable(
    permits.withPermit(
      abortable(async () => {
        for (const root of new Set([dataDirectory, temporaryDirectory()]))
          if (root) await sweepStatusDirectories(root);
      }),
    ),
    new AbortController().signal,
  ).catch(() => {});
  return async (directory: string | undefined, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!directory || !isAbsolute(directory)) return null;
    const cached = cache.get(directory);
    if (cached && cached.expiresAt > monotonic()) return cached.value;
    // A timeout is this checkout's own when the read got its permit with at
    // least half of its budget left. Cache that answer for the usual time.
    // A read that mostly waited for a slot says little about the checkout.
    // Cache that answer briefly so polls under saturation stay fast without
    // hiding the checkout for long. A late timer cannot change the answer
    // because the cutoff uses the budget. readMs does not scale the
    // per-command timeouts inside inspect.
    const budgetEnds = monotonic() + readMs;
    let startedAt: number | undefined;
    try {
      return await readWithDeadline(signal, readMs, (deadline) => {
        const reply = Promise.withResolvers<V1Git | null>();
        void runAbortable(
          permits.withPermit(
            abortable(async (reading) => {
              startedAt = monotonic();
              const saved = cache.get(directory);
              if (saved && saved.expiresAt > monotonic()) {
                reply.resolve(saved.value);
                return;
              }
              let snapshot: string | undefined;
              try {
                const value = await inspect(
                  directory,
                  now,
                  reading,
                  command,
                  (path) => {
                    snapshot = path;
                  },
                  dataDirectory,
                  temporaryDirectory,
                );
                deadline.throwIfAborted();
                reply.resolve(cacheResult(directory, value));
              } catch (error) {
                reply.reject(error);
              } finally {
                // The caller already has its result. Keep the permit until
                // removal finishes so stalled filesystems cannot queue copies.
                if (snapshot) await removeStatusDirectory(snapshot);
              }
            }),
          ),
          deadline,
        ).catch(reply.reject);
        return reply.promise;
      }).result;
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof DOMException && error.name === "TimeoutError"))
        throw error;
      const saved = cache.get(directory);
      if (saved && saved.expiresAt > monotonic()) return saved.value;
      const timedOut = { ...emptyState(now()), error: "Git read timed out." };
      const own =
        startedAt !== undefined && budgetEnds - startedAt >= readMs / 2;
      return cacheResult(directory, timedOut, own ? ttl : readMs / 2);
    }
  };
}
