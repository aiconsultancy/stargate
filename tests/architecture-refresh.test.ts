import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ArchitecturePolicy } from "./architecture-graph";

const SCRIPT = join(
  import.meta.dir,
  "../scripts/refresh-architecture-baseline.ts",
);
const BASELINE = "tests/architecture-baseline.json";
const POLICY = "tests/architecture-policy.json";
const EXCEPTION = "private:src/feature/entry.ts -> src/other/private.ts";
const REVIEW_REQUIRED =
  "Not checked: that bodies are moved, not new, or that packages were already used by the closure. Put this proof in the PR for the reviewer to verify.";
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function baseline() {
  return {
    sourceCommit: "1111111111111111111111111111111111111111",
    measurementStatus: "original measurement; do not replace provenance",
    sourceFiles: 1,
    sourceEdges: 0,
    rootFiles: ["src/main.ts", "src/removed.ts"],
    largestCycle: 3,
    cycleComponents: [["src/feature/entry.ts", "src/feature/leaf.ts"]],
    cyclicEdges: [
      "src/feature/entry.ts -> src/feature/leaf.ts",
      "src/feature/leaf.ts -> src/feature/entry.ts",
      "src/removed.ts -> src/removed.ts",
    ],
    crewPlugin: {
      entry: "src/main.ts",
      members: [
        "src/main.ts",
        "src/feature/entry.ts",
        "src/feature/leaf.ts",
        "src/other/private.ts",
        "src/removed.ts",
      ],
      note: { retain: true },
    },
    exceptions: [EXCEPTION],
    largeFiles: ["src/other/private.ts"],
    futureInventory: { version: 9, values: ["preserve", 42, null] },
  };
}

type Baseline = ReturnType<typeof baseline>;

async function files(root: string, contents: Record<string, string>) {
  for (const [name, text] of Object.entries(contents)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), text);
  }
}

async function json(root: string, path: string, value: unknown) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), JSON.stringify(value, null, 2) + "\n");
}

async function formatter(root: string, body = "process.stdout.write(input);") {
  const path = "node_modules/.bin/oxfmt";
  await files(root, {
    [path]: `#!${process.execPath}\nconst input = await Bun.stdin.text();\n${body}\n`,
  });
  await chmod(join(root, path), 0o755);
}

async function fixture(
  prepare?: (value: Baseline) => void,
  sources: Record<string, string> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "stargate-architecture-refresh-"));
  temporary.push(root);
  const policy: ArchitecturePolicy = {
    slices: {
      feature: {
        layer: "slices",
        files: ["src/main.ts", "src/feature/entry.ts", "src/feature/leaf.ts"],
        public: ["src/feature/entry.ts"],
        neighbours: ["other"],
      },
      other: {
        layer: "slices",
        files: ["src/other/private.ts"],
        public: [],
        neighbours: ["feature"],
      },
    },
  };
  await files(root, {
    "src/main.ts": 'import "./feature/entry";\n',
    "src/feature/entry.ts": 'import "./leaf"; import "../other/private";\n',
    "src/feature/leaf.ts": 'import "./entry";\n',
    "src/other/private.ts": "export {};\n" + "// size fixture\n".repeat(1000),
    "AGENTS.md": "# Fixture\n",
    "README.md": "# Fixture\n",
    "CONTRIBUTING.md": "# Fixture\n",
    "docs/design.md": "# Fixture\n",
    ".gitignore": "node_modules/\n",
    ...sources,
  });
  const original = baseline();
  prepare?.(original);
  await json(root, BASELINE, original);
  await json(root, POLICY, policy);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Architecture Refresh Test");
  git(root, "config", "user.email", "architecture-test@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", ".");
  git(root, "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture");
  return { root, base: git(root, "rev-parse", "HEAD"), original, policy };
}

function run(root: string, base: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    [SCRIPT, "--root", root, "--base", base, ...args],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}

async function noStagingFiles(root: string) {
  expect((await readdir(join(root, "tests"))).sort()).toEqual([
    "architecture-baseline.json",
    "architecture-policy.json",
  ]);
}

async function closureFixture(
  sources: Record<string, string> = { "new.ts": 'import "node:crypto";\n' },
  prepare?: (value: Baseline) => void,
) {
  const value = await fixture(prepare);
  const additions = Object.keys(sources).map((name) => `src/feature/${name}`);
  value.policy.slices["feature"]?.files.push(...additions);
  await files(value.root, {
    ...Object.fromEntries(
      Object.entries(sources).map(([name, text]) => [
        `src/feature/${name}`,
        text,
      ]),
    ),
    "src/feature/entry.ts":
      'import "./leaf"; import "../other/private";\n' +
      Object.keys(sources)
        .map((name) => `import "./${name}";\n`)
        .join(""),
  });
  await json(value.root, POLICY, value.policy);
  await formatter(value.root);
  return value;
}

