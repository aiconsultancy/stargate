/**
 * Run `bun test` the way a self-update runs it: the same minimal
 * environment (`isolatedEnvironment`), with HOME and TMPDIR inside a hidden
 * `.staging-*` directory. Arguments pass through to `bun test`.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isolatedEnvironment } from "../src/nightly/release";

const cache = process.env["XDG_CACHE_HOME"] || join(homedir(), ".cache");
await mkdir(cache, { recursive: true });
const base = await mkdtemp(join(cache, "pogo-release-test-"));
try {
  const env = await isolatedEnvironment(join(base, ".staging-test"));
  const child = Bun.spawn(
    [process.execPath, "test", ...process.argv.slice(2)],
    {
      env,
      stdio: ["inherit", "inherit", "inherit"],
    },
  );
  process.exitCode = await child.exited;
} finally {
  await rm(base, { recursive: true, force: true });
}
