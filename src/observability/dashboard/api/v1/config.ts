import { isAbsolute, resolve } from "node:path";
import { Effect, Predicate, Result, Schema, SchemaIssue } from "effect";
import { settingsIssues } from "../../../../config/settings-schema";
import { isGitHubRepositoryName } from "./github-repository";
import { isOriginPattern, isPrivateNetwork, parseApiListen } from "./network";

const checkoutPath = Schema.String.check(
  Schema.makeFilter(
    (path) =>
      (isAbsolute(path) && resolve(path) === path && !path.includes("\0")) ||
      "Use an absolute, normalized checkout path.",
  ),
);

const pullRequestRepositories = Schema.Record(
  Schema.String,
  Schema.String.check(
    Schema.makeFilter(
      (value) =>
        isGitHubRepositoryName(value) || "Use GitHub owner/repository.",
    ),
  ),
).check(Schema.isPropertyNames(checkoutPath));

const networksMinimum = Schema.isMinLength(1);
const fleetNameMinimum = Schema.isMinLength(1);

// Field order is the order of the human-facing configuration errors.
const fields = {
  listen: Schema.String.check(
    Schema.makeFilter(
      (value) =>
        value === "unix" ||
        parseApiListen(value) !== undefined ||
        "Fleet API is private-network only. Use unix, a private literal host and port 1–65535 (bracket IPv6), or :PORT for loopback.",
    ),
  ),
  allowedNetworks: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.String.check(
          Schema.makeFilter(
            (value) =>
              isPrivateNetwork(value) ||
              "Fleet API is private-network only. Use a CIDR wholly within a supported private network.",
          ),
        ),
      ),
    ).check(networksMinimum),
  ),
  corsOrigins: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.String.check(
          Schema.makeFilter(
            (value) =>
              isOriginPattern(value) ||
              "Use an exact origin or replace a whole hostname label with *.",
          ),
        ),
      ),
    ),
  ),
  pullRequestRepositories: Schema.optional(pullRequestRepositories),
  fleetName: Schema.optional(Schema.Trim.check(fleetNameMinimum)),
};

const configFields = Schema.Struct(fields);

export type ApiV1Config = {
  -readonly [
    K in keyof typeof configFields.Type
  ]: (typeof configFields.Type)[K];
};

const decodeFields = Schema.decodeUnknownResult(configFields, {
  errors: "all",
});

const decodeRepositories = Schema.decodeUnknownResult(pullRequestRepositories, {
  errors: "all",
});

type ConfigIssue = { path: PropertyKey[]; message: string };

// The configuration error text predates this codec. Keep its spelling: the
// Type names, and the length check that also reports a value of the wrong
// Type when that value has a length.
function received(value: unknown) {
  if (typeof value === "number")
    return Number.isNaN(value)
      ? "NaN"
      : Number.isFinite(value)
        ? "number"
        : String(value);

  if (value === null) return "null";

  if (Array.isArray(value)) return "array";

  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    "constructor" in value &&
    typeof value.constructor === "function"
  )
    return value.constructor.name;

  return typeof value;
}

function tooShort(value: unknown): string | undefined {
  const length: unknown =
    typeof value === "string" || Array.isArray(value)
      ? value.length
      : Predicate.isObject(value) && "length" in value
        ? value["length"]
        : undefined;

  if (length === undefined || (typeof length === "number" && length >= 1))
    return;

  if (typeof value === "string")
    return "Too small: expected string to have >=1 characters";

  if (Array.isArray(value))
    return "Too small: expected array to have >=1 items";

  return "Too small: expected unknown to be >=1";
}

const arrayFields = new Set(["allowedNetworks", "corsOrigins"]);
const lengthFields = new Set(["allowedNetworks", "fleetName"]);

function valueAt(root: unknown, path: readonly PropertyKey[]) {
  let value = root;

  for (const key of path)
    value = Array.isArray(value)
      ? value[Number(key)]
      : Predicate.isObject(value)
        ? value[key]
        : undefined;

  return value;
}

function typeIssue(
  root: Record<PropertyKey, unknown>,
  path: PropertyKey[],
  issues: ConfigIssue[],
) {
  const [field] = path;
  const value = valueAt(root, path);

  const expected =
    path.length === 1 && arrayFields.has(String(field)) ? "array" : "string";

  issues.push({
    path,
    message: `Invalid input: expected ${expected}, received ${received(value)}`,
  });

  const short =
    path.length === 1 && lengthFields.has(String(field))
      ? tooShort(value)
      : undefined;

  if (short) issues.push({ path, message: short });
}