function closureAddition(
  file: string,
  imports: string[] = [],
  identity = file,
) {
  return {
    file,
    identity,
    imports,
    checks: [
      "added-member",
      "imports-resolve",
      "imports-in-base-closure-or-package",
    ],
  };
}

async function refusesClosureChange(
  root: string,
  base: string,
  error: string,
  ...args: string[]
) {
  const before = await readFile(join(root, BASELINE), "utf8");
  const result = run(root, base, "--write", ...args);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(error);
  expect(await readFile(join(root, BASELINE), "utf8")).toBe(before);
  await noStagingFiles(root);
  return result;
}

describe("architecture baseline refresh", () => {
  for (const lines of [999, 1000, 1001]) {
    test(`size pruning: listed file reduced to ${lines} lines`, async () => {
      const { root, base, original } = await fixture(
        (value) => value.largeFiles.push("src/feature/leaf.ts"),
        {
          "src/feature/leaf.ts":
            'import "./entry";\n' + "// original oversized file\n".repeat(1000),
        },
      );
      await files(root, {
        "src/feature/leaf.ts":
          'import "./entry";\n' + "// reduced file\n".repeat(lines - 1),
      });
      await formatter(root);
      const before = await readFile(join(root, BASELINE), "utf8");
      const pruned = lines <= 1000 ? ["src/feature/leaf.ts"] : [];
      const kept = original.largeFiles.filter((file) => !pruned.includes(file));
      const outside = await mkdtemp(join(tmpdir(), "stargate-size-preview-"));
      temporary.push(outside);
      const output = join(outside, "receipt.json");
      const preview = run(root, base, "--prune-stale", "--output", output);
      expect(preview.status).toBe(0);
      expect(JSON.parse(preview.stdout)).toMatchObject({
        write: false,
        prunedLargeFiles: pruned,
      });
      expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
        largeFiles: kept,
        prunedLargeFiles: pruned,
      });
      expect(await readFile(join(root, BASELINE), "utf8")).toBe(before);
      const noFlag = run(root, base, "--write");
      if (pruned.length) {
        expect(noFlag.status).not.toBe(0);
        expect(noFlag.stderr).toContain("stale:large-file:src/feature/leaf.ts");
        expect(noFlag.stdout).toBe("");
        expect(await readFile(join(root, BASELINE), "utf8")).toBe(before);
      } else {
        expect(noFlag.status).toBe(0);
      }
      const written = run(root, base, "--write", "--prune-stale");
      expect(written.status).toBe(0);
      expect(JSON.parse(written.stdout)).toMatchObject({
        prunedLargeFiles: pruned,
      });
      const after = await readFile(join(root, BASELINE), "utf8");
      expect(JSON.parse(after).largeFiles).toEqual(kept);
      const second = run(root, base, "--write", "--prune-stale");
      expect(second.status).toBe(0);
      expect(JSON.parse(second.stdout)).toMatchObject({ prunedLargeFiles: [] });
      expect(await readFile(join(root, BASELINE), "utf8")).toBe(after);
      await noStagingFiles(root);
    });
  }

  test("size pruning: listed absent file is refused without the flag and removed with it", async () => {
    const { root, base, original } = await fixture((value) => {
      value.largeFiles.push("src/no-longer-present.ts");
    });
    await formatter(root);
    const before = await readFile(join(root, BASELINE), "utf8");
    const noFlag = run(root, base, "--write");
    expect(noFlag.status).not.toBe(0);
    expect(noFlag.stderr).toContain(
      "stale:large-file:src/no-longer-present.ts",
    );
    expect(noFlag.stdout).toBe("");
    expect(await readFile(join(root, BASELINE), "utf8")).toBe(before);
    const result = run(root, base, "--write", "--prune-stale");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      prunedLargeFiles: ["src/no-longer-present.ts"],
    });
    expect(
      JSON.parse(await readFile(join(root, BASELINE), "utf8")).largeFiles,
    ).toEqual(
      original.largeFiles.filter((file) => file !== "src/no-longer-present.ts"),
    );
    await noStagingFiles(root);
  });

  test("size pruning: moved oversized alias keeps its logical entry and exact baseline bytes", async () => {
    const { root, base, policy } = await fixture();
    await formatter(root);
    expect(run(root, base, "--write").status).toBe(0);
    const before = await readFile(join(root, BASELINE), "utf8");
    const source = await readFile(join(root, "src/other/private.ts"), "utf8");
    await files(root, {
      "src/other/moved-private.ts": source,
      "src/feature/entry.ts":
        'import "./leaf"; import "../other/moved-private";\n',
    });
    await rm(join(root, "src/other/private.ts"));
    policy.aliases = {
      "src/other/private.ts": [
        "src/other/private.ts",
        "src/other/moved-private.ts",
      ],
    };
    await json(root, POLICY, policy);
    for (const flags of [[], ["--prune-stale"]]) {
      const result = run(root, base, "--write", ...flags);
      expect(result.status).toBe(0);
      if (flags.length)
        expect(JSON.parse(result.stdout)).toMatchObject({
          prunedLargeFiles: [],
        });
      expect(await readFile(join(root, BASELINE), "utf8")).toBe(before);
    }
    await noStagingFiles(root);
  });

  test("size pruning: an unlisted oversized file is never authorized", async () => {
    const { root, base } = await fixture();
    await files(root, {
      "src/feature/leaf.ts":
        'import "./entry";\n' + "// oversized\n".repeat(1000),
    });
    await formatter(root);
    const before = await readFile(join(root, BASELINE), "utf8");
    for (const flags of [[], ["--prune-stale"]]) {
      const result = run(root, base, "--write", ...flags);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "unauthorized-large-file:src/feature/leaf.ts",
      );
      expect(result.stdout).toBe("");
      expect(await readFile(join(root, BASELINE), "utf8")).toBe(before);
    }
    await noStagingFiles(root);
  });

  test("rejects added size permissions without writing", async () => {
    const { root, base, original } = await fixture();
    await files(root, {
      "src/feature/leaf.ts":
        'import "./entry";\n' + "// size probe\n".repeat(1028),
    });
    original.largeFiles.push("src/feature/leaf.ts");
    await json(root, BASELINE, original);
    await formatter(root);
    const before = await readFile(join(root, BASELINE), "utf8");
    for (const flags of [[], ["--prune-stale"]]) {
      const result = run(root, base, "--write", ...flags);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "unauthorized-large-file:src/feature/leaf.ts",
      );
      expect(await readFile(join(root, BASELINE), "utf8")).toBe(before);
    }
    await noStagingFiles(root);
  });

  test("accepts explicit removal of a size permission for a file below the limit", async () => {
    const { root, base, original } = await fixture((value) => {
      value.largeFiles.push("src/feature/leaf.ts");
    });
    original.largeFiles = original.largeFiles.filter(
      (file) => file !== "src/feature/leaf.ts",
    );
    await json(root, BASELINE, original);
    await formatter(root);
    expect(run(root, base, "--write").status).toBe(0);
    const next = JSON.parse(
      await readFile(join(root, BASELINE), "utf8"),
    ) as Baseline;
    expect(next.largeFiles).toEqual(original.largeFiles);
    expect(next.largeFiles).not.toContain("src/feature/leaf.ts");
    await noStagingFiles(root);
  });

  test("previews working-tree reductions, then writes once without losing metadata", async () => {
    const { root, base, original } = await fixture();
    await files(root, {
      "src/feature/entry.ts": 'import "../other/private";\n',
      "src/feature/leaf.ts": "export {};\n",
    });
    const before = await readFile(join(root, BASELINE), "utf8");
    const preview = run(root, base);
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      write: false,
      modules: 4,
      edges: 2,
      roots: 1,
      largestCycle: 0,
      cyclicEdges: 0,
      crewClosure: 3,
      exceptions: 1,
    });
    expect(await readFile(join(root, BASELINE), "utf8")).toBe(before);
    await noStagingFiles(root);

    await formatter(root);
    await chmod(join(root, BASELINE), 0o664);
    const written = run(root, base, "--write");
    expect(written.status).toBe(0);
    const after = await readFile(join(root, BASELINE), "utf8");
    expect(JSON.parse(after)).toEqual({
      ...original,
      sourceFiles: 4,
      sourceEdges: 2,
      rootFiles: ["src/main.ts"],
      largestCycle: 0,
      cycleComponents: [],
      cyclicEdges: [],
      crewPlugin: {
        ...original.crewPlugin,
        members: [
          "src/feature/entry.ts",
          "src/main.ts",
          "src/other/private.ts",
        ],
      },
    });
    expect((await stat(join(root, BASELINE))).mode & 0o777).toBe(0o664);
    expect(run(root, base, "--write").status).toBe(0);
    expect(await readFile(join(root, BASELINE), "utf8")).toBe(after);
    await noStagingFiles(root);
  });

  test("permits explicit removal of resolved exceptions", async () => {
    const { root, base, original } = await fixture();
    await files(root, { "src/feature/entry.ts": 'import "./leaf";\n' });
    await json(root, BASELINE, { ...original, exceptions: [] });
    await formatter(root);
    expect(run(root, base, "--write").status).toBe(0);
    const next = JSON.parse(
      await readFile(join(root, BASELINE), "utf8"),
    ) as Baseline;
    expect(next.exceptions).toEqual([]);
    expect(next.largeFiles).toEqual(original.largeFiles);
  });

  test("prunes and names only resolved exceptions, then removes nothing on a second write", async () => {
    const { root, base, original } = await fixture();
    await files(root, { "src/feature/entry.ts": 'import "./leaf";\n' });
    await formatter(root);
    const result = run(root, base, "--write", "--prune-stale");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      write: true,
      exceptions: 0,
      prunedExceptions: [EXCEPTION],
    });
    const after = await readFile(join(root, BASELINE), "utf8");
    const next = JSON.parse(after) as Baseline;
    expect(next.exceptions).toEqual([]);
    expect(next.largeFiles).toEqual(original.largeFiles);
    expect(next.sourceCommit).toBe(original.sourceCommit);
    expect(next.measurementStatus).toBe(original.measurementStatus);
    expect(next.futureInventory).toEqual(original.futureInventory);
    const second = run(root, base, "--write", "--prune-stale");
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ prunedExceptions: [] });
    expect(await readFile(join(root, BASELINE), "utf8")).toBe(after);
    await noStagingFiles(root);
  });

  test("preview names planned removals in stdout and receipt without writing", async () => {
    const { root, base } = await fixture();
    await files(root, { "src/feature/entry.ts": 'import "./leaf";\n' });
    const outside = await mkdtemp(join(tmpdir(), "stargate-prune-preview-"));
    temporary.push(outside);
    const output = join(outside, "receipt.json");
    const before = await readFile(join(root, BASELINE), "utf8");
    const result = run(root, base, "--prune-stale", "--output", output);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      write: false,
      prunedExceptions: [EXCEPTION],
    });
    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
      write: false,
      exceptions: [],
      prunedExceptions: [EXCEPTION],
      errors: [],
    });
    expect(await readFile(join(root, BASELINE), "utf8")).toBe(before);
    await noStagingFiles(root);
  });

  test("a stale exception cannot hide a new violation or permit any write", async () => {
    const { root, base } = await fixture();
    await files(root, {
      "src/feature/entry.ts": 'import "./leaf";\n',
      "src/feature/leaf.ts": 'import "./entry"; import "../other/private";\n',
    });
    await formatter(root);
    const before = await readFile(join(root, BASELINE), "utf8");
    const result = run(root, base, "--write", "--prune-stale");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "new:private:src/feature/leaf.ts -> src/other/private.ts",
    );
    expect(await readFile(join(root, BASELINE), "utf8")).toBe(before);
    await noStagingFiles(root);
  });

  for (const scenario of ["unauthorized", "duplicate"] as const) {
    test(`pruning cannot authorize ${scenario} exceptions`, async () => {
      const { root, base, original } = await fixture();
      original.exceptions.push(
        scenario === "unauthorized" ? "unapproved:permission" : EXCEPTION,
      );
      await files(root, { "src/feature/entry.ts": 'import "./leaf";\n' });
      await json(root, BASELINE, original);
      const before = await readFile(join(root, BASELINE), "utf8");
      const result = run(root, base, "--write", "--prune-stale");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        scenario === "unauthorized"
          ? "unauthorized-exception:unapproved:permission"
          : "duplicate-exception",
      );
      expect(await readFile(join(root, BASELINE), "utf8")).toBe(before);
      await noStagingFiles(root);
    });
  }

  for (const scenario of [
    "unauthorized",
    "new",
    "stale",
    "duplicate",
  ] as const) {
    test(`rejects ${scenario} exceptions without changing the baseline`, async () => {
      const { root, base, original } = await fixture();
      if (scenario === "unauthorized")
        original.exceptions.push("unapproved:permission");
      if (scenario === "new") original.exceptions = [];
      if (scenario === "duplicate") original.exceptions.push(EXCEPTION);
      if (scenario === "stale")
        await files(root, { "src/feature/entry.ts": 'import "./leaf";\n' });
      await json(root, BASELINE, original);
      const before = await readFile(join(root, BASELINE), "utf8");
      const result = run(root, base, "--write");
      expect(result.status).not.toBe(0);
      const error =
        scenario === "unauthorized"
          ? "unauthorized-exception:"
          : scenario === "duplicate"
            ? "duplicate-exception"
            : `${scenario}:`;
      expect(result.stderr).toContain(error);
      expect(await readFile(join(root, BASELINE), "utf8")).toBe(before);
      await noStagingFiles(root);
    });
  }

  for (const scenario of [
    "root",
    "cycle",
    "largest-cycle",
    "crew-closure",
  ] as const) {
    test(`rejects ${scenario} growth against base permissions, not edited working caps`, async () => {
      const { root, base, original, policy } = await fixture((value) => {
        if (scenario === "largest-cycle") value.largestCycle = 1;
        if (scenario === "crew-closure")
          value.crewPlugin.members = ["src/main.ts"];
      });
      if (scenario === "root") {
        await files(root, { "src/new.ts": "export {};\n" });
        policy.slices["feature"]?.files.push("src/new.ts");
        await json(root, POLICY, policy);
        original.rootFiles.push("src/new.ts");
      }
      if (scenario === "cycle") {
        await files(root, {
          "src/feature/leaf.ts": 'import "./entry"; import "./leaf";\n',
        });
        original.cyclicEdges.push("src/feature/leaf.ts -> src/feature/leaf.ts");
      }
      if (scenario === "largest-cycle") original.largestCycle = 10;
      if (scenario === "crew-closure")
        original.crewPlugin.members = baseline().crewPlugin.members;
      await json(root, BASELINE, original);
      const before = await readFile(join(root, BASELINE), "utf8");
      for (const flags of [[], ["--prune-stale"]]) {
        const result = run(root, base, "--write", ...flags);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(`${scenario}:`);
        expect(await readFile(join(root, BASELINE), "utf8")).toBe(before);
      }
      await noStagingFiles(root);
    });
  }

  for (const scenario of [
    "failure",
    "semantic-change",
    "invalid-json",
  ] as const) {
    test(`formatter ${scenario} leaves exact baseline bytes untouched`, async () => {
      const { root, base } = await fixture();
      const before = await readFile(join(root, BASELINE), "utf8");
      const bodies = {
        failure:
          'process.stderr.write("fixture formatter failed"); process.exit(7);',
        "semantic-change":
          "const value = JSON.parse(input); value.sourceFiles++; process.stdout.write(JSON.stringify(value));",
        "invalid-json": 'process.stdout.write("not JSON");',
      };
      await formatter(root, bodies[scenario]);
      const result = run(root, base, "--write");
      expect(result.status).not.toBe(0);
      if (scenario === "failure")
        expect(result.stderr).toContain("oxfmt failed (7)");
      if (scenario === "semantic-change")
        expect(result.stderr).toContain("Formatter changed baseline data");
      expect(await readFile(join(root, BASELINE), "utf8")).toBe(before);
      await noStagingFiles(root);
    });
  }

  for (const path of [BASELINE, POLICY]) {
    test(`rejects concurrent edits to ${path} and removes its own staging file`, async () => {
      const { root, base } = await fixture();
      const before = await readFile(join(root, BASELINE), "utf8");
      const previous = await readFile(join(root, path), "utf8");
      await formatter(
        root,
        `await Bun.write(${JSON.stringify(join(root, path))}, ${JSON.stringify(previous + "\n")}); process.stdout.write(input);`,
      );
      const result = run(root, base, "--write");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Guard JSON changed during measurement");
      expect(await readFile(join(root, BASELINE), "utf8")).toBe(
        before + (path === BASELINE ? "\n" : ""),
      );
      await noStagingFiles(root);
    });
  }

  test("validates full base hashes and ancestry", async () => {
    const { root, base } = await fixture();
    expect(run(root, "HEAD").stderr).toContain("Usage:");
    expect(run(root, base.slice(0, 12)).stderr).toContain("Usage:");
    expect(run(root, "0".repeat(40)).status).not.toBe(0);
    git(root, "checkout", "--orphan", "unrelated");
    git(
      root,
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "unrelated fixture",
    );
    const result = run(root, base);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("merge-base --is-ancestor");
  });

  test("rejects unknown, nightly-only, repeated and incomplete options", async () => {
    const { root, base } = await fixture();
    for (const args of [
      ["--unknown"],
      ["--allow-net1772-swaps"],
      ["--allow-net1769-closure"],
      ["--write", "--write"],
      ["--prune-stale", "--prune-stale"],
      ["--base", base],
      ["--root", root],
      ["--output", join(root, "one"), "--output", join(root, "two")],
      ["--output"],
    ])
      expect(run(root, base, ...args).status).not.toBe(0);
  });

  test("writes optional preview receipts only outside the measured checkout", async () => {
    const { root, base } = await fixture();
    const outside = await mkdtemp(
      join(tmpdir(), "stargate-architecture-receipt-"),
    );
    temporary.push(outside);
    const output = join(outside, "receipt.json");
    const before = await readFile(join(root, BASELINE), "utf8");
    expect(run(root, base, "--output", output).status).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
      root,
      base,
      write: false,
      errors: [],
    });
    expect(await readFile(join(root, BASELINE), "utf8")).toBe(before);
    expect(
      run(root, base, "--output", join(root, "receipt.json")).stderr,
    ).toContain("Receipt output must be outside");
    await symlink(join(root, BASELINE), join(outside, "alias.json"));
    expect(
      run(root, base, "--output", join(outside, "alias.json")).stderr,
    ).toContain("Receipt output must be outside");
    expect(await readFile(join(root, BASELINE), "utf8")).toBe(before);
  });
});

