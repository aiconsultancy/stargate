import { afterAll, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type CleanupInput,
  runCleanup as cleanup,
  cleanupPathUse,
  scratchBatch,
} from "../src/nightly/cleanup";
import {
  cleanupResultSchema,
  cleanupSchema,
} from "../src/nightly/cleanup-config";
import { type CommandRunner, processRunner } from "../src/nightly/exec";

const root = await mkdtemp("/tmp/opencode/stargate-cleanup-");
const now = Date.now();
const day = 86_400_000;
afterAll(() => rm(root, { recursive: true, force: true }));
let sequence = 0;
async function fixture() {
  const directory = join(root, String(sequence++));
  await mkdir(directory);
  return directory;
}
async function age(path: string, days = 10) {
  const info = await lstat(path);
  if (info.isDirectory())
    for (const name of await readdir(path)) await age(join(path, name), days);
  if (!info.isSymbolicLink())
    await utimes(path, (now - days * day) / 1000, (now - days * day) / 1000);
}
async function exists(path: string) {
  return lstat(path).then(
    () => true,
    () => false,
  );
}
function input(
  scratchRoots: string[],
  extra: Partial<CleanupInput> = {},
): CleanupInput {
  return {
    settings: cleanupSchema.parse({ enabled: true, scratchRoots }),
    plan: false,
    now,
    runner: processRunner,
    signal: new AbortController().signal,
    protectedPaths: [],
    inUse: async () => "unused",
    ...extra,
  };
}
async function git(path: string, ...args: string[]) {
  const result = await processRunner.run(["git", "-C", path, ...args], {
    timeoutMs: 10_000,
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
  });
  if (result.code) throw new Error(`fixture git ${args[0]} failed`);
  return result.stdout.trim();
}
async function repository() {
  const directory = await fixture();
  const remote = join(directory, "remote.git");
  const repo = join(directory, "repo");
  await mkdir(remote);
  await mkdir(repo);
  await git(remote, "init", "--bare", "--initial-branch=main");
  await git(repo, "init", "--initial-branch=main");
  await git(repo, "commit", "--allow-empty", "-m", "initial");
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "main");
  return { directory, remote, repo };
}

test("strict schema is disabled by default and rejects relative paths and unknown fields", () => {
  expect(cleanupSchema.parse({})).toEqual({
    enabled: false,
    olderThanDays: 5,
    scratchRoots: [],
    repositories: [],
    protectedPaths: [],
  });
  for (const value of [
    { scratchRoots: ["relative"] },
    { repositories: ["/a\nsecret"] },
    { olderThanDays: 0 },
    { surprise: true },
  ])
    expect(cleanupSchema.safeParse(value).success).toBe(false);
});

test("disabled does not inspect or run commands; plan never deletes or writes", async () => {
  const scratch = await fixture();
  const stale = join(scratch, "stale");
  await mkdir(stale);
  await writeFile(join(stale, "data"), "123");
  await age(stale);
  const disabled = await cleanup(
    input([scratch], { settings: cleanupSchema.parse({}) }),
  );
  expect(disabled.items).toEqual([]);
  const plan = await cleanup(input([scratch], { plan: true }));
  expect(plan.items[0]?.status).toBe("planned");
  expect(plan.plannedBytes).toBe(3);
  expect(await exists(stale)).toBe(true);
});

test("records intent before one stale directory deletion and verifies it is gone", async () => {
  const scratch = await fixture();
  const stale = join(scratch, "-literal ; path");
  await mkdir(stale);
  await writeFile(join(stale, "data"), "123");
  await age(stale);
  let recorded = false;
  const result = await cleanup(
    input([scratch], {
      beforeItem: async (item) => {
        expect(await exists(item.path)).toBe(true);
        expect(item.size).toBe(3);
        recorded = true;
      },
    }),
  );
  expect(recorded).toBe(true);
  expect(result.items[0]?.status).toBe("removed");
  expect(result.freedBytes).toBe(3);
  expect(await exists(stale)).toBe(false);
  expect(await exists(scratch)).toBe(true);
});

test("unsafe scratch names and oversized branch names cannot invalidate the audit", async () => {
  const scratch = await fixture();
  const unsafe = join(scratch, "bad\nname");
  await mkdir(unsafe);
  await age(unsafe);
  const result = await cleanup(input([scratch]));
  expect(cleanupResultSchema.safeParse(result).success).toBe(true);
  expect(result.items.some((item) => item.reason === "unsafe-path")).toBe(true);
  expect(await exists(unsafe)).toBe(true);
  const { repo } = await repository();
  const longBranch = Array.from({ length: 12 }, () => "a".repeat(100)).join(
    "/",
  );
  await git(repo, "branch", longBranch);
  const branches = await cleanup(
    input([], {
      settings: cleanupSchema.parse({ enabled: true, repositories: [repo] }),
    }),
  );
  expect(cleanupResultSchema.safeParse(branches).success).toBe(true);
  expect(branches.items.some((item) => item.reason === "unsafe-path")).toBe(
    true,
  );
  expect(await git(repo, "branch", "--list", longBranch)).toContain(longBranch);
});

