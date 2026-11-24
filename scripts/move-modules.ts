import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { API } from "typescript/unstable/async";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  type Node,
  SyntaxKind,
  isCallExpression,
  isExportDeclaration,
  isImportDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isStringLiteralLikeNode,
  skipTrivia,
} from "typescript/unstable/ast";

type Move = readonly [string, string];

type Entry = { mode: string; bytes: Buffer };

type Tree = Map<string, Entry>;

const code = /^(src|plugins|tests|scripts|perf)\/.*\.(?:[cm]?[jt]s|[jt]sx)$/;

const extensions = [
  ".ts",
  ".tsx",
  ".d.ts",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
];

const locked = new Set([
  "src/main.ts",
  "src/config.ts",
  "plugins/opencode/crew/plugin.ts",
  "plugins/opencode/fleet/plugin.ts",
  "src/fleet/plugin.ts",
]);

function git(
  root: string,
  args: string[],
  input?: Buffer,
  index?: string,
): Buffer {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      ...(index && { GIT_INDEX_FILE: index }),
    },
    ...(input && { stdin: input }),
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args[0]} failed: ${result.stderr.toString().trim()}`,
    );
  }

  return result.stdout;
}

function paths(bytes: Buffer): string[] {
  return bytes.toString("utf8").split("\0").filter(Boolean);
}

function readTree(root: string, ref: string): Tree {
  const records = paths(git(root, ["ls-tree", "-rz", "--full-tree", ref])).map(
    (line) => {
      const match = /^(\d+) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);

      if (!match) {
        throw new Error("Unsupported Git tree entry");
      }

      const [, mode = "", kind = "", oid = "", path = ""] = match;

      return { mode, kind, oid, path };
    },
  );

  const blobs = records.filter((entry) => entry.kind === "blob");

  const bytes = git(
    root,
    ["cat-file", "--batch"],
    Buffer.from(blobs.map((entry) => entry.oid).join("\n") + "\n"),
  );

  let offset = 0;
  const tree: Tree = new Map();

  for (const entry of blobs) {
    const end = bytes.indexOf(10, offset);
    const size = Number(bytes.subarray(offset, end).toString().split(" ")[2]);

    if (end === -1 || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("Invalid Git blob response");
    }

    offset = end + 1;
    tree.set(entry.path, {
      mode: entry.mode,
      bytes: bytes.subarray(offset, offset + size),
    });
    offset += size + 1;
  }

  for (const entry of records.filter((entry) => entry.kind === "commit")) {
    tree.set(entry.path, { mode: entry.mode, bytes: Buffer.from(entry.oid) });
  }

  return tree;
}

function validateMoves(tree: Tree, moves: readonly Move[]) {
  if (moves.length === 0) {
    throw new Error("Supply at least one old/new path pair");
  }

  const sources = new Set<string>();
  const destinations = new Set<string>();

  for (const [oldPath, newPath] of moves) {
    for (const path of [oldPath, newPath]) {
      if (
        !code.test(path) ||
        !/^[a-zA-Z0-9_./-]+$/.test(path) ||
        path.split("/").some((part) => !part || part === "." || part === "..")
      ) {
        throw new Error(`Invalid module path: ${path}`);
      }

      if (locked.has(path)) {
        throw new Error(`Locked module: ${path}`);
      }
    }

    if (posix.extname(oldPath) !== posix.extname(newPath)) {
      throw new Error("Moves must preserve file extensions");
    }

    const source = tree.get(oldPath);

    if (!source || !["100644", "100755"].includes(source.mode)) {
      throw new Error(`Unknown or non-file module: ${oldPath}`);
    }

    if (sources.has(oldPath) || destinations.has(newPath.toLowerCase())) {
      throw new Error("Duplicate move mapping");
    }

    if (
      [...tree.keys()].some(
        (path) =>
          path.toLowerCase() === newPath.toLowerCase() ||
          path.startsWith(`${newPath}/`),
      )
    ) {
      throw new Error(`Destination collision: ${newPath}`);
    }

    sources.add(oldPath);
    destinations.add(newPath.toLowerCase());
  }

  for (const [, newPath] of moves) {
    const parts = newPath.split("/");

    while (parts.pop()) {
      if (
        tree.has(parts.join("/")) ||
        destinations.has(parts.join("/").toLowerCase())
      ) {
        throw new Error(`Destination parent collision: ${newPath}`);
      }
    }
  }
}

function resolveImport(tree: Tree, file: string, specifier: string) {
  const path = posix
    .normalize(posix.join(posix.dirname(file), specifier))
    .replace(/\/$/, "");

  if (tree.has(`${path}/package.json`)) {
    throw new Error(
      `Directory package resolution is not supported: ${file}: ${specifier}`,
    );
  }

  const extension = posix.extname(path);

  const substitutions: Record<string, string[]> = {
    ".js": [".ts", ".tsx", ".d.ts", ".js", ".jsx"],
    ".jsx": [".tsx", ".d.ts", ".jsx"],
    ".mjs": [".mts", ".d.mts", ".mjs"],
    ".cjs": [".cts", ".d.cts", ".cjs"],
  };

  const candidates = substitutions[extension]
    ? substitutions[extension].map((suffix) => ({
        path: path.slice(0, -extension.length) + suffix,
        suffix,
        index: false,
      }))
    : [
        { path, suffix: "", index: false },
        ...extensions.map((suffix) => ({
          path: path + suffix,
          suffix,
          index: false,
        })),
      ];

  if (
    substitutions[extension] &&
    tree.has(path) &&
    candidates.some(
      (candidate) => candidate.path !== path && tree.has(candidate.path),
    )
  ) {
    throw new Error(
      `Ambiguous source/runtime module resolution: ${file}: ${specifier}`,
    );
  }

  candidates.push(
    ...extensions.map((suffix) => ({
      path: `${path}/index${suffix}`,
      suffix,
      index: true,
    })),
  );

  return candidates.find((candidate) => {
    const mode = tree.get(candidate.path)?.mode;

    return mode === "100644" || mode === "100755";
  });
}

function relativeSpecifier(file: string, target: string) {
  const path = posix.relative(posix.dirname(file), target);

  return path.startsWith("../")
    ? path
    : path === ".."
      ? "../"
      : path === ""
        ? "./"
        : `./${path}`;
}

function rewriteSpecifier(
  before: Tree,
  after: Tree,
  moves: Map<string, string>,
  file: string,
  specifier: string,
): string {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return specifier;
  }

  const resolved = resolveImport(before, file, specifier);
  const newFile = moves.get(file) ?? file;

  if (!resolved) {
    if (newFile !== file) {
      throw new Error(
        `Cannot resolve relative module in moved file: ${file}: ${specifier}`,
      );
    }

    if (resolveImport(after, newFile, specifier)) {
      throw new Error(`Move changes module resolution: ${file}: ${specifier}`);
    }

    return specifier;
  }

  const target = moves.get(resolved.path) ?? resolved.path;

  if (file === newFile && target === resolved.path) {
    if (resolveImport(after, file, specifier)?.path !== target) {
      throw new Error(`Move changes module resolution: ${file}: ${specifier}`);
    }

    return specifier;
  }

  const extension = posix.extname(specifier);
  const explicitExtension = extensions.includes(extension) ? extension : "";
  // Keep the filename while relativizing; its stem may name an ancestor folder.
  let result = relativeSpecifier(newFile, target);

  if (resolved.suffix) {
    result = result.slice(0, -resolved.suffix.length);
  }

  if (resolved.index && posix.basename(result) === "index") {
    result = relativeSpecifier(newFile, posix.dirname(target));
  } else if (explicitExtension && resolved.suffix) {
    result += explicitExtension;
  }

  if (specifier.endsWith("/") && resolved.index) {
    result += result.endsWith("/") ? "" : "/";
  }

  if (resolveImport(after, newFile, result)?.path !== target) {
    throw new Error(`Move changes module resolution: ${file}: ${specifier}`);
  }

  return result;
}

function rewriteDocs(
  text: string,
  document: string,
  moves: Map<string, string>,
) {
  return text.replace(
    /[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>"`]+|(?<![\p{L}\p{N}_./:@%+~-])(?:\.\.\/)*src\/[a-zA-Z0-9_./-]+(?![\p{L}\p{N}_./-])/gu,
    (token) => {
      // Consume complete URLs without rewriting path-like query/fragment text.
      if (!token.startsWith("src/") && !token.startsWith("../")) {
        return token;
      }

      // Sentence punctuation is not part of the path token.
      const path = token.replace(/\.+$/, "");

      if (path.startsWith("../")) {
        const directory = posix.dirname(document);
        const resolved = posix.join(directory, path);

        if (posix.relative(directory, resolved) !== path) {
          return token;
        }

        const target = moves.get(resolved);

        return target
          ? posix.relative(directory, target) + token.slice(path.length)
          : token;
      }

      return (moves.get(path) ?? path) + token.slice(path.length);
    },
  );
}

