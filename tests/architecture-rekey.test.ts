import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const script = join(
  import.meta.dir,
  "../scripts/refresh-architecture-baseline.ts",
);

const baselinePath = "tests/architecture-baseline.json";
const oldKey = "private:src/feature/entry.ts -> src/other/private.ts";
const newKey = "private:src/feature/composition.ts -> src/other/private.ts";
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });

  if (result.status !== 0) throw new Error(result.stderr);

  return result.stdout.trim();
}

async function put(root: string, name: string, text: string) {
  await mkdir(dirname(join(root, name)), { recursive: true });
  await writeFile(join(root, name), text);
}

async function fixture(
  options: { existingDestination?: boolean; missingBaseEdge?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "stargate-rekey-"));
  roots.push(root);

  const policy = {
    slices: {
      feature: {
        layer: "slices",
        files: [
          "src/main.ts",
          "src/feature/entry.ts",
          ...(options.existingDestination
            ? ["src/feature/composition.ts"]
            : []),
          "src/feature/unrelated.ts",
        ],
        public: ["src/feature/entry.ts"],
        neighbours: ["other"],
      },
      other: {
        layer: "slices",
        files: ["src/other/private.ts", "src/other/second.ts"],
        public: [],
        neighbours: [],
      },
    },
  };

  const baseline = {
    sourceCommit: "1111111111111111111111111111111111111111",
    sourceFiles: 5,
    sourceEdges: 2,
    rootFiles: ["src/main.ts"],
    largestCycle: 0,
    cycleComponents: [],
    cyclicEdges: [],
    crewPlugin: {
      entry: "src/main.ts",
      members: ["src/main.ts", "src/feature/entry.ts", "src/other/private.ts"],
    },
    exceptions: [oldKey],
    largeFiles: [],
  };

  for (const [name, text] of Object.entries({
    "src/main.ts": 'import "./feature/entry";\n',
    "src/feature/entry.ts": options.missingBaseEdge
      ? '// import "../other/private";\nexport {};\n'
      : 'import "../other/private";\n',
    "src/feature/unrelated.ts": "export {};\n",
    "src/other/private.ts": "export {};\n",
    "src/other/second.ts": "export {};\n",
    "AGENTS.md": "# Fixture\n",
    "README.md": "# Fixture\n",
    "CONTRIBUTING.md": "# Fixture\n",
    "docs/design.md": "# Fixture\n",
    ".gitignore": "node_modules/\n",
    "tests/architecture-policy.json": JSON.stringify(policy),
    [baselinePath]: JSON.stringify(baseline),
    ...(options.existingDestination
      ? { "src/feature/composition.ts": "export {};\n" }
      : {}),
  }))
    await put(root, name, text);
  git(root, "init", "-b", "fixture");
  git(root, "add", ".");
  git(
    root,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  const base = git(root, "rev-parse", "HEAD");

  if (!options.existingDestination) {
    policy.slices.feature.files.push("src/feature/composition.ts");
    await put(root, "tests/architecture-policy.json", JSON.stringify(policy));
  }

  await put(root, "src/feature/entry.ts", 'import "./composition";\n');
  await put(root, "src/feature/composition.ts", 'import "../other/private";\n');
  await put(
    root,
    "node_modules/.bin/oxfmt",
    `#!${process.execPath}\nprocess.stdout.write(await Bun.stdin.text());\n`,
  );
  await chmod(join(root, "node_modules/.bin/oxfmt"), 0o755);

  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        script,
        "--root",
        root,
        "--base",
        base,
        "--allow-closure-addition",
        "src/feature/composition.ts",
        ...args,
      ],
      { cwd: root, encoding: "utf8", timeout: 30_000 },
    );

  return { root, base, run };
}

test("declared rekey preserves a base import and writes only the new identity", async () => {
  const { root, run } = await fixture();
  const before = await readFile(join(root, baselinePath), "utf8");
  const preview = run("--rekey-exception", oldKey, newKey);
  expect(preview.status).toBe(0);
  expect(JSON.parse(preview.stdout).exceptionRekeys).toEqual([
    { oldKey, newKey },
  ]);
  expect(await readFile(join(root, baselinePath), "utf8")).toBe(before);
  const result = run("--write", "--rekey-exception", oldKey, newKey);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).exceptionRekeys).toEqual([
    { oldKey, newKey },
  ]);
  expect(
    JSON.parse(await readFile(join(root, baselinePath), "utf8")).exceptions,
  ).toEqual([newKey]);
});

test("without a declaration the existing new-exception guard still rejects the move", async () => {
  const { root, run } = await fixture();
  const before = await readFile(join(root, baselinePath), "utf8");
  const result = run("--write");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(`new:${newKey}`);
  expect(await readFile(join(root, baselinePath), "utf8")).toBe(before);
});

test("a written rekey remains explicit and can be repeated idempotently", async () => {
  const { root, run } = await fixture();
  const args = ["--write", "--rekey-exception", oldKey, newKey];
  expect(run(...args).status).toBe(0);
  const written = await readFile(join(root, baselinePath), "utf8");
  const undeclared = run("--write");
  expect(undeclared.status).not.toBe(0);
  expect(undeclared.stderr).toContain(`unauthorized-exception:${newKey}`);
  expect(run(...args).status).toBe(0);
  expect(await readFile(join(root, baselinePath), "utf8")).toBe(written);
});

for (const scenario of [
  "different-target",
  "different-kind",
  "old-key-present",
  "new-source-existed-at-base",
  "exception-total-increase",
  "duplicate-old",
  "base-edge-missing",
] as const) {
  test(`declared rekey refuses ${scenario} without changing the baseline`, async () => {
    const { root, run } = await fixture({
      existingDestination: scenario === "new-source-existed-at-base",
      missingBaseEdge: scenario === "base-edge-missing",
    });

    let next = newKey;

    if (scenario === "different-target") {
      next = newKey.replace("private.ts", "second.ts");
      await put(
        root,
        "src/feature/composition.ts",
        'import "../other/second";\n',
      );
    }

    if (scenario === "different-kind")
      next = newKey.replace("private:", "direction:");

    if (scenario === "old-key-present")
      await put(
        root,
        "src/feature/entry.ts",
        'import "./composition"; import "../other/private";\n',
      );

    if (scenario === "exception-total-increase")
      await put(
        root,
        "src/feature/unrelated.ts",
        'import "../other/second";\n',
      );
    const before = await readFile(join(root, baselinePath), "utf8");
    const args = ["--write", "--rekey-exception", oldKey, next];

    if (scenario === "duplicate-old")
      args.push("--rekey-exception", oldKey, next);
    const result = run(...args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`rekey:${scenario}`);
    expect(await readFile(join(root, baselinePath), "utf8")).toBe(before);
  });
}
