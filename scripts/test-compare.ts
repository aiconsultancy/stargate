import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { constants, readFileSync, readdirSync } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type CleanupReport,
  type GroupSnapshot,
  type LoadAverage,
  type Measurement,
  type ProcessIdentity,
  type Side,
  type TreeInfo,
  cleanupMessage,
  parseJUnit,
  renderSummary,
  verdict,
  verdictRule,
} from "./test-compare-report";

const noop = () => {};

export type CompareOptions = {
  cwd: string;
  base?: string;
  candidate: string;
  file: string;
  runs: number;
  load: "none" | "ambient" | "synthetic";
  maxLoad: number;
  timeoutMs: number;
  lock?: string;
  lockWait: number;
  output?: string;
  dependencies?: string;
  failIfCandidateWorse: boolean;
};

type Context = {
  side: Side;
  iteration: number;
  tree: string;
  file: string;
  junit: string;
};

type Runtime = {
  command?: (context: Context) => string[];
  workers?: (directory: string, deadline: number) => string[][];
  load?: () => Promise<LoadAverage>;
  workspace?: (path: string) => void;
  workersStarted?: (pids: number[]) => void;
  groupExists?: (pid: number) => boolean;
  groupSnapshot?: (pid: number, native: () => GroupSnapshot) => GroupSnapshot;
};

type Group = {
  child: ChildProcess;
  done: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: string;
  }>;
  releasing?: boolean;
  spawnIdentity: ProcessIdentity | undefined;
  firstSignalMembers?: ProcessIdentity[];
  lastSnapshot: GroupSnapshot;
  signalDisposition: "sent" | "withheld" | "not-needed";
  signalsSent: number;
};

type Tree = TreeInfo & { path: string; donor: string };

function noProcess(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ESRCH")
  );
}

export const pidMaximum = (() => {
  try {
    const value = Number(
      readFileSync("/proc/sys/kernel/pid_max", "utf8").trim(),
    );

    if (Number.isSafeInteger(value) && value >= 2 && value <= 4_194_304)
      return value;
  } catch {
    // Other platforms have no Linux pid_max; retain the Linux ceiling.
  }

  return 4_194_304;
})();

export function admitPID(pid: number): number {
  // Negating 0 targets our group; negating 1 targets all permitted processes.
  if (!Number.isInteger(pid) || pid < 2 || pid > pidMaximum)
    throw new Error(
      `Invalid owned process-group ID ${pid}; expected 2..${pidMaximum}`,
    );

  return pid;
}

export function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  return process.kill(-admitPID(pid), signal);
}

function groupExists(pid: number): boolean {
  try {
    signalGroup(pid, 0);

    return true;
  } catch (error) {
    if (noProcess(error)) return false;
    throw error;
  }
}

function processIdentity(pid: number): ProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error(`Invalid process identity PID ${pid}`);
  const source = readFileSync(`/proc/${pid}/stat`, "utf8");

  const fields = source
    .slice(source.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);

  const parentPid = Number(fields[1]);
  const groupId = Number(fields[2]);
  const sessionId = Number(fields[3]);

  const startTimeTicks = fields[19];
  const state = fields[0];

  if (
    !state ||
    !startTimeTicks ||
    !/^\d+$/.test(startTimeTicks) ||
    ![pid, parentPid, groupId, sessionId].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    throw new Error(`Unreadable process identity for PID ${pid}`);

  return { pid, parentPid, groupId, sessionId, startTimeTicks, state };
}

function processGroupSnapshot(pid: number): GroupSnapshot {
  const snapshot: GroupSnapshot = { members: [], errors: [] };

  try {
    if (!groupExists(pid)) return snapshot;

    if (process.platform !== "linux")
      throw new Error("Linux /proc facts unavailable");

    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;

      try {
        const identity = processIdentity(Number(name));

        if (identity.groupId === pid) snapshot.members.push(identity);
      } catch (error) {
        if (!noProcess(error))
          snapshot.errors.push(
            `PID ${name}: ${error instanceof Error ? error.message : "identity unreadable"}`,
          );
      }
    }

    if (snapshot.members.length === 0 && groupExists(pid))
      snapshot.errors.push(
        `group ${pid} exists but its membership is unreadable`,
      );
  } catch (error) {
    snapshot.errors.push(
      error instanceof Error ? error.message : "group identity unreadable",
    );
  }

  snapshot.members.sort((a, b) => a.pid - b.pid);

  return snapshot;
}

