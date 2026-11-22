import { Predicate, Result, Schema, type SchemaAST, SchemaIssue } from "effect";
import { settingsIssues } from "./config/settings-schema";

type Issue = ReturnType<typeof settingsIssues>["issues"][number];
const pathOf = (issue: Issue): PropertyKey[] =>
  issue.path?.map((part) => (typeof part === "object" ? part.key : part)) ?? [];

/** Failure-only diagnostics: execute the original custom checks on values
 * decoded by the original codec with constraints disabled. Structural failures
 * still stop that node's domain checks; sibling nodes remain independently
 * readable. Annotated exactness checks inspect raw keys independently.
 * This never supplies a decoded configuration or changes acceptance.
 */
function customIssues(
  ast: SchemaAST.AST,
  input: unknown,
  path: PropertyKey[],
  issues: Issue[],
): void {
  let decoded: Result.Result<unknown, Schema.SchemaError> | undefined;
  try {
    decoded = Schema.decodeUnknownResult(
      Schema.make<Schema.Codec<unknown>>(ast),
      { disableChecks: true, errors: "all" },
    )(input);
  } catch {
    // A transform may require a previously checked format (for example a URL).
    // Its authoritative failure is already present; do not invent diagnostics.
  }
  const check = (filter: SchemaAST.Check<unknown>): void => {
    if (filter._tag === "FilterGroup") {
      for (const child of filter.checks) check(child);
    } else if (
      filter.annotations?.["settingsRawDiagnostic"] === true ||
      (filter.annotations?.["settingsDiagnostic"] === true &&
        decoded &&
        Result.isSuccess(decoded))
    ) {
      try {
        const value =
          filter.annotations?.["settingsRawDiagnostic"] === true
            ? input
            : decoded && Result.isSuccess(decoded)
              ? decoded.success
              : undefined;
        const issue = filter.run(value, ast, { errors: "all" });
        if (issue)
          for (const item of settingsIssues(
            new SchemaIssue.Filter(filter, issue),
          ).issues)
            issues.push({
              path: [...path, ...pathOf(item)],
              message: item.message,
            });
      } catch {
        // Never replace an authoritative rejection with a formatter failure.
      }
    }
  };
  for (const filter of ast.checks ?? []) check(filter);
  for (const link of ast.encoding ?? [])
    customIssues(link.to, input, path, issues);
  switch (ast._tag) {
    case "Objects":
      if (Predicate.isObject(input)) {
        const fields = new Set(
          ast.propertySignatures.map((property) => property.name),
        );
        for (const property of ast.propertySignatures)
          customIssues(
            property.type,
            input[property.name],
            [...path, property.name],
            issues,
          );
        for (const key of Object.keys(input))
          if (!fields.has(key))
            for (const index of ast.indexSignatures)
              customIssues(index.type, input[key], [...path, key], issues);
      }
      break;
    case "Arrays":
      if (Array.isArray(input))
        for (const [index, value] of input.entries()) {
          const item = ast.elements[index] ?? ast.rest[0];
          if (item) customIssues(item, value, [...path, index], issues);
        }
      break;
    case "Union":
      for (const member of ast.types) {
        try {
          if (
            Result.isSuccess(
              Schema.decodeUnknownResult(
                Schema.make<Schema.Codec<unknown>>(member),
                { disableChecks: true },
              )(input),
            )
          ) {
            customIssues(member, input, path, issues);
            break;
          }
        } catch {
          /* A different branch can still be structurally valid. */
        }
      }
      break;
    default:
      break;
  }
}

/** Human-facing config errors retain paths and custom text, never raw values. */
export function decodeSettings<S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  input: unknown,
): S["Type"] {
  const result = Schema.decodeUnknownResult(schema, { errors: "all" })(input);
  if (Result.isSuccess(result)) return result.success;
  const issues = [...settingsIssues(result.failure.issue).issues];
  customIssues(schema.ast, input, [], issues);
  const lines = new Set(
    issues.map((issue) => `${JSON.stringify(pathOf(issue))}: ${issue.message}`),
  );
  throw new Error(`Invalid configuration:\n${[...lines].join("\n")}`);
}
