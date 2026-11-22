import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Schema } from "effect";
import {
  settingsDefault,
  settingsPattern,
  settingsStartsWith,
  settingsStruct,
} from "../../config/settings-schema";
import { CrewError } from "../state";
import { agentIDSchema } from "../team";

const expected = settingsStruct({
  head: Schema.String.check(settingsPattern(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)),
  fingerprint: Schema.String.check(settingsPattern(/^[a-f0-9]{64}$/)),
  taskID: Schema.NullOr(
    Schema.String.check(
      settingsStartsWith("task_"),
      Schema.isMaxCodePoints(100),
    ),
  ),
});
/** Captain-only, configured worker worktree only. Copy expected from inspect. */
export const workspaceInputSchemas = [
  settingsStruct({
    op: Schema.Literal("workspace"),
    crew: agentIDSchema,
    patch: Schema.Boolean.pipe(settingsDefault(false)),
  }),
  settingsStruct({
    op: Schema.Literal("stash"),
    crew: agentIDSchema,
    expected,
    acknowledgeUnconfirmedExecution: Schema.optional(Schema.Literal(true)),
  }),
  settingsStruct({
    op: Schema.Literal("reset"),
    crew: agentIDSchema,
    expected,
    acknowledgeDiscard: Schema.Literal(true),
    acknowledgeUnconfirmedExecution: Schema.optional(Schema.Literal(true)),
  }),
] as const;
export type WorkspaceInput = (typeof workspaceInputSchemas)[number]["Type"];
export type WorkspaceChange = {
  path: string;
  index: string;
  worktree: string;
  kind: "tracked" | "unmerged" | "untracked";
};
export type WorkspaceInspection = {
  crew: string;
  directory: string;
  head: string;
  branch: string | null;
  /** Covers HEAD, index, worktree and untracked bytes; ignored files excluded. */
  fingerprint: string;
  changes: WorkspaceChange[];
  changeCount: number;
  truncated: boolean;
  /** Submodule or nested repository present; stash/reset refuse it. */
  nested: boolean;
  diffstat: { path: string; added: number | null; deleted: number | null }[];
  patch?: { text: string; truncated: boolean; excluded: string[] };
};
export type WorkspaceCheckpoint = {
  oid: string;
  message: string;
  restore: string;
};

const listLimit = 100;
const hashLimit = 64 * 1024 * 1024;
const patchLimit = 32 * 1024;
// Same patterns the crew read policy denies; never put them in a patch.
const secretPaths = ["*.env", "*.env.*", "*.key", "*.pem"];

/** Reads are bounded. A write is never killed by a timer: SIGKILL mid-write
 * can leave index.lock or a partial result. Only an explicit caller signal
 * stops it; ambiguous writes are reported, never retried or rolled back.
 */
export function gitProcessOptions(write: boolean, signal?: AbortSignal) {
  return {
    ...(signal ? { signal } : {}),
    ...(write ? {} : { timeout: 60_000 }),
    killSignal: "SIGKILL" as const,
  };
}

/** argv only; repository config cannot run hooks, fsmonitor or recursion. */
function git(
  directory: string,
  args: string[],
  options: {
    signal?: AbortSignal | undefined;
    failure: string;
    limit?: number;
    truncate?: boolean;
    write?: boolean;
  },
): Promise<{ text: string; truncated: boolean }> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !name.startsWith("GIT_")) env[name] = value;
  if (!options.write) env["GIT_OPTIONAL_LOCKS"] = "0";
  const limit = options.limit ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "-C",
        directory,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "submodule.recurse=false",
        ...args,
      ],
      {
        cwd: directory,
        env,
        stdio: ["ignore", "pipe", "ignore"],
        ...gitProcessOptions(!!options.write, options.signal),
      },
    );
    const chunks: Buffer[] = [];
    let length = 0;
    let truncated = false;
    let failed = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
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
      const text = Buffer.concat(chunks).toString("utf8");
      if (truncated && options.truncate) resolve({ text, truncated });
      else if (truncated)
        reject(
          new CrewError(
            "Workspace changes exceed Stargate's bounded inspection; review them natively. No Git change made.",
          ),
        );
      else if (failed || code !== 0) reject(new CrewError(options.failure));
      else resolve({ text, truncated });
    });
  });
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