test.skipIf(process.getuid?.() === 0)(
  "partial scratch removal is a failed command, not a retained item",
  async () => {
    const scratch = await fixture();
    const stale = join(scratch, "stale");
    const locked = join(stale, "z");
    await mkdir(join(stale, "a"), { recursive: true });
    await mkdir(locked);
    await writeFile(join(stale, "a", "file"), "a");
    await writeFile(join(locked, "file"), "z");
    await age(stale);
    await chmod(locked, 0o500);
    try {
      const result = await cleanup(input([scratch]));
      expect(result.items[0]?.status).toBe("failed");
      expect(result.items[0]?.reason).toBe("command-failed");
      expect(await exists(stale)).toBe(true);
    } finally {
      await chmod(locked, 0o700);
    }
  },
);

test("recent, special, protected, active and symlink directories stay", async () => {
  const cases = [
    "recent",
    "slack-share",
    "avondale-fixtures",
    "inspect-snapshot-recent",
    "bosun-inspect-recent",
    "protected",
    "active",
    "busy",
    "unknown",
    "symlink",
  ];
  for (const name of cases) {
    const scratch = await fixture();
    const candidate = join(scratch, name);
    if (name === "symlink") await symlink(await fixture(), candidate);
    else {
      await mkdir(candidate);
      await writeFile(join(candidate, "data"), "x");
      await age(
        candidate,
        name === "recent" ? 1 : name.includes("inspect") ? 6 : 10,
      );
    }
    const result = await cleanup(
      input([scratch], {
        protectedPaths: name === "protected" ? [join(candidate, "data")] : [],
        taskDirectories: name === "active" ? [join(candidate, "nested")] : [],
        inUse: async () =>
          name === "busy"
            ? "in-use"
            : name === "unknown"
              ? "unknown"
              : "unused",
      }),
    );
    expect(result.items[0]?.status).toBe("skipped");
    expect(await exists(candidate)).toBe(true);
  }
});

test("nested retention exceptions, credential names, symlinks and hard links fail closed", async () => {
  for (const name of [
    "inspect-snapshot-log",
    "bosun-inspect-log",
    "today-relay.json",
    ".env",
    ".ssh",
    "link",
  ]) {
    const scratch = await fixture();
    const candidate = join(scratch, "stale");
    await mkdir(candidate);
    if (name === "link") await symlink(await fixture(), join(candidate, name));
    else await writeFile(join(candidate, name), "not read");
    await age(candidate);
    if (name.includes("inspect") || name.endsWith("relay.json"))
      await utimes(join(candidate, name), now / 1000, now / 1000);
    const result = await cleanup(input([scratch]));
    expect(result.items[0]?.status).toBe("skipped");
    expect(await exists(candidate)).toBe(true);
  }
});

