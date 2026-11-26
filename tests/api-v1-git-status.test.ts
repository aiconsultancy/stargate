import { afterAll, expect, spyOn, test } from "bun:test";
import { appendFileSync, constants, fstatSync } from "node:fs";
import * as fs from "node:fs/promises";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readCommand } from "../src/observability/dashboard/api/v1/command";
import { createGitReader as makeGitReader } from "../src/observability/dashboard/api/v1/git";

// Every reader made here is stopped after the file, so no private temporary
// Snapshot folder is left behind.
const readers: { stop(): Promise<void> }[] = [];

function createGitReader(
  ...args: Parameters<typeof makeGitReader>
): ReturnType<typeof makeGitReader> {
  const reader = makeGitReader(...args);
  readers.push(reader);

  return reader;
}

afterAll(() => Promise.all(readers.map((reader) => reader.stop())));

function git(directory: string, ...args: string[]) {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd: directory },
  );

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }

  return result.stdout.toString().trim();
}

async function waitForRemoval(directory: string, name?: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const entries = await readdir(directory);

    if (name === undefined ? !entries.length : !entries.includes(name)) {
      return;
    }

    await Bun.sleep(5);
  }
}

test("reads a linked worktree split index without updating the checkout indexes", async () => {
  const root = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

  try {
    const repository = join(root, "repository");
    const worktree = join(root, "worktree");
    await mkdir(repository);
    git(repository, "init", "-b", "main");
    await writeFile(join(repository, "tracked"), "fixture\n");
    git(repository, "add", "tracked");
    git(repository, "commit", "-m", "Initial");
    git(repository, "worktree", "add", "-b", "worktree", worktree);
    git(worktree, "update-index", "--split-index");

    const shared = resolve(
      worktree,
      git(worktree, "rev-parse", "--shared-index-path"),
    );

    const index = git(
      worktree,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    );

    const before = await Promise.all([index, shared].map((path) => stat(path)));
    await writeFile(join(worktree, "tracked"), "changed\n");
    expect(
      await createGitReader()(worktree, AbortSignal.timeout(4500)),
    ).toMatchObject({ branch: "worktree", changedFiles: 1 });
    const after = await Promise.all([index, shared].map((path) => stat(path)));
    expect(after.map((entry) => entry.mtimeMs)).toEqual(
      before.map((entry) => entry.mtimeMs),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a credential-shaped branch name as written", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

  try {
    git(directory, "init", "-b", "fix/token=fixture-value");
    git(directory, "commit", "--allow-empty", "-m", "Initial");
    expect(
      await createGitReader()(directory, AbortSignal.timeout(4500)),
    ).toMatchObject({ branch: "fix/token=fixture-value", changedFiles: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a primary index path outside the checkout and its Git directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

  try {
    const checkout = join(root, "checkout");
    const external = join(root, "external");
    await mkdir(checkout);
    await mkdir(external);
    git(checkout, "init", "-b", "main");
    await writeFile(join(checkout, "tracked"), "fixture\n");
    git(checkout, "add", "tracked");

    const index = git(
      checkout,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    );

    const externalIndex = join(external, "index");
    await fs.copyFile(index, externalIndex);

    const read = createGitReader(Date.now, async (args, options) => {
      const result = await readCommand(args, options);

      if (!result || !args.includes("--absolute-git-dir")) {
        return result;
      }

      return { ...result, stdout: result.stdout.replace(index, externalIndex) };
    });

    expect(await read(checkout, AbortSignal.timeout(3000))).toMatchObject({
      changedFiles: null,
      error: "Git state unavailable.",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["primary", "shared"])(
  "bounds an oversized %s index before invoking Git on either index",
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

    try {
      git(directory, "init", "-b", "main");
      await writeFile(join(directory, "tracked"), "fixture\n");
      git(directory, "add", "tracked");
      git(directory, "update-index", "--split-index");

      const index =
        kind === "primary"
          ? join(directory, ".git", "index")
          : join(directory, git(directory, "rev-parse", "--shared-index-path"));

      await truncate(index, 129 * 1024 * 1024);
      const indexCommands: string[][] = [];

      const read = createGitReader(Date.now, (args, options) => {
        if (args.includes("--shared-index-path") || args.includes("status")) {
          indexCommands.push(args);
        }

        return readCommand(args, options);
      });

      expect(await read(directory, AbortSignal.timeout(3000))).toMatchObject({
        changedFiles: null,
        error: "Git metadata exceeds the status read limit.",
      });
      expect(indexCommands).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.each(["absolute", "symlinked parent"])(
  "ignores a checkout excludes file outside the repository via a %s path",
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

    try {
      const checkout = join(directory, "checkout");
      const external = join(directory, "external");
      await mkdir(checkout);
      await mkdir(external);
      git(checkout, "init", "-b", "main");
      await writeFile(join(external, "patterns"), "untracked\n");
      await writeFile(join(checkout, "untracked"), "");
      const gitDir = join(checkout, ".git");
      await symlink(external, join(gitDir, "linked"), "dir");
      git(
        checkout,
        "config",
        "core.excludesFile",
        kind === "absolute"
          ? join(external, "patterns")
          : ".git/linked/patterns",
      );
      expect(
        await createGitReader()(checkout, AbortSignal.timeout(3000)),
      ).toMatchObject({ changedFiles: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("optional ignore metadata can be linked inside Git or skipped when unusable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

  try {
    git(directory, "init", "-b", "main");
    const gitDir = join(directory, ".git");
    const exclude = join(gitDir, "info", "exclude");
    await rm(exclude);
    await writeFile(join(gitDir, "local-patterns"), "ignored\n");
    await symlink("../local-patterns", exclude);
    git(directory, "config", "core.excludesFile", ".git/info");
    await writeFile(join(directory, "ignored"), "");
    await writeFile(join(directory, "visible"), "");
    expect(
      await createGitReader()(directory, AbortSignal.timeout(3000)),
    ).toMatchObject({ changedFiles: 1 });
    await rm(exclude);
    await symlink("missing", exclude);
    expect(
      await createGitReader()(directory, AbortSignal.timeout(3000)),
    ).toMatchObject({ changedFiles: 2 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["branch switch", "branch update", "switch during comparison"])(
  "rejects a Git snapshot after a %s",
  async (change) => {
    const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

    try {
      git(directory, "init", "-b", "main");
      const tracked = join(directory, "tracked");
      await writeFile(tracked, "first\n");
      git(directory, "add", ".");
      git(directory, "commit", "-m", "First");
      const start = git(directory, "rev-parse", "HEAD");
      await writeFile(tracked, "second\n");
      git(directory, "commit", "-am", "Second");
      const next = git(directory, "rev-parse", "HEAD");
      git(directory, "branch", "other", start);
      git(directory, "reset", "--hard", start);
      git(directory, "update-ref", "refs/remotes/origin/main", start);
      git(
        directory,
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
      );

      let moved = false;

      const read = createGitReader(Date.now, async (args, options) => {
        const result = await readCommand(args, options);

        if (moved) {
          return result;
        }

        if (
          (change === "branch switch" && args.includes("status")) ||
          (change === "switch during comparison" && args.includes("rev-list"))
        ) {
          git(directory, "switch", "other");
          moved = true;
        }

        if (change === "branch update" && args.includes("status")) {
          git(directory, "update-ref", "refs/heads/main", next);
          moved = true;
        }

        return result;
      });

      expect(await read(directory, AbortSignal.timeout(3000))).toMatchObject({
        branch: null,
        head: null,
        changedFiles: null,
        error: "Git state unavailable.",
      });
      expect(await read(directory, AbortSignal.timeout(3000))).toMatchObject({
        branch: change === "branch update" ? "main" : "other",
        commit: change === "branch update" ? next : start,
        changedFiles: change === "branch update" ? 1 : 0,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.each([
  ["status", "HEAD moved"],
  ["rev-list", "HEAD moved"],
  ["status", "HEAD unchanged"],
  ["rev-list", "HEAD unchanged"],
] as const)(
  "gateway Git %s failure only bypasses cache on a HEAD move (%s)",
  async (phase, head) => {
    const move = head === "HEAD moved";
    const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

    try {
      git(directory, "init", "-b", "main");
      git(directory, "commit", "--allow-empty", "-m", "First");
      git(directory, "branch", "other");
      git(directory, "update-ref", "refs/remotes/origin/main", "HEAD");
      git(
        directory,
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
      );
      let clock = 0;
      let injected = false;

      const read = createGitReader(
        Date.now,
        (args, options) => {
          if (!injected && args.includes(phase)) {
            injected = true;

            if (move) {
              git(directory, "symbolic-ref", "HEAD", "refs/heads/other");
            }

            return Promise.resolve({ code: 2, stdout: "" });
          }

          return readCommand(args, options);
        },
        undefined,
        undefined,
        () => clock,
      );

      const failed = await read(directory, AbortSignal.timeout(3000));
      expect(injected).toBe(true);
      expect(failed).toMatchObject({
        branch: null,
        changedFiles: null,
        error: "Git state unavailable.",
      });

      if (!move) {
        expect(await read(directory, AbortSignal.timeout(3000))).toBe(failed);
        clock += 15_001;
      }

      expect(await read(directory, AbortSignal.timeout(3000))).toMatchObject({
        branch: move ? "other" : "main",
        changedFiles: 0,
        ahead: 0,
        behind: 0,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("an unreadable final gateway HEAD after a good read is not cached", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

  try {
    git(directory, "init", "-b", "main");
    git(directory, "commit", "--allow-empty", "-m", "First");
    let heads = 0;

    const read = createGitReader(
      Date.now,
      (args, options) => {
        // The second HEAD read is the recheck after status.
        if (args.includes("symbolic-ref") && args.at(-1) === "HEAD") {
          heads++;

          if (heads === 2) {
            return Promise.resolve({ code: 128, stdout: "" });
          }
        }

        return readCommand(args, options);
      },
      undefined,
      undefined,
      () => 0,
    );

    expect(await read(directory, AbortSignal.timeout(3000))).toMatchObject({
      branch: null,
      changedFiles: null,
      error: "Git state unavailable.",
    });
    expect(heads).toBe(2);
    expect(await read(directory, AbortSignal.timeout(3000))).toMatchObject({
      branch: "main",
      changedFiles: 0,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([{ code: 2, stdout: "" }, { code: 1, stdout: "unexpected" }, null])(
  "a failed Git excludes configuration read does not run status (%j)",
  async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));
    let ranStatus = false;

    const read = createGitReader(Date.now, (args, options) => {
      if (args.includes("core.excludesFile")) {
        return Promise.resolve(failure);
      }

      ranStatus ||= args.includes("--porcelain=v1");

      return readCommand(args, options);
    });

    try {
      git(directory, "init", "-b", "main");
      expect(await read(directory, AbortSignal.timeout(3000))).toMatchObject({
        changedFiles: null,
        error: "Git state unavailable.",
      });
      expect(ranStatus).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("index inspection runs outside the gateway thread and stops at its deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));
  const mmap = spyOn(Bun, "mmap");
  const parsed = Promise.withResolvers<number | undefined>();
  let heartbeats = 0;
  const timer = setInterval(() => heartbeats++, 10);

  try {
    git(directory, "init", "-b", "main");
    await writeFile(join(directory, "tracked"), "fixture\n");
    git(directory, "add", "tracked");

    const read = createGitReader(Date.now, async (args, options) => {
      if (args[0] !== process.execPath) {
        return readCommand(args, options);
      }

      const before = heartbeats;

      const result = await readCommand(
        [process.execPath, "-e", "for (;;) {}"],
        options,
      );

      expect(heartbeats - before).toBeGreaterThan(1);
      parsed.resolve(result?.code);

      return result;
    });

    expect(await read(directory, AbortSignal.timeout(4000))).toMatchObject({
      error: "Git read timed out.",
    });
    expect(await parsed.promise).not.toBe(0);
    expect(mmap).not.toHaveBeenCalled();
  } finally {
    clearInterval(timer);
    mmap.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Git snapshot preparation gets a fresh deadline after the initial commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));
  const initial = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  let firstPhase = true;

  const clock = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    if (ms === 2000 && firstPhase) {
      firstPhase = false;

      return initial.signal;
    }

    return timeout(ms);
  });

  try {
    git(directory, "init", "-b", "main");

    const read = createGitReader(Date.now, (args, options) => {
      if (args.includes("--absolute-git-dir")) {
        initial.abort(new DOMException("Initial Git deadline", "TimeoutError"));
      }

      return readCommand(args, options);
    });

    expect(await read(directory, new AbortController().signal)).toMatchObject({
      branch: "main",
      changedFiles: 0,
    });
    expect(initial.signal.aborted).toBe(true);
  } finally {
    clock.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("caches an outer Git read timeout for 15 seconds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));
  const held = Promise.withResolvers<null>();
  let now = 100;
  let calls = 0;

  const read = createGitReader(
    () => now,
    async () => {
      if (++calls === 1) {
        return held.promise;
      }

      return { code: 1, stdout: "" };
    },
    undefined,
    undefined,
    () => now,
    // A short read budget keeps the test fast; half of it decides ownership.
    400,
  );

  const signal = new AbortController().signal;

  try {
    const result = await read(directory, signal);
    expect(result).toMatchObject({
      checkedAt: now,
      error: "Git read timed out.",
    });
    held.resolve(null);
    now += 14_999;
    expect(await read(directory, signal)).toBe(result);
    expect(calls).toBe(1);
    now++;
    expect(await read(directory, signal)).toMatchObject({
      checkedAt: now,
      error: "Git state unavailable.",
    });
    expect(calls).toBe(2);
  } finally {
    held.resolve(null);
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);

test("cache lifetimes follow the monotonic clock, not the wall clock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));
  let wall = 10_000_000;
  let mono = 100;
  let calls = 0;

  const read = createGitReader(
    () => wall,
    async () => {
      calls++;

      return { code: 1, stdout: "" };
    },
    undefined,
    undefined,
    () => mono,
  );

  const signal = new AbortController().signal;

  try {
    const first = await read(directory, signal);
    const reads = calls;
    // The wall clock jumps back an hour: the entry must still expire on time.
    wall -= 3_600_000;
    mono += 14_999;
    expect(await read(directory, signal)).toBe(first);
    expect(calls).toBe(reads);
    mono += 1;
    expect(await read(directory, signal)).not.toBe(first);
    expect(calls).toBeGreaterThan(reads);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the default cache clock ignores an injected wall clock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));
  let wall = 10_000_000;
  let calls = 0;

  // No fifth argument: cache lifetimes must not follow the injected wall clock.
  const read = createGitReader(
    () => wall,
    async () => {
      calls++;

      return { code: 1, stdout: "" };
    },
  );

  const signal = new AbortController().signal;

  try {
    const first = await read(directory, signal);
    const reads = calls;
    wall += 3_600_000;
    expect(await read(directory, signal)).toBe(first);
    expect(calls).toBe(reads);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a read that gets its slot late caches its timeout only briefly", async () => {
  const root = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

  const busy = [0, 1, 2, 3].map((n) => ({
    directory: join(root, `busy-${n}`),
    result: Promise.withResolvers<null>(),
    started: Promise.withResolvers<void>(),
  }));

  const heldByCwd = new Map(busy.map((hold) => [hold.directory, hold]));
  const target = join(root, "late");
  const late = Promise.withResolvers<null>();
  const started = Promise.withResolvers<void>();
  const deadline = new AbortController();
  let mono = 100;
  let calls = 0;
  let targetStarted = false;

  const read = createGitReader(
    Date.now,
    async (_args, options) => {
      calls++;
      const hold = options.cwd ? heldByCwd.get(options.cwd) : undefined;

      if (hold) {
        hold.started.resolve();

        return hold.result.promise;
      }

      if (options.cwd === target && !targetStarted) {
        targetStarted = true;
        started.resolve();

        return late.promise;
      }

      return { code: 1, stdout: "" };
    },
    undefined,
    undefined,
    () => mono,
    400,
  );

  const signal = new AbortController().signal;
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(signal);

  try {
    for (const directory of [...heldByCwd.keys(), target]) {
      await mkdir(directory);
    }

    const busyReads = busy.map((hold) => read(hold.directory, signal));
    await Promise.all(busy.map((hold) => hold.started.promise));
    // Its 400 ms budget ends at 500; it gets a slot at 350, with less than
    // Half of it left.
    timeout.mockReturnValue(deadline.signal);
    const pending = read(target, signal);
    timeout.mockRestore();
    mono = 350;
    busy[0]?.result.resolve(null);
    await busyReads[0];
    await started.promise;
    deadline.abort(new DOMException("Read timed out", "TimeoutError"));
    const timedOut = await pending;
    expect(timedOut).toMatchObject({ error: "Git read timed out." });
    expect(calls).toBe(5);

    for (const hold of busy) {
      hold.result.resolve(null);
    }

    late.resolve(null);
    await Promise.all(busyReads);
    mono += 199;
    expect(await read(target, signal)).toBe(timedOut);
    // The short lifetime, not the 15-second one, has now passed.
    mono += 1;
    expect(await read(target, signal)).toMatchObject({
      error: "Git state unavailable.",
    });
  } finally {
    timeout.mockRestore();

    for (const hold of busy) {
      hold.result.resolve(null);
    }

    late.resolve(null);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("caches a timeout spent only waiting for a read slot briefly", async () => {
  const root = await mkdtemp(join(tmpdir(), "stargate-api-git-"));
  const held = Promise.withResolvers<null>();
  let now = 100;
  let calls = 0;

  const read = createGitReader(
    () => now,
    async () => {
      // The first four reads each hold a slot; later calls fail fast.
      if (++calls <= 4) {
        return held.promise;
      }

      return { code: 1, stdout: "" };
    },
    undefined,
    undefined,
    () => now,
    400,
  );

  const signal = new AbortController().signal;

  try {
    for (const name of ["busy-1", "busy-2", "busy-3", "busy-4", "waiting"]) {
      await mkdir(join(root, name));
    }

    const busy = [1, 2, 3, 4].map((n) => read(join(root, `busy-${n}`), signal));
    const waiting = join(root, "waiting");
    const timedOut = await read(waiting, signal);
    expect(timedOut).toMatchObject({ error: "Git read timed out." });
    // Under saturation the next poll answers from the short cache without
    // Reaching Git or waiting for a slot.
    expect(await read(waiting, signal)).toBe(timedOut);
    expect(calls).toBe(4);
    held.resolve(null);
    await Promise.all(busy);
    // After half the read budget the queue-only timeout is gone: this read runs.
    now += 200;
    expect(await read(waiting, signal)).toMatchObject({
      error: "Git state unavailable.",
    });
    expect(calls).toBeGreaterThan(4);
  } finally {
    held.resolve(null);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test.each(["success", "failure"])(
  "stores private index copies under the data directory and cleans up after %s",
  async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

    try {
      const directory = join(root, "checkout");
      const dataDirectory = join(root, "data");
      await mkdir(directory);
      await mkdir(dataDirectory, { mode: 0o700 });
      git(directory, "init", "-b", "main");
      await writeFile(join(directory, "tracked"), "fixture\n");
      git(directory, "add", "tracked");
      let parent: string | undefined;
      let mode: number | undefined;

      const read = createGitReader(
        Date.now,
        async (args, options) => {
          const snapshot = options.env["GIT_DIR"];

          if (snapshot && args.includes("status")) {
            parent = dirname(snapshot);
            mode = (await stat(snapshot)).mode & 0o777;
            expect((await stat(join(snapshot, "index"))).size).toBeGreaterThan(
              0,
            );

            if (outcome === "failure") {
              return { code: 1, stdout: "" };
            }
          }

          return readCommand(args, options);
        },
        dataDirectory,
      );

      const result = await read(directory, AbortSignal.timeout(3000));
      expect(result?.error).toBe(
        outcome === "failure" ? "Git state unavailable." : undefined,
      );

      const snapshots = join(
        await realpath(dataDirectory),
        "stargate-git-status",
      );

      expect(parent).toBe(snapshots);
      expect((await stat(snapshots)).mode & 0o777).toBe(0o700);
      expect(mode).toBe(0o700);
      await waitForRemoval(snapshots);
      expect(await readdir(snapshots)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("rejects the temporary snapshot fallback inside the checkout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

  try {
    git(directory, "init", "-b", "main");
    const temporary = join(directory, "tmp");
    await mkdir(temporary);
    expect(
      await createGitReader(
        Date.now,
        undefined,
        undefined,
        () => temporary,
      )(directory, AbortSignal.timeout(3000)),
    ).toMatchObject({ changedFiles: null, error: "Git state unavailable." });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("leaves a planted temporary snapshot directory untouched", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "stargate-api-git-")),
  );

  const checkout = join(root, "checkout");
  const planted = join(root, "stargate-git-status");
  const stale = join(planted, "stargate-git-status-Stale1");
  const parents: string[] = [];

  const reader = () =>
    createGitReader(
      Date.now,
      async (args, options) => {
        const snapshot = options.env["GIT_DIR"];

        if (snapshot && args.includes("status")) {
          parents.push(dirname(snapshot));
        }

        return readCommand(args, options);
      },
      undefined,
      () => root,
    );

  const first = reader();
  const second = reader();

  try {
    await mkdir(checkout);
    git(checkout, "init", "-b", "main");
    await mkdir(planted, { mode: 0o700 });
    await mkdir(stale, { mode: 0o700 });
    const old = new Date(Date.now() - 25 * 60 * 60_000);
    await utimes(stale, old, old);
    const signal = new AbortController().signal;

    const results = await Promise.all([
      first(checkout, signal),
      second(checkout, signal),
    ]);

    expect(results).toMatchObject([{ changedFiles: 0 }, { changedFiles: 0 }]);
    expect(parents).toHaveLength(2);
    const [parent] = parents;

    if (!parent) {
      throw new Error("No temporary snapshot directory");
    }

    expect(dirname(parent)).toBe(root);
    expect(parent).not.toBe(planted);
    expect(parents).toEqual([parent, parent]);
    expect((await stat(parent)).mode & 0o777).toBe(0o700);
    expect((await stat(parent)).uid).toBe(process.getuid?.() ?? -1);
    await first.stop();
    expect((await stat(parent)).isDirectory()).toBe(true);
    await second.stop();
    expect((await readdir(root)).sort()).toEqual([
      "checkout",
      "stargate-git-status",
    ]);
    expect(await readdir(planted)).toEqual(["stargate-git-status-Stale1"]);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a snapshot root with a writable non-sticky ancestor", async () => {
  const root = await mkdtemp(join(tmpdir(), "stargate-api-git-"));
  const shared = join(root, "shared");
  const unsafe = join(shared, "private");
  const checkout = join(root, "checkout");
  const read = createGitReader(Date.now, readCommand, unsafe, () => unsafe);

  try {
    await mkdir(shared);
    await chmod(shared, 0o777);
    await mkdir(unsafe, { mode: 0o700 });
    await mkdir(checkout);
    git(checkout, "init", "-b", "main");
    expect(await read(checkout, new AbortController().signal)).toMatchObject({
      error: "Git state unavailable.",
    });
    expect(await readdir(unsafe)).toEqual([]);
  } finally {
    await read.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a temporary root reached through a symlink is checked and used canonically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));
  const outside = await mkdtemp(join(tmpdir(), "stargate-api-git-tmp-"));
  const links = await mkdtemp(join(tmpdir(), "stargate-api-git-link-"));

  try {
    git(directory, "init", "-b", "main");
    await writeFile(join(directory, "tracked.txt"), "x\n");
    const link = join(links, "tmp");
    // Points into the checkout: rejected, even though the link itself is outside.
    await symlink(join(directory), link);
    expect(
      await createGitReader(
        Date.now,
        undefined,
        undefined,
        () => link,
      )(directory, AbortSignal.timeout(3000)),
    ).toMatchObject({ changedFiles: null, error: "Git state unavailable." });
    // Points outside the checkout: the read works, and Git gets a snapshot under
    // The resolved directory, not under the link.
    await rm(link);
    await symlink(outside, link);
    let parent: string | undefined;
    expect(
      await createGitReader(
        Date.now,
        async (args, options) => {
          const snapshot = options.env["GIT_DIR"];

          if (snapshot && args.includes("status")) {
            parent = dirname(snapshot);
          }

          return readCommand(args, options);
        },
        undefined,
        () => link,
      )(directory, AbortSignal.timeout(3000)),
    ).toMatchObject({ changedFiles: 1 });
    expect(parent && dirname(parent)).toBe(await realpath(outside));
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    await rm(links, { recursive: true, force: true });
  }
});

test("the documented copy limit leaves a large worktree .gitignore usable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

  try {
    git(directory, "init", "-b", "main");
    await writeFile(
      join(directory, ".gitignore"),
      `${"# padding\n".repeat(210_000)}ignored\n`,
    );
    await writeFile(join(directory, "ignored"), "fixture\n");
    expect(
      await createGitReader()(directory, AbortSignal.timeout(3000)),
    ).toMatchObject({ changedFiles: 1 });

    const docs = await Bun.file(
      new URL("../docs/api.md", import.meta.url),
    ).text();

    expect(docs).toContain(
      "The 1 MiB limit applies to each copied pattern file.",
    );
    expect(docs).toContain("Git reads worktree `.gitignore` files directly.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("status ignores checkout configuration added immediately before it starts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

  try {
    git(directory, "init", "-b", "main");
    git(directory, "config", "core.trustctime", "false");
    const tracked = join(directory, "tracked.txt");
    const marker = join(directory, ".git", "filter-ran");
    const index = join(directory, ".git", "index");
    const timestamp = 1_600_000_000;
    await writeFile(tracked, "original\n");
    await utimes(tracked, timestamp, timestamp);
    await writeFile(
      join(directory, ".gitattributes"),
      "tracked.txt filter=fixture\n",
    );
    await writeFile(
      join(directory, ".git", "info", "attributes"),
      "tracked.txt filter=fixture\n",
    );
    git(directory, "add", ".");
    git(directory, "commit", "-m", "Initial");
    await writeFile(tracked, "modified\n");
    await utimes(tracked, timestamp, timestamp);
    await utimes(index, timestamp, timestamp);

    const read = createGitReader(Date.now, async (args, options) => {
      if (args.includes("status")) {
        // Run in the fixture checkout and preserve the filter's input.
        git(
          directory,
          "config",
          "filter.fixture.clean",
          "touch .git/filter-ran && cat",
        );
        git(directory, "config", "filter.fixture.required", "true");
      }

      return readCommand(args, options);
    });

    const result = await read(directory, new AbortController().signal);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(result).toMatchObject({
      branch: "main",
      changedFiles: 1,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("isolated status honours a repository excludes file and info/exclude precedence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

  try {
    git(directory, "init", "-b", "main");
    git(directory, "config", "core.excludesFile", ".git/fixture-excludes");
    await writeFile(
      join(directory, ".git", "fixture-excludes"),
      "generated-*\n",
    );
    await writeFile(
      join(directory, ".git", "info", "exclude"),
      "!generated-keep\n",
    );
    await writeFile(join(directory, "generated-ignore"), "");
    await writeFile(join(directory, "generated-keep"), "");
    expect(
      await createGitReader()(directory, new AbortController().signal),
    ).toMatchObject({ changedFiles: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["info/exclude", "fixture-excludes"])(
  "isolated status refuses oversized %s metadata before running status",
  async (name) => {
    const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

    try {
      git(directory, "init", "-b", "main");
      const metadata = join(directory, ".git", name);

      if (name === "fixture-excludes") {
        await writeFile(metadata, "");
        git(directory, "config", "core.excludesFile", metadata);
      }

      await truncate(metadata, 2 * 1024 * 1024);
      let ranStatus = false;

      const read = createGitReader(Date.now, (args, options) => {
        ranStatus ||= args.includes("status");

        return readCommand(args, options);
      });

      expect(await read(directory, new AbortController().signal)).toMatchObject(
        {
          changedFiles: null,
          error: "Git metadata exceeds the status read limit.",
        },
      );
      expect(ranStatus).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("split index files share one aggregate metadata budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

  try {
    git(directory, "init", "-b", "main");
    await writeFile(join(directory, "tracked"), "fixture\n");
    git(directory, "add", "tracked");
    git(directory, "update-index", "--split-index");

    const shared = join(
      directory,
      git(directory, "rev-parse", "--shared-index-path"),
    );

    const index = join(directory, ".git", "index");
    const size = 97 * 1024 * 1024;
    const file = await open(index, "r+");

    try {
      // Leave the real link extension intact and pad the primary index with an
      // Optional extension. Each file fits its individual limit.
      const trailer = (await file.stat()).size - 20;
      const padding = Buffer.from("TEST\0\0\0\0");
      padding.writeUInt32BE(size - trailer - padding.length - 20, 4);
      await file.write(padding, 0, padding.length, trailer);
      await file.truncate(size);
    } finally {
      await file.close();
    }

    await truncate(shared, size);
    let ranStatus = false;

    const read = createGitReader(Date.now, (args, options) => {
      ranStatus ||= args.includes("status");

      return readCommand(args, options);
    });

    expect(await read(directory, new AbortController().signal)).toMatchObject({
      changedFiles: null,
      error: "Git metadata exceeds the status read limit.",
    });
    expect(ranStatus).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a metadata file growing during the snapshot still hits the byte limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

  try {
    git(directory, "init", "-b", "main");
    const exclude = join(directory, ".git", "info", "exclude");
    const inode = (await stat(exclude)).ino;
    const handle = await open(exclude);
    const createReadStream = handle.createReadStream;

    const streams = spyOn(
      Object.getPrototypeOf(handle) as typeof handle,
      "createReadStream",
    );

    await handle.close();
    streams.mockImplementation(function (this: typeof handle, options) {
      if (fstatSync(this.fd).ino === inode) {
        appendFileSync(exclude, Buffer.alloc(2 * 1024 * 1024, 10));
      }

      return createReadStream.call(this, options);
    });

    try {
      expect(
        await createGitReader()(directory, new AbortController().signal),
      ).toMatchObject({
        changedFiles: null,
        error: "Git metadata exceeds the status read limit.",
      });
    } finally {
      streams.mockRestore();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the index snapshot falls back to streaming in large blocks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

  try {
    git(directory, "init", "-b", "main");
    await writeFile(join(directory, "tracked"), "fixture\n");
    git(directory, "add", ".");
    git(directory, "commit", "-m", "Initial");
    const handle = await open(join(directory, ".git", "index"));
    const inode = (await handle.stat()).ino;
    const createReadStream = handle.createReadStream;

    const streams = spyOn(
      Object.getPrototypeOf(handle) as typeof handle,
      "createReadStream",
    );

    await handle.close();
    const blockSizes: (number | undefined)[] = [];
    streams.mockImplementation(function (this: typeof handle, options) {
      if (fstatSync(this.fd).ino === inode) {
        blockSizes.push(options?.highWaterMark);
      }

      return createReadStream.call(this, options);
    });

    const clone = spyOn(fs, "copyFile").mockRejectedValue(
      new Error("Clone unsupported"),
    );

    try {
      expect(
        await createGitReader()(directory, new AbortController().signal),
      ).toMatchObject({ changedFiles: 0 });
      expect(blockSizes).toEqual([1024 * 1024]);
    } finally {
      clone.mockRestore();
      streams.mockRestore();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")(
  "uses the clone of the pinned index when supported",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));
    const copyFile = fs.copyFile;

    const clones = spyOn(fs, "copyFile").mockImplementation(
      async (source, target, flags) => {
        expect(source).toMatch(/^\/proc\/self\/fd\/\d+$/);
        expect(flags).toBe(constants.COPYFILE_FICLONE_FORCE);
        // Model a successful reflink even on a test filesystem without support.
        await copyFile(source, target);
        // The original pathname may be replaced before Git loads the snapshot.
        await rm(join(directory, ".git", "index"));
      },
    );

    try {
      git(directory, "init", "-b", "main");
      await writeFile(join(directory, "tracked"), "fixture\n");
      git(directory, "add", ".");
      git(directory, "commit", "-m", "Initial");
      expect(
        await createGitReader()(directory, AbortSignal.timeout(4500)),
      ).toMatchObject({ changedFiles: 0 });
      expect(clones).toHaveBeenCalledTimes(1);
    } finally {
      clones.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("isolated status detects same-size edits with a racy index timestamp", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

  try {
    git(directory, "init", "-b", "main");
    git(directory, "config", "core.trustctime", "false");
    const tracked = join(directory, "tracked.txt");
    const timestamp = 1_600_000_000;
    await writeFile(tracked, "original\n");
    await utimes(tracked, timestamp, timestamp);
    git(directory, "add", ".");
    git(directory, "commit", "-m", "Initial");
    await writeFile(tracked, "modified\n");
    await utimes(tracked, timestamp, timestamp);
    await utimes(join(directory, ".git", "index"), timestamp, timestamp);
    expect(
      await createGitReader()(directory, new AbortController().signal),
    ).toMatchObject({ changedFiles: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("status rejects a private temporary directory inside the checkout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

  try {
    git(directory, "init", "-b", "main");
    git(directory, "commit", "--allow-empty", "-m", "Initial");
    const temporary = join(directory, "private-temp");
    await mkdir(temporary, { mode: 0o700 });

    const read = createGitReader(
      Date.now,
      readCommand,
      undefined,
      () => temporary,
    );

    expect(await read(directory, new AbortController().signal)).toMatchObject({
      branch: null,
      changedFiles: null,
      error: "Git state unavailable.",
    });
    expect(await readdir(temporary)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("status ignores worktree and info attributes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

  try {
    git(directory, "init", "-b", "main");
    await writeFile(
      join(directory, ".gitattributes"),
      "tracked.txt text eol=lf\n",
    );
    await writeFile(
      join(directory, ".git", "info", "attributes"),
      "other.txt text eol=lf\n",
    );

    // Git stores LF but records the CRLF files' size.
    // A new mtime alone then makes status compare contents.
    // They match only when the attributes apply.
    for (const name of ["tracked.txt", "other.txt"]) {
      await writeFile(join(directory, name), "original\r\n");
    }

    git(directory, "add", ".");
    git(directory, "commit", "-m", "Initial");

    const supportsAttributeSource =
      Bun.spawnSync(
        ["git", "--attr-source=HEAD", "check-attr", "text", "tracked.txt"],
        { cwd: directory },
      ).exitCode === 0;

    for (const name of ["tracked.txt", "other.txt"]) {
      await utimes(join(directory, name), 1_000_000_000, 1_000_000_000);
    }

    expect(
      await createGitReader()(directory, new AbortController().signal),
    ).toMatchObject({ changedFiles: supportsAttributeSource ? 2 : 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["sha1", "sha256"])(
  "isolated status preserves changes and excludes in a linked worktree with a %s version 4 split index",
  async (format) => {
    const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));
    const checkout = join(directory, "checkout");
    const worktree = join(directory, "worktree");

    try {
      await mkdir(checkout);
      git(checkout, "init", "-b", "main", `--object-format=${format}`);
      await writeFile(join(checkout, "tracked.txt"), "original\n");
      git(checkout, "add", ".");
      git(checkout, "commit", "-m", "Initial");
      git(checkout, "worktree", "add", "-b", "work", worktree);
      await writeFile(join(checkout, ".git", "info", "exclude"), "ignored\n");
      await writeFile(join(worktree, "ignored"), "ignore\n");
      await writeFile(join(worktree, "tracked.txt"), "modified\n");
      await writeFile(join(worktree, "staged"), "staged\n");
      git(worktree, "add", "staged");
      git(worktree, "config", "splitIndex.maxPercentChange", "100");
      git(worktree, "update-index", "--index-version=4", "--split-index");
      await writeFile(join(worktree, "new-entry"), "new\n");
      git(worktree, "add", "new-entry");

      const index = git(
        worktree,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index",
      );

      const header = Buffer.from(await Bun.file(index).slice(0, 12).bytes());
      expect(header.readUInt32BE(4)).toBe(4);
      expect(
        await createGitReader()(worktree, new AbortController().signal),
      ).toMatchObject({ branch: "work", changedFiles: 3 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.each(["clean", "process"])(
  "reads changed paths with a checkout-configured %s filter disabled",
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

    try {
      git(directory, "init", "-b", "main");
      const tracked = join(directory, "tracked.txt");
      await writeFile(tracked, "original\n");
      await writeFile(
        join(directory, ".gitattributes"),
        "tracked.txt filter=fixture\n",
      );
      git(directory, "add", ".");
      git(directory, "commit", "-m", "Initial");
      git(directory, "config", `filter.fixture.${kind}`, "false");
      git(directory, "config", "filter.fixture.required", "true");
      await writeFile(tracked, "modified\n");
      expect(
        await createGitReader()(directory, new AbortController().signal),
      ).toMatchObject({ branch: "main", changedFiles: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("stalled removal holds Git status permits beyond the caller deadline", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "stargate-api-git-")),
  );

  const data = join(root, "data");
  const snapshots = join(data, "stargate-git-status");
  const held = Promise.withResolvers<void>();
  const original = fs.rm;
  const full = Promise.withResolvers<void>();
  let removing = 0;

  const removals = spyOn(fs, "rm").mockImplementation(async (path, options) => {
    if (String(path).startsWith(join(snapshots, "stargate-git-status-"))) {
      if (++removing === 4) {
        full.resolve();
      }

      await held.promise;
    }

    return original(path, options);
  });

  try {
    await mkdir(data, { mode: 0o700 });

    const checkouts = await Promise.all(
      Array.from({ length: 8 }, async (_, id) => {
        const path = join(root, String(id));
        await mkdir(path);
        git(path, "init", "-b", "main");

        return path;
      }),
    );

    let now = Date.now();

    const read = createGitReader(
      () => now,
      readCommand,
      data,
      undefined,
      () => now,
    );

    const reads = checkouts.map((path) =>
      read(path, new AbortController().signal),
    );

    const first = await Promise.race([
      Promise.race(reads),
      Bun.sleep(1500).then(() => "blocked"),
    ]);

    expect(first).toMatchObject({ changedFiles: 0 });
    await full.promise;
    const results = await Promise.all(reads);
    expect(results.filter((result) => result?.changedFiles === 0)).toHaveLength(
      4,
    );
    expect(
      results.filter((result) => result?.error === "Git read timed out."),
    ).toHaveLength(4);
    expect(removing).toBe(4);

    const waiting =
      checkouts[results.findIndex((result) => result?.changedFiles === null)];

    // Those timeouts only waited for a slot, so they are cached only for one
    // Read deadline: answered at once now, then the read waits for a slot.
    expect(await read(waiting, AbortSignal.timeout(100))).toMatchObject({
      error: "Git read timed out.",
    });
    now += 2000;
    await expect(read(waiting, AbortSignal.timeout(100))).rejects.toMatchObject(
      { name: "TimeoutError" },
    );
    expect(removing).toBe(4);
    held.resolve();
    await waitForRemoval(snapshots);
    expect(await read(waiting, AbortSignal.timeout(1000))).toMatchObject({
      changedFiles: 0,
    });
    await waitForRemoval(snapshots);
  } finally {
    held.resolve();
    removals.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 8000);

test("startup sweeps old Git snapshots only inside the private snapshot directory", async () => {
  const data = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

  try {
    const snapshots = join(data, "stargate-git-status");
    await mkdir(snapshots, { mode: 0o700 });
    const stale = join(snapshots, "stargate-git-status-Stale1");
    const fresh = join(snapshots, "stargate-git-status-Fresh1");
    const unrelated = join(data, "stargate-git-status-Backup");
    await Promise.all(
      [stale, fresh, unrelated].map((path) => mkdir(path, { mode: 0o700 })),
    );
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const linkedRoot = join(data, "linked");
    const linkedStale = join(unrelated, "stargate-git-status-Stale2");
    await mkdir(linkedRoot);
    await mkdir(linkedStale, { mode: 0o700 });
    await symlink(unrelated, join(linkedRoot, "stargate-git-status"));
    await Promise.all(
      [stale, unrelated, linkedStale].map((path) => utimes(path, old, old)),
    );
    createGitReader(Date.now, readCommand, linkedRoot);
    createGitReader(Date.now, readCommand, data);
    await waitForRemoval(snapshots, "stargate-git-status-Stale1");
    expect(await readdir(unrelated)).toEqual(["stargate-git-status-Stale2"]);
    expect(await readdir(snapshots)).toEqual(["stargate-git-status-Fresh1"]);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("snapshot preparation leaves Git status its full two-second budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));

  try {
    git(directory, "init", "-b", "main");
    await writeFile(join(directory, "tracked"), "fixture");
    git(directory, "add", ".");

    const read = createGitReader(Date.now, async (args, options) => {
      if (args[0] === process.execPath) {
        await Bun.sleep(650);
      }

      if (args.includes("status")) {
        await Bun.sleep(1450);
      }

      return readCommand(args, options);
    });

    expect(await read(directory, AbortSignal.timeout(4500))).toMatchObject({
      changedFiles: 1,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
