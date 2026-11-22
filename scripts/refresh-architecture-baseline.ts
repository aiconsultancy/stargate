import { randomUUID } from "node:crypto";
import {
  open,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  architectureDocuments,
  boundaryViolations,
  buildGraph,
  components,
  cyclicEdges,
  documentationViolations,
  importClosure,
  normalizeGraph,
  sizeRegressions,
  sourceIdentities,
  sourceRootFiles,
  type ArchitecturePolicy,
} from "../tests/architecture-graph";

interface Inventory {
  sourceCommit: string;
  measurementStatus?: string;
  sourceFiles: number;
  sourceEdges: number;
  rootFiles: string[];
  largestCycle: number;
  cycleComponents: string[][];
  cyclicEdges: string[];
  crewPlugin: { entry: string; members: string[] };
  exceptions: string[];
  largeFiles: string[];
}

const argv = process.argv.slice(2);
const flags = new Set<string>();
const values = new Map<string, string>();
const allowedClosureFiles: string[] = [];
const exceptionRekeys: { oldKey: string; newKey: string }[] = [];

for (let index = 0; index < argv.length; index++) {
  const argument = argv[index];

  if (!argument) throw new Error("Missing argument");

  if (argument === "--allow-closure-addition") {
    const file = argv[++index];

    if (!file || file.startsWith("--"))
      throw new Error(`Invalid option: ${argument}`);

    if (allowedClosureFiles.includes(file))
      throw new Error(`duplicate-closure-addition:${file}`);
    allowedClosureFiles.push(file);
  } else if (argument === "--rekey-exception") {
    const oldKey = argv[++index],
      newKey = argv[++index];

    if (
      !oldKey ||
      !newKey ||
      oldKey.startsWith("--") ||
      newKey.startsWith("--")
    )
      throw new Error("rekey:missing-keys");

    if (exceptionRekeys.some((entry) => entry.oldKey === oldKey))
      throw new Error(`rekey:duplicate-old:${oldKey}`);

    if (exceptionRekeys.some((entry) => entry.newKey === newKey))
      throw new Error(`rekey:duplicate-new:${newKey}`);
    exceptionRekeys.push({ oldKey, newKey });
  } else if (argument === "--write" || argument === "--prune-stale") {
    if (flags.has(argument)) throw new Error(`Duplicate option: ${argument}`);
    flags.add(argument);
  } else if (["--root", "--base", "--output"].includes(argument)) {
    const value = argv[++index];

    if (!value || value.startsWith("--") || values.has(argument))
      throw new Error(`Invalid option: ${argument}`);
    values.set(argument, value);
  } else throw new Error(`Unknown option: ${argument}`);
}

const rootArg = values.get("--root");
const baseArg = values.get("--base");

if (!rootArg || !baseArg || !/^[a-f0-9]{40}$/.test(baseArg)) {
  throw new Error(
    "Usage: bun scripts/refresh-architecture-baseline.ts --root PATH --base COMMIT [--output PATH] [--write] [--prune-stale] [--allow-closure-addition FILE ...] [--rekey-exception OLD_KEY NEW_KEY ...]\n--prune-stale removes stale exception and large-file entries.",
  );
}

const root = await realpath(resolve(rootArg));
const base = baseArg;
const output = values.get("--output");

if (output) {
  const target = resolve(output);

  const physical = await realpath(target).catch(async (error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;

    return join(await realpath(dirname(target)), basename(target));
  });

  const destination = relative(root, physical);

  if (
    destination !== ".." &&
    !destination.startsWith(`..${sep}`) &&
    !isAbsolute(destination)
  ) {
    throw new Error("Receipt output must be outside the source clone");
  }
}

async function gitWithEnvironment(
  env: NodeJS.ProcessEnv,
  ...args: string[]
): Promise<string> {
  const result = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
  });

  const [stdout, stderr, exit] = await Promise.all([
    new Response(result.stdout).text(),
    new Response(result.stderr).text(),
    result.exited,
  ]);

  if (exit !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);

  return stdout;
}

const git = (...args: string[]) => gitWithEnvironment(process.env, ...args);

