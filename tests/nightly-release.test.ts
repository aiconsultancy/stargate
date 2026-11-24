import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { bootstrapRelease } from "../scripts/bootstrap-stargate";
import { maintenanceSchema } from "../src/automation/maintenance/nightly/config";
import {
  type CommandOptions,
  type CommandRunner,
  processRunner,
} from "../src/automation/maintenance/nightly/exec";
import {
  readReady,
  waitReady,
  writeReady,
} from "../src/automation/maintenance/nightly/update/ready";
import {
  adoptRelease,
  githubHeaders,
  linkedRelease,
  namedRelease,
  newerRelease,
  pruneReleases,
  restoreCurrent,
  type StargateReleaseConfig,
  stageRelease,
  switchCurrent,
} from "../src/automation/maintenance/nightly/update/release";
import { readMetadata } from "../src/automation/maintenance/nightly/update/release-record";
import { tarball } from "./tar";

let directory: string;
let source: string;
let checkout: string;
let archive: Buffer;
let commit: string;

const state = {
  compare: "ahead",
  author: "github-actions[bot]",
  uploader: true,
  checksum: "",
  archive: undefined as Uint8Array<ArrayBuffer> | undefined,
  redirectList: false,
  storageAuthorization: [] as (string | null)[],
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();

const storage = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request): Response {
    state.storageAuthorization.push(request.headers.get("authorization"));

    if (new URL(request.url).pathname === "/list") {
      return Response.json(list());
    }

    return new Response(new Uint8Array(state.archive ?? archive));
  },
});

const redirectRepository = "fixture/redirected";
const repositoryPath = "/repos/aiconsultancy/stargate";
const repositoryIDPath = "/repositories/1459142785";
let apiPort = 0;

const api = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request): Response {
    const url = new URL(request.url);
    const redirectPath = `/repos/${redirectRepository}/`;

    if (url.pathname.startsWith(redirectPath)) {
      const suffix = url.pathname.slice(redirectPath.length);

      return new Response(null, {
        status: 301,
        headers: { location: `${repositoryIDPath}/${suffix}${url.search}` },
      });
    }

    const path = url.pathname.replace(repositoryIDPath, repositoryPath);
    const repo = repositoryPath;

    if (path === `${repo}/releases`)
    // An API redirect to another host must not carry the token (L1).
    {
      return state.redirectList
        ? Response.redirect(`http://127.0.0.1:${storage.port}/list`, 302)
        : Response.json(list());
    }

    if (path === `${repo}/releases/assets/1`)
    // Signed storage URL on another origin: credentials must not follow.
    {
      return Response.redirect(`http://127.0.0.1:${storage.port}/blob`, 302);
    }

    if (path === `${repo}/releases/assets/2`) {
      return new Response(state.checksum);
    }

    if (path === `${repo}/git/ref/tags/v0.2.0`) {
      return Response.json({ object: { type: "commit", sha: commit } });
    }

    if (path === `${repo}/compare/${commit}...main`) {
      return Response.json({ status: state.compare });
    }

    return new Response("missing", { status: 404 });
  },
});

apiPort = api.port ?? 0;

function list() {
  const base = `http://127.0.0.1:${apiPort}`;
  const repo = repositoryPath;
  const at = "2026-11-10T00:00:00Z";
  const uploader = state.uploader ? { uploader: { login: state.author } } : {};

  return [
    {
      id: 7,
      tag_name: "v0.2.0",
      draft: false,
      prerelease: false,
      published_at: at,
      author: { login: state.author, type: "Bot" },
      assets: [
        {
          id: 1,
          name: "stargate-v0.2.0.tar.gz",
          size: archive.length,
          url: `${base}${repo}/releases/assets/1`,
          created_at: at,
          updated_at: at,
          ...uploader,
        },
        {
          id: 2,
          name: "stargate-v0.2.0.tar.gz.sha256",
          size: 90,
          url: `${base}${repo}/releases/assets/2`,
          created_at: at,
          updated_at: at,
          ...uploader,
        },
      ],
    },
  ];
}

