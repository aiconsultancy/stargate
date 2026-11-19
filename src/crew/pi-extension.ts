import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Effect, Predicate, Schema } from "effect";
import { z } from "zod";
import { quotaInputSchema } from "../quota";
import { crewPiParameters } from "./crew-tool-input";
import { crewInputSchema } from "./engine";
import { journalInputSchema } from "./journal";
import { messagePiParameters } from "./message-tool-input";
import { dmInputSchema, mailInputBranches, mailInputSchema } from "./messaging";
import { CrewError } from "./state";
import { effectToolInputFields } from "./tool-input";

const outputLimit = 50 * 1024;

export type PiCrewBinding = {
  authorize(conversationID: string): void;
  run(
    name: string,
    input: unknown,
    conversationID: string,
    id: string,
    signal: AbortSignal,
  ): Promise<unknown>;
};
// Pi validates JavaScript arguments before execute. A structural JSON schema
// rejects undefined cursor values there; opaque MutableJson advertises {}.
const historyJson: Schema.Codec<Schema.MutableJson> = Schema.suspend(() =>
  Schema.Union([
    Schema.String,
    Schema.Finite,
    Schema.Boolean,
    Schema.Null,
    Schema.mutable(Schema.Array(historyJson)),
    Schema.Record(Schema.String, historyJson),
  ]),
);
const history = Schema.Struct({
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(20)),
  ),
  cursor: Schema.optional(Schema.Record(Schema.String, historyJson)),
});
const decodeHistory = Schema.decodeUnknownSync(history, {
  onExcessProperty: "error",
});
const decodeJournal = Schema.decodeUnknownSync(journalInputSchema, {
  onExcessProperty: "error",
});
// Resolve the circular engine import only when this crew tool is invoked.
const decodeCrew = (raw: unknown) =>
  Schema.decodeUnknownSync(crewInputSchema)(raw);
const decodeMail = Schema.decodeUnknownSync(mailInputSchema);
const decodeDM = Schema.decodeUnknownSync(dmInputSchema);
// Pi's legacy advertisement required defaulted fields. Handler defaults do not
// authorize accepting their omission at the native JSON Schema boundary.
const historyParameters = effectParameters(
  Schema.Struct(
    effectToolInputFields(
      history.mapFields((fields) => ({
        ...fields,
        limit: Schema.toType(fields.limit),
      })),
    ),
  ),
);
const journalParameters = journalToolParameters();

/** Thin native bindings. Each invocation is tied to the saved member conversation. */
export function piCrewToolDefinitions() {
  return [
    {
      name: "stargate_quota",
      schema: quotaInputSchema,
      description:
        "Read Claude/Codex subscription quota percentages, scopes, resets and timestamps, not token totals. Cached up to 60s. Missing/inactive limits and reset-passed observations do not prove model availability. No changes; no arguments or credentials.",
    },
    {
      name: "stargate_crew",
      schema: crewInputSchema,
      description:
        "Read configured roster or own task status; captain controls remain captain-only.",
    },
    {
      name: "stargate_journal",
      schema: journalInputSchema,
      description:
        "Append concise task milestones, checks, blockers and outcomes; read scoped journal by entry ID. No transcripts or secrets.",
    },
    {
      name: "stargate_mail",
      schema: mailInputSchema,
      description:
        "Store/read asynchronous peer mail. captain aliases the originating captain; all excludes self. Mail never wakes agents. Reply with replyTo; acknowledge pages with nextAfter as after.",
    },
    {
      name: "stargate_dm",
      schema: dmInputSchema,
      description:
        "Store peer mail and request steer or queue notification. Queued assignments do not block an idle member's roll-call reply. FIFO is default guidance, not a lock; active/uncertain work and ownership/controller guards remain. Native acceptance does not mean read or answered. Final answers remain task results; use replyTo for peer replies.",
    },
    {
      name: "pi_history",
      schema: history,
      description:
        "Read paginated immutable history of this Pi conversation through the existing native runtime. No other conversations, no agent work.",
    },
  ];
}

export function piCrewExtension(
  binding: PiCrewBinding,
  readHistory: (
    id: string,
    input: typeof history.Type,
    signal: AbortSignal,
  ) => Promise<unknown>,
) {
  const tools = piCrewToolDefinitions().map(({ name, schema, description }) => {
    const parameters = Schema.isSchema(schema)
      ? name === "pi_history"
        ? historyParameters
        : name === "stargate_crew"
          ? crewPiParameters()
          : name === "stargate_mail"
            ? messagePiParameters(mailInputBranches)
            : name === "stargate_dm"
              ? messagePiParameters(dmInputSchema)
              : journalParameters
      : z.toJSONSchema(schema);
    return defineTool({
      name,
      description,
      parameters,
      replay: "unsafe",
      async execute(raw, api, context) {
        try {
          binding.authorize(String(api.conversationId));
          const signal = context.abortSignal ?? new AbortController().signal;
          const result =
            name === "pi_history"
              ? await readHistory(
                  String(api.conversationId),
                  decodeHistory(raw),
                  signal,
                )
              : await binding.run(
                  name,
                  Schema.isSchema(schema)
                    ? name === "stargate_crew"
                      ? decodeCrew(raw)
                      : name === "stargate_mail"
                        ? decodeMail(raw)
                        : name === "stargate_dm"
                          ? decodeDM(raw)
                          : decodeJournal(raw)
                    : schema.parse(raw),
                  String(api.conversationId),
                  String(api.taskId),
                  signal,
                );
          const text = JSON.stringify(result);
          if (Buffer.byteLength(text, "utf8") > outputLimit)
            throw new CrewError("result too large, retry with a smaller limit");
          return { output: [{ type: "text" as const, text }] };
        } catch (error) {
          return {
            isError: true,
            output: [
              {
                type: "text" as const,
                text:
                  error instanceof CrewError
                    ? error.message
                    : "Crew operation unavailable or unconfirmed; do not replay uncertain work.",
              },
            ],
          };
        }
      },
      outputLimits: { maxBytes: outputLimit, maxLines: 200 },
    });
  });
  return defineExtension({ name: "stargate.crew", tools });
}

function effectParameters(schema: Schema.Constraint) {
  const document = Schema.toJsonSchemaDocument(schema, {
    onExcessProperty: "error",
  });
  return { ...document.schema, $defs: document.definitions };
}

function journalToolParameters() {
  const schema = Schema.Union(
    journalInputSchema.members.map((member) =>
      Schema.Struct(
        effectToolInputFields(
          member.mapFields((fields) =>
            Object.fromEntries(
              Object.entries(fields).map(([name, field]) => [
                name,
                Schema.toType(field),
              ]),
            ),
          ),
        ),
      ),
    ),
  );
  const document = Schema.toJsonSchemaDocument(schema, {
    onExcessProperty: "error",
  });
  const branches = document.schema["anyOf"];
  const append = Array.isArray(branches) ? branches[0] : undefined;
  const properties = Predicate.isObject(append)
    ? append["properties"]
    : undefined;
  const text = Predicate.isObject(properties) ? properties["text"] : undefined;
  if (!Predicate.isObject(text))
    throw new Error(
      "Journal tool advertisement requires an append text schema.",
    );
  // Zod advertised trim's length bounds but no whitespace restriction. Keep
  // the decoded bounds/required fields; only the handler applies trimming.
  delete text["pattern"];
  return { ...document.schema, $defs: document.definitions };
}
