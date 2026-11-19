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
      const parsed = Schema.decodeUnknownResult(commandName)(body);
      if (
        Result.isSuccess(parsed) &&
        parsed.success.command === "/stargate" &&
        parsed.success.text === "pair"
      )
        await pairing.command(body, ack);
      else if (
        Result.isSuccess(parsed) &&
        parsed.success.command === "/stargate" &&
        /^(?:crew|usage)(?:\s|$)/.test(parsed.success.text ?? "") &&
        crew
      )
        await crew.command(body, ack);
      else if (Result.isSuccess(parsed) && parsed.success.command === "/cron")
        await cron.command(body, ack);
      else
        await ack({
          response_type: "ephemeral",
          text: "Unknown Stargate command. Use /stargate pair, /stargate crew [member], /stargate usage, or /cron.",
        });
    },
    async interactive(body, ack) {
      if (Result.isSuccess(Schema.decodeUnknownResult(pairingAction)(body)))
        await pairing.interactive(body, ack);
      else if (config && (await config(body, ack))) return;
      else if (cancel(body)) await ack();
      else await cron.interactive(body, ack);
    },
  };
}
