import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

function runHook(dir: string, base: string) {
  const result = spawnSync("/bin/sh", [HOOK, base], {
    cwd: dir,
    timeout: 30_000,
    encoding: "utf8",
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