test("abort, deadline, changed identity, changed content and failed intent prevent deletion", async () => {
  for (const mode of ["abort", "deadline", "identity", "content", "intent"]) {
    const scratch = await fixture();
    const candidate = join(scratch, "stale");
    await mkdir(candidate);
    await age(candidate);
    const controller = new AbortController();
    const result = await cleanup(
      input([scratch], {
        signal: controller.signal,
        ...(mode === "deadline" ? { deadline: Date.now() - 1 } : {}),
        beforeItem: async () => {
          if (mode === "abort") controller.abort();
          if (mode === "identity") {
            await rm(candidate, { recursive: true });
            await mkdir(candidate);
            await age(candidate);
          }
          if (mode === "content")
            await writeFile(join(candidate, "new"), "new");
          if (mode === "intent") throw new Error("private error");
        },
      }),
    );
    expect(result.freedBytes).toBe(0);
    expect(await exists(candidate)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private error");
  }
});

test("scratch repositories require clean trees and every branch and detached HEAD on a real remote", async () => {
  for (const mode of [
    "clean",
    "dirty",
    "unpushed",
    "detached",
    "hidden-branch",
    "missing-remote",
  ]) {
    const { directory, repo } = await repository();
    if (mode === "dirty") await writeFile(join(repo, "untracked"), "new");
    if (["unpushed", "detached", "hidden-branch"].includes(mode)) {
      if (mode === "hidden-branch") await git(repo, "checkout", "-b", "hidden");
      if (mode === "detached") await git(repo, "checkout", "--detach");
      await git(repo, "commit", "--allow-empty", "-m", "local");
      if (mode === "hidden-branch") await git(repo, "checkout", "main");
    }
    if (mode === "missing-remote")
      await git(repo, "remote", "remove", "origin");
    await age(repo);
    const result = await cleanup(
      input([directory], { protectedPaths: [join(directory, "remote.git")] }),
    );
    const item = result.items.find((item) => item.path === repo);
    expect(item?.status).toBe(mode === "clean" ? "removed" : "skipped");
  }
});

test("branches use only safe deletion, skip checked-out branches, and plan never fetches or prunes", async () => {
  const { directory, repo } = await repository();
  await git(repo, "branch", "merged");
  await git(repo, "branch", "master");
  const worktree = join(directory, "checked-out");
  await git(repo, "worktree", "add", "-b", "checked", worktree);
  const commands: string[][] = [];
  const runner: CommandRunner = {
    run: async (command, options) => {
      commands.push([...command]);
      return processRunner.run(command, options);
    },
  };
  const settings = cleanupSchema.parse({ enabled: true, repositories: [repo] });
  const plan = await cleanup(input([], { settings, runner, plan: true }));
  expect(plan.items.find((item) => item.branch === "merged")?.status).toBe(
    "planned",
  );
  expect(
    commands.some(
      (cmd) =>
        cmd.includes("fetch") || cmd.includes("prune") || cmd.includes("-d"),
    ),
  ).toBe(false);
  commands.length = 0;
  const result = await cleanup(input([], { settings, runner }));
  expect(
    result.items.find(
      (item) => item.kind === "branch" && item.branch === "merged",
    )?.status,
  ).toBe("removed");
  expect(await git(repo, "branch", "--list", "master")).toContain("master");
  expect(await git(repo, "branch", "--list", "checked")).toContain("checked");
  expect(
    commands.some((cmd) => cmd.includes("-D") || cmd.includes("--force")),
  ).toBe(false);
});

test("worktrees preserve primary, locked, dirty, unpushed, active and permanent trees; remove merged or pushed trees", async () => {
  for (const mode of [
    "merged",
    "pushed",
    "dirty",
    "unpushed",
    "detached-unpushed",
    "locked",
    "active",
    "permanent",
    "recent",
  ]) {
    const { directory, repo } = await repository();
    const worktree = join(directory, "leaked");
    await git(repo, "worktree", "add", "-b", "leaked", worktree);
    if (["pushed", "unpushed", "detached-unpushed"].includes(mode)) {
      if (mode === "detached-unpushed")
        await git(worktree, "checkout", "--detach");
      await git(worktree, "commit", "--allow-empty", "-m", "local");
      if (mode === "pushed") await git(worktree, "push", "origin", "leaked");
    }
    if (mode === "dirty") await writeFile(join(worktree, "new"), "new");
    if (mode === "locked") await git(repo, "worktree", "lock", worktree);
    await age(worktree, mode === "recent" ? 1 : 10);
    const result = await cleanup(
      input([], {
        settings: cleanupSchema.parse({ enabled: true, repositories: [repo] }),
        protectedPaths: mode === "permanent" ? [worktree] : [],
        taskDirectories: mode === "active" ? [worktree] : [],
      }),
    );
    expect(await exists(repo)).toBe(true);
    expect(
      result.items.find(
        (item) => item.kind === "worktree" && item.path === worktree,
      )?.status,
    ).toBe(["merged", "pushed"].includes(mode) ? "removed" : "skipped");
  }
});

test("audit checkpoints bracket deletion; plan calls neither write callback", async () => {
  const scratch = await fixture();
  const candidate = join(scratch, "stale");
  await mkdir(candidate);
  await age(candidate);
  const statuses: string[] = [];
  const record: CleanupInput["record"] = async (item) => {
    statuses.push(item.status);
    expect(await exists(item.path)).toBe(item.status !== "removed");
  };
  await cleanup(
    input([scratch], {
      plan: true,
      record,
      beforeItem: async () => {
        throw new Error("plan called gate");
      },
    }),
  );
  expect(statuses).toEqual([]);
  await cleanup(input([scratch], { record }));
  expect(statuses).toEqual(["planned", "removed"]);
});

test("failed intent checkpoint stops later items and preserves every candidate", async () => {
  const scratch = await fixture();
  for (const name of ["one", "two"]) {
    await mkdir(join(scratch, name));
    await age(join(scratch, name));
  }
  const result = await cleanup(
    input([scratch], {
      record: async () => {
        throw new Error("private audit failure");
      },
    }),
  );
  expect((await readdir(scratch)).sort()).toEqual(["one", "two"]);
  expect(result.items[0]?.reason).toBe("audit-failed");
  expect(JSON.stringify(result)).not.toContain("private audit failure");
});

test("hard links, symlink ancestors, missing roots, and scan limits cannot authorise deletion", async () => {
  const scratch = await fixture();
  const candidate = join(scratch, "stale");
  await mkdir(candidate);
  const outside = join(await fixture(), "outside");
  await writeFile(outside, "preserve");
  await link(outside, join(candidate, "hard-link"));
  await age(candidate);
  expect((await cleanup(input([scratch]))).items[0]?.status).toBe("skipped");
  const alias = join(await fixture(), "alias");
  await symlink(scratch, alias);
  expect((await cleanup(input([alias]))).items[0]?.reason).toBe("symlink");
  expect(
    (await cleanup(input([join(scratch, "missing")]))).items[0]?.status,
  ).toBe("skipped");
  const wide = await fixture();
  await Promise.all(
    Array.from({ length: 501 }, (_, i) => mkdir(join(wide, String(i)))),
  );
  // New directories: none is old enough, so none is inspected or removed.
  const limited = await cleanup(input([wide]));
  expect(limited.items).toEqual([
    expect.objectContaining({
      path: wide,
      status: "skipped",
      reason: "scan-limit",
    }),
  ]);
  expect((await readdir(wide)).length).toBe(501);
  expect(await Bun.file(outside).text()).toBe("preserve");
});

test("a scratch root with more children than one run inspects is cleaned in batches", async () => {
  const wide = await fixture();
  // 505 recent directories and 6 stale ones: 511 children.
  await Promise.all(
    Array.from({ length: 505 }, (_, i) => mkdir(join(wide, `recent-${i}`))),
  );
  for (let i = 0; i < 6; i++) {
    await mkdir(join(wide, `stale-${i}`));
    await age(join(wide, `stale-${i}`), 10 + i);
  }
  // An old plain file is never a candidate and takes no place in a batch.
  await writeFile(join(wide, "old-file"), "keep");
  await age(join(wide, "old-file"), 30);
  const plan = await cleanup(input([wide], { plan: true }));
  // The root is named as partly inspected; the stale children are found.
  expect(plan.items[0]).toMatchObject({
    path: wide,
    status: "skipped",
    reason: "scan-limit",
  });
  expect(plan.items.slice(1).map((item) => [item.path, item.status])).toEqual(
    // Oldest first.
    [5, 4, 3, 2, 1, 0].map((i) => [join(wide, `stale-${i}`), "planned"]),
  );
  expect((await readdir(wide)).length).toBe(512);
  const applied = await cleanup(input([wide]));
  expect(
    applied.items.filter((item) => item.status === "removed"),
  ).toHaveLength(6);
  expect(
    (await readdir(wide)).filter((name) => name.startsWith("stale")),
  ).toEqual([]);
  expect((await readdir(wide)).length).toBe(506);
});

test("every child of an oversized scratch root gets its turn, also when all of them stay", async () => {
  const wide = await fixture();
  const names = Array.from(
    { length: 501 },
    (_, i) => `d${String(i).padStart(3, "0")}`,
  );
  await Promise.all(names.map((name) => mkdir(join(wide, name))));
  // The same age for all: the order is by name.
  for (const name of names) await age(join(wide, name), 30);
  const seen = new Set<string>();
  const counts: number[] = [];
  for (const run of [0, 1, 2, 3]) {
    const result = await cleanup(
      input([wide], {
        plan: true,
        now: now + run * day,
        inUse: async () => "in-use",
      }),
    );
    // The root report and the children share the report limit.
    expect(result.items.length).toBeLessThanOrEqual(500);
    expect(result.items[0]).toMatchObject({ path: wide, reason: "scan-limit" });
    const children = result.items.slice(1);
    expect(children.every((item) => item.reason === "in-use")).toBe(true);
    counts.push(children.length);
    for (const item of children) seen.add(item.path);
  }
  // Two windows: 499 children, then the other two. None is left out.
  expect(counts).toEqual([499, 2, 499, 2]);
  expect([...seen].sort()).toEqual(names.map((name) => join(wide, name)));
});

test("an earlier scratch root's report items reduce the batch of the next root, not its tail", async () => {
  const first = await fixture();
  const wide = await fixture();
  for (let i = 0; i < 10; i++) {
    await mkdir(join(first, `f${i}`));
    await age(join(first, `f${i}`), 30);
  }
  const names = Array.from(
    { length: 495 },
    (_, i) => `d${String(i).padStart(3, "0")}`,
  );
  await Promise.all(names.map((name) => mkdir(join(wide, name))));
  for (const name of names) await age(join(wide, name), 30);
  const seen = new Set<string>();
  for (const run of [0, 1]) {
    const result = await cleanup(
      input([first, wide], {
        plan: true,
        now: now + run * day,
        inUse: async () => "in-use",
      }),
    );
    expect(result.items.length).toBeLessThanOrEqual(500);
    for (const item of result.items)
      if (item.path.startsWith(`${wide}/`)) seen.add(item.path);
  }
  // 495 children fit in a run by themselves; behind ten other items they
  // take two runs, and every one is inspected.
  expect(seen.size).toBe(495);
});

test("batches of an oversized scratch root rotate, oldest first, so every child is reached", () => {
  const children = Array.from({ length: 25 }, (_, i) => ({
    name: `d${String(i).padStart(2, "0")}`,
    // d00 is the oldest.
    mtimeMs: now - (40 - i) * day,
  }));
  const cutoff = now - 5 * day;
  const names = (run: number, list = children) =>
    scratchBatch(list, run * day, cutoff, 10);
  // Within the limit: every child, by name, as before.
  expect(scratchBatch(children.slice(0, 10), now, cutoff, 10)).toEqual({
    names: children.slice(0, 10).map((child) => child.name),
    partial: false,
  });
  // Above it: three windows of ten, the oldest window first.
  const seen = new Set<string>();
  const windows = [0, 1, 2].map((run) => names(run).names);
  expect(windows[0]).toEqual(children.slice(0, 10).map((child) => child.name));
  expect(windows.map((window) => window.length)).toEqual([10, 10, 5]);
  for (const name of windows.flat()) seen.add(name);
  expect(seen.size).toBe(25);
  expect(names(3).names).toEqual(windows[0] ?? []);
  expect(names(0).partial).toBe(true);
  // A directory changed after the cutoff cannot be stale: never in a batch.
  const mixed = [
    ...children,
    { name: "new", mtimeMs: now - day },
    { name: "newer", mtimeMs: now },
  ];
  expect([0, 1, 2].flatMap((run) => names(run, mixed).names)).not.toContain(
    "new",
  );
  // Few enough old children: all of them in one run.
  expect(
    scratchBatch(
      [...children.slice(0, 4), ...mixed.slice(-2), ...children.slice(4, 9)],
      now,
      cutoff,
      10,
    ),
  ).toEqual({
    names: children.slice(0, 9).map((child) => child.name),
    partial: true,
  });
});

// Root reads every file, so an unreadable process cannot be made here.
test.skipIf(process.getuid?.() === 0)(
  "only this user's processes are inspected when the path is private",
  async () => {
    const directory = await fixture();
    const candidate = join(directory, "private", "candidate");
    await mkdir(candidate, { recursive: true });
    const proc = join(directory, "proc");
    const me = process.getuid?.() ?? 0;
    const locked: string[] = [];
    // One thread, as `/proc/<pid>/task/<pid>`; links are relative to it.
    const process_ = async (
      pid: number,
      links: Record<string, string>,
      readable = true,
    ) => {
      const thread = join(proc, String(pid), "task", String(pid));
      const fd = join(thread, "fd");
      await mkdir(fd, { recursive: true });
      for (const [name, target] of Object.entries(links))
        await symlink(target, join(thread, name));
      // As for another user's process: its open files cannot be listed.
      if (!readable) {
        await chmod(fd, 0);
        locked.push(fd);
      }
    };
    // Mine, elsewhere; another user's and root's: their files cannot be read.
    await process_(100, { cwd: "/elsewhere", "fd/0": "/elsewhere/file" });
    await process_(200, { cwd: "/secret" }, false);
    await process_(300, { cwd: "/root" }, false);
    await mkdir(join(proc, "self"));
    const owners: Record<string, number> = { "200": me + 1, "300": 0 };
    // The candidate's parent is private or not; nothing else is.
    const view = (parentMode: number) => ({
      root: proc,
      uid: me,
      stat: async (path: string) => {
        if (path.startsWith(`${proc}/`))
          return {
            uid: owners[path.slice(proc.length + 1)] ?? me,
            mode: 0o555,
          };
        return {
          uid: me,
          mode: path === join(directory, "private") ? parentMode : 0o755,
        };
      },
    });
    const use = (parentMode: number) =>
      cleanupPathUse(candidate, undefined, undefined, view(parentMode));
    try {
      // Private: other users cannot reach the path; root is accepted.
      expect(await use(0o700)).toBe("unused");
      // Not private: an unreadable process of another user can be using it.
      for (const mode of [0o750, 0o755, 0o701])
        expect(await use(mode)).toBe("unknown");
      // A private directory of another user does not count.
      expect(
        await cleanupPathUse(candidate, undefined, undefined, {
          ...view(0o700),
          stat: async (path: string) =>
            path.startsWith(`${proc}/`)
              ? { uid: owners[path.slice(proc.length + 1)] ?? me, mode: 0o555 }
              : { uid: me + 1, mode: 0o700 },
        }),
      ).toBe("unknown");
      // This user's own process is always inspected.
      await process_(400, { cwd: join(candidate, "sub") });
      expect(await use(0o700)).toBe("in-use");
      await rm(join(proc, "400"), { recursive: true });
      // One of this user's processes that cannot be read is unknown.
      await process_(500, { cwd: "/elsewhere" }, false);
      expect(await use(0o700)).toBe("unknown");
      await chmod(join(proc, "500", "task", "500", "fd"), 0o700);
      await rm(join(proc, "500"), { recursive: true });
      // Without a known user ID nothing can be skipped.
      expect(
        await cleanupPathUse(candidate, undefined, undefined, {
          ...view(0o700),
          uid: undefined,
        }),
      ).toBe("unknown");
    } finally {
      for (const path of locked) await chmod(path, 0o700).catch(() => {});
    }
  },
);

/** A fake `/proc` with this user's processes only, below a private path. */
async function processes() {
  const directory = await fixture();
  const candidate = join(directory, "candidate");
  await mkdir(candidate);
  const proc = join(directory, "proc");
  const me = process.getuid?.() ?? 0;
  const view = {
    root: proc,
    uid: me,
    stat: async () => ({ uid: me, mode: 0o700 }),
  };
  /** `links` are relative to `/proc/<pid>`; a thread is `task/<tid>`. */
  const add = async (pid: number, links: Record<string, string>) => {
    await mkdir(join(proc, String(pid), "task", String(pid), "fd"), {
      recursive: true,
    });
    for (const [name, target] of Object.entries(links)) {
      await mkdir(dirname(join(proc, String(pid), name)), { recursive: true });
      await symlink(target, join(proc, String(pid), name));
    }
  };
  const use = () => cleanupPathUse(candidate, undefined, undefined, view);
  return { candidate, proc, add, use };
}

test("an executable, a mapped file and a root directory inside the path are uses", async () => {
  for (const [name, expected] of [
    ["exe", "in-use"],
    ["task/7/root", "in-use"],
    ["task/7/cwd", "in-use"],
    ["task/7/fd/3", "in-use"],
    // Not a use: a link that this check does not read.
    ["other", "unused"],
  ] as const) {
    const f = await processes();
    await f.add(7, { "task/7/cwd": "/", "task/7/root": "/", exe: "/bin/tool" });
    expect([name, await f.use()]).toEqual([name, "unused"]);
    await rm(join(f.proc, "7", name), { force: true });
    await f.add(7, { [name]: join(f.candidate, "bin", "tool") });
    expect([name, await f.use()]).toEqual([name, expected]);
  }
  // A running binary that was replaced: the kernel marks the old name.
  const replaced = await processes();
  await replaced.add(7, {
    exe: `${join(replaced.candidate, "tool")} (deleted)`,
  });
  expect(await replaced.use()).toBe("in-use");

  // Mapped files: the path column of `maps`, nothing else.
  const maps = (paths: string[]) =>
    [
      "55d0c0a00000-55d0c0a02000 r--p 00000000 fd:01 131090 /usr/bin/tool",
      "7f1c2c000000-7f1c2c021000 rw-p 00000000 00:00 0 ",
      "7ffd4a5f7000-7ffd4a618000 rw-p 00000000 00:00 0 [stack]",
      ...paths.map(
        (path) => `7f1c30000000-7f1c30001000 r--s 00000000 fd:01 99 ${path}`,
      ),
      "",
    ].join("\n");
  for (const [mapped, expected] of [
    [[], "unused"],
    [["/elsewhere/data.bin"], "unused"],
    [["CANDIDATE/data.bin"], "in-use"],
    [["CANDIDATE/with space/data.bin"], "in-use"],
    [["CANDIDATE/gone.bin (deleted)"], "in-use"],
    [["CANDIDATE/line\\012break.bin"], "in-use"],
    // A name that only starts like the path is another directory.
    [["CANDIDATE-other/data.bin"], "unused"],
  ] as const) {
    const f = await processes();
    await f.add(7, { exe: "/usr/bin/tool" });
    await writeFile(
      join(f.proc, "7", "maps"),
      maps(mapped.map((path) => path.replace("CANDIDATE", f.candidate))),
    );
    expect([mapped, await f.use()]).toEqual([mapped, expected]);
  }
});

test("each thread of a process is inspected: its own working directory and files", async () => {
  // A thread with its own filesystem state and file table.
  for (const name of ["task/8/cwd", "task/8/root", "task/8/fd/5"]) {
    const f = await processes();
    await f.add(7, {
      "task/7/cwd": "/",
      "task/7/fd/0": "/dev/null",
      "task/8/cwd": "/",
      "task/8/fd/0": "/dev/null",
    });
    expect([name, await f.use()]).toEqual([name, "unused"]);
    await rm(join(f.proc, "7", name), { force: true });
    await f.add(7, { [name]: join(f.candidate, "work") });
    expect([name, await f.use()]).toEqual([name, "in-use"]);
  }
});

// Root reads every file, so an unreadable entry cannot be made here.
test.skipIf(process.getuid?.() === 0)(
  "an entry of this user's process that cannot be read makes the use unknown",
  async () => {
    for (const name of ["task/8/fd", "task", "maps"]) {
      const f = await processes();
      await f.add(7, { "task/8/cwd": "/", "task/8/fd/0": "/dev/null" });
      await writeFile(join(f.proc, "7", "maps"), "");
      expect([name, await f.use()]).toEqual([name, "unused"]);
      const path = join(f.proc, "7", name);
      await chmod(path, 0);
      try {
        expect([name, await f.use()]).toEqual([name, "unknown"]);
      } finally {
        await chmod(path, 0o700);
      }
    }
    // A process or thread that exited during the scan is not a use.
    const f = await processes();
    await mkdir(join(f.proc, "9"), { recursive: true });
    await mkdir(join(f.proc, "10", "task", "11"), { recursive: true });
    expect(await f.use()).toBe("unused");
  },
);

/** Only the real process `pid`, as an isolated process table. */
async function only(pid: number) {
  const proc = join(await fixture(), "proc");
  await mkdir(proc);
  await symlink(join("/proc", String(pid)), join(proc, String(pid)));
  const me = process.getuid?.();
  return {
    root: proc,
    uid: me,
    // The fixture root is private; the linked process is this user's.
    stat: async () => ({ uid: me ?? 0, mode: 0o700 }),
  };
}

test("a real process that runs a binary inside the path, or has mapped a file of it, is a use", async () => {
  const tool = Bun.which("sleep");
  if (!tool) throw new Error("sleep is required");
  const elsewhere = await fixture();
  // The executable is in the path; the working directory is not.
  const binary = await fixture();
  // The same name: a multi-call binary selects its tool by name.
  await copyFile(tool, join(binary, "sleep"));
  await chmod(join(binary, "sleep"), 0o700);
  const running = Bun.spawn([join(binary, "sleep"), "60"], {
    cwd: elsewhere,
    stdout: "ignore",
    stderr: "ignore",
  });
  // A mapped file whose descriptor is closed; nothing else points there.
  const data = await fixture();
  await writeFile(join(data, "data.bin"), "x".repeat(8192));
  const mapping = Bun.spawn(
    [
      process.execPath,
      "-e",
      "const map = Bun.mmap(process.argv[1]); process.stdout.write('ready'); setInterval(() => map.length, 1000)",
      join(data, "data.bin"),
    ],
    { cwd: elsewhere, stdout: "pipe", stderr: "ignore" },
  );
  try {
    await mapping.stdout.getReader().read();
    const use = async (path: string, pid: number) =>
      cleanupPathUse(path, undefined, undefined, await only(pid));
    expect(await use(binary, running.pid)).toBe("in-use");
    expect(await use(data, mapping.pid)).toBe("in-use");
    // Each process uses only its own path.
    expect(await use(data, running.pid)).toBe("unused");
    expect(await use(binary, mapping.pid)).toBe("unused");
  } finally {
    running.kill();
    mapping.kill();
    await Promise.all([running.exited, mapping.exited]);
  }
});

test("real mapped paths preserve literal escapes and ambiguous newlines", async () => {
  const scratch = await fixture();
  const elsewhere = await fixture();
  for (const name of [
    "literal\\040space",
    "literal\\012newline",
    "literal\nnewline",
    "mixed\nnewline\\012literal",
  ]) {
    const candidate = join(scratch, name);
    await mkdir(candidate, { mode: 0o700 });
    const file = join(candidate, "data.bin");
    await writeFile(file, "x".repeat(8192));
    const mapping = Bun.spawn(
      [
        process.execPath,
        "-e",
        // Bun.mmap normalizes literal backslashes; an fd path avoids that.
        "const fs = require('node:fs'); const fd = fs.openSync(process.argv[1], 'r'); const map = Bun.mmap('/proc/self/fd/' + fd); fs.closeSync(fd); process.stdout.write('ready'); setInterval(() => map.length, 1000)",
        file,
      ],
      { cwd: elsewhere, stdout: "pipe", stderr: "ignore" },
    );
    try {
      expect((await mapping.stdout.getReader().read()).done).toBe(false);
      // Linux escapes only newline, leaving literal backslashes unchanged.
      const maps = await readFile(`/proc/${mapping.pid}/maps`, "utf8");
      expect(maps.includes(file.replaceAll("\n", "\\012"))).toBe(true);
      const view = await only(mapping.pid);
      expect([
        name,
        await cleanupPathUse(candidate, undefined, undefined, view),
      ]).toEqual([name, "in-use"]);
      if (name.includes("\\040"))
        expect(
          await cleanupPathUse(
            candidate.replaceAll("\\040", " "),
            undefined,
            undefined,
            view,
          ),
        ).toBe("unused");
      // Both spellings must be protected: maps cannot distinguish them.
      if (name.includes("\\012") || name.includes("\n")) {
        const ambiguous = candidate.includes("\n")
          ? candidate.replaceAll("\n", "\\012")
          : candidate.replaceAll("\\012", "\n");
        expect(
          await cleanupPathUse(ambiguous, undefined, undefined, view),
        ).toBe("in-use");
      }
      expect(
        await cleanupPathUse(`${candidate}-other`, undefined, undefined, view),
      ).toBe("unused");
    } finally {
      mapping.kill();
      await mapping.exited;
    }
  }
});

test("real process cwd is detected without reading contents", async () => {
  const scratch = await fixture();
  const candidate = join(scratch, "cwd");
  await mkdir(candidate);
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      "process.stdout.write('ready');setInterval(()=>{},1000)",
    ],
    { cwd: candidate, stdout: "pipe", stderr: "ignore" },
  );
  try {
    await child.stdout.getReader().read();
    expect(await cleanupPathUse(candidate)).not.toBe("unused");
    const result = await cleanup(input([scratch], { inUse: cleanupPathUse }));
    expect(result.items[0]?.status).toBe("skipped");
  } finally {
    child.kill();
    await child.exited;
  }
});

