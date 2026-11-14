/**
 * File-system trust of the Codex backend. Pogo's launcher and the Codex CLI
 * run outside the Codex sandbox with the proxy key, so nothing that they run
 * or read may be writable from inside the sandbox. This module has no SDK
 * import, so `pogo config check` can use it.
 */
import { constants, type Stats } from "node:fs";
import {
  access,
  lstat,
  readdir,
  readlink,
  realpath,
  stat,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackendConfig, Config } from "../config";

type CodexConfig = Extract<BackendConfig, { type: "codex" }>;

const codexTargets: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
};

/**
 * The native CLI that the SDK itself would start, found the same way:
 * through the SDK's `@openai/codex` dependency and its platform package.
 * `helpers` holds commands such as `rg` that the SDK puts first on `PATH`.
 * `packages` are the package directories whose code runs.
 */
export function nativeCodex() {
  const platform = `${process.platform}-${process.arch}`;
  const target = codexTargets[platform];
  if (!target) throw new Error(`Codex CLI is not available for ${platform}`);
  const entry = import.meta.resolve("@openai/codex-sdk");
  const sdk = createRequire(entry);
  const cliPackage = sdk.resolve("@openai/codex/package.json");
  const nativePackage = createRequire(cliPackage).resolve(
    `@openai/codex-${platform}/package.json`,
  );
  const root = join(dirname(nativePackage), "vendor", target);
  return {
    executable: join(root, "bin", "codex"),
    helpers: join(root, "codex-path"),
    packages: [
      dirname(
        dirname(entry.startsWith("file:") ? fileURLToPath(entry) : entry),
      ),
      dirname(cliPackage),
      dirname(nativePackage),
    ],
  };
}

/** Pogo's own installation: the directory that holds `src/`. */
const installation = resolve(import.meta.dir, "..", "..");

/**
 * The real path of `path` after symlink resolution, also when it does not
 * exist yet: the nearest existing ancestor is resolved.
 */
export async function realPath(path: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = dirname(current);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === current)
        throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** True when this process can write `directory`. */
async function writable(directory: string) {
  return access(directory, constants.W_OK).then(
    () => true,
    () => false,
  );
}

/**
 * Resolves the absolute `path` one component at a time, following every
 * symbolic link, and calls `visit` for each component met (directories,
 * links and the final entry) with its path, `lstat` result and directory.
 * A missing component ends the walk; its directory was visited. Returns
 * the canonical path. `cache` shares `lstat` results between walks.
 */
async function walk(
  path: string,
  visit: (
    path: string,
    entry: Stats,
    directory: string,
  ) => Promise<void> | void,
  cache = new Map<string, Stats | undefined>(),
): Promise<string> {
  if (!path.startsWith("/")) throw new Error("Codex paths must be absolute");
  const pending = path.split("/").filter(Boolean);
  let resolved = "/";
  for (let links = 0; pending.length > 0; ) {
    const name = pending.shift() ?? "";
    if (name === ".") continue;
    if (name === "..") {
      resolved = dirname(resolved);
      continue;
    }
    const next = join(resolved, name);
    if (!cache.has(next))
      cache.set(
        next,
        await lstat(next).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        }),
      );
    const entry = cache.get(next);
    if (!entry) return join(next, ...pending);
    await visit(next, entry, resolved);
    if (!entry.isSymbolicLink()) {
      resolved = next;
      continue;
    }
    if (++links > 40) throw new Error("Codex path has too many links");
    const target = await readlink(next);
    if (target.startsWith("/")) resolved = "/";
    pending.unshift(...target.split("/").filter(Boolean));
  }
  return resolved;
}

/**
 * The canonical form of the absolute `path`. Pogo then writes, checks and
 * runs only this form, so no symbolic link is followed again later. Fails
 * closed when a symbolic link on the way could be changed afterwards: when
 * its directory is writable by Pogo's user or lies inside one of the
 * canonical writable `roots`. Missing trailing components are kept.
 */
export async function trustedPath(
  path: string,
  roots: readonly string[] = [],
): Promise<string> {
  return walk(path, async (_, entry, directory) => {
    if (
      entry.isSymbolicLink() &&
      ((await writable(directory)) ||
        roots.some((root) => within(directory, root)))
    )
      throw new Error(
        "Codex paths must not pass through a symbolic link that Pogo's user or the sandbox can change",
      );
  });
}

/**
 * True when every component on the full link chain of `path`, and the
 * entry it resolves to, belongs to root and is not group- or
 * world-writable (the mode of a link means nothing). Only root can then
 * change what `path` runs.
 */
