import { z } from "zod";
import type { SlackInteractions } from "./slack";

const commandName = z.object({ command: z.string() });
const pairingAction = z.union([
  z.object({ view: z.object({ callback_id: z.literal("pogo_pair") }) }),
  z.object({
    actions: z
      .array(z.unknown())
      .refine((actions) =>
        actions.some(
          (action) =>
            z
              .object({ action_id: z.literal("pogo_pair_generate") })
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
): SlackInteractions {
  return {
    async command(body, ack) {
      const parsed = commandName.safeParse(body);
      if (parsed.success && parsed.data.command === "/pogo")
        await pairing.command(body, ack);
      else if (parsed.success && parsed.data.command === "/cron")
        await cron.command(body, ack);
      else
        await ack({
          response_type: "ephemeral",
          text: "Unknown Pogo command. Use /pogo pair or /cron.",
        });
    },
    async interactive(body, ack) {
      if (pairingAction.safeParse(body).success)
        await pairing.interactive(body, ack);
      else if (cancel(body)) await ack();
      else await cron.interactive(body, ack);
    },
  };
}
