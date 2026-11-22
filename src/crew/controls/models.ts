import type {
  ModelListInput,
  SessionCompactInput,
  SessionGetInput,
  SessionInterruptInput,
  SessionSwitchModelInput,
} from "@opencode/client";
import { JsonSchema, Predicate, Result, Schema } from "effect";
import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "effect/StandardSchema";
import {
  settingsDefault,
  settingsDiscriminatedUnion,
  settingsIssues,
  settingsStruct,
} from "../../config/settings-schema";
import type { CrewCaller, WorkerModelPeer } from "../engine";
import { effectProjectToolInput } from "../input/project-options";
import { CrewError } from "../state";
import { agentIDSchema, defaultModelProviders, type Team } from "../team";

const target = agentIDSchema.pipe(settingsDefault("captain"));
const modelBranches = Schema.Union([
  settingsStruct({
    op: Schema.Literal("get"),
    target: Schema.Literals(["captain", "self"]).pipe(settingsDefault("self")),
  }),
  settingsStruct({ op: Schema.Literal("list"), target }),
  settingsStruct({ op: Schema.Literal("inspect"), target: agentIDSchema }),
  settingsStruct({
    op: Schema.Literal("effort"),
    target: agentIDSchema,
    variant: Schema.String.check(
      Schema.isMinCodePoints(1),
      Schema.isMaxCodePoints(100),
    ),
  }),
  settingsStruct({
    op: Schema.Literal("switch"),
    target,
    providerID: Schema.String.check(
      Schema.isMinCodePoints(1),
      Schema.isMaxCodePoints(100),
    ),
    id: Schema.String.check(
      Schema.isMinCodePoints(1),
      Schema.isMaxCodePoints(256),
    ),
    variant: Schema.optional(
      Schema.String.check(
        Schema.isMinCodePoints(1),
        Schema.isMaxCodePoints(100),
      ),
    ),
    compactFirst: Schema.Boolean.pipe(settingsDefault(false)),
  }),
]);
export const modelInputSchema = settingsDiscriminatedUnion(
  "op",
  modelBranches.members,
);

// The legacy object envelope orders fields but leaves branch defaults to run().
// Keep this model-only SDK adapter native; other operation envelopes stay put.
const modelEnvelope = effectProjectToolInput(modelBranches);
const decodeEnvelope = Schema.decodeUnknownResult(modelEnvelope, {
  errors: "all",
});
const decodeOperation = Schema.decodeUnknownResult(modelInputSchema, {
  errors: "all",
});
const modelDocument = Schema.toJsonSchemaDocument(modelEnvelope, {
  onExcessProperty: "error",
});
const modelProperties = modelDocument.schema["properties"];
if (!Predicate.isObject(modelProperties))
  throw new Error("Invalid model tool advertisement");