export const help = `Usage: mise run test-compare -- --file tests/x.test.ts --runs N [options]

Compare: --base REF --candidate REF|PATH
Single tree: omit --base; --candidate defaults to the current tracked working tree.
An existing directory means its tracked working files, including edits. Stage new
files first. Other values are commit refs in the caller's repository.

--load none|ambient|synthetic  Default none; none and ambient add no load.
--max-load NUMBER             Synthetic ceiling; default 1.5 times available cores.
--lock PATH                  Optional per-run flock; or STARGATE_TEST_COMPARE_LOCK.
--lock-wait SECONDS           Lock wait limit; default 300.
--timeout-ms NUMBER           Per-file process limit; default 300000.
--output DIR                 New or empty output directory outside source trees.
--dependencies DIR           Tree with installed node_modules and matching bun.lock.
--fail-if-candidate-worse     Exit 1 if candidate has more failed runs than base.
--help                       Show this help.

Private clones and dependency copies use TMPDIR. Preparation does not fetch or
install packages. Tests keep their normal access; this is not a sandbox.
Safe group signalling requires Linux /proc identity facts; unavailable facts fail closed.
Output defaults to a separate retained directory under TMPDIR. Synthetic uses
one CPU worker and one private 1 MiB I/O worker, only during each admitted run.
Use ambient if the host is already busy or load average is unavailable.
Exit 0 means measurement completed, not tests passed. Errors exit nonzero.
Runs must be 1 to 10000; the process limit must not exceed 1800000 ms.
The result does not identify a cause or establish statistical significance.
`;

export function parseOptions(
  args: string[],
  cwd = process.cwd(),
): CompareOptions {
  const values = new Map<string, string>();
  const switches = new Set<string>();

  const names = new Set([
    "base",
    "candidate",
    "file",
    "runs",
    "load",
    "max-load",
    "lock",
    "lock-wait",
    "timeout-ms",
    "output",
    "dependencies",
  ]);

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === "--fail-if-candidate-worse") {
      if (switches.has(arg)) throw new Error(`Duplicate option: ${arg}`);
      switches.add(arg);
    } else if (arg?.startsWith("--") && names.has(arg.slice(2))) {
      const value = args[++index];

      if (!value || value.startsWith("--") || values.has(arg))
        throw new Error(`Invalid option: ${arg}`);
      values.set(arg, value);
    } else throw new Error(`Unknown option: ${arg ?? ""}`);
  }

  const number = (key: string, fallback: number, integer = true) => {
    const text = values.get(key);
    const value = text === undefined ? fallback : Number(text);

    if (
      !Number.isFinite(value) ||
      value <= 0 ||
      (integer && !Number.isSafeInteger(value))
    )
      throw new Error(
        `${key} must be a positive ${integer ? "integer" : "number"}`,
      );

    return value;
  };

  const file = values.get("--file");

  if (
    !file ||
    isAbsolute(file) ||
    file.split(/[\\/]/).includes("..") ||
    !file.endsWith(".test.ts")
  )
    throw new Error("--file must name one repository-relative .test.ts file");
  const load = values.get("--load") ?? "none";

  if (load !== "none" && load !== "ambient" && load !== "synthetic")
    throw new Error("Invalid --load mode");
  const base = values.get("--base");
  const failIfCandidateWorse = switches.has("--fail-if-candidate-worse");

  if (failIfCandidateWorse && !base)
    throw new Error("--fail-if-candidate-worse requires --base");

  const lock =
    values.get("--lock") ?? process.env["STARGATE_TEST_COMPARE_LOCK"];

  const runs = number("--runs", 10);
  const timeoutMs = number("--timeout-ms", 300_000);

  if (runs > 10_000 || timeoutMs > 1_800_000)
    throw new Error("Run count or process limit is too large");

  return {
    cwd: resolve(cwd),
    ...(base && { base }),
    candidate: values.get("--candidate") ?? cwd,
    file,
    runs,
    load,
    maxLoad: number("--max-load", availableParallelism() * 1.5, false),
    timeoutMs,
    lockWait: number("--lock-wait", 300),
    ...(lock && { lock: resolve(cwd, lock) }),
    ...(values.has("--output") && {
      output: resolve(cwd, values.get("--output") ?? ""),
    }),
    ...(values.has("--dependencies") && {
      dependencies: resolve(cwd, values.get("--dependencies") ?? ""),
    }),
    failIfCandidateWorse,
  };
}

