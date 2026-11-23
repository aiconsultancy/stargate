import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Invariant: every changed path either selects at least one test file,
// Is itself a test file, or is named in the untrusted notice.
// Explicit opt-in to the old local full-suite fallback; CI remains the full gate.
const UNTRUSTED_MODE = process.env["STARGATE_UNTRUSTED_TESTS"] ?? "defer";
const testFile = /\.test\.ts$/;

// Files read at runtime have no import edge. Keep their readers in this table.
const readers = [
  {
    path: /^scripts\/test-compare(?:-report)?\.ts$/,
    tests: /^tests\/test-compare\.test\.ts$/,
  },
  {
    path: /^tests\/architecture-(baseline|policy)\.json$/,
    tests: /^tests\/architecture\.test\.ts$/,
  },
  {
    path: /^scripts\/hooks\/(?!.*\.(?:[cm]?[jt]s|[jt]sx|sh)$).+$/,
    tests: /^tests\/touched-zod-.*\.test\.ts$/,
  },
  {
    path: /^(docs\/.*\.md|AGENTS\.md|README\.md|CONTRIBUTING\.md)$/,
    tests: /^tests\/architecture\.test\.ts$/,
  },
  {
    path: /^docs\/api\.md$/,
    tests: /^tests\/api-v1-git-status\.test\.ts$/,
  },
  {
    path: /^scripts\/hooks\/touched-zod\.(ts|sh)$/,
    tests: /^tests\/touched-zod-.*\.test\.ts$/,
  },
  {
    path: /^scripts\/hooks\/affected-tests\.ts$/,
    tests: /^tests\/affected-tests-hook\.test\.ts$/,
  },
  {
    path: /^tests\/architecture-graph\.ts$/,
    tests: /^tests\/affected-tests-hook\.test\.ts$/,
  },
  {
    path: /^tests\/claude-fixture\.ts$/,
    tests: /^tests\/claude-backend\.test\.ts$/,
  },
  {
    path: /^tests\/codex-fixture\.ts$/,
    tests: /^tests\/codex-backend\.test\.ts$/,
  },
  {
    path: /^tests\/notify-crash-fixture\.ts$/,
    tests: /^tests\/notify-core\.test\.ts$/,
  },
  {
    path: /^docs\/(cron|instances)\.md$/,
    tests: /^tests\/profile\.test\.ts$/,
  },
  {
    path: /^templates\/agents\/(captain|crew)\.md$/,
    tests: /^tests\/(irc-routing|profile)\.test\.ts$/,
  },
  {
    path: /^templates\/agents\/crew\.md$/,
    tests: /^tests\/crew-instruction-rules\.test\.ts$/,
  },
  {
    path: /^templates\/(opencode\.json|ways-of-working\.md|ship-instructions\.md)$/,
    tests: /^tests\/profile\.test\.ts$/,
  },
  {
    path: /^templates\//,
    tests: /^tests\/nightly-plugin-digest\.test\.ts$/,
  },
  {
    path: /^templates\/dashboard\/index\.html$/,
    tests: /^tests\/dashboard-(branding|projection)\.test\.ts$/,
  },
  {
    path: /^assets\/icons\//,
    tests: /^tests\/dashboard-branding\.test\.ts$/,
  },
  {
    path: /^(team\.example\.json|teams\/[^/]+\.example\.json)$/,
    tests: /^tests\/profile\.test\.ts$/,
  },
  {
    path: /^cronjobs\/system-maintenance\/CRONJOB\.md$/,
    tests: /^tests\/cronjob-integration\.test\.ts$/,
  },
];

function git(args: string[], env = process.env): string {
  const result = spawnSync("git", args, {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });

  if (result.status !== 0) throw new Error("Git comparison failed");

  return result.stdout;
}

async function snapshot(root: string, env: NodeJS.ProcessEnv) {
  await mkdir(root);
  git(["checkout-index", "--all", `--prefix=${root}/`], env);

  for (const directory of ["src", "tests", "scripts", "perf"])
    await mkdir(join(root, directory), { recursive: true });
  const modules = join(process.cwd(), "node_modules");

  if (await Bun.file(join(modules, "typescript/package.json")).exists())
    await symlink(modules, join(root, "node_modules"));
}

