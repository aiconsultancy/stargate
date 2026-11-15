import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type {
  CleanupItem,
  CleanupReason,
  CleanupResult,
  CleanupSettings,
} from "./cleanup-config";
import type { CommandResult, CommandRunner } from "./exec";

export type {
  CleanupItem,
  CleanupReason,
  CleanupResult,
} from "./cleanup-config";
export type CleanupInput = {
  settings: CleanupSettings;
  plan: boolean;
  runner: CommandRunner;
  now: number;
  signal: AbortSignal;
  protectedPaths: string[];
  taskDirectories?: string[];
  /** Absolute wall-clock deadline, also enforced between filesystem operations. */
  deadline?: number;
  beforeItem?: (item: CleanupItem) => Promise<void>;
  /** Awaited intent checkpoint BEFORE deletion; awaited final checkpoint AFTER it. */
  record?: (item: CleanupItem) => Promise<void>;
  /** Test/platform seam. Unknown use must fail closed. Default: Linux /proc. */
  inUse?: (path: string) => Promise<"unused" | "in-use" | "unknown">;
};

const day = 86_400_000;
const maxItems = 500;
const maxEntries = 20_000;
const sha = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const inside = (path: string, root: string) =>
  path === root || path.startsWith(root === sep ? sep : `${root}${sep}`);
const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);
const hasControls = (value: string) =>
  [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
class Refusal extends Error {
  constructor(readonly reason: CleanupReason) {
    super(reason);
  }
}
function refuse(reason: CleanupReason): never {
  throw new Refusal(reason);
}
const reasonOf = (error: unknown): CleanupReason =>
  error instanceof Refusal ? error.reason : "metadata-unknown";
function bounded<T>(values: T[], maximum = maxEntries) {
  if (values.length > maximum) refuse("scan-limit");
  return values;
}
const sensitive = (name: string) =>
  [
    ".config",
    ".ssh",
    ".aws",
    ".azure",
    ".gnupg",
    ".kube",
    ".claude",
    ".codex",
    ".pogo",
    ".opencode",
    "credentials",
    "credentials.json",
    ".env",
  ].includes(name) || name.startsWith(".env.");

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
    if (info.uid === view.uid && (info.mode & 0o077) === 0) return true;
  }
  return false;
}

/** Most characters of one `/proc/<pid>/maps` that are read. */
const maxMaps = 16 * 1024 * 1024;