// Preserve the installed Zod converter's literal/boolean union spelling.
modelProperties["op"] = {
  anyOf: modelBranches.members.map((member) => {
    const json = Schema.toJsonSchemaDocument(member.fields.op).schema;
    const values = json["enum"];
    if (!Array.isArray(values) || values.length !== 1)
      throw new Error("Invalid model operation advertisement");
    return { type: "string", const: values[0] };
  }),
};
for (const [key, property] of Object.entries(modelProperties)) {
  if (
    Predicate.isObject(property) &&
    Array.isArray(property["anyOf"]) &&
    property["anyOf"].length === 1 &&
    property["anyOf"][0]?.type === "boolean"
  )
    modelProperties[key] = property["anyOf"][0];
}
const modelFieldOrder = Object.keys(modelProperties);
export const modelToolInputSchema: StandardSchemaV1<Record<string, unknown>> &
  StandardJSONSchemaV1<Record<string, unknown>> = {
  "~standard": {
    version: 1,
    vendor: "effect",
    validate: (raw) => {
      const result = decodeEnvelope(raw);
      if (Result.isFailure(result)) {
        if (Predicate.isObject(raw)) {
          const { project: _project, ...operation } = raw;
          const failure = decodeOperation(operation);
          if (Result.isFailure(failure))
            return {
              issues: [
                ...settingsIssues(result.failure.issue).issues.filter(
                  (issue) => issue.path?.length,
                ),
                ...settingsIssues(failure.failure.issue).issues,
              ],
            };
        }
        return settingsIssues(result.failure.issue);
      }
      return {
        value: Object.fromEntries(
          modelFieldOrder
            .filter((key) => Object.hasOwn(result.success, key))
            .map((key) => [key, result.success[key]]),
        ),
      };
    },
    jsonSchema: {
      input: ({ target }) => {
        if (target === "draft-2020-12")
          return structuredClone({
            $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
            ...modelDocument.schema,
          });
        if (target === "draft-07")
          return structuredClone({
            $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
            ...JsonSchema.toDocumentDraft07(modelDocument).schema,
          });
        throw new Error(`Unsupported model schema target: ${target}`);
      },
      output: ({ target }) =>
        modelToolInputSchema["~standard"].jsonSchema.input({ target }),
    },
  },
};
type ModelRef = SessionSwitchModelInput["model"];
type Request = { signal: AbortSignal };
export interface ModelSessions {
  get(input: SessionGetInput, request?: Request): Promise<{ model?: ModelRef }>;
  switchModel(input: SessionSwitchModelInput, request?: Request): Promise<void>;
  compact(input: SessionCompactInput, request?: Request): Promise<unknown>;
  interrupt(input: SessionInterruptInput, request?: Request): Promise<unknown>;
}
interface Models {
  list(
    input: ModelListInput,
    request?: Request,
  ): Promise<{
    data: {
      id: string;
      providerID: string;
      enabled: boolean;
      variants: { id: string }[];
    }[];
  }>;
}
export interface ModelAuthority {
  options: {
    team: Team;
    captainDirectory: string;
    worktrees: Record<string, string>;
  };
  captain(caller: CrewCaller): Promise<void>;
  authorize(caller: CrewCaller): Promise<void>;
  inspectWorkerModel(
    crewID: string,
    caller: CrewCaller,
  ): Promise<WorkerModelPeer>;
  withWorkerControl<T>(
    crewID: string,
    caller: CrewCaller,
    operation: (peer: WorkerModelPeer) => Promise<T>,
    options?: { requireReady?: boolean },
  ): Promise<T>;
}

function describeModel(
  model: ModelRef | undefined,
  subject: "Worker" | "Session",
) {
  if (!model)
    throw new CrewError(
      `${subject} has no selected model; no default inferred.`,
    );
  return {
    providerID: model.providerID,
    id: model.id,
    variant: model.variant ?? "default/unspecified",
  };
}

