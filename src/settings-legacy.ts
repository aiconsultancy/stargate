import { Predicate, Result, Schema, SchemaAST } from "effect";
import { z } from "zod";
import { settingsIssues } from "./settings-schema";

// JSON has absent keys, not undefined. Canonical Effect JSON maps undefined
// to null; legacy Zod advertisements did not. Project only the advertisement,
// leaving defaults, validation and transforms with the original codec.
function advertisedAST(ast: SchemaAST.AST): SchemaAST.AST {
  switch (ast._tag) {
    case "Union": {
      const members = ast.types
        .filter((member) => member._tag !== "Undefined")
        .map(advertisedAST);
      const union =
        members.length === 1 && members[0]
          ? members[0]
          : new SchemaAST.Union(
              members,
              ast.options,
              ast.annotations,
              ast.checks,
              undefined,
              ast.context,
            );
      return members.length !== ast.types.length
        ? Schema.optionalKey(Schema.make(union)).ast
        : union;
    }
    case "Objects":
      return new SchemaAST.Objects(
        ast.propertySignatures.map(
          (property) =>
            new SchemaAST.PropertySignature(
              property.name,
              advertisedAST(property.type),
            ),
        ),
        ast.indexSignatures.map(
          (index) =>
            new SchemaAST.IndexSignature(
              index.parameter,
              advertisedAST(index.type),
            ),
        ),
        ast.annotations,
        ast.checks,
        undefined,
        ast.context,
      );
    case "Arrays":
      return new SchemaAST.Arrays(
        ast.isMutable,
        ast.elements.map(advertisedAST),
        ast.rest.map(advertisedAST),
        ast.annotations,
        ast.checks,
        undefined,
        ast.context,
      );
    default:
      return ast;
  }
}

function advertisement(schema: Schema.Constraint) {
  const document = Schema.toJsonSchemaDocument(
    Schema.make(advertisedAST(Schema.toType(schema).ast)),
    { onExcessProperty: "error" },
  );
  // Zod spells a singleton enum as const. The distinction is representational,
  // but retaining it keeps the existing native advertisements unchanged.
  const result: unknown = JSON.parse(
    JSON.stringify(document.schema, (_key, value: unknown) => {
      if (
        !Predicate.isObject(value) ||
        !Array.isArray(value["enum"]) ||
        value["enum"].length !== 1
      )
        return value;
      const { enum: values, ...rest } = value;
      return { ...rest, const: values[0] };
    }),
  );
  if (!Predicate.isObject(result))
    throw new Error("Invalid settings advertisement");
  return result;
}

/** Temporary composition bridge for settings still embedded in Zod operations.
 * Validation/defaults/transforms belong solely to the authoritative Effect codec.
 */
export function legacySetting<S extends Schema.Codec<unknown, unknown>>(
  schema: S,
) {
  const decode = Schema.decodeUnknownResult(schema, { errors: "all" });
  const bridge = z
    .custom<S["Encoded"]>(() => true)
    .transform((value, context): S["Type"] => {
      const result = decode(value);
      if (Result.isSuccess(result)) return result.success;
      for (const issue of settingsIssues(result.failure.issue).issues)
        context.addIssue({
          code: "custom",
          path:
            issue.path?.map((part) =>
              typeof part === "object" ? part.key : part,
            ) ?? [],
          message: issue.message,
        });
      return z.NEVER;
    });
  // Zod's installed converter supports this schema-level JSON hook. Keep its
  // advertisement derived from the same codec, not the opaque transform.
  bridge._zod.toJSONSchema = () => advertisement(schema);
  bridge.in._zod.toJSONSchema = bridge._zod.toJSONSchema;
  return bridge;
}
