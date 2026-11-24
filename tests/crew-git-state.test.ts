import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import {
  countChangedPaths,
  crewGitStateSchema,
  parseAheadBehind,
} from "../src/coordination/crew/reporting/fleet-status";
import {
  createCrewGitReader,
  remoteWithoutUser,
} from "../src/coordination/crew/workspace/workspace";

const root = await realpath(
  await mkdtemp(join(tmpdir(), "stargate-crew-git-")),
);

afterAll(() => rm(root, { recursive: true, force: true }));

const signal = new AbortController().signal;

async function git(directory: string, ...args: string[]) {
  const child = Bun.spawn(
    [
      "git",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  );

  const output = await new Response(child.stdout).text();

  if ((await child.exited) !== 0) {
    throw new Error(`git ${args.join(" ")}`);
  }

  return output.trim();
}

let count = 0;

async function repository() {
  const directory = join(root, `repo-${count++}`);
  await mkdir(directory);
  await git(directory, "init");
  await git(directory, "commit", "--allow-empty", "-m", "first");

  return directory;
}

test("porcelain -z counts rename/copy records once and accepts literal path whitespace", () => {
  expect(countChangedPaths("")).toBe(0);
  expect(
    countChangedPaths(
      [
        " M file with spaces",
        "?? path\nwith a newline",
        "R  new path",
        "old path",
        " C new copy",
        "source",
        " D file-to-remove",
        "A  new file",
        "",
      ].join("\0"),
    ),
  ).toBe(6);
  expect(countChangedPaths("R  incomplete\0")).toBeNull();
  expect(countChangedPaths("?? missing terminator")).toBeNull();
  expect(parseAheadBehind("2\t7\n")).toEqual({ ahead: 7, behind: 2 });
  expect(parseAheadBehind("0 0")).toEqual({ ahead: 0, behind: 0 });
  expect(parseAheadBehind("log output")).toBeNull();
  expect(parseAheadBehind("2 9007199254740992")).toBeNull();
});

test("remote URLs lose user information and keep the SCP form", () => {
  expect(
    remoteWithoutUser("https://user:secret@github.com/example/project.git\n"),
  ).toBe("https://github.com/example/project.git");
  expect(remoteWithoutUser("git@github.com:example/project.git")).toBe(
    "git@github.com:example/project.git",
  );
  expect(remoteWithoutUser("")).toBeNull();
});

test("reads branch, commit, base, counts, dirty state and remote", async () => {
  const origin = await repository();
  const directory = join(root, "clone");
  await git(root, "clone", "--quiet", origin, directory);
  await git(
    directory,
    "switch",
    "--quiet",
    "-c",
    "feature",
    "--track",
    "origin/main",
  );
  await git(directory, "commit", "--allow-empty", "-m", "ahead");
  await writeFile(join(directory, "new.txt"), "changed\n");
  await git(
    directory,
    "remote",
    "set-url",
    "origin",
    "https://user:secret@github.com/example/project.git",
  );
  const commit = await git(directory, "rev-parse", "HEAD");

  const state = await createCrewGitReader(() => 42)(directory, signal);

  expect(Schema.decodeUnknownSync(crewGitStateSchema)(state)).toEqual({
    branch: "feature",
    commit,
    base: "origin/main",
    ahead: 1,
    behind: 0,
    changedFiles: 1,
    remote: "https://github.com/example/project.git",
    checkedAt: 42,
  });
  expect(JSON.stringify(state)).not.toContain("secret");
});

test("a detached checkout without upstream has no branch or base", async () => {
  const directory = await repository();
  await git(directory, "switch", "--quiet", "--detach");

  expect(await createCrewGitReader(() => 1)(directory, signal)).toEqual({
    branch: null,
    commit: await git(directory, "rev-parse", "HEAD"),
    base: null,
    ahead: null,
    behind: null,
    changedFiles: 0,
    remote: null,
    checkedAt: 1,
  });
});

test("a missing checkout is null and a plain directory is unavailable", async () => {
  const read = createCrewGitReader(() => 1);
  expect(await read(join(root, "missing"), signal)).toBeNull();
  const plain = join(root, "plain");
  await mkdir(plain);
  // A temporary directory is never inside a Git checkout here.
  expect(await read(plain, signal)).toMatchObject({
    branch: null,
    error: "Git state unavailable.",
  });
});

test("results are cached briefly and shared by concurrent callers", async () => {
  const directory = await repository();
  let clock = 0;

  const read = createCrewGitReader(
    () => 1,
    () => clock,
  );

  const [first, second] = await Promise.all([
    read(directory, signal),
    read(directory, signal),
  ]);

  expect(second).toBe(first);
  await writeFile(join(directory, "later.txt"), "x");
  expect((await read(directory, signal))?.changedFiles).toBe(0);
  clock = 15_001;
  expect((await read(directory, signal))?.changedFiles).toBe(1);
});

test("a caller that leaves does not cancel the shared read", async () => {
  const directory = await repository();
  const read = createCrewGitReader(() => 1);
  const caller = new AbortController();
  const leaving = read(directory, caller.signal);
  caller.abort();
  await expect(leaving).rejects.toThrow();
  expect((await read(directory, signal))?.changedFiles).toBe(0);
});
