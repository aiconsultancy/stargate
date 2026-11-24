import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { bounded, gone, inside } from "./cleanup-scan";

/** The process table and file owners; tests use a fake `/proc`. */
export type ProcessView = {
  root: string;
  /** This process's user ID; undefined where the platform has none. */
  uid: number | undefined;
  stat(path: string): Promise<{ uid: number; mode: number }>;
};

const systemView: ProcessView = {
  root: "/proc",
  uid: process.getuid?.(),
  stat: (path) => lstat(path),
};

/**
 * True when a directory above `path` belongs to this user and gives no
 * access to group or others: another user (not root) cannot reach `path`.
 */
async function privatePath(path: string, view: ProcessView) {
  for (
    let directory = dirname(path);
    directory !== dirname(directory);
    directory = dirname(directory)
  ) {
    const info = await view.stat(directory);

    if (info.uid === view.uid && (info.mode & 0o077) === 0) {
      return true;
    }
  }

  return false;
}

/** Most characters of one `/proc/<pid>/maps` that are read. */
const maxMaps = 16 * 1024 * 1024;

/** Paths of the files that a process has mapped, from `/proc/<pid>/maps`. */
function mappedPaths(maps: string): string[] {
  const paths = new Set<string>();

  for (const line of maps.split("\n")) {
    // Address perms offset dev inode pathname
    const match = /^\S+ +\S+ +\S+ +\S+ +\S+ +(\/.*)$/.exec(line);

    if (match?.[1]) {
      paths.add(match[1]);
    }
  }

  return [...paths];
}

/**
 * Whether a process uses `path` or something inside it. For each process:
 * its executable (`exe`) and mapped files (`maps`), and for each of its
 * threads (`task/<tid>`) the working directory, the root directory and the
 * open files. A thread can have its own working directory and file table.
 * Only link targets and the path column of `maps` are read: no file
 * contents, arguments or environment.
 *
 * A process that cannot be inspected makes the answer unknown, with one
 * exception: when `path` is below a private directory of this user (see
 * `privatePath`), the processes of other users are not inspected. Another
 * user cannot reach the path. Root can, and is accepted as not using it:
 * on a normal host root's processes can never be inspected, and no path
 * would ever be removed.
 */
export async function cleanupPathUse(
  path: string,
  signal?: AbortSignal,
  deadline?: number,
  view: ProcessView = systemView,
): Promise<"unused" | "in-use" | "unknown"> {
  const uses = (target: string, candidate = path) => {
    const name = target.replace(/ \(deleted\)$/, "");

    return isAbsolute(name) && inside(resolve(name), candidate);
  };

  try {
    const stopped = () =>
      signal?.aborted === true ||
      (deadline !== undefined && Date.now() >= deadline);

    const isolated = view.uid !== undefined && (await privatePath(path, view));
    let count = 0;

    /** One link: true when it points into `path`; throws when unreadable. */
    const link = async (name: string) => {
      if (++count > 500_000 || stopped()) {
        throw new Error("limit");
      }

      try {
        return uses(await readlink(name));
      } catch (error) {
        // No such link: the process or thread exited, or a kernel thread.
        if (gone(error)) {
          return false;
        }

        throw error;
      }
    };

    for (const pid of bounded(await readdir(view.root))) {
      if (stopped()) {
        return "unknown";
      }

      if (!/^\d+$/.test(pid)) {
        continue;
      }

      const entry = join(view.root, pid);

      if (isolated) {
        let owner: number;

        try {
          owner = (await view.stat(entry)).uid;
        } catch (error) {
          // Exited meanwhile.
          if (gone(error)) {
            continue;
          }

          return "unknown";
        }

        if (owner !== view.uid) {
          continue;
        }
      }

      let threads: string[];

      try {
        threads = bounded(await readdir(join(entry, "task")));
      } catch (error) {
        if (gone(error)) {
          continue;
        }

        return "unknown";
      }

      if (await link(join(entry, "exe"))) {
        return "in-use";
      }

      try {
        const file = await open(join(entry, "maps"), constants.O_RDONLY);

        try {
          const maps = await file.readFile({ encoding: "utf8" });

          if (maps.length > maxMaps) {
            return "unknown";
          }

          // Linux escapes only newline as `\012`, not literal backslashes.
          // Compare raw paths and fold ambiguous spellings on both sides,
          // Including names with both real newlines and literal `\012`.
          if (
            mappedPaths(maps).some(
              (target) =>
                uses(target) ||
                uses(
                  target.replaceAll("\\012", "\n"),
                  path.replaceAll("\\012", "\n"),
                ),
            )
          ) {
            return "in-use";
          }
        } finally {
          await file.close();
        }
      } catch (error) {
        if (!gone(error)) {
          return "unknown";
        }
      }

      for (const tid of threads) {
        if (!/^\d+$/.test(tid)) {
          continue;
        }

        const thread = join(entry, "task", tid);
        let descriptors: string[];

        try {
          descriptors = bounded(await readdir(join(thread, "fd")));
        } catch (error) {
          if (gone(error)) {
            continue;
          }

          return "unknown";
        }

        for (const name of [
          join(thread, "cwd"),
          join(thread, "root"),
          ...descriptors.map((fd) => join(thread, "fd", fd)),
        ]) {
          if (await link(name)) {
            return "in-use";
          }
        }
      }
    }

    return "unused";
  } catch {
    return "unknown";
  }
}
