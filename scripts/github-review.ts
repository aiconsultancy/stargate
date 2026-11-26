import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { GitHubAdapter, GitHubScope, JsonObject } from "./github-wire";
import {
  check,
  field,
  githubRepository,
  graphqlOk,
  list,
  object,
  sha,
  text,
} from "./github-wire";

const diffLimit = 256_000;
const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@.*$/;

const metadata = [
  "index ",
  "--- ",
  "+++ ",
  "new file mode ",
  "deleted file mode ",
  "old mode ",
  "new mode ",
  "similarity index ",
  "dissimilarity index ",
  "rename from ",
  "rename to ",
  "copy from ",
  "copy to ",
];

function digest(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const record = object(value);

    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function verifyDiff(raw: Uint8Array, pull: JsonObject) {
  check(
    raw.length > 0 && raw.length <= diffLimit && !raw.includes(0),
    "Review requires a bounded complete textual diff.",
  );
  const context = new TextDecoder("utf-8", { fatal: true }).decode(raw);

  check(
    context.startsWith("diff --git "),
    "GitHub did not return a complete raw diff.",
  );
  const lines = context.split("\n");

  if (lines.at(-1) === "") {
    lines.pop();
  }

  let files = 0;
  let additions = 0;
  let deletions = 0;
  let old = 0;
  let next = 0;

  for (const line of lines) {
    check(
      !line.startsWith("Binary files ") && line !== "GIT binary patch",
      "Binary review context is unsupported.",
    );

    if (line.startsWith("diff --git ")) {
      check(old === 0 && next === 0, "PR diff hunk was truncated.");
      files++;
    } else if (line.startsWith("@@ ")) {
      const match = hunk.exec(line);

      check(
        old === 0 && next === 0 && files > 0 && match,
        "Unsupported or truncated PR diff hunk.",
      );
      old = Number(match[1] ?? 1);
      next = Number(match[2] ?? 1);
    } else if (line !== "\\ No newline at end of file") {
      if (old || next) {
        const prefix = line[0];

        check(
          prefix === " " || prefix === "+" || prefix === "-",
          "PR diff hunk was truncated.",
        );
        old -= Number(prefix !== "+");
        next -= Number(prefix !== "-");
        additions += Number(prefix === "+");
        deletions += Number(prefix === "-");
        check(old >= 0 && next >= 0, "PR diff exceeds its declared size.");
      } else {
        check(
          metadata.some((value) => line.startsWith(value)),
          "Unsupported or partial PR diff metadata.",
        );
      }
    }
  }

  check(
    old === 0 &&
      next === 0 &&
      files === pull["changed_files"] &&
      additions === pull["additions"] &&
      deletions === pull["deletions"],
    "PR diff differs from live PR totals.",
  );

  return { context, contextDigest: digest(raw) };
}

export function reviewAuthor(adapter: GitHubAdapter, pull: JsonObject) {
  const login = field(pull, "user", "login");

  const author = Object.entries(adapter.policy.captains).find(
    ([, captain]) => login === `${captain.app}[bot]`,
  );

  check(
    author && field(pull, "user", "type") === "Bot",
    "PR author does not match a configured captain App.",
  );

  return author[0];
}

type Context = ReturnType<typeof verifyDiff> & {
  headSHA: string;
  baseSHA: string;
  mergeBaseSHA: string;
};

async function liveContext(
  adapter: GitHubAdapter,
  repo: string,
  number: number,
  pull: JsonObject,
  scope: GitHubScope,
): Promise<Context> {
  const headSHA = sha(field(pull, "head", "sha"));
  const baseSHA = sha(field(pull, "base", "sha"));
  const endpoint = `/repos/${githubRepository(adapter.policy, repo)}`;

  const raw = await adapter.diff(
    repo,
    scope,
    `${endpoint}/pulls/${number}`,
    diffLimit,
  );

  const result = verifyDiff(raw, pull);

  const compare = await adapter.json(
    repo,
    scope,
    `${endpoint}/compare/${baseSHA}...${headSHA}?per_page=1`,
  );

  check(
    field(compare, "base_commit", "sha") === baseSHA,
    "GitHub did not confirm the exact review base.",
  );

  return {
    ...result,
    headSHA,
    baseSHA,
    mergeBaseSHA: sha(field(compare, "merge_base_commit", "sha")),
  };
}

function proofFamily(
  adapter: GitHubAdapter,
  proof: JsonObject,
  repo: string,
  number: number,
  author: string,
  options: { context: Context; approve: boolean },
) {
  const { context, approve } = options;
  const { policy } = adapter;
  const reviewer = text(proof["reviewerShip"]);
  const coordinator = text(proof["coordinatorShip"]);
  const nativeAgent = text(proof["reviewerAgent"]);
  const identity = policy.captains[reviewer];
  const model = identity?.models[nativeAgent];
  const verdict = proof["verdict"];

  check(
    proof["repository"] === githubRepository(policy, repo) &&
      proof["pullRequest"] === number &&
      proof["headSHA"] === context.headSHA &&
      proof["authorShip"] === author &&
      proof["outcome"] === "completed" &&
      (verdict === "approve" ||
        verdict === "request_changes" ||
        verdict === "comment") &&
      (!approve || verdict === "approve") &&
      proof["authority"] === "agent" &&
      proof["humanApproval"] === false,
    "Stale, incomplete or unrelated review evidence.",
  );
  check(
    proof["baseSHA"] === context.baseSHA &&
      proof["mergeBaseSHA"] === context.mergeBaseSHA &&
      proof["contextDigest"] === context.contextDigest,
    "Review did not inspect the exact live base, merge-base and diff.",
  );
  check(
    model &&
      policy.captains[coordinator] &&
      reviewer !== author &&
      coordinator !== author &&
      text(proof["sessionID"]).startsWith("ses_") &&
      text(proof["inputID"]).length > 0 &&
      text(proof["id"]).length > 0 &&
      proof["kind"] === (nativeAgent === "build" ? "captain" : "crew"),
    "Review lacks bound cross-ship native identity.",
  );

  const resultText = text(proof["resultText"]);

  check(
    resultText.trim().length > 0 &&
      digest(resultText) === proof["resultDigest"],
    "Native review text digest differs.",
  );
  const makers = list(proof["makers"]).map((item) => object(item));

  check(makers.length > 0 && makers.length <= 100, "Invalid native makers.");
  check(
    makers.every(
      (maker) =>
        maker["agent"] === nativeAgent &&
        text(maker["messageID"]).length > 0 &&
        `${text(maker["provider"])}/${text(maker["model"])}` === model,
    ),
    "Review native agent or model differs.",
  );

  const families = Object.keys(policy.reviewModels).filter((key) =>
    policy.reviewModels[key]?.includes(model),
  );

  check(
    families.length === 1 && families[0],
    "Native model has no unique approved review family.",
  );
  const family = families[0];

  check(
    family !== "codex" || makers.every((maker) => maker["variant"] === "high"),
    "Codex review requires actual high effort.",
  );
  check(
    !Object.hasOwn(proof, "family") || proof["family"] === family,
    "Claimed family differs from native makers.",
  );

  return family;
}

function reviewBody(marker: string, proof: JsonObject) {
  const makers = list(proof["makers"])
    .map((item) => {
      const maker = object(item);

      return `${text(maker["provider"])}/${text(maker["model"])} (${text(maker["agent"])})`;
    })
    .join(", ");

  const result = text(proof["resultText"]).replaceAll(
    marker,
    "(quoted review marker)",
  );

  const envelope = {
    proofID: proof["id"],
    proofDigest: digest(canonical(proof)),
  };

  return [
    `Cross-ship review of \`${text(proof["headSHA"])}\`.`,
    `Reviewer ship: ${text(proof["reviewerShip"])}. Coordinator: ${text(proof["coordinatorShip"])}.`,
    `Native session and input: \`${text(proof["sessionID"])}\` and \`${text(proof["inputID"])}\`.`,
    `Actual native makers: ${makers}.`,
    `Agent review verdict: ${text(proof["verdict"])}.`,
    result,
    `<!-- ${marker}${canonical(envelope)} -->`,
  ].join("\n\n");
}

function proofReference(marker: string, body: unknown) {
  if (typeof body !== "string") {
    return;
  }

  const prefix = `<!-- ${marker}`;

  const lines = body
    .split("\n")
    .filter((line) => line.startsWith(prefix) && line.endsWith(" -->"));

  if (lines.length !== 1 || !lines[0]) {
    return;
  }

  try {
    return object(JSON.parse(lines[0].slice(prefix.length, -4)));
  } catch {
    return;
  }
}

async function reviews(
  adapter: GitHubAdapter,
  repo: string,
  endpoint: string,
  scope: GitHubScope,
) {
  const result: JsonObject[] = [];

  for (let page = 1; page <= 10; page++) {
    const rows = list(
      await adapter.json(
        repo,
        scope,
        `${endpoint}/reviews?per_page=100&page=${page}`,
      ),
    ).map((item) => object(item));

    result.push(...rows);

    if (rows.length < 100) {
      return result;
    }
  }

  throw new Error("Review history exceeds the bounded gate.");
}

function ready(pull: JsonObject, repository: string, number: number) {
  check(
    pull["number"] === number &&
      pull["state"] === "open" &&
      pull["draft"] === false &&
      pull["merged"] === false &&
      pull["mergeable"] === true &&
      pull["mergeable_state"] === "clean" &&
      field(pull, "head", "repo", "full_name") === repository &&
      field(pull, "base", "repo", "full_name") === repository,
    "GitHub has not confirmed a ready same-repository PR with all required checks.",
  );
}

async function mergeProofs(
  adapter: GitHubAdapter,
  repo: string,
  number: number,
  pull: JsonObject,
  author: string,
  context: Context,
) {
  const repository = githubRepository(adapter.policy, repo);

  const endpoint = `/repos/${repository}/pulls/${number}`;

  ready(pull, repository, number);
  check(
    adapter.policy.caller === reviewAuthor(adapter, pull) &&
      field(pull, "base", "ref") === "main",
    "Standing merges require the author captain and main.",
  );
  check(
    field(pull, "head", "sha") === context.headSHA &&
      field(pull, "base", "sha") === context.baseSHA,
    "Live PR head or base differs from review evidence.",
  );

  const proofs = (
    await adapter.proofs(repository, number, context.headSHA)
  ).map((item) => object(item));

  const byId = new Map(proofs.map((proof) => [proof["id"], proof]));

  check(
    proofs.length <= 100 && byId.size === proofs.length,
    "Invalid or duplicate review proofs.",
  );
  const accepted = new Map<string, number>();
  const receipts = new Set<number>();
  const bindings = new Set<string>();

  for (const review of await reviews(adapter, repo, endpoint, "merge")) {
    if (
      review["state"] !== "APPROVED" ||
      review["commit_id"] !== context.headSHA
    ) {
      continue;
    }

    const ref = proofReference(adapter.policy.reviewMarker, review["body"]);
    const proof = ref && byId.get(ref["proofID"]);

    if (!proof) {
      continue;
    }

    const family = proofFamily(adapter, proof, repo, number, author, {
      context,
      approve: true,
    });

    const app = adapter.policy.captains[text(proof["reviewerShip"])]?.app;
    const receipt = review["id"];

    check(
      ref?.["proofDigest"] === digest(canonical(proof)) &&
        app &&
        field(review, "user", "login") === `${app}[bot]` &&
        field(review, "user", "type") === "Bot" &&
        (review["performed_via_github_app"] === null ||
          review["performed_via_github_app"] === undefined ||
          field(review, "performed_via_github_app", "slug") === app) &&
        typeof receipt === "number" &&
        Number.isSafeInteger(receipt) &&
        !receipts.has(receipt),
      "Review receipt differs from trusted proof.",
    );
    receipts.add(receipt);

    const binding = canonical([
      proof["reviewerShip"],
      proof["sessionID"],
      proof["inputID"],
    ]);

    if (!accepted.has(family)) {
      check(
        !bindings.has(binding),
        "A native input cannot count for two families.",
      );
      bindings.add(binding);
      accepted.set(family, receipt);
    }
  }

  check(
    accepted.size === 2 && accepted.has("codex") && accepted.has("claude"),
    "Two current-head cross-ship reviews are required.",
  );
}

export async function humanApproval(
  adapter: GitHubAdapter,
  repo: string,
  endpoint: string,
  head: string,
) {
  const decisions = new Map<number, JsonObject>();

  for (const review of await reviews(adapter, repo, endpoint, "read")) {
    const id = field(review, "user", "id");

    if (
      field(review, "user", "type") === "User" &&
      typeof id === "number" &&
      ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(
        String(review["state"]),
      )
    ) {
      decisions.delete(id);
      decisions.set(id, review);
    }
  }

  for (const [id, review] of Array.from(decisions).toReversed()) {
    const login = field(review, "user", "login");
    const approvedAt = review["submitted_at"];

    if (
      review["state"] !== "APPROVED" ||
      review["commit_id"] !== head ||
      (review["performed_via_github_app"] !== null &&
        review["performed_via_github_app"] !== undefined) ||
      typeof review["id"] !== "number" ||
      typeof login !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login) ||
      typeof approvedAt !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(approvedAt)
    ) {
      continue;
    }

    const root = `/repos/${githubRepository(adapter.policy, repo)}`;

    const authority = await adapter.json(
      repo,
      "read",
      `${root}/collaborators/${login}/permission`,
      { allowMissing: true },
    );

    if (
      field(authority, "user", "id") === id &&
      field(authority, "user", "type") === "User" &&
      ["write", "maintain", "admin"].includes(
        String(field(authority, "permission")),
      )
    ) {
      return { reviewID: review["id"], approver: login, approvedAt };
    }
  }

  throw new Error(
    "Confirm current-head human approval from a repository writer.",
  );
}

