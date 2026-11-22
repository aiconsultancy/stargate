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
    largeFiles: ["src/permanently-exempt.ts"],
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

async function fixture(prepare?: (value: Baseline) => void) {
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
    "src/other/private.ts": "export {};\n",
    "AGENTS.md": "# Fixture\n",
    "README.md": "# Fixture\n",
    "CONTRIBUTING.md": "# Fixture\n",
    "docs/design.md": "# Fixture\n",
    ".gitignore": "node_modules/\n",
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

describe("architecture baseline refresh", () => {
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
    const result = run(root, base, "--write");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "unauthorized-large-file:src/feature/leaf.ts",
    );
    expect(await readFile(join(root, BASELINE), "utf8")).toBe(before);
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
      const result = run(root, base, "--write");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`${scenario}:`);
      expect(await readFile(join(root, BASELINE), "utf8")).toBe(before);
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
