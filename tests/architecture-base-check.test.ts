import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildGraph,
  components,
  cyclicEdges,
  importClosure,
  sourceRootFiles,
} from "./architecture-graph";

const SCRIPT = join(
  import.meta.dir,
  "../scripts/check-architecture-baseline.ts",
);

const REFRESH = join(
  import.meta.dir,
  "../scripts/refresh-architecture-baseline.ts",
);

const BASELINE = "tests/architecture-baseline.json";
const POLICY = "tests/architecture-policy.json";
const DECLARATION = "tests/architecture-change.json";
const PRIVATE_KEY = "private:src/a/index.ts -> src/b/private.ts";
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function git(root: string, ...args: string[]) {
  const result = spawnSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr);
  }

  return result.stdout.trim();
}

function commit(root: string, message: string) {
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", message);

  return git(root, "rev-parse", "HEAD");
}

async function files(root: string, contents: Record<string, string>) {
  for (const [name, text] of Object.entries(contents)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), text);
  }
}

async function json(root: string, path: string, value: unknown) {
  await files(root, { [path]: JSON.stringify(value, null, 2) + "\n" });
}

async function editJson<T>(
  root: string,
  path: string,
  edit: (value: T) => void,
) {
  const value = JSON.parse(await readFile(join(root, path), "utf8")) as T;
  edit(value);
  await json(root, path, value);
}

async function baselineHash(root: string, revision: string) {
  const shown = spawnSync("git", ["show", `${revision}:${BASELINE}`], {
    cwd: root,
    timeout: 30_000,
  });

  if (shown.status !== 0) {
    throw new Error(String(shown.stderr));
  }

  return createHash("sha256").update(shown.stdout).digest("hex");
}

type Policy = { slices: Record<string, { files: string[]; public: string[] }> };

/** One commit on branch main. The index imports b/private: one exception. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "stargate-base-check-"));
  temporary.push(root);
  await files(root, {
    "src/main.ts": 'import "./a/index";\n',
    "src/a/index.ts": 'import "./leaf";\nimport "../b/private";\n',
    "src/a/leaf.ts": "export {};\n",
    "src/b/private.ts": "export {};\n",
    "AGENTS.md": "# Fixture\n",
    "README.md": "# Fixture\n",
    "CONTRIBUTING.md": "# Fixture\n",
    "docs/design.md": "# Fixture\n",
    ".gitignore": "node_modules/\n",
  });
  await json(root, POLICY, {
    slices: {
      a: {
        layer: "slices",
        files: ["src/main.ts", "src/a/index.ts", "src/a/leaf.ts"],
        public: ["src/a/index.ts"],
        neighbours: ["b"],
      },
      b: {
        layer: "slices",
        files: ["src/b/private.ts"],
        public: [],
        neighbours: ["a"],
      },
    },
  });
  const graph = await buildGraph(root);

  const baseline = {
    sourceCommit: "1111111111111111111111111111111111111111",
    sourceFiles: graph.size,
    sourceEdges: [...graph.values()].reduce(
      (sum, edges) => sum + edges.size,
      0,
    ),
    rootFiles: await sourceRootFiles(root),
    largestCycle: 0,
    cycleComponents: components(graph).filter((group) => group.length > 1),
    cyclicEdges: cyclicEdges(graph),
    crewPlugin: {
      entry: "src/main.ts",
      members: importClosure(graph, "src/main.ts"),
    },
    exceptions: [PRIVATE_KEY],
    largeFiles: [] as string[],
  };

  await json(root, BASELINE, baseline);
  await json(root, DECLARATION, {});
  await mkdir(join(root, "node_modules/.bin"), { recursive: true });
  await symlink(
    await realpath(join(import.meta.dir, "../node_modules/.bin/oxfmt")),
    join(root, "node_modules/.bin/oxfmt"),
  );

  // Use the refresh tool's own layout, so two writers merge as they do on main.
  const format = spawnSync(
    join(root, "node_modules/.bin/oxfmt"),
    ["--write", BASELINE],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );

  if (format.status !== 0) {
    throw new Error(format.stderr);
  }

  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Baseline Check Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  const base = commit(root, "fixture");

  // Tests that check a working tree need a parent: an empty child commit.
  return { root, base, baseline, head: commit(root, "start") };
}

function run(
  root: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  // The tree under test is a commit: fold working-tree edits into HEAD.
  // HEAD^1 then stays the parent that the check compares with.
  if (git(root, "status", "--porcelain")) {
    git(root, "add", "-A");
    git(root, "commit", "-q", "--amend", "--allow-empty", "--no-edit");
  }

  return spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, GITHUB_STEP_SUMMARY: "", ...env },
  });
}

/** Checks the working tree as it is, without folding it into HEAD. */
function runRaw(root: string, args: string[] = []) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
  });
}

