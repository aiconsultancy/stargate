import { spawnSync } from "node:child_process";
import { posix } from "node:path";
import { Schema } from "effect";
import {
  createScanner,
  getTokenPosOfNode,
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isStringLiteralLikeNode,
  type Node,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";
import { API } from "typescript/unstable/async";
import { createVirtualFileSystem } from "typescript/unstable/fs";

function git(...args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error("Git comparison failed");
  return result.stdout;
}

function scoped(path: string): boolean {
  return /^(src|scripts|perf)\/.*\.ts$/.test(path);
}

const declarationsPath = "scripts/hooks/touched-zod-changes.json";
// Count additions plus removals: a ten-line replacement consumes all 20.
const changedLineLimit = 20;
const declarationSchema = Schema.Array(
  Schema.Struct({
    path: Schema.String.check(
      Schema.isPattern(/^(src|scripts|perf)\/[A-Za-z0-9_./-]+\.ts(?![\s\S])/),
      Schema.isMaxLength(256),
    ),
    issue: Schema.String.check(Schema.isPattern(/^NET-[1-9][0-9]*(?![\s\S])/)),
    reason: Schema.String.check(
      Schema.isPattern(/^[^\r\n\s][^\r\n\u2028\u2029]*(?![\s\S])/),
      Schema.isMaxLength(200),
    ),
  }),
);

function declarations(
  ancestor: string,
  baseFiles: Map<string, string>,
  headFiles: Map<string, string>,
) {
  const paths = new Set<string>();
  if (headFiles.get(declarationsPath) !== "100644")
    throw new Error("head declared-change list must exist as a regular file");
  try {
    function read(revision: string) {
      const entries = Schema.decodeUnknownSync(declarationSchema, {
        onExcessProperty: "error",
      })(JSON.parse(git("show", `${revision}:${declarationsPath}`)));
      const seen = new Set<string>();
      for (const entry of entries) {
        if (posix.normalize(entry.path) !== entry.path || seen.has(entry.path))
          throw new Error("invalid declared path");
        seen.add(entry.path);
      }
      return entries;
    }
    const entries = read("HEAD");
    if (
      baseFiles.has(declarationsPath) &&
      baseFiles.get(declarationsPath) !== "100644"
    )
      throw new Error("base declared-change list must be a regular file");
    const previous = new Map(
      (baseFiles.has(declarationsPath) ? read(ancestor) : []).map((entry) => [
        entry.path,
        entry,
      ]),
    );
    for (const entry of entries) {
      if (
        !["100644", "100755"].includes(baseFiles.get(entry.path) ?? "") ||
        !["100644", "100755"].includes(headFiles.get(entry.path) ?? "")
      )
        throw new Error("invalid declared path");
      const old = previous.get(entry.path);
      if (!old || old.issue !== entry.issue || old.reason !== entry.reason)
        paths.add(entry.path);
    }
  } catch {
    throw new Error("invalid declared-change list; refusing to verify");
  }
  return paths;
}

function tree(revision: string): Map<string, string> {
  return new Map(
    git("ls-tree", "-rz", "--full-tree", revision)
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const tab = entry.indexOf("\t");
        return [entry.slice(tab + 1), entry.slice(0, tab).split(" ")[0] ?? ""];
      }),
  );
}