export async function sampleLoad(): Promise<LoadAverage> {
  try {
    const values = (await readFile("/proc/loadavg", "utf8"))
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .map(Number);

    const [one, five, fifteen] = values;

    if (
      one !== undefined &&
      five !== undefined &&
      fifteen !== undefined &&
      values.every((v) => Number.isFinite(v) && v >= 0)
    )
      return [one, five, fifteen];
  } catch {
    /* Load average is optional outside Linux. */
  }

  return "unavailable";
}

function environment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    { cwd, env: environment(), encoding: "utf8", timeout: 60_000 },
  );

  if (result.status !== 0)
    throw new Error(
      `Git failed: ${result.stderr || (result.error === undefined || result.error.message === "" ? args[0] : result.error.message)}`,
    );

  return result.stdout.trimEnd();
}

const inside = (root: string, path: string) =>
  path === root || path.startsWith(root + sep);

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);

    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

async function trackedSnapshot(source: string, destination: string) {
  const names = new Set(
    [
      ...git(destination, "ls-files", "-z").split("\0"),
      ...git(source, "ls-files", "-z").split("\0"),
    ].filter(Boolean),
  );

  for (const name of names) {
    const from = join(source, name);
    const to = join(destination, name);

    await rm(to, { recursive: true, force: true });

    if (!(await exists(from))) continue;
    await mkdir(dirname(to), { recursive: true });
    const stat = await lstat(from);

    if (stat.isSymbolicLink()) {
      const target = await realpath(from);

      if (!inside(source, target))
        throw new Error(`Tracked link leaves the source tree: ${name}`);
      await symlink(
        relative(dirname(to), join(destination, relative(source, target))),
        to,
      );
    } else if (stat.isFile()) {
      await copyFile(from, to, constants.COPYFILE_FICLONE);
      await chmod(to, stat.mode & 0o777);
    } else throw new Error(`Unsupported tracked entry: ${name}`);
  }

  git(destination, "add", "--all");
}

async function copyModules(source: string, destination: string) {
  const links: { name: string; target: string }[] = [];

  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);

      if (entry.isSymbolicLink()) {
        const target = await realpath(path);

        if (!inside(source, target))
          throw new Error(
            `Dependency link leaves node_modules: ${relative(source, path)}`,
          );
        links.push({
          name: relative(source, path),
          target: relative(source, target),
        });
      } else if (entry.isDirectory()) await walk(path);
    }
  }

  await walk(source);
  await cp(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });

  for (const link of links) {
    const to = join(destination, link.name);
    await unlink(to);
    await symlink(relative(dirname(to), join(destination, link.target)), to);
  }
}

