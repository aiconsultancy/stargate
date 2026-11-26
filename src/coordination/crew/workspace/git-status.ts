import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

async function captureFleetHead(run: FleetGitCommand): Promise<FleetHead> {
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

/**
 * Classify even a failed sample against the checkout it started on. A good
 * sample followed by an unreadable HEAD counts as a move, so it is not cached.
 */
export async function guardFleetHead<T>(
  run: FleetGitCommand,
  deadline: () => AbortSignal,
  sample: (head: FleetHead) => Promise<T>,
) {
  const before = await captureFleetHead(run);
  const [result] = await Promise.allSettled([sample(before)]);
  deadline().throwIfAborted();

  const after = await captureFleetHead(run).catch(() => {
    deadline().throwIfAborted();

    // An unreadable HEAD must not erase a more specific sample failure.
    if (result.status === "rejected") {
      throw result.reason;
    }

    // After a good sample, HEAD may be mid-move: a move, not a stable failure.
    return null;
  });

  deadline().throwIfAborted();

  if (!after || before.ref !== after.ref || before.oid !== after.oid) {
    return { kind: "moved" as const };
  }

  if (result.status === "rejected") {
    throw result.reason;
  }

  return { kind: "sample" as const, value: result.value };
}

class UnsafeStatusTemp extends Error {}

export async function trustedStatusRoot(path: string, serviceOwned = false) {
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

const statusArgs = [
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=all",
  // Count changed gitlinks without reading submodule worktrees.
  "--ignore-submodules=dirty",
];

/** Run in a private Git directory with no info/attributes or filter config. */
function isolatedGit({
  directory,
  gitDir,
  format,
  config,
  excludes,
}: {
  directory: string;
  gitDir: string;
  format: "sha1" | "sha256";
  /** The checkout's status settings, as `git config -z` output. */
  config: string;
  /** The ignore file to use as `core.excludesFile`. */
  excludes: string;
}) {
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
    options: [
      ...settings,
      "-c",
      `core.excludesFile=${excludes}`,
      "-c",
      "core.attributesFile=/dev/null",
    ],
  };
}

/** A command's arguments and environment in the private Git directory. */
export type IsolatedCheckout = {
  /** The checkout's own index, for the fingerprint. */
  index: string;
  objects: string;
  gitDir: string;
  format: "sha1" | "sha256";
  command(args: string[]): { args: string[]; env: NodeJS.ProcessEnv };
};

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
    return statusParent(root);
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

type StatusOpenOptions = {
  directory: string;
  head: string | null;
  signal: AbortSignal;
  run: FleetGitCommand;
  storage?: StatusStorage | undefined;
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
    status,
    ...options
  }: StatusOpenOptions & { status?: FleetGitCommand }) {
    const isolated = await this.open(options);
    const { args, env } = isolated.command(statusArgs);

    return (status ?? options.run)(args, env);
  }

  /** Set up the private repository, which lives until disposal. */
  public async open({
    directory,
    head,
    signal,
    run,
    storage = liveStorage,
  }: StatusOpenOptions): Promise<IsolatedCheckout> {
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

    const isolated = isolatedGit({
      directory,
      gitDir,
      format,
      config: settings.kind === "value" ? settings.value : "",
      excludes: configured ? join(gitDir, configuredTarget) : "/dev/null",
    });

    return {
      index,
      objects,
      gitDir,
      format,
      command: (args) => ({
        args: [...isolated.options, ...args],
        env: { ...isolated.env, ...env },
      }),
    };
  }
}

type FleetGitProcess = (
  directory: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { signal: AbortSignal; limit?: number | undefined },
) => Promise<{
  stdout: string;
  bytes: Buffer;
  code: number | null;
  truncated: boolean;
}>;

type FleetGitStream = (
  directory: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: {
    signal: AbortSignal;
    onData: (chunk: Buffer) => boolean;
    input?: string | Buffer | undefined;
  },
) => Promise<number | null>;

/** Streams a command's output; null when stopped or killed. */
export type IsolatedStream = (
  args: string[],
  env: NodeJS.ProcessEnv,
  onData: (chunk: Buffer) => boolean,
  input?: string | Buffer,
) => Promise<number | null>;

