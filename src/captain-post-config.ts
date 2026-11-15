import { isAbsolute } from "node:path";
import { z } from "zod";

/**
 * Opt-in `stargate_post`: the bot's captain may post to channels its access rules
 * allow. Absent is off. See docs/captain-post.md.
 */
export const captainPostSchema = z.strictObject({
  /**
   * Explicit conversation IDs this captain may post to, narrower than inbound
   * access: a post also needs `access.channels` and no `deniedChannels`
   * match. `*` is not accepted; DMs and group DMs must be listed here.
   */
  channels: z
    .array(
      z
        .string()
        .regex(
          /^[CGD][A-Z0-9]+$/,
          "captainPost.channels needs explicit Slack conversation IDs (C…, G… or D…); * is not accepted",
        ),
    )
    .min(1)
    .max(200),
  /**
   * Roots for attached files. Absent: the captain backend directory and
   * OpenCode's scratch directory, `join(os.tmpdir(), "opencode")` in the
   * plugin process at call time (honours TMPDIR). `[]` disables files.
   */
  fileDirectories: z
    .array(
      z
        .string()
        .max(4096)
        .refine((path) => isAbsolute(path) && !/[\r\n\0]/.test(path)),
    )
    .max(16)
    .optional(),
  /** Admitted posts per bot in any rolling hour. */
  postsPerHour: z.number().int().min(1).max(600).default(30),
});
export type CaptainPostConfig = z.infer<typeof captainPostSchema>;
