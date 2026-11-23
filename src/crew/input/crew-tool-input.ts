import { JsonSchema, Predicate, Result, Schema } from "effect";
import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "effect/StandardSchema";
import {
  settingsAdvertisement,
  settingsInputAdvertisement,
} from "../../config/settings-legacy";
import {
  settingsDefault,
  settingsDiscriminatedUnion,
  settingsIssues,
  settingsStartsWith,
  settingsStruct,
} from "../../config/settings-schema";
import {
  effectProjectKeySchema,
  effectProjectToolInput,
} from "./project-options";

import {
  abandonInputSchema,
  inspectInputSchema,
  reconcileInputSchema,
  resumeInputSchema,
} from "../execution/reconciliation";
import { quotaInputSchema } from "../../quota/quota";
import { agentIDSchema } from "../team";
import { workspaceInputSchemas } from "../workspace/workspace";

const crewTaskID = Schema.String.check(
  settingsStartsWith("task_"),
  Schema.isMaxCodePoints(100),
);

const crewText = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(64_000),
);

export const crewInputBranches = Schema.Union([
  settingsStruct({ op: Schema.Literal("roster") }),
  inspectInputSchema,
  reconcileInputSchema,
  resumeInputSchema,
  abandonInputSchema,
  ...workspaceInputSchemas,
  settingsStruct({
    op: Schema.Literal("ensure"),
    crew: Schema.optional(agentIDSchema),
  }),
  settingsStruct({
    op: Schema.Literal("dispatch"),
    crew: agentIDSchema,
    text: crewText,
    queue: Schema.Boolean.pipe(settingsDefault(false)),
  }),
  settingsStruct({
    op: Schema.Literal("wait"),
    taskID: crewTaskID,
    afterNoticeID: Schema.Finite.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
    ).pipe(settingsDefault(0)),
  }),
  settingsStruct({ op: Schema.Literal("status"), taskID: crewTaskID }),
  settingsStruct({
    op: Schema.Literal("complete"),
    taskID: crewTaskID,
    result: crewText,
  }),
  settingsStruct({ op: Schema.Literal("compact"), crew: agentIDSchema }),
  settingsStruct({
    op: Schema.Literal("urgent"),
    taskID: crewTaskID,
    to: agentIDSchema,
    text: crewText,
  }),
]);

const crewBranchDecoders = new Map<
  string,
  (raw: unknown) => Result.Result<unknown, Schema.SchemaError>
>(
  crewInputBranches.members.map((member) => [
    String(member.fields.op.ast.literal),
    Schema.decodeUnknownResult(member, { errors: "all" }),
  ]),
);

// Native union sentinel optimization can otherwise hide an invalid literal
// Acknowledgement behind a root error. Delegate to the known branch first.
export const crewInputSchema = Schema.Unknown.check(
  Schema.makeFilter((raw) => {
    if (!Predicate.isObject(raw) || typeof raw["op"] !== "string") return;
    const decode = crewBranchDecoders.get(raw["op"]);

    if (!decode) return;
    const result = decode(raw);

    return Result.isFailure(result) ? result.failure.issue : undefined;
  }),
).pipe(
  Schema.decodeTo(settingsDiscriminatedUnion("op", crewInputBranches.members)),
);

export type CrewInput = typeof crewInputSchema.Type;

export { crewTaskID, crewText };

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
    for (const [key, field] of Object.entries<Schema.Constraint>(
      member.fields,
    )) {
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
    ((raw: unknown) => Result.Result<unknown, Schema.SchemaError>)[]
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

const decodeQuotaInput = Schema.decodeUnknownResult(quotaInputSchema, {
  errors: "all",
});

const decodeProjectKey = Schema.decodeUnknownResult(effectProjectKeySchema, {
  errors: "all",
});

// The tool reads fields as the host passes them, inherited ones included.
const decodeToolObject = Schema.decodeUnknownResult(
  Schema.declare(
    (input): input is Record<string, unknown> =>
      Predicate.isObject(input) && !Array.isArray(input),
    { expected: "object" },
  ),
);

/** The stargate_quota tool input: an optional project key and nothing else,
 * advertised as before. The quota decoder then checks the remaining fields.
 */
export function quotaToolInput(): StandardSchemaV1<Record<string, unknown>> &
  StandardJSONSchemaV1<Record<string, unknown>> {
  const json = {
    type: "object",
    properties: {
      project: settingsInputAdvertisement(
        effectProjectKeySchema.annotate({
          description:
            "Configured repository key, never a path. Captain omission uses default; worker omission uses its persisted native context.",
        }),
      ),
    },
    additionalProperties: false,
  };

  const project = ({ target }: { target: StandardJSONSchemaV1.Target }) => {
    if (target === "draft-2020-12")
      return structuredClone({
        $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
        ...json,
      });

    if (target === "draft-07")
      return structuredClone({
        $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
        ...json,
      });
    throw new Error(`Unsupported quota schema target: ${target}`);
  };

  return {
    "~standard": {
      version: 1,
      vendor: "effect",
      jsonSchema: { input: project, output: project },
      validate: (raw) => {
        const object = decodeToolObject(raw);

        if (Result.isFailure(object))
          return settingsIssues(object.failure.issue);
        const input = object.success;
        const issues: StandardSchemaV1.Issue[] = [];
        const value: Record<string, unknown> = {};

        if ("project" in input) {
          value["project"] = input["project"];

          if (input["project"] !== undefined) {
            const key = decodeProjectKey(input["project"]);

            if (Result.isFailure(key))
              for (const issue of settingsIssues(key.failure.issue).issues)
                issues.push({
                  ...issue,
                  path: ["project", ...(issue.path ?? [])],
                });
          }
        }

        const unknown: string[] = [];

        for (const key in input) if (key !== "project") unknown.push(key);

        if (unknown.length > 0)
          issues.push({
            path: [],
            message: `Unrecognized key${unknown.length === 1 ? "" : "s"}: ${unknown.map((key) => JSON.stringify(key)).join(", ")}`,
          });

        if (issues.length > 0) return { issues };
        const { project: _project, ...rest } = input;
        const quota = decodeQuotaInput(rest);

        return Result.isFailure(quota)
          ? settingsIssues(quota.failure.issue)
          : { value };
      },
    },
  };
}
