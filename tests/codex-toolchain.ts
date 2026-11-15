/**
 * The programs that Codex tests run, for a backend's `extraPath`. The
 * Codex CLI never inherits PATH and takes system directories only when root
 * controls every program in them, which hosted CI runners do not satisfy.
 * Tests therefore list their own toolchain: a directory of links to the
 * host programs that this test process finds on its PATH.
 */
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const programs = [
  "cat",
  "curl",
  "env",
  "git",
  "grep",
  "ln",
  "ls",
  "mkdir",
  "rm",
  "sh",
  "sleep",
  "touch",
  "true",
];

/** Creates the toolchain directory; `remove` deletes it again. */
export async function toolchain() {
  const directory = await mkdtemp(join(tmpdir(), "stargate-codex-toolchain-"));
  for (const name of programs) {
    const path = Bun.which(name);
    if (path) await symlink(path, join(directory, name));
  }
  return {
    directory,
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}
