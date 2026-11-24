import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type Node,
  type SourceFile,
  SyntaxKind,
  createScanner,
  getTokenPosOfNode,
  isBigIntLiteral,
  isBlock,
  isExpressionStatement,
  isFunctionLikeDeclaration,
  isNumericLiteral,
  isRegularExpressionLiteral,
  isSourceFile,
  isStringLiteral,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isTemplateLiteralToken,
  isTemplateSpan,
} from "typescript/unstable/ast";
import { API } from "typescript/unstable/async";
import { createVirtualFileSystem } from "typescript/unstable/fs";

const value = (text: string) => BigInt(text.replaceAll("_", "").slice(0, -1));

const shebang = (text: string) => /^#![^\r\n]*/.exec(text)?.[0] ?? "";

type Difference = { reason: string; before: string; after: string };

type Result = { equal: boolean; reasons: string[]; differences: Difference[] };

type Pair = { path: string; before: string; after: string };

function directiveStrings(source: SourceFile) {
  const found = new Set<Node>();

  const queue: { node: Node; functionBody: boolean }[] = [
    { node: source, functionBody: false },
  ];

  for (let next = queue.pop(); next; next = queue.pop()) {
    const { node, functionBody } = next;

    if (isSourceFile(node) || (functionBody && isBlock(node))) {
      for (const statement of node.statements) {
        if (
          !isExpressionStatement(statement) ||
          !isStringLiteral(statement.expression)
        ) {
          break;
        }

        found.add(statement.expression);
      }
    }

    node.forEachChild((child) => {
      queue.push({
        node: child,
        functionBody: isFunctionLikeDeclaration(node) && node.body === child,
      });
    });
  }

  return found;
}

function tokens(gap: string) {
  const scanner = createScanner(true, undefined, gap);
  const found: string[] = [];

  let last = 0;

  while (scanner.scan() !== SyntaxKind.EndOfFile) {
    const end = scanner.getTokenEnd();

    if (end <= last || end > gap.length) {
      throw new Error("Non-progressing TypeScript token scanner");
    }

    last = end;
    found.push(scanner.getTokenText());
  }

  return found;
}

function children(node: Node) {
  const found: Node[] = [];
  node.forEachChild((child) => {
    found.push(child);
  });

  return found;
}

function gaps(node: Node, source: SourceFile, descendants: Node[]) {
  let cursor = getTokenPosOfNode(node, source);
  const uncovered: string[][] = [];

  for (const child of descendants) {
    const start = getTokenPosOfNode(child, source);

    if (start < cursor || child.end > node.end) {
      throw new Error("TypeScript returned overlapping child source spans");
    }

    uncovered.push(tokens(source.text.slice(cursor, start)));
    cursor = child.end;
  }

  const tail = tokens(source.text.slice(cursor, node.end));

  const close =
    node.kind === SyntaxKind.ArrayLiteralExpression
      ? "]"
      : node.kind === SyntaxKind.ObjectLiteralExpression
        ? "}"
        : undefined;

  // TS does not represent a single trailing delimiter as a child. Unlike an
  // Array hole it may differ solely because the emitter wrapped the literal.
  if (
    close &&
    descendants.length > 0 &&
    descendants.at(-1)?.kind !== SyntaxKind.OmittedExpression &&
    tail[0] === "," &&
    tail[1] === close &&
    tail.length === 2
  ) {
    tail.shift();
  }

  uncovered.push(tail);

  return JSON.stringify(uncovered);
}

function inTaggedTemplate(node: Node, child: Node, tagged: boolean) {
  if (isTaggedTemplateExpression(node)) {
    return child === node.template;
  }

  if (tagged && isTemplateExpression(node)) {
    return true;
  }

  return tagged && isTemplateSpan(node) && child === node.literal;
}

function literal(source: SourceFile, node: Node) {
  return source.text.slice(getTokenPosOfNode(node, source), node.end);
}

