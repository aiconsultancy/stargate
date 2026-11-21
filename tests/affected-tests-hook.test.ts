import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";

const HOOK = join(import.meta.dir, "../scripts/hooks/affected-tests.ts");

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

async function scenario() {
  const root = await mkdtemp(join(tmpdir(), "affected-hook-"));
  for (const directory of ["src", "tests", "scripts", "bin"])
    await mkdir(join(root, directory));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "hook-test@example.invalid");
  git(root, "config", "user.name", "Hook Test");
  await writeFile(join(root, "src/leaf.ts"), "export const value = 1;\n");
  await writeFile(
    join(root, "src/middle.ts"),
    'export { value } from "./leaf";\n',
  );
  await writeFile(
    join(root, "tests/dependent.test.ts"),
    'import { value } from "../src/middle";\nconsole.log(value);\n',
  );
  await writeFile(join(root, "tests/unrelated.test.ts"), "export {};\n");
  await writeFile(
    join(root, "tests/commonjs.test.ts"),
    'const loaded = require("../src/leaf");\nconsole.log(loaded);\n',
  );
  await writeFile(join(root, "scripts/.keep"), "");
  git(root, "add", "src", "tests", "scripts");
  git(root, "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture");
  // Record the runner boundary without starting another test suite.
  await writeFile(
    join(root, "bin/bun"),
    '#!/bin/sh\n[ -z "${GIT_INDEX_FILE+x}" ] || exit 93\nprintf "%s\\n" "$@" > "$PWD/ran"\nexit "${RUNNER_EXIT:-0}"\n',
  );
  await chmod(join(root, "bin/bun"), 0o755);
  return root;
}

function run(root: string, extra: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env };
  delete env["STARGATE_UNTRUSTED_TESTS"];
  return spawnSync(process.execPath, [HOOK], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...env,
      PATH: `${root}/bin:${process.env["PATH"] ?? ""}`,
      ...extra,
    },
  });
}

async function fixture(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  git(root, "add", ...Object.keys(files));
  git(root, "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture inputs");
}

function untrustedPaths(output: string): Set<string> {
  const value: unknown = JSON.parse(
    /^Untrusted paths: (\[.*\])\./m.exec(output)?.[1] ?? "[]",
  );
  if (
    !Array.isArray(value) ||
    !value.every((path): path is string => typeof path === "string")
  )
    throw new Error("Invalid untrusted-path notice");
  return new Set(value);
}

