import { z } from "zod";
import type { BotConfig } from "./config";
import { type Identity, isAllowedChannel, isAllowedUser } from "./routing";

export const cancellationNotice =
  "Pogo received your stop request. Work may have run; existing effects may remain. The request was not repeated. Check agent state before trying again.";

const timestamp = z.string().regex(/^\d+\.\d+$/);
const actionSchema = z.object({
  type: z.literal("block_actions"),
  api_app_id: z.string(),
  team: z.object({ id: z.string() }),
  user: z.object({
    id: z.string().regex(/^[UW][A-Z0-9]+$/),
    is_bot: z.literal(false).optional(),
    bot_id: z.never().optional(),
  }),
  bot_id: z.never().optional(),
  channel: z.object({ id: z.string().regex(/^[CGD][A-Z0-9]+$/) }),
  container: z.object({
    type: z.literal("message"),
    channel_id: z.string(),
    message_ts: timestamp,
    is_ephemeral: z.literal(false).optional(),
  }),
  message: z.object({ user: z.string(), ts: timestamp, thread_ts: timestamp }),
  actions: z
    .array(
      z.object({
        type: z.literal("button"),
        action_id: z.literal("pogo_stop"),
        value: z
          .string()
          .regex(/^[1-9]\d{0,15}$/)
          .transform(Number)
          .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)),
      }),
    )
    .length(1),
});

/** Socket Mode authenticates the envelope; persisted preview identity binds its target. */
export function cancellationTarget(
  raw: unknown,
  config: BotConfig,
  identity: Identity,
) {
  const parsed = actionSchema.safeParse(raw);
  if (!parsed.success) return;
  const data = parsed.data;
  const action = data.actions[0];
  if (
    !action ||
    data.api_app_id !== config.slack.appId ||
    data.team.id !== identity.team ||
    data.user.id === identity.user ||
    data.message.user !== identity.user ||
    data.container.channel_id !== data.channel.id ||
    data.container.message_ts !== data.message.ts ||
    !isAllowedUser(config, data.user.id) ||
    !isAllowedChannel(config, data.channel.id)
  )
    return;
  return {
    id: action.value,
    user: data.user.id,
    channel: data.channel.id,
    thread: data.message.thread_ts,
    ts: data.message.ts,
  };
}

export function stopBlock(job: number) {
  return {
    type: "actions" as const,
    elements: [
      {
        type: "button" as const,
        action_id: "pogo_stop",
        text: { type: "plain_text" as const, text: "Stop", emoji: false },
        accessibility_label: "Stop this request (requester only)",
        value: String(job),
      },
    ],
  };
}
