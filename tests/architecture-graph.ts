import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { API } from "typescript/unstable/async";
import {
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  SyntaxKind,
  type Node,
} from "typescript/unstable/ast";

export type SourceGraph = ReadonlyMap<string, ReadonlySet<string>>;

export async function sourceRootFiles(root: string): Promise<string[]> {
  return (await readdir(join(root, "src"), { withFileTypes: true }))
    .filter((entry) => !entry.isDirectory())
    .map((entry) => `src/${entry.name}`)
    .sort();
}

export interface GraphBaseline {
  rootFiles: string[];
  cyclicEdges: string[];
  crewPlugin: { entry: string; members: string[] };
  largestCycle?: number;
}

export interface SlicePolicy {
  layer: string;
  files: string[];
  public: string[];
  neighbours: string[];
  contracts?: string[];
  retained?: Record<string, string>;
}

export interface ArchitecturePolicy {
  slices: Record<string, SlicePolicy>;
  /** Stable ID -> complete approved physical paths, including its original path. */
  aliases?: Record<string, string[]>;
}

/** IDs keep their first recorded spelling. No basename or content matching. */
export function normalizeGraph(
  graph: SourceGraph,
  policy: ArchitecturePolicy,
): SourceGraph {
  const owners = new Map<string, string>();
  const paths = new Map<string, string>();
  const validPath = (path: string) =>
    path.startsWith("src/") &&
    path === posix.normalize(path) &&
    !path.includes("\\") &&
    sourceExtension.test(path);
  for (const [owner, slice] of Object.entries(policy.slices)) {
    for (const id of slice.files) {
      if (!validPath(id)) throw new Error(`invalid module identity: ${id}`);
      if (owners.has(id)) throw new Error(`duplicate module identity: ${id}`);
      owners.set(id, owner);
    }
  }
  for (const id of Object.keys(policy.aliases ?? {}))
    if (!owners.has(id)) throw new Error(`unknown alias identity: ${id}`);
  for (const [id, owner] of owners) {
    const aliases = policy.aliases?.[id] ?? [id];
    if (!aliases.includes(id))
      throw new Error(`alias list omits original path: ${id}`);
    for (const path of aliases) {
      if (!validPath(path)) throw new Error(`invalid source alias: ${path}`);
      if (paths.has(path)) throw new Error(`alias collision: ${path}`);
      const sharedFolder = /^src\/(lib|shared)\//.exec(path)?.[1];
      if (sharedFolder && sharedFolder !== owner)
        throw new Error(
          `alias changes shared-folder ownership: ${id} -> ${path}`,
        );
      paths.set(path, id);
    }
  }
  const physical = new Map<string, string>();
  for (const path of graph.keys()) {
    const id = paths.get(path);
    if (!id) throw new Error(`unknown source path: ${path}`);
    const previous = physical.get(id);
    if (previous)
      throw new Error(`simultaneous aliases: ${id}: ${previous}, ${path}`);
    physical.set(id, path);
  }
  const normalized = new Map<string, Set<string>>();
  for (const [path, imports] of graph) {
    const id = paths.get(path);
    if (!id) throw new Error(`unknown source path: ${path}`);
    const edges = new Set<string>();
    for (const target of imports) {
      const targetID = paths.get(target);
      if (!targetID || !graph.has(target))
        throw new Error(`unknown source target: ${path} -> ${target}`);
      edges.add(targetID);
    }
    normalized.set(id, edges);
  }
  return normalized;
}

const layers = [
  "lib",
  "contracts",
  "config",
  "slices",
  "gateway",
  "transports",
  "app",
];