function refresh(root: string, base: string, args: string[]) {
  const result = spawnSync(
    process.execPath,
    [REFRESH, "--root", root, "--base", base, "--write", ...args],
    { cwd: root, encoding: "utf8", timeout: 60_000 },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
}

/** A reviewed extraction: new leaf joins the closure, declared by name. */
async function closureChange(root: string) {
  const parent = git(root, "rev-parse", "HEAD");
  await files(root, {
    "src/main.ts": 'import "./a/index";\nimport "./a/new";\n',
    "src/a/new.ts": "export {};\n",
  });
  await editJson<Policy>(root, POLICY, (policy) =>
    policy.slices["a"]?.files.push("src/a/new.ts"),
  );
  refresh(root, parent, ["--allow-closure-addition", "src/a/new.ts"]);
  await json(root, DECLARATION, {
    baselineSha256: await baselineHash(root, parent),
    closureAdditions: ["src/a/new.ts"],
  });
}

/** Another baseline writer: b/private becomes public; one exception goes. */
async function exceptionLowering(root: string) {
  const parent = git(root, "rev-parse", "HEAD");
  await editJson<Policy>(root, POLICY, (policy) => {
    const slice = policy.slices["b"];

    if (slice) {
      slice.public = ["src/b/private.ts"];
    }
  });
  refresh(root, parent, ["--prune-stale"]);
}

/** GitHub's refs/pull/N/merge: first parent target, second parent PR head. */
function mergeRef(root: string, target: string, prHead: string) {
  git(root, "switch", "-q", "--detach", target);
  git(root, "merge", "-q", "--no-ff", "--no-edit", prHead);

  return git(root, "rev-parse", "HEAD");
}

/** A squash merge of the PR onto the target, as auto-merge pushes it. */
function squash(root: string, target: string, prHead: string) {
  git(root, "switch", "-q", "--detach", target);
  git(root, "merge", "-q", "--squash", prHead);

  return commit(root, "squash");
}

describe("architecture baseline check against the first parent", () => {
  test("rejects a new real import hidden by a hand-appended permission", async () => {
    const { root, baseline } = await fixture();
    await files(root, { "src/a/leaf.ts": 'import "../b/private";\n' });
    baseline.exceptions.push("private:src/a/leaf.ts -> src/b/private.ts");
    await json(root, BASELINE, baseline);
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unauthorized-exception");
  });

  test("accepts a baseline lowered by the tool without writing during the check", async () => {
    const { root, head } = await fixture();
    await files(root, { "src/a/index.ts": 'import "./leaf";\n' });
    refresh(root, head, ["--prune-stale"]);
    const before = await readFile(join(root, BASELINE), "utf8");
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("policy changed");
    expect(await readFile(join(root, BASELINE), "utf8")).toBe(before);
  });

  test("rejects a hand-raised size list", async () => {
    const { root, baseline } = await fixture();
    await files(root, { "src/a/leaf.ts": "// size\n".repeat(1001) });
    baseline.largeFiles.push("src/a/leaf.ts");
    await json(root, BASELINE, baseline);
    expect(run(root).stderr).toContain("unauthorized-large-file");
  });

  test("baseline data cannot disable comparison of measured inventory", async () => {
    const { root, baseline } = await fixture();
    await json(root, BASELINE, { ...baseline, sourceEdges: 999, skip: true });
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("baseline-diff:sourceEdges");
  });

  test("rejects unknown declaration fields instead of forwarding raw arguments", async () => {
    const { root } = await fixture();
    await json(root, DECLARATION, { skip: true });
    expect(run(root).stderr).toContain("declaration:invalid");
  });

  test("rejects a duplicate declaration key instead of keeping the last value", async () => {
    const { root, head } = await fixture();
    await closureChange(root);
    const hash = await baselineHash(root, head);
    await files(root, {
      [DECLARATION]: `{"closureAdditions": [], "baselineSha256": "${hash}", "closureAdditions": ["src/a/new.ts"]}\n`,
    });
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'declaration:duplicate-key: "closureAdditions"',
    );
    await files(root, {
      [DECLARATION]: `{"rekeyExceptions": [{"oldKey": "x", "newKey": "y", "oldKey": "z"}]}\n`,
    });
    expect(run(root).stderr).toContain('declaration:duplicate-key: "oldKey"');
  });

  test("a named closure addition needs a declaration bound to the parent baseline", async () => {
    const { root } = await fixture();
    await closureChange(root);
    await json(root, DECLARATION, {});
    expect(run(root).stderr).toContain("closure-addition:unnamed");
    await json(root, DECLARATION, { closureAdditions: ["src/a/new.ts"] });
    expect(run(root).stderr).toContain("declaration:missing-baseline-sha256");
    await json(root, DECLARATION, {
      baselineSha256: "0".repeat(64),
      closureAdditions: ["src/a/new.ts"],
    });
    expect(run(root).stderr).toContain("declaration:stale-baseline");
  });

  test("prints every active allowance as a notice and in the step summary", async () => {
    const oldKey = PRIVATE_KEY;
    const newKey = "private:src/a/new.ts -> src/b/private.ts";
    const { root, head } = await fixture();
    await files(root, {
      "src/a/index.ts": 'import "./leaf";\nimport "./new";\n',
      "src/a/new.ts": 'import "../b/private";\n',
    });
    await editJson<Policy>(root, POLICY, (policy) =>
      policy.slices["a"]?.files.push("src/a/new.ts"),
    );
    refresh(root, head, [
      "--allow-closure-addition",
      "src/a/new.ts",
      "--rekey-exception",
      oldKey,
      newKey,
    ]);
    expect(run(root).stderr).toContain("unauthorized-exception");
    await json(root, DECLARATION, {
      baselineSha256: await baselineHash(root, head),
      pruneStale: true,
      closureAdditions: ["src/a/new.ts"],
      rekeyExceptions: [{ oldKey, newKey }],
    });
    const outside = await mkdtemp(join(tmpdir(), "stargate-summary-"));
    temporary.push(outside);
    const summary = join(outside, "summary.md");
    const result = run(root, [], { GITHUB_STEP_SUMMARY: summary });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "::notice title=Architecture allowance: closure addition::src/a/new.ts.",
    );
    expect(result.stdout).toContain(
      `::notice title=Architecture allowance: exception rekey::${oldKey} => ${newKey}.`,
    );
    expect(result.stdout).toContain(
      "::notice title=Architecture allowance: prune stale::",
    );
    expect(result.stdout).toContain("3 allowances");
    const text = await readFile(summary, "utf8");
    expect(text).toContain("**closure addition**: `src/a/new.ts.");
    expect(text).toContain(`**exception rekey**: \`${oldKey} => ${newKey}.`);
    // A rekey declared again on the next change names an absent old key.
    const next = commit(root, "rekey extraction");
    commit(root, "next change");
    await json(root, DECLARATION, {
      baselineSha256: await baselineHash(root, next),
      rekeyExceptions: [{ oldKey, newKey }],
    });
    expect(run(root).stderr).toContain("rekey:unknown-old");
  });

  test("after merge the inherited declaration is inactive; the next change may keep or overwrite it", async () => {
    const { root } = await fixture();
    await closureChange(root);
    const merged = commit(root, "declared extraction");
    // Keep: no edit at all.
    const keep = commit(root, "unrelated");
    expect(run(root).status).toBe(0);
    expect(run(root).stdout).toContain("no active declaration");
    // Overwrite with the empty form.
    await json(root, DECLARATION, {});
    expect(run(root).status).toBe(0);

    // Restoring the inherited bytes is no change: still inactive.
    const old = {
      baselineSha256: await baselineHash(root, merged + "^"),
      closureAdditions: ["src/a/new.ts"],
    };

    await json(root, DECLARATION, old);
    expect(run(root).stdout).toContain("no active declaration");
    // Re-using the old allowances: the old hash is refused.
    // With a fresh hash, the tool refuses a file that is already a member.
    await files(root, { [DECLARATION]: JSON.stringify(old) + "\n" });
    expect(run(root).stderr).toContain("declaration:stale-baseline");
    await json(root, DECLARATION, {
      baselineSha256: await baselineHash(root, keep),
      closureAdditions: ["src/a/new.ts"],
    });
    expect(run(root).stderr).toContain("closure-addition:not-added");
  });

  test("D1a: a declared PR behind main by unrelated commits passes as merge ref and as squash", async () => {
    const { root, head: fork } = await fixture();
    git(root, "switch", "-q", "-c", "pr");
    await closureChange(root);
    const prHead = commit(root, "declared extraction");
    git(root, "switch", "-q", "main");
    await files(root, { "README.md": "# Unrelated\n" });
    const main = commit(root, "unrelated");
    expect(git(root, "merge-base", main, prHead)).toBe(fork);
    mergeRef(root, main, prHead);
    const pr = run(root, ["--pr-head", prHead]);
    expect(pr.status, pr.stderr).toBe(0);
    expect(pr.stdout).toContain(`against parent ${main} (active declaration`);
    squash(root, main, prHead);
    const push = run(root, ["--push-before", main]);
    expect(push.status, push.stderr).toBe(0);
    expect(push.stdout).toContain("1 allowances");
  });

  test("D1b: a declared PR behind another baseline writer must regenerate on current main", async () => {
    const { root } = await fixture();
    git(root, "switch", "-q", "-c", "pr");
    await closureChange(root);
    const prHead = commit(root, "declared extraction");
    git(root, "switch", "-q", "main");
    await exceptionLowering(root);
    const main = commit(root, "other baseline writer");
    expect(run(root).status).toBe(0);
    mergeRef(root, main, prHead);
    const pr = run(root, ["--pr-head", prHead]);
    expect(pr.status).not.toBe(0);
    expect(pr.stderr).toContain("declaration:stale-baseline");
    expect(pr.stderr).toContain("regenerate on current main");
    // R1: auto-merge on Y's earlier green run.
    // The push run re-validates the allowances against the parent and warns.
    squash(root, main, prHead);
    const push = run(root, ["--push-before", main]);
    expect(push.status, push.stderr).toBe(0);
    expect(push.stdout).toContain(
      "::warning title=Architecture declaration re-validated::declaration was bound to an older baseline; allowances re-validated against the parent",
    );
    expect(push.stdout).toContain(
      "::notice title=Architecture allowance: closure addition::src/a/new.ts.",
    );
  });

  test("R1: a left-over or invalid declaration never passes a PR, and fails a push unless it validates", async () => {
    const { root } = await fixture();
    await closureChange(root);
    commit(root, "declared extraction");
    const declared = await readFile(join(root, DECLARATION), "utf8");
    // Another change drops the file from the closure again.
    await files(root, { "src/main.ts": 'import "./a/index";\n' });
    refresh(root, git(root, "rev-parse", "HEAD"), []);
    const main = commit(root, "closure removal");
    // A later PR re-adds the file and leaves the inherited declaration.
    git(root, "switch", "-q", "-c", "readd");
    await files(root, {
      "src/main.ts": 'import "./a/index";\nimport "./a/new";\n',
    });
    refresh(root, main, ["--allow-closure-addition", "src/a/new.ts"]);
    const kept = commit(root, "re-add, declaration inherited");
    mergeRef(root, main, kept);
    expect(run(root, ["--pr-head", kept]).stderr).toContain(
      "closure-addition:unnamed",
    );
    squash(root, main, kept);
    expect(run(root, ["--push-before", main]).stderr).toContain(
      "closure-addition:unnamed",
    );
    // The same PR re-serialises the old declaration: refused on the PR.
    git(root, "switch", "-q", "readd");
    await files(root, {
      [DECLARATION]: JSON.stringify(JSON.parse(declared)) + "\n",
    });
    const reused = commit(root, "re-add, old declaration re-serialised");
    mergeRef(root, main, reused);
    const pr = run(root, ["--pr-head", reused]);
    expect(pr.status).not.toBe(0);
    expect(pr.stderr).toContain("declaration:stale-baseline");
    // An admin merge of a red PR whose allowances do not validate fails.
    git(root, "switch", "-q", "--detach", main);
    await files(root, {
      "README.md": "# Admin merge\n",
      [DECLARATION]:
        JSON.stringify({
          ...(JSON.parse(declared) as object),
          closureAdditions: ["src/a/leaf.ts"],
        }) + "\n",
    });
    const admin = commit(root, "admin merge of a red PR");
    expect(git(root, "rev-parse", "HEAD")).toBe(admin);
    const push = run(root, ["--push-before", main]);
    expect(push.status).not.toBe(0);
    expect(push.stderr).toContain("declaration:stale-baseline");
    expect(push.stderr).toContain("closure-addition:not-added");
  });

  test("R2: a policy change is announced with its changed line count", async () => {
    const { root, head } = await fixture();
    await files(root, {
      "src/a/leaf.ts": 'import "../b/private";\n',
    });
    await editJson<Policy>(root, POLICY, (policy) => {
      const slice = policy.slices["b"];

      if (slice) {
        slice.public = ["src/b/private.ts"];
      }
    });
    refresh(root, head, ["--prune-stale"]);
    const outside = await mkdtemp(join(tmpdir(), "stargate-summary-"));
    temporary.push(outside);
    const summary = join(outside, "summary.md");
    const result = run(root, [], { GITHUB_STEP_SUMMARY: summary });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "::notice title=Architecture policy changed::policy changed in this commit: the reader checks every changed line (3 added, 1 removed)",
    );
    expect(result.stdout).toContain("0 allowances");
    expect(await readFile(summary, "utf8")).toContain(
      "**policy changed in this commit**: the reader checks every changed line (3 added, 1 removed)",
    );
  });

  test("the prune notice names the entries removed against the parent", async () => {
    const { root, head } = await fixture();
    await exceptionLowering(root);
    await json(root, DECLARATION, {
      baselineSha256: await baselineHash(root, head),
      pruneStale: true,
    });
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      `::notice title=Architecture allowance: prune stale::removed against the parent: exceptions: ${PRIVATE_KEY}; size entries: none.`,
    );
  });

  test("R3: names a declaration path that is not a small regular file", async () => {
    const { root, head } = await fixture();
    const target = join(root, "declaration-elsewhere.json");
    await json(root, "declaration-elsewhere.json", {
      baselineSha256: await baselineHash(root, head),
      pruneStale: true,
    });
    await unlink(join(root, DECLARATION));
    await symlink(target, join(root, DECLARATION));
    expect(runRaw(root).stderr).toContain("declaration:symlink");
    await unlink(join(root, DECLARATION));
    await mkdir(join(root, DECLARATION));
    expect(runRaw(root).stderr).toContain("declaration:not-regular-file");
    await rm(join(root, DECLARATION), { recursive: true });
    expect(
      spawnSync("mkfifo", [join(root, DECLARATION)], { timeout: 10_000 })
        .status,
    ).toBe(0);
    expect(runRaw(root).stderr).toContain("declaration:not-regular-file");
    await unlink(join(root, DECLARATION));
    await files(root, {
      [DECLARATION]: JSON.stringify({
        closureAdditions: Array.from(
          { length: 5000 },
          (_, i) => `src/x${i}.ts`,
        ),
      }),
    });
    expect(runRaw(root).stderr).toContain("declaration:too-large");
  });

  test("D2: the workflow checks a plain PR opened before an allowance PR merged", async () => {
    const { root } = await fixture();
    git(root, "switch", "-q", "-c", "plain");
    await files(root, { "README.md": "# Plain documentation change\n" });
    const prHead = commit(root, "plain");
    git(root, "switch", "-q", "main");
    await closureChange(root);
    const main = commit(root, "allowance PR squash");

    const workflow = await readFile(
      join(import.meta.dir, "../.github/workflows/check.yml"),
      "utf8",
    );

    const block =
      / {6}- name: Compare architecture baseline with its Git parent[\s\S]*? {8}run: \|\n((?: {10}.*\n)+)/.exec(
        workflow,
      )?.[1];

    if (!block) {
      throw new Error("Missing hosted comparison step");
    }

    const shell =
      `mise() { shift 3; "$BUN_EXEC" "$@"; }\n` +
      block
        .replace(/^ {10}/gm, "")
        .replace("bun scripts/", `bun ${dirname(SCRIPT)}/`);

    const hosted = (event: string, values: Record<string, string>) =>
      spawnSync("bash", ["--noprofile", "--norc", "-c", shell], {
        cwd: root,
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: "",
          EVENT_NAME: event,
          PR_HEAD_SHA: "",
          PUSH_BEFORE_SHA: "",
          BUN_EXEC: process.execPath,
          ...values,
        },
      });

    mergeRef(root, main, prHead);
    const pr = hosted("pull_request", { PR_HEAD_SHA: prHead });
    expect(pr.status, pr.stderr).toBe(0);
    expect(pr.stdout).toContain(
      `against parent ${main} (no active declaration`,
    );
    squash(root, main, prHead);
    const push = hosted("push", { PUSH_BEFORE_SHA: main });
    expect(push.status, push.stderr).toBe(0);
    expect(hosted("workflow_dispatch", {}).stdout).toContain(
      "unsupported event",
    );
  });

  test("names every unusable event input", async () => {
    const { root, base, head } = await fixture();

    for (const before of ["", "0".repeat(40)]) {
      expect(run(root, ["--push-before", before]).stderr).toContain(
        "event:push-before-missing",
      );
    }

    await files(root, { "README.md": "# Second commit\n" });
    commit(root, "second");
    expect(run(root, ["--push-before", base]).stderr).toContain(
      "event:push-not-single-commit",
    );
    expect(run(root, ["--pr-head", head]).stderr).toContain(
      "event:not-merge-ref",
    );
    git(root, "switch", "-q", "--orphan", "root");
    commit(root, "root commit");
    expect(run(root).stderr).toContain("event:no-parent");
  });
});
