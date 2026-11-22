import { Rpc } from "@opencode/plugin/rpc";
import { JsonSchema, Predicate, Result, Schema } from "effect";
import type { StandardJSONSchemaV1 } from "effect/StandardSchema";
import { decodeSettings } from "../config/settings-errors";
import { settingsInputAdvertisement } from "../config/settings-legacy";
import {
  settingsDiscriminatedUnion,
  settingsStruct,
} from "../config/settings-schema";
import type { CrewEngine } from "./engine";
import { effectProjectKeySchema } from "./input/project-options";
import {
  abandonInputSchema,
  inspectInputSchema,
  reconcileInputSchema,
} from "./reconciliation";
import { workspaceInputSchemas } from "./workspace/workspace";

const recoveryBranches = [
  inspectInputSchema,
  reconcileInputSchema,
  abandonInputSchema,
  ...workspaceInputSchemas,
] as const;
// Known-branch decoding retains acknowledgement paths before union routing.
const recoveryOperationSchema = Schema.Unknown.check(
  Schema.makeFilter((raw) => {
    if (!Predicate.isObject(raw) || typeof raw["op"] !== "string")
      return undefined;
    const branch = recoveryBranches.find(
      (member) => member.fields.op.ast.literal === raw["op"],
    );
    if (!branch) return undefined;
    const parsed = Schema.decodeUnknownResult(branch, { errors: "all" })(raw);
    return Result.isFailure(parsed) ? parsed.failure.issue : undefined;
  }),
).pipe(Schema.decodeTo(settingsDiscriminatedUnion("op", recoveryBranches)));

export const recoveryRequestSchema = settingsStruct({
  sessionID: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(256),
  ),
  project: Schema.optional(effectProjectKeySchema),
  request: recoveryOperationSchema,
});
const recoveryNativeInput = Schema.toStandardSchemaV1(recoveryRequestSchema);
const recoveryJSON = ({ target }: { target: StandardJSONSchemaV1.Target }) => {
  const json = settingsInputAdvertisement(recoveryRequestSchema);
  if (target === "draft-2020-12")
    return { $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12, ...json };
  if (target === "draft-07")
    return {
      $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
      ...JsonSchema.toDocumentDraft07({
        dialect: "draft-2020-12",
        schema: json,
        definitions: {},
      }).schema,
    };
  throw new Error(`Unsupported recovery schema target: ${target}`);
};
// Keep the Effect codec prototype/AST recognized by the installed SDK, with
// input-side JSON metadata separate from decoded required defaults.
const recoveryPortableInput = Object.assign(recoveryNativeInput, {
  "~standard": {
    ...recoveryNativeInput["~standard"],
    jsonSchema: { input: recoveryJSON, output: recoveryJSON },
  },
});
export const CrewRecovery = Rpc.define({
  id: "stargate.crew.recovery",
  events: {},
  methods: {
    // The Promise RPC registration consumes PortableValueSchema (Standard
    // Schema), while the native codecs remain authoritative and nested-strict.
    run: {
      input: recoveryPortableInput,
      output: Schema.toStandardSchemaV1(Schema.String),
    },
  },
});

/** Authenticated operator transport; engine validates the native root identity. */
export async function runRecoveryOperator(
  engine: CrewEngine,
  raw: unknown,
  signal: AbortSignal,
): Promise<string> {
  const input = decodeSettings(recoveryRequestSchema, raw);
  return JSON.stringify(
    await engine.run(input.request, {
      sessionID: input.sessionID,
      agent: engine.options.team.captain.id,
      signal,
    }),
  );
}
