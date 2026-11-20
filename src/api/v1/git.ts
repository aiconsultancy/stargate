import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Semaphore } from "effect";
import { containsCredential } from "../../credentials";
import { abortable, runAbortable } from "../../effect";
import { readCommand } from "./command";
import type { V1Git } from "./types";

const ttl = 15_000;
const timeout = 2_000;

export function githubRepository(remote: string): string | null {
  const scp = /^(?:[^@/:\s]+@)?github\.com:([^\s]+)$/i.exec(remote);
  const url = URL.parse(remote);
  const path =
    scp?.[1] ??
    (url &&
    ["https:", "ssh:", "git:", "http:"].includes(url.protocol) &&
    url.hostname.toLowerCase() === "github.com" &&
    !url.search &&
    !url.hash
      ? url.pathname.slice(1)
      : "");
  const repo = path.replace(/\/$/, "").replace(/\.git$/, "");
  return /^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i.test(repo) &&
    !/\/\.{1,2}$/.test(repo) &&
    !containsCredential(repo)
    ? repo
    : null;
}

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

async function copyStatusFile(
  source: string,
  target: string,
  signal: AbortSignal,
  optional = false,
) {
  const file = await open(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    if (
      optional &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw error;
  });
  if (!file) return;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error("Git metadata unavailable");
    await pipeline(
      file.createReadStream({ autoClose: false }),
      createWriteStream(target),
      { signal },
    );
    // Git uses the index mtime to decide which same-timestamp files to rehash.
    // Round down so the copy can never make a racy entry appear older.
    await utimes(target, metadata.atime, Math.floor(metadata.mtimeMs / 1_000));
  } finally {
    await file.close();
  }
}

type RunGit = (...args: string[]) => Promise<{ code: number; stdout: string }>;

async function readPushRepository(branch: string, run: RunGit) {
  const config = await run(
    "config",
    "--null",
    "--get-regexp",
    "^(branch\\..*\\.(pushremote|remote)|remote\\.pushdefault)$",
  );
  if (config.code !== 0 && !(config.code === 1 && !config.stdout)) return null;
  const values = new Map<string, string>();
  for (const entry of config.stdout.split("\0")) {
    const separator = entry.indexOf("\n");
    if (separator >= 0)
      values.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  const remote =
    values.get(`branch.${branch}.pushremote`) ??
    values.get("remote.pushdefault") ??
    values.get(`branch.${branch}.remote`);
  let name = remote;
  if (name === undefined) {
    const remotes = await run("remote");
    if (remotes.code !== 0) return null;
    const names = remotes.stdout.trimEnd().split("\n");
    name = names.length === 1 && names[0] ? names[0] : "origin";
  }
  if (!name || name === ".") return null;
  const url = await run("remote", "get-url", "--push", "--", name);
  return url.code === 0 ? githubRepository(url.stdout.trim()) : null;
}

async function readStatus(
  directory: string,
  head: string | undefined,
  signal: AbortSignal,
  run: RunGit,
  runWithEnv: (env: NodeJS.ProcessEnv, ...args: string[]) => ReturnType<RunGit>,
) {
  const [paths, settings] = await Promise.all([
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
      "--show-object-format",
      "--shared-index-path",
    ),
    run("config", "--null", "--get-regexp", statusSettings.source),
  ]);
  const [objects, index, exclude, sparse, format, shared, ...rest] =
    paths.stdout.trimEnd().split("\n");
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
    (format !== "sha1" && format !== "sha256") ||
    (shared &&
      (!isAbsolute(shared) ||
        !/^sharedindex\.[a-f0-9]+$/.test(basename(shared)))) ||
    rest.length
  )
    throw new Error("Git metadata unavailable");

  // Status only sees this repository's config, HEAD, index and object store.
  // Never copy executable settings, hooks, info/attributes or a commondir.
  const gitDir = await mkdtemp(join(tmpdir(), "stargate-git-status-"));
  try {
    await Promise.all([
      mkdir(join(gitDir, "objects", "info"), { recursive: true }),
      mkdir(join(gitDir, "info")),
      mkdir(join(gitDir, "refs")),
    ]);
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
      copyStatusFile(index, join(gitDir, "index"), signal, true),
      copyStatusFile(exclude, join(gitDir, "info", "exclude"), signal, true),
      copyStatusFile(
        sparse,
        join(gitDir, "info", "sparse-checkout"),
        signal,
        true,
      ),
      shared && copyStatusFile(shared, join(gitDir, basename(shared)), signal),
    ]);
    if (files.some((file) => file.status === "rejected"))
      throw new Error("Git metadata unavailable");
    return await runWithEnv(
      {
        GIT_DIR: gitDir,
        GIT_WORK_TREE: directory,
        GIT_ATTR_NOSYSTEM: "1",
        GIT_ATTR_SOURCE: createHash(format).update("tree 0\0").digest("hex"),
      },
      ...statusOptions(settings.stdout),
      "-c",
      "core.attributesFile=/dev/null",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      // Count changed gitlinks without reading submodule worktree configuration.
      "--ignore-submodules=dirty",
    );
  } finally {
    await rm(gitDir, { recursive: true, force: true });
  }
}

