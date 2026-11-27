import { constants, createWriteStream } from "node:fs";
import {
  type FileHandle,
  copyFile,
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
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Semaphore } from "effect";
import {
  countChangedPaths,
  parseAheadBehind,
} from "../../../../coordination/crew/reporting/fleet-status";
import {
  type FleetGitCommand,
  FleetStatusRead,
  type StatusStorage,
  fleetGitEnv,
  fleetGitOptions,
  guardFleetHead,
  originHeadArgs,
  outsideCheckout,
  parseOriginHead,
  privateStatusDirectory,
  removeStatusDirectory,
  statusDataDirectory,
  statusDirectoryPrefix,
  statusParent,
} from "../../../../coordination/crew/workspace/git-status";
import { abortable, runAbortable } from "../../../../lib/effect";
import { readWithDeadline } from "../../../../lib/read-deadline";
import { readCommand } from "./command";
import { githubRepository, isGitHubRepositoryName } from "./github-repository";
import type { V1Git } from "./types";

const ttl = 15_000;
const timeout = 2000;
const staleDirectoryAge = 24 * 60 * 60_000;
const mib = 1024 * 1024;
const indexLimit = 128 * mib;
const patternsLimit = mib;
const metadataLimit = 192 * mib;

class MetadataLimitExceeded extends Error {}

// Kept in their own module so config.ts can validate repository names without
// Pulling this file, which looks up its own location, into the crew plugin's
// Digest.
export { githubRepository, isGitHubRepositoryName };

const safeRef = (ref: string) => (ref.length <= 255 ? ref : null);

const metadataFlags =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function fileError(error: unknown) {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

async function openStatusFile(source: string, roots: string[]) {
  // Resolve links first, then prevent the open from following a replacement
  // Symlink in any component of the canonical path.
  const path = await realpath(source);

  if (
    !roots.some((root) => {
      const child = relative(root, path);

      return (
        child !== "" &&
        child !== ".." &&
        !child.startsWith(`..${sep}`) &&
        !isAbsolute(child)
      );
    })
  ) {
    return;
  }

  if (process.platform === "darwin") {
    // Darwin O_NOFOLLOW_ANY
    const noFollowAny = 0x20_00_00_00;

    return open(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollowAny);
  }

  if (process.platform !== "linux") {
    return;
  }

  // Linux exposes directory descriptors through procfs. Open each component
  // Relative to its pinned parent, forbidding symlinks at each step.
  const parts = path.split(sep).slice(1);
  const name = parts.pop();

  if (!name) {
    return;
  }

  const directoryFlags = constants.O_DIRECTORY | metadataFlags;
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
  if (process.platform !== "linux") {
    return false;
  }

  // Clone the already-open file. Reopening its checkout path would race a
  // Replacement between the size check and clone.
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
    ) {
      return;
    }

    throw error;
  });

  if (!file) {
    return false;
  }

  let copied = 0;

  try {
    const metadata = await file.stat();

    if (!metadata.isFile()) {
      if (kind === "pattern") {
        return false;
      }

      throw new Error("Git metadata unavailable");
    }

    if (metadata.size > limit || metadata.size > budget.remaining) {
      throw new MetadataLimitExceeded();
    }

    if (kind !== "pattern" && (await cloneIndex(file, target))) {
      const { size } = await stat(target);

      if (size > limit || size > budget.remaining) {
        throw new MetadataLimitExceeded();
      }

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

            if (remaining < 0 || budget.remaining < 0) {
              throw new MetadataLimitExceeded();
            }

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
    await utimes(target, metadata.atime, Math.floor(metadata.mtimeMs / 1000));

    return true;
  } catch (error) {
    signal.throwIfAborted();

    if (kind !== "pattern" || error instanceof MetadataLimitExceeded) {
      throw error;
    }

    await rm(target, { force: true });
    budget.remaining += copied;

    return false;
  } finally {
    await file.close();
  }
}

const temporaryStatusRoots = new Map<
  string,
  { path: Promise<string>; readers: number }
>();

