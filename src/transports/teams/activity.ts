import { Schema } from "effect";
import {
  settingsDefault,
  settingsPattern,
  settingsUUID,
} from "../../config/settings-schema";
import { isAllowedServiceUrl } from "./service-url";

const account = Schema.Struct({
  id: Schema.String.check(Schema.isMinCodePoints(1)),
  aadObjectId: Schema.optional(settingsUUID),
  role: Schema.optional(Schema.String),
});

const timestamp = Schema.String.check(
  settingsPattern(
    /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z)$/,
  ),
).annotate({ format: "date-time" });

export const activitySchema = Schema.Struct({
  type: Schema.Literal("message"),
  id: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(512),
  ),
  channelId: Schema.Literal("msteams"),
  serviceUrl: Schema.String.check(Schema.makeFilter(isAllowedServiceUrl)),
  from: account,
  recipient: account,
  conversation: Schema.Struct({
    id: Schema.String.check(
      Schema.isMinCodePoints(1),
      Schema.isMaxCodePoints(1024),
    ),
    conversationType: Schema.Literals(["personal", "channel", "groupChat"]),
    tenantId: Schema.optional(settingsUUID),
  }),
  channelData: Schema.optional(
    Schema.Struct({
      tenant: Schema.optional(Schema.Struct({ id: settingsUUID })),
      channel: Schema.optional(Schema.Struct({ id: Schema.String })),
    }),
  ),
  attachments: Schema.optional(
    Schema.Array(
      Schema.Struct({
        contentType: Schema.optional(Schema.String),
        contentUrl: Schema.optional(Schema.String),
        content: Schema.optional(Schema.Unknown),
      }),
    ),
  ),
  text: Schema.String.check(Schema.isMaxCodePoints(40_000)).pipe(
    settingsDefault(""),
  ),
  timestamp: Schema.optional(timestamp),
  entities: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          type: Schema.optional(Schema.String),
          text: Schema.optional(Schema.String),
          mentioned: Schema.optional(account),
          quotedReply: Schema.optional(Schema.Unknown),
        }),
      ),
    ),
  ),
});

export type TeamsActivity = typeof activitySchema.Type;
