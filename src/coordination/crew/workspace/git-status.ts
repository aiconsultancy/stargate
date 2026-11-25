import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type FleetGitCommand = (
  args: string[],
  env?: NodeJS.ProcessEnv,
) => Promise<{ code: number; stdout: string } | null>;

type ConfigRead =
  | { kind: "value"; value: string }
  | { kind: "no-match" }
  | { kind: "failure" };

async function readConfig(
  run: FleetGitCommand,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<ConfigRead> {
  const result = await run(args, env);

  if (result?.code === 0) {
    return { kind: "value", value: result.stdout };
  }

  return result?.code === 1 && result.stdout === ""
    ? { kind: "no-match" }
    : { kind: "failure" };
}

type FleetHead = { ref: string | null; oid: string | null };

export async function captureFleetHead(
  run: FleetGitCommand,
): Promise<FleetHead> {
  const ref = await run(["symbolic-ref", "-q", "HEAD"]);
  const name = ref?.code === 0 ? ref.stdout.trim() : null;

  if (
    !(ref?.code === 1 && ref.stdout === "") &&
    !(ref?.code === 0 && name?.startsWith("refs/"))
  ) {
    throw new Error("Git HEAD unavailable");
  }

  const revision = await run([
    "rev-parse",
    "--verify",
    "-q",
    "--end-of-options",
    "HEAD^{commit}",
  ]);

  const oid = revision?.stdout.trim();

  if (
    revision?.code === 0 &&
    oid &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)
  ) {
    return { ref: name, oid };
  }

  if (name && revision?.code === 1 && revision.stdout === "") {
    return { ref: name, oid: null };
  }

  throw new Error("Git HEAD unavailable");
}

export async function fleetHeadMatches(
  run: FleetGitCommand,
  before: FleetHead,
) {
  const after = await captureFleetHead(run);

  return before.ref === after.ref && before.oid === after.oid;
}

class UnsafeStatusTemp extends Error {}

async function trustedStatusRoot(path: string, serviceOwned = false) {
  const canonical = await realpath(path).catch(() => {});

  if (!canonical) {
    return;
  }

  const uid = process.getuid?.();
  // Sticky directories protect entries owned by root or the service user.
  let ancestor: string = sep;

  for (const part of canonical.split(sep)) {
    ancestor = join(ancestor, part);
    const info = await lstat(ancestor).catch(() => {});

    if (
      !info?.isDirectory() ||
      (info.uid !== uid &&
        (info.uid !== 0 || (serviceOwned && ancestor === canonical))) ||
      (info.mode & 0o022 && !(info.mode & 0o1000))
    ) {
      return;
    }
  }

  return canonical;
}

export function outsideCheckout(root: string, path: string) {
  const child = relative(root, path);

  return child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child);
}

export async function removeStatusDirectory(path: string) {
  await rm(path, { recursive: true, force: true }).catch(() => {});
}

const statusSettings =
  /^(core\.(filemode|ignorecase|symlinks|precomposeunicode|autocrlf|eol|sparsecheckout|sparsecheckoutcone|checkstat|trustctime|ignorestat)|(diff|status)\.renames)$/;

const statusConfigArgs = [
  "config",
  "--null",
  "--get-regexp",
  statusSettings.source,
];

const excludesConfigArgs = [
  "config",
  "--null",
  "--path",
  "--get",
  "core.excludesFile",
];

/** The ignore file is data, not a status setting to forward unchanged. */
function configuredExcludesPath(directory: string, output: string) {
  const [path, terminator, ...rest] = output.split("\0");

  return path && !/[\r\n]/.test(path) && terminator === "" && rest.length === 0
    ? resolve(directory, path)
    : undefined;
}

export const fleetGitEnv = {
  GIT_ALLOW_PROTOCOL: "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
};

export const fleetGitOptions = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "submodule.recurse=false",
];

/** Run in a private Git directory with no info/attributes or filter config. */
function isolatedGitStatus(
  directory: string,
  gitDir: string,
  format: "sha1" | "sha256",
  config: string,
  excludes: string,
) {
  const settings: string[] = [];

  for (const entry of config.split("\0")) {
    const [key, value = "true", ...rest] = entry.split("\n");

    if (
      key &&
      statusSettings.test(key) &&
      rest.length === 0 &&
      !value.includes("\r")
    ) {
      settings.push("-c", `${key}=${value}`);
    }
  }

  return {
    env: {
      GIT_DIR: gitDir,
      GIT_WORK_TREE: directory,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_ATTR_SOURCE: createHash(format).update("tree 0\0").digest("hex"),
    },
    args: [
      ...settings,
      "-c",
      `core.excludesFile=${excludes}`,
      "-c",
      "core.attributesFile=/dev/null",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      // Count changed gitlinks without reading submodule worktrees.
      "--ignore-submodules=dirty",
    ],
  };
}