function retainTemporaryStatusRoot(directory: string) {
  let root = temporaryStatusRoots.get(directory);

  if (!root) {
    const path = mkdtemp(join(directory, statusDirectoryPrefix)).then(
      async (path) => {
        const info = await privateStatusDirectory(path);

        if (info && (info.mode & 0o7777) === 0o700) {
          return path;
        }

        await removeStatusDirectory(path);
        throw new Error("Invalid private Git status directory");
      },
    );

    root = { path, readers: 0 };
    temporaryStatusRoots.set(directory, root);
  }

  const retained = root;
  retained.readers++;

  return {
    path: retained.path,
    async release() {
      if (--retained.readers !== 0) {
        return;
      }

      temporaryStatusRoots.delete(directory);
      const path = await retained.path.catch(() => {});

      if (path) {
        await removeStatusDirectory(path);
      }
    },
  };
}

function snapshotStatusDirectories(
  dataDirectory: string | undefined,
  temporaryDirectory: () => string,
) {
  let temporaryRoot: ReturnType<typeof retainTemporaryStatusRoot> | undefined;

  async function retainedTemporary() {
    const retained = temporaryRoot;

    return retained?.path.catch(async (error: unknown) => {
      if (temporaryRoot === retained) {
        temporaryRoot = undefined;
        await retained.release();
      }

      throw error;
    });
  }

  return {
    async parent(this: void, root: string) {
      const selected = await statusParent(root, {
        dataDirectory,
        temporaryDirectory,
        retainedTemporary,
      });

      if (selected.kind === "ready") {
        return selected.path;
      }

      temporaryRoot ??= retainTemporaryStatusRoot(selected.path);
      const parent = await retainedTemporary();

      if (!parent || !outsideCheckout(root, parent)) {
        throw new Error("No private Git status directory outside checkout");
      }

      return parent;
    },
    async stop() {
      await temporaryRoot?.release();
    },
  };
}

async function sweepStatusDirectories(root: string) {
  const directory = await statusDataDirectory(root);

  if (!directory || !(await privateStatusDirectory(directory))) {
    return;
  }

  const cutoff = Date.now() - staleDirectoryAge;
  const names = await readdir(directory).catch(() => []);

  for (const name of names) {
    if (
      !name.startsWith(statusDirectoryPrefix) ||
      !/^[a-z\d]{6}$/i.test(name.slice(statusDirectoryPrefix.length))
    ) {
      continue;
    }

    const path = join(directory, name);
    const metadata = await privateStatusDirectory(path);

    if (metadata && metadata.mtimeMs < cutoff) {
      await removeStatusDirectory(path);
    }
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

  if (result?.code !== 0) {
    throw new Error("Invalid Git index");
  }

  const name = result.stdout;

  if (!name) {
    return;
  }

  if (
    !/^sharedindex\.[a-f0-9]+$/.test(name) ||
    name.length !== "sharedindex.".length + (format === "sha1" ? 40 : 64)
  ) {
    throw new Error("Invalid Git index");
  }

  return name;
}

function snapshotMetadata(
  directory: string,
  signal: AbortSignal,
  command: typeof readCommand,
): StatusStorage["install"] {
  return async (gitDir, { checkoutGit, commonGit, objects, index, format }) => {
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

          if (!file) {
            throw new Error("Git metadata unavailable");
          }

          return file;
        },
        join(gitDir, target),
        signal,
        indexLimit,
        budget,
        kind,
      );

    await mkdir(join(gitDir, "objects", "info"), { recursive: true });

    if (await snapshotIndex(index, "index", "primary")) {
      const shared = await readSharedIndexName(gitDir, format, signal, command);

      if (shared) {
        await snapshotIndex(join(dirname(index), shared), shared, "shared");
      }
    }

    await writeFile(
      join(gitDir, "objects", "info", "alternates"),
      `${objects}\n`,
    );

    return {
      env: {},
      pattern: (source, target) =>
        copyStatusFile(
          () => openStatusFile(source, roots),
          join(gitDir, target),
          signal,
          patternsLimit,
          budget,
          "pattern",
        ),
    };
  };
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

const branchField = ["symref:short"];