/** Paths of the files that a process has mapped, from `/proc/<pid>/maps`. */
function mappedPaths(maps: string): string[] {
  const paths = new Set<string>();
  for (const line of maps.split("\n")) {
    // address perms offset dev inode pathname
    const match = /^\S+ +\S+ +\S+ +\S+ +\S+ +(\/.*)$/.exec(line);
    if (match?.[1]) paths.add(match[1]);
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
  const gone = (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT";
  const uses = (target: string, candidate = path) => {
    const name = target.replace(/ \(deleted\)$/, "");
    return isAbsolute(name) && inside(resolve(name), candidate);
  };
  try {
    const stopped = () =>
      signal?.aborted || (deadline !== undefined && Date.now() >= deadline);
    const isolated = view.uid !== undefined && (await privatePath(path, view));
    let count = 0;
    /** One link: true when it points into `path`; throws when unreadable. */
    const link = async (name: string) => {
      if (++count > 500_000 || stopped()) throw new Error("limit");
      try {
        return uses(await readlink(name));
      } catch (error) {
        // No such link: the process or thread exited, or a kernel thread.
        if (gone(error)) return false;
        throw error;
      }
    };
    for (const pid of bounded(await readdir(view.root))) {
      if (stopped()) return "unknown";
      if (!/^\d+$/.test(pid)) continue;
      const entry = join(view.root, pid);
      if (isolated) {
        let owner: number;
        try {
          owner = (await view.stat(entry)).uid;
        } catch (error) {
          // Exited meanwhile.
          if (gone(error)) continue;
          return "unknown";
        }
        if (owner !== view.uid) continue;
      }
      let threads: string[];
      try {
        threads = bounded(await readdir(join(entry, "task")));
      } catch (error) {
        if (gone(error)) continue;
        return "unknown";
      }
      if (await link(join(entry, "exe"))) return "in-use";
      try {
        const file = await open(join(entry, "maps"), constants.O_RDONLY);
        try {
          const maps = await file.readFile({ encoding: "utf8" });
          if (maps.length > maxMaps) return "unknown";
          // Linux escapes only newline as `\012`, not literal backslashes.
          // Compare raw paths and fold ambiguous spellings on both sides,
          // including names with both real newlines and literal `\012`.
          if (
            mappedPaths(maps).some(
              (target) =>
                uses(target) ||
                uses(
                  target.replaceAll("\\012", "\n"),
                  path.replaceAll("\\012", "\n"),
                ),
            )
          )
            return "in-use";
        } finally {
          await file.close();
        }
      } catch (error) {
        if (!gone(error)) return "unknown";
      }
      for (const tid of threads) {
        if (!/^\d+$/.test(tid)) continue;
        const thread = join(entry, "task", tid);
        let descriptors: string[];
        try {
          descriptors = bounded(await readdir(join(thread, "fd")));
        } catch (error) {
          if (gone(error)) continue;
          return "unknown";
        }
        for (const name of [
          join(thread, "cwd"),
          join(thread, "root"),
          ...descriptors.map((fd) => join(thread, "fd", fd)),
        ])
          if (await link(name)) return "in-use";
      }
    }
    return "unused";
  } catch {
    return "unknown";
  }
}

/**
 * The children of one scratch root that one run inspects. Up to `limit`
 * children: all of them, by name. More: only those whose own modification
 * time is before the cutoff (a directory changed later is not stale,
 * whatever it holds), oldest first; when these are still more than `limit`,
 * one window of `limit` per day, so that children which stay (in use, not
 * pushed) cannot keep the others from their turn.
 */
export function scratchBatch(
  children: readonly { name: string; mtimeMs: number }[],
  now: number,
  cutoff: number,
  limit = maxItems,
): { names: string[]; partial: boolean } {
  if (children.length <= limit)
    return {
      names: children.map((child) => child.name).sort(),
      partial: false,
    };
  if (limit <= 0) return { names: [], partial: true };
  const old = children
    .filter((child) => child.mtimeMs < cutoff)
    .sort((a, b) =>
      a.mtimeMs !== b.mtimeMs
        ? a.mtimeMs - b.mtimeMs
        : a.name < b.name
          ? -1
          : 1,
    );
  const windows = Math.max(1, Math.ceil(old.length / limit));
  const start = (Math.floor(now / day) % windows) * limit;
  return {
    names: old.slice(start, start + limit).map((child) => child.name),
    partial: true,
  };
}

type Tree = {
  size: number;
  newestMtime: number;
  fingerprint: string;
  repositories: string[];
};
type Worktree = {
  path: string;
  tip: string;
  branch?: string;
  locked: boolean;
  bare: boolean;
};
function worktrees(text: string): Worktree[] {
  const result: Worktree[] = [];
  for (const record of bounded(text.split("\0\0").filter(Boolean), 256)) {
    const lines = record.split("\0").filter(Boolean);
    const path = lines.shift()?.replace(/^worktree /, "");
    if (!path || path.length > 4096 || !isAbsolute(path) || hasControls(path))
      refuse("git-unknown");
    const tip = lines.find((line) => line.startsWith("HEAD "))?.slice(5) ?? "";
    const branch = lines
      .find((line) => line.startsWith("branch refs/heads/"))
      ?.slice(18);
    const bare = lines.includes("bare");
    if (!bare && !sha.test(tip)) refuse("git-unknown");
    if (
      lines.some(
        (line) =>
          !/^(HEAD |branch refs\/heads\/|detached$|locked(?: |$)|prunable(?: |$)|bare$)/.test(
            line,
          ),
      )
    )
      refuse("git-unknown");
    if (lines.some((line) => line.startsWith("prunable")))
      refuse("git-unknown");
    result.push({
      path: resolve(path),
      tip,
      ...(branch ? { branch } : {}),
      locked: lines.some((line) => line.startsWith("locked")),
      bare,
    });
  }
  if (!result.length) refuse("git-unknown");
  return result;
}

/** Bounded, opt-in cleanup. All uncertainty keeps the item; raw errors never escape. */
export async function runCleanup(input: CleanupInput): Promise<CleanupResult> {
  const result: CleanupResult = { items: [], freedBytes: 0, plannedBytes: 0 };
  if (!input.settings.enabled) return result;
  const deadline = Math.min(input.deadline ?? Infinity, Date.now() + 120_000);
  const home = homedir();
  const fixed = [
    "/etc",
    "/var",
    "/run",
    "/proc",
    "/sys",
    "/dev",
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/boot",
    "/root",
    ...[
      ".config",
      ".ssh",
      ".local/share",
      ".local/state",
      ".aws",
      ".azure",
      ".gnupg",
      ".kube",
      ".claude",
      ".codex",
    ].map((part) => join(home, part)),
    ...[
      process.env["XDG_CONFIG_HOME"],
      process.env["XDG_DATA_HOME"],
      process.env["XDG_STATE_HOME"],
    ].filter((path): path is string => !!path && isAbsolute(path)),
  ];
  const protectedPaths = [
    ...fixed,
    ...input.protectedPaths,
    ...input.settings.protectedPaths,
  ].map((path) => resolve(path));
  // Include resolved aliases too; an unresolved operator protection still protects its literal path.
  for (const path of [...protectedPaths])
    try {
      protectedPaths.push(await realpath(path));
    } catch {
      /* literal protection remains */
    }
  const tasks = (input.taskDirectories ?? []).map((path) => resolve(path));
  for (const path of [...tasks])
    try {
      tasks.push(await realpath(path));
    } catch {
      /* literal protection remains */
    }
  const primaries: string[] = [];
  let commands = 0;
  let auditBroken = false;
  const check = () => {
    if (input.signal.aborted) refuse("aborted");
    if (Date.now() >= deadline) refuse("deadline");
  };
  const capacity = () => !auditBroken && result.items.length < maxItems;
  async function record(item: CleanupItem) {
    if (input.plan) return;
    try {
      await input.record?.({ ...item });
    } catch {
      auditBroken = true;
      refuse("audit-failed");
    }
  }
  async function emit(item: CleanupItem) {
    if (!capacity()) return;
    result.items.push(item);
    await record(item);
  }
  async function command(
    path: string,
    args: string[],
    verification = false,
  ): Promise<CommandResult> {
    if (!verification) check();
    if (++commands > 2000) refuse("scan-limit");
    const timeoutMs = Math.max(1, Math.min(10_000, deadline - Date.now()));
    const output = await input.runner.run(
      ["git", "--no-optional-locks", "-C", path, ...args],
      {
        timeoutMs,
        env: {
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
    );
    if (output.stdout.length >= 1024 * 1024) refuse("scan-limit");
    return output;
  }
  async function git(path: string, ...args: string[]) {
    const output = await command(path, args);
    if (output.code !== 0) refuse("git-unknown");
    return output.stdout;
  }
  async function canonical(path: string) {
    check();
    if (!isAbsolute(path) || resolve(path) !== path || hasControls(path))
      refuse("unsafe-path");
    if ((await realpath(path)) !== path || (await lstat(path)).isSymbolicLink())
      refuse("symlink");
    if (!(await lstat(path)).isDirectory()) refuse("unsafe-path");
  }
  async function allowed(path: string, primary = true) {
    check();
    await canonical(path);
    // An exact permanent-checkout protection forbids removing the directory,
    // not managing its unused branches or separately listed leaked worktrees.
    if (
      path === sep ||
      path === home ||
      fixed.some((p) => overlaps(path, p)) ||
      protectedPaths.some((p) => overlaps(path, p) && (primary || path !== p))
    )
      refuse("protected");
    if (primary && primaries.some((p) => overlaps(path, p))) refuse("primary");
    if (tasks.some((p) => overlaps(path, p))) refuse("in-use");
    const use = await (input.inUse
      ? input.inUse(path)
      : cleanupPathUse(path, input.signal, deadline));
    check();
    if (use !== "unused") refuse(use === "in-use" ? "in-use" : "use-unknown");
  }
  async function scan(path: string): Promise<Tree> {
    const hash = createHash("sha256");
    let size = 0;
    let newestMtime = 0;
    let count = 0;
    const device = (await lstat(path)).dev;
    const repositories: string[] = [];
    const visit = async (current: string, depth: number): Promise<void> => {
      check();
      if (++count > maxEntries || depth > 64) refuse("scan-limit");
      const info = await lstat(current);
      if (info.isSymbolicLink()) refuse("symlink");
      if (!info.isFile() && !info.isDirectory()) refuse("metadata-unknown");
      if (info.isFile() && info.nlink !== 1) refuse("unsafe-path");
      if (info.dev !== device) refuse("unsafe-path");
      const name = basename(current);
      if (
        sensitive(name) ||
        current.endsWith(`${sep}.agents${sep}opco`) ||
        current.endsWith(`${sep}.local${sep}share${sep}pogo`) ||
        current.endsWith(`${sep}.local${sep}share${sep}opencode`)
      )
        refuse("protected");
      if (["slack-share", "avondale-fixtures"].includes(name))
        refuse("protected");
      if (
        (/^(inspect-snapshot-|bosun-inspect-)/.test(name) &&
          info.mtimeMs >= input.now - 7 * day) ||
        (name.endsWith("-relay.json") &&
          new Date(info.mtimeMs).toDateString() ===
            new Date(input.now).toDateString())
      )
        refuse("retained");
      if (name === ".git") {
        if (!info.isDirectory()) refuse("git-unknown"); // linked worktrees require `git worktree remove`.
        repositories.push(dirname(current));
      }
      newestMtime = Math.max(newestMtime, info.mtimeMs);
      if (info.isFile()) size += info.size;
      hash.update(
        JSON.stringify([
          current,
          info.dev,
          info.ino,
          info.mode,
          info.size,
          info.mtimeMs,
          info.ctimeMs,
        ]),
      );
      if (info.isDirectory())
        for (const name of bounded(await readdir(current)).sort()) {
          // The root .git pointer is metadata of an explicitly listed worktree, not a nested repository.
          if (
            current === path &&
            name === ".git" &&
            !(await lstat(join(current, name))).isDirectory()
          ) {
            const pointer = await lstat(join(current, name));
            if (
              !pointer.isFile() ||
              pointer.nlink !== 1 ||
              pointer.dev !== device
            )
              refuse("git-unknown");
            size += pointer.size;
            hash.update(
              JSON.stringify([
                name,
                pointer.dev,
                pointer.ino,
                pointer.size,
                pointer.mtimeMs,
                pointer.ctimeMs,
              ]),
            );
            newestMtime = Math.max(newestMtime, pointer.mtimeMs);
            continue;
          }
          await visit(join(current, name), depth + 1);
        }
    };
    await visit(path, 0);
    return { size, newestMtime, fingerprint: hash.digest("hex"), repositories };
  }
  async function clean(path: string) {
    if (
      (
        await git(
          path,
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignore-submodules=none",
        )
      ).length
    )
      refuse("dirty");
    if ((await git(path, "rev-parse", "--show-toplevel")).trim() !== path)
      refuse("git-unknown");
  }
  async function remoteTips(path: string) {
    // Offline evidence only: origin, actual remote-tracking refs and verified
    // local commit objects. Configured upstream names alone prove nothing.
    if (!(await git(path, "remote")).trim().split("\n").includes("origin"))
      refuse("git-unknown");
    const text = await git(
      path,
      "for-each-ref",
      "--format=%(objectname)%09%(refname)%09%(objecttype)%09%(symref)",
      "refs/remotes/origin/",
    );
    const tips = bounded(text.split("\n").filter(Boolean), 256).flatMap(
      (line) => {
        const [tip, ref, type, symbolic] = line.split("\t");
        if (
          !tip ||
          !sha.test(tip) ||
          !ref?.startsWith("refs/remotes/origin/") ||
          type !== "commit" ||
          symbolic === undefined
        )
          refuse("git-unknown");
        return symbolic ? [] : [tip];
      },
    );
    if (!tips.length) refuse("git-unknown");
    return tips;
  }
  async function contained(path: string, tip: string, remotes: string[]) {
    if (!sha.test(tip)) refuse("git-unknown");
    for (const remote of remotes) {
      const output = await command(path, [
        "merge-base",
        "--is-ancestor",
        tip,
        remote,
      ]);
      if (output.code === 0) return;
      if (output.code !== 1 && output.code !== 128) refuse("git-unknown");
    }
    refuse("unpushed");
  }
  async function allPushed(path: string) {
    const tips = await remoteTips(path);
    const heads = bounded(
      (await git(path, "for-each-ref", "--format=%(objectname)", "refs/heads/"))
        .trim()
        .split("\n")
        .filter(Boolean),
      256,
    );
    heads.push((await git(path, "rev-parse", "--verify", "HEAD")).trim());
    for (const head of new Set(heads)) await contained(path, head, tips);
  }
  async function treeSafe(path: string, kind: CleanupItem["kind"]) {
    await allowed(path);
    const tree = await scan(path);
    if (tree.newestMtime >= input.now - input.settings.olderThanDays * day)
      refuse("recent");
    for (const repo of tree.repositories) {
      await clean(repo);
      await allPushed(repo);
      const list = worktrees(
        await git(repo, "worktree", "list", "--porcelain", "-z"),
      );
      if (list.some((item) => item.path !== repo)) refuse("git-unknown");
    }
    if (kind === "scratch") {
      try {
        if ((await lstat(join(path, ".git"))).isFile()) refuse("git-unknown");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return tree;
  }
  async function perform(
    item: CleanupItem,
    validate: () => Promise<void>,
    remove: () => Promise<void>,
  ) {
    check();
    if (input.plan) {
      result.plannedBytes += item.size;
      await emit({ ...item, status: "planned" });
      return;
    }
    try {
      await input.beforeItem?.({ ...item });
    } catch {
      refuse("gate-failed");
    }
    check();
    await record({ ...item, status: "planned" });
    await validate();
    check();
    try {
      await remove();
    } catch (error) {
      // Filesystem removal can fail after deleting part of the tree.
      // Never classify an unknown removal outcome as a retained item.
      if (error instanceof Refusal) throw error;
      refuse("command-failed");
    }
    // The side effect happened even if cancellation arrived during it: record its outcome.
    result.freedBytes += item.size;
    await emit({ ...item, status: "removed" });
  }
  async function attempt(item: CleanupItem, operation: () => Promise<void>) {
    if (!capacity()) return;
    try {
      check();
      await operation();
    } catch (error) {
      if (auditBroken) {
        if (result.items.length < maxItems)
          result.items.push({
            ...item,
            status: "failed",
            reason: "audit-failed",
          });
        return;
      }
      try {
        const reason = reasonOf(error);
        await emit({
          ...item,
          status: reason === "command-failed" ? "failed" : "skipped",
          reason,
        });
      } catch {
        /* A failed durable checkpoint stops all subsequent deletion. */
      }
    }
  }
  const repositoryLists = new Map<string, Worktree[]>();
  for (const raw of new Set(input.settings.repositories)) {
    const item: CleanupItem = {
      kind: "worktree",
      path: raw,
      size: 0,
      newestMtime: 0,
      status: "skipped",
      reason: "primary",
    };
    await attempt(item, async () => {
      await canonical(raw);
      const list = worktrees(
        await git(raw, "worktree", "list", "--porcelain", "-z"),
      );
      const primary = list[0];
      if (!primary) refuse("git-unknown");
      primaries.push(primary.path);
      repositoryLists.set(raw, list);
    });
  }
  // A configured repository's unavailable primary metadata cannot authorise scratch deletion.
  const scratchAllowed =
    repositoryLists.size === new Set(input.settings.repositories).size;
  for (const raw of new Set(input.settings.scratchRoots)) {
    if (!capacity()) break;
    const base: CleanupItem = {
      kind: "scratch",
      path: raw,
      size: 0,
      newestMtime: 0,
      status: "skipped",
      reason: "metadata-unknown",
    };
    await attempt(base, async () => {
      await canonical(raw);
      if (raw === sep || raw === home || fixed.some((p) => inside(raw, p)))
        refuse("protected");
      if (!scratchAllowed) refuse("git-unknown");
      // More children than this run can still report: a batch now, the
      // rest later. One report item is kept for the root itself, so every
      // name of the batch has an item and the daily window loses no child.
      const children: { name: string; mtimeMs: number }[] = [];
      const listed = bounded(await readdir(raw));
      const budget = maxItems - result.items.length;
      if (listed.length <= budget)
        children.push(...listed.map((name) => ({ name, mtimeMs: 0 })));
      else
        for (const name of listed) {
          check();
          const info = await lstat(join(raw, name)).catch(() => undefined);
          // A plain file is never a candidate; it takes no place in a batch.
          if (info && (info.isDirectory() || info.isSymbolicLink()))
            children.push({ name, mtimeMs: info.mtimeMs });
        }
      const batch = scratchBatch(
        children,
        input.now,
        input.now - input.settings.olderThanDays * day,
        listed.length <= budget ? budget : Math.max(0, budget - 1),
      );
      if (batch.partial) await emit({ ...base, reason: "scan-limit" });
      for (const name of batch.names) {
        if (!capacity()) break;
        const path = join(raw, name);
        if (hasControls(name) || path.length > 4096) {
          // Keep the unsafe child; audit its safe parent rather than emit
          // an invalid path that could suppress the entire run's report.
          await emit({ ...base, reason: "unsafe-path" });
          continue;
        }
        const info = await lstat(path);
        if (!info.isDirectory() && !info.isSymbolicLink()) continue;
        const item = { ...base, path };
        await attempt(item, async () => {
          const tree = await treeSafe(path, "scratch");
          Object.assign(item, {
            size: tree.size,
            newestMtime: tree.newestMtime,
            reason: "stale",
          });
          await perform(
            item,
            async () => {
              const names = bounded(await readdir(raw));
              if (!names.includes(name)) refuse("changed");
              if (
                (await treeSafe(path, "scratch")).fingerprint !==
                tree.fingerprint
              )
                refuse("changed");
            },
            async () => {
              // Pin the parent descriptor; recursive removal cannot traverse a replaced ancestor.
              const handle = await open(
                raw,
                constants.O_RDONLY |
                  constants.O_DIRECTORY |
                  constants.O_NOFOLLOW,
              );
              try {
                const parent = await handle.stat();
                const live = await lstat(raw);
                if (
                  parent.dev !== live.dev ||
                  parent.ino !== live.ino ||
                  (await realpath(raw)) !== raw
                )
                  refuse("changed");
                if ((await scan(path)).fingerprint !== tree.fingerprint)
                  refuse("changed");
                check();
                await rm(`/proc/self/fd/${handle.fd}/${name}`, {
                  recursive: true,
                  force: false,
                });
                try {
                  await lstat(`/proc/self/fd/${handle.fd}/${name}`);
                  refuse("command-failed");
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                    throw error;
                }
              } finally {
                await handle.close();
              }
            },
          );
        });
      }
    });
  }
  for (const [repo, initial] of repositoryLists) {
    if (!capacity()) break;
    const base: CleanupItem = {
      kind: "branch",
      path: repo,
      size: 0,
      newestMtime: 0,
      status: "skipped",
      reason: "git-unknown",
    };
    await attempt(base, async () => {
      // Primary is protected from removal, not from safe deletion of an unused branch.
      await allowed(repo, false);
      await clean(repo);
      if (!input.plan) {
        const fetch = await command(repo, ["fetch", "--prune", "origin"]);
        if (fetch.code !== 0) refuse("fetch-failed");
      }
      const list = worktrees(
        await git(repo, "worktree", "list", "--porcelain", "-z"),
      );
      if (list[0]?.path !== initial[0]?.path) refuse("changed");
      for (const worktree of list) {
        if (!capacity()) break;
        const item: CleanupItem = {
          ...base,
          kind: "worktree",
          path: worktree.path,
          tip: worktree.tip,
          ...(worktree.branch ? { branch: worktree.branch } : {}),
        };
        await attempt(item, async () => {
          if (worktree.path === list[0]?.path || worktree.bare)
            refuse("primary");
          if (worktree.locked) refuse("locked");
          const validateGit = async () => {
            await clean(worktree.path);
            const fresh = worktrees(
              await git(repo, "worktree", "list", "--porcelain", "-z"),
            ).find((entry) => entry.path === worktree.path);
            if (
              !fresh ||
              fresh.locked ||
              fresh.tip !== worktree.tip ||
              fresh.branch !== worktree.branch
            )
              refuse("changed");
            await allPushed(worktree.path);
          };
          const tree = await treeSafe(worktree.path, "worktree");
          await validateGit();
          Object.assign(item, {
            size: tree.size,
            newestMtime: tree.newestMtime,
            reason: "pushed",
          });
          await perform(
            item,
            async () => {
              if (
                (await treeSafe(worktree.path, "worktree")).fingerprint !==
                tree.fingerprint
              )
                refuse("changed");
              await validateGit();
            },
            async () => {
              const output = await command(repo, [
                "worktree",
                "remove",
                "--",
                worktree.path,
              ]);
              if (output.code) refuse("command-failed");
              try {
                await lstat(worktree.path);
                refuse("command-failed");
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                  throw error;
              }
            },
          );
        });
      }
      const refs = bounded(
        (
          await git(
            repo,
            "for-each-ref",
            "--format=%(refname)%09%(objectname)",
            "refs/heads/",
          )
        )
          .trim()
          .split("\n")
          .filter(Boolean),
        256,
      );
      for (const ref of refs) {
        if (!capacity()) break;
        const [full, tip] = ref.split("\t");
        const branch = full?.slice("refs/heads/".length);
        if (
          !full?.startsWith("refs/heads/") ||
          !branch ||
          !tip ||
          !sha.test(tip)
        )
          refuse("git-unknown");
        if (branch.length > 1024) {
          await emit({ ...base, reason: "unsafe-path" });
          continue;
        }
        const item: CleanupItem = { ...base, branch, tip, reason: "merged" };
        await attempt(item, async () => {
          const validate = async () => {
            await allowed(repo, false);
            await clean(repo);
            if (["main", "master"].includes(branch)) refuse("protected");
            const trees = worktrees(
              await git(repo, "worktree", "list", "--porcelain", "-z"),
            );
            if (trees.some((tree) => tree.branch === branch))
              refuse("checked-out");
            if ((await git(repo, "rev-parse", "--verify", full)).trim() !== tip)
              refuse("changed");
            const main = (
              await git(
                repo,
                "rev-parse",
                "--verify",
                "refs/remotes/origin/main",
              )
            ).trim();
            if (!sha.test(main) || !(await remoteTips(repo)).includes(main))
              refuse("git-unknown");
            await contained(repo, tip, [main]);
          };
          await validate();
          await perform(item, validate, async () => {
            const output = await command(repo, ["branch", "-d", "--", branch]);
            if (output.code !== 0) refuse("command-failed");
            const remains = await command(
              repo,
              ["show-ref", "--verify", "--quiet", full],
              true,
            );
            if (remains.code !== 1) refuse("command-failed");
          });
        });
      }
      // No plan-side metadata writes. Prune only after successful worktree removals.
      if (
        !input.plan &&
        result.items.some(
          (item) =>
            item.kind === "worktree" &&
            item.status === "removed" &&
            list.some((tree) => tree.path === item.path),
        )
      ) {
        const prune = await command(repo, ["worktree", "prune"]);
        if (prune.code) refuse("command-failed");
      }
    });
  }
  return result;
}
