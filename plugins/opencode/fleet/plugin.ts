import { isAbsolute, resolve } from "node:path";
import { Plugin } from "@opencode/plugin";
import { fromPromise } from "@opencode/plugin/promise/adapter";
import type { Context } from "@opencode/plugin/promise/plugin";
import {
  type Info,
  type ToolContext,
  Error as ToolError,
} from "@opencode/plugin/promise/tool";
import { JsonSchema, Result, Schema } from "effect";
import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "effect/StandardSchema";
import { settingsInputAdvertisement } from "../../../src/config/settings-legacy";
import {
  settingsDefault,
  settingsStruct,
} from "../../../src/config/settings-schema";
import { fleetRequest } from "../../../src/coordination/fleet/client";
import {
  callerSchema,
  dispatchInputSchema,
  FleetError,
  peerDestinationSchema,
  peerMessageInputSchema,
  type FleetRequest,
  offerAnswerInputSchema,
  reviewInputBranches,
  reviewInputSchema,
  statusInputSchema,
  verifyInputSchema,
} from "../../../src/coordination/fleet/protocol";

const optionsSchema = settingsStruct({
  socketPath: Schema.String.check(
    Schema.makeFilter((path) => isAbsolute(path) && resolve(path) === path),
  ),
  reviews: Schema.Boolean.pipe(settingsDefault(false)),
  peerMessages: Schema.Boolean.pipe(settingsDefault(false)),
});

/** Keep native validation and the original object/union tool presentations. */
function fleetToolInput<S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  presentation: Schema.Constraint = schema,
) {
  const native = Schema.toStandardSchemaV1(schema);

  const project = ({ target }: { target: StandardJSONSchemaV1.Target }) => {
    const json = settingsInputAdvertisement(presentation);

    if (target === "draft-2020-12") {
      return { $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12, ...json };
    }

    if (target === "draft-07") {
      return {
        $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
        ...JsonSchema.toDocumentDraft07({
          dialect: "draft-2020-12",
          schema: json,
          definitions: {},
        }).schema,
      };
    }

    throw new Error(`Unsupported fleet schema target: ${target}`);
  };

  return Object.assign(native, {
    "~standard": {
      ...native["~standard"],
      jsonSchema: { input: project, output: project },
    },
  });
}

const peerInputError =
  "Use op=send, a configured to, via=ship or via=command and 1–1,800 characters of single-line text without @ or control characters. Only steer delivery is supported.";

function isPeerInput(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    "via" in input &&
    input.via !== undefined
  );
}

function peerDmInput(input: Info["input"]) {
  const standard = "~standard" in input ? input["~standard"] : undefined;
  if (
    typeof standard !== "object" ||
    standard === null ||
    !("jsonSchema" in standard)
  ) {
    throw new ToolError({
      message: "The local DM tool has an unsupported input schema.",
    });
  }

  const local = standard as StandardSchemaV1.Props & StandardJSONSchemaV1.Props;
  const validatePeer = Schema.decodeUnknownResult(peerMessageInputSchema, {
    onExcessProperty: "error",
  });
  const project = (options: { target: StandardJSONSchemaV1.Target }) => {
    const json = local.jsonSchema.input(options);

    return {
      ...json,
      properties: {
        ...(json["properties"] as Record<string, unknown>),
        via: settingsInputAdvertisement(peerDestinationSchema),
      },
    };
  };

  return {
    "~standard": {
      ...local,
      jsonSchema: { input: project, output: project },
      validate(raw: unknown) {
        if (!isPeerInput(raw)) {
          return local.validate(raw);
        }

        const result = validatePeer(raw);

        return Result.isSuccess(result)
          ? { value: result.success }
          : { issues: [{ message: peerInputError }] };
      },
    },
  };
}

type ToolHost = {
  options: unknown;
  tool: Pick<Context["tool"], "transform">;
  permission: Pick<Context["permission"], "assert">;
};