/**
 * The branch `origin/HEAD` names, read as the crew plugin's reader reads it,
 * or null. A dangling `origin/HEAD` has no base rather than a failed
 * comparison.
 */
async function defaultBranch(
  run: (...args: string[]) => Promise<{ code: number; stdout: string }>,
) {
  const result = await run(...originHeadArgs(branchField));
  const [short] = parseOriginHead(result.stdout, branchField);

  return result.code === 0 && short ? short : null;
}

async function inspect(
  directory: string,
  now: () => number,
  signal: AbortSignal,
  command: typeof readCommand,
  checkout: FleetStatusRead,
  statusParent: StatusStorage["parent"],
): Promise<V1Git | null | "head-moved"> {
  const state = emptyState(now());
  let deadline = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);

  const runCommand: FleetGitCommand = async (args, overrides) => {
    deadline.throwIfAborted();

    const result = await command(
      ["git", "--no-optional-locks", ...fleetGitOptions, ...args],
      {
        cwd: directory,
        env: {
          PATH: process.env["PATH"],
          ...fleetGitEnv,
          LC_ALL: "C",
          ...overrides,
        },
        timeout,
        signal: deadline,
      },
    );

    deadline.throwIfAborted();

    return result;
  };

  const run = async (...args: string[]) => {
    const result = await runCommand(args);

    if (result === null) {
      throw new Error("Git unavailable");
    }

    return result;
  };

  try {
    try {
      if (!(await stat(directory)).isDirectory()) {
        return null;
      }
    } catch (error) {
      if (fileError(error) === "ENOENT") {
        return null;
      }

      throw error;
    }

    const root = await run(
      "rev-parse",
      "--is-inside-work-tree",
      "--show-prefix",
    );

    if (root.code !== 0 || root.stdout !== "true\n\n") {
      throw new Error("Checkout root unavailable");
    }

    const guarded = await guardFleetHead(
      runCommand,
      () => deadline,
      async (before): Promise<V1Git> => {
        const oid = before.oid;

        const branch = before.ref?.startsWith("refs/heads/")
          ? before.ref.slice("refs/heads/".length)
          : null;

        const upstream = branch
          ? await run(
              "rev-parse",
              "--verify",
              "--abbrev-ref",
              "--symbolic-full-name",
              "--end-of-options",
              `${branch}@{upstream}`,
            )
          : undefined;

        const baseRef =
          upstream?.code === 0
            ? upstream.stdout.trim()
            : await defaultBranch(run);

        deadline = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);

        const changed = await checkout.read({
          directory,
          head: oid,
          signal: deadline,
          run: runCommand,
          storage: {
            parent: statusParent,
            install: snapshotMetadata(directory, deadline, command),
          },
          status: (args, env) => {
            // Snapshot I/O and index inspection have a separate status budget.
            deadline = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);

            return runCommand(args, env);
          },
        });

        const changedFiles =
          changed?.code === 0 ? countChangedPaths(changed.stdout) : null;

        if (changedFiles === null) {
          throw new Error("Git state unavailable");
        }

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

          if (!counts) {
            throw new Error("Git comparison unavailable");
          }
        }

        return {
          ...state,
          branch: branchName,
          head:
            oid?.startsWith(abbreviation) &&
            /^[a-f0-9]{4,64}$/.test(abbreviation)
              ? abbreviation
              : null,
          commit: oid ?? null,
          base: baseRef ? safeRef(baseRef) : null,
          ...counts,
          changedFiles,
          repository:
            remote.code === 0 ? githubRepository(remote.stdout.trim()) : null,
          checkedAt: now(),
        };
      },
    );

    return guarded.kind === "moved" ? "head-moved" : guarded.value;
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

type GitReader = {
  (directory: string | undefined, signal: AbortSignal): Promise<V1Git | null>;
  stop(): Promise<void>;
};

