import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countChangedPaths,
  createGitReader,
  githubRepository,
  parseAheadBehind,
} from "../src/api/v1/git";
import { createPullReader, mapPullRequest } from "../src/api/v1/pulls";

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

test("parses only GitHub owner/repo from URL and scp-like remotes", () => {
  for (const remote of [
    "https://github.com/example/project.git",
    "https://user:fixture-password@github.com/example/project",
    "ssh://git@GitHub.com:22/example/project.git",
    "git@github.com:example/project.git",
  ])
    expect(githubRepository(remote)).toBe("example/project");
  for (const remote of [
    "/local/checkout",
    "https://github.com.example.test/example/project.git",
    "https://github.com/example/project.git?token=fixture",
    "git@example.test:example/project.git",
    "https://github.com/example/project/deeper",
    "https://github.com/example/%2fproject",
  ])
    expect(githubRepository(remote)).toBeNull();
});

test("reads real Git state, respects the 15-second cache and handles a detached HEAD", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));
  const signal = new AbortController().signal;
  let now = 1_000;
  const read = createGitReader(() => now);
  const git = (...args: string[]) => {
    const command = Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: directory },
    );
    if (command.exitCode !== 0) throw new Error(command.stderr.toString());
  };
  try {
    git("init", "-b", "main");
    git("commit", "--allow-empty", "-m", "Initial");
    git("remote", "add", "origin", "git@github.com:example/project.git");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git("switch", "-c", "work");
    git("commit", "--allow-empty", "-m", "Feature");
    expect(await read(directory, signal)).toMatchObject({
      branch: "work",
      head: expect.stringMatching(/^[a-f0-9]+$/),
      base: "origin/main",
      ahead: 1,
      behind: 0,
      changedFiles: 0,
      repository: "example/project",
      checkedAt: now,
    });
    await writeFile(join(directory, "untracked"), "fixture");
    expect((await read(directory, signal))?.changedFiles).toBe(0);
    now += 15_000;
    git("switch", "--detach", "HEAD");
    expect(await read(directory, signal)).toMatchObject({
      branch: null,
      changedFiles: 1,
      checkedAt: now,
    });
    await mkdir(join(directory, "nested"));
    expect(await read(join(directory, "nested"), signal)).toMatchObject({
      error: "Git state unavailable.",
      repository: null,
    });
    expect(await read(join(directory, "missing"), signal)).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("maps PR state and check rollups and restricts URL and title output", () => {
  const base = {
    number: 42,
    url: "https://github.com/example/project/pull/42",
    title: "Fix layout with token=example-value",
    state: "OPEN",
    isDraft: true,
    statusCheckRollup: null,
  };
  const parse = (extra: Record<string, unknown> = {}) =>
    mapPullRequest({ ...base, ...extra }, "example/project");
  expect(parse()).toEqual({
    number: 42,
    url: base.url,
    title: "Fix layout with token=[REDACTED]",
    state: "draft",
    checks: "none",
  });
  expect(
    parse({
      isDraft: false,
      statusCheckRollup: [
        { status: "COMPLETED", conclusion: "NEUTRAL" },
        { state: "SUCCESS" },
      ],
    }),
  ).toMatchObject({ state: "open", checks: "passing" });
  expect(
    parse({
      state: "MERGED",
      statusCheckRollup: [
        { status: "IN_PROGRESS", conclusion: null },
        { state: "SUCCESS" },
      ],
    }),
  ).toMatchObject({ state: "merged", checks: "running" });
  expect(
    parse({
      state: "CLOSED",
      statusCheckRollup: [
        { status: "QUEUED" },
        { status: "COMPLETED", conclusion: "CANCELLED" },
      ],
    }),
  ).toMatchObject({ state: "closed", checks: "failing" });
  expect(
    parse({ url: "https://user:fixture@github.com/example/project/pull/42" }),
  ).toBeNull();
  expect(parse({ url: "https://github.com/other/project/pull/42" })).toBeNull();
  expect(parse({ statusCheckRollup: "unexpected" })).toBeNull();
});

test("PR refreshes return immediately, deduplicate lookups and use two slots", async () => {
  let now = 1_000;
  let authChecks = 0;
  type Response = { code: number; stdout: string };
  const views = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<Response>>
  >();
  const pull = createPullReader(() => now, {
    which: () => "/fixture/gh",
    run: async (command, options) => {
      expect(options.timeout).toBe(4_000);
      if (command[1] === "auth") {
        authChecks++;
        return { code: 0, stdout: "" };
      }
      const branch = command.at(-1);
      if (!branch) throw new Error("Missing branch");
      const response = Promise.withResolvers<Response>();
      views.set(branch, response);
      return response.promise;
    },
  });
  const read = (branch: string) => pull("example/project", branch);
  expect(read("first")).toBeNull();
  expect(read("first")).toBeNull();
  expect(read("second")).toBeNull();
  expect(read("third")).toBeNull();
  await Bun.sleep(0);
  expect(authChecks).toBe(1);
  expect([...views.keys()]).toEqual(["first", "second"]);
  views.get("first")?.resolve({
    code: 0,
    stdout: JSON.stringify({
      number: 1,
      url: "https://github.com/example/project/pull/1",
      title: "Example",
      state: "OPEN",
      isDraft: false,
      statusCheckRollup: [],
    }),
  });
  views.get("second")?.resolve({ code: 1, stdout: "" });
  await Bun.sleep(0);
  expect(read("first")?.number).toBe(1);
  expect(read("second")).toBeNull();
  now += 60_000;
  expect(read("first")?.number).toBe(1);
  await Bun.sleep(0);
  expect(authChecks).toBe(2);
  views.get("first")?.resolve({ code: 1, stdout: "" });
  await Bun.sleep(0);
  expect(read("first")).toBeNull();
});
