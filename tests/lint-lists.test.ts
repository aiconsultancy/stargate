import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../scripts/check-lint-lists.ts");
const modules = join(import.meta.dir, "../node_modules");

let cwd = "";

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "stargate-lint-lists-"));
  // Type-aware Oxlint finds its linter through the working directory.
  symlinkSync(modules, join(cwd, "node_modules"));
  mkdirSync(join(cwd, "src"));

  const sources = {
    "wide.ts":
      "export function wide(a: number, b: number, c: number, d: number, e: number) {\n  return a + b + c + d + e;\n}\n",
    "narrow.ts": "export function narrow(a: number) {\n  return a;\n}\n",
    "nested.ts":
      "export const nested = String(String(String(String(String(1)))));\n",
    "loop.ts":
      "export function loop(limit: number) {\n  const items: number[] = [];\n  let count = 0;\n  while (count < limit) items.push(1);\n  count = items.length;\n  return count;\n}\n",
    "promise.ts":
      "export function later(value: number) {\n  return Promise.resolve(value);\n}\n",
  };

  for (const [name, text] of Object.entries(sources)) {
    writeFileSync(join(cwd, "src", name), text);
  }
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const general = {
  files: ["src/**/*.ts"],
  excludeFiles: [],
  rules: {
    "eslint/max-params": ["error", { max: 3 }],
    "unicorn/max-nested-calls": ["error", { max: 2 }],
    "eslint/no-unmodified-loop-condition": "error",
    "typescript/promise-function-async": "error",
    "eslint/no-such-rule": "error",
  },
};

const tests = {
  files: ["tests/**"],
  rules: {
    "eslint/max-lines-per-function": "off",
    "eslint/max-statements": "off",
    "eslint/max-params": "off",
    "eslint/max-depth": "off",
    "eslint/complexity": "off",
    "unicorn/max-nested-calls": "off",
    "eslint/max-classes-per-file": "off",
    "eslint/no-unmodified-loop-condition": "off",
  },
};

const paramsList = {
  files: ["src/wide.ts"],
  rules: { "eslint/max-params": ["error", { max: 5 }] },
};

const callsList = {
  files: ["src/nested.ts"],
  rules: { "unicorn/max-nested-calls": ["error", { max: 5 }] },
};

const loopList = {
  files: ["src/loop.ts"],
  rules: { "eslint/no-unmodified-loop-condition": "off" },
};

const promiseList = {
  files: ["src/promise.ts"],
  rules: { "typescript/promise-function-async": "off" },
};

function run(
  overrides: unknown[],
  checker = script,
  env?: Record<string, string | undefined>,
) {
  writeFileSync(join(cwd, ".oxlintrc.json"), JSON.stringify({ overrides }));

  const result = Bun.spawnSync([process.execPath, checker], {
    cwd,
    ...(env && { env }),
  });

  return { code: result.exitCode, message: result.stderr.toString() };
}

const valid = [general, paramsList, callsList, loopList, promiseList, tests];

test("a configuration with valid lists of both kinds passes", () => {
  expect(run(valid)).toEqual({ code: 0, message: "" });
});

test("type-aware exception lists work without node on PATH", () => {
  const { OXLINT_TSGOLINT_PATH: _, ...env } = process.env;

  expect(run(valid, script, { ...env, PATH: "" })).toEqual({
    code: 0,
    message: "",
  });
});

test("one rule can have different measured ceilings for different files", () => {
  writeFileSync(
    join(cwd, "src", "medium.ts"),
    "export function medium(a: number, b: number, c: number, d: number) { return a + b + c + d; }\n",
  );

  const mediumList = {
    files: ["src/medium.ts"],
    rules: { "eslint/max-params": ["error", { max: 4 }] },
  };

  expect(run([...valid, mediumList])).toEqual({ code: 0, message: "" });
  const overlap = run([...valid, mediumList, mediumList]);

  expect(overlap.code).toBe(1);
  expect(overlap.message).toContain(
    "eslint/max-params: src/medium.ts is in more than one list",
  );
});

