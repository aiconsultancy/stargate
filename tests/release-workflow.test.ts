import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("main checks do not invoke a release or run a second full suite", async () => {
  const check = await readFile(
    new URL("../.github/workflows/check.yml", import.meta.url),
    "utf8",
  );

  expect(check).not.toContain("uses: ./.github/workflows/release.yml");
  expect(check).not.toMatch(/^ {2}release:/m);
  expect(check).not.toMatch(/^\s+run: mise run check\s*$/m);
  expect(check).toContain("mise run test-release-env");
  expect(check).toMatch(
    /^\s+run: mise exec -- bun test tests\/mesij\.test\.ts$/m,
  );
});

test("only explicit manual publication crosses the release environment approval gate", async () => {
  const release = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );

  expect(release).not.toContain("workflow_call:");
  expect(release).toContain("workflow_dispatch:");
  expect(release).toMatch(/dry_run:[\s\S]*?type: boolean[\s\S]*?default: true/);
  expect(release).toContain("environment: release");
  expect(release).toContain("!inputs.dry_run");
  expect(release).toContain("github.ref == 'refs/heads/main'");
  expect(release).toContain("Require passed Quality checks");
  expect(release).toContain("--notes-file release-notes.md");
});
