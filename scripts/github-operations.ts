import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { officerRequest } from "./github-officer";
import { humanApproval, reviewContext, reviewOperation } from "./github-review";
import {
  type GitHubAdapter,
  type JsonObject,
  check,
  field,
  githubRepository,
  graphqlOk,
  list,
  object,
  sha,
  text,
} from "./github-wire";

type OfficerRequest = ReturnType<typeof officerRequest>;

const branchPattern =
  /^(?:feat|fix|chore|docs|refactor|test|build|ci|perf|revert)\/[A-Za-z0-9][A-Za-z0-9/_.-]{0,180}$/;

const commitQuery =
  /^mutation(?:\s+[A-Za-z_]\w*)?\s*\(\s*\$input\s*:\s*CreateCommitOnBranchInput!\s*\)\s*\{\s*createCommitOnBranch\s*\(\s*input\s*:\s*\$input\s*\)\s*\{\s*commit\s*\{\s*(?:oid(?:\s+url)?|url(?:\s+oid)?)\s*\}\s*\}\s*\}\s*$/;

const publishLimit = 16 * 1024 * 1024;

function featureBranch(value: unknown, protectedBranches?: readonly string[]) {
  const branch = text(value);
  const namedBranch = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,180}$/;

  check(
    (protectedBranches ? namedBranch : branchPattern).test(branch) &&
      !branch.includes("..") &&
      !/[/.]$/.test(branch) &&
      branch
        .split("/")
        .every(
          (part) =>
            part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"),
        ),
    "Select a supported feature branch.",
  );

  for (const pattern of protectedBranches ?? []) {
    check(
      /^[a-zA-Z0-9*?._/-]{1,120}$/.test(pattern),
      "Invalid protected branch pattern.",
    );

    const matcher = new RegExp(
      "^" +
        pattern
          .replaceAll(".", "\\.")
          .replaceAll("*", ".*")
          .replaceAll("?", ".") +
        "$",
    );

    check(
      !matcher.test(branch),
      "The selected branch is protected by the fleet.",
    );
  }

  return branch;
}

function onlyFields(value: JsonObject, fields: string[], required = true) {
  const keys = Object.keys(value);

  return (
    keys.every((key) => fields.includes(key)) &&
    (!required || keys.length === fields.length)
  );
}

async function input(path: string | null, maximum = publishLimit) {
  const file = await open(
    text(path),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );

  try {
    const info = await file.stat();

    check(
      info.isFile() && info.size > 0 && info.size <= maximum,
      "Supply a bounded JSON input file.",
    );
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;

    while (length < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );

      if (bytesRead === 0) {
        break;
      }

      length += bytesRead;
    }

    check(length === info.size, "Input changed while it was read.");

    return object(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, length),
        ),
      ),
    );
  } finally {
    await file.close();
  }
}

