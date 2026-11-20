import { expect, spyOn, test } from "bun:test";
import { appendFileSync, fstatSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  rm,
  stat,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
}

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
    const gitDir = join(directory, ".git");
    const index = join(gitDir, "index");
    const shared = join(gitDir, `sharedindex.${"a".repeat(40)}`);
    for (const path of [index, shared]) {
      await writeFile(path, "");
      // Each file fits its individual limit.
      await truncate(path, 97 * 1024 * 1024);
    }
    let ranStatus = false;
    const read = createGitReader(Date.now, (args, options) => {
      if (args.includes("--shared-index-path"))
        return Promise.resolve({
          code: 0,
          stdout: [
            join(gitDir, "objects"),
            index,
            join(gitDir, "info", "exclude"),
            join(gitDir, "info", "sparse-checkout"),
            "sha1",
            shared,
            "",
          ].join("\n"),
        });
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

test("isolated status preserves changes and excludes in a linked worktree with a split index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));
  const checkout = join(directory, "checkout");
  const worktree = join(directory, "worktree");
  try {
    await mkdir(checkout);
    git(checkout, "init", "-b", "main");
    await writeFile(join(checkout, "tracked.txt"), "original\n");
    git(checkout, "add", ".");
    git(checkout, "commit", "-m", "Initial");
    git(checkout, "worktree", "add", "-b", "work", worktree);
    await writeFile(join(checkout, ".git", "info", "exclude"), "ignored\n");
    await writeFile(join(worktree, "ignored"), "ignore\n");
    await writeFile(join(worktree, "tracked.txt"), "modified\n");
    await writeFile(join(worktree, "staged"), "staged\n");
    git(worktree, "add", "staged");
    git(worktree, "update-index", "--split-index");
    expect(
      await createGitReader()(worktree, new AbortController().signal),
    ).toMatchObject({ branch: "work", changedFiles: 2 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