test("fetch errors and malformed worktree metadata fail closed without exposing output", async () => {
  for (const failure of ["fetch", "metadata"]) {
    const { repo } = await repository();
    await git(repo, "branch", "merged");
    const runner: CommandRunner = {
      run: async (command, options) => {
        if (
          (failure === "fetch" && command.includes("fetch")) ||
          (failure === "metadata" &&
            command.includes("--porcelain") &&
            command.includes("list"))
        )
          return {
            code: failure === "fetch" ? 1 : 0,
            stdout: "private malformed output",
            stderr: "private secret",
          };
        return processRunner.run(command, options);
      },
    };
    const result = await cleanup(
      input([], {
        settings: cleanupSchema.parse({ enabled: true, repositories: [repo] }),
        runner,
      }),
    );
    expect(result.items.some((item) => item.status === "removed")).toBe(false);
    expect(await git(repo, "branch", "--list", "merged")).toContain("merged");
    expect(JSON.stringify(result)).not.toContain("private");
  }
});

test("abort during completed Git deletion still records removed outcome", async () => {
  const { repo } = await repository();
  await git(repo, "branch", "merged");
  const controller = new AbortController();
  const statuses: string[] = [];
  const runner: CommandRunner = {
    run: async (command, options) => {
      const result = await processRunner.run(command, options);
      if (command.includes("-d")) controller.abort();
      return result;
    },
  };
  const result = await cleanup(
    input([], {
      settings: cleanupSchema.parse({ enabled: true, repositories: [repo] }),
      runner,
      signal: controller.signal,
      record: async (item) => {
        if (item.branch === "merged") statuses.push(item.status);
      },
    }),
  );
  expect(result.items.find((item) => item.branch === "merged")?.status).toBe(
    "removed",
  );
  expect(statuses).toEqual(["planned", "removed"]);
});