async function transformedTree(
  before: Tree,
  pairs: readonly Move[],
): Promise<Tree> {
  validateMoves(before, pairs);
  const moves = new Map(pairs);

  const after = new Map(
    [...before].map(([path, entry]) => [moves.get(path) ?? path, entry]),
  );

  const files = [...before.keys()].filter(
    (path) =>
      code.test(path) &&
      ["100644", "100755"].includes(before.get(path)?.mode ?? ""),
  );

  const virtualRoot = "/__stargate_module_move__";
  const config = `${virtualRoot}/tsconfig.json`;
  const virtualFiles: Record<string, string> = {};

  for (const path of files) {
    const bytes = before.get(path)?.bytes ?? Buffer.alloc(0);
    const text = bytes.toString("utf8");

    if (!Buffer.from(text).equals(bytes)) {
      throw new Error(`Module is not UTF-8: ${path}`);
    }

    virtualFiles[`${virtualRoot}/${path}`] = text;
  }

  virtualFiles[config] = JSON.stringify({
    files,
    compilerOptions: {
      noLib: true,
      noResolve: true,
      allowJs: true,
      jsx: "preserve",
    },
  });

  const api = new API({
    cwd: virtualRoot,
    fs: createVirtualFileSystem(virtualFiles),
  });

  try {
    const snapshot = await api.updateSnapshot({ openProjects: [config] });
    const project = snapshot.getProject(config);

    if (!project) {
      throw new Error("TypeScript could not open the module tree");
    }

    for (const file of files) {
      const source = await project.program.getSourceFile(
        `${virtualRoot}/${file}`,
      );

      if (
        !source ||
        (
          await project.program.getSyntacticDiagnostics(
            `${virtualRoot}/${file}`,
          )
        ).length > 0
      ) {
        throw new Error(`Cannot parse module: ${file}`);
      }

      let text = virtualFiles[`${virtualRoot}/${file}`] ?? "";
      const edits: { start: number; end: number; value: string }[] = [];

      const visit = (node: Node): void => {
        const literal =
          isImportDeclaration(node) || isExportDeclaration(node)
            ? node.moduleSpecifier
            : isCallExpression(node) &&
                node.expression.kind === SyntaxKind.ImportKeyword
              ? node.arguments[0]
              : isImportTypeNode(node) && isLiteralTypeNode(node.argument)
                ? node.argument.literal
                : undefined;

        if (literal && isStringLiteralLikeNode(literal)) {
          const value = rewriteSpecifier(
            before,
            after,
            moves,
            file,
            literal.text,
          );

          if (value !== literal.text) {
            edits.push({
              start: skipTrivia(text, literal.pos) + 1,
              end: literal.end - 1,
              value,
            });
          }
        }

        node.forEachChild(visit);
      };

      visit(source);

      for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
        text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
      }

      const entry = before.get(file);

      if (entry) {
        after.set(moves.get(file) ?? file, {
          ...entry,
          bytes: Buffer.from(text),
        });
      }
    }
  } finally {
    await api.close();
  }

  for (const [path, entry] of before) {
    if (
      !path.startsWith("docs/") &&
      !["AGENTS.md", "README.md", "CONTRIBUTING.md"].includes(path)
    ) {
      continue;
    }

    if (!["100644", "100755"].includes(entry.mode) || entry.bytes.includes(0)) {
      continue;
    }

    const text = entry.bytes.toString("utf8");

    if (Buffer.from(text).equals(entry.bytes)) {
      after.set(path, {
        ...entry,
        bytes: Buffer.from(rewriteDocs(text, path, moves)),
      });
    }
  }

  return after;
}