/** Resolve and validate the configured team project checkout. */
export async function projectRepository(
  directory: string,
  signal: AbortSignal,
) {
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink())
    throw new CrewError("Project must be an existing real Git checkout.");
  const root = await realpath(directory);
  if (root !== resolve(directory))
    throw new CrewError("Project directory contains a symbolic-link alias.");
  const read = (args: string[]) =>
    git(root, args, {
      signal,
      failure: "Project Git identity is unavailable; no Git change made.",
    }).then(({ text }) => text.trim());
  if (
    (await realpath(await read(["rev-parse", "--show-toplevel"])).catch(
      () => "",
    )) !== root
  )
    throw new CrewError("Project must be its exact Git checkout root.");
  const common = await realpath(
    resolve(root, await read(["rev-parse", "--git-common-dir"])),
  );
  return { directory: root, common };
}

/** The configured path must be its own worktree root of the team project. */
export async function workspaceRoot(
  configured: string,
  captainDirectory: string,
  projectDirectory: string,
  signal: AbortSignal,
): Promise<string> {
  const failure =
    "Configured worker worktree is not a readable Git worktree. No Git change made.";
  const info = await lstat(configured).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink())
    throw new CrewError(
      "Configured worker worktree must be an existing real directory, not a symlink or file.",
    );
  const root = await realpath(configured);
  const captain = await realpath(captainDirectory).catch(() =>
    resolve(captainDirectory),
  );
  if (within(root, captain) || within(captain, root))
    throw new CrewError("Worker worktree overlaps the captain directory.");
  const read = (directory: string, args: string[]) =>
    git(directory, args, { signal, failure }).then(({ text }) => text.trim());
  const top = await read(root, ["rev-parse", "--show-toplevel"]);
  if ((await realpath(top).catch(() => "")) !== root)
    throw new CrewError(
      "Configured worktree is not its own Git worktree root; nested or foreign repositories are refused.",
    );
  const common = async (directory: string) =>
    realpath(
      resolve(
        directory,
        await read(directory, ["rev-parse", "--git-common-dir"]),
      ),
    ).catch(() => "");
  const [worker, project] = await Promise.all([
    common(root),
    common(projectDirectory),
  ]);
  if (!worker || worker !== project)
    throw new CrewError(
      "Configured worktree does not belong to this team's project repository.",
    );
  return root;
}

async function untrackedHash(
  root: string,
  path: string,
  budget: { bytes: number },
): Promise<string> {
  const absolute = join(root, path);
  if (!within(root, absolute)) throw new CrewError("Invalid workspace path.");
  const info = await lstat(absolute).catch(() => null);
  if (!info) return "missing";
  if (info.isSymbolicLink()) return `link:${await readlink(absolute)}`;
  if (!info.isFile()) return "other";
  budget.bytes += info.size;
  if (budget.bytes > hashLimit)
    throw new CrewError(
      "Untracked files exceed Stargate's bounded inspection; review them natively. No Git change made.",
    );
  return createHash("sha256")
    .update(await readFile(absolute))
    .digest("hex");
}

