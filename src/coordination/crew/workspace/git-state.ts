import { stat } from "node:fs/promises";
import { Semaphore } from "effect";
import { abortable, runAbortable } from "../../../lib/effect";
import { readWithDeadline } from "../../../lib/read-deadline";
import {
  type CrewGitState,
  countChangedPaths,
  parseAheadBehind,
} from "../reporting/fleet-status";

// Read-only checkout state for the Fleet API, read as the captain.
const gitStateTTL = 15_000;
const gitStateTimeout = 5000;
const gitUnavailable = "Git state unavailable.";

type Head = { ref: string | null; oid: string | null };

type CheckoutGit = (
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
    { kind: "value"; stdout: string } | { kind: "unavailable" | "unsafe-temp" }
  >;
};

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

const name = (value: string | null | undefined) => {
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
        git.status(commit),
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

      const { value: status } = statusRead;
      const { value: remote } = remoteRead;
      const { value: counts } = comparison;

      if (status.kind === "unsafe-temp") {
        return {
          ...emptyState(now()),
          error: "Git status requires a safe temporary directory.",
        };
      }

      const changedFiles =
        status.kind === "value" ? countChangedPaths(status.stdout) : null;

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
