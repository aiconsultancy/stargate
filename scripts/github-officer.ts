import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runGitHubOperation } from "./github-operations";
import {
  type GitHubAdapter,
  GitHubRefused,
  check,
  object,
} from "./github-wire";

export const requiredOptions = {
  check: [],
  push: ["directory", "branch"],
  "branch-create": ["input"],
  "pr-create": ["input"],
  "pr-status": ["pr"],
  "pr-edit": ["pr", "expected-head", "input"],
  publish: ["input"],
  review: ["pr", "proof-id"],
  merge: ["pr"],
  ready: ["pr"],
  "review-context": ["pr", "output"],
} as const;

const help = `Run repository-scoped GitHub operations through the installed adapter.

Usage: fleet-github <operation> --repo <repository-key> [options]

  check          Verify repository access as the current officer
  push           Push the selected feature branch (--directory, --branch)
  branch-create  Create a feature branch (--input)
  publish        Create a signed commit on a feature branch (--input)
  pr-create      Open a pull request (--input)
  pr-status      Read PR state and checks (--pr)
  pr-edit        Edit the current App's PR (--pr, --expected-head, --input)
  ready          Mark the current App's PR ready (--pr)
  review-context Save the exact review context (--pr, --output)
  review         Publish the current officer's verified review (--pr, --proof-id)
  merge          Request a policy-gated merge (--pr, --expected-head, --directory for checkout policy)

Writes may succeed even when their response is lost. Inspect the branch or PR before retrying.
`;

export function officerRequest(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      directory: { type: "string" },
      branch: { type: "string" },
      input: { type: "string" },
      pr: { type: "string" },
      "expected-head": { type: "string" },
      "proof-id": { type: "string" },
      output: { type: "string" },
    },
  });

  const operation = positionals[0];

  if (
    positionals.length !== 1 ||
    !operation ||
    !Object.hasOwn(requiredOptions, operation)
  ) {
    throw new GitHubRefused(
      "Choose a supported GitHub operation. Run fleet-github --help.",
    );
  }

  const selected = operation as keyof typeof requiredOptions;

  const expected = new Set<keyof typeof values>([
    "repo",
    ...requiredOptions[selected],
  ]);

  for (const key of Object.keys(values)) {
    if (
      !expected.has(key as keyof typeof values) &&
      !(
        selected === "merge" &&
        (key === "expected-head" || key === "directory")
      )
    ) {
      throw new GitHubRefused(
        "An option is unavailable for this operation. Run fleet-github --help.",
      );
    }
  }

  for (const key of expected) {
    if (!values[key]) {
      throw new GitHubRefused(`Supply --${key}. Run fleet-github --help.`);
    }
  }

  if (!values.repo || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(values.repo)) {
    throw new GitHubRefused("Supply a configured repository key.");
  }

  const pr = values.pr === undefined ? null : Number(values.pr);

  if (
    pr !== null &&
    (!/^\d+$/.test(values.pr ?? "") || !Number.isSafeInteger(pr) || pr < 1)
  ) {
    throw new GitHubRefused("Supply a positive pull request number.");
  }

  if (
    values["expected-head"] !== undefined &&
    !/^[a-f0-9]{40}$/.test(values["expected-head"])
  ) {
    throw new GitHubRefused("Supply the full current pull request head SHA.");
  }

  return {
    operation: selected,
    repo: values.repo,
    directory: values.directory ?? null,
    branch: values.branch ?? null,
    input: values.input ?? null,
    pr,
    expected_head: values["expected-head"] ?? null,
    proof_id: values["proof-id"] ?? null,
    output: values.output ?? null,
  };
}

export async function runOfficerRequest(
  adapter: string,
  request: ReturnType<typeof officerRequest>,
) {
  const module: unknown = await import(pathToFileURL(adapter).href);
  const factory = object(module)["createAdapter"];

  check(
    typeof factory === "function",
    "The configured adapter has no factory.",
  );
  const createAdapter = factory as (repo: string) => Promise<GitHubAdapter>;

  return runGitHubOperation(await createAdapter(request.repo), request);
}

async function main() {
  const [adapter, ...args] = process.argv.slice(2);

  if (!adapter?.startsWith("/")) {
    throw new GitHubRefused("Configure the installed GitHub adapter.");
  }

  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(help);

    return;
  }

  const response = await runOfficerRequest(adapter, officerRequest(args));
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof GitHubRefused ? error.message : "GitHub operation refused or unconfirmed. Inspect remote state before retrying writes."}\n`,
    );
    process.exitCode = 2;
  }
}