type StatusMetadata = {
  format: "sha1" | "sha256";
  objects: string;
  index: string;
  checkoutGit: string;
  commonGit: string;
};

type PatternInstaller = (source: string, target: string) => Promise<unknown>;

export type StatusStorage = {
  parent(root: string): Promise<string>;
  install(
    gitDir: string,
    metadata: StatusMetadata,
  ): Promise<{
    env: NodeJS.ProcessEnv;
    pattern: PatternInstaller;
  }>;
};

const liveStorage: StatusStorage = {
  async parent(root) {
    return (await statusParent(root)).path;
  },
  install(gitDir, metadata) {
    return Promise.resolve({
      env: {
        GIT_OBJECT_DIRECTORY: metadata.objects,
        // Preserve the index timestamp and live split-index lookup.
        GIT_INDEX_FILE: metadata.index,
      },
      pattern: (source, target) => symlink(source, join(gitDir, target)),
    });
  },
};

/** Own the private repository until the reader has handed off its result. */
export class FleetStatusRead {
  private directory?: Promise<string>;

  public async [Symbol.asyncDispose]() {
    const directory = await this.directory?.catch(() => {});

    if (directory) {
      await removeStatusDirectory(directory);
    }
  }

  public async read({
    directory,
    head,
    signal,
    run,
    status = run,
    storage = liveStorage,
  }: {
    directory: string;
    head: string | null;
    signal: AbortSignal;
    run: FleetGitCommand;
    status?: FleetGitCommand;
    storage?: StatusStorage;
  }) {
    const [paths, settings, excludes] = await Promise.all([
      run([
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
      ]),
      readConfig(run, statusConfigArgs),
      readConfig(run, excludesConfigArgs, { HOME: homedir() }),
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
    ] = paths?.stdout.replace(/\n$/, "").split("\n") ?? [];

    if (
      paths?.code !== 0 ||
      settings.kind === "failure" ||
      excludes.kind === "failure" ||
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
      rest.length > 0
    ) {
      throw new Error("Git metadata unavailable");
    }

    const configured =
      excludes.kind === "value"
        ? configuredExcludesPath(directory, excludes.value)
        : undefined;

    if (excludes.kind === "value" && !configured) {
      throw new Error("Invalid Git excludes path");
    }

    const parent = await storage.parent(await realpath(directory));

    signal.throwIfAborted();

    if (this.directory) {
      throw new Error("Status repository already in use");
    }

    this.directory = mkdtemp(join(parent, statusDirectoryPrefix));
    const gitDir = await this.directory;
    await mkdir(join(gitDir, "info"));
    await mkdir(join(gitDir, "refs"));
    await writeFile(
      join(gitDir, "HEAD"),
      head ? `${head}\n` : "ref: refs/heads/unborn\n",
    );
    await writeFile(
      join(gitDir, "config"),
      format === "sha256"
        ? "[core]\nrepositoryformatversion = 1\n[extensions]\nobjectformat = sha256\n"
        : "[core]\nrepositoryformatversion = 0\n",
    );

    const { env, pattern } = await storage.install(gitDir, {
      format,
      objects,
      index,
      checkoutGit,
      commonGit,
    });

    const configuredTarget = "info/configured-excludes";

    const files = await Promise.allSettled([
      pattern(exclude, "info/exclude"),
      pattern(sparse, "info/sparse-checkout"),
      configured ? pattern(configured, configuredTarget) : undefined,
    ]);

    for (const file of files) {
      if (file.status === "rejected") {
        throw file.reason;
      }
    }

    signal.throwIfAborted();

    const isolated = isolatedGitStatus(
      directory,
      gitDir,
      format,
      settings.kind === "value" ? settings.value : "",
      configured ? join(gitDir, configuredTarget) : "/dev/null",
    );

    return status(isolated.args, { ...isolated.env, ...env });
  }
}

/** Bind all live checkout reads to the captain's directory and cancellation. */
export function liveFleetGit(directory: string, signal: AbortSignal) {
  const command = async (
    args: string[],
    overrides?: NodeJS.ProcessEnv,
    limit?: number,
  ) => {
    const result = await spawnGit(
      directory,
      [...fleetGitOptions, ...args],
      { PATH: process.env["PATH"], LC_ALL: "C", ...fleetGitEnv, ...overrides },
      { signal, limit },
    );

    signal.throwIfAborted();

    return result.truncated || result.code === null
      ? null
      : { code: result.code, stdout: result.stdout };
  };

  return {
    command,
    head: () => captureFleetHead(command),
    headMatches: (head: FleetHead) => fleetHeadMatches(command, head),
    async status(head: string | null) {
      await using checkout = new FleetStatusRead();

      try {
        const status = await checkout.read({
          directory,
          head,
          signal,
          run: command,
          status: (args, env) => command(args, env, 16 * 1024 * 1024),
        });

        return status?.code === 0
          ? { kind: "value" as const, stdout: status.stdout }
          : { kind: "unavailable" as const };
      } catch (error) {
        signal.throwIfAborted();

        return {
          kind:
            error instanceof UnsafeStatusTemp
              ? ("unsafe-temp" as const)
              : ("unavailable" as const),
        };
      }
    },
  };
}

/** Reads are bounded. A write is never killed by a timer: SIGKILL mid-write
 * can leave index.lock or a partial result. Only an explicit caller signal
 * stops it; ambiguous writes are reported, never retried or rolled back.
 */
export function gitProcessOptions(write: boolean, signal?: AbortSignal) {
  return {
    ...(signal && { signal }),
    ...(!write && { timeout: 60_000 }),
    killSignal: "SIGKILL" as const,
  };
}

export function spawnGit(
  directory: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: {
    limit?: number | undefined;
    signal?: AbortSignal | undefined;
    write?: boolean;
  },
): Promise<{ stdout: string; code: number | null; truncated: boolean }> {
  const limit = options.limit ?? 1024 * 1024;

  return new Promise((resolve) => {
    const child = spawn("git", ["-C", directory, ...args], {
      cwd: directory,
      env,
      stdio: ["ignore", "pipe", "ignore"],
      ...gitProcessOptions(!!options.write, options.signal),
    });

    const chunks: Buffer[] = [];
    let length = 0;
    let truncated = false;
    let failed = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) {
        return;
      }

      if (length + chunk.length > limit) {
        chunks.push(chunk.subarray(0, limit - length));
        truncated = true;
        child.kill("SIGKILL");

        return;
      }

      chunks.push(chunk);
      length += chunk.length;
    });
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(chunks).toString("utf8"),
        code: failed ? null : code,
        truncated,
      });
    });
  });
}