export class CrewModels {
  constructor(
    private readonly authority: ModelAuthority,
    private readonly sessions: ModelSessions,
    private readonly models: Models,
    private readonly compactAndWait: (
      sessionID: string,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {}

  async run(raw: unknown, caller: CrewCaller) {
    const parsed = Schema.decodeUnknownResult(modelInputSchema, {
      onExcessProperty: "error",
    })(raw);
    if (Result.isFailure(parsed))
      throw new CrewError("Invalid stargate_model operation.");
    const input = parsed.success;
    try {
      caller.signal.throwIfAborted();
      if (input.op === "get") {
        if (input.target === "captain") await this.authority.captain(caller);
        else await this.authority.authorize(caller);
        const { model } = await this.sessions.get(
          { sessionID: caller.sessionID },
          { signal: caller.signal },
        );
        return {
          sessionID: caller.sessionID,
          model: describeModel(model, "Session"),
        };
      }
      if (input.op === "inspect") {
        const peer = await this.authority.inspectWorkerModel(
          input.target,
          caller,
        );
        return {
          sessionID: peer.sessionID,
          target: input.target,
          model: describeModel(peer.model, "Worker"),
        };
      }
      if (input.op === "effort") {
        return await this.authority.withWorkerControl(
          input.target,
          caller,
          async (peer) => {
            const current = peer.model;
            if (!current)
              throw new CrewError(
                "Worker has no selected model; no default inferred.",
              );
            const providers =
              this.authority.options.team.modelProviders ??
              defaultModelProviders;
            if (!providers.includes(current.providerID))
              throw new CrewError(
                "Worker's selected provider is outside this team's allowed model providers; effort unchanged.",
              );
            const directory = this.authority.options.worktrees[input.target];
            if (!directory)
              throw new CrewError("Unknown configured model target.");
            // Local readiness, ownership, control and native idle checks precede
            // catalogue access. All selection/mutation stays under that guard.
            const catalog = await this.catalog(directory, caller.signal);
            const available = catalog.find(
              (model) =>
                model.providerID === current.providerID &&
                model.id === current.id,
            );
            if (!available?.variants.some(({ id }) => id === input.variant))
              throw new CrewError(
                "Effort variant is unavailable for the current model; no model switch or fallback applied.",
              );
            const model = {
              providerID: current.providerID,
              id: current.id,
              variant: input.variant,
            };
            if (current.variant === input.variant)
              return {
                status: "unchanged",
                sessionID: peer.sessionID,
                model,
                effect: "subsequent-provider-turns",
              };
            return this.switch(peer.sessionID, model, caller.signal);
          },
          { requireReady: true },
        );
      }
      await this.authority.captain(caller);
      const { team } = this.authority.options;
      if (team.crew.find(({ id }) => id === input.target)?.backend)
        throw new CrewError(
          "Pi worker models are configured in team JSON; live model tools apply only to OpenCode.",
        );
      const directory =
        input.target === "captain"
          ? this.authority.options.captainDirectory
          : team.crew.some(({ id }) => id === input.target)
            ? this.authority.options.worktrees[input.target]
            : undefined;
      if (!directory) throw new CrewError("Unknown configured model target.");
      const catalog = await this.catalog(directory, caller.signal);
      if (input.op === "list")
        return {
          models: catalog.slice(0, 100).map((model) => ({
            providerID: model.providerID,
            id: model.id,
            variants: model.variants.map(({ id }) => id),
          })),
          truncated: catalog.length > 100,
        };
      const selected = catalog.find(
        (model) =>
          model.providerID === input.providerID && model.id === input.id,
      );
      if (
        !selected ||
        (input.variant &&
          !selected.variants.some(({ id }) => id === input.variant))
      ) {
        throw new CrewError(
          "Model or variant is unavailable or outside this team's allowed providers; no fallback applied.",
        );
      }
      const model: ModelRef = {
        providerID: input.providerID,
        id: input.id,
        ...(input.variant ? { variant: input.variant } : {}),
      };
      if (input.target === "captain") {
        if (input.compactFirst) {
          // Waiting for our own turn to compact would deadlock this tool call.
          await this.sessions.compact(
            { sessionID: caller.sessionID, delivery: "steer" },
            { signal: caller.signal },
          );
          return {
            status: "compaction-admitted",
            modelChanged: false,
            next: "After compaction completes, call switch again with compactFirst=false.",
          };
        }
        return await this.switch(caller.sessionID, model, caller.signal);
      }
      return await this.authority.withWorkerControl(
        input.target,
        caller,
        async (peer) => {
          if (input.compactFirst) {
            try {
              await this.compactAndWait(peer.sessionID, caller.signal);
            } catch {
              await this.sessions
                .interrupt(
                  { sessionID: peer.sessionID, resume: false },
                  { signal: AbortSignal.timeout(5000) },
                )
                .catch(() => {});
              throw new CrewError(
                "Worker compaction was not confirmed; model unchanged. Inspect the session before retrying.",
              );
            }
          }
          return this.switch(peer.sessionID, model, caller.signal);
        },
      );
    } catch (error) {
      if (caller.signal.aborted)
        throw new CrewError(
          "Model operation cancelled; inspect session state before retrying.",
        );
      if (error instanceof CrewError) throw error;
      throw new CrewError(
        "Model operation unavailable or unconfirmed; inspect session state. Raw details withheld.",
      );
    }
  }

  private async catalog(directory: string, signal: AbortSignal) {
    const providers =
      this.authority.options.team.modelProviders ?? defaultModelProviders;
    return (
      await this.models.list(
        { location: { directory }, types: ["chat"] },
        { signal },
      )
    ).data.filter(
      (model) => model.enabled && providers.includes(model.providerID),
    );
  }

  private async switch(
    sessionID: string,
    model: ModelRef,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    await this.sessions.switchModel({ sessionID, model }, { signal });
    const selected = (await this.sessions.get({ sessionID }, { signal })).model;
    if (
      selected?.providerID !== model.providerID ||
      selected.id !== model.id ||
      selected.variant !== model.variant
    ) {
      throw new CrewError(
        "Model selection was not confirmed; inspect the session before retrying.",
      );
    }
    return {
      status: "switched",
      sessionID,
      model,
      effect: "subsequent-provider-turns",
    };
  }
}