async function affected(existing: Set<string>) {
  const fields = git([
    "diff",
    "--cached",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--name-status",
    "-z",
    "HEAD",
  ]).split("\0");

  const changes: { status: string; path: string }[] = [];

  for (let index = 0; index < fields.length - 1; index += 2) {
    const status = fields[index];
    const path = fields[index + 1];

    if (!path || !status || !["A", "M", "D", "T"].includes(status))
      throw new Error("Unsupported index comparison");
    changes.push({ status, path });
  }

  const selected = new Set<string>();
  const graphTests = new Set<string>();
  const mappedTests = new Set<string>();
  const untrusted: string[] = [];

  if (changes.length === 0)
    return { selected, graphTests, mappedTests, untrusted };

  const root = mkdtempSync(join(tmpdir(), "stargate-affected-"));
  let terminationStatus: number | undefined;

  const terminate = (status: number) => {
    // Let in-flight filesystem operations and Git children settle before rm.
    terminationStatus ??= status;
  };

  const term = () => terminate(143);
  const interrupt = () => terminate(130);

  process.on("SIGTERM", term);
  process.on("SIGINT", interrupt);

  try {
    // Both snapshots use the hook's Git namespace. Only HEAD gets a private
    // Index; never clear the original Git environment before reading the index.
    const headEnv = {
      ...process.env,
      GIT_INDEX_FILE: join(root, "head-index"),
    };

    git(["read-tree", "HEAD"], headEnv);
    await snapshot(join(root, "head"), headEnv);

    if (terminationStatus !== undefined)
      return { selected, graphTests, mappedTests, untrusted };
    await snapshot(join(root, "index"), process.env);

    if (terminationStatus !== undefined)
      return { selected, graphTests, mappedTests, untrusted };

    const { buildGraph, importClosure } =
      await import("../../tests/architecture-graph");

    const directories = ["src", "tests", "scripts", "perf"];
    const before = await buildGraph(join(root, "head"), directories);

    const deleted = new Set(
      changes
        .values()
        .filter(({ status }) => status === "D")
        .map(({ path }) => path),
    );

    const after = await buildGraph(join(root, "index"), directories, deleted);

    for (const test of existing)
      if (!after.has(test)) throw new Error("Test outside the scanned graph");

    const closures = [...existing].map((test) => ({
      test,
      before: importClosure(before, test),
      after: importClosure(after, test),
    }));

    for (const { status, path } of changes) {
      const isTest = testFile.test(path);
      const mappings = readers.filter((reader) => reader.path.test(path));

      const mapped = [...existing].filter((test) =>
        mappings.some((reader) => reader.tests.test(test)),
      );

      // Global package/tool/workflow inputs remain untrusted even if imported.
      const graphAllowed =
        status !== "T" && /^(src|tests|scripts|perf)\//.test(path);

      const reached = graphAllowed
        ? closures.filter(({ before, after }) => {
            // Architecture readers inspect all source paths without importing them.
            const scanner = "tests/architecture-graph.ts";

            return (
              (status !== "A" && before.includes(path)) ||
              (status !== "D" && after.includes(path)) ||
              (path.startsWith("src/") &&
                (before.includes(scanner) || after.includes(scanner)))
            );
          })
        : [];

      // Attribute coverage per path. Another changed file selecting tests must
      // Not hide an orphan script, module, helper, or data file in the same commit.
      if (
        !isTest &&
        (status === "T" || (reached.length === 0 && mapped.length === 0))
      )
        untrusted.push(path);

      for (const { test } of reached) graphTests.add(test);

      for (const test of mapped) mappedTests.add(test);

      if (isTest && status !== "D") {
        graphTests.add(path);
      }
    }

    for (const test of [...graphTests, ...mappedTests]) selected.add(test);

    return {
      selected,
      graphTests,
      mappedTests,
      untrusted: untrusted.toSorted(),
    };
  } finally {
    try {
      await rm(root, { recursive: true, force: true });
    } finally {
      process.off("SIGTERM", term);
      process.off("SIGINT", interrupt);

      if (terminationStatus !== undefined) process.exit(terminationStatus);
    }
  }
}

let env: NodeJS.ProcessEnv = { ...process.env };
let tests: string[] | undefined;
let total: number | undefined;

try {
  const local = new Set(
    git(["rev-parse", "--local-env-vars"])
      .split(/\s+/)
      .filter((name) => name),
  );

  env = Object.fromEntries(
    Object.entries(env).filter(([name]) => !local.has(name)),
  );

  const existing = new Set(
    git(["ls-files", "--cached", "-z"])
      .split("\0")
      .filter((path) => testFile.test(path)),
  );

  total = existing.size;

  if (!["full", "defer"].includes(UNTRUSTED_MODE))
    throw new Error("Invalid STARGATE_UNTRUSTED_TESTS mode");
  const result = await affected(existing);
  const full = result.untrusted.length > 0 && UNTRUSTED_MODE === "full";
  tests = full ? undefined : [...result.selected].toSorted();
  console.log(
    `affected-tests: ${full ? total : tests?.length} test files selected of ${total} ` +
      `(graph=${result.graphTests.size}, mapped=${result.mappedTests.size}, untrusted-mode=${UNTRUSTED_MODE})`,
  );

  if (result.untrusted.length > 0)
    console.log(
      `Untrusted paths: ${JSON.stringify(result.untrusted)}. ` +
        (full
          ? "Running the full suite locally."
          : "Running selected tests only; the full suite runs in hosted Quality checks."),
    );
} catch {
  env = Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith("GIT_")),
  );
  console.error(
    `affected-tests: ${total ?? "all"} test files selected of ${total ?? "unknown"} ` +
      "(computation error; running full suite)",
  );
}

// Apply the bound only to a successfully computed selected set. Explicit
// Untrusted full runs and computation-error full fallbacks remain unchanged.
const limitText = process.env["STARGATE_AFFECTED_TEST_LIMIT"] ?? "20";
const limit = Number(limitText);
const force = process.env["STARGATE_FORCE_AFFECTED_TESTS"] ?? "0";

if (
  !/^(0|[1-9]\d*)$/.test(limitText) ||
  !Number.isSafeInteger(limit) ||
  !["0", "1"].includes(force)
) {
  console.error(
    "affected-tests: STARGATE_AFFECTED_TEST_LIMIT must be a nonnegative safe integer; STARGATE_FORCE_AFFECTED_TESTS must be 0 or 1",
  );
  process.exitCode = 1;
} else if (tests && tests.length > limit && force !== "1") {
  console.log(
    `affected-tests: ${tests.length} selected files exceed the local limit ${limit}; deferring these tests:\n` +
      tests.map((path) => `  ${path}`).join("\n"),
  );
  console.log(
    "affected-tests: typecheck and lint remain required; hosted Quality checks runs the full suite. Set STARGATE_FORCE_AFFECTED_TESTS=1 to run this selection locally.",
  );
} else if (tests?.length === 0) {
  console.log(
    "affected-tests: no selected tests; full suite runs in hosted Quality checks",
  );
} else {
  const result = spawnSync(
    "bun",
    ["test", ...(tests?.map((path) => `./${path}`) ?? [])],
    {
      env,
      stdio: "inherit",
    },
  );

  process.exitCode = result.status ?? 1;
}
