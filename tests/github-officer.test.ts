import { permissions } from "../scripts/github-local-app";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
        if (repo !== "project" || scope !== "check" || path !== "/repos/example/project") throw new Error();
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

    const mcp = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--no-install",
        "scripts/github-officer-mcp.ts",
        path,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );

    const requests = [
      { method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { method: "tools/list" },
      {
        method: "tools/call",
        params: {
          name: "operate",
          arguments: { operation: "check", repo: "project" },
        },
      },
      {
        method: "tools/call",
        params: {
          name: "operate",
          arguments: { operation: "check", repo: "foreign" },
        },
      },
      {
        method: "tools/call",
        params: {
          name: "operate",
          arguments: { operation: "check", repo: "project", command: "bash" },
        },
      },
    ];

    await mcp.stdin.write(
      requests
        .map((request, id) =>
          JSON.stringify({ ...request, id, jsonrpc: "2.0" }),
        )
        .join("\n") + "\n",
    );
    await mcp.stdin.end();
    const mcpOutput = await new Response(mcp.stdout).text();

    const replies = mcpOutput
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(await mcp.exited).toBe(0);
    expect(replies[0]?.result.serverInfo.name).toBe("github-officer");
    expect(replies[1]?.result.tools).toMatchObject([{ name: "operate" }]);
    expect(JSON.parse(replies[2]?.result.content[0].text)).toEqual({
      repository: "example/project",
      read: true,
    });
    expect(replies[3]?.result.isError).toBe(true);
    expect(replies[4]?.result.isError).toBe(true);
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

function proof(family: "codex" | "claude", approvedHead: string) {
  const model = family === "codex" ? "codex-model" : "claude-model";
  const agent = `peer-crew-${family}`;
  const resultText = "Reviewed the exact fixture diff.";

  return {
    id: `proof-${family}`,
    repository,
    pullRequest: 8,
    headSHA: approvedHead,
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
    commit_id: value.headSHA,
    state: "APPROVED",
    body: `Previous review format.\n<!-- ${marker}${JSON.stringify({ proofID: value.id, proofDigest })} -->`,
  };
}

function fixture(approvedHead = head) {
  const first = proof("codex", approvedHead);
  const second = proof("claude", approvedHead);
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
    head: { sha: approvedHead, repo: { full_name: repository } },
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

test("a repository check requests metadata and read-only content without PR access", () => {
  expect(permissions("check")).toEqual({ metadata: "read", contents: "read" });
  expect(permissions("pr-status")).toMatchObject({
    pull_requests: "read",
    checks: "read",
  });
});

test("push accepts the configured HTTPS repository with or without the .git suffix", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "github-push-")));
  const checkout = join(home, "project");
  const gitDir = join(checkout, ".git");
  mkdirSync(gitDir, { recursive: true });
  const { adapter } = fixture();
  adapter.policy.home = home;
  let origin: string;
  const pushed: string[][] = [];
  adapter.git = async (_directory, args, publication) => {
    if (args[0] === "remote") {
      return origin;
    }

    if (args.includes("--show-toplevel")) {
      return checkout;
    }

    if (args.includes("--git-common-dir")) {
      return gitDir;
    }

    if (args[0] === "symbolic-ref") {
      return "fix/example";
    }

    expect(publication).toBe("project");
    pushed.push(args);

    return "";
  };

  const request = officerRequest([
    "push",
    "--repo",
    "project",
    "--directory",
    checkout,
    "--branch",
    "fix/example",
  ]);

  try {
    for (origin of [
      "https://github.com/example/project",
      "https://github.com/example/project.git",
    ]) {
      expect(await runGitHubOperation(adapter, request)).toMatchObject({
        pushed: true,
      });
    }

    origin = "https://GitHub.com:443/EXAMPLE/project/";
    expect(await runGitHubOperation(adapter, request)).toMatchObject({
      pushed: true,
    });
    origin = "https://github.com/unassigned/project";
    await expect(runGitHubOperation(adapter, request)).rejects.toThrow(
      "Unexpected push origin",
    );
    expect(pushed).toEqual(
      Array.from({ length: 3 }, () => [
        "push",
        "https://github.com/example/project.git",
        "HEAD:refs/heads/fix/example",
      ]),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the local App can use non-prefixed branches but respects operator protection globs", async () => {
  const { adapter } = fixture();
  adapter.policy.protectedBranches = ["main", "release/*", "stable.?"];
  adapter.git = async () => "";
  const directory = mkdtempSync(join(tmpdir(), "github-ref-"));
  const input = join(directory, "pr.json");

  const pr = officerRequest([
    "pr-create",
    "--repo",
    "project",
    "--input",
    input,
  ]);

  let mutations = 0;
  adapter.json = async () => {
    mutations++;

    return { number: 21 };
  };

  try {
    for (const head of ["main", "release/nested/branch", "stable.1"]) {
      writeFileSync(
        input,
        JSON.stringify({ title: "Title", head, base: "develop", body: "Body" }),
      );
      await expect(runGitHubOperation(adapter, pr)).rejects.toThrow(
        "protected by the fleet",
      );
    }

    writeFileSync(
      input,
      JSON.stringify({
        title: "Title",
        head: "workstream/deploy",
        base: "develop",
        body: "Body",
      }),
    );
    expect(await runGitHubOperation(adapter, pr)).toMatchObject({ number: 21 });
    expect(mutations).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("local squash requires an App-owned ready PR, a protected default branch, and exact-head human approval", async () => {
  const { adapter, pull } = fixture();
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "github-squash-")));
  const request = { ...mergeRequest, directory: checkout, expected_head: head };
  adapter.policy.squashCheckout = checkout;
  let permission = "write";
  let approvedHead = "e".repeat(40);
  let moved = false;
  let checks = 0;
  let writes = 0;
  adapter.json = async (_repo, scope, path, options) => {
    if (path === pullPath) {
      if (moved && ++checks === 2) {
        return { ...pull, head: { ...pull.head, sha: "e".repeat(40) } };
      }

      return pull;
    }

    if (path === "/repos/example/project") {
      expect(scope).toBe("check");

      return { full_name: repository, default_branch: "main" };
    }

    if (path.endsWith("/branches/main")) {
      return { protected: true, commit: { sha: base } };
    }

    if (path.startsWith(pullPath + "/reviews?")) {
      return [
        {
          id: 1,
          state: "APPROVED",
          commit_id: approvedHead,
          submitted_at: "2026-01-02T12:00:00Z",
          user: { type: "User", id: 2, login: "human-reviewer" },
        },
      ];
    }

    if (path.endsWith("/collaborators/human-reviewer/permission")) {
      return { user: { type: "User", id: 2 }, permission };
    }

    expect(scope).toBe("merge");
    expect(options?.body).toEqual({ sha: head, merge_method: "squash" });
    writes++;

    return { merged: true, sha: merged };
  };

  try {
    await expect(runGitHubOperation(adapter, request)).rejects.toThrow(
      "current-head human approval",
    );
    approvedHead = head;
    permission = "read";
    await expect(runGitHubOperation(adapter, request)).rejects.toThrow(
      "repository writer",
    );
    permission = "write";
    pull.user.login = "other-app[bot]";
    await expect(runGitHubOperation(adapter, request)).rejects.toThrow(
      "own open App PR",
    );
    pull.user.login = "fixture-owner[bot]";
    pull.base.ref = "release";
    await expect(runGitHubOperation(adapter, request)).rejects.toThrow(
      "default branch",
    );
    pull.base.ref = "main";
    moved = true;
    await expect(runGitHubOperation(adapter, request)).rejects.toThrow(
      "exact current head",
    );
    expect(writes).toBe(0);
    moved = false;
    expect(await runGitHubOperation(adapter, request)).toMatchObject({
      merged: true,
      humanApproval: true,
    });
    expect(writes).toBe(1);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

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

test("merge refuses a stale requested head even when the replacement has valid approvals", async () => {
  const replacement = "e".repeat(40);
  const { adapter, writes } = fixture(replacement);
  const request = { ...mergeRequest, expected_head: head };

  await expect(runGitHubOperation(adapter, request)).rejects.toThrow(
    "requested merge SHA",
  );
  expect(writes).toEqual([]);
  expect(
    await runGitHubOperation(adapter, {
      ...request,
      expected_head: replacement,
    }),
  ).toMatchObject({ merged: true, headSHA: replacement });
});

test("merge refuses a head change between the proof check and the write", async () => {
  const nextHead = "e".repeat(40);
  const { adapter, pull, writes } = fixture();
  const json = adapter.json;
  let reads = 0;
  adapter.json = async (repo, scope, path, options) => {
    if (path === pullPath && ++reads === 2) {
      pull.head.sha = nextHead;
    }

    return json(repo, scope, path, options);
  };

  await expect(
    runGitHubOperation(adapter, { ...mergeRequest, expected_head: head }),
  ).rejects.toThrow("head changed before merge");
  expect(writes).toEqual([]);
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
  const replacement = "e".repeat(40);
  const { adapter, pull } = fixture(replacement);

  const approved = {
    id: 9,
    user: { id: 5, type: "User", login: "owner" },
    state: "APPROVED",
    commit_id: replacement,
    submitted_at: "2026-01-02T12:00:00Z",
  };

  const queue = { id: "queue-unit" };

  const entry = {
    id: "entry-unit",
    position: 2,
    state: "QUEUED",
    headCommit: { oid: replacement },
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
              headRefOid: replacement,
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

  await expect(
    runGitHubOperation(adapter, { ...mergeRequest, expected_head: head }),
  ).rejects.toThrow("requested merge SHA");
  expect(writes).toEqual([]);

  const request = { ...mergeRequest, expected_head: replacement };
  expect(await runGitHubOperation(adapter, request)).toMatchObject({
    queued: true,
    headSHA: replacement,
    base: "develop",
    queueEntryID: entry.id,
    humanApproval: true,
    reviewID: 9,
  });
  expect(writes).toMatchObject([
    { variables: { pr: "fixture-pull", head: replacement } },
  ]);

  permission = "read";
  await expect(runGitHubOperation(adapter, request)).rejects.toThrow(
    "repository writer",
  );
  expect(writes).toHaveLength(1);
});