async function singleQueue(
  adapter: GitHubAdapter,
  repo: string,
  root: string,
  base: string,
) {
  const summaries = list(
    await adapter.json(
      repo,
      "read",
      `${root}/rulesets?includes_parents=true&per_page=100`,
    ),
  ).map((item) => object(item));

  check(summaries.length < 100, "Could not inspect all GitHub rulesets.");
  const queues: JsonObject[] = [];

  for (const summary of summaries) {
    if (summary["enforcement"] === "active" && summary["target"] === "branch") {
      const id = summary["id"];

      check(
        typeof id === "number" && Number.isSafeInteger(id) && id > 0,
        "Invalid ruleset identity.",
      );

      const rule = object(
        await adapter.json(repo, "read", `${root}/rulesets/${id}`),
      );

      if (
        list(rule["rules"]).some(
          (entry) => field(entry, "type") === "merge_queue",
        )
      ) {
        queues.push(rule);
      }
    }
  }

  const queue = queues[0];

  check(
    queues.length === 1 &&
      queue &&
      isDeepStrictEqual(field(queue, "conditions", "ref_name", "include"), [
        `refs/heads/${base}`,
      ]) &&
      isDeepStrictEqual(field(queue, "conditions", "ref_name", "exclude"), []),
    "Require exactly one active queue matching this target.",
  );

  const review = list(queue["rules"]).find(
    (rule) => field(rule, "type") === "pull_request",
  );

  const approvals = field(
    review,
    "parameters",
    "required_approving_review_count",
  );

  check(
    typeof approvals === "number" &&
      Number.isSafeInteger(approvals) &&
      approvals >= 1 &&
      field(review, "parameters", "dismiss_stale_reviews_on_push") === true &&
      field(review, "parameters", "require_last_push_approval") === true &&
      field(review, "parameters", "require_code_owner_review") === true,
    "Queue must enforce current code-owner and last-push approval.",
  );
}

