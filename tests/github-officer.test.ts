import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitHubOperation } from "../scripts/github-operations";
import type { GitHubAdapter, JsonObject } from "../scripts/github-wire";
import { officerRequest } from "../scripts/github-officer";

test("the GitHub officer entrypoint validates the selected operation before invoking its adapter", () => {
  const args = [
    "review",
    "--repo",
    "fixture",
    "--pr",
    "377",
    "--proof-id",
    "proof-10",
  ];

  expect(officerRequest(args)).toEqual({
    operation: "review",
    repo: "fixture",
    pr: 377,
    proof_id: "proof-10",
    branch: null,
    directory: null,
    expected_head: null,
    input: null,
    output: null,
  });
  expect(() => officerRequest(["credential", "--repo", "fixture"])).toThrow(
    "supported",
  );
  expect(() => officerRequest(["token", "--repo", "fixture"])).toThrow(
    "supported",
  );
  expect(() => officerRequest(["check", "--repo", "../fixture"])).toThrow(
    "repository key",
  );
  expect(() =>
    officerRequest(["merge", "--repo", "fixture", "--pr", "0x17"]),
  ).toThrow("positive");
  expect(() =>
    officerRequest(["check", "--repo", "fixture", "--directory", "/tmp"]),
  ).toThrow("unavailable");
  expect(() => officerRequest(["publish", "--repo", "fixture"])).toThrow(
    "--input",
  );
});

