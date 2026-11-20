import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    const tracked = join(directory, "tracked.txt");
    await writeFile(tracked, "original\n");
    await writeFile(
      join(directory, ".gitattributes"),
      "tracked.txt filter=fixture\n",
    );
    git(directory, "add", ".");
    git(directory, "commit", "-m", "Initial");
    await writeFile(tracked, "modified\n");
    const read = createGitReader(Date.now, async (args, options) => {
      // A required driver without a command is inert, but rejects conversion
      // if status consults this newly added filter configuration.
      if (args.includes("status"))
        git(directory, "config", "filter.fixture.required", "true");
      return readCommand(args, options);
    });
    expect(await read(directory, new AbortController().signal)).toMatchObject({
      branch: "main",
      changedFiles: 1,
    });
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
