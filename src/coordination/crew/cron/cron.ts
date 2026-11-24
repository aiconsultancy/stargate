import {
  JsonSchema,
  Match,
  Predicate,
  Result,
  Schema,
  type SchemaIssue,
} from "effect";
import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "effect/StandardSchema";
import { settingsInputAdvertisement } from "../../../config/settings-legacy";
import { settingsIssues } from "../../../config/settings-schema";
import {
  CronControlError,
  cronOperationBranches,
  cronOperationSchema,
  runCronOperation,
} from "../../../automation/cron/control";
import type { CrewCaller } from "../execution/engine";
import { CrewError } from "../execution/state";

// Shared settings codecs (destination and advanced options) are checked once,
// By the operation decoder, so their issues keep the operation's paths.
const operationChecked = new Set([
  "channel",
  "user",
  "trigger",
  "model",
  "once",
  "arbiter",
]);

const decodeOperation = Schema.decodeUnknownResult(cronOperationSchema, {
  errors: "all",
});

// The tool reads fields as the host passes them, inherited ones included.
const decodeObject = Schema.decodeUnknownResult(
  Schema.declare(
    (input): input is Record<string, unknown> =>
      Predicate.isObject(input) && !Array.isArray(input),
    { expected: "object" },
  ),
);

type FieldDecoder = (
  raw: unknown,
) => Result.Result<unknown, Schema.SchemaError>;

// A failed bound or pattern of a string or number still lets the operation
// Decoder report its issues; a wrong type, value, union, integer or array
// Length stops the check at the field.
const continuing = new Set([
  "effect/schema/isMinCodePoints",
  "effect/schema/isMaxCodePoints",
  "effect/schema/isPattern",
  "effect/schema/isBetween",
  "effect/schema/isGreaterThanOrEqualTo",
  "effect/schema/isLessThanOrEqualTo",
]);

function continues(issue: SchemaIssue.Issue): boolean {
  return Match.value(issue).pipe(
    Match.tag("Filter", ({ filter }) => {
      const id = filter.annotations?.representation?.id;

      return id !== undefined && continuing.has(id);
    }),
    Match.tag("Pointer", "Encoding", (inner) => continues(inner.issue)),
    Match.tag(
      "Composite",
      "AnyOf",
      ({ issues }) =>
        issues.length > 0 && issues.every((inner) => continues(inner)),
    ),
    Match.orElse(() => false),
  );
}

/** Advertised JSON of one field, in the property order of the tool schema. */
function advertised(key: string, variants: Record<string, unknown>[]) {
  const [only] = variants;

  if (
    variants.length === 1 &&
    only?.["type"] === "boolean" &&
    Object.keys(only).length === 1
  ) {
    return only;
  }

  return {
    anyOf: variants.map((variant) => {
      if (key === "skills") {
        const { maxItems, ...rest } = variant;

        return { maxItems, ...rest };
      }

      if (key === "id") {
        const { type, ...rest } = variant;

        return { type, format: "uuid", ...rest };
      }

      return variant;
    }),
  };
}

function jsonTarget(
  json: Record<string, unknown>,
  target: StandardJSONSchemaV1.Target,
) {
  if (target === "draft-2020-12") {
    return structuredClone({
      $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
      ...json,
    });
  }

  if (target === "draft-07") {
    return structuredClone({
      $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
      ...json,
    });
  }

  throw new Error(`Unsupported cron schema target: ${target}`);
}

/** The stargate_cron tool input: one flat object for every operation.
 * A present field must match that field in one operation; unknown fields
 * fail. Only then the operation decoder reports its own issues. The handler
 * receives the checked fields without operation defaults and decodes again.
 */
