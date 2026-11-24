import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";

/** Ceiling rules whose per-file lists in `.oxlintrc.json` may only shrink. */
export const ceilingRules = [
  "eslint/max-lines-per-function",
  "eslint/max-statements",
  "eslint/max-params",
  "eslint/max-depth",
  "eslint/complexity",
  "unicorn/max-nested-calls",
  "eslint/max-classes-per-file",
] as const;

/**
 * Overrides that turn rules off for structural reasons, not for listed
 * places. Each is matched by its exact set of `files`. Every other override
 * must be the general set, a ceiling list or an exception list.
 */
export const structuralOverrides = [
  { name: "tests", files: ["tests/**"] },
  {
    name: "fixed entries",
    files: [
      "plugins/opencode/crew/plugin.ts",
      "plugins/opencode/fleet/plugin.ts",
      "src/config.ts",
      "src/main.ts",
    ],
  },
] as const;

/**
 * Keys the check allows in each part of `.oxlintrc.json`. The Schema decode
 * below drops every other key, so the check reads the raw keys first.
 */
const allowedKeys = {
  top: [
    "$schema",
    "categories",
    "ignorePatterns",
    "jsPlugins",
    "overrides",
    "rules",
  ],
  general: ["env", "excludeFiles", "files", "globals", "rules"],
  list: ["files", "rules"],
} as const;

type Rule = (typeof ceilingRules)[number];

const ceilingSetting = Schema.Tuple([
  Schema.Literal("error"),
  Schema.Record(Schema.String, Schema.Unknown),
]);

type CeilingSetting = typeof ceilingSetting.Type;