test("ceiling lists reject stale entries and limits above the measured maximum", () => {
  const { code, message } = run([
    general,
    {
      files: ["src/narrow.ts", "src/wide.ts"],
      rules: { "eslint/max-params": ["error", { max: 6 }] },
    },
    {
      files: ["src/nested.ts"],
      rules: { "unicorn/max-nested-calls": ["error", { max: 6 }] },
    },
    tests,
  ]);

  expect(code).toBe(1);
  expect(message).toContain(
    "eslint/max-params: src/narrow.ts has no place above 3; remove it from the eslint/max-params list in .oxlintrc.json",
  );
  expect(message).toContain(
    'eslint/max-params: the list maximum 6 is above the measured maximum 5; set "max" to 5',
  );
  expect(message).toContain(
    'unicorn/max-nested-calls: the list maximum 6 is above the measured maximum 5; set "max" to 5',
  );
});

test("an exception list fails on a stale entry, also in a new override", () => {
  const { code, message } = run([
    ...valid,
    {
      files: ["src/narrow.ts"],
      rules: { "eslint/no-unmodified-loop-condition": "off" },
    },
  ]);

  expect(code).toBe(1);
  expect(message).toContain(
    "override 6 (src/narrow.ts): src/narrow.ts has no eslint/no-unmodified-loop-condition finding with the rule on; remove it from this list in .oxlintrc.json",
  );
});

test("an exception list fails on a path that does not exist", () => {
  const { code, message } = run([
    general,
    { ...loopList, files: ["src/gone.ts", "src/loop.ts"] },
    tests,
  ]);

  expect(code).toBe(1);
  expect(message).toContain("src/gone.ts does not exist; remove it");
});

test("an override that turns a ceiling rule off fails", () => {
  const { code, message } = run([
    ...valid,
    { files: ["src/narrow.ts"], rules: { "eslint/max-params": "off" } },
  ]);

  expect(code).toBe(1);
  expect(message).toContain(
    "override 6 (src/narrow.ts): turns the ceiling rule eslint/max-params off",
  );
});

test("a ceiling list that names a second rule fails", () => {
  const { code, message } = run([
    general,
    {
      files: ["src/wide.ts"],
      rules: {
        "eslint/max-params": ["error", { max: 5 }],
        "unicorn/max-nested-calls": ["error", { max: 5 }],
      },
    },
    tests,
  ]);

  expect(code).toBe(1);
  expect(message).toContain(
    "override 1 (src/wide.ts): names eslint/max-params, unicorn/max-nested-calls",
  );
});

test("an override of no known kind fails", () => {
  const cases = [
    {
      files: ["tests/**", "src/narrow.ts"],
      rules: { "eslint/max-params": "off" },
    },
    {
      files: ["src/narrow.ts"],
      rules: { "eslint/no-unmodified-loop-condition": "warn" },
    },
    { files: ["src/narrow.ts"], rules: {} },
    {
      files: ["tests/a.test.ts"],
      rules: { "eslint/no-unmodified-loop-condition": "off" },
    },
  ];

  const expected = [
    "turns the ceiling rule eslint/max-params off",
    "names eslint/no-unmodified-loop-condition",
    "not a ceiling list or an exception list (keys no rules)",
    "is a test, a fixed entry or a Zod file",
  ];

  cases.forEach((extra, index) => {
    const { code, message } = run([...valid, extra]);
    expect(code).toBe(1);
    expect(message).toContain(expected[index] ?? "");
  });
});

test("a list with a key other than files and rules fails, before decoding drops it", () => {
  const cases = [
    { ...loopList, env: { node: true } },
    { ...loopList, globals: { Bun: "writable" } },
    { ...loopList, plugins: ["import"] },
    { ...loopList, jsPlugins: [] },
    { ...paramsList, globals: { Bun: "writable" } },
  ];

  const keys = ["env", "globals", "plugins", "jsPlugins", "globals"];

  cases.forEach((list, index) => {
    const { code, message } = run([general, list, tests]);

    expect(code).toBe(1);
    expect(message).toContain(
      `(${list.files[0] ?? ""}): key "${keys[index] ?? ""}" is not allowed in a ceiling list or an exception list (allowed: files, rules)`,
    );
  });
});