const bunCalls: string[][] = [];
const bunOptions: CommandOptions[] = [];
let testsPass = true;

const runner: CommandRunner = {
  async run(command, options) {
    if (command[0] === "bun") {
      bunCalls.push([...command]);
      bunOptions.push(options);

      return {
        code: command[1] === "test" && !testsPass ? 1 : 0,
        stdout: "",
        stderr: "",
      };
    }

    return processRunner.run(command, options);
  },
};

function config(root: string, withCheckout = true): StargateReleaseConfig {
  const release = Schema.decodeUnknownSync(maintenanceSchema)({
    stargate: { root },
  }).stargate;

  if (!release) {
    throw new Error("missing release configuration");
  }

  return {
    root,
    repository: release.repository,
    apiURL: `http://127.0.0.1:${apiPort}`,
    author: "github-actions[bot]",
    branch: "main",
    ...(withCheckout ? { checkout } : {}),
    requireTreeCheck: withCheckout,
    coolOffHours: 0,
    keep: 3,
    installCommand: ["bun", "install", "--frozen-lockfile"],
    testCommand: ["bun", "test"],
  };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "stargate-release-"));
  source = join(directory, "source");
  await mkdir(join(source, "src"), { recursive: true });
  git(directory, "init", "-q", "-b", "main", source);
  await writeFile(join(source, "package.json"), '{ "name": "stargate" }\n');
  await writeFile(join(source, "src", "main.ts"), "console.log(1);\n");
  await writeFile(join(source, "run.sh"), "#!/bin/sh\n");
  await chmod(join(source, "run.sh"), 0o755);
  await symlink("src/main.ts", join(source, "entry"));
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "feat: first");
  git(source, "tag", "v0.2.0");
  commit = git(source, "rev-parse", "HEAD");
  const path = join(directory, "stargate-v0.2.0.tar.gz");
  git(
    source,
    "archive",
    "--format=tar.gz",
    "--prefix=stargate-v0.2.0/",
    "-o",
    path,
    "v0.2.0",
  );
  archive = await readFile(path);
  checkout = join(directory, "checkout");
  execFileSync("git", ["clone", "-q", source, checkout]);
});

afterAll(async () => {
  void api.stop(true);
  void storage.stop(true);
  await rm(directory, { recursive: true, force: true });
});

beforeEach(() => {
  state.compare = "ahead";
  state.author = "github-actions[bot]";
  state.checksum = `${createHash("sha256").update(archive).digest("hex")}  stargate-v0.2.0.tar.gz\n`;
  state.storageAuthorization = [];
  state.uploader = true;
  state.archive = undefined;
  state.redirectList = false;
  testsPass = true;
  bunCalls.length = 0;
  bunOptions.length = 0;
});

async function newRoot(name: string) {
  const root = join(directory, name);
  await mkdir(join(root, "releases", "old"), { recursive: true });
  await writeFile(
    join(root, "releases", "old", "package.json"),
    '{ "name": "stargate" }\n',
  );
  await mkdir(join(root, "releases", "old", "src"));
  await writeFile(join(root, "releases", "old", "src", "main.ts"), "");
  await adoptRelease(root, join(root, "releases", "old"), "0.1.0");

  return root;
}

async function stage(root: string, withCheckout = true, repository?: string) {
  const settings = config(root, withCheckout);

  if (repository) {
    settings.repository = repository;
  }

  const headers = githubHeaders("secret-token");

  const release = await newerRelease(
    settings,
    headers,
    "0.1.0",
    Date.parse("2026-11-12T00:00:00Z"),
  );

  if (!release) {
    throw new Error("no release");
  }

  return stageRelease({
    config: settings,
    release,
    headers,
    runner,
    runID: crypto.randomUUID(),
    remaining: () => 3_600_000,
    signal: AbortSignal.timeout(30_000),
  });
}

