import { Schema } from "effect";
import {
  absolutePath,
  envName,
  settingsDefault,
  settingsPattern,
  settingsRecord,
  settingsRefine,
  settingsStruct,
  settingsURL,
} from "../../config/settings-schema";

export const opencodeBackendSchema = settingsStruct({
  type: Schema.Literal("opencode"),
  url: settingsURL.check(
    settingsRefine(
      (value) => ["http:", "https:"].includes(new URL(value).protocol),
      { message: "Invalid input" },
    ),
  ),
  directory: absolutePath,
  headersEnv: settingsRecord(Schema.String, envName).pipe(settingsDefault({})),
  sessionID: Schema.optional(
    Schema.String.check(Schema.isMaxCodePoints(256)).check(
      settingsPattern(/^ses_[A-Za-z0-9]+$/),
    ),
  ),
  agent: Schema.optional(Schema.String.check(Schema.isMinCodePoints(1))),
  enforcePermissions: Schema.optional(Schema.Boolean),
  model: Schema.optional(
    settingsStruct({
      providerID: Schema.String.check(Schema.isMinCodePoints(1)),
      id: Schema.String.check(Schema.isMinCodePoints(1)),
    }),
  ),
  permissions: Schema.mutable(
    Schema.Array(
      settingsStruct({
        action: Schema.String.check(Schema.isMinCodePoints(1)),
        resource: Schema.String.check(Schema.isMinCodePoints(1)),
        effect: Schema.Literals(["allow", "deny", "ask"]),
      }),
    ),
  ).pipe(settingsDefault([{ action: "*", resource: "*", effect: "deny" }])),
});