async function snapshot(
  options: CompareOptions,
  workspace: string,
  side: Side,
  spec: string,
): Promise<Tree> {
  const caller = git(options.cwd, "rev-parse", "--show-toplevel");

  const pathInput =
    side !== "base" &&
    (await exists(resolve(options.cwd, spec))) &&
    (await stat(resolve(options.cwd, spec))).isDirectory();

  const source = await realpath(
    git(
      pathInput ? resolve(options.cwd, spec) : caller,
      "rev-parse",
      "--show-toplevel",
    ),
  );

  const sha = git(
    source,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${pathInput ? "HEAD" : spec}^{commit}`,
  );

  const path = join(workspace, side);
  git(
    workspace,
    "clone",
    "--quiet",
    "--no-hardlinks",
    "--no-checkout",
    "--",
    source,
    path,
  );
  git(path, "checkout", "--quiet", "--detach", sha);

  if (pathInput) await trackedSnapshot(source, path);

  return {
    side,
    source: pathInput ? `path:${source}` : spec,
    sha,
    path,
    donor: options.dependencies ?? source,
    snapshotTree: git(path, "write-tree"),
  };
}

export async function compare(options: CompareOptions, runtime: Runtime = {}) {
  if (process.platform === "win32")
    throw new Error("test-compare requires POSIX process groups");
  const controller = new AbortController();
  let interrupt: "SIGINT" | "SIGTERM" | undefined;

  const sigint = () => {
    interrupt ??= "SIGINT";
    controller.abort();
  };

  const sigterm = () => {
    interrupt ??= "SIGTERM";
    controller.abort();
  };

  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);

  const check = () => {
    if (controller.signal.aborted)
      throw new Error(`Interrupted by ${interrupt ?? "signal"}`);
  };

  const owned = new Set<Group>();
  let lastHolder: Group | undefined;
  const cleanupFailures = new Map<Group, CleanupReport["groups"][number]>();

  const cleanup: CleanupReport = {
    groups: [],
    workspace: { path: null, state: "not-created" },
    lock: {
      path: options.lock ?? null,
      state: options.lock ? "not-acquired" : "not-used",
    },
  };

  const runs: Measurement[] = [];
  const trees: Tree[] = [];
  let workspace: string | undefined;
  let output: string | undefined;
  let errorMessage: string | undefined;
  let complete = false;
  let cleanupFailed = false;

  let incompleteRun:
    | {
        side: Side;
        iteration: number;
        load: LoadAverage;
        log: string;
        command?: string[];
      }
    | undefined;

  async function start(
    command: string[],
    cwd: string,
    log?: number,
  ): Promise<Group> {
    check();
    const executable = command[0];

    if (!executable) throw new Error("Empty child command");

    const child = spawn(executable, command.slice(1), {
      cwd,
      env: {
        ...environment(),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      detached: true,
      stdio:
        log === undefined ? ["pipe", "pipe", "pipe"] : ["ignore", log, log],
    });

    const done: Group["done"] = new Promise((resolveDone) => {
      child.once("error", (error) => {
        resolveDone({ code: null, signal: null, error: error.message });
      });
      child.once("close", (code, signal) => {
        resolveDone({ code, signal });
      });
    });

    const group: Group = {
      child,
      done,
      spawnIdentity: undefined,
      lastSnapshot: { members: [], errors: [] },
      signalDisposition: "not-needed",
      signalsSent: 0,
    };

    owned.add(group);
    await new Promise<void>((resolveSpawn, reject) => {
      child.once("spawn", resolveSpawn);
      child.once("error", reject);
    });

    if (child.pid) {
      try {
        group.spawnIdentity = processIdentity(child.pid);
      } catch {
        /* Cleanup refuses signals without a readable spawn identity. */
      }
    }

    return group;
  }

  async function stop(groups: Group[]) {
    const results = await Promise.allSettled(
      groups.map(async (group) => {
        const pid = group.child.pid;

        if (pid === undefined) {
          owned.delete(group);

          return;
        }

        const deadline = performance.now() + 1000;

        try {
          admitPID(pid);

          // Completed leaders do not justify signalling their saved group IDs.
          if (group.child.exitCode === null && group.child.signalCode === null)
            signalOwned(group);
          await waitFor(
            group.done,
            Math.max(1, deadline - performance.now()),
            true,
          );

          while ((runtime.groupExists ?? groupExists)(pid)) {
            if (performance.now() >= deadline) {
              signalOwned(group);
              throw new Error(`group ${pid} survived cleanup deadline`);
            }

            await delay(10);
          }

          owned.delete(group);
        } catch (error) {
          cleanupFailed = true;

          const reason =
            error instanceof Error ? error.message : "group cleanup failed";

          cleanupFailures.set(group, {
            groupId: pid,
            sessionId: group.spawnIdentity?.sessionId ?? null,
            spawnLeader: group.spawnIdentity ?? null,
            firstSignalMembers: group.firstSignalMembers ?? [],
            currentMembers: group.lastSnapshot.members,
            errors: group.lastSnapshot.errors,
            reason,
            signalDisposition: group.signalDisposition,
            signalsSent: group.signalsSent,
          });
          throw error;
        }
      }),
    );

    const failed = results.find((result) => result.status === "rejected");

    if (failed?.status === "rejected") throw failed.reason;
  }

  function inspectGroup(group: Group): GroupSnapshot {
    const pid = group.child.pid;

    const native = () =>
      pid ? processGroupSnapshot(pid) : { members: [], errors: [] };

    group.lastSnapshot = pid
      ? (runtime.groupSnapshot?.(pid, native) ?? native())
      : native();

    return group.lastSnapshot;
  }

  function signalOwned(group: Group) {
    const pid = group.child.pid;

    if (pid === undefined) return;
    admitPID(pid);
    const snapshot = inspectGroup(group);
    group.signalDisposition = "withheld";

    const refuse = (reason: string): never => {
      throw new Error(`group ${pid} ownership not proven: ${reason}`);
    };

    if (snapshot.errors.length > 0) refuse(snapshot.errors.join("; "));

    if (snapshot.members.length === 0) {
      group.signalDisposition = "not-needed";

      return;
    }

    const leader = group.spawnIdentity;

    if (!leader || leader.groupId !== pid || leader.sessionId !== pid)
      return refuse("spawn leader/session identity unavailable");

    if (
      snapshot.members.some(
        (member) =>
          member.groupId !== pid || member.sessionId !== leader.sessionId,
      )
    )
      refuse("current member session/group changed");

    if (!group.firstSignalMembers) {
      if (
        !snapshot.members.some(
          (member) =>
            member.pid === pid &&
            member.startTimeTicks === leader.startTimeTicks,
        )
      )
        refuse("spawn leader no longer anchors the first signal");

      if (
        snapshot.members.some(
          (member) =>
            BigInt(member.startTimeTicks) < BigInt(leader.startTimeTicks),
        )
      )
        refuse("member predates the created session");
      group.firstSignalMembers = [...snapshot.members];
    } else if (
      snapshot.members.some(
        (member) =>
          !group.firstSignalMembers?.some(
            (known) =>
              known.pid === member.pid &&
              known.startTimeTicks === member.startTimeTicks &&
              known.sessionId === member.sessionId,
          ),
      )
    )
      refuse("member PID/start time is not in the first-signal identity set");

    try {
      signalGroup(pid, "SIGKILL");
      group.signalsSent++;
      group.signalDisposition = "sent";
    } catch (error) {
      if (!noProcess(error)) throw error;
      group.signalDisposition = "not-needed";
    }
  }

  async function waitFor<T>(
    promise: Promise<T>,
    milliseconds: number,
    cleanup = false,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = noop;

    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          cancel = () => {
            reject(new Error(`Interrupted by ${interrupt ?? "signal"}`));
          };

          if (!cleanup)
            controller.signal.addEventListener("abort", cancel, { once: true });
          timer = setTimeout(() => {
            reject(new Error("Child or lock wait timed out"));
          }, milliseconds);

          if (!cleanup && controller.signal.aborted) cancel();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      controller.signal.removeEventListener("abort", cancel);
    }
  }

  async function acquireLock(tree: Tree): Promise<Group | undefined> {
    if (!options.lock) return;

    const holder = await start(
      [
        "flock",
        "--exclusive",
        "--wait",
        String(options.lockWait),
        options.lock,
        "sh",
        "-c",
        'printf "locked\\n"; cat >/dev/null',
      ],
      tree.path,
    );

    lastHolder = holder;

    const ready = new Promise<void>((resolveReady, reject) => {
      holder.child.stdout?.once("data", () => {
        resolveReady();
      });
      void holder.done.then((status) => {
        reject(new Error(`Lock holder exited: ${status.error ?? status.code}`));
      });
    });

    await waitFor(ready, (options.lockWait + 1) * 1000);
    void holder.done.then(() => {
      if (!holder.releasing) controller.abort();
    });

    return holder;
  }

  async function releaseLock(holder: Group | undefined) {
    if (!holder) return;
    holder.releasing = true;
    holder.child.stdin?.end();
    const result = await waitFor(holder.done, 5000, true);

    if (result.code !== 0) throw new Error("Lock holder failed before release");
    await stop([holder]);
  }

  async function record() {
    cleanup.groups = [...cleanupFailures.values()];
    cleanup.workspace.path = workspace ?? null;

    if (workspace) {
      try {
        cleanup.workspace.state = (await exists(workspace))
          ? "retained"
          : "removed";
      } catch {
        cleanup.workspace.state = "not-confirmed";
      }
    }

    if (lastHolder?.child.pid) {
      try {
        if (!groupExists(lastHolder.child.pid)) cleanup.lock.state = "released";
        else if (
          lastHolder.child.exitCode !== null ||
          lastHolder.child.signalCode !== null
        ) {
          const snapshot = processGroupSnapshot(lastHolder.child.pid);
          // Linux zombies have closed their descriptors even before collection.
          cleanup.lock.state =
            snapshot.errors.length === 0 &&
            snapshot.members.length > 0 &&
            snapshot.members.every(
              (member) => member.state === "Z" || member.state === "X",
            )
              ? "released"
              : "not-confirmed-released";
        } else
          cleanup.lock.state = lastHolder.releasing
            ? "not-confirmed-released"
            : "held";
      } catch {
        cleanup.lock.state = "not-confirmed-released";
      }
    }

    if (cleanupFailed) errorMessage = cleanupMessage(cleanup);

    if (!output) return;

    const metadata = {
      version: 1,
      complete,
      cleanup,
      ...(errorMessage && { error: errorMessage }),
      rule: verdictRule,
      file: options.file,
      runsPerTree: options.runs,
      loadMode: options.load,
      maxLoad: options.maxLoad,
      lock: options.lock ?? null,
      timeoutMs: options.timeoutMs,
      bunVersion: Bun.version,
      syntheticWorkers:
        options.load === "synthetic"
          ? { cpu: 1, io: 1, ioBytes: 1_048_576, ioIntervalMs: 20 }
          : null,
      trees: trees.map(({ side, source, sha, snapshotTree }) => ({
        side,
        source,
        sha,
        snapshotTree,
      })),
      ...(incompleteRun && { incompleteRun }),
      runs,
    };

    await writeFile(
      join(output, "results.json"),
      JSON.stringify(metadata, null, 2) + "\n",
      { mode: 0o600 },
    );
    await writeFile(
      join(output, "summary.md"),
      renderSummary(metadata.trees, runs, options.load, complete, cleanup),
      { mode: 0o600 },
    );
  }

  try {
    const caller = await realpath(
      git(options.cwd, "rev-parse", "--show-toplevel"),
    );

    const roots = [caller];

    if (
      (await exists(resolve(options.cwd, options.candidate))) &&
      (await stat(resolve(options.cwd, options.candidate))).isDirectory()
    )
      roots.push(
        await realpath(
          git(
            resolve(options.cwd, options.candidate),
            "rev-parse",
            "--show-toplevel",
          ),
        ),
      );

    if (options.dependencies) roots.push(await realpath(options.dependencies));

    if (options.lock) {
      const lock = (await exists(options.lock))
        ? await realpath(options.lock)
        : join(
            await realpath(dirname(options.lock)),
            relative(dirname(options.lock), options.lock),
          );

      if (roots.some((root) => inside(root, lock)))
        throw new Error("Lock must be outside source trees");
    }

    const temporary = await realpath(tmpdir());

    if (roots.some((root) => inside(root, temporary)))
      throw new Error("TMPDIR must be outside source trees");
    let target: string;

    if (options.output) {
      const parent = await realpath(dirname(options.output));
      target = (await exists(options.output))
        ? await realpath(options.output)
        : join(parent, relative(dirname(options.output), options.output));

      if (roots.some((root) => inside(root, target)))
        throw new Error("Output must be outside source trees");

      if (await exists(target)) {
        if ((await readdir(target)).length > 0)
          throw new Error("Output directory must be empty");
      } else await mkdir(target, { mode: 0o700 });
    } else target = await mkdtemp(join(temporary, "test-compare-results-"));
    await mkdir(join(target, "runs"), { mode: 0o700 });
    output = target;

    if (process.platform !== "linux")
      throw new Error(
        "Linux /proc ownership facts unavailable; no child started",
      );
    processIdentity(process.pid);
    workspace = await mkdtemp(join(tmpdir(), "test-compare-work-"));
    runtime.workspace?.(workspace);

    if (options.base)
      trees.push(await snapshot(options, workspace, "base", options.base));
    trees.push(
      await snapshot(
        options,
        workspace,
        options.base ? "candidate" : "tree",
        options.candidate,
      ),
    );
    const modules = new Map<string, string>();

    for (const tree of trees) {
      const source = tree.source.startsWith("path:")
        ? tree.source.slice(5)
        : caller;

      if (inside(source, output))
        throw new Error("Output must be outside every source tree");

      if (!(await exists(join(tree.path, options.file))))
        throw new Error(`Test file is absent in ${tree.side}`);

      if (!(await exists(join(tree.path, "package.json")))) continue;
      const lock = await readFile(join(tree.path, "bun.lock"));

      if (!(await readFile(join(tree.donor, "bun.lock"))).equals(lock))
        throw new Error(
          `Dependency lock differs for ${tree.side}; provide a matching --dependencies tree`,
        );
      const donor = await realpath(join(tree.donor, "node_modules"));
      let copy = modules.get(donor);

      if (!copy) {
        copy = join(workspace, `modules-${modules.size}`, "node_modules");
        await mkdir(dirname(copy));
        await copyModules(donor, copy);
        modules.set(donor, copy);
      }

      await symlink(copy, join(tree.path, "node_modules"));
    }

    console.log(`Rule before run 1: ${verdictRule}`);
    console.log(`Load mode: ${options.load}. Results: ${output}`);
    await record();

    for (let iteration = 1; iteration <= options.runs; iteration++)
      for (const tree of trees) {
        check();
        git(tree.path, "read-tree", "--reset", "-u", tree.snapshotTree);
        git(tree.path, "clean", "-ffdx", "-e", "node_modules");
        const holder = await acquireLock(tree);
        const workers: Group[] = [];
        let child: Group | undefined;
        const name = `${String(iteration).padStart(3, "0")}-${tree.side}`;

        const logPath = join(output, "runs", `${name}.log`);
        const junit = join(output, "runs", `${name}.xml`);

        const log = await open(logPath, "wx", 0o600);

        try {
          let load = await (runtime.load ?? sampleLoad)();
          incompleteRun = {
            side: tree.side,
            iteration,
            load,
            log: relative(output, logPath),
          };

          if (
            options.load === "synthetic" &&
            (load === "unavailable" || load[0] > options.maxLoad)
          )
            throw new Error(
              "Synthetic load refused on this host; use --load ambient",
            );
          const workerDirectory = join(workspace, "load");
          await mkdir(workerDirectory, { recursive: true });

          if (options.load === "synthetic") {
            const deadline = Date.now() + options.timeoutMs + 10_000;

            const commands =
              runtime.workers?.(workerDirectory, deadline) ??
              ["cpu", "io"].map((kind) => [
                process.execPath,
                import.meta.path,
                "--load-worker",
                kind,
                workerDirectory,
                String(deadline),
              ]);

            for (const command of commands)
              workers.push(await start(command, workerDirectory, log.fd));
            runtime.workersStarted?.(
              workers.flatMap((worker) =>
                worker.child.pid ? [worker.child.pid] : [],
              ),
            );
            load = await (runtime.load ?? sampleLoad)();
            incompleteRun.load = load;
          }

          const context = {
            side: tree.side,
            iteration,
            tree: tree.path,
            file: options.file,
            junit,
          };

          const command = runtime.command?.(context) ?? [
            process.execPath,
            "test",
            `./${options.file}`,
            "--reporter=junit",
            "--reporter-outfile",
            junit,
          ];

          incompleteRun.command = command;
          await record();
          console.log(
            `${tree.side} ${iteration}/${options.runs} start load: ${JSON.stringify(load)}`,
          );
          const started = performance.now();
          const startedAt = new Date().toISOString();
          child = await start(command, tree.path, log.fd);

          const result = await waitFor(
            Promise.race([
              child.done,
              ...workers.map(async (worker) => {
                await worker.done;
                throw new Error(
                  "A synthetic load worker exited before the test runner",
                );
              }),
            ]),
            options.timeoutMs,
          );

          const wallSeconds = (performance.now() - started) / 1000;

          if (
            result.error ||
            result.signal ||
            (result.code !== 0 && result.code !== 1)
          )
            throw new Error(
              `Test runner failed: ${result.error ?? result.signal ?? result.code}`,
            );
          const report = parseJUnit(await readFile(junit, "utf8"));

          const failures = report.tests.filter(
            (test) => test.status === "failed",
          );

          if ((result.code === 0) !== (failures.length === 0))
            throw new Error("Runner exit and JUnit failures disagree");
          await stop([...workers, child]);
          child = undefined;
          workers.length = 0;
          runs.push({
            side: tree.side,
            iteration,
            load,
            exitCode: result.code,
            ...report,
            wallSeconds,
            startedAt,
            command,
            workersReaped: true,
            log: relative(output, logPath),
            junit: relative(output, junit),
          });
          incompleteRun = undefined;
          console.log(
            `${tree.side} ${iteration}/${options.runs}: ${result.code === 0 ? "pass" : "fail"}; load ${JSON.stringify(load)}; file ${report.fileSeconds}s`,
          );
        } finally {
          await stop([...workers, ...(child ? [child] : [])]);
          await rm(join(workspace, "load"), { recursive: true, force: true });
          await log.close();
          await releaseLock(holder);
        }

        await record();
      }

    complete = true;
  } catch (error) {
    errorMessage =
      error instanceof Error ? error.message : "Measurement failed";
  } finally {
    try {
      await stop([...owned]);
    } catch (error) {
      complete = false;
      errorMessage = `Cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`;
    }

    if (owned.size === 0 && workspace) {
      try {
        await rm(workspace, { recursive: true, force: true });
      } catch (error) {
        complete = false;
        errorMessage = `Temporary cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`;
      }
    }

    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
    await record();
  }

  const worse =
    options.base &&
    runs.filter((run) => run.side === "candidate" && run.exitCode !== 0)
      .length >
      runs.filter((run) => run.side === "base" && run.exitCode !== 0).length;

  return {
    directory: output,
    cleanup,
    code: cleanupFailed
      ? 2
      : interrupt === "SIGINT"
        ? 130
        : interrupt === "SIGTERM"
          ? 143
          : errorMessage
            ? 2
            : options.failIfCandidateWorse && worse === true
              ? 1
              : 0,
    ...(errorMessage && { error: errorMessage }),
    verdict: verdict(runs, complete),
  };
}

async function loadWorker(
  kind: string | undefined,
  directory: string | undefined,
  end: string | undefined,
) {
  const deadline = Number(end);

  if (
    !directory ||
    !Number.isFinite(deadline) ||
    deadline > Date.now() + 3_600_000
  )
    throw new Error("Invalid load worker boundary");

  if (kind === "cpu") {
    let value = 1;

    while (Date.now() < deadline)
      for (let i = 0; i < 10_000; i++)
        value = Math.imul(value, 1_664_525) + 1_013_904_223;
    await writeFile(join(directory, "cpu.done"), String(value));
  } else if (kind === "io") {
    const file = await open(join(directory, "load.bin"), "w");

    try {
      const block = new Uint8Array(1024 * 1024);

      while (Date.now() < deadline) {
        await file.write(block, 0, block.length, 0);
        await file.datasync();
        await delay(20);
      }
    } finally {
      await file.close();
    }
  } else throw new Error("Unknown load worker");
}

if (import.meta.main) {
  try {
    if (process.argv[2] === "--load-worker")
      await loadWorker(process.argv[3], process.argv[4], process.argv[5]);
    else if (process.argv.slice(2).includes("--help")) console.log(help);
    else {
      const result = await compare(parseOptions(process.argv.slice(2)));

      if (result.error) console.error(result.error);

      if (result.directory) console.log(`Results: ${result.directory}`);
      console.log(result.verdict);
      process.exitCode = result.code;
    }
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "test-compare failed",
    );
    process.exitCode = 2;
  }
}
