import {
  Predicate,
  Result,
  Schema,
  SchemaAST,
  SchemaTransformation,
} from "effect";
import { z } from "zod";

type EffectToolStruct = Schema.Struct<
  Record<string, Schema.ConstraintDecoder<unknown>>
>;
export type EffectToolInput =
  | EffectToolStruct
  | Schema.Union<ReadonlyArray<EffectToolStruct>>;

function encodedField(field: Schema.Constraint) {
  const encoded = Schema.toEncoded(field);
  if (encoded.ast._tag !== "Union") return encoded;
  // JSON has no undefined. Keep absent optional keys, not nullable values:
  // Pi coerces null optional arguments to omission before authoritative decode.
  const value = Schema.Union(
    encoded.ast.types
      .filter((member) => member._tag !== "Undefined")
      .map((ast) => Schema.make<Schema.Codec<unknown>>(ast)),
  ).annotate(encoded.ast.annotations ?? {});
  return encoded.ast.context?.isOptional ? Schema.optionalKey(value) : value;
}

/** Encoded fields only: advertising a tool must not apply branch transforms. */
export function effectToolInputFields(schema: EffectToolInput) {
  if (!("members" in schema))
    return Object.fromEntries(
      Object.entries(schema.fields).map(([name, field]) => [
        name,
        encodedField(field),
      ]),
    );
  const fields = new Map<string, Schema.Constraint[]>();
  for (const option of schema.members)
    for (const [name, field] of Object.entries(option.fields)) {
      const variants = fields.get(name) ?? [];
      variants.push(encodedField(field));
      fields.set(name, variants);
    }
  return Object.fromEntries(
    [...fields].map(([name, variants]) => [
      name,
      name === "op"
        ? Schema.Union(variants)
        : Schema.optionalKey(Schema.Union(variants)),
    ]),
  );
}

/** Keep raw values until the handler decodes; validate before any stripping. */
export function effectObjectToolInput(schema: EffectToolInput) {
  const advertised = Schema.Struct(effectToolInputFields(schema));
  const decode = Schema.decodeUnknownResult(schema, {
    onExcessProperty: "error",
  });
  return Schema.declare<Record<string, unknown>>(Predicate.isObject, {
    toCodecJson: () =>
      new SchemaAST.Link(advertised.ast, SchemaTransformation.passthrough()),
  }).check(
    Schema.makeFilter((input) => {
      const result = decode(input);
      return Result.isFailure(result) ? result.failure.issue : undefined;
    }),
  );
}

// Claude rejects root-level unions. Advertise their fields as one object, but
// keep the original strict union as the validator before any tool can execute.
// Operation handlers parse again to apply their original branch defaults.
export function objectToolInput(
  schema:
    | z.ZodDiscriminatedUnion<readonly z.ZodObject[]>
    | z.ZodUnion<readonly z.ZodObject[]>,
) {
  const fields = new Map<string, z.core.$ZodType[]>();
  for (const option of schema.options) {
    for (const [name, field] of Object.entries(option.shape)) {
      const variants = fields.get(name) ?? [];
      let advertised: z.core.$ZodType =
        field instanceof z.ZodDefault ? field.removeDefault() : field;
      if (advertised instanceof z.ZodOptional) advertised = advertised.unwrap();
      // Advertise a transform's input; the original validator still normalizes it.
      if (advertised instanceof z.ZodPipe) advertised = advertised.in;
      variants.push(advertised);
      fields.set(name, variants);
    }
  }
  const shape: Record<string, z.ZodType> = {};
  for (const [name, variants] of fields)
    shape[name] =
      name === "op" ? z.union(variants) : z.union(variants).optional();
  return z.strictObject(shape).superRefine((input, context) => {
    const result = schema.safeParse(input);
    if (!result.success)
      for (const issue of result.error.issues)
        context.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
  });
}
