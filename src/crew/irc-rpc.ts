import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";

const sessionID = z
  .string()
  .max(256)
  .regex(/^ses_[A-Za-z0-9]+$/);
const memberID = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const member = z.strictObject({
  role: z.enum(["captain", "crew"]),
  id: memberID,
});
const sequence = z.number().int().safe().nonnegative();
/** An outbox entry older than this is never listed or copied. */
export const outboxMaxAgeMs = 24 * 60 * 60_000;
export const outboxPageSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      sequence,
      id: z.string().regex(/^[a-f0-9]{32}$/),
      from: member,
      to: member,
      text: z.string().min(1).max(64000),
      /** Time the pogo_dm was stored (ms). */
      created: z.number().int().safe().nonnegative(),
    }),
  ),
  latest: sequence,
});
export type OutboxPage = z.infer<typeof outboxPageSchema>;

/**
 * Pogo's IRC transport → crew plugin, at the captain location only. `bind`
 * ties a crew IRC session that Pogo created to its crew member, so pogo_dm
 * and pogo_mail accept that session as the member. `outbox` lists stored
 * pogo_dm sends after a sequence (none without `after`: a baseline), so
 * Pogo can copy those between ship accounts as IRC DMs (docs/irc.md).
 */
export const CrewIrc = Rpc.define({
  id: "pogo.crew.irc",
  events: {},
  methods: {
    bind: {
      input: z.strictObject({ sessionID, crewID: memberID }),
      output: z.strictObject({ bound: z.literal(true) }),
    },
    outbox: {
      input: z.strictObject({
        after: sequence.optional(),
        limit: z.number().int().min(1).max(100),
      }),
      output: outboxPageSchema,
    },
  },
});