function compareTrees(left: SourceFile, right: SourceFile): Result {
  const reasons = new Set<string>();
  const differences: Difference[] = [];
  const directivesLeft = directiveStrings(left);
  const directivesRight = directiveStrings(right);

  const stack: { a: Node; b: Node; tagged: boolean }[] = [
    { a: left, b: right, tagged: false },
  ];

  function difference(reason: string, before: string, after: string) {
    differences.push({ reason, before, after });
  }

  function visit(a: Node, b: Node, tagged: boolean) {
    if (a.kind !== b.kind) {
      difference("node kind", SyntaxKind[a.kind], SyntaxKind[b.kind]);

      return;
    }

    const x = literal(left, a);
    const y = literal(right, b);

    if (isRegularExpressionLiteral(a) && isRegularExpressionLiteral(b)) {
      if (x !== y) {
        difference("regex", x, y);
      }

      return;
    }

    if (directivesLeft.has(a) || directivesRight.has(b)) {
      if (x !== y || directivesLeft.has(a) !== directivesRight.has(b)) {
        difference("directive", x, y);
      }

      return;
    }

    if (isNumericLiteral(a) && isNumericLiteral(b)) {
      if (!Object.is(Number(a.text), Number(b.text))) {
        difference("numeric value", x, y);
      } else if (x !== y) {
        reasons.add("numeric form");
      }

      return;
    }

    if (isBigIntLiteral(a) && isBigIntLiteral(b)) {
      if (value(x) !== value(y)) {
        difference("bigint value", x, y);
      } else if (x !== y) {
        reasons.add("numeric form");
      }

      return;
    }

    if (
      (isStringLiteral(a) && isStringLiteral(b)) ||
      (isTemplateLiteralToken(a) && isTemplateLiteralToken(b))
    ) {
      if (a.text !== b.text) {
        difference("cooked value", x, y);
      } else if (tagged && x !== y) {
        difference("tagged raw value", x, y);
      } else if (x !== y) {
        reasons.add("escape form");
      }

      return;
    }

    const ac = children(a);
    const bc = children(b);

    if (ac.length !== bc.length) {
      difference(
        "child count",
        `${SyntaxKind[a.kind]}:${ac.length}`,
        `${SyntaxKind[b.kind]}:${bc.length}`,
      );

      return;
    }

    if (ac.length === 0) {
      if (x !== y) {
        difference("token text", x, y);
      }

      return;
    }

    // Preserve tokens that TS stores outside the child walk, such as unary
    // Operators and declaration keywords. Only trivia is ignored here.
    const ag = gaps(a, left, ac);
    const bg = gaps(b, right, bc);

    if (ag !== bg) {
      difference("structural tokens", ag, bg);
    }

    for (const [index, child] of ac.entries()) {
      const other = bc[index];

      if (!other) {
        throw new Error("TypeScript child count changed during comparison");
      }

      stack.push({
        a: child,
        b: other,
        tagged: inTaggedTemplate(a, child, tagged),
      });
    }
  }

  const before = shebang(left.text);
  const after = shebang(right.text);

  if (before !== after) {
    difference("shebang", before, after);
  }

  for (let next = stack.pop(); next; next = stack.pop()) {
    visit(next.a, next.b, next.tagged);
  }

  return {
    equal: differences.length === 0,
    differences,
    reasons:
      reasons.size > 0
        ? [...reasons].toSorted()
        : differences.length > 0
          ? []
          : ["layout"],
  };
}

