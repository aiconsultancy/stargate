import { isAbsolute, resolve } from "node:path";
import {
  Predicate,
  Result,
  Schema,
  SchemaAST,
  SchemaTransformation,
} from "effect";
import { z } from "zod";
import { agentIDSchema } from "./team";
import {
  type EffectToolInput,
  effectToolInputFields,
  objectToolInput,
} from "./tool-input";

const projectKeyPattern = /^[a-z][a-z0-9_-]{0,47}$/u;
export const effectProjectKeySchema = Schema.String.check(
  Schema.makeFilter(
    (key) => !["__proto__", "prototype", "constructor"].includes(key),
  ),
  Schema.isPattern(projectKeyPattern),
);
const decodeProject = Schema.decodeUnknownResult(effectProjectKeySchema);
// Narrow bridge for the remaining Zod configuration and tool envelopes.
export const projectKeySchema = z
  .string()
  .regex(projectKeyPattern)
  .refine((key) => Result.isSuccess(decodeProject(key)));
export const projectSelectionSchema = projectKeySchema;
const directory = z
  .string()
  .refine(
    (path) =>
      isAbsolute(path) && !path.includes("\0") && resolve(path) === path,
  );
const projectRecordSchema = z
  .record(
    projectKeySchema,
    z.strictObject({
      projectDirectory: directory,
      worktrees: z.record(agentIDSchema, directory),
    }),
  )
  .superRefine((projects, context) => {
    if (Object.keys(projects).length > 8 || Object.hasOwn(projects, "default"))
      context.addIssue({
        code: "custom",
        message:
          "Configure at most eight additional projects; default is the existing context.",
      });
  });
export const projectsSchema = z.preprocess((value, context) => {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some((key) =>
        ["__proto__", "prototype", "constructor"].includes(key),
      ))
  ) {
    context.addIssue({
      code: "custom",
      message: "Projects require safe own keys without prototype aliases.",
    });
    return z.NEVER;
  }
  return value;
}, projectRecordSchema);

/** Advertise an optional key without weakening the original strict operation. */
export function projectToolInput(
  schema: z.ZodObject | z.ZodDiscriminatedUnion<readonly z.ZodObject[]>,
) {
  const object =
    schema instanceof z.ZodObject ? schema : objectToolInput(schema);
  const shape: Record<string, z.ZodType> = {
    ...object.shape,
    project: projectKeySchema
      .describe(
        "Configured repository key, never a path. Captain omission uses default; worker omission uses its persisted native context.",
      )
      .optional(),
  };
  return z.strictObject(shape).superRefine((raw, context) => {
    const { project: _project, ...input } = raw;
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

/** Project selection stays outside the original strict operation validator. */
export function effectProjectToolInput(schema: EffectToolInput) {
  const advertised = Schema.Struct({
    ...effectToolInputFields(schema),
    project: Schema.optionalKey(
      effectProjectKeySchema.annotate({
        description:
          "Configured repository key, never a path. Captain omission uses default; worker omission uses its persisted native context.",
      }),
    ),
  });
  const decode = Schema.decodeUnknownResult(schema, {
    onExcessProperty: "error",
  });
  const selection = Schema.decodeUnknownResult(
    Schema.Struct({ project: Schema.optional(effectProjectKeySchema) }),
  );
  return Schema.declare<Record<string, unknown>>(Predicate.isObject, {
    toCodecJson: () =>
      new SchemaAST.Link(advertised.ast, SchemaTransformation.passthrough()),
  }).check(
    Schema.makeFilter((raw) => {
      const project = selection(raw);
      if (Result.isFailure(project)) return project.failure.issue;
      const { project: _project, ...input } = raw;
      const result = decode(input);
      return Result.isFailure(result) ? result.failure.issue : undefined;
    }),
  );
}
