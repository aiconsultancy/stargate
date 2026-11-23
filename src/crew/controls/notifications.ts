import {
  JsonSchema,
  Match,
  Predicate,
  Result,
  Schema,
  type SchemaAST,
  type SchemaIssue,
} from "effect";
import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "effect/StandardSchema";
import { settingsInputAdvertisement } from "../../config/settings-legacy";
import { settingsIssues } from "../../config/settings-schema";
import {
  NotificationControlError,
  runNotificationOperation,
} from "../../notifications/preferences/notification-control";
import { notificationInputSchema } from "../../notifications/preferences/notification-store";
import type { CrewCaller } from "../execution/engine";
import { CrewError } from "../execution/state";

const decodeOperation = Schema.decodeUnknownResult(notificationInputSchema, {
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

// A failed bound or pattern of a one-variant field still lets the operation
// Decoder report its issues; a wrong type or value stops the check there.
const continuing = new Set([
  "effect/schema/isMinCodePoints",
  "effect/schema/isMaxCodePoints",
  "effect/schema/isPattern",
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

/** The pattern sources of a string field, in check order. */
function patterns(ast: SchemaAST.AST): string[] {
  if (Predicate.isTagged(ast, "Union")) return ast.types.flatMap(patterns);

  return (ast.checks ?? []).flatMap((check) => {
    const representation = check.annotations?.representation;
    const payload: unknown = representation?.payload;

    return representation?.id === "effect/schema/isPattern" &&
      Predicate.isObject(payload) &&
      typeof payload["source"] === "string"
      ? [payload["source"]]
      : [];
  });
}

/** One field's advertised variant, spelled as the tool has always sent it.
 * A string with two patterns lists both under `allOf`; draft-07 repeats the
 * type in each member.
 */
function advertised(
  field: Schema.Constraint,
  target: StandardJSONSchemaV1.Target,
): Record<string, unknown> {
  const encoded = Schema.toEncoded(field);
  const sources = patterns(encoded.ast);

  if (sources.length < 2) return settingsInputAdvertisement(field);

  return {
    type: "string",
    allOf: sources.map((pattern) =>
      target === "draft-07" ? { type: "string", pattern } : { pattern },
    ),
  };
}

function schemaURI(target: StandardJSONSchemaV1.Target) {
  if (target === "draft-2020-12")
    return JsonSchema.META_SCHEMA_URI_DRAFT_2020_12;

  if (target === "draft-07") return JsonSchema.META_SCHEMA_URI_DRAFT_07;
  throw new Error(`Unsupported notification schema target: ${target}`);
}

/** The stargate_notifications tool input: one flat object for every
 * operation, advertised as before. A present field must match that field in
 * one operation; unknown fields fail. Only then the operation decoder reports
 * its own issues. The handler receives the checked fields and decodes again.
 */
export function notificationToolInput(): StandardSchemaV1<
  Record<string, unknown>
> &
  StandardJSONSchemaV1<Record<string, unknown>> {
  const fields = new Map<string, Schema.Constraint[]>();

  for (const branch of notificationInputSchema.members)
    for (const [key, field] of Object.entries<Schema.Constraint>(
      branch.fields,
    )) {
      const variants = fields.get(key) ?? [];
      variants.push(field);
      fields.set(key, variants);
    }

  const decoders = new Map<string, FieldDecoder[]>();

  for (const [key, variants] of fields)
    decoders.set(
      key,
      variants.map((field) =>
        Schema.decodeUnknownResult(Schema.toEncoded(field), { errors: "all" }),
      ),
    );

  const project = ({ target }: { target: StandardJSONSchemaV1.Target }) => {
    const properties: Record<string, unknown> = {};

    for (const [key, variants] of fields)
      properties[key] = {
        anyOf: variants.map((field) => advertised(field, target)),
      };

    return structuredClone({
      $schema: schemaURI(target),
      type: "object",
      properties,
      required: ["op"],
      additionalProperties: false,
    });
  };

  return {
    "~standard": {
      version: 1,
      vendor: "effect",
      jsonSchema: { input: project, output: project },
      validate: (raw) => {
        const object = decodeObject(raw);

        if (Result.isFailure(object))
          return settingsIssues(object.failure.issue);
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

          if (field === undefined && key !== "op") continue;
          const results = variants.map((decode) => decode(field));

          if (results.some((result) => Result.isSuccess(result))) continue;
          const [only] = results;

          if (results.length !== 1 || !only || Result.isSuccess(only)) {
            issues.push({ path: [key], message: "Invalid input" });
            stop = true;
            continue;
          }

          for (const issue of settingsIssues(only.failure.issue).issues)
            issues.push({ ...issue, path: [key, ...(issue.path ?? [])] });

          if (!continues(only.failure.issue)) stop = true;
        }

        const unknown: string[] = [];

        for (const key in input) if (!decoders.has(key)) unknown.push(key);

        if (unknown.length > 0)
          issues.push({
            path: [],
            message: `Unrecognized key${unknown.length === 1 ? "" : "s"}: ${unknown.map((key) => JSON.stringify(key)).join(", ")}`,
          });

        if (stop) return { issues };
        const operation = decodeOperation(value);

        if (Result.isFailure(operation))
          issues.push(...settingsIssues(operation.failure.issue).issues);

        return issues.length > 0 ? { issues } : { value };
      },
    },
  };
}

interface NotificationAuthority {
  options: {
    captainDirectory: string;
    cron?: { configPath: string; bot: string } | undefined;
  };
  captain(caller: CrewCaller): Promise<void>;
}

export class CrewNotifications {
  public constructor(
    private readonly authority: NotificationAuthority,
    private readonly runner: typeof runNotificationOperation = runNotificationOperation,
  ) {}

  public async run(raw: unknown, caller: CrewCaller): Promise<unknown> {
    const parsed = Schema.decodeUnknownResult(notificationInputSchema)(raw);

    if (Result.isFailure(parsed))
      throw new CrewError(
        "Invalid notification operation; targets must be explicit.",
      );
    caller.signal.throwIfAborted();
    await this.authority.captain(caller);
    caller.signal.throwIfAborted();
    const binding = this.authority.options.cron;

    if (!binding)
      throw new CrewError(
        "stargate_notifications unavailable: bind the captain's cron configPath and bot first.",
      );

    try {
      return await this.runner(
        parsed.success,
        {
          ...binding,
          expectedDirectory: this.authority.options.captainDirectory,
          captainSessionID: caller.sessionID,
          operationID: caller.id,
        },
        caller.signal,
      );
    } catch (error) {
      throw new CrewError(
        error instanceof NotificationControlError
          ? error.message
          : "Notification operation unconfirmed; private details withheld.",
      );
    }
  }
}