async function comparePair({ path, before, after }: Pair): Promise<Result> {
  if (before === after) {
    return { equal: true, reasons: ["raw"], differences: [] };
  }

  const suffix = /\.[cm]?jsx?$/.exec(path)?.[0] ?? ".js";

  const left = `/before${suffix}`;
  const right = `/after${suffix}`;

  const config = "/tsconfig.json";

  const api = new API({
    cwd: "/",
    fs: createVirtualFileSystem({
      [left]: before,
      [right]: after,
      [config]: JSON.stringify({
        compilerOptions: {
          allowJs: true,
          checkJs: false,
          noLib: true,
          noResolve: true,
          jsx: "preserve",
          target: "esnext",
        },
        files: [left, right],
      }),
    }),
  });

  try {
    const snapshot = await api.updateSnapshot({ openProjects: [config] });

    try {
      const program = snapshot.getProjects()[0]?.program;

      if (!program) {
        throw new Error("Could not load TypeScript's JS parser");
      }

      const a = await program.getSourceFile(left);
      const b = await program.getSourceFile(right);

      if (!a || !b || a.text !== before || b.text !== after) {
        throw new Error(`Parser input mismatch: ${path}`);
      }

      if (
        (await program.getSyntacticDiagnostics(left)).length > 0 ||
        (await program.getSyntacticDiagnostics(right)).length > 0
      ) {
        return {
          equal: false,
          reasons: [],
          differences: [
            { reason: "invalid JavaScript", before: left, after: right },
          ],
        };
      }

      return compareTrees(a, b);
    } finally {
      await snapshot.dispose();
    }
  } finally {
    await api.close();
  }
}

export function compareJavaScript(before: string, after: string) {
  return comparePair({ path: "fixture.js", before, after });
}

async function listDirectory(root: string, dir = ""): Promise<string[]> {
  const files: string[] = [];

  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      files.push(...(await listDirectory(root, path)));
    } else if (/\.(?:[cm]?js|jsx)$/.test(path)) {
      if (!entry.isFile()) {
        throw new Error(`Not a regular JS output: ${path}`);
      }

      files.push(path);
    }
  }

  return files;
}

type CompilerConfig = { compilerOptions?: Record<string, unknown> };

async function capture(output: string) {
  const root = process.cwd();
  const outDir = resolve(root, output);

  const config = JSON.parse(
    await readFile("tsconfig.json", "utf8"),
  ) as CompilerConfig;

  // The comparison must not silently reuse stale compiler output.
  await mkdir(outDir);
  const scratch = await mkdtemp(join(tmpdir(), "stargate-ts-emit-"));

  try {
    const path = join(scratch, "tsconfig.json");
    await writeFile(
      path,
      JSON.stringify({
        ...config,
        compilerOptions: {
          ...config.compilerOptions,
          rootDir: root,
          outDir,
          typeRoots: [join(root, "node_modules/@types")],
          noCheck: true,
          noEmit: false,
          noEmitOnError: false,
          removeComments: true,
          sourceMap: false,
          inlineSourceMap: false,
        },
        include: ["src", "scripts", "perf", "tests"].map((folder) =>
          join(root, folder, "**/*.ts"),
        ),
      }),
    );
    execFileSync(process.execPath, ["./node_modules/.bin/tsc", "-p", path], {
      stdio: "inherit",
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const [, , a, b, ...extra] = process.argv;

  if (!a || !b || extra.length > 0) {
    throw new Error(
      "Usage: bun scripts/compare-js-emit.ts --capture OUT_DIR | BEFORE_DIR AFTER_DIR",
    );
  }

  if (a === "--capture") {
    await capture(b);

    return;
  }

  const before = (await listDirectory(a)).toSorted();
  const after = new Set(await listDirectory(b));

  if (
    before.length === 0 ||
    before.length !== after.size ||
    before.some((path) => !after.has(path))
  ) {
    throw new Error("JavaScript output inventories are empty or differ");
  }

  const files: [string, Result][] = [];
  const counts: Record<string, number> = {};
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

  for (const path of before) {
    const result = await comparePair({
      path,
      before: decoder.decode(await readFile(join(a, path))),
      after: decoder.decode(await readFile(join(b, path))),
    });

    files.push([path, result]);
    const kind = result.equal ? result.reasons.join(" + ") : "fail";
    counts[kind] = (counts[kind] ?? 0) + 1;
  }

  console.log(
    JSON.stringify({ counts, files: Object.fromEntries(files) }, null, 2),
  );

  if (counts["fail"]) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
