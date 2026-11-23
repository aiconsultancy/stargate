import { Result, Schema, SchemaTransformation } from "effect";
import type { BotConfig } from "../config";
import { type Identity, isAllowedChannel, isAllowedUser } from "./routing";
import { settingsPattern } from "../config/settings-schema";

export { cancellationNotice } from "../shared/request-failure";

const timestamp = Schema.String.check(settingsPattern(/^\d+\.\d+$/));

const actionSchema = Schema.Struct({
  type: Schema.Literal("block_actions"),
  api_app_id: Schema.String,
  team: Schema.Struct({ id: Schema.String }),
  user: Schema.Struct({
    id: Schema.String.check(settingsPattern(/^[UW][A-Z0-9]+$/)),
    is_bot: Schema.optional(Schema.Literal(false)),
    bot_id: Schema.optional(Schema.Never),
  }),
  bot_id: Schema.optional(Schema.Never),
  channel: Schema.Struct({
    id: Schema.String.check(settingsPattern(/^[CGD][A-Z0-9]+$/)),
  }),
  container: Schema.Struct({
    type: Schema.Literal("message"),
    channel_id: Schema.String,
    message_ts: timestamp,
    is_ephemeral: Schema.optional(Schema.Literal(false)),
  }),
  message: Schema.Struct({
    user: Schema.String,
    ts: timestamp,
    thread_ts: timestamp,
  }),
  actions: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        type: Schema.Literal("button"),
        action_id: Schema.Literal("stargate_stop"),
        value: Schema.String.check(settingsPattern(/^[1-9]\d{0,15}$/)).pipe(
          Schema.decodeTo(
            Schema.Int.check(Schema.isGreaterThan(0)),
            SchemaTransformation.transform({ decode: Number, encode: String }),
          ),
        ),
      }),
    ),
  ).check(Schema.isBetweenLength(1, 1)),
});

/** Socket Mode authenticates the envelope; persisted preview identity binds its target. */
export function cancellationTarget(
  raw: unknown,
  config: BotConfig,
  identity: Identity,
) {
  const parsed = Schema.decodeUnknownResult(actionSchema)(raw);

  if (Result.isFailure(parsed)) return;
  const data = parsed.success;
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