function within(root: string, path: string) {
  const part = relative(root, path);

  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

async function push(
  adapter: GitHubAdapter,
  fullName: string,
  request: OfficerRequest,
) {
  const branch = featureBranch(
    request.branch,
    adapter.policy.protectedBranches,
  );

  const directory = await realpath(text(request.directory));
  const origin = `https://github.com/${fullName}.git`;
  const { home } = adapter.policy;

  check(within(home, directory), "Use your own checkout.");
  const gitDir = await stat(join(directory, ".git"));

  check(
    gitDir.isFile() || gitDir.isDirectory(),
    "Git metadata is unavailable.",
  );

  const configuredOrigin = URL.parse(
    await adapter.git(directory, ["remote", "get-url", "origin"]),
  );

  check(
    configuredOrigin?.protocol === "https:" &&
      configuredOrigin.hostname === "github.com" &&
      !configuredOrigin.username &&
      !configuredOrigin.password &&
      !configuredOrigin.search &&
      !configuredOrigin.hash &&
      configuredOrigin.pathname
        .replace(/\/$/, "")
        .replace(/\.git$/, "")
        .toLowerCase() === `/${fullName.toLowerCase()}`,
    "Unexpected push origin.",
  );
  const top = await adapter.git(directory, ["rev-parse", "--show-toplevel"]);

  const common = await adapter.git(directory, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);

  check(
    top === directory && within(home, await realpath(common)),
    "Checkout or Git metadata belongs to another user.",
  );
  check(
    (await adapter.git(directory, ["symbolic-ref", "--short", "HEAD"])) ===
      branch,
    "Push branch differs from checkout.",
  );
  await adapter.git(
    directory,
    ["push", origin, `HEAD:refs/heads/${branch}`],
    request.repo,
  );

  return { repository: request.repo, branch, pushed: true };
}

function selected(value: unknown, keys: string[]) {
  return Object.fromEntries(
    keys.map((key) => [key, field(value, key) ?? null]),
  );
}

async function status(
  adapter: GitHubAdapter,
  repo: string,
  root: string,
  endpoint: string,
) {
  const get = (path: string) => adapter.json(repo, "pr-status", path);
  const head = sha(field(await get(endpoint), "head", "sha"));
  const commit = `${root}/commits/${head}`;
  const checks: JsonObject[] = [];
  const statuses: JsonObject[] = [];
  let combined: unknown;

  for (let page = 1; page <= 10; page++) {
    const result = await get(
      `${commit}/check-runs?filter=latest&per_page=100&page=${page}`,
    );

    const rows = list(field(result, "check_runs"));

    check(
      rows.every((row) => field(row, "head_sha") === head),
      "Check runs did not match the PR head.",
    );
    checks.push(
      ...rows.map((row) =>
        selected(row, [
          "id",
          "name",
          "status",
          "conclusion",
          "html_url",
          "details_url",
        ]),
      ),
    );

    if (rows.length < 100) {
      break;
    }

    check(page < 10, "Check runs exceed the bounded status query.");
  }

  for (let page = 1; page <= 10; page++) {
    const result = await get(`${commit}/status?per_page=100&page=${page}`);
    const rows = list(field(result, "statuses"));

    check(
      field(result, "sha") === head,
      "Commit statuses did not match the PR head.",
    );

    if (page === 1) {
      combined = field(result, "state");
    }

    statuses.push(
      ...rows.map((row) =>
        selected(row, ["context", "state", "description", "target_url"]),
      ),
    );

    if (rows.length < 100) {
      break;
    }

    check(page < 10, "Commit statuses exceed the bounded status query.");
  }

  check(
    field(await get(endpoint), "head", "sha") === head,
    "PR head moved during status read.",
  );

  return {
    headSHA: head,
    checkRuns: checks,
    commitStatuses: statuses,
    commitStatusState: combined,
  };
}

function ownPull(result: unknown, adapter: GitHubAdapter) {
  check(
    field(result, "state") === "open" &&
      field(result, "user", "login") === `${adapter.policy.app}[bot]`,
    "Select your own open App PR.",
  );
}

async function publishCommit(
  adapter: GitHubAdapter,
  repo: string,
  fullName: string,
  path: string | null,
) {
  const value = await input(path);
  const variables = object(value["variables"]);
  const mutation = object(variables["input"]);
  const branch = object(mutation["branch"]);

  check(
    onlyFields(value, ["query", "variables"]) &&
      commitQuery.test(text(value["query"])) &&
      onlyFields(variables, ["input"]) &&
      onlyFields(
        mutation,
        [
          "branch",
          "expectedHeadOid",
          "message",
          "fileChanges",
          "clientMutationId",
        ],
        false,
      ) &&
      branch["repositoryNameWithOwner"] === fullName,
    "Only signed commits to the selected repository are accepted.",
  );
  featureBranch(branch["branchName"], adapter.policy.protectedBranches);
  sha(text(mutation["expectedHeadOid"]).toLowerCase());

  const result = await adapter.json(repo, "publish", "/graphql", {
    body: value,
  });

  check(
    graphqlOk(result),
    "Publication unconfirmed. Inspect branch state before retrying.",
  );

  const commit = object(
    field(result, "data", "createCommitOnBranch", "commit"),
  );

  check(
    Object.hasOwn(commit, "oid") || Object.hasOwn(commit, "url"),
    "No signed commit receipt was returned.",
  );

  return Object.fromEntries(
    Object.entries(commit).filter(([key]) => key === "oid" || key === "url"),
  );
}

async function guardedSquash(
  adapter: GitHubAdapter,
  request: OfficerRequest,
  endpoint: string,
  fullName: string,
) {
  const allowed = adapter.policy.squashCheckout;

  check(
    allowed &&
      (await realpath(request.directory ?? process.cwd())) === allowed &&
      adapter.policy.mergeRepositories.includes(request.repo),
    "Squash merging requires the configured captain checkout.",
  );
  const head = sha(request.expected_head);
  const repo = request.repo;
  const pull = await adapter.json(repo, "read", endpoint);
  const base = text(field(pull, "base", "ref"));
  const baseSha = sha(field(pull, "base", "sha"));

  function requireCurrent(value: unknown) {
    ownPull(value, adapter);
    check(
      field(value, "head", "sha") === head &&
        field(value, "draft") === false &&
        field(value, "merged") === false &&
        field(value, "mergeable") === true &&
        field(value, "mergeable_state") === "clean" &&
        field(value, "head", "repo", "full_name") === fullName &&
        field(value, "base", "repo", "full_name") === fullName &&
        field(value, "base", "ref") === base &&
        field(value, "base", "sha") === baseSha,
      "Select the exact current head of a ready same-repository PR.",
    );
  }

  requireCurrent(pull);
  const root = `/repos/${fullName}`;
  const repository = await adapter.json(repo, "check", root);

  check(
    field(repository, "full_name") === fullName &&
      field(repository, "default_branch") === base,
    "Squash merging is limited to the selected repository's default branch.",
  );

  const target = await adapter.json(
    repo,
    "read",
    `${root}/branches/${encodeURIComponent(base)}`,
  );

  check(
    field(target, "protected") === true &&
      field(target, "commit", "sha") === baseSha,
    "Confirm default branch protection and the current base commit.",
  );
  await humanApproval(adapter, repo, endpoint, head);
  requireCurrent(await adapter.json(repo, "read", endpoint));
  await humanApproval(adapter, repo, endpoint, head);

  const result = await adapter.json(
    request.repo,
    "merge",
    endpoint + "/merge",
    {
      method: "PUT",
      body: { sha: head, merge_method: "squash" },
    },
  );

  check(
    field(result, "merged") === true,
    "Squash merge unconfirmed. Inspect the PR before retrying.",
  );

  return {
    merged: true,
    headSHA: head,
    mergeSHA: sha(field(result, "sha")),
    humanApproval: true,
  };
}

export async function runGitHubOperation(
  adapter: GitHubAdapter,
  request: OfficerRequest,
) {
  const { repo, operation } = request;
  const { policy } = adapter;

  const read =
    operation === "check" ||
    operation === "pr-status" ||
    operation === "review-context";

  check(
    policy.readRepositories.includes(repo),
    "Repository has no configured read policy.",
  );
  check(
    read ||
      (policy.rank === "captain" && policy.writeRepositories.includes(repo)),
    "This officer or repository has no configured write policy.",
  );
  const fullName = githubRepository(policy, repo);
  const root = `/repos/${fullName}`;
  const endpoint = `${root}/pulls/${request.pr}`;

  switch (operation) {
    case "check": {
      const value = await adapter.json(repo, "check", root);

      check(
        field(value, "full_name") === fullName,
        "Repository identity differs.",
      );

      return { repository: fullName, read: true };
    }

    case "push":
      return push(adapter, fullName, request);
    case "pr-status":
      return status(adapter, repo, root, endpoint);
    case "pr-edit": {
      const changes = await input(request.input, 1024 * 1024);
      const head = sha(request.expected_head);

      check(
        Object.keys(changes).length > 0 &&
          onlyFields(changes, ["title", "body"], false) &&
          Object.values(changes).every((value) => typeof value === "string") &&
          (!Object.hasOwn(changes, "title") || text(changes["title"]).trim()),
        "Supply a nonempty title or a body string.",
      );
      const pull = await adapter.json(repo, "pr", endpoint);

      ownPull(pull, adapter);
      check(
        field(pull, "head", "sha") === head,
        "PR head differs from expected SHA.",
      );

      const result = await adapter.json(repo, "pr", endpoint, {
        method: "PATCH",
        body: changes,
      });

      check(
        field(result, "head", "sha") === head &&
          field(result, "state") === "open",
        "PR changed during edit. Inspect the remote text before retrying.",
      );

      return {
        number: field(result, "number"),
        url: field(result, "html_url"),
        headSHA: head,
        updated: Object.keys(changes).toSorted(),
      };
    }

    case "ready": {
      const pull = await adapter.json(repo, "pr", endpoint);

      ownPull(pull, adapter);

      const result = await adapter.json(repo, "pr", "/graphql", {
        body: {
          query:
            "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}",
          variables: { id: text(field(pull, "node_id")) },
        },
      });

      check(
        graphqlOk(result) &&
          field(
            result,
            "data",
            "markPullRequestReadyForReview",
            "pullRequest",
            "isDraft",
          ) === false,
        "Ready state unconfirmed.",
      );

      return { pullRequest: request.pr, ready: true };
    }

    case "pr-create": {
      const changes = await input(request.input);

      check(
        onlyFields(changes, ["title", "head", "base", "body"]) &&
          Object.values(changes).every(
            (value) => typeof value === "string" && value.trim().length > 0,
          ),
        "PR requires title, head, base and body.",
      );
      const head = featureBranch(changes["head"], policy.protectedBranches);
      const base = text(changes["base"]);

      check(base !== head, "PR base must differ from the feature branch.");
      await adapter.git(policy.home, [
        "check-ref-format",
        `refs/heads/${base}`,
      ]);

      const result = await adapter.json(repo, "pr", `${root}/pulls`, {
        body: changes,
      });

      return {
        number: field(result, "number"),
        url: field(result, "html_url"),
      };
    }

    case "branch-create": {
      const value = await input(request.input);
      const ref = text(value["ref"]);

      check(
        onlyFields(value, ["ref", "sha"]) && ref.startsWith("refs/heads/"),
        "Choose a feature ref and its exact base.",
      );
      featureBranch(ref.slice("refs/heads/".length), policy.protectedBranches);
      sha(text(value["sha"]).toLowerCase());

      const result = await adapter.json(repo, "publish", `${root}/git/refs`, {
        body: value,
      });

      check(
        field(result, "ref") === ref,
        "Feature branch creation unconfirmed.",
      );

      return { ref, sha: sha(field(result, "object", "sha")) };
    }

    case "publish":
      return publishCommit(adapter, repo, fullName, request.input);
    case "review-context": {
      const number = request.pr;
      const target = text(request.output);

      check(
        number !== null &&
          isAbsolute(target) &&
          within(policy.home, await realpath(join(target, ".."))),
        "Review context requires a PR and an output path in your own home.",
      );

      const context = await reviewContext(adapter, repo, number);

      const file = await open(
        target,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );

      try {
        await file.writeFile(
          `${JSON.stringify({ repository: fullName, pullRequest: number, ...context })}\n`,
        );
      } finally {
        await file.close();
      }

      const { context: _, ...metadata } = context;

      return { ...metadata, path: target };
    }

    case "review":
    case "merge":
      check(request.pr !== null, "Supply the pull request number.");

      if (operation === "merge" && policy.squashCheckout) {
        return guardedSquash(adapter, request, endpoint, fullName);
      }

      return reviewOperation(
        adapter,
        repo,
        request.pr,
        operation,
        request.proof_id,
        request.expected_head,
      );
  }
}