describe("Stargate release update", () => {
  test("bootstrap installs the pinned new-format release without an old updater", async () => {
    const root = join(directory, "bootstrap");
    const settings = config(root, true);
    const headers = githubHeaders("secret-token");

    const release = await newerRelease(
      settings,
      headers,
      "0.1.0",
      Date.parse("2026-11-12T00:00:00Z"),
    );

    if (!release) {
      throw new Error("Fixture release missing");
    }

    const input = {
      config: settings,
      release,
      headers,
      commit,
      runner,
      runID: crypto.randomUUID(),
      remaining: () => 3_600_000,
      signal: AbortSignal.timeout(30_000),
    };

    await expect(
      bootstrapRelease({ ...input, commit: "0".repeat(40) }),
    ).rejects.toThrow("pinned commit");
    expect(await linkedRelease(root, "current")).toBeNull();
    const staged = await bootstrapRelease(input);
    expect(staged.metadata).toMatchObject({
      schema: "stargate.release.v1",
      commit,
      tree: "equal",
      verification: "verified",
    });
    expect((await linkedRelease(root, "current"))?.metadata).toEqual(
      staged.metadata,
    );
    await expect(
      bootstrapRelease({ ...input, runID: crypto.randomUUID() }),
    ).rejects.toThrow("without current");
  });

  test("adoption refuses an old-name package rather than registering an alias", async () => {
    const root = join(directory, "refuse-old");
    const path = join(root, "releases", "old");
    await mkdir(join(path, "src"), { recursive: true });
    await writeFile(join(path, "package.json"), '{"name":"pogo"}');
    await writeFile(join(path, "src", "main.ts"), "");
    await expect(adoptRelease(root, path, "0.1.0")).rejects.toThrow(
      "not an unpacked Stargate",
    );
    expect(await readMetadata(path)).toBeNull();
  });

  test("adopts a Stargate package with Stargate metadata alongside a release", async () => {
    const root = await newRoot("adopt-stargate");
    const path = join(root, "releases", "0.2.0");
    await mkdir(join(path, "src"), { recursive: true });
    await writeFile(join(path, "package.json"), '{ "name": "stargate" }');
    await writeFile(join(path, "src", "main.ts"), "");

    expect(await adoptRelease(root, path, "0.2.0")).toEqual({
      current: "unchanged",
    });
    expect(await readMetadata(path)).toMatchObject({
      schema: "stargate.release.v1",
      version: "0.2.0",
      verification: "adopted",
    });
    expect((await linkedRelease(root, "current"))?.metadata.version).toBe(
      "0.1.0",
    );
  });

  test("a repository URL stages a Stargate release through same-origin redirects", async () => {
    const root = await newRoot("redirected-stargate");
    const result = await stage(root, true, redirectRepository);
    expect(result.metadata).toMatchObject({
      schema: "stargate.release.v1",
      version: "0.2.0",
      verification: "verified",
      tree: "equal",
    });
    expect(await readMetadata(result.directory)).toEqual(result.metadata);
    expect(state.storageAuthorization).toEqual([null]);
    expect((await linkedRelease(root, "current"))?.name).toBe("old");
  });

  test("verifies, unpacks, compares with git archive, installs and tests", async () => {
    const root = await newRoot("ok");
    expect((await linkedRelease(root, "current"))?.metadata.version).toBe(
      "0.1.0",
    );
    const result = await stage(root);
    expect(result.metadata).toMatchObject({
      version: "0.2.0",
      tag: "v0.2.0",
      commit,
      verification: "verified",
      tree: "equal",
    });
    expect(bunCalls).toEqual([
      ["bun", "install", "--frozen-lockfile"],
      ["bun", "test"],
    ]);
    // The token reached the API only, never the storage redirect.
    expect(state.storageAuthorization).toEqual([null]);
    expect(await readlink(join(result.directory, "entry"))).toBe("src/main.ts");
    // Nothing live changed until the switch.
    expect((await linkedRelease(root, "current"))?.name).toBe("old");
    expect(await switchCurrent(root, "0.2.0")).toBe("old");
    expect(await readlink(join(root, "current"))).toBe("releases/0.2.0");
    expect(await readlink(join(root, "previous"))).toBe("releases/old");
    await restoreCurrent(root, "old");
    expect((await linkedRelease(root, "current"))?.name).toBe("old");
    // A verified release is reused instead of downloaded again.
    expect((await stage(root)).reused).toBe(true);
  });

  test("checksum, author, branch and tree failures fail closed", async () => {
    const cases: [string, () => void, string, boolean?][] = [
      [
        "checksum",
        () => {
          state.checksum = `${"0".repeat(64)}  stargate-v0.2.0.tar.gz\n`;
        },
        "checksum-mismatch",
      ],
      [
        "checksum-name",
        () => {
          state.checksum = state.checksum.replace("stargate-v0.2.0", "other");
        },
        "checksum-mismatch",
      ],
      [
        "author",
        () => {
          state.author = "someone";
        },
        "author-mismatch",
      ],
      [
        "branch",
        () => {
          state.compare = "diverged";
        },
        "tag-not-on-branch",
      ],
    ];

    for (const [name, change, reason] of cases) {
      const root = await newRoot(`bad-${name}`);
      change();
      await expect(stage(root)).rejects.toThrow(reason);
      expect(await readMetadata(join(root, "releases", "0.2.0"))).toBeNull();
      expect((await linkedRelease(root, "current"))?.name).toBe("old");
      expect(
        (await readdir(join(root, "releases"))).filter((n) =>
          n.startsWith(".staging"),
        ),
      ).toEqual([]);
      state.compare = "ahead";
      state.author = "github-actions[bot]";
      state.checksum = `${createHash("sha256").update(archive).digest("hex")}  stargate-v0.2.0.tar.gz\n`;
    }
  });

  test("a local tag with different content is a tree mismatch", async () => {
    const other = join(directory, "other-checkout");
    execFileSync("git", ["clone", "-q", source, other]);
    await writeFile(join(other, "extra.txt"), "changed\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "fix: other");
    git(other, "tag", "-f", "v0.2.0");
    const root = await newRoot("tree");
    const headers = githubHeaders(undefined);
    const base = { ...config(root), checkout: other };
    const release = await newerRelease(base, headers, "0.1.0", Date.now());

    if (!release) {
      throw new Error("no release");
    }

    await expect(
      stageRelease({
        config: base,
        release,
        headers,
        runner,
        runID: "x",
        remaining: () => 3_600_000,
        signal: AbortSignal.timeout(30_000),
      }),
    ).rejects.toThrow("tree-mismatch");
  });

  test("failing packaged tests set the release aside; current is unchanged", async () => {
    const root = await newRoot("tests");
    testsPass = false;
    await expect(stage(root, false)).rejects.toThrow("tests-failed");
    const names = await readdir(join(root, "releases"));
    expect(names.some((n) => n.startsWith(".failed-0.2.0-"))).toBe(true);
    expect(names).not.toContain("0.2.0");
    expect((await linkedRelease(root, "current"))?.name).toBe("old");
    expect(await pruneReleases(root, 3)).toEqual(
      names.filter((n) => n.startsWith(".failed-")),
    );
  });

  test("prune keeps current, previous and the newest releases", async () => {
    const root = await newRoot("prune");

    for (const version of ["0.3.0", "0.4.0", "0.5.0", "0.6.0"]) {
      const path = join(root, "releases", version);
      await mkdir(join(path, "src"), { recursive: true });
      await writeFile(join(path, "package.json"), '{ "name": "stargate" }\n');
      await writeFile(join(path, "src", "main.ts"), "");
      await adoptRelease(root, path, version);
    }

    await mkdir(join(root, "releases", "unmanaged"));
    await switchCurrent(root, "0.6.0");
    await switchCurrent(root, "0.3.0");
    // Current 0.3.0, previous 0.6.0, then the newest other: 0.5.0.
    expect((await pruneReleases(root, 3)).sort()).toEqual(["0.4.0", "old"]);
    expect((await readdir(join(root, "releases"))).sort()).toEqual([
      "0.3.0",
      "0.5.0",
      "0.6.0",
      "unmanaged",
    ]);
  });

  test("a root symlink in the archive is rejected before extraction", async () => {
    const root = await newRoot("symlink");
    const outside = join(directory, "outside");
    await mkdir(outside);
    state.archive = tarball([
      // Listed as "stargate-v0.2.0/", so a name-only listing check accepts it.
      { path: "stargate-v0.2.0/", type: "2", link: outside },
      { path: "stargate-v0.2.0/package.json", data: "{}" },
    ]);
    state.checksum = `${createHash("sha256").update(state.archive).digest("hex")}  stargate-v0.2.0.tar.gz\n`;
    await expect(stage(root, false)).rejects.toThrow("archive-invalid");
    expect(await readdir(outside)).toEqual([]);
    expect(bunCalls).toEqual([]);
  });

  test("a chain of contained-looking links that escapes is rejected after tar", async () => {
    const root = await newRoot("chain");
    state.archive = tarball([
      { path: "stargate-v0.2.0/", type: "5", mode: 0o755 },
      { path: "stargate-v0.2.0/package.json", data: "{}" },
      { path: "stargate-v0.2.0/deep/", type: "5", mode: 0o755 },
      { path: "stargate-v0.2.0/deep/back", type: "2", link: ".." },
      {
        path: "stargate-v0.2.0/escape",
        type: "2",
        // Lexically stargate-v0.2.0/outside; really <staging>/outside.
        link: "deep/back/../../outside",
      },
    ]);
    state.checksum = `${createHash("sha256").update(state.archive).digest("hex")}  stargate-v0.2.0.tar.gz\n`;
    await expect(stage(root, false)).rejects.toThrow("archive-invalid");
    expect(bunCalls).toEqual([]);
  });

  test("missing uploader or tree check fails closed", async () => {
    const root = await newRoot("uploader");
    state.uploader = false;
    await expect(stage(root)).rejects.toThrow("author-mismatch");
    state.uploader = true;
    const headers = githubHeaders(undefined);

    const release = await newerRelease(
      config(root),
      headers,
      "0.1.0",
      Date.now(),
    );

    if (!release) {
      throw new Error("no release");
    }

    await expect(
      stageRelease({
        config: { ...config(root, false), requireTreeCheck: true },
        release,
        headers,
        runner,
        runID: "tree",
        remaining: () => 3_600_000,
        signal: AbortSignal.timeout(30_000),
      }),
    ).rejects.toThrow("not-configured");
  });

  test("release install and tests run with a minimal private environment", async () => {
    process.env["STARGATE_TEST_SECRET"] = "never-inherited";

    try {
      const root = await newRoot("env");
      await stage(root);
      expect(bunOptions).toHaveLength(2);

      for (const options of bunOptions) {
        expect(options.inheritEnv).toBe(false);
        expect(Object.keys(options.env ?? {}).sort()).toEqual([
          "HOME",
          "LANG",
          "PATH",
          "TMPDIR",
          "XDG_CACHE_HOME",
          "XDG_CONFIG_HOME",
          "XDG_DATA_HOME",
          "XDG_STATE_HOME",
        ]);
        expect(options.env?.["HOME"]).toContain(
          join(root, "releases", ".staging-"),
        );
        expect(options.env?.["TMPDIR"]).toContain(
          join(root, "releases", ".staging-"),
        );
        expect(JSON.stringify(options.env)).not.toContain("never-inherited");
      }

      // The real runner gives such a child nothing else from this process.
      const child = await processRunner.run(["/usr/bin/env"], {
        timeoutMs: 5000,
        env: { PATH: "/usr/bin:/bin" },
        inheritEnv: false,
      });

      expect(child.stdout.trim()).toBe("PATH=/usr/bin:/bin");
    } finally {
      delete process.env["STARGATE_TEST_SECRET"];
    }
  });

  test("API redirects to another host drop the token", async () => {
    const root = await newRoot("redirect");
    state.redirectList = true;

    const release = await newerRelease(
      config(root),
      githubHeaders("secret-token"),
      "0.1.0",
      Date.now(),
    );

    expect(release?.version).toBe("0.2.0");
    expect(state.storageAuthorization).toEqual([null]);
  });

  test("adopt validates the directory and never replaces current", async () => {
    const root = await newRoot("adopt");
    await expect(
      adoptRelease(root, join(directory, "source"), "1.0.0"),
    ).rejects.toThrow("directly under");
    await expect(
      adoptRelease(root, join(root, "releases", "old"), "0.1.0"),
    ).rejects.toThrow("already managed");
    expect((await lstat(join(root, "current"))).isSymbolicLink()).toBe(true);
  });

  test("a hand-made release directory is never switched to and has no ready version", async () => {
    const root = await newRoot("hand-made");
    // Unpacked by hand: the files are there, the release metadata is not.
    const made = join(root, "releases", "0.9.0");
    await mkdir(join(made, "src"), { recursive: true });
    await writeFile(join(made, "package.json"), '{ "name": "stargate" }\n');
    await writeFile(join(made, "src", "main.ts"), "");
    await expect(switchCurrent(root, "0.9.0")).rejects.toThrow();
    expect(await readlink(join(root, "current"))).toBe("releases/old");
    // Invalid metadata is the same as none.
    await writeFile(
      join(made, ".stargate-release.json"),
      '{"version":"0.9.0"}',
    );
    await expect(switchCurrent(root, "0.9.0")).rejects.toThrow();
    const data = join(root, "data");
    await mkdir(data);
    expect(await writeReady(data, 1, made)).toBeNull();
    expect((await readReady(data))?.version).toBeNull();
    // Adopt is the supported way to mark an existing directory.
    await rm(join(made, ".stargate-release.json"));
    await adoptRelease(root, made, "0.9.0");
    expect(await switchCurrent(root, "0.9.0")).toBe("old");
    expect(await writeReady(data, 2, made)).toBe("0.9.0");
    expect((await readReady(data))?.version).toBe("0.9.0");
    await writeReady(
      data,
      3,
      made,
      [],
      [{ kind: "slack", id: "captain", state: "reconnecting" }],
    );
    expect(
      await waitReady(
        data,
        3,
        "0.9.0",
        0,
        async () => {},
        () => 4,
      ),
    ).toBe(false);
    await writeReady(
      data,
      3,
      made,
      [],
      [{ kind: "slack", id: "captain", state: "connected" }],
    );
    expect(
      await waitReady(
        data,
        3,
        "0.9.0",
        0,
        async () => {},
        () => 4,
      ),
    ).toBe(true);
  });

  test("a named release is looked up by its tag and must be published", async () => {
    const releases: Record<string, object> = {
      "v0.2.0": { tag_name: "v0.2.0", draft: false, prerelease: false },
      "v0.3.0": { tag_name: "v0.3.0", draft: true, prerelease: false },
      "v0.4.0": { tag_name: "v0.4.0", draft: false, prerelease: true },
      // The API answers with another release than the one asked for.
      "v0.5.0": { tag_name: "v0.6.0", draft: false, prerelease: false },
    };

    const seen: string[] = [];

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const path = new URL(request.url).pathname;
        seen.push(path);

        const found =
          releases[
            path.replace("/repos/aiconsultancy/stargate/releases/tags/", "")
          ];

        return found
          ? Response.json({
              id: 1,
              published_at: null,
              author: null,
              assets: [],
              ...found,
            })
          : new Response(null, { status: 404 });
      },
    });

    try {
      const settings = {
        ...config(await newRoot("named")),
        apiURL: server.url.origin,
      };

      expect((await namedRelease(settings, {}, "0.2.0")).version).toBe("0.2.0");
      expect(seen).toEqual([
        "/repos/aiconsultancy/stargate/releases/tags/v0.2.0",
      ]);

      for (const version of ["0.3.0", "0.4.0", "0.5.0", "0.9.0", "v0.2.0"]) {
        await expect(namedRelease(settings, {}, version)).rejects.toMatchObject(
          { reason: "not-found" },
        );
      }
    } finally {
      await server.stop(true);
    }
  });
});
