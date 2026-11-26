import { createHash } from "node:crypto";
import { lstat, stat } from "node:fs/promises";
import { join } from "node:path";
import { Semaphore } from "effect";
import { abortable, runAbortable } from "../../../lib/effect";
import { readWithDeadline } from "../../../lib/read-deadline";
import {
  type CrewGitState,
  parseAheadBehind,
  statusEntries,
} from "../reporting/fleet-status";
import type { IsolatedCheckout, IsolatedStream } from "./git-status";

// Read-only checkout state for the Fleet API, read as the captain.
const gitStateTTL = 15_000;
const gitStateTimeout = 5000;
export const gitUnavailable = "Git state unavailable.";

export type Head = { ref: string | null; oid: string | null };

export type CheckoutGit = (
  directory: string,
  signal: AbortSignal,
) => {
  command(args: string[]): Promise<{ code: number; stdout: string } | null>;
  guard<T>(
    sample: (head: Head) => Promise<T>,
  ): Promise<{ kind: "sample"; value: T } | { kind: "moved" }>;
  status(
    oid: string | null,
  ): Promise<
    | { kind: "value"; stdout: string; index: string }
    | { kind: "unavailable" | "unsafe-temp" }
  >;
  isolated<T>(
    head: string | null,
    use: (checkout: IsolatedCheckout, stream: IsolatedStream) => Promise<T>,
  ): Promise<T>;
};

export type Git = ReturnType<CheckoutGit>;

/** Stdout of a successful command, else null: absent refs are normal. */
export async function output(git: Git, args: string[]) {
  const result = await git.command(args);

  return result?.code === 0 ? result.stdout : null;
}

export type Origin = { ref: string; commit: string };

/** A path's size and modification time, or `-` when it is gone. */
async function stamp(path: string, follow = false) {
  const info = await (
    follow ? stat(path, { bigint: true }) : lstat(path, { bigint: true })
  ).catch((): undefined => {});

  return info ? `${info.size}:${info.mtimeNs}` : "-";
}

/**
 * The checkout's status and fingerprint for `head`. The fingerprint hashes
 * HEAD, `origin/HEAD`, the index file's size and mtime, the status output,
 * and the size and mtime of every path it names. It is the same in every
 * diff mode, and the same here and in crew Git state.
 */
export async function fingerprintOf(git: Git, directory: string, head: Head) {
  const [status, originRef, originCommit] = await Promise.all([
    git.status(head.oid),
    output(git, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]),
    output(git, [
      "rev-parse",
      "--verify",
      "-q",
      "--end-of-options",
      "refs/remotes/origin/HEAD^{commit}",
    ]),
  ]);

  if (status.kind !== "value") {
    return { status };
  }

  const entries = statusEntries(status.stdout);

  if (!entries) {
    throw new Error(gitUnavailable);
  }

  const paths = entries.flatMap(({ path, from }) =>
    from ? [path, from] : [path],
  );

  const stamps: string[] = [];

  // Bounded batches keep a large untracked tree from flooding the pool.
  for (let start = 0; start < paths.length; start += 64) {
    stamps.push(
      ...(await Promise.all(
        paths
          .slice(start, start + 64)
          .map((path) => stamp(join(directory, path))),
      )),
    );
  }

  const commit = originCommit?.trim() ?? "";
  const ref = originRef?.trim() ?? "";

  const origin: Origin | null = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)
    ? {
        ref:
          ref.startsWith("refs/remotes/") && ref.length <= 268
            ? ref.slice("refs/remotes/".length)
            : "origin/HEAD",
        commit,
      }
    : null;

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        head.ref,
        head.oid,
        ref,
        commit,
        status.index && (await stamp(status.index, true)),
        status.stdout,
        stamps,
      ]),
    )
    .digest("hex")
    .slice(0, 32);

  return { status, entries, fingerprint, origin };
}

/** The remote URL without user information, which can hold a credential. */
export function remoteWithoutUser(remote: string): string | null {
  const value = remote.trim();

  if (!value || value.length > 2048 || /[\0\n\r]/.test(value)) {
    return null;
  }

  const url = URL.parse(value);

  if (!url || url.protocol === "file:") {
    return value;
  }

  url.username = "";
  url.password = "";

  return url.href;
}

export const name = (value: string | null | undefined) => {
  const text = value?.trim();

  return text && text.length <= 255 && !/[\0\n\r]/.test(text) ? text : null;
};

function emptyState(checkedAt: number): CrewGitState {
  return {
    branch: null,
    commit: null,
    base: null,
    ahead: null,
    behind: null,
    changedFiles: null,
    remote: null,
    checkedAt,
  };
}

