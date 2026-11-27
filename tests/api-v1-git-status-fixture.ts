import { afterAll } from "bun:test";
import { readdir } from "node:fs/promises";
import { createGitReader } from "../src/observability/dashboard/api/v1/git";

/**
 * A createGitReader whose readers all stop after the calling test file, so
 * No private temporary snapshot folder is left behind. Call it once at the
 * Top of a test file.
 */
export function stoppedGitReaders() {
  const readers: { stop(): Promise<void> }[] = [];
  afterAll(() => Promise.all(readers.map((reader) => reader.stop())));

  return (
    ...args: Parameters<typeof createGitReader>
  ): ReturnType<typeof createGitReader> => {
    const reader = createGitReader(...args);
    readers.push(reader);

    return reader;
  };
}

export function git(directory: string, ...args: string[]) {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd: directory },
  );

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }

  return result.stdout.toString().trim();
}

export async function waitForRemoval(directory: string, name?: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const entries = await readdir(directory);

    if (name === undefined ? !entries.length : !entries.includes(name)) {
      return;
    }

    await Bun.sleep(5);
  }
}
