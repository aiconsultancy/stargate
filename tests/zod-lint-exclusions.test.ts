import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("lint exclusions reject migrated and missing files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "stargate-zod-exclusions-"));

  const check = () =>
    Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "../scripts/check-zod-exclusions.ts"),
      ],
      { cwd },
    );

  try {
    mkdirSync(join(cwd, "src"));
    writeFileSync(
      join(cwd, "src/active.ts"),
      'export type Z = import("zod/v4").ZodType;\n',
    );
    writeFileSync(
      join(cwd, "src/migrated.ts"),
      '// import { z } from "zod";\n',
    );
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd }).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "add", "src"], { cwd }).exitCode).toBe(0);

    const config = (excludeFiles: string[]) =>
      writeFileSync(
        join(cwd, ".oxlintrc.json"),
        JSON.stringify({ overrides: [{ excludeFiles }] }),
      );

    config(["src/active.ts", "src/migrated.ts", "src/missing.ts"]);

    const stale = check();
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr.toString()).toContain(
      "src/migrated.ts no longer imports Zod",
    );
    expect(stale.stderr.toString()).toContain(
      "src/missing.ts is missing or untracked",
    );

    config(["src/active.ts"]);
    const repaired = check();
    expect(repaired.stderr.toString()).toBe("");
    expect(repaired.exitCode).toBe(0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
