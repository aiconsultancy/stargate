import { Result, Schema } from "effect";
import type { SlackInteractions } from "./slack";

const commandName = Schema.Struct({
  command: Schema.String,
  text: Schema.optional(Schema.String),
});

const pairingAction = Schema.Union([
  Schema.Struct({
    view: Schema.Struct({ callback_id: Schema.Literal("stargate_pair") }),
  }),
  Schema.Struct({
    actions: Schema.mutable(Schema.Array(Schema.Unknown)).check(
      Schema.makeFilter((actions) =>
        actions.some((action) =>
          Result.isSuccess(
            Schema.decodeUnknownResult(
              Schema.Struct({
                action_id: Schema.Literal("stargate_pair_generate"),
              }),
            )(action),
          ),
        ),
      ),
    ),
  }),
]);

const decodeCommand = Schema.decodeUnknownResult(commandName);
const decodePairing = Schema.decodeUnknownResult(pairingAction);

function commandTarget(body: unknown) {
  const parsed = decodeCommand(body);

  if (Result.isFailure(parsed)) {
    return;
  }

  const { command, text } = parsed.success;

  if (command === "/cron") {
    return "cron";
  }

  if (command !== "/stargate") {
    return;
  }

  if (text === "pair") {
    return "pairing";
  }

  if (/^(?:crew|usage)(?:\s|$)/.test(text ?? "")) {
    return "crew";
  }

  return;
}

/** Route exact control namespaces, never slash-command text to a model. */
export function controlInteractions(
  cron: SlackInteractions,
  pairing: SlackInteractions,
  cancel: (body: unknown) => boolean,
  crew?: SlackInteractions,
  config?: (
    body: unknown,
    ack: Parameters<SlackInteractions["interactive"]>[1],
  ) => Promise<boolean>,
): SlackInteractions {
  return {
    async command(body, ack) {
      const target = commandTarget(body);

      if (target === "pairing") {
        await pairing.command(body, ack);
      } else if (target === "crew" && crew) {
        await crew.command(body, ack);
      } else if (target === "cron") {
        await cron.command(body, ack);
      } else {
        await ack({
          response_type: "ephemeral",
          text: "Unknown Stargate command. Use /stargate pair, /stargate crew [member], /stargate usage, or /cron.",
        });
      }
    },
    async interactive(body, ack) {
      if (Result.isSuccess(decodePairing(body))) {
        await pairing.interactive(body, ack);
      } else if (config && (await config(body, ack))) {
        return;
      } else if (cancel(body)) {
        await ack();
      } else {
        await cron.interactive(body, ack);
      }
    },
  };
}