async function rekeyBase() {
  const directory = await mkdtemp(join(tmpdir(), "stargate-rekey-base-"));

  try {
    const tree = join(directory, "tree");
    await mkdir(tree);
    const env = { ...process.env, GIT_INDEX_FILE: join(directory, "index") };
    await gitWithEnvironment(env, "read-tree", base);
    await gitWithEnvironment(
      env,
      "checkout-index",
      "--all",
      `--prefix=${tree}/`,
    );

    const basePolicy = JSON.parse(
      await readFile(join(tree, "tests/architecture-policy.json"), "utf8"),
    ) as ArchitecturePolicy;

    const source = await buildGraph(tree);
    const graph = normalizeGraph(source, basePolicy);

    const violations = [
      ...boundaryViolations(graph, basePolicy),
      ...(await documentationViolations(
        tree,
        await architectureDocuments(tree),
      )),
    ];

    return { graph, files: new Set(source.keys()), violations };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await git("merge-base", "--is-ancestor", base, "HEAD");

const baselinePath = join(root, "tests/architecture-baseline.json");
const policyPath = join(root, "tests/architecture-policy.json");
const baselineBytes = await readFile(baselinePath, "utf8");
const policyBytes = await readFile(policyPath, "utf8");
const working = JSON.parse(baselineBytes) as Inventory;

const baseline = JSON.parse(
  await git("show", `${base}:tests/architecture-baseline.json`),
) as Inventory;

const policy = JSON.parse(policyBytes) as ArchitecturePolicy;

const source = await buildGraph(
  root,
  ["src"],
  new Set(),
  new Set(allowedClosureFiles),
);

const graph = normalizeGraph(source, policy);

const cycleComponents = components(graph).filter(
  (group) => group.length > 1 || graph.get(group[0] ?? "")?.has(group[0] ?? ""),
);

const inventory = {
  sourceFiles: graph.size,
  sourceEdges: [...graph.values()].reduce(
    (total, edges) => total + edges.size,
    0,
  ),
  rootFiles: await sourceRootFiles(root),
  largestCycle: Math.max(0, ...cycleComponents.map((group) => group.length)),
  cycleComponents,
  cyclicEdges: cyclicEdges(graph),
  crewPlugin: {
    ...working.crewPlugin,
    entry: baseline.crewPlugin.entry,
    members: importClosure(graph, baseline.crewPlugin.entry),
  },
};

const violations = [
  ...boundaryViolations(graph, policy),
  ...(await documentationViolations(root, await architectureDocuments(root))),
].sort();

const errors: string[] = [];

function subset(actual: string[], allowed: string[], label: string) {
  const permissions = new Set(allowed);

  for (const item of actual)
    if (!permissions.has(item)) errors.push(`${label}:${item}`);
}

subset(working.largeFiles, baseline.largeFiles, "unauthorized-large-file");

subset(inventory.rootFiles, baseline.rootFiles, "root");

subset(inventory.cyclicEdges, baseline.cyclicEdges, "cycle");

if (new Set(working.exceptions).size !== working.exceptions.length)
  errors.push("duplicate-exception");

const approvedExceptions = [...working.exceptions];
const allowedWorkingExceptions = [...baseline.exceptions];

if (exceptionRekeys.length) {
  const previous = await rekeyBase();
  const paths = sourceIdentities(source.keys(), policy);

  const parse = (key: string) => {
    const match =
      /^(direction|private|neighbour|shared-dependency):(src\/\S+) -> (src\/\S+)$/.exec(
        key,
      );

    return match
      ? { kind: match[1], source: match[2], target: match[3] }
      : undefined;
  };

  for (const { oldKey, newKey } of exceptionRekeys) {
    const old = parse(oldKey),
      next = parse(newKey);

    let reason: string | undefined;

    if (
      !old ||
      !next ||
      !old.source ||
      !old.target ||
      !next.source ||
      !next.target
    )
      reason = "invalid-key";
    else if (old.kind !== next.kind) reason = "different-kind";
    else if (old.target !== next.target) reason = "different-target";
    else if (
      !baseline.exceptions.includes(oldKey) ||
      (!working.exceptions.includes(oldKey) &&
        !working.exceptions.includes(newKey))
    )
      reason = "unknown-old";
    else if (
      approvedExceptions.includes(oldKey) &&
      approvedExceptions.includes(newKey)
    )
      reason = "duplicate-new";
    else if (
      violations.includes(oldKey) ||
      graph.get(old.source)?.has(old.target)
    )
      reason = "old-key-present";
    else {
      const file = [...paths].find(
        ([, identity]) => identity === next.source,
      )?.[0];

      if (!file) reason = "new-source-missing";
      else if (previous.files.has(file)) reason = "new-source-existed-at-base";
      else if (!previous.graph.get(old.source)?.has(old.target))
        reason = "base-edge-missing";
      else if (!previous.violations.includes(oldKey))
        reason = "base-exception-missing";
      else if (!violations.includes(newKey)) reason = "new-key-missing";
    }

    if (reason) errors.push(`rekey:${reason}:${oldKey} => ${newKey}`);
    else {
      const index = approvedExceptions.indexOf(oldKey);

      if (index !== -1) approvedExceptions[index] = newKey;
      allowedWorkingExceptions.push(newKey);
    }
  }

  if (violations.length > previous.violations.length)
    errors.push(
      `rekey:exception-total-increase:${previous.violations.length} -> ${violations.length}`,
    );
}

subset(working.exceptions, allowedWorkingExceptions, "unauthorized-exception");

subset(violations, approvedExceptions, "new");

if (!flags.has("--prune-stale"))
  subset(approvedExceptions, violations, "stale");

const sizeFailures = await sizeRegressions(root, policy, working.largeFiles);
const staleSizePrefix = "stale:large-file:";

const staleLargeFiles = new Set(
  sizeFailures
    .filter((failure) => failure.startsWith(staleSizePrefix))
    .map((failure) => failure.slice(staleSizePrefix.length)),
);

errors.push(
  ...sizeFailures
    .filter(
      (failure) =>
        !flags.has("--prune-stale") || !failure.startsWith(staleSizePrefix),
    )
    .map((failure) =>
      failure.replace(/^new:large-file:/, "unauthorized-large-file:"),
    ),
);

if (inventory.largestCycle > baseline.largestCycle)
  errors.push(
    `largest-cycle:${inventory.largestCycle} > ${baseline.largestCycle}`,
  );

const closureCap = baseline.crewPlugin.members.length;
const previousMembers = new Set(baseline.crewPlugin.members);

const addedMembers = inventory.crewPlugin.members.filter(
  (file) => !previousMembers.has(file),
);

const currentMembers = new Set(inventory.crewPlugin.members);

const removedMembers = baseline.crewPlugin.members
  .filter((file) => !currentMembers.has(file))
  .sort();

const identities =
  addedMembers.length || allowedClosureFiles.length
    ? sourceIdentities(source.keys(), policy)
    : new Map<string, string>();

const namedMembers = new Set(
  allowedClosureFiles.map((file) => identities.get(file)),
);

for (const identity of addedMembers) {
  if (!namedMembers.has(identity)) {
    const file =
      [...identities].find(([, id]) => id === identity)?.[0] ?? identity;

    errors.push(
      `closure-addition:unnamed:${identity}; --allow-closure-addition ${file} is only for a file holding only code the closure already loaded, with a decision recorded for this change; otherwise remove the import that added it.`,
    );
  }
}

const closureAdditions = [];

const closureReviewRequired =
  "Not checked: that bodies are moved, not new, or that packages were already used by the closure. Put this proof in the PR for the reviewer to verify.";

for (const file of [...allowedClosureFiles].sort()) {
  const identity = identities.get(file);

  if (!identity) {
    errors.push(`closure-addition:unknown-file:${file}`);
    continue;
  }

  if (!addedMembers.includes(identity))
    errors.push(`closure-addition:not-added:${file}`);
  const imports = [...(graph.get(identity) ?? [])].sort();

  for (const target of imports)
    if (!previousMembers.has(target))
      errors.push(`closure-addition:new-import:${file} -> ${target}`);
  closureAdditions.push({
    file,
    identity,
    imports,
    checks: [
      "added-member",
      "imports-resolve",
      "imports-in-base-closure-or-package",
    ],
  });
}

if (
  !allowedClosureFiles.length &&
  inventory.crewPlugin.members.length > closureCap
)
  errors.push(
    `crew-closure:${inventory.crewPlugin.members.length} > ${closureCap}`,
  );

if (errors.length)
  throw new Error(JSON.stringify({ errors: errors.sort() }, null, 2));

const measuredExceptions = new Set(violations);

const prunedExceptions = flags.has("--prune-stale")
  ? approvedExceptions.filter((item) => !measuredExceptions.has(item))
  : [];

const exceptions = flags.has("--prune-stale")
  ? approvedExceptions.filter((item) => measuredExceptions.has(item))
  : approvedExceptions;

const prunedLargeFiles = flags.has("--prune-stale")
  ? working.largeFiles.filter((item) => staleLargeFiles.has(item))
  : [];

const largeFiles = flags.has("--prune-stale")
  ? working.largeFiles.filter((item) => !staleLargeFiles.has(item))
  : working.largeFiles;

const next: Inventory = {
  ...working,
  ...inventory,
  exceptions,
  largeFiles,
};

if (flags.has("--write")) {
  const formatter = Bun.spawn(
    [join(root, "node_modules/.bin/oxfmt"), "--stdin-filepath", baselinePath],
    {
      cwd: root,
      stdin: new Blob([JSON.stringify(next, null, 2) + "\n"]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [formatted, stderr, exit] = await Promise.all([
    new Response(formatter.stdout).text(),
    new Response(formatter.stderr).text(),
    formatter.exited,
  ]);

  if (exit !== 0) throw new Error(`oxfmt failed (${exit}): ${stderr}`);

  if (!isDeepStrictEqual(JSON.parse(formatted), next))
    throw new Error("Formatter changed baseline data");
  const temporary = `${baselinePath}.${randomUUID()}.tmp`;
  const mode = (await stat(baselinePath)).mode & 0o777;
  const file = await open(temporary, "wx", mode);

  try {
    try {
      await file.writeFile(formatted);
      await file.chmod(mode);
    } finally {
      await file.close();
    }

    if (
      (await readFile(policyPath, "utf8")) !== policyBytes ||
      (await readFile(baselinePath, "utf8")) !== baselineBytes
    )
      throw new Error(
        "Guard JSON changed during measurement; retry without concurrent editing",
      );
    await rename(temporary, baselinePath);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    });
  }
}

const result = {
  root,
  base,
  write: flags.has("--write"),
  flags: [...flags].sort(),
  inventory,
  cycleComponents,
  exceptions,
  ...(flags.has("--prune-stale")
    ? { largeFiles, prunedExceptions, prunedLargeFiles }
    : {}),
  ...(allowedClosureFiles.length
    ? {
        closureAdditions,
        closureRemovals: removedMembers,
        closureReviewRequired,
      }
    : {}),
  violations,
  errors,
  ...(exceptionRekeys.length ? { exceptionRekeys } : {}),
};

if (output)
  await writeFile(resolve(output), JSON.stringify(result, null, 2) + "\n");

console.log(
  JSON.stringify({
    root,
    write: result.write,
    modules: inventory.sourceFiles,
    edges: inventory.sourceEdges,
    roots: inventory.rootFiles.length,
    largestCycle: inventory.largestCycle,
    cyclicEdges: inventory.cyclicEdges.length,
    crewClosure: inventory.crewPlugin.members.length,
    exceptions: exceptions.length,
    ...(flags.has("--prune-stale")
      ? { largeFiles: largeFiles.length, prunedExceptions, prunedLargeFiles }
      : {}),
    ...(allowedClosureFiles.length
      ? {
          closureAdditions,
          closureRemovals: removedMembers,
          closureReviewRequired,
        }
      : {}),
    errors,
    ...(exceptionRekeys.length ? { exceptionRekeys } : {}),
  }),
);