/** Policy uses current paths, even when logical ownership anticipates a move. */
export function boundaryViolations(
  graph: SourceGraph,
  policy: ArchitecturePolicy,
): string[] {
  const failures = new Set<string>();
  const owners = new Map<string, { name: string; slice: SlicePolicy }>();
  for (const [name, slice] of Object.entries(policy.slices)) {
    if (!layers.includes(slice.layer))
      failures.add(`policy:unknown-layer:${name}:${slice.layer}`);
    for (const file of slice.files) {
      if (owners.has(file)) failures.add(`membership:duplicate:${file}`);
      owners.set(file, { name, slice });
      if (!graph.has(file)) failures.add(`policy:missing-file:${file}`);
    }
    for (const file of slice.public)
      if (!slice.files.includes(file))
        failures.add(`policy:public-not-owned:${name}:${file}`);
    for (const file of slice.contracts ?? [])
      if (!slice.public.includes(file))
        failures.add(`policy:contract-not-public:${name}:${file}`);
    for (const [file, kind] of Object.entries(slice.retained ?? {}))
      if (!slice.files.includes(file) || !["service", "store"].includes(kind))
        failures.add(`policy:invalid-owner-exception:${name}:${file}`);
    for (const neighbour of slice.neighbours)
      if (!policy.slices[neighbour] || neighbour === name)
        failures.add(`policy:unknown-neighbour:${name}:${neighbour}`);
  }
  for (const file of graph.keys())
    if (!owners.has(file)) failures.add(`membership:missing:${file}`);
  const shared = (name: string) => name === "lib" || name === "shared";
  for (const [file, owner] of owners) {
    const folder = /^src\/(lib|shared)\//.exec(file)?.[1];
    if (folder && folder !== owner.name)
      failures.add(`policy:shared-folder-owner:${file}:${owner.name}`);
  }
  const consumers = new Map<string, Set<string>>();
  for (const [from, imports] of graph) {
    const source = owners.get(from);
    if (!source) continue;
    const sourceLayer = source.slice.contracts?.includes(from)
      ? "contracts"
      : source.slice.layer;
    for (const to of imports) {
      const target = owners.get(to);
      if (!target) continue;
      // Count consuming owners, including local use. Technical lib/shared
      // buckets are not consuming slices; tests never enter the src graph.
      if (!shared(source.name)) {
        const slices = consumers.get(to) ?? new Set<string>();
        slices.add(source.name);
        consumers.set(to, slices);
      }
      const edge = `${from} -> ${to}`;
      const targetLayer = target.slice.contracts?.includes(to)
        ? "contracts"
        : target.slice.layer;
      if (layers.indexOf(targetLayer) > layers.indexOf(sourceLayer))
        failures.add(`direction:${edge}`);
      if (source.name === target.name) continue;
      if (!target.slice.public.includes(to)) failures.add(`private:${edge}`);
      if (!source.slice.neighbours.includes(target.name))
        failures.add(`neighbour:${edge}`);
      if (shared(source.name) && !shared(target.name))
        failures.add(`shared-dependency:${edge}`);
    }
  }
  for (const [file, owner] of owners) {
    const count = consumers.get(file)?.size ?? 0;
    if (shared(owner.name) && count < 3)
      failures.add(`rule-three:underused:${file}`);
    if (
      !shared(owner.name) &&
      count >= 3 &&
      !owner.slice.public.includes(file) &&
      !owner.slice.retained?.[file]
    )
      failures.add(`rule-three:extract:${file}`);
  }
  return [...failures].sort();
}

/** Remove resolved exceptions in the same edit. Tests never write baselines. */
export function exceptionRegressions(
  violations: string[],
  exceptions: string[],
): string[] {
  const current = new Set(violations);
  const allowed = new Set(exceptions);
  return [
    ...violations.filter((id) => !allowed.has(id)).map((id) => `new:${id}`),
    ...exceptions.filter((id) => !current.has(id)).map((id) => `stale:${id}`),
  ].sort();
}