test("permanent primary protection permits unused branch management, never directory removal", async () => {
  const { repo } = await repository();
  await git(repo, "branch", "merged");
  const result = await cleanup(
    input([], {
      settings: cleanupSchema.parse({ enabled: true, repositories: [repo] }),
      protectedPaths: [repo],
    }),
  );
  expect(result.items.find((item) => item.branch === "merged")?.status).toBe(
    "removed",
  );
  expect(await exists(repo)).toBe(true);
});

test("scratch evidence stays offline, including nested repositories", async () => {
  for (const dirty of [false, true]) {
    const { repo } = await repository();
    const scratch = await fixture();
    const candidate = join(scratch, "stale");
    await mkdir(candidate);
    const nested = join(candidate, "nested");
    await git(candidate, "clone", "--no-hardlinks", "--", repo, nested);
    if (dirty) await writeFile(join(nested, "new"), "preserve");
    await age(candidate);
    const commands: string[][] = [];
    const runner: CommandRunner = {
      run: async (command, options) => {
        commands.push([...command]);
        return processRunner.run(command, options);
      },
    };
    const result = await cleanup(input([scratch], { runner }));
    expect(result.items[0]?.status).toBe(dirty ? "skipped" : "removed");
    expect(
      commands.some(
        (command) => command.includes("fetch") || command.includes("ls-remote"),
      ),
    ).toBe(false);
    expect(cleanupResultSchema.safeParse(result).success).toBe(true);
  }
});

