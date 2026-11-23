import { Schema } from "effect";
import { isLoopbackHost } from "../lib/loopback";
import { mentionRuleSchema } from "../shared/mentions";
import {
  settingsDefault,
  settingsPattern,
  settingsRefine,
  settingsStruct,
  settingsURL,
} from "../config/settings-schema";

const endpoint = settingsURL.check(
  settingsRefine(
    (value) => {
      const url = new URL(value);
      const loopback = isLoopbackHost(url.hostname);

      return (
        (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash &&
        !value.includes("?") &&
        !value.includes("#")
      );
    },
    {
      message:
        "Use an HTTPS origin, or loopback HTTP, without path, credentials, query or fragment",
    },
  ),
);

/**
 * Off unless a bot sets it. The provider object is a discriminated shape so
 * another provider can be added without changing this bot setting.
 */
export const transcriptionSchema = settingsStruct({
  provider: settingsStruct({
    type: Schema.Literal("azure-openai"),
    endpoint,
    deployment: Schema.String.check(
      settingsPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    ),
    apiVersion: Schema.String.check(
      settingsPattern(/^\d{4}-\d{2}-\d{2}(-preview)?$/),
    ),
    /** Microsoft Entra token of the host's managed identity; no stored key. */
    auth: Schema.Literal("managedIdentity"),
  }),
  /** Limit for one file, including the wait for an earlier transcription. */
  timeoutMs: Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(1000))
    .check(Schema.isLessThanOrEqualTo(600_000))
    .pipe(settingsDefault(120_000)),
  /**
   * Channels where a voice message without a typed mention is transcribed
   * and admitted only if the speech names the bot. Absent is off.
   */
  spokenMentions: Schema.optional(mentionRuleSchema),
});

export type TranscriptionConfig = typeof transcriptionSchema.Type;