async function enqueue(
  adapter: GitHubAdapter,
  repo: string,
  endpoint: string,
  number: number,
  pull: JsonObject,
) {
  const repository = githubRepository(adapter.policy, repo);
  const root = `/repos/${repository}`;

  ready(pull, repository, number);
  const head = sha(field(pull, "head", "sha"));
  const baseSHA = sha(field(pull, "base", "sha"));
  const base = text(field(pull, "base", "ref"));

  await humanApproval(adapter, repo, endpoint, head);
  const current = object(await adapter.json(repo, "read", endpoint));

  ready(current, repository, number);
  check(
    isDeepStrictEqual(current["user"], pull["user"]) &&
      field(current, "head", "sha") === head &&
      field(current, "base", "sha") === baseSHA &&
      field(current, "base", "ref") === base,
    "PR changed before queue admission.",
  );
  const approval = await humanApproval(adapter, repo, endpoint, head);

  const target = await adapter.json(
    repo,
    "read",
    `${root}/branches/${encodeURIComponent(base)}`,
  );

  check(
    field(target, "protected") === true &&
      field(target, "commit", "sha") === baseSHA,
    "Could not confirm target branch protection and commit.",
  );

  const checked = await adapter.json(repo, "read", "/graphql", {
    body: {
      query: `query($owner:String!,$repo:String!,$number:Int!){
      repository(owner:$owner,name:$repo){pullRequest(number:$number){
        id baseRefName baseRefOid headRefOid isDraft state reviewDecision mergeStateStatus
        isMergeQueueEnabled mergeQueue{id}
        mergeQueueEntry{id position state headCommit{oid} mergeQueue{id}}
        timelineItems(last:1,itemTypes:[BASE_REF_CHANGED_EVENT]){
          nodes{... on BaseRefChangedEvent{createdAt}}
        }
      }}
    }`,
      variables: {
        owner: adapter.policy.organization,
        repo: adapter.policy.repositoryNames?.[repo] ?? repo,
        number,
      },
    },
  });

  const hosted = object(field(checked, "data", "repository", "pullRequest"));

  check(
    graphqlOk(checked) &&
      hosted["baseRefName"] === base &&
      hosted["baseRefOid"] === baseSHA &&
      hosted["headRefOid"] === head &&
      hosted["isDraft"] === false &&
      hosted["state"] === "OPEN" &&
      hosted["reviewDecision"] === "APPROVED" &&
      hosted["mergeStateStatus"] === "CLEAN",
    "GitHub did not confirm exact-head approval.",
  );
  const retargets = list(field(hosted, "timelineItems", "nodes"));
  const queue = text(field(hosted, "mergeQueue", "id"));

  check(
    (retargets.length === 0 ||
      (retargets.length === 1 &&
        text(field(retargets[0], "createdAt")) < approval.approvedAt)) &&
      hosted["isMergeQueueEnabled"] === true,
    "Human approval must follow the latest retarget and a merge queue must be enabled.",
  );

  let entry = hosted["mergeQueueEntry"];

  if (entry === null || entry === undefined) {
    await singleQueue(adapter, repo, root, base);

    const result = await adapter.json(repo, "enqueue", "/graphql", {
      body: {
        query: `mutation($pr:ID!,$head:GitObjectID!){
        enqueuePullRequest(input:{pullRequestId:$pr,expectedHeadOid:$head}){
          mergeQueueEntry{id position state headCommit{oid} mergeQueue{id}}
        }
      }`,
        variables: { pr: text(hosted["id"]), head },
      },
    });

    check(
      graphqlOk(result),
      "Queue admission unconfirmed. Inspect the PR before retrying.",
    );
    entry = field(result, "data", "enqueuePullRequest", "mergeQueueEntry");
  }

  check(
    field(entry, "headCommit", "oid") === head &&
      field(entry, "mergeQueue", "id") === queue,
    "Expected queue admission was not confirmed.",
  );

  return {
    queued: true,
    headSHA: head,
    base,
    queueEntryID: text(field(entry, "id")),
    position: field(entry, "position"),
    queueState: field(entry, "state"),
    humanApproval: true,
    ...approval,
  };
}

