import {
  Effect,
  RegExp as EffectRegExp,
  Predicate,
  Schema,
  SchemaAST,
  SchemaGetter,
  SchemaIssue,
  SchemaTransformation,
} from "effect";

/** Mutable configuration values; reject unknown fields before they can strip. */
export function settingsStruct<const F extends Schema.Struct.Fields>(
  fields: F,
) {
  const mutable = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      Schema.mutableKey(value),
    ]),
  ) as { [K in keyof F]: Schema.mutableKey<F[K]> };
  const keys = new Set(Object.keys(fields));
  const exact = Schema.makeFilter<unknown>(
    (value) => {
      if (!Predicate.isObject(value)) return "Expected an object";
      const extra: string[] = [];
      for (const key in value) if (!keys.has(key)) extra.push(key);
      return extra.length
        ? `Unrecognized key${extra.length === 1 ? "" : "s"}: ${extra.map((key) => JSON.stringify(key)).join(", ")}`
        : undefined;
    },
    { settingsRawDiagnostic: true },
  );
  const shape = Schema.Struct(mutable);
  return Schema.flip(Schema.flip(shape.check(exact)).check(exact));
}

/** Zod records skip only the outer enumerable __proto__ entry, before checking
 * its key or value. Preserve all other keys and unknown nested values.
 */
export function settingsRecord<
  K extends Schema.Record.Key,
  V extends Schema.Constraint,
>(key: K, value: V) {
  return Schema.Unknown.pipe(
    Schema.decodeTo(
      Schema.Unknown,
      SchemaTransformation.transform({
        decode: (input) => {
          if (
            !Predicate.isObject(input) ||
            Array.isArray(input) ||
            !Object.hasOwn(input, "__proto__")
          )
            return input;
          const copy = { ...input };
          Reflect.deleteProperty(copy, "__proto__");
          return copy;
        },
        encode: (input) => input,
      }),
    ),
    // Select every raw name, then validate and transform it with the key codec.
    // Native record decoding retains independent key and value diagnostics.
    Schema.decodeTo(
      Schema.Record(Schema.String.pipe(Schema.decodeTo(key)), value).check(
        Schema.isPropertyNames(key),
      ),
    ),
  );
}

/** Legacy defaults bypass the inner decoder and shallow-copy containers.
 * Effect's withDecodingDefaultType rechecks/clones the decoded default, which
 * changes shared nested defaults. Only undefined takes this trusted fallback;
 * every supplied value still passes through the authoritative input codec.
 */
export function settingsDefault<S extends Schema.Constraint>(value: S["Type"]) {
  return (self: S) =>
    Schema.optional(self).pipe(
      Schema.decodeTo(
        Schema.declare<S["Type"]>((_input): _input is S["Type"] => true, {
          toCodecJson: () =>
            new SchemaAST.Link(
              Schema.toType(self).annotate({ default: value }).ast,
              SchemaTransformation.passthrough(),
            ),
        }).annotate({ default: value }),
        {
          decode: SchemaGetter.withDefault(
            Effect.sync(() =>
              Array.isArray(value) || Predicate.isObject(value)
                ? Object.assign(Array.isArray(value) ? [] : {}, value)
                : value,
            ),
          ),
          encode: SchemaGetter.passthrough(),
        },
      ),
    );
}

/** Unknown discriminators retain the configuration field's original path. */
export function settingsDiscriminatedUnion<
  const Key extends string,
  const Members extends ReadonlyArray<
    Schema.Constraint & { readonly Type: { readonly [K in Key]: PropertyKey } }
  >,
>(key: Key, members: Members) {
  const union = Schema.Union(members).pipe(Schema.toTaggedUnion(key));
  const tags = new Set(Object.keys(union.cases));
  const discriminator = Schema.makeFilter<unknown>((value) =>
    Predicate.isObject(value) && !tags.has(String(value[key]))
      ? { path: [key], issue: "Invalid input" }
      : undefined,
  );
  return Schema.Unknown.check(discriminator).pipe(Schema.decodeTo(union));
}

/** A multi-field check can report all contract errors at their original paths. */
export function settingsCheck<T>(
  check: (
    value: T,
    context: {
      addIssue(issue: {
        code: "custom";
        path?: PropertyKey[];
        message?: string;
      }): void;
    },
  ) => void,
) {
  return Schema.makeFilter<T>(
    (value) => {
      const issues: Schema.FilterIssue[] = [];
      check(value, {
        addIssue: ({ path = [], message = "Invalid input" }) =>
          issues.push({ path, issue: message }),
      });
      return issues;
    },
    { settingsDiagnostic: true },
  );
}

/** The public error formatter can repeat a custom check after child bounds fail. */
export const settingsRefine = <T>(
  predicate: (value: T) => boolean,
  annotations: Schema.Annotations.Filter,
) => Schema.makeFilter(predicate, { ...annotations, settingsDiagnostic: true });

// Preserve the installed Zod 4.6.7 URL boundary: trim, validate, then remove
// ASCII tab/newline characters without otherwise normalising the spelling.
export const settingsURL = Schema.Trim.check(
  Schema.makeFilter((value) => URL.canParse(value), { message: "Invalid URL" }),
).pipe(
  Schema.decodeTo(
    Schema.String.annotate({ format: "uri" }),
    SchemaTransformation.transform({
      decode: (value) => value.replace(/[\t\n\r]/g, ""),
      encode: (value) => value,
    }),
  ),
);
/** Keep the existing JSON pattern without changing non-Unicode JS semantics. */
export const settingsPattern = (
  pattern: RegExp,
  annotations?: Schema.Annotations.Filter,
) =>
  Schema.isPattern(pattern, {
    toJsonSchema: () => ({ pattern: pattern.source }),
    ...annotations,
  });

/** Preserve the legacy prefix advertisement without changing native checking. */
export const settingsStartsWith = (prefix: string) =>
  Schema.isStartingWith(prefix, {
    toJsonSchema: () => ({
      format: "starts_with",
      pattern: `^${EffectRegExp.escape(prefix)}.*`,
    }),
  });

export const settingsUUID = Schema.String.check(
  settingsPattern(
    /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
  ),
);
export const settingsEmail = Schema.String.check(
  settingsPattern(
    /^(?:[A-Za-z0-9_'+-]+\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/,
  ),
);

/** Safe, input-free issues for mixed configuration consumers. */
export const settingsIssues = SchemaIssue.makeFormatterStandardSchemaV1();
