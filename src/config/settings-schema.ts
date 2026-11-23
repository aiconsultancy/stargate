import { isAbsolute } from "node:path";
import { isLoopbackHost } from "../lib/loopback";
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

      return extra.length > 0
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

/** Zod's plain-object test: a null prototype, or a constructor whose prototype
 * owns `isPrototypeOf`. Every JSON object passes; a `Date` or a class instance
 * does not.
 */
function plainObject(input: unknown) {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !Predicate.isObject(input)
  )
    return false;
  const constructor = input.constructor;

  if (typeof constructor !== "function") return true;
  const prototype: unknown = constructor.prototype;

  return (
    typeof prototype === "object" &&
    prototype !== null &&
    !Array.isArray(prototype) &&
    Object.hasOwn(prototype, "isPrototypeOf")
  );
}

/** A Zod record, which also requires a plain object (see `settingsRecord`). */
export function settingsPlainRecord<
  K extends Schema.Record.Key,
  V extends Schema.Constraint,
>(key: K, value: V) {
  return Schema.Unknown.check(Schema.makeFilter(plainObject)).pipe(
    Schema.decodeTo(settingsRecord(key, value)),
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
  const Members extends readonly (Schema.Constraint & {
    readonly Type: Readonly<Record<Key, PropertyKey>>;
  })[],
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
        addIssue: ({ path = [], message = "Invalid input" }) => {
          issues.push({ path, issue: message });
        },
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

/** Zod 4.6.7 `z.iso.datetime({ offset: true })`: calendar-checked, seconds
 * required, fractional seconds allowed, `Z` or a `±hh:mm` offset. */
const dateTime =
  /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$/;

export const settingsDateTime = Schema.String.check(
  Schema.isPattern(dateTime, {
    toJsonSchema: () => ({ format: "date-time", pattern: dateTime.source }),
  }),
);

export const settingsUUID = Schema.String.check(
  settingsPattern(
    /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,
  ),
);

/** Zod 4.6.7 `z.iso.datetime({ offset: true })`: a pattern only, with seconds,
 * any fraction, `Z` or a `±HH:MM` offset.
 */
export const settingsOffsetDatetime = Schema.String.check(
  settingsPattern(
    /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$/,
  ),
);

export const settingsEmail = Schema.String.check(
  settingsPattern(
    /^(?:[A-Za-z0-9_'+-]+\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/,
  ),
);

/** Safe, input-free issues for mixed configuration consumers. */
export const settingsIssues = SchemaIssue.makeFormatterStandardSchemaV1();

const absolutePath = Schema.String.check(
  settingsRefine(isAbsolute, { message: "Use an absolute path" }),
);

const envName = Schema.String.check(settingsPattern(/^[A-Z_][A-Z0-9_]*$/));

export { absolutePath, envName };

export const secureLocalOrHttpsURL = settingsURL.check(
  settingsRefine(
    (value) => {
      const url = new URL(value);
      const loopback = isLoopbackHost(url.hostname);

      return (
        (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        !value.includes("?") &&
        !value.includes("#")
      );
    },
    {
      message:
        "Use HTTPS or loopback HTTP without credentials, query, or fragment",
    },
  ),
);

/** Explicit proxy endpoint; the key is an environment reference, never a value. */
export const piProviderSchema = settingsStruct({
  baseURL: secureLocalOrHttpsURL,
  apiKeyEnv: envName,
});