async function rootChain(path: string, cache?: Map<string, Stats | undefined>) {
  return walk(
    path,
    (_, entry) => {
      if (
        entry.uid !== 0 ||
        (!entry.isSymbolicLink() && (entry.mode & 0o022) !== 0)
      )
        throw new Error("not root-controlled");
    },
    cache,
  ).then(
    () => true,
    () => false,
  );
}

/** True when no component of the absolute `path` is a symbolic link. */
export async function linkFree(path: string) {
  for (let current = path; ; current = dirname(current)) {
    if ((await lstat(current)).isSymbolicLink()) return false;
    if (dirname(current) === current) return true;
  }
}

/** True when `path` is `root` or below it. Both are real paths. */
export function within(path: string, root: string) {
  return (
    path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`)
  );
}

/** The directories that tool commands can write: Codex's writable roots. */
export function writableRoots(config: CodexConfig, temporary?: string) {
  if (config.sandbox === "read-only") return [];
  return [config.directory, ...(temporary ? [temporary] : [])];
}

/**
 * Refuses a backend whose sandbox can write what runs or is read outside
 * it: Pogo's data directory (the launcher, `CODEX_HOME`, `ZDOTDIR`, thread
 * maps), Pogo's installation, the SDK and CLI packages, and the home
 * directory (start-up files of unsandboxed commands such as git). A
 * writable root may neither contain nor lie inside the first four; it may
 * lie inside the home directory but not contain it. `temporary` is the
 * turn's new private TMPDIR, a writable root that only must not contain
 * them. `danger-full-access` has no sandbox and nothing to protect.
 */
export async function checkCodexPaths(
  config: CodexConfig,
  data: string,
  temporary?: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (config.sandbox !== "workspace-write") return;
  const directory = await realPath(config.directory);
  const turn = temporary ? await realPath(temporary) : undefined;
  const named: [string, string[]][] = [
    ["Pogo's data directory", [data]],
    ["Pogo's installation", [installation]],
    ["the Codex SDK and CLI", nativeCodex().packages],
  ];
  for (const [name, paths] of named)
    for (const path of await Promise.all(paths.map(realPath))) {
      if (within(path, directory) || within(directory, path))
        throw new Error(
          `Codex workspace-write directory must not contain or be inside ${name}`,
        );
      if (turn && within(path, turn))
        throw new Error(`Codex turn TMPDIR must not contain ${name}`);
    }
  const home = env["HOME"];
  if (home && within(await realPath(home), directory))
    throw new Error(
      "Codex workspace-write directory must not contain the home directory",
    );
}

/** Every Codex backend of a configuration, for `pogo config check`. */
export async function checkCodexConfiguration(config: Config, path: string) {
  const data = resolve(dirname(resolve(path)), config.dataDirectory);
  const backends = [
    ...config.bots.map((bot) => bot.backend),
    ...config.irc.flatMap((irc) => [
      irc.backend,
      ...irc.crew.map((member) => member.backend),
    ]),
  ];
  for (const backend of backends) {
    if (backend.type !== "codex") continue;
    const roots =
      backend.sandbox === "read-only"
        ? []
        : [await trustedPath(backend.directory)];
    if (backend.sandbox === "workspace-write") await trustedPath(data, roots);
    await checkCodexPaths(backend, data);
    await codexSearchPath(backend.extraPath, undefined, roots);
  }
}

/** System directories that the CLI's `PATH` can hold, in this order. */
export const searchDirectories = ["/usr/local/bin", "/usr/bin", "/bin"];

/**
 * A system directory for `PATH` in canonical form, or why it is left out:
 * the directory and every program in it must be root-controlled over their
 * full link chains, so no program found there can lead outside root's
 * control. One program that fails leaves out the whole directory.
 */
async function systemDirectory(
  path: string,
): Promise<{ path: string } | { reason: string }> {
  if (!(await lstat(path).catch(() => undefined))) return { reason: "missing" };
  const cache = new Map<string, Stats | undefined>();
  if (!(await rootChain(path, cache))) return { reason: "not root-controlled" };
  const real = await realpath(path);
  if (!(await stat(real)).isDirectory()) return { reason: "not a directory" };
  for (const name of await readdir(real))
    if (!(await rootChain(join(real, name), cache)))
      return { reason: `${name} in it is not root-controlled` };
  return { path: real };
}

/**
 * The qualifying system directories among `directories`, in canonical form
 * without duplicates, and why each other one is left out.
 */
export async function systemDirectories(
  directories: readonly string[] = searchDirectories,
) {
  const found: string[] = [];
  const reasons: string[] = [];
  for (const directory of directories) {
    const result = await systemDirectory(directory).catch(() => ({
      reason: "unreadable",
    }));
    if ("reason" in result) reasons.push(`${directory}: ${result.reason}`);
    else if (!found.includes(result.path)) found.push(result.path);
  }
  return { found, reasons };
}

/**
 * An `extraPath` directory, in canonical form. It is trusted operator
 * input, but it must not be reached through a symbolic link that Pogo's
 * user or the sandbox can change, must not lie inside a writable root, and
 * no program in it may lead into a writable root: neither a link on its
 * chain nor the file it runs may lie inside one.
 */
async function extraDirectory(path: string, roots: readonly string[]) {
  const real = await trustedPath(path, roots);
  if (!(await stat(real).catch(() => undefined))?.isDirectory())
    throw new Error("Codex extraPath entries must be existing directories");
  const inside = (candidate: string) =>
    roots.some((root) => within(candidate, root));
  if (inside(real))
    throw new Error("Codex extraPath must not be inside a writable directory");
  for (const name of await readdir(real)) {
    const target = await walk(join(real, name), (_, entry, directory) => {
      if (entry.isSymbolicLink() && inside(directory))
        throw new Error(
          "Codex extraPath programs must not link through a writable directory",
        );
    });
    if (inside(target))
      throw new Error(
        "Codex extraPath programs must not run from a writable directory",
      );
  }
  return real;
}

/**
 * The fixed `PATH` of the CLI and its tool commands, built at start-up:
 * the SDK's helper directory, then `/usr/local/bin`, `/usr/bin` and `/bin`
 * when root controls them and every program in them (see
 * `systemDirectory`), then the backend's `extraPath`. The operator's own
 * `PATH` is never inherited. Fails, naming the reasons, when neither a
 * system directory nor `extraPath` provides a command directory: tool
 * commands could then run nothing. `directories` replaces the system list
 * in tests.
 */
export async function codexSearchPath(
  extra: readonly string[],
  helpers: string | undefined,
  roots: readonly string[],
  directories: readonly string[] = searchDirectories,
) {
  const system = await systemDirectories(directories);
  if (system.found.length === 0 && extra.length === 0)
    throw new Error(
      `Codex found no root-controlled system directory for PATH (${system.reasons.join("; ")}). Make root own those programs, or list directories that you trust in the backend's extraPath.`,
    );
  const entries: string[] = helpers ? [helpers] : [];
  for (const directory of system.found)
    if (!entries.includes(directory)) entries.push(directory);
  for (const directory of extra) {
    const real = await extraDirectory(directory, roots);
    if (!entries.includes(real)) entries.push(real);
  }
  return entries.join(":");
}