async function inspect(
  directory: string,
  now: () => number,
  signal: AbortSignal,
  command: typeof readCommand,
): Promise<V1Git | null> {
  const state: V1Git = {
    branch: null,
    head: null,
    base: null,
    ahead: null,
    behind: null,
    changedFiles: null,
    repository: null,
    checkedAt: now(),
  };
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
  const runWithEnv = async (
    overrides: NodeJS.ProcessEnv,
    ...args: string[]
  ) => {
    deadline.throwIfAborted();
    const result = await command(
      [
        "git",
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
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    }
    const root = await run(
      "rev-parse",
      "--is-inside-work-tree",
      "--show-prefix",
    );
    if (root.code !== 0 || root.stdout !== "true\n\n")
      throw new Error("Checkout root unavailable");
    const [branch, head, fullHead, upstream] = await Promise.all([
      run("symbolic-ref", "-q", "HEAD"),
      run("rev-parse", "--short", "--verify", "HEAD"),
      run("rev-parse", "--verify", "HEAD"),
      run("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"),
    ]);
    const oid = fullHead.code === 0 ? fullHead.stdout.trim() : undefined;
    if (oid !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))
      throw new Error("Git HEAD unavailable");
    const base =
      upstream.code === 0
        ? upstream
        : await run(
            "symbolic-ref",
            "--short",
            "-q",
            "refs/remotes/origin/HEAD",
          );
    const baseRef = base.code === 0 ? base.stdout.trim() : null;
    const changed = await readStatus(directory, oid, deadline, run, runWithEnv);
    const changedFiles =
      changed.code === 0 ? countChangedPaths(changed.stdout) : null;
    if (changedFiles === null || branch.code > 1)
      throw new Error("Git state unavailable");
    const branchRef = branch.code === 0 ? branch.stdout.trim() : "";
    const branchName = branchRef.startsWith("refs/heads/")
      ? safeRef(branchRef.slice("refs/heads/".length))
      : null;
    const [remote, pushRepository] = await Promise.all([
      run("remote", "get-url", "origin"),
      branchName && oid ? readPushRepository(branchName, run) : null,
    ]);
    let counts: ReturnType<typeof parseAheadBehind> = null;
    if (baseRef && head.code === 0) {
      const result = await run(
        "rev-list",
        "--left-right",
        "--count",
        "--end-of-options",
        `${baseRef}...HEAD`,
        "--",
      );
      counts = result.code === 0 ? parseAheadBehind(result.stdout) : null;
      if (!counts) throw new Error("Git comparison unavailable");
    }
    return {
      ...state,
      branch: branchName,
      head:
        head.code === 0 && /^[a-f0-9]{4,64}$/.test(head.stdout.trim())
          ? head.stdout.trim()
          : null,
      base: baseRef ? safeRef(baseRef) : null,
      ...counts,
      changedFiles,
      repository:
        remote.code === 0 ? githubRepository(remote.stdout.trim()) : null,
      pushRepository,
      checkedAt: now(),
    };
  } catch {
    signal.throwIfAborted();
    return {
      ...state,
      checkedAt: now(),
      error: deadline.aborted
        ? "Git read timed out."
        : "Git state unavailable.",
    };
  }
}

export function createGitReader(
  now: () => number = Date.now,
  command = readCommand,
) {
  const permits = Semaphore.makeUnsafe(4);
  const cache = new Map<string, { expiresAt: number; value: V1Git | null }>();
  return (directory: string | undefined, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!directory || !isAbsolute(directory)) return Promise.resolve(null);
    const cached = cache.get(directory);
    if (cached && cached.expiresAt > now())
      return Promise.resolve(cached.value);
    return runAbortable(
      permits.withPermit(
        abortable(async (reading) => {
          const saved = cache.get(directory);
          if (saved && saved.expiresAt > now()) return saved.value;
          const value = await inspect(directory, now, reading, command);
          for (const [path, entry] of cache)
            if (entry.expiresAt <= now()) cache.delete(path);
          cache.set(directory, { expiresAt: now() + ttl, value });
          return value;
        }),
      ),
      signal,
    );
  };
}