test("the standalone CLI loads a configured adapter and performs a repository check", async () => {
  const directory = mkdtempSync(join(tmpdir(), "github-officer-cli-"));
  const path = join(directory, "fixture.ts");

  try {
    writeFileSync(
      path,
      `export function createAdapter() { return {
      policy: { organization: "example", readRepositories: ["project"] },
      async json(repo, scope, path) {
        if (repo !== "project" || scope !== "read" || path !== "/repos/example/project") throw new Error();
        return { full_name: "example/project" };
      },
    }; }`,
    );

    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--no-install",
        "scripts/github-officer.ts",
        path,
        "check",
        "--repo",
        "project",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );

    const [status, output] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);

    expect(status).toBe(0);
    expect(JSON.parse(output)).toEqual({
      repository: "example/project",
      read: true,
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

const head = "a".repeat(40);
const base = "b".repeat(40);
const mergeBase = "c".repeat(40);
const merged = "d".repeat(40);
const repository = "example/project";
const pullPath = "/repos/example/project/pulls/8";

const rawDiff = Buffer.from(
  "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n",
);

const contextDigest = createHash("sha256").update(rawDiff).digest("hex");
const marker = "fixture-review-v1:";

function proof(family: "codex" | "claude") {
  const model = family === "codex" ? "codex-model" : "claude-model";
  const agent = `peer-crew-${family}`;
  const resultText = "Reviewed the exact fixture diff.";

  return {
    id: `proof-${family}`,
    repository,
    pullRequest: 8,
    headSHA: head,
    baseSHA: base,
    mergeBaseSHA: mergeBase,
    contextDigest,
    authorShip: "owner",
    reviewerShip: "peer",
    coordinatorShip: "peer",
    reviewerAgent: agent,
    sessionID: "ses_fixture",
    inputID: `input-${family}`,
    kind: "crew",
    outcome: "completed",
    verdict: "approve",
    authority: "agent",
    humanApproval: false,
    resultText,
    resultDigest: createHash("sha256").update(resultText).digest("hex"),
    makers: [
      {
        provider: "fixture",
        model,
        agent,
        messageID: "message-" + family,
        variant: "high",
      },
    ],
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const item = value as Record<string, unknown>;

    return `{${Object.keys(item)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function receipt(value: ReturnType<typeof proof>, id: number) {
  const proofDigest = createHash("sha256")
    .update(canonical(value))
    .digest("hex");

  return {
    id,
    user: { login: "fixture-peer[bot]", type: "Bot" },
    commit_id: head,
    state: "APPROVED",
    body: `Previous review format.\n<!-- ${marker}${JSON.stringify({ proofID: value.id, proofDigest })} -->`,
  };
}

function fixture() {
  const first = proof("codex");
  const second = proof("claude");
  const reviews = [receipt(first, 1), receipt(second, 2)];
  const errors: string[] = [];
  const writes: { path: string; body?: JsonObject }[] = [];

  const pull = {
    number: 8,
    state: "open",
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: "clean",
    head: { sha: head, repo: { full_name: repository } },
    base: { sha: base, ref: "main", repo: { full_name: repository } },
    user: { login: "fixture-owner[bot]", type: "Bot" },
    changed_files: 1,
    additions: 1,
    deletions: 1,
  };

  const policy: GitHubAdapter["policy"] = {
    organization: "example",
    caller: "owner",
    app: "fixture-owner",
    home: "/fixture",
    rank: "captain",
    readRepositories: ["project"],
    writeRepositories: ["project"],
    mergeRepositories: ["project"],
    reviewMarker: marker,
    captains: {
      owner: { app: "fixture-owner", models: { build: "fixture/codex-model" } },
      peer: {
        app: "fixture-peer",
        models: {
          "peer-crew-codex": "fixture/codex-model",
          "peer-crew-claude": "fixture/claude-model",
        },
      },
    },
    reviewModels: {
      codex: ["fixture/codex-model"],
      claude: ["fixture/claude-model"],
    },
  };

  const adapter: GitHubAdapter = {
    policy,
    async json(repo, _scope, path, options) {
      expect(repo).toBe("project");

      if (options?.body) {
        writes.push({ path, body: options.body });
      }

      if (path === pullPath) {
        return structuredClone(pull);
      }

      if (path.startsWith("/repos/example/project/compare/")) {
        return {
          base_commit: { sha: base },
          merge_base_commit: { sha: mergeBase },
        };
      }

      if (path.startsWith(pullPath + "/reviews?")) {
        return reviews;
      }

      if (path === pullPath + "/merge") {
        return { merged: true, sha: merged };
      }

      errors.push(path);
      throw new Error("Unexpected GitHub request.");
    },
    async diff() {
      return rawDiff;
    },
    async git() {
      return "";
    },
    async proof(id) {
      return id === first.id ? first : second;
    },
    async proofs() {
      return [first, second];
    },
  };

  return { adapter, pull, first, second, reviews, writes, errors };
}

const mergeRequest = officerRequest([
  "merge",
  "--repo",
  "project",
  "--pr",
  "8",
]);

test("merge rechecks both native review families, the exact diff, and sends only the reviewed head", async () => {
  const { adapter, writes, errors } = fixture();

  expect(await runGitHubOperation(adapter, mergeRequest)).toMatchObject({
    merged: true,
    mergeSHA: merged,
    headSHA: head,
    observedBaseSHA: base,
    observedMergeBaseSHA: mergeBase,
  });
  expect(writes).toEqual([
    { path: pullPath + "/merge", body: { sha: head, merge_method: "merge" } },
  ]);
  expect(errors).toEqual([]);
});

test("merge refuses stale or unverifiable evidence before a write", async () => {
  const scenarios = [
    (testFixture: ReturnType<typeof fixture>) => {
      testFixture.pull.head.sha = "e".repeat(40);
    },
    (testFixture: ReturnType<typeof fixture>) => {
      testFixture.pull.mergeable_state = "blocked";
    },
    (testFixture: ReturnType<typeof fixture>) => {
      testFixture.reviews.pop();
    },
    (testFixture: ReturnType<typeof fixture>) => {
      const maker = testFixture.first.makers[0];

      if (maker) {
        maker.variant = "xhigh";
      }
    },
    (testFixture: ReturnType<typeof fixture>) => {
      const receipt = testFixture.reviews[0];

      if (receipt) {
        receipt.user.login = "other-app[bot]";
      }
    },
  ];

  for (const modify of scenarios) {
    const testFixture = fixture();

    modify(testFixture);
    await expect(
      runGitHubOperation(testFixture.adapter, mergeRequest),
    ).rejects.toThrow();
    expect(testFixture.writes).toEqual([]);
  }
});

test("signed publication keeps repository, feature ref, mutation and expected head bound together", async () => {
  const directory = mkdtempSync(join(tmpdir(), "github-officer-publish-"));
  const path = join(directory, "publish.json");
  const operations: unknown[] = [];
  const { adapter } = fixture();

  const mutation = {
    query:
      "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }",
    variables: {
      input: {
        branch: {
          repositoryNameWithOwner: repository,
          branchName: "feat/example",
        },
        expectedHeadOid: head,
        message: { headline: "Example signed change" },
      },
    },
  };

  adapter.json = async (repo, scope, endpoint, options) => {
    operations.push({ repo, scope, endpoint, body: options?.body });

    return { data: { createCommitOnBranch: { commit: { oid: merged } } } };
  };

  try {
    const request = officerRequest([
      "publish",
      "--repo",
      "project",
      "--input",
      path,
    ]);

    writeFileSync(path, JSON.stringify(mutation));
    expect(await runGitHubOperation(adapter, request)).toEqual({ oid: merged });
    expect(operations).toEqual([
      {
        repo: "project",
        scope: "publish",
        endpoint: "/graphql",
        body: mutation,
      },
    ]);

    mutation.variables.input.branch.repositoryNameWithOwner = "other/project";
    writeFileSync(path, JSON.stringify(mutation));
    await expect(runGitHubOperation(adapter, request)).rejects.toThrow(
      "selected repository",
    );
    expect(operations).toHaveLength(1);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("repositories outside standing merge authority can only enter a protected queue after exact-head human approval", async () => {
  const { adapter, pull } = fixture();

  const approved = {
    id: 9,
    user: { id: 5, type: "User", login: "owner" },
    state: "APPROVED",
    commit_id: head,
    submitted_at: "2026-01-02T12:00:00Z",
  };

  const queue = { id: "queue-unit" };

  const entry = {
    id: "entry-unit",
    position: 2,
    state: "QUEUED",
    headCommit: { oid: head },
    mergeQueue: queue,
  };

  const writes: JsonObject[] = [];
  let permission = "write";

  adapter.policy.mergeRepositories = [];
  pull.base.ref = "develop";
  adapter.json = async (_repo, scope, path, options) => {
    if (path === pullPath) {
      return pull;
    }

    if (path.startsWith(pullPath + "/reviews?")) {
      return [approved];
    }

    if (path.endsWith("/collaborators/owner/permission")) {
      return { permission, user: approved.user };
    }

    if (path.endsWith("/branches/develop")) {
      return { protected: true, commit: { sha: base } };
    }

    if (path === "/graphql" && scope === "read") {
      return {
        data: {
          repository: {
            pullRequest: {
              id: "fixture-pull",
              baseRefName: "develop",
              baseRefOid: base,
              headRefOid: head,
              isDraft: false,
              state: "OPEN",
              reviewDecision: "APPROVED",
              mergeStateStatus: "CLEAN",
              isMergeQueueEnabled: true,
              mergeQueue: queue,
              mergeQueueEntry: null,
              timelineItems: { nodes: [] },
            },
          },
        },
      };
    }

    if (path.includes("/rulesets?")) {
      return [{ id: 17, target: "branch", enforcement: "active" }];
    }

    if (path.endsWith("/rulesets/17")) {
      return {
        conditions: {
          ref_name: { include: ["refs/heads/develop"], exclude: [] },
        },
        rules: [
          { type: "merge_queue" },
          {
            type: "pull_request",
            parameters: {
              required_approving_review_count: 1,
              dismiss_stale_reviews_on_push: true,
              require_last_push_approval: true,
              require_code_owner_review: true,
            },
          },
        ],
      };
    }

    if (path === "/graphql" && scope === "enqueue" && options?.body) {
      writes.push(options.body);

      return { data: { enqueuePullRequest: { mergeQueueEntry: entry } } };
    }

    throw new Error("Unexpected queue request.");
  };

  expect(await runGitHubOperation(adapter, mergeRequest)).toMatchObject({
    queued: true,
    headSHA: head,
    base: "develop",
    queueEntryID: entry.id,
    humanApproval: true,
    reviewID: 9,
  });
  expect(writes).toMatchObject([{ variables: { pr: "fixture-pull", head } }]);

  permission = "read";
  await expect(runGitHubOperation(adapter, mergeRequest)).rejects.toThrow(
    "repository writer",
  );
  expect(writes).toHaveLength(1);
});