describe("affected-tests hook", () => {
  test("a staged source selects transitive dependent tests from the index", async () => {
    const root = await scenario();
    try {
      await writeFile(join(root, "src/leaf.ts"), "export const value = 2;\n");
      git(root, "add", "src/leaf.ts");
      const index = join(root, ".git/commit-index");
      await copyFile(join(root, ".git/index"), index);
      git(root, "read-tree", "HEAD");
      await writeFile(join(root, "src/leaf.ts"), "export const value = 1;\n");
      // An unstaged import removal must not hide the staged dependency.
      await writeFile(join(root, "src/middle.ts"), "export const value = 9;\n");
      await writeFile(
        join(root, "tests/untracked.test.ts"),
        'import "../src/leaf";\n',
      );
      const result = run(root, { GIT_INDEX_FILE: index });
      expect(result.status).toBe(0);
      expect(await readFile(join(root, "ran"), "utf8")).toBe(
        "test\n./tests/commonjs.test.ts\n./tests/dependent.test.ts\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("source edits also select architecture scanners without source imports", async () => {
    const root = await scenario();
    try {
      await writeFile(
        join(root, "tests/architecture-graph.ts"),
        "export {};\n",
      );
      await writeFile(
        join(root, "tests/architecture.test.ts"),
        'import "./architecture-graph";\n',
      );
      git(root, "add", "tests");
      git(
        root,
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-m",
        "scanner fixture",
      );
      await writeFile(join(root, "src/leaf.ts"), "export const value = 2;\n");
      git(root, "add", "src/leaf.ts");
      expect(run(root).status).toBe(0);
      expect(await readFile(join(root, "ran"), "utf8")).toBe(
        "test\n./tests/architecture.test.ts\n./tests/commonjs.test.ts\n./tests/dependent.test.ts\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("deleting a source selects its HEAD importers without running all tests", async () => {
    const root = await scenario();
    try {
      await rm(join(root, "src/leaf.ts"));
      git(root, "add", "-u");
      const result = run(root);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("2 test files selected of 3");
      expect(await readFile(join(root, "ran"), "utf8")).toBe(
        "test\n./tests/commonjs.test.ts\n./tests/dependent.test.ts\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a source rename and import rewrites select old and new dependents", async () => {
    const root = await scenario();
    try {
      git(root, "mv", "src/leaf.ts", "src/renamed.ts");
      await writeFile(
        join(root, "src/middle.ts"),
        'export { value } from "./renamed";\n',
      );
      await writeFile(
        join(root, "tests/commonjs.test.ts"),
        'const loaded = require("../src/renamed");\n',
      );
      git(root, "add", "src", "tests");
      expect(run(root).status).toBe(0);
      expect(await readFile(join(root, "ran"), "utf8")).toBe(
        "test\n./tests/commonjs.test.ts\n./tests/dependent.test.ts\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each(["delete", "rename"])(
    "a test %s never runs its old path",
    async (operation) => {
      const root = await scenario();
      try {
        if (operation === "delete") git(root, "rm", "tests/unrelated.test.ts");
        else
          git(root, "mv", "tests/unrelated.test.ts", "tests/renamed.test.ts");
        expect(run(root).status).toBe(0);
        if (operation === "delete")
          expect(await Bun.file(join(root, "ran")).exists()).toBe(false);
        else
          expect(await readFile(join(root, "ran"), "utf8")).toBe(
            "test\n./tests/renamed.test.ts\n",
          );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  const readerCases: [string, string[]][] = [
    ["tests/architecture-baseline.json", ["tests/architecture.test.ts"]],
    ["tests/architecture-policy.json", ["tests/architecture.test.ts"]],
    [
      "scripts/hooks/touched-zod-changes.json",
      ["tests/touched-zod-hook.test.ts"],
    ],
    ["scripts/hooks/nested/policy.yaml", ["tests/touched-zod-hook.test.ts"]],
    ["docs/nested/guide.md", ["tests/architecture.test.ts"]],
    ["AGENTS.md", ["tests/architecture.test.ts"]],
    ["README.md", ["tests/architecture.test.ts"]],
    ["CONTRIBUTING.md", ["tests/architecture.test.ts"]],
    [
      "docs/api.md",
      ["tests/api-v1-git-status.test.ts", "tests/architecture.test.ts"],
    ],
    ["scripts/hooks/touched-zod.ts", ["tests/touched-zod-hook.test.ts"]],
    ["scripts/hooks/affected-tests.ts", ["tests/affected-tests-hook.test.ts"]],
    ["tests/architecture-graph.ts", ["tests/affected-tests-hook.test.ts"]],
    ["tests/claude-fixture.ts", ["tests/claude-backend.test.ts"]],
    ["tests/codex-fixture.ts", ["tests/codex-backend.test.ts"]],
    ["tests/notify-crash-fixture.ts", ["tests/notify-core.test.ts"]],
    ["docs/cron.md", ["tests/architecture.test.ts", "tests/profile.test.ts"]],
    [
      "docs/instances.md",
      ["tests/architecture.test.ts", "tests/profile.test.ts"],
    ],
    [
      "templates/agents/captain.md",
      [
        "tests/irc-routing.test.ts",
        "tests/profile.test.ts",
        "tests/nightly-plugin-digest.test.ts",
      ],
    ],
    [
      "templates/agents/crew.md",
      [
        "tests/irc-routing.test.ts",
        "tests/crew-instruction-rules.test.ts",
        "tests/profile.test.ts",
        "tests/nightly-plugin-digest.test.ts",
      ],
    ],
    [
      "templates/opencode.json",
      ["tests/profile.test.ts", "tests/nightly-plugin-digest.test.ts"],
    ],
    [
      "templates/ways-of-working.md",
      ["tests/profile.test.ts", "tests/nightly-plugin-digest.test.ts"],
    ],
    [
      "templates/ship-instructions.md",
      ["tests/profile.test.ts", "tests/nightly-plugin-digest.test.ts"],
    ],
    [
      "templates/skills/stargate-cronjobs/SKILL.md",
      ["tests/nightly-plugin-digest.test.ts"],
    ],
    [
      "templates/dashboard/index.html",
      [
        "tests/dashboard-branding.test.ts",
        "tests/dashboard-projection.test.ts",
        "tests/nightly-plugin-digest.test.ts",
      ],
    ],
    ["assets/icons/stargate-dark-64.png", ["tests/dashboard-branding.test.ts"]],
    ["team.example.json", ["tests/profile.test.ts"]],
    ["teams/pegasus.example.json", ["tests/profile.test.ts"]],
    [
      "cronjobs/system-maintenance/CRONJOB.md",
      ["tests/cronjob-integration.test.ts"],
    ],
  ];
  test.each(readerCases)(
    "maps %s to its actual readers",
    async (path, expected) => {
      const root = await scenario();
      try {
        await fixture(
          root,
          Object.fromEntries(
            [...new Set(readerCases.flatMap(([, tests]) => tests))].map(
              (path) => [path, "export {};\n"],
            ),
          ),
        );
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), "{}\n");
        git(root, "add", path);
        const result = run(root);
        expect(result.status).toBe(0);
        expect(await readFile(join(root, "ran"), "utf8")).toBe(
          `test\n${[...expected]
            .sort()
            .map((test) => `./${test}\n`)
            .join("")}`,
        );
        expect(result.stdout).toContain(`mapped=${expected.length}`);
        expect(result.stdout).not.toContain("Untrusted paths:");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.each(["defer", "full"])(
    "an orphan test helper is never silently trusted in %s mode",
    async (mode) => {
      const root = await scenario();
      try {
        await writeFile(
          join(root, "tests/unmapped-fixture.ts"),
          "export const helper = true;\n",
        );
        git(root, "add", "tests/unmapped-fixture.ts");
        const result = run(root, { STARGATE_UNTRUSTED_TESTS: mode });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(
          'Untrusted paths: ["tests/unmapped-fixture.ts"]',
        );
        if (mode === "defer") {
          expect(result.stdout).toContain(
            "full suite runs in hosted Quality checks",
          );
          expect(await Bun.file(join(root, "ran")).exists()).toBe(false);
        } else expect(await readFile(join(root, "ran"), "utf8")).toBe("test\n");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.each(["defer", "full"])(
    "a filename-executed script is untrusted in %s mode without a reader mapping",
    async (mode) => {
      const root = await scenario();
      try {
        await fixture(root, {
          "scripts/generate-review.ts": 'console.log("old review");\n',
          "tests/unrelated.test.ts":
            'import { spawnSync } from "node:child_process";\nspawnSync(process.execPath, ["scripts/generate-review.ts"]);\n',
        });
        await writeFile(
          join(root, "scripts/generate-review.ts"),
          'console.log("new review");\n',
        );
        git(root, "add", "scripts/generate-review.ts");
        const result = run(root, { STARGATE_UNTRUSTED_TESTS: mode });
        expect(result.status).toBe(0);
        expect(untrustedPaths(result.stdout)).toEqual(
          new Set(["scripts/generate-review.ts"]),
        );
        if (mode === "defer")
          expect(await Bun.file(join(root, "ran")).exists()).toBe(false);
        else expect(await readFile(join(root, "ran"), "utf8")).toBe("test\n");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("every added, modified, deleted or renamed path selects a reader, is a test, or has a notice", async () => {
    const root = await scenario();
    try {
      await fixture(root, {
        "src/orphan.ts": "export const unused = 0;\n",
        "src/movable.ts": "export const movable = 1;\n",
        "scripts/generate-review.ts": 'console.log("old");\n',
        "scripts/old-runner.ts": "export {};\n",
        "perf/orphan.ts": "export const sample = 0;\n",
        "tests/extra-helper.ts": "export {};\n",
        "tests/shared.ts": "export const shared = 1;\n",
        "tests/fixtures/value.json": '{"value":1}\n',
        "tests/data.test.ts": 'import "./fixtures/value.json";\n',
        "tests/shared.test.ts": 'import "./shared";\n',
        "tests/movable.test.ts": 'import "../src/movable";\n',
        "tests/script-consumer.test.ts":
          'import { spawnSync } from "node:child_process";\nspawnSync(process.execPath, ["scripts/generate-review.ts"]);\n',
        "tests/old.test.ts": "export {};\n",
        "misc/deleted.data": "old\n",
      });
      git(root, "mv", "src/movable.ts", "src/moved.ts");
      git(root, "mv", "scripts/old-runner.ts", "scripts/new-runner.ts");
      git(root, "mv", "tests/old.test.ts", "tests/renamed.test.ts");
      for (const path of [
        "src/orphan.ts",
        "tests/extra-helper.ts",
        "tests/unrelated.test.ts",
        "misc/deleted.data",
      ])
        git(root, "rm", path);
      const edits: Record<string, string> = {
        "src/leaf.ts": "export const value = 2;\n",
        "src/added-orphan.ts": "export const added = true;\n",
        "scripts/generate-review.ts": 'console.log("new");\n',
        "scripts/added.ts": "export {};\n",
        "perf/orphan.ts": "export const sample = 1;\n",
        "tests/shared.ts": "export const shared = 2;\n",
        "tests/fixtures/value.json": '{"value":2}\n',
        "tests/movable.test.ts": 'import "../src/moved";\n',
        "tests/nested/added.test.ts": "export {};\n",
        "misc/added.data": "new\n",
      };
      for (const [path, text] of Object.entries(edits)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), text);
      }
      git(root, "add", ...Object.keys(edits));
      const result = run(root);
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("computation error");
      const selected = new Set(
        (await readFile(join(root, "ran"), "utf8"))
          .trim()
          .split("\n")
          .slice(1)
          .map((path) => path.replace(/^\.\//, "")),
      );
      const noticed = untrustedPaths(result.stdout);
      // Ground truth comes from this fixture's explicit import relationships,
      // not from the selector's graph or its total selected count.
      const readers = new Map<string, string[]>([
        ["src/leaf.ts", ["tests/commonjs.test.ts", "tests/dependent.test.ts"]],
        ["src/movable.ts", ["tests/movable.test.ts"]],
        ["src/moved.ts", ["tests/movable.test.ts"]],
        ["tests/shared.ts", ["tests/shared.test.ts"]],
        ["tests/fixtures/value.json", ["tests/data.test.ts"]],
      ]);
      const changed = git(
        root,
        "diff",
        "--cached",
        "--no-renames",
        "--name-only",
        "-z",
        "HEAD",
      )
        .split("\0")
        .filter(Boolean);
      for (const path of changed) {
        const isTest = path.endsWith(".test.ts");
        const contributes =
          readers.get(path)?.some((reader) => selected.has(reader)) ?? false;
        expect({
          path,
          covered: contributes || isTest || noticed.has(path),
        }).toEqual({ path, covered: true });
        if (isTest) expect(noticed.has(path)).toBe(false);
      }
      expect(selected).toEqual(
        new Set([
          "tests/commonjs.test.ts",
          "tests/dependent.test.ts",
          "tests/data.test.ts",
          "tests/shared.test.ts",
          "tests/movable.test.ts",
          "tests/nested/added.test.ts",
          "tests/renamed.test.ts",
        ]),
      );
      expect(noticed).toEqual(
        new Set(
          changed.filter(
            (path) => !path.endsWith(".test.ts") && !readers.has(path),
          ),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["TERM", 143],
    ["INT", 130],
  ] as const)(
    "SIG%s during snapshot creation cleans its private index and exits %s",
    async (signal, status) => {
      const root = await scenario();
      let snapshot: string | undefined;
      try {
        const realGit = Bun.which("git");
        if (!realGit) throw new Error("Git unavailable");
        await writeFile(join(root, "src/leaf.ts"), "export const value = 2;\n");
        git(root, "add", "src/leaf.ts");
        await writeFile(
          join(root, "bin/git"),
          `#!/bin/sh\n${JSON.stringify(realGit)} "$@" || exit $?\nif [ "$1" = checkout-index ]; then\n  printf '%s' "$GIT_INDEX_FILE" > "$PWD/snapshot-index"\n  kill -${signal} "$PPID"\nfi\n`,
        );
        await chmod(join(root, "bin/git"), 0o755);
        const result = run(root);
        const index = await readFile(join(root, "snapshot-index"), "utf8");
        snapshot = dirname(index);
        expect(result.status).toBe(status);
        expect(existsSync(snapshot)).toBe(false);
        expect(await Bun.file(join(root, "ran")).exists()).toBe(false);
      } finally {
        if (snapshot) await rm(snapshot, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.each(["tests/fixtures/helper.ts", "tests/fixtures/data.json"])(
    "imported helper or fixture %s is graph-selectable",
    async (path) => {
      const root = await scenario();
      try {
        await fixture(root, {
          [path]: path.endsWith(".json") ? "{}\n" : "export {};\n",
          "tests/dependent.test.ts": `import "./${path.slice(6)}";\n`,
        });
        await writeFile(
          join(root, path),
          path.endsWith(".json")
            ? '{"changed":true}\n'
            : "export const changed = true;\n",
        );
        git(root, "add", path);
        const result = run(root);
        expect(result.status).toBe(0);
        expect(await readFile(join(root, "ran"), "utf8")).toBe(
          "test\n./tests/dependent.test.ts\n",
        );
        expect(result.stdout).not.toContain("Untrusted paths:");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.each(["full", "defer"])(
    "untrusted %s mode preserves selected-test results",
    async (mode) => {
      const root = await scenario();
      try {
        await writeFile(join(root, "src/leaf.ts"), "export const value = 2;\n");
        await writeFile(join(root, "package.json"), "{}\n");
        git(root, "add", "src/leaf.ts", "package.json");
        const result = run(root, {
          STARGATE_UNTRUSTED_TESTS: mode,
          RUNNER_EXIT: "7",
        });
        expect(result.status).toBe(7);
        expect(result.stdout).toContain('Untrusted paths: ["package.json"]');
        expect(result.stdout).toContain(`untrusted-mode=${mode}`);
        expect(await readFile(join(root, "ran"), "utf8")).toBe(
          mode === "full"
            ? "test\n"
            : "test\n./tests/commonjs.test.ts\n./tests/dependent.test.ts\n",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("default defer runs no tests for config-only changes and names all untrusted paths", async () => {
    const root = await scenario();
    try {
      // The real gateway imports package.json too. Global config remains
      // untrusted by policy even when an import edge happens to exist.
      await fixture(root, {
        "package.json": "{}\n",
        "src/manifest.ts":
          'import manifest from "../package.json";\nconsole.log(manifest);\n',
        "tests/unrelated.test.ts": 'import "../src/manifest";\n',
      });
      await writeFile(join(root, "package.json"), '{"changed":true}\n');
      await writeFile(join(root, "bun.lock"), "lock\n");
      git(root, "add", "package.json", "bun.lock");
      const result = run(root, { RUNNER_EXIT: "7" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("0 test files selected of 3");
      expect(result.stdout).toContain(
        'Untrusted paths: ["bun.lock","package.json"]',
      );
      expect(result.stdout).toContain(
        "full suite runs in hosted Quality checks",
      );
      expect(await Bun.file(join(root, "ran")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const mode of ["full", "defer"]) {
    test.each(["parse", "resolution", "git"])(
      `${mode}: %s errors still run the full suite`,
      async (failure) => {
        const root = await scenario();
        try {
          await writeFile(
            join(root, "src/leaf.ts"),
            failure === "parse"
              ? "export const = ;\n"
              : 'import "./missing";\n',
          );
          git(root, "add", "src/leaf.ts");
          const result = run(root, {
            STARGATE_UNTRUSTED_TESTS: mode,
            RUNNER_EXIT: "7",
            ...(failure === "git"
              ? { GIT_DIR: join(root, "missing.git") }
              : {}),
          });
          expect(result.status).toBe(7);
          expect(result.stderr).toContain(
            "computation error; running full suite",
          );
          expect(await readFile(join(root, "ran"), "utf8")).toBe("test\n");
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  }

  test("an empty index diff exits zero without starting tests", async () => {
    const root = await scenario();
    try {
      expect(run(root).status).toBe(0);
      expect(await Bun.file(join(root, "ran")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unreachable source has a notice; a new staged test selects itself", async () => {
    const root = await scenario();
    try {
      await fixture(root, { "src/isolated.ts": "export const unused = 0;\n" });
      await writeFile(
        join(root, "src/isolated.ts"),
        "export const unused = 1;\n",
      );
      git(root, "add", "src/isolated.ts");
      const isolated = run(root);
      expect(isolated.status).toBe(0);
      expect(untrustedPaths(isolated.stdout)).toEqual(
        new Set(["src/isolated.ts"]),
      );
      expect(await Bun.file(join(root, "ran")).exists()).toBe(false);
      await writeFile(join(root, "tests/new.test.ts"), "export {};\n");
      git(root, "add", "tests/new.test.ts");
      const added = run(root);
      expect(added.status).toBe(0);
      expect(untrustedPaths(added.stdout)).toEqual(
        new Set(["src/isolated.ts"]),
      );
      expect(await readFile(join(root, "ran"), "utf8")).toBe(
        "test\n./tests/new.test.ts\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