function documentedPaths(markdown: string) {
  const paths = new Set<string>();
  let fence: { marker: string; size: number; target: boolean } | undefined;
  for (const line of markdown.split("\n")) {
    const delimiter = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      const marker = delimiter[1] ?? "";
      if (!fence)
        fence = {
          marker: marker[0] ?? "",
          size: marker.length,
          target: /\bTARGET-LAYOUT\b/.test(delimiter[2] ?? ""),
        };
      else if (
        marker[0] === fence.marker &&
        marker.length >= fence.size &&
        !delimiter[2]?.trim()
      )
        fence = undefined;
      continue;
    }
    // Scope is one labelled line or one labelled fence, never a whole document.
    if (fence?.target || /^\s*TARGET-LAYOUT:/.test(line)) continue;
    for (const match of line.matchAll(
      /(?<![\w/.:~-])(?:\.\/)?(src\/[\w./*?-]+)/g,
    )) {
      const path = match[1]?.replace(/\.+$/, "");
      if (path) paths.add(path);
    }
  }
  return [...paths].sort();
}

export async function documentationViolations(
  root: string,
  documents: Record<string, string>,
): Promise<string[]> {
  const failures: string[] = [];
  for (const [document, markdown] of Object.entries(documents)) {
    for (const path of documentedPaths(markdown)) {
      let exists = false;
      if (/[?*]/.test(path)) {
        const matches = await Array.fromAsync(
          new Bun.Glob(path).scan({ cwd: root, onlyFiles: false }),
        );
        exists = matches.length > 0;
      } else {
        const target = resolve(root, path);
        if (inside(root, target)) {
          const stat = await lstat(target).catch(() => undefined);
          exists = stat?.isFile() === true || stat?.isDirectory() === true;
          if (!stat) {
            // Documentation also contains real extensionless module imports.
            exists = await resolveLocal(
              root,
              join(root, "document.ts"),
              `./${path}`,
            ).then(
              () => true,
              () => false,
            );
          }
        }
      }
      if (!exists) failures.push(`source-path:${document}:${path}`);
    }
  }
  return failures.sort();
}

export async function architectureDocuments(
  root: string,
): Promise<Record<string, string>> {
  const documents: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(join(root, directory), {
      withFileTypes: true,
    })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".md"))
        documents[portable(path)] = await readFile(join(root, path), "utf8");
    }
  };
  await visit("docs");
  for (const path of ["AGENTS.md", "README.md", "CONTRIBUTING.md"])
    documents[path] = await readFile(join(root, path), "utf8");
  return documents;
}

const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const portable = (path: string) => path.split(sep).join("/");

function inside(root: string, path: string) {
  const name = relative(root, path);
  return name !== ".." && !name.startsWith(`..${sep}`) && !isAbsolute(name);
}

async function sourceFiles(directory: string): Promise<string[]> {
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error(`symbolic link: ${directory}`);
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symbolic link: ${path}`);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.isFile() && sourceExtension.test(path)) files.push(path);
  }
  return files.sort();
}

async function resolveLocal(
  root: string,
  from: string,
  specifier: string,
  deleted: ReadonlySet<string> = new Set(),
) {
  const named = resolve(dirname(from), specifier);
  if (!inside(root, named))
    throw new Error(`${from}: ${specifier} outside repository`);
  // Bun resolves symlinks. Check the spelled path first, including directories.
  let part = root;
  for (const segment of relative(root, named).split(sep)) {
    part = join(part, segment);
    const stat = await lstat(part).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw new Error(`symbolic link: ${part}`);
  }
  let target: string;
  try {
    target = Bun.resolveSync(specifier, dirname(from));
  } catch {
    // A staged deletion can leave old importers broken. Keep that terminal
    // edge so selection runs those tests; do not hide unrelated resolution errors.
    const stem = portable(relative(root, named));
    const extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".json"];
    const candidates = [
      stem,
      ...extensions.flatMap((extension) => [
        stem + extension,
        `${stem}/index${extension}`,
      ]),
      ...(stem.endsWith(".js") ? [stem.slice(0, -3) + ".ts"] : []),
    ].filter((path) => deleted.has(path));
    if (candidates.length === 1 && candidates[0]) return candidates[0];
    throw new Error(`${from}: unresolved local import ${specifier}`);
  }
  if (!inside(root, target))
    throw new Error(`${from}: ${specifier} resolves outside repository`);
  const stat = await lstat(target);
  if (!stat.isFile()) throw new Error(`not a regular file: ${target}`);
  return portable(relative(root, target));
}

async function resolveSource(
  root: string,
  from: string,
  specifier: string,
  deleted: ReadonlySet<string>,
) {
  if (isAbsolute(specifier) || specifier.startsWith("file:"))
    throw new Error(`${from}: absolute source import: ${specifier}`);
  if (specifier.startsWith("."))
    return resolveLocal(root, from, specifier, deleted);
  // Bun also resolves tsconfig paths and package.json imports. Bare package and
  // builtin imports are external; a local alias must not hide a source edge.
  let target: string;
  try {
    target = Bun.resolveSync(specifier, dirname(from));
  } catch {
    return undefined;
  }
  if (!isAbsolute(target) || !inside(root, target)) return undefined;
  const name = portable(relative(root, target));
  if (name.split("/").includes("node_modules")) return undefined;
  return name;
}

function importsOf(node: Node): string[] {
  const imports = new Set<string>();
  const literal = (value: Node | undefined) => {
    if (
      value &&
      (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value))
    )
      imports.add(value.text);
  };
  const visit = (child: Node): void => {
    if (isImportDeclaration(child) || isExportDeclaration(child))
      literal(child.moduleSpecifier);
    else if (isImportTypeNode(child) && isLiteralTypeNode(child.argument))
      literal(child.argument.literal);
    else if (
      isCallExpression(child) &&
      (child.expression.kind === SyntaxKind.ImportKeyword ||
        (isIdentifier(child.expression) && child.expression.text === "require"))
    )
      literal(child.arguments[0]);
    else if (
      isImportEqualsDeclaration(child) &&
      isExternalModuleReference(child.moduleReference)
    )
      literal(child.moduleReference.expression);
    child.forEachChild(visit);
  };
  visit(node);
  return [...imports].sort();
}

/** Parse only. Never import, transpile, or execute a production module. */
export async function buildGraph(
  directory: string,
  directories: string[] = ["src"],
  deleted: ReadonlySet<string> = new Set(),
): Promise<SourceGraph> {
  const root = await realpath(directory);
  const files = (
    await Promise.all(directories.map((name) => sourceFiles(join(root, name))))
  ).flat();
  const graph = new Map<string, Set<string>>(
    files.map((file) => [portable(relative(root, file)), new Set<string>()]),
  );
  // TS 7's installed native parser preserves type edges; Bun.scanImports erases
  // them. A virtual config avoids project/dependency loading and filesystem edits.
  const config = join(root, ".architecture-scan.json");
  const contents = JSON.stringify({
    compilerOptions: { noResolve: true, noLib: true, allowJs: true },
    files,
  });
  const api = new API({
    cwd: root,
    fs: {
      fileExists: (path) => (path === config ? true : undefined),
      readFile: (path) => (path === config ? contents : undefined),
    },
  });
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [config] });
    try {
      const program = snapshot.getProject(config)?.program;
      if (!program) throw new Error("Missing architecture parser project");
      for (const file of files) {
        const source = await program.getSourceFile(file);
        if (!source) throw new Error(`Source not parsed: ${file}`);
        const diagnostics = await program.getSyntacticDiagnostics(file);
        if (diagnostics.length)
          throw new Error(`Invalid source syntax: ${file}`);
        const edges = graph.get(portable(relative(root, file)));
        if (!edges) throw new Error(`Source not in graph: ${file}`);
        for (const specifier of importsOf(source)) {
          const target = await resolveSource(root, file, specifier, deleted);
          if (!target) continue;
          // Affected-test graphs retain imported data and known deleted targets.
          // The default architecture graph remains source-only.
          if (
            directories.includes("tests") &&
            (!sourceExtension.test(target) || deleted.has(target)) &&
            !graph.has(target)
          )
            graph.set(target, new Set());
          if (graph.has(target)) edges.add(target);
          else if (sourceExtension.test(target))
            throw new Error(`${file}: source outside src graph: ${specifier}`);
        }
      }
    } finally {
      await snapshot.dispose();
    }
  } finally {
    await api.close();
  }
  return graph;
}

/** Tarjan components, including isolated nodes; deterministic source identities. */
export function components(graph: SourceGraph): string[][] {
  let next = 0;
  const indices = new Map<string, number>();
  const lows = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();
  const result: string[][] = [];
  const visit = (file: string): void => {
    const index = next++;
    indices.set(file, index);
    lows.set(file, index);
    stack.push(file);
    active.add(file);
    for (const target of graph.get(file) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lows.set(
          file,
          Math.min(lows.get(file) ?? index, lows.get(target) ?? index),
        );
      } else if (active.has(target)) {
        lows.set(
          file,
          Math.min(lows.get(file) ?? index, indices.get(target) ?? index),
        );
      }
    }
    if (lows.get(file) !== index) return;
    const group: string[] = [];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      active.delete(node);
      group.push(node);
      if (node === file) break;
    }
    result.push(group.sort());
  };
  for (const file of graph.keys()) if (!indices.has(file)) visit(file);
  return result.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
}

