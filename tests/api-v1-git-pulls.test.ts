import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countChangedPaths,
  githubRepository,
  createGitReader as makeGitReader,
  parseAheadBehind,
} from "../src/observability/dashboard/api/v1/git";
import {
  createPullReader,
  mapPullRequest,
} from "../src/observability/dashboard/api/v1/pulls";

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
  let now = 1000;

  const read = createGitReader(
    () => now,
    undefined,
    undefined,
    undefined,
    () => now,
  );

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
    git("update-ref", "refs/remotes/origin/trunk", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git("switch", "-c", "work");
    git("branch", "--set-upstream-to=origin/trunk");
    git("commit", "--allow-empty", "-m", "Feature");
    expect(await read(directory, signal)).toMatchObject({
      branch: "work",
      head: expect.stringMatching(/^[a-f0-9]+$/),
      base: "origin/trunk",
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

test("looks up only the bound repository and requires an exact head repository", async () => {
  const commands: string[][] = [];

  const pull = createPullReader(Date.now, {
    which: () => "/fixture/gh",
    run: async (args) => {
      commands.push(args);

      if (args[1] === "auth") return { code: 0, stdout: "" };

      if (args[1] === "api") {
        const rows = [
          { number: 42, repository: "another/project" },
          { number: 41, repository: "Example/renamed" },
        ];

        if (args.at(-1) === "head=example:123")
          rows.push({ number: 40, repository: "Example/project" });

        return { code: 0, stdout: JSON.stringify(rows) };
      }

      return {
        code: 0,
        stdout: JSON.stringify({
          number: 40,
          url: "https://github.com/Example/project/pull/40",
          title: "Example",
          state: "OPEN",
          isDraft: false,
          statusCheckRollup: [],
          headRefName: "123",
          headRepository: { name: "Project" },
          headRepositoryOwner: { login: "Example" },
        }),
      };
    },
  });

  expect(pull("Example/project", "123")).toBeUndefined();
  expect(pull("Example/project", "absent")).toBeUndefined();
  await Bun.sleep(0);
  expect(pull("Example/project", "123")?.number).toBe(40);
  expect(pull("Example/project", "absent")).toBeNull();
  expect(commands.find((args) => args[1] === "api")).toEqual(
    expect.arrayContaining(["repos/example/project/pulls", "head=example:123"]),
  );
  expect(commands.filter((args) => args[1] === "pr")).toEqual([
    expect.arrayContaining([
      "40",
      "--repo",
      "example/project",
      "number,url,title,state,isDraft,statusCheckRollup,headRefName,headRepository,headRepositoryOwner",
    ]),
  ]);
});

test.each([
  ["owner", { headRepositoryOwner: { login: "fork" } }],
  ["repository", { headRepository: { name: "other" } }],
  ["branch", { headRefName: "Feature" }],
] as const)(
  "rejects a mismatched head %s from PR detail",
  async (_field, mismatch) => {
    const pull = createPullReader(Date.now, {
      which: () => "/fixture/gh",
      run: async (command) => {
        if (command[1] === "auth") return { code: 0, stdout: "" };

        if (command[1] === "api")
          return {
            code: 0,
            stdout: JSON.stringify([
              { number: 1, repository: "example/project" },
            ]),
          };

        return {
          code: 0,
          stdout: JSON.stringify({
            number: 1,
            url: "https://github.com/example/project/pull/1",
            title: "Example",
            state: "OPEN",
            isDraft: false,
            statusCheckRollup: [],
            headRepositoryOwner: { login: "example" },
            headRepository: { name: "project" },
            headRefName: "feature",
            ...mismatch,
          }),
        };
      },
    });

    pull("example/project", "feature");
    await Bun.sleep(0);
    expect(pull("example/project", "feature")).toBeUndefined();
  },
);

test("PR refreshes deduplicate work, keep the last result on failure and clear it on confirmed absence", async () => {
  let now = 1000;
  let authChecks = 0;
  let authCode = 0;

  type Response = { code: number; stdout: string };

  const views = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<Response>>
  >();

  const pull = createPullReader(() => now, {
    which: () => "/fixture/gh",
    run: async (command, options) => {
      expect(options.timeout).toBe(4000);

      if (command[1] === "auth") {
        authChecks++;

        return { code: authCode, stdout: "" };
      }

      if (command[2] === "view")
        return {
          code: 0,
          stdout: JSON.stringify({
            number: 1,
            url: "https://github.com/example/project/pull/1",
            title: "Example",
            state: "OPEN",
            isDraft: false,
            statusCheckRollup: [],
            headRefName: "first",
            headRepository: { name: "project" },
            headRepositoryOwner: { login: "example" },
          }),
        };
      const branch = command.at(-1)?.replace(/^head=example:/, "");

      if (!branch) throw new Error("Missing branch");
      const response = Promise.withResolvers<Response>();
      views.set(branch, response);

      return response.promise;
    },
  });

  const read = (branch: string) => pull("example/project", branch);
  expect(read("first")).toBeUndefined();
  expect(read("first")).toBeUndefined();
  expect(read("second")).toBeUndefined();
  expect(read("third")).toBeUndefined();
  await Bun.sleep(0);
  expect(authChecks).toBe(1);
  expect([...views.keys()]).toEqual(["first", "second"]);
  views.get("first")?.resolve({
    code: 0,
    stdout: JSON.stringify([{ number: 1, repository: "example/project" }]),
  });
  views.get("second")?.resolve({ code: 1, stdout: "" });
  await Bun.sleep(0);
  expect(read("first")?.number).toBe(1);
  expect(read("second")).toBeUndefined();
  now += 60_000;
  expect(read("first")?.number).toBe(1);
  await Bun.sleep(0);
  expect(authChecks).toBe(2);
  views.get("first")?.resolve({ code: 1, stdout: "" });
  await Bun.sleep(0);
  expect(read("first")?.number).toBe(1);
  now += 60_000;
  authCode = 1;
  expect(read("first")?.number).toBe(1);
  await Bun.sleep(0);
  expect(read("first")?.number).toBe(1);
  now += 60_000;
  authCode = 0;
  expect(read("first")?.number).toBe(1);
  await Bun.sleep(0);
  views.get("first")?.resolve({ code: 0, stdout: "[]" });
  await Bun.sleep(0);
  expect(read("first")).toBeNull();
});

test.each(["123", "#123"])(
  "looks up a literal head branch named %s",
  async (branch) => {
    const pr = {
      number: 42,
      url: "https://github.com/example/project/pull/42",
      title: "Example",
      state: "OPEN",
      isDraft: false,
      statusCheckRollup: [],
      headRefName: branch,
      headRepositoryOwner: { login: "example" },
      headRepository: { name: "project" },
    };

    const pull = createPullReader(Date.now, {
      which: () => "/fixture/gh",
      run: async (command) => {
        if (command[1] === "auth") return { code: 0, stdout: "" };

        if (command[2] === "view")
          return {
            code: 0,
            stdout: JSON.stringify({
              ...pr,
              number: Number(command[3]),
              url: `https://github.com/example/project/pull/${command[3]}`,
            }),
          };

        if (
          command[1] !== "api" ||
          !command.includes(`head=example:${branch}`) ||
          !command.includes("state=all")
        )
          return { code: 1, stdout: "" };

        return {
          code: 0,
          stdout: JSON.stringify([
            { number: 42, repository: "example/project" },
          ]),
        };
      },
    });

    pull("example/project", branch);
    await Bun.sleep(0);
    expect(pull("example/project", branch)?.number).toBe(42);
  },
);