const statusDirectoryName = "stargate-git-status";
export const statusDirectoryPrefix = `${statusDirectoryName}-`;

function fileError(error: unknown) {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

export async function statusDataDirectory(dataDirectory: string) {
  const canonical = await trustedStatusRoot(dataDirectory, true);

  return canonical && join(canonical, statusDirectoryName);
}

export async function statusParent(
  root: string,
  {
    dataDirectory,
    temporaryDirectory = tmpdir,
    retainedTemporary,
  }: {
    dataDirectory?: string | undefined;
    temporaryDirectory?: () => string;
    retainedTemporary?: (() => Promise<string | undefined>) | undefined;
  } = {},
) {
  if (dataDirectory) {
    try {
      const parent = await statusDataDirectory(dataDirectory);

      if (parent && outsideCheckout(root, parent)) {
        await mkdir(parent, { mode: 0o700 }).catch((error: unknown) => {
          if (fileError(error) !== "EEXIST") {
            throw error;
          }
        });

        if (await privateStatusDirectory(parent)) {
          return { path: parent, kind: "ready" as const };
        }
      }
    } catch (error) {
      if (
        !["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EROFS"].includes(
          String(fileError(error)),
        )
      ) {
        throw error;
      }
    }
  }

  const retained = await retainedTemporary?.();
  const temporary = retained ?? (await trustedStatusRoot(temporaryDirectory()));

  if (!temporary || !outsideCheckout(root, temporary)) {
    throw new UnsafeStatusTemp();
  }

  return {
    path: temporary,
    kind: retained === undefined ? ("lease" as const) : ("ready" as const),
  };
}

export async function privateStatusDirectory(path: string) {
  const metadata = await lstat(path).catch(() => {});

  if (
    metadata?.isDirectory() &&
    (metadata.mode & 0o777) === 0o700 &&
    metadata.uid === process.getuid?.()
  ) {
    return metadata;
  }

  return;
}
