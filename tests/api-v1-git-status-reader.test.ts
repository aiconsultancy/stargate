import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { readCommand } from "../src/observability/dashboard/api/v1/command";
import {
  git,
  stoppedGitReaders,
  waitForRemoval,
} from "./api-v1-git-status-fixture";

// The gateway Git status reader's cache, deadlines, read slots and private
// Snapshot folders. What its isolated status read sees is in
// Api-v1-git-status.test.ts.
const createGitReader = stoppedGitReaders();

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

test.each([
  ["is not private", "shared"],
  ["is inside the checkout", "inside"],
  ["cannot be made", "read-only"],
] as const)(
  "uses the temporary snapshot root when the data directory's folder %s",
  async (_, kind) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "stargate-api-git-")),
    );

    const directory = join(root, "checkout");

    const dataDirectory =
      kind === "inside" ? join(directory, "data") : join(root, "data");

    try {
      await mkdir(directory);
      git(directory, "init", "-b", "main");
      await mkdir(dataDirectory, { mode: 0o700 });

      if (kind === "shared") {
        const snapshots = join(dataDirectory, "stargate-git-status");
        await mkdir(snapshots);
        await chmod(snapshots, 0o750);
      } else if (kind === "read-only") {
        // Making the status folder fails with EACCES.
        await chmod(dataDirectory, 0o500);
      }

      let parent: string | undefined;

      const read = createGitReader(
        Date.now,
        (args, options) => {
          const snapshot = options.env["GIT_DIR"];

          if (snapshot && args.includes("status")) {
            parent = dirname(snapshot);
          }

          return readCommand(args, options);
        },
        dataDirectory,
      );

      expect(await read(directory, AbortSignal.timeout(3000))).toMatchObject({
        changedFiles: 0,
      });
      expect(parent && dirname(parent)).toBe(await realpath(tmpdir()));
      expect(parent && basename(parent)).toStartWith("stargate-git-status-");
    } finally {
      await chmod(dataDirectory, 0o700).catch(() => {});
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
