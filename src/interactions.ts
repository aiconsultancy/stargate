import { z } from "zod";
import type { SlackInteractions } from "./slack";

const commandName = z.object({
  command: z.string(),
  text: z.string().optional(),
});
const pairingAction = z.union([
  z.object({ view: z.object({ callback_id: z.literal("stargate_pair") }) }),
  z.object({
    actions: z
      .array(z.unknown())
      .refine((actions) =>
        actions.some(
          (action) =>
            z
              .object({ action_id: z.literal("stargate_pair_generate") })
              .safeParse(action).success,
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
      const parsed = commandName.safeParse(body);
      if (
        parsed.success &&
        parsed.data.command === "/stargate" &&
        parsed.data.text === "pair"
      )
        await pairing.command(body, ack);
      else if (
        parsed.success &&
        parsed.data.command === "/stargate" &&
        /^(?:crew|usage)(?:\s|$)/.test(parsed.data.text ?? "") &&
        crew
      )
        await crew.command(body, ack);
      else if (parsed.success && parsed.data.command === "/cron")
        await cron.command(body, ack);
      else
        await ack({
          response_type: "ephemeral",
          text: "Unknown Stargate command. Use /stargate pair, /stargate crew [member], /stargate usage, or /cron.",
        });
    },
    async interactive(body, ack) {
      if (pairingAction.safeParse(body).success)
        await pairing.interactive(body, ack);
      else if (config && (await config(body, ack))) return;
      else if (cancel(body)) await ack();
      else await cron.interactive(body, ack);
    },
  };
}