describe("named architecture closure additions", () => {
  test("architecture guidance limits named additions to the recorded extraction decision", async () => {
    const source = await readFile(
      join(import.meta.dir, "architecture.test.ts"),
      "utf8",
    );
    expect(source).toContain(
      "--allow-closure-addition is only for files holding only code the closure already loaded",
    );
    expect(source).toContain("with a decision recorded for this change");
    expect(source).toContain("otherwise remove the added import");
  });

  test("refuses an unnamed equal-count identity swap", async () => {
    const { root, base, original } = await closureFixture(
      undefined,
      (value) => {
        value.crewPlugin.members = value.crewPlugin.members.filter(
          (file) => file !== "src/removed.ts",
        );
      },
    );
    // Four base members become four different members. No count cap grows.
    expect(original.crewPlugin.members).toHaveLength(4);
    await files(root, {
      "src/feature/entry.ts": 'import "./new"; import "../other/private";\n',
    });
    const result = await refusesClosureChange(
      root,
      base,
      "closure-addition:unnamed:src/feature/new.ts",
    );
    expect(result.stderr).toContain("--allow-closure-addition");
    expect(result.stderr).toContain("only code the closure already loaded");
    expect(result.stderr).toContain("with a decision recorded for this change");
    expect(result.stderr).toContain(
      "otherwise remove the import that added it",
    );
  });

  test("refuses an unnamed addition inside stale closure headroom", async () => {
    const { root, base, original } = await closureFixture();
    // Four live base members plus one new member still fit the stale cap of five.
    expect(original.crewPlugin.members).toHaveLength(5);
    expect(original.crewPlugin.members).toContain("src/removed.ts");
    const result = await refusesClosureChange(
      root,
      base,
      "closure-addition:unnamed:src/feature/new.ts",
      "--prune-stale",
    );
    expect(result.stderr).toContain("--allow-closure-addition");
  });

  test("preview and write report the exact named set without changing baseline schema", async () => {
    const { root, base, original } = await closureFixture({
      "new.ts": 'import "node:crypto"; import "./leaf"; import "./entry";\n',
    });
    // Reach the addition from main so its old local dependencies stay acyclic.
    await files(root, {
      "src/main.ts": 'import "./feature/entry"; import "./feature/new";\n',
      "src/feature/entry.ts": 'import "./leaf"; import "../other/private";\n',
      "src/feature/leaf.ts": "export {};\n",
    });
    const outside = await mkdtemp(join(tmpdir(), "stargate-closure-receipt-"));
    temporary.push(outside);
    const output = join(outside, "receipt.json");
    const before = await readFile(join(root, BASELINE), "utf8");
    const closureAdditions = [
      closureAddition("src/feature/new.ts", [
        "src/feature/entry.ts",
        "src/feature/leaf.ts",
      ]),
    ];
    const closureRemovals = ["src/removed.ts"];
    for (const write of [false, true]) {
      const result = run(
        root,
        base,
        "--allow-closure-addition",
        "src/feature/new.ts",
        "--output",
        output,
        ...(write ? ["--write"] : []),
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        root,
        write,
        modules: 5,
        edges: 6,
        roots: 1,
        largestCycle: 0,
        cyclicEdges: 0,
        crewClosure: 5,
        exceptions: 1,
        closureAdditions,
        closureRemovals,
        closureReviewRequired: REVIEW_REQUIRED,
        errors: [],
      });
      expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
        write,
        closureAdditions,
        closureRemovals,
        closureReviewRequired: REVIEW_REQUIRED,
        errors: [],
      });
      if (!write)
        expect(await readFile(join(root, BASELINE), "utf8")).toBe(before);
      await noStagingFiles(root);
    }
    expect(JSON.parse(await readFile(join(root, BASELINE), "utf8"))).toEqual({
      ...original,
      sourceFiles: 5,
      sourceEdges: 6,
      rootFiles: ["src/main.ts"],
      largestCycle: 0,
      cycleComponents: [],
      cyclicEdges: [],
      crewPlugin: {
        ...original.crewPlugin,
        members: [
          "src/feature/entry.ts",
          "src/feature/leaf.ts",
          "src/feature/new.ts",
          "src/main.ts",
          "src/other/private.ts",
        ],
      },
    });
  });

  test("accepts repeated options for independent additions and a resolved package", async () => {
    const { root, base } = await closureFixture({
      "new.ts": 'import "node:crypto";\n',
      "second.ts":
        'import { Schema } from "effect"; export function newlyWritten() { return Schema.String; }\n',
    });
    await symlink(
      join(import.meta.dir, "../node_modules/effect"),
      join(root, "node_modules/effect"),
      "dir",
    );
    const result = run(
      root,
      base,
      "--write",
      "--allow-closure-addition",
      "src/feature/second.ts",
      "--allow-closure-addition",
      "src/feature/new.ts",
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      crewClosure: 6,
      closureAdditions: [
        closureAddition("src/feature/new.ts"),
        closureAddition("src/feature/second.ts"),
      ],
      closureRemovals: ["src/removed.ts"],
      closureReviewRequired: REVIEW_REQUIRED,
      errors: [],
    });
    await noStagingFiles(root);
  });

  test("combines named additions with separate closure removals", async () => {
    const { root, base } = await closureFixture();
    await files(root, {
      "src/feature/entry.ts": 'import "./new"; import "../other/private";\n',
    });
    const result = run(
      root,
      base,
      "--write",
      "--allow-closure-addition",
      "src/feature/new.ts",
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      crewClosure: 4,
      closureAdditions: [closureAddition("src/feature/new.ts")],
      closureRemovals: ["src/feature/leaf.ts", "src/removed.ts"],
      errors: [],
    });
    const next = JSON.parse(
      await readFile(join(root, BASELINE), "utf8"),
    ) as Baseline;
    expect(next.crewPlugin.members).toEqual([
      "src/feature/entry.ts",
      "src/feature/new.ts",
      "src/main.ts",
      "src/other/private.ts",
    ]);
    await noStagingFiles(root);
  });

  test("maps a named physical file to its policy identity", async () => {
    const { root, base, policy } = await closureFixture();
    const identity = "src/feature/logical-new.ts";
    const feature = policy.slices["feature"];
    if (!feature) throw new Error("Missing fixture feature slice");
    feature.files = feature.files.map((file) =>
      file === "src/feature/new.ts" ? identity : file,
    );
    policy.aliases = { [identity]: [identity, "src/feature/new.ts"] };
    await json(root, POLICY, policy);
    const result = run(
      root,
      base,
      "--write",
      "--allow-closure-addition",
      "src/feature/new.ts",
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      closureAdditions: [closureAddition("src/feature/new.ts", [], identity)],
    });
    const next = JSON.parse(
      await readFile(join(root, BASELINE), "utf8"),
    ) as Baseline;
    expect(next.crewPlugin.members).toContain(identity);
    expect(next.crewPlugin.members).not.toContain("src/feature/new.ts");
    await noStagingFiles(root);
  });

  test("does not require a name for a new physical path with an existing identity", async () => {
    const { root, base, policy } = await fixture();
    await files(root, {
      "src/feature/entry.ts":
        'import "./moved-leaf"; import "../other/private";\n',
      "src/feature/moved-leaf.ts": 'import "./entry";\n',
    });
    await rm(join(root, "src/feature/leaf.ts"));
    policy.aliases = {
      "src/feature/leaf.ts": [
        "src/feature/leaf.ts",
        "src/feature/moved-leaf.ts",
      ],
    };
    await json(root, POLICY, policy);
    await formatter(root);
    const result = run(root, base, "--write");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).not.toHaveProperty("closureAdditions");
    expect(JSON.parse(result.stdout)).not.toHaveProperty("closureRemovals");
    const next = JSON.parse(
      await readFile(join(root, BASELINE), "utf8"),
    ) as Baseline;
    expect(next.crewPlugin.members).toContain("src/feature/leaf.ts");
    expect(next.crewPlugin.members).not.toContain("src/feature/moved-leaf.ts");
    await noStagingFiles(root);
  });

  test("refuses an independent unnamed extra even when another addition is named", async () => {
    const { root, base } = await closureFixture({
      "new.ts": 'import "node:crypto";\n',
      "second.ts": 'import "node:crypto";\n',
    });
    const result = await refusesClosureChange(
      root,
      base,
      "closure-addition:unnamed:src/feature/second.ts",
      "--allow-closure-addition",
      "src/feature/new.ts",
    );
    expect(result.stderr).toContain("--allow-closure-addition");
  });

  test("refuses a name for an existing closure member", async () => {
    const { root, base } = await fixture();
    await formatter(root);
    await refusesClosureChange(
      root,
      base,
      "closure-addition:not-added:src/feature/leaf.ts",
      "--allow-closure-addition",
      "src/feature/leaf.ts",
    );
  });

  test("refuses a duplicate name", async () => {
    const { root, base } = await closureFixture();
    await refusesClosureChange(
      root,
      base,
      "duplicate-closure-addition:src/feature/new.ts",
      "--allow-closure-addition",
      "src/feature/new.ts",
      "--allow-closure-addition",
      "src/feature/new.ts",
    );
  });

  for (const name of [
    "src/feature/missing.ts",
    "./src/feature/new.ts",
    "src/feature/../feature/new.ts",
    "src/feature",
    "README.md",
    "../outside.ts",
    "src/feature/new",
  ]) {
    test(`refuses an unknown or noncanonical file name ${name}`, async () => {
      const { root, base } = await closureFixture();
      await refusesClosureChange(
        root,
        base,
        `closure-addition:unknown-file:${name}`,
        "--allow-closure-addition",
        name,
      );
    });
  }

  test("refuses an absolute file name even inside the checkout", async () => {
    const { root, base } = await closureFixture();
    const name = join(root, "src/feature/new.ts");
    await refusesClosureChange(
      root,
      base,
      `closure-addition:unknown-file:${name}`,
      "--allow-closure-addition",
      name,
    );
  });

  for (const bothNamed of [false, true]) {
    test(`refuses a dependency outside the base closure when both named = ${bothNamed}`, async () => {
      const { root, base } = await closureFixture({
        "new.ts": 'import "./second";\n',
        "second.ts": 'import "node:crypto";\n',
      });
      await refusesClosureChange(
        root,
        base,
        "closure-addition:new-import:src/feature/new.ts -> src/feature/second.ts",
        "--allow-closure-addition",
        "src/feature/new.ts",
        ...(bothNamed
          ? ["--allow-closure-addition", "src/feature/second.ts"]
          : []),
      );
    });
  }

  for (const loader of ["import", "require"]) {
    test(`refuses a computed ${loader} in a named addition`, async () => {
      const { root, base } = await closureFixture({
        "new.ts": `const target = "node:crypto"; ${loader}(target);\n`,
      });
      await refusesClosureChange(
        root,
        base,
        "closure-addition:nonliteral-import:src/feature/new.ts",
        "--allow-closure-addition",
        "src/feature/new.ts",
      );
    });
  }

  test("refuses an unresolved package in a named addition", async () => {
    const { root, base } = await closureFixture({
      "new.ts": 'import "stargate-fixture-package-does-not-exist";\n',
    });
    await refusesClosureChange(
      root,
      base,
      "closure-addition:unresolved-import:",
      "--allow-closure-addition",
      "src/feature/new.ts",
    );
  });

  test("refuses local JSON omitted from the source graph", async () => {
    const { root, base } = await closureFixture({
      "new.ts": 'import "./data.json";\n',
    });
    await json(root, "src/feature/data.json", { value: 1 });
    await refusesClosureChange(
      root,
      base,
      "closure-addition:untracked-import:",
      "--allow-closure-addition",
      "src/feature/new.ts",
    );
  });

  for (const guard of ["root", "cycle", "size-permission"] as const) {
    test(`naming an addition does not waive the ${guard} guard`, async () => {
      const { root, base, original, policy } = await closureFixture();
      if (guard === "root") {
        await files(root, { "src/new-root.ts": "export {};\n" });
        policy.slices["feature"]?.files.push("src/new-root.ts");
        await json(root, POLICY, policy);
      }
      if (guard === "cycle")
        await files(root, {
          "src/feature/leaf.ts": 'import "./entry"; import "./leaf";\n',
        });
      if (guard === "size-permission") {
        original.largeFiles.push("src/feature/new.ts");
        await json(root, BASELINE, original);
        await files(root, {
          "src/feature/new.ts":
            'import "node:crypto";\n' + "// size probe\n".repeat(1001),
        });
      }
      const error =
        guard === "root"
          ? "root:src/new-root.ts"
          : guard === "cycle"
            ? "cycle:src/feature/leaf.ts -> src/feature/leaf.ts"
            : "unauthorized-large-file:src/feature/new.ts";
      await refusesClosureChange(
        root,
        base,
        error,
        "--allow-closure-addition",
        "src/feature/new.ts",
        "--prune-stale",
      );
    });
  }

  test("keeps the default stdout and receipt shapes when there are no new identities", async () => {
    const { root, base } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "stargate-closure-default-"));
    temporary.push(outside);
    const output = join(outside, "receipt.json");
    const before = await readFile(join(root, BASELINE), "utf8");
    const result = run(root, base, "--output", output);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      root,
      write: false,
      modules: 4,
      edges: 4,
      roots: 1,
      largestCycle: 2,
      cyclicEdges: 2,
      crewClosure: 4,
      exceptions: 1,
      errors: [],
    });
    const receipt = JSON.parse(await readFile(output, "utf8"));
    expect(Object.keys(receipt).sort()).toEqual([
      "base",
      "cycleComponents",
      "errors",
      "exceptions",
      "flags",
      "inventory",
      "root",
      "violations",
      "write",
    ]);
    expect(receipt).not.toHaveProperty("closureAdditions");
    expect(receipt).not.toHaveProperty("closureRemovals");
    expect(await readFile(join(root, BASELINE), "utf8")).toBe(before);
    await noStagingFiles(root);
  });

  test("does not enable strict import checks without named additions", async () => {
    const { root, base } = await fixture();
    await files(root, {
      "src/feature/leaf.ts":
        'import "./entry"; import "./data.json";\n' +
        'import "stargate-fixture-package-does-not-exist";\n' +
        'const target = "node:crypto"; import(target); require(target);\n',
    });
    await json(root, "src/feature/data.json", { value: 1 });
    await formatter(root);
    const result = run(root, base, "--write");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).not.toHaveProperty("closureAdditions");
    expect(JSON.parse(result.stdout)).not.toHaveProperty("closureRemovals");
    await noStagingFiles(root);
  });
});