test("Git state and process use are checked again after the durable intent", async () => {
  for (const mode of ["dirty", "tip", "in-use"]) {
    const { repo } = await repository();
    await git(repo, "branch", "merged");
    let recorded = false;
    const result = await cleanup(
      input([], {
        settings: cleanupSchema.parse({ enabled: true, repositories: [repo] }),
        inUse: async () =>
          recorded && mode === "in-use" ? "in-use" : "unused",
        record: async (item) => {
          if (item.branch !== "merged" || item.status !== "planned") return;
          recorded = true;
          if (mode === "dirty") await writeFile(join(repo, "new"), "preserve");
          if (mode === "tip") {
            await git(repo, "commit", "--allow-empty", "-m", "new");
            await git(repo, "branch", "-f", "merged", "HEAD");
          }
        },
      }),
    );
    expect(recorded).toBe(true);
    expect(result.items.find((item) => item.branch === "merged")?.status).toBe(
      "skipped",
    );
    expect(await git(repo, "branch", "--list", "merged")).toContain("merged");
  }
});

test("an upstream configured to a local branch cannot prove pushed commits", async () => {
  const { directory, repo } = await repository();
  await git(repo, "commit", "--allow-empty", "-m", "local");
  await git(repo, "config", "branch.main.remote", ".");
  await git(repo, "config", "branch.main.merge", "refs/heads/main");
  await age(repo);
  const result = await cleanup(
    input([directory], { protectedPaths: [join(directory, "remote.git")] }),
  );
  expect(result.items.find((item) => item.path === repo)?.reason).toBe(
    "unpushed",
  );
  expect(await exists(repo)).toBe(true);
});