/** Read-only: optional locks off, no index refresh, no worker contact. */
export async function inspectWorkspace(
  root: string,
  crew: string,
  signal: AbortSignal,
  includePatch = false,
): Promise<WorkspaceInspection> {
  const failure =
    "Workspace Git inspection failed; raw details withheld. No Git change made.";
  const read = (args: string[], limit?: number) =>
    git(root, args, {
      signal,
      failure,
      ...(limit ? { limit } : {}),
    }).then(({ text }) => text);
  const head = (
    await read(["rev-parse", "--verify", "HEAD^{commit}"]).catch(() => {
      throw new CrewError(
        "Workspace has no HEAD commit; review it natively. No Git change made.",
      );
    })
  ).trim();
  const branch = (await read(["branch", "--show-current"])).trim() || null;
  const status = await read(
    [
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
      "--ignored=no",
      "--no-renames",
    ],
    4 * 1024 * 1024,
  );
  const changes: WorkspaceChange[] = [];
  let nested = false;
  for (const entry of status.split("\0")) {
    const fields = entry.split(" ");
    const type = fields[0];
    if (type === "?") {
      const path = entry.slice(2);
      // Git shows a nested repository as one untracked directory.
      if (path.endsWith("/")) nested = true;
      changes.push({ path, index: "?", worktree: "?", kind: "untracked" });
    } else if (type === "1" || type === "u") {
      const xy = fields[1] ?? "..";
      if (fields[2]?.startsWith("S")) nested = true;
      changes.push({
        path: fields.slice(type === "1" ? 8 : 10).join(" "),
        index: xy[0] ?? ".",
        worktree: xy[1] ?? ".",
        kind: type === "1" ? "tracked" : "unmerged",
      });
    }
  }
  const diff = ["--binary", "--no-ext-diff", "--no-textconv", "--no-color"];
  const [index, worktree, numstat] = await Promise.all([
    read(["diff", "--cached", ...diff, "--no-renames", "HEAD"], hashLimit),
    read(["diff", ...diff, "--no-renames"], hashLimit),
    read([
      "diff",
      "--numstat",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "HEAD",
    ]),
  ]);
  const budget = { bytes: 0 };
  const untracked: string[] = [];
  for (const change of changes)
    if (change.kind === "untracked" && !change.path.endsWith("/"))
      untracked.push(
        `${change.path}\0${await untrackedHash(root, change.path, budget)}`,
      );
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const diffstat = numstat
    .split("\0")
    .filter(Boolean)
    .slice(0, listLimit)
    .map((line) => {
      const [added, deleted, ...path] = line.split("\t");
      const count = (value?: string) =>
        value === undefined || value === "-" ? null : Number(value);
      return {
        path: path.join("\t"),
        added: count(added),
        deleted: count(deleted),
      };
    });
  let patch: WorkspaceInspection["patch"];
  if (includePatch) {
    const excluded = secretPaths.map((glob) => `:(exclude,glob)**/${glob}`);
    const output = await git(
      root,
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-renames",
        "HEAD",
        "--",
        ".",
        ...excluded,
      ],
      { signal, failure, limit: patchLimit, truncate: true },
    );
    patch = { ...output, excluded: secretPaths };
  }
  return {
    crew,
    directory: root,
    head,
    branch,
    fingerprint: sha(
      JSON.stringify([
        head,
        branch,
        status,
        sha(index),
        sha(worktree),
        untracked,
      ]),
    ),
    changes: changes.slice(0, listLimit),
    changeCount: changes.length,
    truncated: changes.length > listLimit,
    nested,
    diffstat,
    ...(patch ? { patch } : {}),
  };
}

const split = (text: string) => text.split("\0").filter(Boolean);

/** Git's hard reset overwrites untracked and ignored entries that sit where
 * HEAD writes a path (a file, a directory, or a file in a directory's place).
 * Checkpoints cannot hold ignored or nested children, so refuse first.
 */
