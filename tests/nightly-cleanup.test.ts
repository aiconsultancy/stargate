import { afterAll, expect, test } from "bun:test";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  type CleanupInput,
  runCleanup as cleanup,
  cleanupPathUse,
} from "../src/nightly/cleanup";
import {
  cleanupResultSchema,
  cleanupSchema,
} from "../src/nightly/cleanup-config";
import { type CommandRunner, processRunner } from "../src/nightly/exec";

const root = await mkdtemp("/tmp/opencode/pogo-cleanup-");
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
  const limited = await cleanup(input([wide]));
  expect(limited.items[0]?.reason).toBe("scan-limit");
  expect((await readdir(wide)).length).toBe(501);
  expect(await Bun.file(outside).text()).toBe("preserve");
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
