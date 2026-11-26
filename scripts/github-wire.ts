export type JsonObject = Record<string, unknown>;

export type GitHubScope =
  | "check"
  | "read"
  | "pr-status"
  | "pr"
  | "push"
  | "publish"
  | "review"
  | "merge"
  | "enqueue";

export type GithubPolicy = {
  organization: string;
  repositoryNames?: Readonly<Record<string, string>>;
  squashCheckout?: string;
  protectedBranches?: readonly string[];
  caller: string;
  app: string;
  rank: "captain" | "rear_admiral";
  home: string;
  readRepositories: readonly string[];
  writeRepositories: readonly string[];
  mergeRepositories: readonly string[];
  reviewMarker: string;
  captains: Readonly<
    Record<string, { app: string; models: Readonly<Record<string, string>> }>
  >;
  reviewModels: Readonly<Record<string, readonly string[]>>;
};

export type GitHubAdapter = {
  policy: GithubPolicy;
  json(
    repo: string,
    scope: GitHubScope,
    path: string,
    options?: {
      body?: JsonObject;
      method?: "POST" | "PATCH" | "PUT";
      allowMissing?: boolean;
    },
  ): Promise<unknown>;
  diff(
    repo: string,
    scope: GitHubScope,
    path: string,
    limit: number,
  ): Promise<Uint8Array>;
  git(directory: string, args: string[], publish?: string): Promise<string>;
  proof(id: string): Promise<unknown>;
  proofs(repository: string, number: number, head: string): Promise<unknown[]>;
};

export class GitHubRefused extends Error {}

export function check(condition: unknown, message: string): asserts condition {
  if (
    condition === undefined ||
    condition === null ||
    condition === false ||
    condition === "" ||
    condition === 0
  ) {
    throw new GitHubRefused(message);
  }
}

function record(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function object(value: unknown) {
  check(record(value), "Expected a GitHub object.");

  return value;
}

export function field(value: unknown, ...parts: string[]) {
  let current = value;

  for (const part of parts) {
    if (!record(current) || !Object.hasOwn(current, part)) {
      return;
    }

    current = current[part];
  }

  return current;
}

export function text(value: unknown) {
  check(typeof value === "string" && value.length > 0, "Expected GitHub text.");

  return value;
}

export function sha(value: unknown) {
  check(
    typeof value === "string" && /^[a-f0-9]{40}$/.test(value),
    "Expected a full GitHub commit SHA.",
  );

  return value;
}

export function list(value: unknown): unknown[] {
  check(Array.isArray(value), "Expected a GitHub list.");

  return value;
}

export function graphqlOk(value: unknown) {
  const errors = field(value, "errors");

  return (
    errors === undefined ||
    errors === null ||
    (Array.isArray(errors) && errors.length === 0)
  );
}

export function githubRepository(policy: GithubPolicy, key: string) {
  return `${policy.organization}/${policy.repositoryNames?.[key] ?? key}`;
}