const override = Schema.Struct({
  files: Schema.optional(Schema.Array(Schema.String)),
  excludeFiles: Schema.optional(Schema.Array(Schema.String)),
  rules: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

type Override = typeof override.Type;

const config = Schema.Struct({
  rules: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  jsPlugins: Schema.optional(
    Schema.Array(
      Schema.Struct({ name: Schema.String, specifier: Schema.String }),
    ),
  ),
  overrides: Schema.Array(override),
});

const report = Schema.Struct({
  diagnostics: Schema.Array(
    Schema.Struct({
      code: Schema.String,
      filename: Schema.String,
      message: Schema.String,
    }),
  ),
  number_of_files: Schema.Number,
  number_of_rules: Schema.Number,
});

const oxlint = join(import.meta.dir, "../node_modules/.bin/oxlint");

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

const offValues: ReadonlySet<unknown> = new Set(["off", "allow", 0]);

function isOff(value: unknown) {
  return offValues.has(Array.isArray(value) ? value[0] : value);
}

function isCeiling(name: string): name is Rule {
  return (ceilingRules as readonly string[]).includes(name);
}

function limit(value: CeilingSetting) {
  const max = value[1]["max"];

  if (typeof max !== "number" || !Number.isInteger(max))
    throw new Error(`"max" must be an integer: ${JSON.stringify(value)}`);

  return max;
}

/** Oxlint reports a rule as `plugin(name)`; the config names it `plugin/name`. */
function ruleOf(code: string) {
  const match = /^([\w-]+)\(([\w-]+)\)$/.exec(code);

  return match ? `${match[1]}/${match[2]}` : code;
}

type Finding = { file: string; rule: string; value: number | undefined };

type Run = {
  scratch: string;
  plugins: readonly { name: string; specifier: string }[];
  typeAware: boolean;
};

/**
 * Runs Oxlint with only `rules` on. Any doubt fails: an exit status other
 * than 0 or 1, no output, output that is not the JSON report, or a report
 * that did not lint every file with every rule.
 */
function lint(run: Run, rules: Record<string, unknown>, files: string[]) {
  const path = join(run.scratch, `run-${crypto.randomUUID()}.json`);

  const jsPlugins = run.plugins.map(({ name, specifier }) => ({
    name,
    specifier: specifier.startsWith(".") ? resolve(specifier) : specifier,
  }));

  writeFileSync(path, JSON.stringify({ categories, jsPlugins, rules }));

  // Oxlint exits right after it writes, so a large report through a pipe
  // Is cut short. A file receives all of it.
  const outputPath = `${path}.out`;
  const sink = openSync(outputPath, "w");

  const result = spawnSync(
    process.execPath,
    [
      oxlint,
      "-c",
      path,
      "--disable-nested-config",
      ...(run.typeAware ? ["--type-aware"] : []),
      "--format",
      "json",
      ...files,
    ],
    { encoding: "utf8", stdio: ["ignore", sink, "pipe"] },
  );

  closeSync(sink);
  const stdout = readFileSync(outputPath, "utf8");
  const detail = `${result.stderr ?? ""}${result.error?.message ?? ""}`.trim();

  if (result.status !== 0 && result.status !== 1)
    throw new Error(`oxlint failed (status ${result.status}): ${detail}`);

  if (!stdout.trim())
    throw new Error(`oxlint gave no output; nothing was checked. ${detail}`);

  let output: unknown;

  try {
    output = JSON.parse(stdout);
  } catch {
    throw new Error(
      `oxlint output is not a JSON report: ${stdout.slice(0, 500)} ${detail}`,
    );
  }

  const parsed = Schema.decodeUnknownSync(report)(output);

  if (parsed.number_of_files !== files.length)
    throw new Error(
      `oxlint linted ${parsed.number_of_files} of ${files.length} files`,
    );

  if (parsed.number_of_rules !== Object.keys(rules).length)
    throw new Error(
      `oxlint ran ${parsed.number_of_rules} of ${Object.keys(rules).length} rules: ${Object.keys(rules).join(", ")}`,
    );

  return parsed.diagnostics.map(({ code, filename, message }): Finding => {
    const number = /\((\d+)\)|complexity of (\d+)/.exec(message);

    return {
      file: filename,
      rule: ruleOf(code),
      value: number ? Number(number[1] ?? number[2]) : undefined,
    };
  });
}

type CeilingList = { files: string[]; setting: CeilingSetting };

type ExceptionList = { at: string; files: string[]; rules: string[] };

type Plan = {
  general: Record<string, unknown>;
  protectedFiles: Set<string>;
  ceilings: Map<Rule, CeilingList>;
  exceptions: ExceptionList[];
  failures: string[];
};

function describe(index: number, { files = [] }: Override) {
  const shown = files.slice(0, 3).join(", ");

  return `override ${index} (${shown}${files.length > 3 ? ", …" : ""})`;
}

function sameFiles(files: readonly string[], expected: readonly string[]) {
  return (
    files.length === expected.length &&
    [...files].toSorted().join("\n") === [...expected].toSorted().join("\n")
  );
}

function structuralName(files: readonly string[]) {
  return structuralOverrides.find((entry) => sameFiles(files, entry.files))
    ?.name;
}

/** Puts every override in exactly one kind; an override of no kind fails. */
function classify(plan: Plan, index: number, entry: Override) {
  const { files = [], rules = {} } = entry;
  const names = Object.keys(rules);
  const at = describe(index, entry);

  const extra = Object.keys(entry).filter(
    (key) => !["files", "rules"].includes(key),
  );

  if (entry.excludeFiles) return;

  const structural = structuralName(files);

  if (structural) {
    if (names.some((name) => !isOff(rules[name])))
      plan.failures.push(
        `${at}: the ${structural} override may only turn rules off`,
      );

    for (const name of ceilingRules)
      if (!isOff(rules[name]))
        plan.failures.push(
          `${at}: the ${structural} override must turn ${name} off`,
        );

    return;
  }

  if (extra.length > 0 || names.length === 0) {
    plan.failures.push(
      `${at}: not a ceiling list or an exception list (keys ${[...extra, ...(names.length > 0 ? [] : ["no rules"])].join(", ")})`,
    );

    return;
  }

  const [first] = names;

  if (names.length === 1 && first && isCeiling(first) && !isOff(rules[first])) {
    if (plan.ceilings.has(first))
      plan.failures.push(`${first}: more than one list (${at})`);
    plan.ceilings.set(first, {
      files: [...files],
      setting: Schema.decodeUnknownSync(ceilingSetting)(rules[first]),
    });

    return;
  }

  if (names.every((name) => isOff(rules[name]))) {
    for (const name of names.filter((item) => isCeiling(item)))
      plan.failures.push(
        `${at}: turns the ceiling rule ${name} off; list the file in the ${name} list instead`,
      );

    for (const name of names) {
      const on = plan.general[name];

      if (on === undefined || isOff(on))
        plan.failures.push(
          `${at}: ${name} is not on in the general set, so this list turns nothing off`,
        );
    }

    plan.exceptions.push({
      at,
      files: [...files],
      rules: names.filter((name) => !isCeiling(name)),
    });

    return;
  }

  plan.failures.push(
    `${at}: names ${names.join(", ")}; a ceiling list names one ceiling rule, an exception list only turns rules off`,
  );
}

function checkPaths(plan: Plan, owner: string, files: readonly string[]) {
  const sorted = [...new Set(files)].toSorted();

  if (files.join("\n") !== sorted.join("\n"))
    plan.failures.push(`${owner}: list files must be unique and sorted`);

  for (const file of files) {
    if (/[*?[\]{}!]/.test(file))
      plan.failures.push(`${owner}: ${file} is a pattern; list literal paths`);
    else if (file.startsWith("tests/") || plan.protectedFiles.has(file))
      plan.failures.push(
        `${owner}: ${file} is a test, a fixed entry or a Zod file; those rules are already off there`,
      );
    else if (!existsSync(file))
      plan.failures.push(`${owner}: ${file} does not exist; remove it`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
) {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

/** Refuses keys the check does not read, and overrides with no files. */
function checkKeys(input: unknown) {
  if (!isRecord(input)) return ["the configuration is not a JSON object"];

  const failures = unknownKeys(input, allowedKeys.top).map(
    (key) =>
      `top level: key "${key}" is not allowed (allowed: ${allowedKeys.top.join(", ")})`,
  );

  const overrides = Array.isArray(input["overrides"]) ? input["overrides"] : [];

  for (const [index, entry] of overrides.entries()) {
    if (!isRecord(entry)) {
      failures.push(`override ${index}: not a JSON object`);
      continue;
    }

    const files = Array.isArray(entry["files"])
      ? entry["files"].filter((file) => typeof file === "string")
      : [];

    const at = describe(index, { files });
    const general = "excludeFiles" in entry;
    const structural = structuralName(files);
    const allowed = general ? allowedKeys.general : allowedKeys.list;

    const kind = general
      ? "the general set"
      : structural
        ? `the ${structural} override`
        : "a ceiling list or an exception list";

    for (const key of unknownKeys(entry, allowed))
      failures.push(
        `${at}: key "${key}" is not allowed in ${kind} (allowed: ${allowed.join(", ")})`,
      );

    if (files.length === 0) failures.push(`${at}: lists no files`);
  }

  return failures;
}

async function readPlan(): Promise<{ plan: Plan; plugins: Run["plugins"] }> {
  const input: unknown = await Bun.file(".oxlintrc.json").json();
  const keyFailures = checkKeys(input);

  if (keyFailures.length > 0)
    throw new Error(keyFailures.toSorted().join("\n"));

  const {
    overrides,
    rules = {},
    jsPlugins = [],
  } = Schema.decodeUnknownSync(config)(input);

  const generalSets = overrides.filter(({ excludeFiles }) => excludeFiles);
  const [generalSet] = generalSets;

  const plan: Plan = {
    general: { ...rules, ...generalSet?.rules },
    protectedFiles: new Set([
      ...(generalSet?.excludeFiles ?? []),
      ...structuralOverrides[1].files,
    ]),
    ceilings: new Map(),
    exceptions: [],
    failures:
      generalSets.length === 1
        ? []
        : [
            `expected one general set (the override with excludeFiles), found ${generalSets.length}`,
          ],
  };

  for (const [index, entry] of overrides.entries())
    classify(plan, index, entry);

  return { plan, plugins: jsPlugins };
}

function checkCeilings(plan: Plan, run: Run, findings: Finding[]) {
  for (const [name, { files, setting: listed }] of plan.ceilings) {
    const general = plan.general[name];

    if (general === undefined || isOff(general)) continue;
    const generalMax = limit(Schema.decodeUnknownSync(ceilingSetting)(general));
    const max = limit(listed);
    const above = findings.filter((finding) => finding.rule === name);

    for (const file of files)
      if (!above.some((finding) => finding.file === file))
        plan.failures.push(
          `${name}: ${file} has no place above ${generalMax}; remove it from the ${name} list in .oxlintrc.json`,
        );

    let measured = Math.max(
      generalMax,
      ...above.flatMap((finding) =>
        files.includes(finding.file) && finding.value !== undefined
          ? [finding.value]
          : [],
      ),
    );

    // The nested-calls rule reports no number: probe below the listed
    // Maximum until a place is found.
    if (
      above.length > 0 &&
      above.every((finding) => finding.value === undefined)
    )
      for (measured = max; measured > generalMax; measured--) {
        const probe = lint(
          { ...run, typeAware: false },
          { [name]: ["error", { ...listed[1], max: measured - 1 }] },
          files,
        );

        if (probe.some((finding) => finding.rule === name)) break;
      }

    if (above.length > 0 && max > measured)
      plan.failures.push(
        `${name}: the list maximum ${max} is above the measured maximum ${measured}; set "max" to ${measured} in the ${name} list in .oxlintrc.json`,
      );
  }
}

function checkExceptions(plan: Plan, findings: Finding[]) {
  for (const { at, files, rules } of plan.exceptions)
    for (const rule of rules)
      for (const file of files)
        if (
          !findings.some(
            (finding) => finding.rule === rule && finding.file === file,
          )
        )
          plan.failures.push(
            `${at}: ${file} has no ${rule} finding with the rule on; remove it from this list in .oxlintrc.json`,
          );
}

export async function check() {
  const { plan, plugins } = await readPlan();

  for (const [name, { files }] of plan.ceilings) {
    const general = plan.general[name];

    if (general === undefined || isOff(general))
      plan.failures.push(
        `${name}: the list has no general limit to compare with`,
      );
    checkPaths(plan, name, files);
  }

  for (const { at, files } of plan.exceptions) checkPaths(plan, at, files);

  if (plan.failures.length > 0)
    throw new Error(plan.failures.toSorted().join("\n"));

  const scratch = mkdtempSync(join(tmpdir(), "stargate-lint-lists-"));

  try {
    const ceilingFiles = [...plan.ceilings.values()].flatMap((l) => l.files);
    const ceilingRun = { scratch, plugins: [], typeAware: false };

    const ceilingFindings =
      ceilingFiles.length > 0
        ? lint(
            ceilingRun,
            Object.fromEntries(
              [...plan.ceilings.keys()].map((name) => [
                name,
                plan.general[name],
              ]),
            ),
            [...new Set(ceilingFiles)],
          )
        : [];

    checkCeilings(plan, ceilingRun, ceilingFindings);

    const exceptionRules = [
      ...new Set(plan.exceptions.flatMap((l) => l.rules)),
    ];

    const exceptionFiles = [
      ...new Set(plan.exceptions.flatMap((l) => l.files)),
    ];

    if (exceptionRules.length > 0 && exceptionFiles.length > 0)
      checkExceptions(
        plan,
        lint(
          { scratch, plugins, typeAware: true },
          Object.fromEntries(
            exceptionRules.map((name) => [name, plan.general[name]]),
          ),
          exceptionFiles,
        ),
      );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (plan.failures.length > 0)
    throw new Error(plan.failures.toSorted().join("\n"));
}

if (import.meta.main) {
  try {
    await check();
  } catch (error) {
    console.error(
      `Lint lists: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