function equal(a: Entry | undefined, b: Entry | undefined) {
  return (
    a?.mode === b?.mode &&
    (a === b || !!a?.bytes.equals(b?.bytes ?? Buffer.alloc(0)))
  );
}

async function pathStat(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  });
}

async function safePath(root: string, path: string) {
  let current = root;
  const parts = path.split("/");

  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i] ?? "");
    const stat = await pathStat(current);

    if (
      stat?.isSymbolicLink() ||
      (stat && i < parts.length - 1 && !stat.isDirectory())
    ) {
      throw new Error(`Unsafe path: ${path}`);
    }
  }
}

async function workingEntry(
  root: string,
  path: string,
): Promise<Entry | undefined> {
  await safePath(root, path);
  const stat = await pathStat(join(root, path));

  if (!stat) {
    return undefined;
  }

  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${path}`);
  }

  return {
    mode: stat.mode & 0o111 ? "100755" : "100644",
    bytes: await readFile(join(root, path)),
  };
}

async function checkTree(
  root: string,
  before: Tree,
  after: Tree,
  pairs: readonly Move[],
) {
  const actual = new Set([
    ...paths(git(root, ["ls-files", "--cached", "-z"])),
    ...paths(git(root, ["ls-files", "--others", "--exclude-standard", "-z"])),
  ]);

  for (const path of new Set([...before.keys(), ...after.keys(), ...actual])) {
    const expected = after.get(path);

    if (expected?.mode === "160000" || expected?.mode === "120000") {
      // Unchanged links/submodules are compared by Git, never followed.
      if (
        !equal(before.get(path), expected) ||
        git(root, [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--ignore-submodules=none",
          "--",
          path,
        ]).length > 0
      ) {
        throw new Error(`Unexpected change: ${path}`);
      }

      continue;
    }

    if (!equal(await workingEntry(root, path), expected)) {
      throw new Error(`Unexpected change: ${path}`);
    }
  }

  const index = paths(git(root, ["ls-files", "--stage", "-z"]));

  const movedOriginals = new Map(
    pairs.map(([oldPath, newPath]) => [newPath, before.get(oldPath)]),
  );

  const indexedPaths = new Set<string>();

  for (const line of index) {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(line);

    if (!match) {
      throw new Error("Unsupported Git index entry");
    }

    const [, mode = "", oid = "", stage = "", path = ""] = match;

    if (stage !== "0") {
      throw new Error("Resolve index conflicts before checking moves");
    }

    indexedPaths.add(path);

    const allowed = [
      before.get(path),
      after.get(path),
      movedOriginals.get(path),
    ].some((entry) => {
      if (!entry || entry.mode !== mode) {
        return false;
      }

      const hash =
        mode === "160000"
          ? entry.bytes.toString()
          : createHash(oid.length === 64 ? "sha256" : "sha1")
              .update(`blob ${entry.bytes.length}\0`)
              .update(entry.bytes)
              .digest("hex");

      return hash === oid;
    });

    if (!allowed) {
      throw new Error(`Unexpected staged change: ${path}`);
    }
  }

  for (const path of before.keys()) {
    if (after.has(path) && !indexedPaths.has(path)) {
      throw new Error(`Unexpected staged deletion: ${path}`);
    }
  }
}

async function applyTree(
  root: string,
  before: Tree,
  after: Tree,
  pairs: readonly Move[],
) {
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
    (path) => !equal(before.get(path), after.get(path)),
  );

  const indexPath = resolve(
    root,
    git(root, ["rev-parse", "--git-path", "index"]).toString().trim(),
  );

  const lock = await open(`${indexPath}.lock`, "wx");
  const privateIndex = `${indexPath}.module-move-${randomUUID()}`;
  const created: string[] = [];
  const moved: Move[] = [];
  const written: string[] = [];
  let published = false;

  try {
    await copyFile(indexPath, privateIndex, constants.COPYFILE_EXCL);

    const dirty = new Set(
      paths(
        git(root, [
          "diff",
          "--cached",
          "--name-only",
          "--no-renames",
          "-z",
          "HEAD",
        ]),
      ),
    );

    for (const path of changed) {
      if (
        dirty.has(path) ||
        !equal(await workingEntry(root, path), before.get(path))
      ) {
        throw new Error(`Affected path is dirty or occupied: ${path}`);
      }
    }

    for (const [, newPath] of pairs) {
      const missing: string[] = [];
      let parent = dirname(join(root, newPath));

      while (parent !== root && !(await pathStat(parent))) {
        missing.push(parent);
        parent = dirname(parent);
      }

      for (const path of missing.toReversed()) {
        await mkdir(path);
        created.push(path);
      }
    }

    for (const [oldPath, newPath] of pairs) {
      moved.push([oldPath, newPath]);
      git(root, ["mv", "--", oldPath, newPath], undefined, privateIndex);
    }

    for (const path of changed) {
      const entry = after.get(path);

      if (!entry) {
        continue;
      }

      written.push(path);
      await Bun.write(join(root, path), entry.bytes);
    }

    await lock.writeFile(await readFile(privateIndex));
    await lock.close();
    await rename(`${indexPath}.lock`, indexPath);
    published = true;
  } catch (error) {
    for (const path of written.toReversed()) {
      const oldPath =
        pairs.find(([, destination]) => destination === path)?.[0] ?? path;

      const entry = before.get(oldPath);

      if (entry) {
        await Bun.write(join(root, path), entry.bytes);
      }
    }

    for (const [oldPath, newPath] of moved.toReversed()) {
      const destination = await pathStat(join(root, newPath));

      if (!destination) {
        continue;
      }

      if (await pathStat(join(root, oldPath))) {
        throw new Error(
          `Rollback conflict; preserve both paths: ${oldPath}, ${newPath}`,
          { cause: error },
        );
      }

      await rename(join(root, newPath), join(root, oldPath));
    }

    for (const path of created.toReversed()) {
      await rmdir(path);
    }

    throw error;
  } finally {
    await lock.close();

    if (!published) {
      await rm(`${indexPath}.lock`, { force: true });
    }

    await rm(privateIndex, { force: true });
  }
}

/** Apply declared moves, or compare their exact generated tree with the checkout. */
export async function moveModules(
  rootInput: string,
  pairs: readonly Move[],
  options: { check?: boolean; base?: string } = {},
): Promise<void> {
  const root = resolve(rootInput);

  if (
    ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"].some(
      (key) => process.env[key],
    )
  ) {
    throw new Error("Custom Git index/worktree environment is not supported");
  }

  if (git(root, ["rev-parse", "--show-toplevel"]).toString().trim() !== root) {
    throw new Error("Run from the repository root");
  }

  if (options.base && !options.check) {
    throw new Error("--base requires --check");
  }

  const ref = git(root, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${options.base ?? "HEAD"}^{tree}`,
  ])
    .toString()
    .trim();

  const before = readTree(root, ref);
  const after = await transformedTree(before, pairs);

  if (options.check) {
    await checkTree(root, before, after, pairs);
  } else {
    await applyTree(root, before, after, pairs);
  }
}

