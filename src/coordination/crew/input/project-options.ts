import { isAbsolute, resolve } from "node:path";
import {
  Predicate,
  Result,
  Schema,
  SchemaAST,
  SchemaTransformation,
} from "effect";
import {
  settingsCheck,
  settingsRecord,
  settingsRefine,
  settingsStruct,
} from "../../../config/settings-schema";
import { effectProjectKeySchema } from "../protocol/project-key";
import { agentIDSchema } from "../team";
import { type EffectToolInput, effectToolInputFields } from "./tool-input";

const directory = Schema.String.check(
  settingsRefine(
    (path) =>
      isAbsolute(path) && !path.includes("\0") && resolve(path) === path,
    { message: "Invalid input" },
  ),
);

const projectRecordSchema = settingsRecord(
  effectProjectKeySchema,
  Schema.mutableKey(
    settingsStruct({
      projectDirectory: directory,
      worktrees: settingsRecord(agentIDSchema, Schema.mutableKey(directory)),
    }),
  ),
).check(
  settingsCheck((projects, context) => {
    if (
      Object.keys(projects).length > 8 ||
      Object.hasOwn(projects, "default")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Configure at most eight additional projects; default is the existing context.",
      });
    }
  }),
);

export const projectsSchema = Schema.Unknown.check(
  Schema.makeFilter((value) => {
    if (!Predicate.isObject(value)) {
      return;
    }

    const prototype: unknown = Object.getPrototypeOf(value);

    return (prototype !== Object.prototype && prototype !== null) ||
      Object.keys(value).some((key) =>
        ["__proto__", "prototype", "constructor"].includes(key),
      )
      ? "Projects require safe own keys without prototype aliases."
      : undefined;
  }),
).pipe(Schema.decodeTo(projectRecordSchema));

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

      if (Result.isFailure(project)) {
        return project.failure.issue;
      }

      const { project: _project, ...input } = raw;
      const result = decode(input);

      return Result.isFailure(result) ? result.failure.issue : undefined;
    }),
  );
}
