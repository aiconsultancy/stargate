import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const HOOK = join(import.meta.dir, "../scripts/hooks/touched-zod.sh");

function git(dir: string, ...args: string[]) {
  const result = spawnSync("git", ["-C", dir, ...args], {
    timeout: 30_000,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function runHook(dir: string, base: string, env = process.env) {
  const result = spawnSync("/bin/sh", [HOOK, base], {
    cwd: dir,
    timeout: 30_000,
    encoding: "utf8",
    env,
  });
  return {
    status: result.status ?? -1,
    output: `${result.stdout}${result.stderr}`,
  };
}

/** A scratch repository whose `main` carries one Zod-importing source file. */
async function scenario() {
  const root = await mkdtemp(join(tmpdir(), "touched-zod-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "hook-test@example.invalid");
  git(root, "config", "user.name", "Hook Test");
  await mkdir(join(root, "scripts/hooks"), { recursive: true });
  await writeFile(join(root, "scripts/hooks/touched-zod-changes.json"), "[]\n");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src/zod-file.ts"),
    'import { z } from "zod";\nexport const s = z.string();\n',
  );
  await writeFile(
    join(root, "src/clean.ts"),
    'import { Schema } from "effect";\nexport const s = Schema.String;\n',
  );
  git(root, "add", "-A");
  git(root, "commit", "-m", "base");
  return root;
}

describe("touched-zod hook", () => {
  test("an actual rename permits only its relative import update", async () => {
    const root = await scenario();
    try {
      await writeFile(join(root, "src/helper.ts"), "export const value = 1;\n");
      const before =
        'import { z } from "zod";\nimport { value } from "./helper";\n' +
        "export const s = z.string();\nexport const n = value;\n";
      await writeFile(join(root, "src/zod-file.ts"), before);
      git(root, "add", "-A");
      git(root, "commit", "-m", "base with relative import");
      const base = git(root, "rev-parse", "HEAD");
      await mkdir(join(root, "src/moved"));
      await rename(
        join(root, "src/zod-file.ts"),
        join(root, "src/moved/zod-file.ts"),
      );
      await writeFile(
        join(root, "src/moved/zod-file.ts"),
        before.replace('"./helper"', '"../helper"'),
      );
      git(root, "add", "-A");
      git(root, "commit", "-m", "move and update relative import");
      expect(git(root, "diff", "--name-status", "-M", base, "HEAD")).toContain(
        "R",
      );
      expect(runHook(root, base).status).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([false, true])(
    "a nightly CLI rename preserves its literal dynamic import target, moved=%s",
    async (moveTarget) => {
      const root = await scenario();
      try {
        await mkdir(join(root, "src/nightly"));
        await writeFile(
          join(root, "src/runtime.ts"),
          "export const run = (value: string) => value;\n",
        );
        const before =
          'import { z } from "zod";\n' +
          "export const input = z.string();\n" +
          "export async function command(value: string) {\n" +
          "  const parsed = input.parse(value);\n" +
          "  const runtime = await import('../runtime');\n" +
          "  return runtime.run(parsed);\n}\n";
        await writeFile(join(root, "src/nightly/cli.ts"), before);
        git(root, "add", "-A");
        git(root, "commit", "-m", "nightly CLI base");
        const base = git(root, "rev-parse", "HEAD");
        await mkdir(join(root, "src/maintenance/nightly"), { recursive: true });
        await rename(
          join(root, "src/nightly/cli.ts"),
          join(root, "src/maintenance/nightly/cli.ts"),
        );
        if (moveTarget) {
          await mkdir(join(root, "src/app"));
          await rename(
            join(root, "src/runtime.ts"),
            join(root, "src/app/runtime.ts"),
          );
        }
        await writeFile(
          join(root, "src/maintenance/nightly/cli.ts"),
          before.replace(
            "'../runtime'",
            moveTarget ? "'../../app/runtime'" : "'../../runtime'",
          ),
        );
        git(root, "add", "-A");
        git(root, "commit", "-m", "move CLI and preserve dynamic target");
        expect(
          git(root, "diff", "--name-status", "-M", base, "HEAD"),
        ).toContain("src/nightly/cli.ts\tsrc/maintenance/nightly/cli.ts");
        expect(runHook(root, base)).toMatchObject({ status: 0 });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.each([
    "retarget",
    "unchanged wrong target",
    "computed",
    "logic",
    "Zod binding",
    "Zod schema",
  ])("a renamed dynamic-import consumer rejects %s changes", async (kind) => {
    const root = await scenario();
    try {
      await mkdir(join(root, "src/nightly"));
      await writeFile(
        join(root, "src/runtime.ts"),
        'export const name = "runtime";\n',
      );
      await writeFile(
        join(root, "src/other.ts"),
        'export const name = "other";\n',
      );
      await mkdir(join(root, "src/maintenance"));
      await writeFile(
        join(root, "src/maintenance/runtime.ts"),
        'export const name = "different";\n',
      );
      const before =
        'import { z } from "zod";\nexport const input = z.string();\n' +
        'export const modulePath = "../runtime";\n' +
        "export async function command(value: string) {\n" +
        "  const parsed = input.parse(value);\n" +
        `  const runtime = await import(${kind === "computed" ? "modulePath" : "'../runtime'"});\n` +
        "  return { parsed, runtime };\n}\n";
      await writeFile(join(root, "src/nightly/cli.ts"), before);
      git(root, "add", "-A");
      git(root, "commit", "-m", "dynamic consumer base");
      const base = git(root, "rev-parse", "HEAD");
      await mkdir(join(root, "src/maintenance/nightly"));
      await rename(
        join(root, "src/nightly/cli.ts"),
        join(root, "src/maintenance/nightly/cli.ts"),
      );
      let after = before.replace("'../runtime'", "'../../runtime'");
      if (kind === "retarget")
        after = after.replace("'../../runtime'", "'../../other'");
      if (kind === "unchanged wrong target") after = before;
      if (kind === "logic")
        after = after.replace(
          "input.parse(value)",
          "input.parse(value.trim())",
        );
      if (kind === "Zod binding")
        after = after.replace("{ z }", "{ z, ZodError }");
      if (kind === "Zod schema")
        after = after.replace("z.string()", "z.number()");
      await writeFile(join(root, "src/maintenance/nightly/cli.ts"), after);
      git(root, "add", "-A");
      git(root, "commit", "-m", "unproven dynamic consumer move");
      expect(git(root, "diff", "--name-status", "-M", base, "HEAD")).toContain(
        "src/nightly/cli.ts\tsrc/maintenance/nightly/cli.ts",
      );
      const result = runHook(root, base);
      expect(result.status).toBe(1);
      expect(result.output).toContain("src/maintenance/nightly/cli.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a retained Zod consumer follows a renamed import and reexport target", async () => {
    const root = await scenario();
    try {
      await writeFile(join(root, "src/helper.ts"), "export const value = 1;\n");
      const before =
        'import { z } from "zod";\nimport { value } from "./helper";\n' +
        'export { value } from "./helper";\nexport const s = z.string();\n';
      await writeFile(join(root, "src/zod-file.ts"), before);
      git(root, "add", "-A");
      git(root, "commit", "-m", "base consumer");
      const base = git(root, "rev-parse", "HEAD");
      await rename(join(root, "src/helper.ts"), join(root, "src/renamed.ts"));
      await writeFile(
        join(root, "src/zod-file.ts"),
        before.replaceAll('"./helper"', '"./renamed"'),
      );
      git(root, "add", "-A");
      git(root, "commit", "-m", "move imported target");
      expect(runHook(root, base).status).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["extra declaration", 'import { ZodError } from "zod";\n'],
    ["subpath", "import { z as other } from 'zod/v4';\n"],
    ["dynamic", "const other = import('zod');\n"],
    ["require", "const other = require('zod/mini');\n"],
    ["side effect", "import 'zod';\n"],
    ["import equals", "import other = require('zod');\n"],
    ["reexport", "export { z as other } from 'zod';\n"],
    ["import type", "type Other = import('zod').ZodError;\n"],
    ["template", "const other = import(`zod`);\n"],
    ["escaped source", 'import { z as other } from "z\\u006fd";\n'],
  ])(
    "new %s Zod use fails in existing, added and renamed files",
    async (_name, addition) => {
      for (const kind of ["existing", "added", "renamed"]) {
        const root = await scenario();
        try {
          const base = git(root, "rev-parse", "HEAD");
          const target = kind === "existing" ? "src/zod-file.ts" : "src/new.ts";
          if (kind === "renamed") {
            await rename(join(root, "src/zod-file.ts"), join(root, target));
          }
          await writeFile(
            join(root, target),
            (kind === "added"
              ? ""
              : 'import { z } from "zod";\nexport const s = z.string();\n') +
              addition,
          );
          git(root, "add", "-A");
          git(root, "commit", "-m", "add forbidden import");
          if (kind === "renamed") {
            expect(
              git(root, "diff", "--name-status", "-M", base, "HEAD"),
            ).toContain("R");
          }
          const { status, output } = runHook(root, base);
          expect(status).toBe(1);
          expect(output).toContain(target);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    },
  );

  test.each([
    [
      "binding",
      'import { z, ZodError } from "zod";\nexport const s = z.string();\n',
    ],
    ["source", 'import { z } from "zod/v4";\nexport const s = z.string();\n'],
    ["logic", 'import { z } from "zod";\nexport const s = z.number();\n'],
    [
      "formatting",
      'import { z } from "zod";\n\nexport const s = z.string();\n',
    ],
  ])("retained Zod %s edits remain strict", async (_name, source) => {
    const root = await scenario();
    try {
      const base = git(root, "rev-parse", "HEAD");
      await writeFile(join(root, "src/zod-file.ts"), source);
      git(root, "add", "-A");
      git(root, "commit", "-m", "non-mechanical change");
      expect(runHook(root, base).status).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("move-only preserves an existing single-quoted Zod import", async () => {
    const root = await scenario();
    try {
      await writeFile(
        join(root, "src/zod-file.ts"),
        "import { z } from 'zod';\nexport const s = z.string();\n",
      );
      git(root, "add", "-A");
      git(root, "commit", "-m", "single quoted base");
      const base = git(root, "rev-parse", "HEAD");
      await rename(join(root, "src/zod-file.ts"), join(root, "src/renamed.ts"));
      git(root, "add", "-A");
      git(root, "commit", "-m", "move only");
      expect(runHook(root, base).status).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("strings and comments that mention Zod are not imports", async () => {
    const root = await scenario();
    try {
      const base = git(root, "rev-parse", "HEAD");
      await writeFile(
        join(root, "src/clean.ts"),
        '// import { z } from "zod";\nexport const message = "zod";\n',
      );
      git(root, "add", "-A");
      git(root, "commit", "-m", "mention without import");
      expect(runHook(root, base).status).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("clean logic edits can retain an existing computed module loader", async () => {
    const root = await scenario();
    try {
      const before =
        "export async function load(path: string) { return import(path); }\n" +
        "export const enabled = false;\n";
      await writeFile(join(root, "src/clean.ts"), before);
      git(root, "add", "-A");
      git(root, "commit", "-m", "clean computed loader base");
      const base = git(root, "rev-parse", "HEAD");
      await writeFile(
        join(root, "src/clean.ts"),
        before.replace("false", "true"),
      );
      git(root, "add", "-A");
      git(root, "commit", "-m", "unrelated clean logic edit");
      expect(runHook(root, base).status).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a retained-Zod file with a computed loader cannot claim a move exception", async () => {
    const root = await scenario();
    try {
      await writeFile(
        join(root, "src/zod-file.ts"),
        'import { z } from "zod";\nexport const s = z.string();\n' +
          "export async function load(path: string) { return import(path); }\n",
      );
      git(root, "add", "-A");
      git(root, "commit", "-m", "legacy Zod with computed loader");
      const base = git(root, "rev-parse", "HEAD");
      await rename(join(root, "src/zod-file.ts"), join(root, "src/moved.ts"));
      git(root, "add", "-A");
      git(root, "commit", "-m", "unproven legacy move");
      expect(git(root, "diff", "--name-status", "-M", base, "HEAD")).toContain(
        "R100",
      );
      const { status, output } = runHook(root, base);
      expect(status).toBe(1);
      expect(output).toContain("src/moved.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each(["tests", "docs"])(
    "moving an exempt %s file into src cannot retain Zod",
    async (directory) => {
      const root = await scenario();
      try {
        await mkdir(join(root, directory));
        await writeFile(
          join(root, directory, "oracle.ts"),
          'import { z } from "zod";\nexport const oracle = z.number();\n',
        );
        git(root, "add", "-A");
        git(root, "commit", "-m", "exempt oracle base");
        const base = git(root, "rev-parse", "HEAD");
        await rename(
          join(root, directory, "oracle.ts"),
          join(root, "src/oracle.ts"),
        );
        git(root, "add", "-A");
        git(root, "commit", "-m", "move oracle into production");
        expect(
          git(root, "diff", "--name-status", "-M", base, "HEAD"),
        ).toContain("R100");
        const { status, output } = runHook(root, base);
        expect(status).toBe(1);
        expect(output).toContain("src/oracle.ts");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.each([
    "swap",
    "unresolved",
    "ambiguous",
    "copy",
    "binding",
    "logic",
    "dynamic",
  ])("%s cannot claim the import/move exception", async (kind) => {
    const root = await scenario();
    try {
      await writeFile(join(root, "src/helper.ts"), "export const value = 1;\n");
      const before =
        'import { z } from "zod";\nimport { value } from "./helper";\n' +
        "export const s = z.string();\nexport const n = value;\n";
      await writeFile(join(root, "src/zod-file.ts"), before);
      git(root, "add", "-A");
      git(root, "commit", "-m", "base with helper");
      const base = git(root, "rev-parse", "HEAD");
      if (kind === "swap" || kind === "copy") {
        await writeFile(
          join(root, "src/renamed.ts"),
          "export const value = 1;\n",
        );
      } else if (kind !== "unresolved") {
        await rename(join(root, "src/helper.ts"), join(root, "src/renamed.ts"));
      }
      if (kind === "ambiguous") {
        await mkdir(join(root, "src/renamed"));
        await writeFile(
          join(root, "src/renamed/index.ts"),
          "export const value = 2;\n",
        );
      }
      let after = before.replace('"./helper"', '"./renamed"');
      if (kind === "binding") after = after.replace("{ z }", "{ z, ZodError }");
      if (kind === "logic") after = after.replace("z.string()", "z.number()");
      if (kind === "dynamic") after += 'const loaded = import("./renamed");\n';
      if (kind === "copy") {
        // An added copy cannot inherit a legacy import's base identity.
        await writeFile(join(root, "src/copy.ts"), after);
      } else {
        await writeFile(join(root, "src/zod-file.ts"), after);
      }
      git(root, "add", "-A");
      git(root, "commit", "-m", "unproven mechanical change");
      expect(runHook(root, base).status).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("same-token ASI changes fail even alongside a valid target rename", async () => {
    const root = await scenario();
    try {
      await writeFile(join(root, "src/helper.ts"), "export const value = 1;\n");
      const before =
        'import { z } from "zod";\nimport { value } from "./helper";\n' +
        "export const s = z.string();\nexport function f() { return\nvalue; }\n";
      await writeFile(join(root, "src/zod-file.ts"), before);
      git(root, "add", "-A");
      git(root, "commit", "-m", "ASI base");
      const base = git(root, "rev-parse", "HEAD");
      await rename(join(root, "src/helper.ts"), join(root, "src/renamed.ts"));
      await writeFile(
        join(root, "src/zod-file.ts"),
        before
          .replace('"./helper"', '"./renamed"')
          .replace("return\nvalue", "return value"),
      );
      git(root, "add", "-A");
      git(root, "commit", "-m", "ASI logic change");
      expect(runHook(root, base).status).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a Git diff error fails closed after resolving a valid base", async () => {
    const root = await scenario();
    try {
      const base = git(root, "rev-parse", "HEAD");
      const realGit = Bun.which("git");
      if (!realGit) throw new Error("git is required");
      await mkdir(join(root, "bin"));
      await writeFile(
        join(root, "bin/git"),
        `#!/bin/sh\nif [ "$1" = diff ]; then exit 9; fi\nexec "${realGit}" "$@"\n`,
        { mode: 0o700 },
      );
      const { status, output } = runHook(root, base, {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env["PATH"] ?? ""}`,
      });
      expect(status).toBe(1);
      expect(output).toContain("cannot compare with");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("touching a Zod file without migrating it fails", async () => {
    const root = await scenario();
    try {
      const base = git(root, "rev-parse", "HEAD");
      await writeFile(
        join(root, "src/zod-file.ts"),
        'import { z } from "zod";\nexport const s = z.string();\nexport const t = true;\n',
      );
      git(root, "add", "-A");
      git(root, "commit", "-m", "touch without migrating");
      const { status, output } = runHook(root, base);
      expect(status).toBe(1);
      expect(output).toContain("still import zod");
      expect(output).toContain("src/zod-file.ts");
      expect(output).toContain("docs/effect-schema-migration.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("migrating the touched Zod file passes", async () => {
    const root = await scenario();
    try {
      const base = git(root, "rev-parse", "HEAD");
      await writeFile(
        join(root, "src/zod-file.ts"),
        'import { Schema } from "effect";\nexport const s = Schema.String;\n',
      );
      git(root, "add", "-A");
      git(root, "commit", "-m", "migrate the touched file");
      expect(runHook(root, base).status).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("touching only clean files leaves untouched Zod files alone", async () => {
    const root = await scenario();
    try {
      const base = git(root, "rev-parse", "HEAD");
      await writeFile(
        join(root, "src/clean.ts"),
        'import { Schema } from "effect";\nexport const s = Schema.String;\nexport const t = true;\n',
      );
      git(root, "add", "-A");
      git(root, "commit", "-m", "touch a clean file");
      expect(runHook(root, base).status).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("test fixtures are exempt; an unresolvable base fails closed", async () => {
    const root = await scenario();
    try {
      const base = git(root, "rev-parse", "HEAD");
      await mkdir(join(root, "tests"), { recursive: true });
      await writeFile(
        join(root, "tests/legacy-oracle.ts"),
        'import { z } from "zod";\nexport const s = z.string();\n',
      );
      git(root, "add", "-A");
      git(root, "commit", "-m", "zod inside tests");
      expect(runHook(root, base).status).toBe(0);
      expect(
        runHook(root, "0000000000000000000000000000000000000000").status,
      ).toBe(1);
      expect(runHook(root, "").status).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("subpath and dynamic Zod imports are caught", async () => {
    const root = await scenario();
    try {
      const base = git(root, "rev-parse", "HEAD");
      await writeFile(
        join(root, "src/zod-file.ts"),
        'export const m = await import("zod/v4");\n',
      );
      git(root, "add", "-A");
      git(root, "commit", "-m", "subpath import");
      const { status, output } = runHook(root, base);
      expect(status).toBe(1);
      expect(output).toContain("src/zod-file.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a base with no shared history fails closed", async () => {
    const root = await scenario();
    try {
      const base = git(root, "rev-parse", "HEAD");
      // An orphan branch gives the repository two roots: the base still
      // resolves, but no merge base exists, like CI's shallow checkout.
      git(root, "checkout", "--orphan", "detached-head");
      git(root, "rm", "-rq", "--cached", ".");
      await writeFile(
        join(root, "other.ts"),
        'import { Schema } from "effect";\nexport const s = Schema.String;\n',
      );
      git(root, "add", "other.ts");
      git(root, "commit", "-qm", "unrelated history");
      const { status, output } = runHook(root, base);
      expect(status).toBe(1);
      expect(output).toContain("cannot compare with");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("non-TypeScript files mentioning the specifier are exempt", async () => {
    const root = await scenario();
    try {
      const base = git(root, "rev-parse", "HEAD");
      await mkdir(join(root, "scripts/hooks"), { recursive: true });
      await writeFile(
        join(root, "scripts/hooks/enforcer.sh"),
        'if grep -q \'from "zod"\' "$file"; then echo match; fi\n',
      );
      git(root, "add", "-A");
      git(root, "commit", "-m", "enforcer mentions the import specifier");
      expect(runHook(root, base).status).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