function issueMessages(
  issue: SchemaIssue.Issue,
  root: Record<PropertyKey, unknown>,
  path: PropertyKey[],
  issues: ConfigIssue[],
): void {
  if (Predicate.isTagged(issue, "Pointer")) {
    issueMessages(issue.issue, root, [...path, ...issue.path], issues);

    return;
  }

  if (Predicate.isTagged(issue, "Composite")) {
    for (const child of issue.issues) issueMessages(child, root, path, issues);

    return;
  }

  if (Predicate.isTagged(issue, "Encoding")) {
    issueMessages(issue.issue, root, path, issues);

    return;
  }

  // An optional field: a failure inside its codec, or no member matched.
  if (Predicate.isTagged(issue, "AnyOf") && issue.issues.length > 0) {
    for (const child of issue.issues) issueMessages(child, root, path, issues);

    return;
  }

  if (
    Predicate.isTagged(issue, "AnyOf") ||
    Predicate.isTagged(issue, "MissingKey") ||
    Predicate.isTagged(issue, "InvalidType")
  ) {
    typeIssue(root, path, issues);

    return;
  }

  if (
    Predicate.isTagged(issue, "Filter") &&
    (issue.filter === networksMinimum || issue.filter === fleetNameMinimum)
  ) {
    const short = tooShort(
      issue.filter === fleetNameMinimum
        ? String(valueAt(root, path)).trim()
        : valueAt(root, path),
    );

    if (short) issues.push({ path, message: short });

    return;
  }

  if (Predicate.isTagged(issue, "Filter")) {
    issueMessages(issue.issue, root, path, issues);

    return;
  }

  for (const item of settingsIssues(issue).issues)
    issues.push({
      path: [
        ...path,
        ...(item.path?.map((part) =>
          typeof part === "object" ? part.key : part,
        ) ?? []),
      ],
      message: item.message,
    });
}

function configIssues(input: unknown): ConfigIssue[] {
  if (!Predicate.isObject(input) || Array.isArray(input))
    return [
      {
        path: [],
        message: `Invalid input: expected object, received ${received(input)}`,
      },
    ];
  const issues: ConfigIssue[] = [];
  const decoded = decodeFields(input);

  if (Result.isFailure(decoded))
    for (const [name, field] of Object.entries(fields)) {
      if (name === "pullRequestRepositories") {
        // The repository map keeps the wording of its Effect setting codec.
        const value = input[name];

        const repositories =
          value === undefined ? undefined : decodeRepositories(value);

        if (repositories && Result.isFailure(repositories))
          for (const item of settingsIssues(repositories.failure.issue).issues)
            issues.push({
              path: [
                name,
                ...(item.path?.map((part) =>
                  typeof part === "object" ? part.key : part,
                ) ?? []),
              ],
              message: item.message,
            });
        continue;
      }

      const result = Schema.decodeUnknownResult(
        Schema.Struct({ [name]: field }),
        { errors: "all" },
      )({ [name]: input[name] });

      if (Result.isFailure(result))
        issueMessages(result.failure.issue, input, [], issues);
    }

  for (const key in input)
    if (!Object.hasOwn(fields, key)) {
      issues.push({ path: [], message: "Unrecognized Fleet API setting" });
      break;
    }

  return issues;
}

// Keep the API object strict, with the existing configuration error text.
export const apiV1ConfigSchema = Schema.declareConstructor<ApiV1Config>()(
  [],
  () => (input, ast) => {
    const issues = configIssues(input).map(
      ({ path, message }) =>
        new SchemaIssue.Pointer(
          path,
          new SchemaIssue.InvalidValue({ message }),
        ),
    );

    const decoded = decodeFields(input);
    const [first, ...rest] = issues;

    if (!first && Result.isSuccess(decoded))
      return Effect.succeed({ ...decoded.success });

    return Effect.fail(
      first
        ? new SchemaIssue.Composite(ast, [first, ...rest])
        : new SchemaIssue.InvalidValue({
            message: "Invalid Fleet API configuration",
          }),
    );
  },
);
