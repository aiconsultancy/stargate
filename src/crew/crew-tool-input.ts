import { JsonSchema, Predicate, Result, Schema } from "effect";
import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "effect/StandardSchema";
import {
  settingsAdvertisement,
  settingsInputAdvertisement,
} from "../settings-legacy";
import { settingsIssues } from "../settings-schema";
import { crewInputBranches, crewInputSchema } from "./engine";
import {
  effectProjectKeySchema,
  effectProjectToolInput,
} from "./project-options";

/** Crew-only SDK object envelope; top-level branch defaults stay in the handler. */
export function crewOpenCodeInput(): StandardSchemaV1<Record<string, unknown>> &
  StandardJSONSchemaV1<Record<string, unknown>> {
  const native = effectProjectToolInput(crewInputBranches);
  const decode = Schema.decodeUnknownResult(native, { errors: "all" });
  const operation = Schema.decodeUnknownResult(crewInputSchema, {
    errors: "all",
  });
  const fields = new Map<string, Schema.Constraint[]>();
  for (const member of crewInputBranches.members)
    for (const [key, field] of Object.entries(member.fields)) {
      const variants = fields.get(key) ?? [];
      variants.push(
        Object.hasOwn(field.ast.annotations ?? {}, "default")
          ? Schema.toEncoded(field)
          : field,
      );
      fields.set(key, variants);
    }
  const properties: Record<string, unknown> = {};
  const decoders = new Map<
    string,
    Array<(raw: unknown) => Result.Result<unknown, Schema.SchemaError>>
  >();
  for (const [key, variants] of fields) {
    const schemas = variants.map((variant) =>
      settingsInputAdvertisement(variant),
    );
    for (const schema of schemas) {
      delete schema["default"];
      if (key === "reason") delete schema["pattern"];
    }
    const only = schemas[0];
    properties[key] =
      schemas.length === 1 &&
      only?.["type"] === "boolean" &&
      !Object.hasOwn(only, "const")
        ? only
        : { anyOf: schemas };
    decoders.set(
      key,
      variants.map((variant) =>
        Schema.decodeUnknownResult(
          Schema.make<Schema.Codec<unknown>>(variant.ast),
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
    required: ["op"],
    additionalProperties: false,
  };
  const order = Object.keys(properties);
  const project = (target: StandardJSONSchemaV1.Target) => {
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
    throw new Error(`Unsupported crew schema target: ${target}`);
  };
  return {
    "~standard": {
      version: 1,
      vendor: "effect",
      validate: (raw) => {
        const result = decode(raw);
        if (Result.isFailure(result)) {
          if (Predicate.isObject(raw)) {
            const { project: _project, ...input } = raw;
            const failed = operation(input);
            if (Result.isFailure(failed))
              return {
                issues: [
                  ...settingsIssues(result.failure.issue).issues.filter(
                    (issue) => issue.path?.length,
                  ),
                  ...settingsIssues(failed.failure.issue).issues,
                ],
              };
          }
          return settingsIssues(result.failure.issue);
        }
        const value: Record<string, unknown> = {};
        for (const key of order) {
          if (!Object.hasOwn(result.success, key)) continue;
          const rawValue = result.success[key];
          value[key] = rawValue;
          if (rawValue === undefined) continue;
          for (const decode of decoders.get(key) ?? []) {
            const decoded = decode(rawValue);
            if (Result.isSuccess(decoded)) {
              value[key] = decoded.success;
              break;
            }
          }
        }
        return { value };
      },
      jsonSchema: {
        input: ({ target }) => project(target),
        output: ({ target }) => project(target),
      },
    },
  };
}

/** Pi retains its exclusive union and required decoded/defaulted fields. */
export function crewPiParameters() {
  const json = settingsAdvertisement(
    Schema.Union(crewInputBranches.members, { mode: "oneOf" }),
  );
  // Trim is a handler transformation, not an extra Pi whitespace constraint.
  const branches = json["oneOf"] ?? json["anyOf"];
  if (Array.isArray(branches)) {
    json["oneOf"] = branches;
    delete json["anyOf"];
  }
  if (Array.isArray(branches))
    for (const branch of branches) {
      const properties = Predicate.isObject(branch)
        ? branch["properties"]
        : undefined;
      const reason = Predicate.isObject(properties)
        ? properties["reason"]
        : undefined;
      if (Predicate.isObject(reason)) delete reason["pattern"];
    }
  return { $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12, ...json };
}