const help = `Usage: bun scripts/move-modules.ts [--check [--base REF]] OLD NEW [OLD NEW ...]

Move tracked modules in src, plugins, tests, scripts, or perf with git mv. Update relative
imports/exports/literal import() and exact src/... documentation references,
including canonical document-relative ../src/... links. Paths must be canonical,
retain their extension and avoid locked entries.
Resolution supports files and index modules, not directory package metadata or
ambiguous source/runtime extension substitution. Unsupported resolution fails closed.
Apply refuses dirty affected paths; unrelated changes are preserved. Do not edit
the checkout concurrently. Code edits remain unstaged after git mv.
--check is read-only: require the exact transformed base tree (default HEAD),
including modes, and reject unrelated changes. It does not prove runtime parity.
--help shows this text. No dependencies are installed automatically.`;

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);

    if (args.includes("--help")) {
      console.log(help);
    } else {
      let check = false;
      let base: string | undefined;
      const positional: string[] = [];

      for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? "";

        if (arg === "--check") {
          check = true;
        } else if (arg === "--base") {
          base = args[++i];

          if (!base || base.startsWith("--")) {
            throw new Error("--base needs a reference");
          }
        } else if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        } else {
          positional.push(arg);
        }
      }

      if (positional.length === 0 || positional.length % 2) {
        throw new Error("Supply old/new path pairs; use --help");
      }

      const pairs: Move[] = [];

      for (let i = 0; i < positional.length; i += 2) {
        pairs.push([positional[i] ?? "", positional[i + 1] ?? ""]);
      }

      await moveModules(process.cwd(), pairs, {
        check,
        ...(base && { base }),
      });
      console.log(
        check
          ? "Module move tree matches exactly."
          : "Module moves applied; review the staged renames and unstaged rewrites.",
      );
    }
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Module move failed",
    );
    process.exitCode = 1;
  }
}