// Do not guess package, alias, JS-to-TS or platform-dependent resolution.
// Count all common file/index candidates so ambiguous paths fail closed.
function resolveRelative(
  path: string,
  specifier: string,
  files: Map<string, string>,
) {
  if (!/^\.\.?\//.test(specifier)) return undefined;
  const target = posix.normalize(posix.join(posix.dirname(path), specifier));
  if (target.startsWith("../")) return undefined;
  const candidates = posix.extname(target)
    ? [target]
    : [
        target,
        ...[".ts", ".tsx", ".js", ".jsx", ".json"].flatMap((extension) => [
          target + extension,
          `${target}/index${extension}`,
        ]),
      ];
  const matches = candidates.filter((candidate) => files.has(candidate));
  const match = matches[0];
  return matches.length === 1 &&
    match?.endsWith(".ts") &&
    ["100644", "100755"].includes(files.get(match) ?? "")
    ? match
    : undefined;
}

type ModuleSpan = { start: number; end: number; value: string };

function inspect(source: SourceFile, movableDynamicImports = false) {
  const modules: ModuleSpan[] = [];
  const zodDeclarations: string[] = [];
  let zod = false;
  let unknownLoader = false;
  let relativeLoader = false;
  function module(node: Node | undefined, movable: boolean, owner: Node) {
    if (!node || !isStringLiteralLikeNode(node)) {
      unknownLoader = true;
      return;
    }
    const value = node.text;
    zod ||= value === "zod" || value.startsWith("zod/");
    if (value === "zod" || value.startsWith("zod/"))
      zodDeclarations.push(
        source.text.slice(getTokenPosOfNode(owner, source), owner.end),
      );
    if (movable) {
      modules.push({
        start: getTokenPosOfNode(node, source),
        end: node.end,
        value,
      });
    } else {
      relativeLoader ||= /^\.\.?\//.test(value);
    }
  }
  function visit(node: Node) {
    if (isImportDeclaration(node)) module(node.moduleSpecifier, true, node);
    else if (isExportDeclaration(node) && node.moduleSpecifier)
      module(node.moduleSpecifier, true, node);
    else if (
      isImportEqualsDeclaration(node) &&
      isExternalModuleReference(node.moduleReference)
    ) {
      module(node.moduleReference.expression, false, node);
    } else if (isImportTypeNode(node) && isLiteralTypeNode(node.argument)) {
      module(node.argument.literal, false, node);
    } else if (
      isCallExpression(node) &&
      (node.expression.kind === SyntaxKind.ImportKeyword ||
        (isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      module(
        node.arguments[0],
        movableDynamicImports &&
          node.expression.kind === SyntaxKind.ImportKeyword,
        node,
      );
    }
    node.forEachChild(visit);
  }
  visit(source);
  return { modules, zod, zodDeclarations, unknownLoader, relativeLoader };
}

function declaredChange(
  before: SourceFile,
  after: SourceFile,
  oldPath: string,
  path: string,
  ancestor: string,
  declared: Set<string>,
) {
  if (oldPath !== path || !declared.has(path)) return false;
  const old = inspect(before);
  const next = inspect(after);
  if (
    !old.zod ||
    old.unknownLoader ||
    next.unknownLoader ||
    JSON.stringify(old.zodDeclarations) !== JSON.stringify(next.zodDeclarations)
  )
    return false;
  const parts = git(
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--numstat",
    ancestor,
    "HEAD",
    "--",
    path,
  )
    .trimEnd()
    .split("\t");
  const [added, removed, file] = parts;
  return (
    parts.length === 3 &&
    file === path &&
    /^\d+$/.test(added ?? "") &&
    /^\d+$/.test(removed ?? "") &&
    Number(added) + Number(removed) <= changedLineLimit
  );
}

/** Only mechanical() uses this: tokenize one static declaration, not the file. */
function declarationTokens(source: SourceFile, node: Node, module: ModuleSpan) {
  try {
    const scanner = createScanner(
      false,
      source.languageVariant,
      source.text,
      getTokenPosOfNode(node, source),
      node.end - getTokenPosOfNode(node, source),
    );
    let braceEnd: number | undefined;
    const namedBrace = (child: Node): void => {
      if (
        child.kind === SyntaxKind.NamedImports ||
        child.kind === SyntaxKind.NamedExports
      )
        braceEnd = child.end - 1;
      child.forEachChild(namedBrace);
    };
    namedBrace(node);
    const tokens: { kind: SyntaxKind; text: string; start: number }[] = [];
    for (;;) {
      const kind = scanner.scan();
      if (scanner.isUnterminated() || kind === SyntaxKind.Unknown)
        return undefined;
      if (kind === SyntaxKind.EndOfFile) break;
      // Never silently skip comments in a declaration whose layout changes.
      if (
        kind === SyntaxKind.SingleLineCommentTrivia ||
        kind === SyntaxKind.MultiLineCommentTrivia
      )
        return undefined;
      if (
        kind === SyntaxKind.WhitespaceTrivia ||
        kind === SyntaxKind.NewLineTrivia
      )
        continue;
      tokens.push({
        kind,
        text:
          scanner.getTokenStart() === module.start &&
          scanner.getTokenEnd() === module.end
            ? "<module>"
            : scanner.getTokenText(),
        start: scanner.getTokenStart(),
      });
    }
    const close = tokens.findIndex(
      (token) =>
        token.kind === SyntaxKind.CloseBraceToken && token.start === braceEnd,
    );
    if (close > 0 && tokens[close - 1]?.kind === SyntaxKind.CommaToken)
      tokens.splice(close - 1, 1);
    return tokens.map(({ kind, text }) => [kind, text]);
  } catch {
    return undefined;
  }
}

function mechanical(
  before: SourceFile,
  after: SourceFile,
  oldPath: string,
  newPath: string,
  baseFiles: Map<string, string>,
  headFiles: Map<string, string>,
  renames: Map<string, string>,
): boolean {
  const old = inspect(before, oldPath !== newPath);
  const next = inspect(after, oldPath !== newPath);
  if (
    !old.zod ||
    old.unknownLoader ||
    next.unknownLoader ||
    old.modules.length !== next.modules.length ||
    (oldPath !== newPath && (old.relativeLoader || next.relativeLoader))
  )
    return false;
  let oldCursor = 0;
  let newCursor = 0;
  for (let index = 0; index < old.modules.length; index++) {
    const left = old.modules[index];
    const right = next.modules[index];
    if (!left || !right) return false;
    const oldRaw = before.text.slice(left.start, left.end);
    const newRaw = after.text.slice(right.start, right.end);
    if (/^\.\.?\//.test(left.value)) {
      const oldTarget = resolveRelative(oldPath, left.value, baseFiles);
      const newTarget = resolveRelative(newPath, right.value, headFiles);
      if (
        !oldTarget ||
        !newTarget ||
        (renames.get(oldTarget) ?? oldTarget) !== newTarget
      )
        return false;
      // A rewritten literal changes only its contents, not quote kind/escapes.
      if (
        oldRaw !== newRaw &&
        (oldRaw !== `${oldRaw[0]}${left.value}${oldRaw[0]}` ||
          newRaw !== `${oldRaw[0]}${right.value}${oldRaw[0]}` ||
          (oldPath === newPath && !renames.has(oldTarget)))
      )
        return false;
    } else if (oldRaw !== newRaw) return false;
    if (oldPath !== newPath && left.value !== right.value) {
      const declaration = (source: SourceFile, span: ModuleSpan) =>
        source.statements.find(
          (node) =>
            (isImportDeclaration(node) || isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            getTokenPosOfNode(node.moduleSpecifier, source) === span.start &&
            node.moduleSpecifier.end === span.end,
        );
      const oldDeclaration = declaration(before, left);
      const newDeclaration = declaration(after, right);
      if (oldDeclaration && newDeclaration) {
        const oldTokens = declarationTokens(before, oldDeclaration, left);
        const newTokens = declarationTokens(after, newDeclaration, right);
        if (
          oldTokens &&
          newTokens &&
          before.text.slice(
            oldCursor,
            getTokenPosOfNode(oldDeclaration, before),
          ) ===
            after.text.slice(
              newCursor,
              getTokenPosOfNode(newDeclaration, after),
            ) &&
          JSON.stringify(oldTokens) === JSON.stringify(newTokens)
        ) {
          oldCursor = oldDeclaration.end;
          newCursor = newDeclaration.end;
          continue;
        }
      }
    }
    if (
      before.text.slice(oldCursor, left.start) !==
      after.text.slice(newCursor, right.start)
    )
      return false;
    oldCursor = left.end;
    newCursor = right.end;
  }
  // Preserve every byte outside the verified declaration/literal spans.
  return before.text.slice(oldCursor) === after.text.slice(newCursor);
}

async function check(base: string): Promise<void> {
  let revision: string;
  try {
    revision = git(
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${base}^{commit}`,
    ).trim();
  } catch {
    throw new Error(`cannot resolve base ${base}; refusing to verify.`);
  }
  let ancestor: string;
  let changes: string[];
  try {
    ancestor = git("merge-base", revision, "HEAD").trim();
    changes = git(
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-status",
      "-M50%",
      "-z",
      ancestor,
      "HEAD",
    ).split("\0");
  } catch {
    throw new Error(`cannot compare with ${base}; refusing to verify.`);
  }
  const baseFiles = tree(ancestor);
  const headFiles = tree("HEAD");
  const renames = new Map<string, string>();
  const touched: { path: string; oldPath: string | undefined }[] = [];
  for (let index = 0; index < changes.length - 1;) {
    const status = changes[index++];
    const oldPath = changes[index++];
    if (!status || !oldPath) throw new Error("invalid Git comparison");
    const path = status.startsWith("R") ? changes[index++] : oldPath;
    if (!path) throw new Error("invalid Git rename comparison");
    if (status.startsWith("R")) renames.set(oldPath, path);
    if (status !== "D" && scoped(path))
      touched.push({
        path,
        oldPath: status === "M" || status.startsWith("R") ? oldPath : undefined,
      });
  }
  const declared = declarations(ancestor, baseFiles, headFiles);
  if (!touched.length) return;
  const sources: Record<string, string> = {};
  function addSource(rev: string, path: string) {
    const files = rev === "HEAD" ? headFiles : baseFiles;
    if (!["100644", "100755"].includes(files.get(path) ?? "")) {
      throw new Error(
        "changed source is not a regular file; refusing to verify.",
      );
    }
    const key = `/touched-zod/file-${Object.keys(sources).length}.ts`;
    sources[key] = git("show", `${rev}:${path}`);
    return key;
  }
  const pairs = touched.map(({ path, oldPath }) => ({
    path,
    oldPath,
    after: addSource("HEAD", path),
    before:
      oldPath &&
      scoped(oldPath) &&
      ["100644", "100755"].includes(baseFiles.get(oldPath) ?? "")
        ? addSource(ancestor, oldPath)
        : undefined,
  }));
  const config = "/touched-zod/tsconfig.json";
  const api = new API({
    cwd: "/",
    fs: createVirtualFileSystem({
      ...sources,
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true },
        files: Object.keys(sources),
      }),
    }),
  });
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [config] });
    try {
      const program = snapshot.getProjects()[0]?.program;
      if (!program || (await program.getSyntacticDiagnostics()).length)
        throw new Error("cannot parse changed source; refusing to verify.");
      const violations: string[] = [];
      for (const pair of pairs) {
        const after = await program.getSourceFile(pair.after);
        const before = pair.before
          ? await program.getSourceFile(pair.before)
          : undefined;
        if (!after) throw new Error("cannot read parsed source");
        if (
          after.text !== sources[pair.after] ||
          (before && pair.before && before.text !== sources[pair.before])
        ) {
          throw new Error("parser changed source text; refusing to verify.");
        }
        const next = inspect(after);
        if (
          next.zod &&
          (!before ||
            !pair.oldPath ||
            (!mechanical(
              before,
              after,
              pair.oldPath,
              pair.path,
              baseFiles,
              headFiles,
              renames,
            ) &&
              !declaredChange(
                before,
                after,
                pair.oldPath,
                pair.path,
                ancestor,
                declared,
              )))
        )
          violations.push(pair.path);
      }
      if (violations.length)
        throw new Error(
          `this change touches files that still import zod:\n  ${violations.join("\n  ")}\n` +
            "Each touched file must migrate its Zod schemas to Effect Schema, or the touch must be reverted.\n" +
            "Only verified import/path moves or declared bounded restructure changes are exempt. See docs/effect-schema-migration.md.",
        );
    } finally {
      await snapshot.dispose();
    }
  } finally {
    await api.close();
  }
}

try {
  await check(process.argv[2] ?? "");
} catch (error) {
  console.error(
    `touched-zod: ${error instanceof Error ? error.message : "comparison failed"}`,
  );
  process.exitCode = 1;
}
