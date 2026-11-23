import { isAbsolute } from "node:path";
import { Schema } from "effect";
import {
  settingsDefault,
  settingsPattern,
  settingsRefine,
  settingsStruct,
} from "../../config/settings-schema";

/**
 * Opt-in `stargate_post`: the bot's captain may post to channels its access rules
 * allow. Absent is off. See docs/captain-post.md.
 */
export const captainPostSchema = settingsStruct({
  /**
   * Explicit conversation IDs this captain may post to, narrower than inbound
   * access: a post also needs `access.channels` and no `deniedChannels`
   * match. `*` is not accepted; DMs and group DMs must be listed here.
   */
  channels: Schema.mutable(
    Schema.Array(
      Schema.String.check(
        settingsPattern(/^[CGD][A-Z0-9]+$/, {
          message:
            "captainPost.channels needs explicit Slack conversation IDs (C…, G… or D…); * is not accepted",
        }),
      ),
    ),
  )
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(200)),
  /**
   * Roots for attached files. Absent: the captain backend directory and
   * OpenCode's scratch directory, `join(os.tmpdir(), "opencode")` in the
   * plugin process at call time (honours TMPDIR). `[]` disables files.
   */
  fileDirectories: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.String.check(Schema.isMaxCodePoints(4096)).check(
          settingsRefine((path) => isAbsolute(path) && !/[\r\n\0]/.test(path), {
            message: "Invalid input",
          }),
        ),
      ),
    ).check(Schema.isMaxLength(16)),
  ),
  /** Admitted posts per bot in any rolling hour. */
  postsPerHour: Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(1))
    .check(Schema.isLessThanOrEqualTo(600))
    .pipe(settingsDefault(30)),
});

export type CaptainPostConfig = typeof captainPostSchema.Type;
