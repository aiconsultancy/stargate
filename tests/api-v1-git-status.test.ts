import { expect, spyOn, test } from "bun:test";
import { appendFileSync, fstatSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCommand } from "../src/api/v1/command";
import { createGitReader } from "../src/api/v1/git";

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
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

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
        if (args.includes("--shared-index-path") || args.includes("status"))
          indexCommands.push(args);
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

test.each(["branch switch", "branch update"])(
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
      const read = createGitReader(Date.now, async (args, options) => {
        const result = await readCommand(args, options);
        if (args.includes("status")) {
          if (change === "branch switch") git(directory, "switch", "other");
          else git(directory, "update-ref", "refs/heads/main", next);
        }
        return result;
      });
      expect(await read(directory, AbortSignal.timeout(3000))).toMatchObject({
        branch: null,
        head: null,
        changedFiles: null,
        error: "Git state unavailable.",
      });
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
      if (args[0] !== process.execPath) return readCommand(args, options);
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
            if (outcome === "failure") return { code: 1, stdout: "" };
          }
          return readCommand(args, options);
        },
        dataDirectory,
      );
      const result = await read(directory, AbortSignal.timeout(3000));
      expect(result?.error).toBe(
        outcome === "failure" ? "Git state unavailable." : undefined,
      );
      expect(parent).toBe(dataDirectory);
      expect(mode).toBe(0o700);
      expect(await readdir(dataDirectory)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

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
      // optional extension. Each file fits its individual limit.
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
      if (fstatSync(this.fd).ino === inode)
        appendFileSync(exclude, Buffer.alloc(2 * 1024 * 1024, 10));
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

test("the status index snapshots stream in large blocks", async () => {
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
      if (fstatSync(this.fd).ino === inode)
        blockSizes.push(options?.highWaterMark);
      return createReadStream.call(this, options);
    });
    try {
      expect(
        await createGitReader()(directory, new AbortController().signal),
      ).toMatchObject({ changedFiles: 0 });
      expect(blockSizes).toEqual([1024 * 1024]);
    } finally {
      streams.mockRestore();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
    for (const name of ["tracked.txt", "other.txt"])
      await writeFile(join(directory, name), "original\n");
    git(directory, "add", ".");
    git(directory, "commit", "-m", "Initial");
    const supportsAttributeSource =
      Bun.spawnSync(
        ["git", "--attr-source=HEAD", "check-attr", "text", "tracked.txt"],
        { cwd: directory },
      ).exitCode === 0;
    for (const name of ["tracked.txt", "other.txt"])
      await writeFile(join(directory, name), "original\r\n");
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
