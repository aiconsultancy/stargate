import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const HOOK = join(import.meta.dir, "../scripts/hooks/pre-push-main.sh");
const ZERO = "0".repeat(40);

/**
 * Run the hook inside `dir`, simulating prek's invocation: the push is
 * described through PRE_COMMIT_* environment variables, never stdin.
 */
function runHook(dir: string, env: { remoteBranch?: string; toRef?: string }) {
  const result = spawnSync("/bin/sh", [HOOK], {
    cwd: dir,
    timeout: 30_000,
    encoding: "utf8",
    env: {
      ...process.env,
      PRE_COMMIT: "1",
      PREK_HOOK_STAGE: "pre-push",
      PRE_COMMIT_REMOTE_BRANCH: env.remoteBranch ?? "",
      PRE_COMMIT_TO_REF: env.toRef ?? "",
    },
  });
  return {
    status: result.status ?? -1,
    output: `${result.stdout}${result.stderr}`,
  };
}

function git(dir: string, ...args: string[]) {
  const result = spawnSync("git", ["-C", dir, ...args], {
    timeout: 30_000,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A scratch remote with `main`, plus a clone whose origin is that remote. */
async function scenario() {
  const root = await mkdtemp(join(tmpdir(), "pre-push-hook-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  git(root, "init", "--bare", "-b", "main", remote);
  git(root, "init", "-b", "main", work);
  git(work, "config", "user.email", "hook-test@example.invalid");
  git(work, "config", "user.name", "Hook Test");
  await writeFile(join(work, "file.txt"), "one\n");
  git(work, "add", "-A");
  git(work, "commit", "-m", "base");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "--quiet", "origin", "main");
  return { root, remote, work };
}

describe("pre-push main-ancestor hook", () => {
  test("an up-to-date branch push passes", async () => {
    const { root, work } = await scenario();
    try {
      git(work, "checkout", "-b", "feature");
      await writeFile(join(work, "file.txt"), "two\n");
      git(work, "commit", "-am", "feature");
      git(work, "fetch", "--quiet", "origin");
      const sha = git(work, "rev-parse", "HEAD");
      const { status } = runHook(work, {
        remoteBranch: "refs/heads/feature",
        toRef: sha,
      });
      expect(status).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a behind-main branch is refused with rebase instructions", async () => {
    const { root, remote, work } = await scenario();
    try {
      // Move the remote's main forward without updating the local clone.
      const other = join(root, "other");
      git(root, "clone", "--quiet", remote, other);
      git(other, "config", "user.email", "hook-test@example.invalid");
      git(other, "config", "user.name", "Hook Test");
      await writeFile(join(other, "file.txt"), "moved on\n");
      git(other, "commit", "-am", "advance main");
      git(other, "push", "--quiet", "origin", "main");

      git(work, "checkout", "-b", "stale");
      await writeFile(join(work, "file.txt"), "stale change\n");
      git(work, "commit", "-am", "stale");
      git(work, "fetch", "--quiet", "origin");
      const sha = git(work, "rev-parse", "HEAD");
      const { status, output } = runHook(work, {
        remoteBranch: "refs/heads/stale",
        toRef: sha,
      });
      expect(status).toBe(1);
      expect(output).toContain("behind the fetched origin/main");
      expect(output).toContain("git rebase origin/main");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("main pushes, deletions and non-branch refs are skipped", async () => {
    const { root, work } = await scenario();
    try {
      const sha = git(work, "rev-parse", "HEAD");
      expect(
        runHook(work, { remoteBranch: "refs/heads/main", toRef: sha }).status,
      ).toBe(0);
      expect(
        runHook(work, { remoteBranch: "refs/heads/gone", toRef: ZERO }).status,
      ).toBe(0);
      expect(
        runHook(work, { remoteBranch: "refs/tags/v1", toRef: sha }).status,
      ).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("outside prek, with no push context, the hook passes", async () => {
    const { root, work } = await scenario();
    try {
      const result = spawnSync("/bin/sh", [HOOK], {
        cwd: work,
        timeout: 30_000,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a failed fetch refuses the push with a clear message", async () => {
    const { root, work } = await scenario();
    try {
      git(work, "remote", "set-url", "origin", join(root, "missing.git"));
      git(work, "checkout", "-b", "feature");
      const featureSha = git(work, "rev-parse", "HEAD");
      const { status, output } = runHook(work, {
        remoteBranch: "refs/heads/feature",
        toRef: featureSha,
      });
      expect(status).toBe(1);
      expect(output).toContain("cannot fetch origin/main");
      expect(output).toContain("--no-verify");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
