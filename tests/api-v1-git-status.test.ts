import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitReader } from "../src/api/v1/git";

test.each(["clean", "process"])(
  "reads changed paths with a checkout-configured %s filter disabled",
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "stargate-api-git-"));
    const git = (...args: string[]) => {
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
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    try {
      git("init", "-b", "main");
      const tracked = join(directory, "tracked.txt");
      await writeFile(tracked, "original\n");
      await writeFile(
        join(directory, ".gitattributes"),
        "tracked.txt filter=fixture\n",
      );
      git("add", ".");
      git("commit", "-m", "Initial");
      git("config", `filter.fixture.${kind}`, "false");
      git("config", "filter.fixture.required", "true");
      await writeFile(tracked, "modified\n");
      expect(
        await createGitReader()(directory, new AbortController().signal),
      ).toMatchObject({ branch: "main", changedFiles: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
