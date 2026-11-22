import { randomUUID } from "node:crypto";
import {
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
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
for (let index = 0; index < argv.length; index++) {
  const argument = argv[index];
  if (!argument) throw new Error("Missing argument");
  if (argument === "--write" || argument === "--prune-stale") {
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
    "Usage: bun scripts/refresh-architecture-baseline.ts --root PATH --base COMMIT [--output PATH] [--write] [--prune-stale]",
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
async function git(...args: string[]): Promise<string> {
  const result = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(result.stdout).text(),
    new Response(result.stderr).text(),
    result.exited,
  ]);
  if (exit !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
  return stdout;
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
const graph = normalizeGraph(await buildGraph(root), policy);
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
subset(working.exceptions, baseline.exceptions, "unauthorized-exception");
subset(working.largeFiles, baseline.largeFiles, "unauthorized-large-file");
subset(inventory.rootFiles, baseline.rootFiles, "root");
subset(inventory.cyclicEdges, baseline.cyclicEdges, "cycle");
if (new Set(working.exceptions).size !== working.exceptions.length)
  errors.push("duplicate-exception");
subset(violations, working.exceptions, "new");
if (!flags.has("--prune-stale"))
  subset(working.exceptions, violations, "stale");
if (inventory.largestCycle > baseline.largestCycle)
  errors.push(
    `largest-cycle:${inventory.largestCycle} > ${baseline.largestCycle}`,
  );
const closureCap = baseline.crewPlugin.members.length;
if (inventory.crewPlugin.members.length > closureCap)
  errors.push(
    `crew-closure:${inventory.crewPlugin.members.length} > ${closureCap}`,
  );
if (errors.length)
  throw new Error(JSON.stringify({ errors: errors.sort() }, null, 2));
const measuredExceptions = new Set(violations);
const prunedExceptions = flags.has("--prune-stale")
  ? working.exceptions.filter((item) => !measuredExceptions.has(item))
  : [];
const exceptions = flags.has("--prune-stale")
  ? working.exceptions.filter((item) => measuredExceptions.has(item))
  : working.exceptions;
const next: Inventory = {
  ...working,
  ...inventory,
  exceptions,
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
  ...(flags.has("--prune-stale") ? { prunedExceptions } : {}),
  violations,
  errors,
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
    ...(flags.has("--prune-stale") ? { prunedExceptions } : {}),
    errors,
  }),
);