export function createGitReader(
  now: () => number = Date.now,
  command = readCommand,
  dataDirectory?: string,
  temporaryDirectory: () => string = tmpdir,
  // Cache expiry and read timing use a monotonic clock, so a wall-clock change
  // Cannot stretch or shrink cache lifetimes. `now` only stamps `checkedAt`.
  monotonic: () => number = () => performance.now(),
  // The whole read's budget, waiting for a slot included. A timeout counts as
  // The checkout's own when it got a slot with at least half of it left.
  readMs: number = 2 * timeout,
): GitReader {
  const permits = Semaphore.makeUnsafe(4);

  const directories = snapshotStatusDirectories(
    dataDirectory,
    temporaryDirectory,
  );

  const lifetime = new AbortController();
  const reads = new Set<Promise<void>>();
  let stopping: Promise<void> | undefined;
  const cache = new Map<string, { expiresAt: number; value: V1Git | null }>();
  let sweptAt = Number.NEGATIVE_INFINITY;

  function cachedResult(directory: string) {
    const entry = cache.get(directory);

    return entry && entry.expiresAt > monotonic() ? entry : undefined;
  }

  function cacheResult(directory: string, value: V1Git | null, ms = ttl) {
    const at = monotonic();

    // Sweep at most once a second, so a burst of results stays linear.
    if (at - sweptAt >= 1000) {
      sweptAt = at;

      for (const [path, entry] of cache) {
        if (entry.expiresAt <= at) {
          cache.delete(path);
        }
      }
    }

    cache.set(directory, { expiresAt: at + ms, value });

    return value;
  }

  if (dataDirectory) {
    void runAbortable(
      permits.withPermit(
        abortable(() => sweepStatusDirectories(dataDirectory)),
      ),
      lifetime.signal,
    ).catch(() => {});
  }

  async function read(directory: string | undefined, caller: AbortSignal) {
    const signal = AbortSignal.any([caller, lifetime.signal]);
    signal.throwIfAborted();

    if (!directory || !isAbsolute(directory)) {
      return null;
    }

    const cached = cachedResult(directory);

    if (cached) {
      return cached.value;
    }

    // A timeout is this checkout's own when the read got its permit with at
    // Least half of its budget left. Cache that answer for the usual time.
    // A read that mostly waited for a slot says little about the checkout.
    // Cache that answer briefly so polls under saturation stay fast without
    // Hiding the checkout for long. A late timer cannot change the answer
    // Because the cutoff uses the budget. readMs does not scale the
    // Per-command timeouts inside inspect.
    const budgetEnds = monotonic() + readMs;
    let startedAt: number | undefined;

    try {
      return await readWithDeadline(signal, readMs, (deadline) => {
        const reply = Promise.withResolvers<V1Git | null>();

        const task = runAbortable(
          permits.withPermit(
            abortable(async (reading) => {
              startedAt = monotonic();
              const saved = cachedResult(directory);

              if (saved) {
                reply.resolve(saved.value);

                return;
              }

              // Reply before disposal, but hold the permit until it finishes.
              await using checkout = new FleetStatusRead();

              try {
                const value = await inspect(
                  directory,
                  now,
                  reading,
                  command,
                  checkout,
                  directories.parent,
                );

                deadline.throwIfAborted();
                reply.resolve(
                  value === "head-moved"
                    ? {
                        ...emptyState(now()),
                        error: "Git state unavailable.",
                      }
                    : cacheResult(directory, value),
                );
              } catch (error) {
                reply.reject(error);
              }
            }),
          ),
          deadline,
        )
          .catch(reply.reject)
          .finally(() => {
            reads.delete(task);
          });

        reads.add(task);

        return reply.promise;
      }).result;
    } catch (error) {
      signal.throwIfAborted();

      if (!(error instanceof DOMException && error.name === "TimeoutError")) {
        throw error;
      }

      const saved = cachedResult(directory);

      if (saved) {
        return saved.value;
      }

      const timedOut = { ...emptyState(now()), error: "Git read timed out." };

      const own =
        startedAt !== undefined && budgetEnds - startedAt >= readMs / 2;

      return cacheResult(directory, timedOut, own ? ttl : readMs / 2);
    }
  }

  return Object.assign(read, {
    stop() {
      lifetime.abort();
      stopping ??= Promise.all(reads).then(() => directories.stop());

      return stopping;
    },
  });
}
