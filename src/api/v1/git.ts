import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
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

function disabledFilters(output: string): NodeJS.ProcessEnv {
  if (!output) return {};
  const keys = output.split("\0");
  if (keys.pop() !== "" || output.includes("\uFFFD"))
    throw new Error("Git filter names unavailable");
  const drivers = new Set<string>();
  for (const key of keys) {
    const separator = key.lastIndexOf(".");
    if (separator < "filter.".length)
      throw new Error("Git filter name unavailable");
    drivers.add(key.slice(0, separator));
  }
  // Separate keys from values so even a subsection containing '=' is literal.
  const env: NodeJS.ProcessEnv = {};
  let index = 0;
  for (const driver of drivers) {
    for (const [option, value] of [
      ["clean", ""],
      ["smudge", ""],
      ["process", ""],
      ["required", "false"],
    ]) {
      env[`GIT_CONFIG_KEY_${index}`] = `${driver}.${option}`;
      env[`GIT_CONFIG_VALUE_${index}`] = value;
      index++;
    }
  }
  env["GIT_CONFIG_COUNT"] = String(index);
  return env;
}

async function inspect(
  directory: string,
  now: () => number,
  signal: AbortSignal,
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
    const result = await readCommand(
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
    const branch = await run("symbolic-ref", "--short", "-q", "HEAD");
    const head = await run("rev-parse", "--short", "--verify", "HEAD");
    const upstream = await run(
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    );
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
    const filters = await run(
      "config",
      "--null",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process|required)$",
    );
    if (filters.code !== 0 && !(filters.code === 1 && !filters.stdout))
      throw new Error("Git filter names unavailable");
    const changed = await runWithEnv(
      disabledFilters(filters.stdout),
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      // Count changed gitlinks without reading submodule worktree configuration.
      "--ignore-submodules=dirty",
    );
    const changedFiles =
      changed.code === 0 ? countChangedPaths(changed.stdout) : null;
    if (changedFiles === null || branch.code > 1)
      throw new Error("Git state unavailable");
    const remote = await run("remote", "get-url", "origin");
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
      branch: branch.code === 0 ? safeRef(branch.stdout.trim()) : null,
      head:
        head.code === 0 && /^[a-f0-9]{4,64}$/.test(head.stdout.trim())
          ? head.stdout.trim()
          : null,
      base: baseRef ? safeRef(baseRef) : null,
      ...counts,
      changedFiles,
      repository:
        remote.code === 0 ? githubRepository(remote.stdout.trim()) : null,
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

export function createGitReader(now: () => number = Date.now) {
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
          const value = await inspect(directory, now, reading);
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