test("the general set and the structural overrides allow only their own keys", () => {
  const cases = [
    [
      [{ ...general, plugins: ["import"] }, loopList, tests],
      'key "plugins" is not allowed in the general set (allowed: env, excludeFiles, files, globals, rules)',
    ],
    [
      [general, loopList, { ...tests, env: { node: true } }],
      'key "env" is not allowed in the tests override (allowed: files, rules)',
    ],
  ] as const;

  for (const [overrides, expected] of cases) {
    const { code, message } = run([...overrides]);

    expect(code).toBe(1);
    expect(message).toContain(expected);
  }
});

test("an unknown top-level key fails", () => {
  writeFileSync(
    join(cwd, ".oxlintrc.json"),
    JSON.stringify({ settings: {}, overrides: valid }),
  );

  const result = Bun.spawnSync([process.execPath, script], { cwd });

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(
    'top level: key "settings" is not allowed',
  );
});

test("an override without files fails", () => {
  for (const list of [{ ...loopList, files: [] }, { rules: loopList.rules }]) {
    const { code, message } = run([general, list, tests]);

    expect(code).toBe(1);
    expect(message).toContain("lists no files");
  }
});

test("an Oxlint configuration error fails the check", () => {
  const { code, message } = run([
    general,
    { files: ["src/narrow.ts"], rules: { "eslint/no-such-rule": "off" } },
    tests,
  ]);

  expect(code).toBe(1);
  expect(message).toContain("oxlint output is not a JSON report");
});

/** Puts a copy of the check next to a fake Oxlint binary; returns its path. */
function fakeOxlint(body: string) {
  mkdirSync(join(cwd, "scripts"), { recursive: true });
  mkdirSync(join(cwd, "fake/.bin"), { recursive: true });
  rmSync(join(cwd, "fake/effect"), { force: true });
  symlinkSync(join(modules, "effect"), join(cwd, "fake/effect"));
  copyFileSync(script, join(cwd, "scripts/check-lint-lists.ts"));
  rmSync(join(cwd, "node_modules"), { force: true });
  symlinkSync(join(cwd, "fake"), join(cwd, "node_modules"));

  const fake = join(cwd, "fake/.bin/oxlint");
  writeFileSync(fake, body);
  chmodSync(fake, 0o755);

  return join(cwd, "scripts/check-lint-lists.ts");
}

test("a large Oxlint report is read in full", () => {
  // Oxlint exits right after it writes; through a pipe a large report was
  // Cut short. 20,000 findings are about 2 MB.
  const filler = Array.from({ length: 20_000 }, () => ({
    code: "eslint(no-unmodified-loop-condition)",
    filename: "src/loop.ts",
    message: "x".repeat(80),
  }));

  const report = JSON.stringify({
    diagnostics: filler,
    number_of_files: 1,
    number_of_rules: 1,
  });

  const checker = fakeOxlint(
    `process.stdout.write(${JSON.stringify(report)}); process.exit(1);`,
  );

  expect(run([general, loopList, tests], checker)).toEqual({
    code: 0,
    message: "",
  });
});

test("no output, a partial report or a crash of Oxlint fails the check", () => {
  const fakes = [
    ["", "oxlint gave no output; nothing was checked"],
    [
      "process.stdout.write(JSON.stringify({ diagnostics: [], number_of_files: 1, number_of_rules: 0 }));",
      "oxlint ran 0 of 1 rules",
    ],
    [
      "process.stdout.write(JSON.stringify({ diagnostics: [], number_of_files: 0, number_of_rules: 1 }));",
      "oxlint linted 0 of 1 files",
    ],
    ["process.exit(2);", "oxlint failed (status 2)"],
  ];

  for (const [body, expected] of fakes) {
    const { code, message } = run(
      [general, loopList, tests],
      fakeOxlint(body ?? ""),
    );

    expect(code).toBe(1);
    expect(message).toContain(expected ?? "");
  }
});