export function cyclicEdges(graph: SourceGraph): string[] {
  const result: string[] = [];
  for (const group of components(graph)) {
    const members = new Set(group);
    for (const from of group)
      for (const to of graph.get(from) ?? [])
        if (members.has(to)) result.push(`${from} -> ${to}`);
  }
  return result.sort();
}

export function importClosure(graph: SourceGraph, entry: string): string[] {
  if (!graph.has(entry)) return [];
  const seen = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...(graph.get(file) ?? []));
  }
  return [...seen].sort();
}

export function graphRegressions(
  graph: SourceGraph,
  baseline: GraphBaseline,
  rootFiles = [...graph.keys()].filter((file) => dirname(file) === "src"),
): string[] {
  const roots = new Set(baseline.rootFiles);
  const cycles = new Set(baseline.cyclicEdges);
  const failures = rootFiles
    .filter((file) => !roots.has(file))
    .map((file) => `root:${file}`);
  failures.push(
    ...cyclicEdges(graph)
      .filter((edge) => !cycles.has(edge))
      .map((edge) => `cycle:${edge}`),
  );
  const largest = Math.max(
    0,
    ...components(graph)
      .filter((group) => group.length > 1)
      .map((group) => group.length),
  );
  if (baseline.largestCycle !== undefined && largest > baseline.largestCycle)
    failures.push(`largest-cycle:${largest} > ${baseline.largestCycle}`);
  const closure = importClosure(graph, baseline.crewPlugin.entry);
  if (closure.length > baseline.crewPlugin.members.length)
    failures.push(
      `crew-closure:${closure.length} > ${baseline.crewPlugin.members.length}`,
    );
  return failures.sort();
}