/** Separate export permits native-host tests without a provider or model call. */
export async function installFleetTools(ctx: ToolHost) {
  const options = Schema.decodeUnknownSync(optionsSchema)(ctx.options);

  const caller = (context: ToolContext) =>
    Schema.decodeUnknownSync(callerSchema)({
      sessionID: context.sessionID,
      agent: context.agent,
      messageID: context.messageID,
      id: context.id,
    });

  const guard = async (
    context: ToolContext,
    action: string,
    resource: string,
    value: FleetRequest,
  ) => {
    // Preserve the native tool source; caller identity is never a tool argument.
    // Permission rejection must propagate natively rather than become tool text.
    await ctx.permission.assert({
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.messageID, id: context.id },
      action,
      resources: [resource],
      save: [resource],
    });

    try {
      const result = await fleetRequest(
        options.socketPath,
        value,
        context.signal,
      );

      return { content: JSON.stringify(result) };
    } catch (error) {
      throw new ToolError({
        message:
          error instanceof FleetError
            ? error.message
            : "Fleet operation unconfirmed; raw details withheld.",
      });
    }
  };

  const registration = await ctx.tool.transform((editor) => {
    if (options.peerMessages) {
      const dm = editor.list().find((tool) => tool.name === "stargate_dm");

      if (dm) {
        editor.update(dm.id, (tool) => {
          const sendLocal = tool.execute;
          tool.input = peerDmInput(tool.input);
          tool.description +=
            ' For a configured cross-ship captain, use their target ID as to and via="ship" or via="command". Send 1–1,800 characters on one line without @ or control characters. The gateway adds the recipient tag.';
          tool.execute = async (input, context) => {
            if (!isPeerInput(input)) {
              return sendLocal(input, context);
            }

            const peer = Schema.decodeUnknownResult(peerMessageInputSchema)(
              input,
              {
                onExcessProperty: "error",
              },
            );

            if (Result.isFailure(peer)) {
              throw new ToolError({
                message: peerInputError,
              });
            }

            return guard(context, "stargate_mail", "send", {
              operation: "peer-message",
              input: peer.success,
              caller: caller(context),
            });
          };
        });
      }
    }

    if (options.reviews) {
      editor.add({
        name: "fleet_review",
        description:
          "Start or inspect independent native PR-review evidence for an exact structured review assignment. The gateway derives native agent/model/verdict from retained history. Use only a configured named reviewer or matching-family captain; finish captain reviews as strict review JSON. Pending or uncertain work is never approving proof, never resubmit it. Read-only agent evidence supplies no human approval or GitHub authority.",
        input: fleetToolInput(
          reviewInputSchema,
          Schema.Union(reviewInputBranches, { mode: "oneOf" }),
        ),
        options: { codemode: false, permission: "fleet_review" },
        execute: (input, context) =>
          guard(
            context,
            "fleet_review",
            input.op === "start" ? input.reviewID : input.id,
            { operation: "review", input, caller: caller(context) },
          ),
      });
    }

    editor.add({
      name: "fleet_verify_instruction",
      description:
        "Retrieve the exact authenticated original Teams/IRC message, account, authority and source reference from the gateway ledger. Only this pinned session's sources or evidence explicitly delegated to it are visible. Verify text and identity before acting on a relay. Historical human text and agent rank never grant new human approval.",
      input: fleetToolInput(verifyInputSchema),
      options: { codemode: false, permission: "fleet_verify_instruction" },
      execute: (input, context) =>
        guard(context, "fleet_verify_instruction", input.reference, {
          operation: "verify",
          input,
          caller: caller(context),
        }),
    });
    editor.add({
      name: "fleet_dispatch",
      description:
        "Contact an explicitly configured fleet target, including a rear admiral, with existing authorised work under your own real agent identity and a verified original source reference. Read fleet_status for target IDs/channels; stargate_mail is local captain/crew mail only. Never approve as a human. Gateway records requestID before delivery; retry the SAME ID to read its retained result. unknown means delivery may have happened: inspect before any new request, never blindly resend. Optional requestID defaults to the native tool-call ID.",
      input: fleetToolInput(dispatchInputSchema),
      options: { codemode: false, permission: "fleet_dispatch" },
      execute: (input, context) =>
        guard(context, "fleet_dispatch", input.target, {
          operation: "dispatch",
          input,
          caller: caller(context),
        }),
    });
    editor.add({
      name: "fleet_answer_offer",
      description:
        "Answer a Ready-for-agents offer that your fleet's rear admiral addressed to you in chat: accept or decline, with the exact offerID from that offer message. The gateway sends the answer from your own IRC account as a reply to the offer. Accepting asks the rear admiral to assign the issue to you; the rear admiral confirms in the channel. No answer before the deadline counts as a decline. An optional short reason is shown to people only. Not human approval.",
      input: fleetToolInput(offerAnswerInputSchema),
      options: { codemode: false, permission: "fleet_answer_offer" },
      execute: (input, context) =>
        guard(context, "fleet_answer_offer", input.offerID, {
          operation: "answer",
          input,
          caller: caller(context),
        }),
    });
    editor.add({
      name: "fleet_status",
      description:
        "Read configured captain targets/transport state, or the durable outcome for one dispatch requestID, without waking an agent. sent confirms transport completion only; unknown never authorises automatic resend. No human approval authority.",
      input: fleetToolInput(statusInputSchema),
      options: { codemode: false, permission: "fleet_status" },
      execute: (input, context) =>
        guard(context, "fleet_status", input.requestID ?? "fleet", {
          operation: "status",
          input,
          caller: caller(context),
        }),
    });
  });

  return () => registration.dispose();
}

export const fleetPlugin = Plugin.define({
  id: "stargate.fleet",
  setup: installFleetTools,
});

export default fromPromise(fleetPlugin);
