import { JsonSchema, Predicate, Result, Schema } from "effect";
import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "effect/StandardSchema";
import {
  settingsAdvertisement,
  settingsInputAdvertisement,
} from "../settings-legacy";
import { settingsIssues } from "../config/settings-schema";
import {
  effectProjectKeySchema,
  effectProjectToolInput,
} from "./project-options";
import type { EffectToolInput } from "./tool-input";

function jsonTarget(
  json: Record<string, unknown>,
  target: StandardJSONSchemaV1.Target,
) {
  if (target === "draft-2020-12")
    return structuredClone({
      $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
      ...json,
    });
  if (target === "draft-07")
    return structuredClone({
      $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
      ...JsonSchema.toDocumentDraft07({
        dialect: "draft-2020-12",
        schema: json,
        definitions: {},
      }).schema,
    });
  throw new Error(`Unsupported message schema target: ${target}`);
}

/** Portable Promise RPC definitions retain their native AST and strict codecs. */
export function messagePortableSchema<S extends Schema.Codec<unknown, unknown>>(
  schema: S,
) {
  const native = Schema.toStandardSchemaV1(schema);
  const project = ({ target }: { target: StandardJSONSchemaV1.Target }) =>
    jsonTarget(settingsInputAdvertisement(schema), target);
  return Object.assign(native, {
    "~standard": {
      ...native["~standard"],
      jsonSchema: { input: project, output: project },
    },
  });
}

/** Mail/history flatten union fields; DM's object applies its own defaults.
 * Both preserve field transforms and keep project outside operation decoding.
 */
export function messageOpenCodeInput(
  schema: EffectToolInput,
): StandardSchemaV1<Record<string, unknown>> &
  StandardJSONSchemaV1<Record<string, unknown>> {
  const decode = Schema.decodeUnknownResult(effectProjectToolInput(schema), {
    errors: "all",
  });
  const members = "members" in schema ? schema.members : [schema];
  const union = "members" in schema;
  const properties: Record<string, unknown> = {};
  const fields = new Map<string, Schema.Constraint[]>();
  for (const member of members)
    for (const [key, field] of Object.entries(member.fields)) {
      const variants = fields.get(key) ?? [];
      variants.push(
        union && Object.hasOwn(field.ast.annotations ?? {}, "default")
          ? Schema.toEncoded(field)
          : field,
      );
      fields.set(key, variants);
    }
  const operation = union
    ? Schema.decodeUnknownResult(
        Schema.Struct({
          op: Schema.Union(
            (fields.get("op") ?? []).map((field) =>
              Schema.make<Schema.Codec<unknown>>(field.ast),
            ),
          ),
        }),
        { errors: "all" },
      )
    : undefined;
  const decoders = new Map<
    string,
    Array<(raw: unknown) => Result.Result<unknown, Schema.SchemaError>>
  >();
  const required: string[] = [];
  for (const [key, variants] of fields) {
    const schemas = variants.map((field) => settingsInputAdvertisement(field));
    if (union) for (const field of schemas) delete field["default"];
    properties[key] = union ? { anyOf: schemas } : schemas[0];
    if (
      union
        ? key === "op"
        : variants[0] && !Schema.toType(variants[0]).ast.context?.isOptional
    )
      required.push(key);
    decoders.set(
      key,
      variants.map((field) =>
        Schema.decodeUnknownResult(
          Schema.make<Schema.Codec<unknown>>(field.ast),
          { errors: "all" },
        ),
      ),
    );
  }
  properties["project"] = settingsInputAdvertisement(
    effectProjectKeySchema.annotate({
      description:
        "Configured repository key, never a path. Captain omission uses default; worker omission uses its persisted native context.",
    }),
  );
  const json = {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
  const project = ({ target }: { target: StandardJSONSchemaV1.Target }) =>
    jsonTarget(json, target);
  return {
    "~standard": {
      version: 1,
      vendor: "effect",
      jsonSchema: { input: project, output: project },
      validate: (raw) => {
        const result = decode(raw);
        if (Result.isFailure(result)) {
          const failed = operation?.(raw);
          if (failed && Result.isFailure(failed))
            return {
              issues: [
                ...settingsIssues(result.failure.issue).issues.filter(
                  (issue) => issue.path?.length,
                ),
                ...settingsIssues(failed.failure.issue).issues,
              ],
            };
          return settingsIssues(result.failure.issue);
        }
        const value: Record<string, unknown> = {};
        for (const key of Object.keys(properties)) {
          const present = Object.hasOwn(result.success, key);
          if (!present && (union || key === "project")) continue;
          const input = result.success[key];
          if (present) value[key] = input;
          if (union && input === undefined) continue;
          for (const decoder of decoders.get(key) ?? []) {
            const decoded = decoder(input);
            if (Result.isSuccess(decoded)) {
              if (present || decoded.success !== undefined)
                value[key] = decoded.success;
              break;
            }
          }
        }
        return { value };
      },
    },
  };
}

/** Pi advertises decoded required defaults, but trim remains a handler change. */
export function messagePiParameters(schema: EffectToolInput) {
  const json = settingsAdvertisement(schema);
  const branches = "members" in schema ? json["anyOf"] : [json];
  if ("members" in schema && Array.isArray(branches)) {
    json["oneOf"] = branches;
    delete json["anyOf"];
  }
  if (Array.isArray(branches))
    for (const branch of branches) {
      const properties = Predicate.isObject(branch)
        ? branch["properties"]
        : undefined;
      const text = Predicate.isObject(properties)
        ? properties["text"]
        : undefined;
      if (Predicate.isObject(text)) delete text["pattern"];
    }
  return { $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12, ...json };
}
