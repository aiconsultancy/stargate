import {
  Predicate,
  Result,
  Schema,
  SchemaAST,
  SchemaTransformation,
} from "effect";

type EffectToolStruct = Schema.Struct<
  Record<string, Schema.ConstraintDecoder<unknown>>
>;

export type EffectToolInput =
  | EffectToolStruct
  | Schema.Union<readonly EffectToolStruct[]>;

function encodedField(field: Schema.Constraint) {
  const encoded = Schema.toEncoded(field);

  if (!Predicate.isTagged(encoded.ast, "Union")) return encoded;

  // JSON has no undefined. Keep absent optional keys, not nullable values:
  // Pi coerces null optional arguments to omission before authoritative decode.
  const value = Schema.Union(
    encoded.ast.types
      .filter((member) => !Predicate.isTagged(member, "Undefined"))
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
