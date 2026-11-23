import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hardModeConfig, lintRoots, spacingRule } from "./hard-mode-config";

const toolRules = [
  "eslint/capitalized-comments",
  "typescript/array-type",
  "typescript/consistent-indexed-object-style",
  "typescript/prefer-readonly",
  "unicorn/no-hex-escape",
  "unicorn/numeric-separators-style",
];

function treeDigest() {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      encoding: "utf8",
    },
  ).split("\0");

  const digest = createHash("sha256");

  for (const path of new Set(files)) {
    if (!path || !lstatSync(path, { throwIfNoEntry: false })?.isFile())
      continue;
    digest
      .update(`${path}\0`)
      .update(createHash("sha256").update(readFileSync(path)).digest());
  }

  return digest.digest("hex");
}

const { zod, fixed, ignorePatterns } = await hardModeConfig();
const excluded = [...zod, ...fixed];

const lintIgnores = [
  ...(ignorePatterns ?? []),
  ...excluded.map((path) => `/${path}`),
].flatMap((pattern) => ["--ignore-pattern", pattern]);

const scratch = mkdtempSync(join(tmpdir(), "stargate-format-"));

function fixConfig(name: string, rules: string[]) {
  const path = join(scratch, name);
  writeFileSync(
    path,
    JSON.stringify({
      categories: { correctness: "off" },
      ...(rules.includes(spacingRule) && {
        jsPlugins: [
          {
            name: "anti-slop",
            specifier: resolve("tools/oxlint/anti-slop/index.ts"),
          },
        ],
      }),
      rules: Object.fromEntries(rules.map((rule) => [rule, "error"])),
    }),
  );

  return path;
}

function fix(config: string, options: string[]) {
  const attempt = spawnSync(
    process.execPath,
    [
      "./node_modules/.bin/oxlint",
      "-c",
      config,
      "--disable-nested-config",
      "--fix",
      ...lintIgnores,
      ...options,
      ...lintRoots,
    ],
    { stdio: "inherit" },
  );

  if (attempt.error) throw attempt.error;

  if (attempt.status !== 0 && attempt.status !== 1)
    throw new Error(`Oxlint fix failed: ${attempt.status ?? attempt.signal}`);

  return attempt.status === 0;
}

try {
  const syntax = fixConfig("syntax.json", toolRules);
  const spacing = fixConfig("spacing.json", [spacingRule]);
  const formatPaths = [".", ...excluded.map((path) => `!${path}`)];

  let previous = treeDigest();
  let settled = false;

  for (let round = 1; round <= 4; round++) {
    const syntaxPassed = fix(syntax, ["--type-aware"]);
    const spacingPassed = fix(spacing, []);
    execFileSync(
      process.execPath,
      ["./node_modules/.bin/oxfmt", "--write", ...formatPaths],
      { stdio: "inherit" },
    );
    const current = treeDigest();

    if (current === previous) {
      if (!syntaxPassed || !spacingPassed)
        throw new Error("Oxlint could not fix every selected finding");
      console.log(
        `Format fixed point: ${round - 1} changed rounds, one unchanged`,
      );
      settled = true;
      break;
    }

    previous = current;
  }

  if (!settled)
    throw new Error("Formatting did not converge within four rounds");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
