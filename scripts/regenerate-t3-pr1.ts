import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";

/** Any function can be called with any arguments; its result is unchecked. */
const callable = (value: unknown): value is (...args: unknown[]) => unknown =>
  typeof value === "function";

const isHardModeConfig = Schema.is(
  Schema.Struct({
    zod: Schema.Array(Schema.String),
    ignorePatterns: Schema.optional(Schema.Array(Schema.String)),
  }),
);

type Finding = { filename: string; labels: [{ span: { offset: number } }] };

const fixed = [
  "src/main.ts",
  "src/config.ts",
  "src/crew/plugin.ts",
  "src/fleet/plugin.ts",
];

const roots = ["src", "scripts", "perf"];

const categories = Object.fromEntries(
  [
    "correctness",
    "suspicious",
    "pedantic",
    "style",
    "perf",
    "restriction",
    "nursery",
  ].map((name) => [name, "off"]),
);

function git(...args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

function bun(...args: string[]): void {
  execFileSync(process.execPath, args, { stdio: "inherit" });
}

function digest(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function replace(file: string, from: string, to: string): void {
  const text = readFileSync(file, "utf8");
  const at = text.indexOf(from);

  if (at === -1 || text.includes(from, at + from.length))
    throw new Error(`Pattern drift: ${file}`);
  writeFileSync(file, text.slice(0, at) + to + text.slice(at + from.length));
}

function moveInlineComments(findings: Finding[]): void {
  const groups = new Map<string, number[]>();

  for (const { filename, labels } of findings) {
    groups.set(filename, [
      ...(groups.get(filename) ?? []),
      labels[0].span.offset,
    ]);
  }

  for (const [file, offsets] of groups) {
    let text = readFileSync(file, "utf8");
    const bytes = Buffer.from(text);

    if (file === "src/chat/attachments/store.ts") {
      replace(
        file,
        "    return row?.input_files\n      ? // Slack file IDs, or IRC FILEHOST URLs that the transport rechecks.",
        "    // Slack file IDs, or IRC FILEHOST URLs that the transport rechecks.\n    return row?.input_files\n      ?",
      );
      continue;
    }

    if (file === "src/dispatch/dispatcher.ts") {
      replace(
        file,
        '    const at =\n      tracked.state === "asking"',
        '    // A pending write is retried by every timer run; never spin for it.\n    const at =\n      tracked.state === "asking"',
      );
      replace(
        file,
        "            : // A pending write is retried by every timer run; never spin for it.\n",
        "            :\n",
      );
      continue;
    }

    for (const offset of offsets.toSorted((a, b) => b - a)) {
      const at = bytes.subarray(0, offset).toString().length;
      const start = text.lastIndexOf("\n", at - 1) + 1;
      const following = text.indexOf("\n", at);
      const end = following === -1 ? text.length : following;
      const code = text.slice(start, at);
      const comment = text.slice(at, end);
      const indent = /^\s*/.exec(code)?.[0] ?? "";

      if (
        !code.trim() ||
        !comment.startsWith("//") ||
        /eslint|biome|oxlint|oxfmt|@ts-|sourceMappingURL|istanbul|c8 ignore/.test(
          comment,
        )
      ) {
        throw new Error(
          `Not an ordinary movable line comment: ${file}:${offset}`,
        );
      }

      text = `${text.slice(0, start)}${indent}${comment}\n${code.trimEnd()}${text.slice(end)}`;
    }

    writeFileSync(file, text);
  }
}

async function regenerate(): Promise<void> {
  const [, , option, patch, ...extra] = process.argv;
  const top = git("rev-parse", "--show-prefix").trim();
  const branch = git("branch", "--show-current").trim();

  if (top || !branch || branch === "main" || branch === "master")
    throw new Error("Use a feature branch from the repository root");

  if (
    extra.length > 0 ||
    (option && option !== "--tool-patch" && option !== "--staged-candidate") ||
    (option === "--tool-patch") !== Boolean(patch)
  ) {
    throw new Error(
      "Usage: bun scripts/regenerate-t3-pr1.ts [--tool-patch /path/to/tool.patch | --staged-candidate]",
    );
  }

  const status = git("status", "--porcelain=v1", "--untracked-files=all");

  if (option === "--staged-candidate") {
    if (
      git("diff", "--name-only") ||
      status.split("\n").some((line) => line.startsWith("??"))
    ) {
      throw new Error(
        "Staged-candidate mode requires no unstaged or untracked changes",
      );
    }
  } else if (status) {
    throw new Error("Start from a clean feature branch");
  }

  if (patch) {
    if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main"))
      throw new Error("Fetch and branch from current main first");
    git("apply", "--check", "--index", "--", patch);
    git("apply", "--index", "--", patch);
  }

  const loaded: unknown = await import(resolve("scripts/hard-mode-config.ts"));

  if (
    typeof loaded !== "object" ||
    loaded === null ||
    !("hardModeConfig" in loaded) ||
    !callable(loaded.hardModeConfig)
  )
    throw new Error("scripts/hard-mode-config.ts must export hardModeConfig");

  const config: unknown = await loaded.hardModeConfig();

  if (!isHardModeConfig(config))
    throw new Error("hardModeConfig returned an unexpected shape");

  const { zod, ignorePatterns } = config;
  const protectedPaths = [...zod, ...fixed];

  const protectedBefore = new Map(
    protectedPaths.map((file) => [file, digest(file)]),
  );

  const parentTree = git("write-tree");
  const scratch = mkdtempSync(join(tmpdir(), "stargate-t3-pr1-"));
  const isolated = resolve(`.t3-${crypto.randomUUID()}.json`);

  function lint(rule: string, fix?: "--fix" | "--fix-suggestions"): Finding[] {
    writeFileSync(
      isolated,
      JSON.stringify({
        categories,
        ignorePatterns,
        rules: { [rule]: "error" },
        overrides: [{ files: protectedPaths, rules: { [rule]: "off" } }],
      }),
    );

    const result = spawnSync(
      "node",
      [
        "./node_modules/.bin/oxlint",
        "--type-aware",
        "-c",
        isolated,
        "--disable-nested-config",
        "--format",
        "json",
        ...roots,
        ...(fix ? [fix] : []),
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );

    if (result.status !== 0 && result.status !== 1)
      throw new Error(`Oxlint failed for ${rule}: ${result.stderr}`);
    const data = JSON.parse(result.stdout) as { diagnostics: Finding[] };

    if (
      data.diagnostics.some(
        ({ filename, labels }) =>
          !Number.isSafeInteger(labels[0]?.span.offset) ||
          labels[0].span.offset < 0 ||
          protectedPaths.includes(filename) ||
          !/^(src|scripts|perf)\/(?:[\w-]+\/)*[\w.-]+\.ts$/.test(filename),
      )
    )
      throw new Error(`Unexpected diagnostic scope: ${rule}`);

    return data.diagnostics;
  }

  function requireGreen(rule: string): void {
    if (lint(rule).length > 0)
      throw new Error(`Unresolved findings remain: ${rule}`);
  }

  function transform(): void {
    for (const [rule, mode] of [
      ["typescript/explicit-member-accessibility", "--fix-suggestions"],
      ["typescript/no-unnecessary-type-arguments", "--fix"],
    ] as const) {
      const findings = lint(rule).length;

      if (findings) lint(rule, mode);
      requireGreen(rule);
      console.log(`${rule}: ${findings} native repairs`);
    }

    const duplicate = "typescript/no-redundant-type-constituents";
    const repeats = lint(duplicate);

    for (const { filename } of repeats) {
      if (filename === "src/coordination/fleet/control.ts")
        replace(
          filename,
          "status?(): Promise<unknown> | unknown;",
          "status?(): unknown;",
        );
      else if (filename === "src/lib/effect.ts")
        replace(filename, "=> Promise<unknown> | unknown,", "=> unknown,");
      else throw new Error(`Unrecognised redundant constituent: ${filename}`);
    }

    requireGreen(duplicate);
    console.log(`${duplicate}: ${repeats.length} exact type repairs`);

    const imports = "typescript/consistent-type-imports";
    const queries = lint(imports);

    if (queries.length > 0) {
      const file = "src/observability/dashboard/api/v1/types.ts";

      if (
        queries.length !== 3 ||
        queries.some(({ filename }) => filename !== file)
      )
        throw new Error(
          "Type-query group changed; inspect before extending the codemod",
        );
      replace(
        file,
        'import type { JobStatus } from "../../../../gateway/store";',
        'import type { JobStatus } from "../../../../gateway/store";\nimport type { TurnStage } from "../../../../shared/turn-progress";\nimport type { RequestFailure } from "../../../../shared/request-failure";',
      );

      for (const [name, module] of [
        ["TurnStage", "shared/turn-progress"],
        ["JobStatus", "gateway/store"],
        ["RequestFailure", "shared/request-failure"],
      ] as const)
        replace(file, `import("../../../../${module}").${name}`, name);
    }

    requireGreen(imports);
    console.log(`${imports}: ${queries.length} exact type-query repairs`);

    const comments = "eslint/no-inline-comments";
    const inline = lint(comments);
    moveInlineComments(inline);
    requireGreen(comments);
    console.log(`${comments}: ${inline.length} ordinary comments moved`);

    rmSync(isolated, { force: true });
    bun("run", "format");
  }

  try {
    bun("scripts/compare-js-emit.ts", "--capture", join(scratch, "before"));
    transform();
    const diff = git("diff", "--binary", "--no-ext-diff");
    transform();

    if (
      diff !== git("diff", "--binary", "--no-ext-diff") ||
      parentTree !== git("write-tree")
    )
      throw new Error("Second run changed the sweep or the index");

    for (const [file, hash] of protectedBefore) {
      if (digest(file) !== hash)
        throw new Error(`Protected file changed: ${file}`);
    }

    if (git("diff", "--name-only", "--", "tests"))
      throw new Error("PR1 must not rewrite test files");
    bun("run", "typecheck");
    bun("run", "lint");
    bun("scripts/compare-js-emit.ts", "--capture", join(scratch, "after"));
    bun(
      "scripts/compare-js-emit.ts",
      join(scratch, "before"),
      join(scratch, "after"),
    );
    git("diff", "--check");
    console.log(git("diff", "--stat"));
  } finally {
    rmSync(isolated, { force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

await regenerate();