async function refuseObstructions(root: string, action: string) {
  const options = {
    signal: AbortSignal.timeout(60_000),
    failure: `Workspace obstruction check failed; nothing ${action}.`,
    limit: 32 * 1024 * 1024,
  };
  const [tree, others] = await Promise.all([
    git(
      root,
      ["ls-tree", "-r", "-z", "--name-only", "--full-tree", "HEAD"],
      options,
    ),
    // Ignored entries included; whole untracked directories stay one entry.
    git(root, ["ls-files", "-z", "--others", "--directory"], options),
  ]);
  const files = new Set(split(tree.text));
  const directories = new Set<string>();
  for (const path of files)
    for (let at = path.indexOf("/"); at !== -1; at = path.indexOf("/", at + 1))
      directories.add(path.slice(0, at));
  const blocked: string[] = [];
  for (const entry of split(others.text)) {
    const path = entry.replace(/\/$/, "");
    let hit = files.has(path) || directories.has(path);
    for (
      let at = path.indexOf("/");
      !hit && at !== -1;
      at = path.indexOf("/", at + 1)
    )
      hit = files.has(path.slice(0, at));
    if (hit) blocked.push(entry);
  }
  if (blocked.length)
    throw new CrewError(
      `Untracked or ignored entries occupy paths that HEAD would restore (${blocked.length}: ${blocked
        .slice(0, 5)
        .map((path) => JSON.stringify(path))
        .join(
          ", ",
        )}). Move or commit them natively, then inspect again. Nothing ${action}.`,
    );
}

const restore = (root: string, oid: string) =>
  `git -C ${JSON.stringify(root)} stash apply --index ${oid}`;

async function findStash(root: string, message: string) {
  const { text } = await git(
    root,
    ["stash", "list", "--format=%H%x09%s", "-n", "100"],
    {
      signal: AbortSignal.timeout(30_000),
      failure: "Stash list unavailable; inspect the worktree natively.",
    },
  );
  for (const line of text.split("\n")) {
    const [oid, subject] = line.split("\t", 2);
    if (oid && subject?.endsWith(message)) return oid;
  }
  return null;
}

/** Tracked, staged and untracked changes; ignored files stay in place.
 * Refuses obstructed HEAD paths: Git's internal hard reset would delete them.
 * Writes have no timer; only an explicit signal may stop them (see above).
 */
export async function stashWorkspace(
  root: string,
  crew: string,
  signal?: AbortSignal,
): Promise<WorkspaceCheckpoint> {
  await refuseObstructions(root, "stashed");
  const message = `stargate stash ${crew} ${randomUUID()}`;
  let failed = false;
  await git(root, ["stash", "push", "--include-untracked", "-m", message], {
    signal,
    failure: "git stash failed",
    write: true,
  }).catch(() => {
    failed = true;
  });
  const oid = await findStash(root, message);
  if (!oid)
    throw new CrewError(
      "git stash did not record a Stargate stash; inspect the worktree again.",
    );
  if (failed)
    throw new CrewError(
      `git stash recorded ${oid} but did not finish; inspect before ${restore(root, oid)}.`,
    );
  return { oid, message, restore: restore(root, oid) };
}

/** Checkpoint tracked changes in the stash list, then reset to current HEAD.
 * Refuses when untracked or ignored entries obstruct HEAD paths, so those
 * entries are never overwritten. Returns null if no tracked change exists.
 */
export async function resetWorkspace(
  root: string,
  crew: string,
  head: string,
  signal?: AbortSignal,
): Promise<WorkspaceCheckpoint | null> {
  await refuseObstructions(root, "reset");
  const message = `stargate reset checkpoint ${crew} ${randomUUID()}`;
  const write = (args: string[], failure: string) =>
    git(root, args, { signal, failure, write: true }).then(({ text }) =>
      text.trim(),
    );
  const oid = await write(
    ["stash", "create", message],
    "Checkpoint creation failed; nothing reset.",
  );
  if (!oid) return null;
  await write(
    ["stash", "store", "-m", message, oid],
    `Checkpoint ${oid} was not retained; nothing reset.`,
  );
  const checkpoint = { oid, message, restore: restore(root, oid) };
  const current = await write(
    ["rev-parse", "--verify", "HEAD^{commit}"],
    `HEAD unreadable; nothing reset. Checkpoint ${oid} is retained.`,
  );
  if (current !== head)
    throw new CrewError(
      `HEAD moved before reset; nothing reset. Checkpoint ${oid} is retained.`,
    );
  await write(
    ["reset", "--hard", "--quiet", "HEAD"],
    `Reset did not finish; inspect before ${checkpoint.restore}.`,
  );
  return checkpoint;
}