const environment = (overrides?: NodeJS.ProcessEnv) => ({
  PATH: process.env["PATH"],
  LC_ALL: "C",
  ...fleetGitEnv,
  ...overrides,
});

/** Bind all live checkout reads to the captain's directory and cancellation. */
export function liveFleetGit(
  spawnGit: FleetGitProcess,
  streamGit?: FleetGitStream,
) {
  return (directory: string, signal: AbortSignal) => {
    const run = async (
      args: string[],
      overrides?: NodeJS.ProcessEnv,
      limit?: number,
    ) => {
      const result = await spawnGit(
        directory,
        [...fleetGitOptions, ...args],
        environment(overrides),
        { signal, limit },
      );

      signal.throwIfAborted();

      return result.truncated || result.code === null
        ? null
        : { code: result.code, stdout: result.stdout, bytes: result.bytes };
    };

    const command = async (
      args: string[],
      overrides?: NodeJS.ProcessEnv,
      limit?: number,
    ) => {
      const result = await run(args, overrides, limit);

      return result && { code: result.code, stdout: result.stdout };
    };

    const stream: IsolatedStream = async (args, env, onData, input) => {
      if (!streamGit) {
        throw new Error("Git streaming unavailable");
      }

      const code = await streamGit(
        directory,
        [...fleetGitOptions, ...args],
        environment(env),
        { signal, onData, input },
      );

      signal.throwIfAborted();

      return code;
    };

    return {
      command,
      guard: <T>(sample: (head: FleetHead) => Promise<T>) =>
        guardFleetHead(command, () => signal, sample),
      /** Run `use` in a private repository for `head`, removed afterwards. */
      async isolated<T>(
        head: string | null,
        use: (checkout: IsolatedCheckout, stream: IsolatedStream) => Promise<T>,
      ) {
        await using checkout = new FleetStatusRead();

        const isolated = await checkout.open({
          directory,
          head,
          signal,
          run: command,
        });

        return await use(isolated, stream);
      },
      async status(head: string | null) {
        await using checkout = new FleetStatusRead();

        try {
          let index = "";
          let raw: Buffer | undefined;

          const status = await checkout.read({
            directory,
            head,
            signal,
            run: command,
            status: async (args, env) => {
              index = env?.["GIT_INDEX_FILE"] ?? "";
              const result = await run(args, env, 16 * 1024 * 1024);
              raw = result?.bytes;

              return result;
            },
          });

          // The raw output keeps paths that are not valid UTF-8 apart.
          return status?.code === 0 && raw
            ? { kind: "value" as const, stdout: status.stdout, raw, index }
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
  };
}

export const statusDirectoryName = "stargate-git-status";
export const statusDirectoryPrefix = `${statusDirectoryName}-`;

function fileError(error: unknown) {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

/**
 * The trusted temporary directory, or a private folder already made in it,
 * that holds status repositories. It must resolve outside the checkout, so
 * status never runs inside it.
 */
export async function statusParent(
  root: string,
  {
    temporaryDirectory = tmpdir,
    retained,
  }: {
    temporaryDirectory?: (() => string) | undefined;
    retained?: string | undefined;
  } = {},
) {
  const temporary = retained ?? (await trustedStatusRoot(temporaryDirectory()));

  if (!temporary || !outsideCheckout(root, temporary)) {
    throw new UnsafeStatusTemp();
  }

  return temporary;
}

/** Repository-relative, inside the worktree and outside any `.git`. */
export function validDiffPath(path: string) {
  const parts = path.split("/");

  return (
    !/[\p{Cc}\\]/u.test(path) &&
    parts.every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        part.toLowerCase() !== ".git",
    )
  );
}

/** A refused or vanished path is absent, not a failure. */
const absentPath = (error: unknown): undefined => {
  if (!["ENOENT", "ENOTDIR", "ELOOP"].includes(String(fileError(error)))) {
    throw error;
  }
};

/** A worktree file changed while it was read: the answer is stale. */
export class WorktreeChanged extends Error {
  public constructor() {
    super("File shrank while read");
  }
}

/** Read up to a page at `offset`, or undefined when it starts past the end. */
async function readPage(
  file: FileHandle,
  size: number,
  offset: number,
  limit: number,
) {
  if (offset > size) {
    return;
  }

  const data = Buffer.alloc(Math.min(limit, size - offset));
  let filled = 0;

  while (filled < data.length) {
    const { bytesRead } = await file.read(
      data,
      filled,
      data.length - filled,
      offset + filled,
    );

    if (bytesRead === 0) {
      throw new WorktreeChanged();
    }

    filled += bytesRead;
  }

  return { size, data };
}

/** `base` and the path parts below it, as bytes that need not be UTF-8. */
const below = (base: string, parts: Buffer[]) =>
  Buffer.concat([
    Buffer.from(base),
    ...parts.flatMap((part) => [Buffer.from("/"), part]),
  ]);

/** A path's parts, split at each `/` byte. */
function pathParts(path: Buffer) {
  const parts: Buffer[] = [];
  let start = 0;

  for (let slash = path.indexOf(0x2f); slash >= 0;) {
    parts.push(path.subarray(start, slash));
    start = slash + 1;
    slash = path.indexOf(0x2f, start);
  }

  return [...parts, path.subarray(start)];
}

/**
 * Run `use` on a worktree path, given by the bytes Git wrote, whose
 * directories were each opened relative to their parent without following
 * links, so the path cannot leave the worktree. Undefined for an invalid
 * path or a missing or linked directory.
 */
async function inWorktree<T>(
  root: string,
  path: Buffer,
  use: (target: Buffer, real: string) => Promise<T | undefined>,
) {
  // Checked decoded: an invalid byte decodes to U+FFFD, never `/` or `.`.
  if (!validDiffPath(path.toString("utf8"))) {
    return;
  }

  const real = await realpath(root);
  const parts = pathParts(path);
  const name = parts.pop() ?? Buffer.alloc(0);
  const linux = process.platform === "linux";
  let parent = await open(real, constants.O_RDONLY | constants.O_DIRECTORY);

  try {
    for (const [index, part] of parts.entries()) {
      const next = await open(
        linux
          ? below(`/proc/self/fd/${parent.fd}`, [part])
          : below(real, parts.slice(0, index + 1)),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
      ).catch(absentPath);

      if (!next) {
        return;
      }

      await parent.close();
      parent = next;
    }

    return await use(
      linux
        ? below(`/proc/self/fd/${parent.fd}`, [name])
        : below(real, [...parts, name]),
      real,
    );
  } finally {
    await parent.close();
  }
}

/** A worktree path's own size, never through a linked directory. */
export const worktreeSize = (root: string, path: Buffer) =>
  inWorktree(
    root,
    path,
    async (target) => (await lstat(target).catch(absentPath))?.size,
  );

/**
 * A worktree file's bytes, or a symbolic link's own text, never through a
 * linked directory; the opened file's real path is checked as well.
 */
export function readWorktree(
  root: string,
  path: Buffer,
  offset: number,
  limit: number,
) {
  const linux = process.platform === "linux";

  return inWorktree(root, path, async (target, real) => {
    const info = await lstat(target).catch(absentPath);

    if (info?.isSymbolicLink()) {
      const text = await readlink(target, { encoding: "buffer" }).catch(
        absentPath,
      );

      if (!text || offset > text.length) {
        return;
      }

      return {
        size: text.length,
        data: text.subarray(offset, offset + limit),
      };
    }

    if (!info?.isFile()) {
      return;
    }

    const file = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch(absentPath);

    if (!file) {
      return;
    }

    try {
      const opened = await file.stat();

      const where = linux
        ? await readlink(`/proc/self/fd/${file.fd}`)
        : await realpath(target);

      if (
        !opened.isFile() ||
        dirname(where) === where ||
        !where.startsWith(`${real}${sep}`)
      ) {
        return;
      }

      return await readPage(file, opened.size, offset, limit);
    } finally {
      await file.close();
    }
  });
}
