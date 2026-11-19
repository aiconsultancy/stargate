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

export function settingsAdvertisement(schema: Schema.Constraint) {
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

/** Input JSON retains decoded bounds/transforms but marks defaulted keys optional.
 * Only the operation presentation adapters need this input-side projection.
 */
export function settingsInputAdvertisement(
  schema: Schema.Constraint,
): Record<string, unknown> {
  const json = settingsAdvertisement(schema);
  const ast = schema.ast;
  const trimsInput = (check: SchemaAST.Check<unknown>): boolean =>
    check._tag === "FilterGroup"
      ? check.checks.some(trimsInput)
      : check.annotations?.representation?.id === "effect/schema/isTrimmed";
  if (ast.encoding?.length && ast.checks?.some(trimsInput))
    delete json["pattern"];
  if (ast._tag === "Objects" && Predicate.isObject(json["properties"])) {
    const properties = json["properties"];
    const required: string[] = [];
    for (const field of ast.propertySignatures) {
      if (typeof field.name !== "string") continue;
      const codec = Schema.make<Schema.Codec<unknown>>(field.type);
      properties[field.name] = settingsInputAdvertisement(codec);
      if (!Schema.toEncoded(codec).ast.context?.isOptional)
        required.push(field.name);
    }
    if (required.length) json["required"] = required;
    else delete json["required"];
  } else if (ast._tag === "Union") {
    const types = ast.types.filter((member) => member._tag !== "Undefined");
    if (types.length === 1 && types[0])
      return settingsInputAdvertisement(Schema.make(types[0]));
    const key = Array.isArray(json["oneOf"]) ? "oneOf" : "anyOf";
    if (Array.isArray(json[key]) && types.length === json[key].length) {
      const branches = types.map((member) =>
        settingsInputAdvertisement(Schema.make(member)),
      );
      const tags = branches.map((branch) => {
        const properties = branch["properties"];
        const op = Predicate.isObject(properties)
          ? properties["op"]
          : undefined;
        return Predicate.isObject(op) ? op["const"] : undefined;
      });
      const exclusive =
        tags.every((tag) => typeof tag === "string") &&
        new Set(tags).size === branches.length;
      json[exclusive ? "oneOf" : key] = branches;
      if (exclusive) delete json["anyOf"];
    }
  }
  return json;
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
  bridge._zod.toJSONSchema = () => settingsAdvertisement(schema);
  bridge.in._zod.toJSONSchema = bridge._zod.toJSONSchema;
  return bridge;
}
