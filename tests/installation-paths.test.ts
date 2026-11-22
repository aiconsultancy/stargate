import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import manifest from "../package.json";
import {
  assetsDirectory,
  installationDirectory,
  mainEntrypoint,
  packageJsonPath,
  packageManifest,
  templatesDirectory,
} from "../src/lib/installation-paths";
import { packageDirectory } from "../src/maintenance/nightly/update/ready";

const root = fileURLToPath(new URL("..", import.meta.url));

test("installation paths identify the package files and preserve the public root", () => {
  expect(installationDirectory).toBe(root);
  expect(packageDirectory).toBe(root);
  expect(packageJsonPath).toBe(`${root}package.json`);
  expect(templatesDirectory).toBe(`${root}templates`);
  expect(assetsDirectory).toBe(`${root}assets`);
  expect(mainEntrypoint).toBe(`${root}src/main.ts`);
  expect(packageManifest).toBe(manifest);
});

test("installation root does not depend on the caller's working directory", async () => {
  const module = fileURLToPath(
    new URL("../src/lib/installation-paths.ts", import.meta.url),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { installationDirectory } from ${JSON.stringify(module)}; console.log(installationDirectory);`,
    ],
    { cwd: tmpdir(), stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [output, errors, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(errors).toBe("");
  expect(exit).toBe(0);
  expect(output).toBe(`${root}\n`);
});