async function inspect(
  directory: string,
  signal: AbortSignal,
  now: () => number,
  open: CheckoutGit,
): Promise<CrewGitState | null | "head-moved"> {
  try {
    if (!(await stat(directory)).isDirectory()) {
      return { ...emptyState(now()), error: gitUnavailable };
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    return { ...emptyState(now()), error: gitUnavailable };
  }

  const git = open(directory, signal);

  const run = async (args: string[]) => {
    const result = await git.command(args);

    if (result?.code !== 0) {
      throw new Error(gitUnavailable);
    }

    return result.stdout;
  };

  // Missing upstream or remote are normal.
  const optional = (args: string[]) =>
    run(args).catch(() => {
      signal.throwIfAborted();

      return null;
    });

  try {
    if (
      (await run(["rev-parse", "--is-inside-work-tree", "--show-prefix"])) !==
      "true\n\n"
    ) {
      throw new Error(gitUnavailable);
    }

    const guarded = await git.guard(async (head): Promise<CrewGitState> => {
      const commit = head.oid;

      const branch = head.ref?.startsWith("refs/heads/")
        ? head.ref.slice("refs/heads/".length)
        : null;

      const upstream = branch
        ? await optional([
            "rev-parse",
            "--verify",
            "-q",
            "--abbrev-ref",
            "--symbolic-full-name",
            "--end-of-options",
            `${branch}@{upstream}`,
          ])
        : null;

      const base = name(
        upstream ??
          (await optional([
            "symbolic-ref",
            "--short",
            "-q",
            "refs/remotes/origin/HEAD",
          ])),
      );

      // A failed comparison must not make the guard check HEAD before status ends.
      const [statusRead, remoteRead, comparison] = await Promise.allSettled([
        fingerprintOf(git, directory, head),
        optional(["remote", "get-url", "origin"]),
        base && commit
          ? run([
              "rev-list",
              "--left-right",
              "--count",
              "--end-of-options",
              `${base}...${commit}`,
              "--",
            ])
          : null,
      ]);

      if (
        statusRead.status === "rejected" ||
        remoteRead.status === "rejected" ||
        comparison.status === "rejected"
      ) {
        throw new Error(gitUnavailable);
      }

      const { status, entries, fingerprint } = statusRead.value;
      const { value: remote } = remoteRead;
      const { value: counts } = comparison;

      if (status.kind === "unsafe-temp") {
        return {
          ...emptyState(now()),
          error: "Git status requires a safe temporary directory.",
        };
      }

      const changedFiles = entries?.length ?? null;

      const divergence = counts === null ? null : parseAheadBehind(counts);

      if (changedFiles === null || (counts !== null && divergence === null)) {
        throw new Error(gitUnavailable);
      }

      return {
        branch: name(branch),
        commit,
        base,
        ahead: divergence?.ahead ?? null,
        behind: divergence?.behind ?? null,
        changedFiles,
        remote: remote === null ? null : remoteWithoutUser(remote),
        checkedAt: now(),
        ...(fingerprint && { fingerprint }),
      };
    });

    return guarded.kind === "moved" ? "head-moved" : guarded.value;
  } catch {
    signal.throwIfAborted();

    return { ...emptyState(now()), error: gitUnavailable };
  }
}

export type CrewGitReader = (
  directory: string,
  signal: AbortSignal,
) => Promise<CrewGitState | null>;

/**
 * Reads checkouts as the captain, who owns them. Results are cached briefly
 * and a read continues after its caller leaves, so the next poll is warm.
 */
export function createCrewGitReader(
  open: CheckoutGit,
  now: () => number = Date.now,
  monotonic: () => number = () => performance.now(),
  timeout = gitStateTimeout,
): CrewGitReader {
  const permits = Semaphore.makeUnsafe(4);

  const cache = new Map<
    string,
    { expiresAt: number; value: Promise<CrewGitState | null> }
  >();

  return (directory, signal) => {
    const at = monotonic();

    for (const [path, entry] of cache) {
      if (entry.expiresAt <= at) {
        cache.delete(path);
      }
    }

    let entry = cache.get(directory);

    if (!entry) {
      const deadline = AbortSignal.timeout(timeout);

      const value = runAbortable(
        permits.withPermit(
          abortable((reading) => inspect(directory, reading, now, open)),
        ),
        deadline,
      ).then(
        (result) => {
          if (result === "head-moved") {
            if (cache.get(directory)?.value === value) {
              cache.delete(directory);
            }

            return { ...emptyState(now()), error: gitUnavailable };
          }

          return result;
        },
        () => ({ ...emptyState(now()), error: "Git read timed out." }),
      );

      entry = { expiresAt: at + gitStateTTL, value };
      cache.set(directory, entry);
    }

    const { value } = entry;

    return readWithDeadline(signal, undefined, () => value).result;
  };
}