export async function reviewContext(
  adapter: GitHubAdapter,
  repo: string,
  number: number,
) {
  const endpoint = `/repos/${githubRepository(adapter.policy, repo)}/pulls/${number}`;
  const pull = object(await adapter.json(repo, "read", endpoint));

  return liveContext(adapter, repo, number, pull, "read");
}

export async function reviewOperation(
  adapter: GitHubAdapter,
  repo: string,
  number: number,
  operation: "review" | "merge",
  proofId: string | null,
  expectedHead: string | null,
) {
  const repository = githubRepository(adapter.policy, repo);
  const endpoint = `/repos/${repository}/pulls/${number}`;
  const scope = operation === "review" ? "review" : "read";
  const pull = object(await adapter.json(repo, scope, endpoint));

  const author = reviewAuthor(adapter, pull);
  const head = sha(field(pull, "head", "sha"));

  check(
    pull["state"] === "open" &&
      field(pull, "head", "repo", "full_name") === repository &&
      field(pull, "base", "repo", "full_name") === repository,
    "Select a same-repository open PR.",
  );

  if (operation === "merge") {
    check(
      expectedHead === null || head === sha(expectedHead),
      "PR head differs from the requested merge SHA.",
    );
    check(
      author === adapter.policy.caller,
      "Only the author captain may merge.",
    );

    if (
      !adapter.policy.mergeRepositories.includes(repo) ||
      field(pull, "base", "ref") !== "main"
    ) {
      return enqueue(adapter, repo, endpoint, number, pull);
    }

    const context = await liveContext(adapter, repo, number, pull, "merge");

    await mergeProofs(adapter, repo, number, pull, author, context);
    const current = object(await adapter.json(repo, "merge", endpoint));

    check(
      field(current, "head", "sha") === head,
      "Live PR head changed before merge.",
    );

    const currentContext = await liveContext(
      adapter,
      repo,
      number,
      current,
      "merge",
    );

    check(
      isDeepStrictEqual(currentContext, context),
      "Live head, base or diff changed.",
    );
    await mergeProofs(adapter, repo, number, current, author, currentContext);

    const result = await adapter.json(repo, "merge", `${endpoint}/merge`, {
      method: "PUT",
      body: { sha: head, merge_method: "merge" },
    });

    check(
      field(result, "merged") === true,
      "Merge outcome unconfirmed. Inspect the PR before retrying.",
    );

    return {
      merged: true,
      headSHA: head,
      mergeSHA: sha(field(result, "sha")),
      observedBaseSHA: context.baseSHA,
      observedMergeBaseSHA: context.mergeBaseSHA,
      reviewContextDigest: context.contextDigest,
      humanApproval: false,
    };
  }

  const context = await liveContext(adapter, repo, number, pull, "review");
  const proof = object(await adapter.proof(text(proofId)));

  check(
    proof["id"] === proofId && proof["reviewerShip"] === adapter.policy.caller,
    "Proof belongs to another reviewer.",
  );
  proofFamily(adapter, proof, repo, number, author, {
    context,
    approve: false,
  });
  const app = `${adapter.policy.app}[bot]`;
  const marker = adapter.policy.reviewMarker;
  const body = reviewBody(marker, proof);
  const proofDigest = digest(canonical(proof));

  const existing = (await reviews(adapter, repo, endpoint, "review")).filter(
    (row) => {
      const ref = proofReference(marker, row["body"]);

      return (
        (row["body"] === body ||
          (ref?.["proofID"] === proofId &&
            ref["proofDigest"] === proofDigest)) &&
        row["commit_id"] === head &&
        field(row, "user", "login") === app
      );
    },
  );

  const verdict = proof["verdict"];

  const decisions = {
    approve: { event: "APPROVE", state: "APPROVED" },
    request_changes: { event: "REQUEST_CHANGES", state: "CHANGES_REQUESTED" },
    comment: { event: "COMMENT", state: "COMMENTED" },
  };

  check(
    verdict === "approve" ||
      verdict === "request_changes" ||
      verdict === "comment",
    "Invalid review verdict.",
  );
  const { event, state } = decisions[verdict];

  if (existing.length > 0) {
    check(
      existing.length === 1 && existing[0]?.["state"] === state,
      "Existing review outcome needs reconciliation.",
    );

    return { reviewID: existing[0]["id"], headSHA: head, reused: true };
  }

  const current = object(await adapter.json(repo, "review", endpoint));

  check(
    isDeepStrictEqual(
      await liveContext(adapter, repo, number, current, "review"),
      context,
    ),
    "Live review context changed.",
  );

  const result = await adapter.json(repo, "review", `${endpoint}/reviews`, {
    body: { commit_id: head, event, body },
  });

  check(
    field(result, "state") === state &&
      field(result, "commit_id") === head &&
      field(result, "user", "login") === app,
    "Review outcome unconfirmed.",
  );

  return { reviewID: field(result, "id"), headSHA: head, humanApproval: false };
}