export function cronToolInput(): StandardSchemaV1<Record<string, unknown>> &
  StandardJSONSchemaV1<Record<string, unknown>> {
  const fields = new Map<string, Schema.Constraint[]>();

  for (const branch of cronOperationBranches.members) {
    for (const [key, field] of Object.entries<Schema.Constraint>(
      branch.fields,
    )) {
      const variants = fields.get(key) ?? [];
      variants.push(field);
      fields.set(key, variants);
    }
  }

  const properties: Record<string, unknown> = {};
  const decoders = new Map<string, FieldDecoder[]>();

  for (const [key, variants] of fields) {
    properties[key] = advertised(
      key,
      variants.map((field) => {
        const json = settingsInputAdvertisement(field);
        delete json["default"];

        return json;
      }),
    );
    decoders.set(
      key,
      variants.map((field) =>
        Schema.decodeUnknownResult(
          Schema.make<Schema.Codec<unknown>>(field.ast),
          {
            errors: "all",
          },
        ),
      ),
    );
  }

  const json = {
    type: "object",
    properties,
    required: ["op"],
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
        const object = decodeObject(raw);

        if (Result.isFailure(object)) {
          return settingsIssues(object.failure.issue);
        }

        const input = object.success;
        const issues: StandardSchemaV1.Issue[] = [];
        const value: Record<string, unknown> = {};
        let stop = false;

        for (const [key, variants] of decoders) {
          if (!(key in input)) {
            if (key === "op") {
              issues.push({ path: [key], message: "Invalid input" });
              stop = true;
            }

            continue;
          }

          const field = input[key];
          value[key] = field;

          if (
            operationChecked.has(key) ||
            (field === undefined && key !== "op")
          ) {
            continue;
          }

          const results = variants.map((decode) => decode(field));
          const decoded = results.find((result) => Result.isSuccess(result));

          if (decoded) {
            value[key] = decoded.success;
            continue;
          }

          const [only] = results;

          if (results.length !== 1 || !only || Result.isSuccess(only)) {
            issues.push({ path: [key], message: "Invalid input" });
            stop = true;
            continue;
          }

          for (const issue of settingsIssues(only.failure.issue).issues) {
            issues.push({ ...issue, path: [key, ...(issue.path ?? [])] });
          }

          if (!continues(only.failure.issue)) {
            stop = true;
          }
        }

        const unknown: string[] = [];

        for (const key in input) {
          if (!decoders.has(key)) {
            unknown.push(key);
          }
        }

        if (unknown.length > 0) {
          issues.push({
            path: [],
            message: `Unrecognized key${unknown.length === 1 ? "" : "s"}: ${unknown.map((key) => JSON.stringify(key)).join(", ")}`,
          });
        }

        if (stop) {
          return { issues };
        }

        const operation = decodeOperation(value);

        if (Result.isFailure(operation)) {
          issues.push(...settingsIssues(operation.failure.issue).issues);
        }

        return issues.length > 0 ? { issues } : { value };
      },
    },
  };
}

interface CronAuthority {
  options: {
    captainDirectory: string;
    cron?: { configPath: string; bot: string } | undefined;
  };
  captain(caller: CrewCaller): Promise<void>;
}

export class CrewCron {
  public constructor(
    private readonly authority: CronAuthority,
    private readonly runner: typeof runCronOperation = runCronOperation,
  ) {}

  public async run(raw: unknown, caller: CrewCaller): Promise<unknown> {
    const parsed = Schema.decodeUnknownResult(cronOperationSchema)(raw);

    if (Result.isFailure(parsed)) {
      throw new CrewError(
        "Invalid stargate_cron input. Use the declared fields.",
      );
    }

    const cancelled = () => {
      if (caller.signal.aborted) {
        throw new CrewError(
          "Cronjob operation cancelled; inspect retained status before retrying.",
        );
      }
    };

    cancelled();

    try {
      await this.authority.captain(caller);
    } catch (error) {
      if (error instanceof CrewError) {
        throw error;
      }

      throw new CrewError(
        "Captain verification unavailable; raw details withheld.",
      );
    }

    cancelled();
    const { captainDirectory, cron } = this.authority.options;

    if (!cron) {
      throw new CrewError(
        "Cronjobs unavailable: configure this captain's cron configPath and bot binding first.",
      );
    }

    const input = parsed.success;

    // Stable host tool identity makes a retry reuse its durable admission.
    const operation =
      input.op === "run" && !input.requestId && caller.id
        ? { ...input, requestId: caller.id }
        : input;

    try {
      const result = await this.runner(
        operation,
        {
          configPath: cron.configPath,
          bot: cron.bot,
          expectedDirectory: captainDirectory,
        },
        caller.signal,
      );

      cancelled();

      return result;
    } catch (error) {
      cancelled();
      throw new CrewError(
        error instanceof CronControlError
          ? error.message
          : "Cronjob operation unconfirmed; raw details withheld. Inspect retained status before retrying.",
      );
    }
  }
}