/** Fixed system directories for the launcher's utilities. */
const utilityDirectories = ["/usr/bin", "/bin"];

/**
 * Every component of `path`, as written, belongs to root, and none but
 * symbolic links (whose mode means nothing) is group- or world-writable.
 */
async function rootControlled(path: string) {
  for (let current = path; ; current = dirname(current)) {
    const entry = await lstat(current);
    if (
      entry.uid !== 0 ||
      (!entry.isSymbolicLink() && (entry.mode & 0o022) !== 0)
    )
      return false;
    if (dirname(current) === current) return true;
  }
}

/**
 * Absolute paths of `sh`, `mkfifo`, `cat` and `rm` in `/usr/bin` or `/bin`.
 * Each path as written and the file it resolves to are root-controlled, so
 * only root can change what runs. The canonical path is used, except when
 * it has another name (`/usr/bin/rm` → `gnurm`, `/bin/cat` → `busybox`):
 * such programs can select their behaviour by name, so the root-controlled
 * path as written is kept. The launcher runs before the sandbox, with the
 * key in its environment, so it never looks commands up through `PATH`.
 */
export async function trustedUtilities(
  directories: readonly string[] = utilityDirectories,
) {
  const found: Record<string, string> = {};
  for (const name of ["sh", "mkfifo", "cat", "rm"]) {
    for (const directory of directories) {
      const candidate = join(directory, name);
      if (!(await lstat(candidate).catch(() => undefined))) continue;
      const real = await realpath(candidate);
      if (
        /^\/[A-Za-z0-9._+/-]+$/.test(candidate) &&
        (await stat(real)).isFile() &&
        (await rootControlled(candidate)) &&
        (await rootControlled(real))
      ) {
        found[name] =
          basename(real) === name && /^\/[A-Za-z0-9._+/-]+$/.test(real)
            ? real
            : candidate;
        break;
      }
    }
    if (!found[name])
      throw new Error(
        `Codex backend needs a root-owned ${name} in ${directories.join(" or ")}`,
      );
  }
  return found as Record<"sh" | "mkfifo" | "cat" | "rm", string>;
}
