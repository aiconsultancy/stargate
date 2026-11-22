import { Rpc } from "@opencode/plugin/rpc";
import { Schema } from "effect";
import { settingsPattern, settingsStruct } from "../config/settings-schema";
import { messagePortableSchema } from "./message-tool-input";
import { effectProjectKeySchema } from "./input/project-options";

const sessionID = Schema.String.check(
  Schema.isMaxCodePoints(256),
  settingsPattern(/^ses_[A-Za-z0-9]+$/),
);
const memberID = Schema.String.check(
  settingsPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/),
);
const member = settingsStruct({
  role: Schema.Literals(["captain", "crew"]),
  id: memberID,
});
const sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** An outbox entry older than this is never listed or copied. */
export const outboxMaxAgeMs = 24 * 60 * 60_000;
export const outboxPageSchema = settingsStruct({
  items: Schema.mutable(
    Schema.Array(
      settingsStruct({
        sequence,
        id: Schema.String.check(settingsPattern(/^[a-f0-9]{32}$/)),
        from: member,
        to: member,
        text: Schema.String.check(
          Schema.isMinCodePoints(1),
          Schema.isMaxCodePoints(64000),
        ),
        /** Time the stargate_dm was stored (ms). */
        created: sequence,
      }),
    ),
  ),
  latest: sequence,
});
export type OutboxPage = typeof outboxPageSchema.Type;

/**
 * Stargate's IRC transport → crew plugin, at the captain location only. `bind`
 * ties a crew IRC session that Stargate created to its crew member, so stargate_dm
 * and stargate_mail accept that session as the member. `outbox` lists stored
 * stargate_dm sends after a sequence (none without `after`: a baseline), so
 * Stargate can copy those between ship accounts as IRC DMs (docs/irc.md).
 */
export const CrewIrc = Rpc.define({
  id: "stargate.crew.irc",
  events: {},
  methods: {
    bind: {
      input: messagePortableSchema(
        settingsStruct({
          sessionID,
          crewID: memberID,
          project: Schema.optional(effectProjectKeySchema),
        }),
      ),
      output: messagePortableSchema(
        settingsStruct({ bound: Schema.Literal(true) }),
      ),
    },
    outbox: {
      input: messagePortableSchema(
        settingsStruct({
          project: Schema.optional(effectProjectKeySchema),
          after: Schema.optional(sequence),
          limit: Schema.Int.check(
            Schema.isBetween({ minimum: 1, maximum: 100 }),
          ),
        }),
      ),
      output: messagePortableSchema(outboxPageSchema),
    },
  },
});
