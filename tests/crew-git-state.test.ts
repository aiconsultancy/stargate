import { afterAll, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
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
import { readCommand } from "../src/observability/dashboard/api/v1/command";
import { createGitReader } from "../src/observability/dashboard/api/v1/git";

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

async function repository(format = "sha1") {
  const directory = join(root, `repo-${count++}`);
  await mkdir(directory);
  await git(directory, "init", `--object-format=${format}`);
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

test("Fleet status starts before the remote read completes", async () => {
  const directory = await repository();
  const bin = await mkdtemp(join(root, "git-overlap-"));
  const realGit = Bun.which("git");
  const path = process.env["PATH"];
  const wrapper = join(bin, "git");

  if (!realGit) {
    throw new Error("Git is required for the overlap fixture.");
  }

  await git(directory, "remote", "add", "origin", "https://example.test/repo");
  await writeFile(
    wrapper,
    `#!/bin/sh
marker="\${0%/*}/status-started"
case " $* " in
  *' status --porcelain=v1 '*) touch "$marker" ;;
  *' remote get-url origin '*)
    attempts=0
    until test -f "$marker"; do
      test "$attempts" -lt 40 || exit 1
      attempts=$((attempts + 1))
      sleep 0.05
    done
    ;;
esac
exec '${realGit.replaceAll("'", "'\\''")}' "$@"
`,
  );
  await chmod(wrapper, 0o700);
  process.env["PATH"] = path === undefined ? bin : `${bin}:${path}`;

  try {
    expect(await createCrewGitReader()(directory, signal)).toMatchObject({
      changedFiles: 0,
      remote: "https://example.test/repo",
    });
  } finally {
    if (path === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = path;
    }
  }
});

test.each([
  ["clean", ".gitattributes"],
  ["process", ".gitattributes"],
  ["clean", ".git/info/attributes"],
  ["process", ".git/info/attributes"],
])(
  "Fleet status skips the %s driver selected by %s",
  async (driver, attributes) => {
    const directory = await repository();
    const tracked = join(directory, "tracked");
    const marker = join(directory, ".git", "probe-ran");
    const timestamp = 1_600_000_000;

    await git(directory, "config", "core.trustctime", "false");
    await writeFile(join(directory, attributes), "tracked filter=probe\n");
    await writeFile(tracked, "before\n");
    await utimes(tracked, timestamp, timestamp);
    await git(directory, "add", ".");
    await git(directory, "commit", "-m", "track probe file");
    await git(
      directory,
      "config",
      `filter.probe.${driver}`,
      driver === "clean"
        ? "touch .git/probe-ran && cat"
        : "touch .git/probe-ran; exit 1",
    );
    await writeFile(tracked, "edited\n");
    await utimes(tracked, timestamp, timestamp);
    await utimes(join(directory, ".git", "index"), timestamp, timestamp);

    // Positive control: ordinary status really invokes the driver, even for
    // A same-size edit with an unchanged worktree timestamp.
    // The process probe deliberately exits before the Git handshake.
    Bun.spawnSync(["git", "--no-optional-locks", "status", "--porcelain=v1"], {
      cwd: directory,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await Bun.file(marker).exists()).toBe(true);
    await rm(marker);

    expect(await createCrewGitReader()(directory, signal)).toMatchObject({
      changedFiles: 1,
    });
    expect(await Bun.file(marker).exists()).toBe(false);
  },
);

test.each(["sha1", "sha256"])(
  "Fleet status uses the %s empty tree for attributes",
  async (format) => {
    const directory = await repository(format);
    await writeFile(join(directory, ".gitattributes"), "tracked text eol=lf\n");
    await writeFile(join(directory, "tracked"), "original\n");
    await git(directory, "add", ".");
    await git(directory, "commit", "-m", "track LF text");

    const emptyTree = await git(
      directory,
      "hash-object",
      "-t",
      "tree",
      "--stdin",
    );

    const supportsAttributeSource =
      Bun.spawnSync(
        ["git", `--attr-source=${emptyTree}`, "check-attr", "text", "tracked"],
        { cwd: directory },
      ).exitCode === 0;

    await writeFile(join(directory, "tracked"), "original\r\n");

    expect(await createCrewGitReader()(directory, signal)).toMatchObject({
      changedFiles: supportsAttributeSource ? 1 : 0,
    });
  },
);

test("both Fleet readers drop rejected settings and multiline values before status", async () => {
  const directory = await repository();
  await git(directory, "config", "filter.probe.clean", "false");
  await git(directory, "config", "status.renames", "invalid\nvalue");

  const spawn = spyOn(childProcess, "spawn");

  try {
    // If forwarded, the invalid Boolean prevents Git from running status.
    expect(await createCrewGitReader()(directory, signal)).toMatchObject({
      changedFiles: 0,
    });

    const captainStatus = spawn.mock.calls
      .map(([, args]) => args)
      .find((args) => Array.isArray(args) && args.includes("--porcelain=v1"));

    expect(captainStatus).toBeDefined();
    expect(captainStatus?.join("\0")).not.toMatch(
      /filter\.probe|status\.renames/,
    );
  } finally {
    spawn.mockRestore();
  }

  const commands: string[][] = [];

  const gateway = createGitReader(Date.now, (args, options) => {
    commands.push(args);

    return readCommand(args, options);
  });

  try {
    expect(await gateway(directory, signal)).toMatchObject({ changedFiles: 0 });
    const status = commands.find((args) => args.includes("--porcelain=v1"));
    expect(status).toBeDefined();
    expect(status?.join("\0")).not.toMatch(/filter\.probe|status\.renames/);
  } finally {
    await gateway.stop();
  }
});

test("Fleet status reads a linked worktree's split index and ignore rules", async () => {
  const directory = await repository();
  const linked = join(root, "linked-split");

  await writeFile(join(directory, "tracked"), "initial\n");
  await git(directory, "add", "tracked");
  await git(directory, "commit", "-m", "track file");
  await git(directory, "worktree", "add", "-b", "linked-split", linked);
  await git(linked, "update-index", "--split-index");
  await writeFile(join(directory, ".git", "info", "exclude"), "ignored-info\n");
  const configured = join(directory, ".git", "custom-excludes");
  await writeFile(configured, "ignored-config\n");
  await git(directory, "config", "core.excludesFile", configured);
  await writeFile(join(linked, "ignored-info"), "hidden\n");
  await writeFile(join(linked, "ignored-config"), "hidden\n");
  await writeFile(join(linked, "tracked"), "edited\n");

  expect(await createCrewGitReader()(linked, signal)).toMatchObject({
    branch: "linked-split",
    changedFiles: 1,
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
