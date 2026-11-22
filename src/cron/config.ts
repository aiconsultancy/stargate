import { isAbsolute } from "node:path";
import { Schema } from "effect";
import {
  settingsDefault,
  settingsPattern,
  settingsRefine,
  settingsStruct,
} from "../config/settings-schema";

export const cronChannel = Schema.String.check(
  settingsPattern(/^[CGD][A-Z0-9]+$/),
);

export const cronUser = Schema.String.check(settingsPattern(/^[UW][A-Z0-9]+$/));

export const cronjobsSchema = settingsStruct({
  advanced: Schema.optional(Schema.Boolean),
  directory: Schema.String.check(Schema.isMaxCodePoints(4096)).check(
    settingsRefine((path) => isAbsolute(path) && !/[\r\n\0]/.test(path), {
      message: "Invalid input",
    }),
  ),
  channel: cronChannel,
  user: cronUser,
  dailyReport: Schema.optional(
    settingsStruct({
      channel: Schema.optional(cronChannel),
      time: Schema.String.check(
        settingsPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
      ).pipe(settingsDefault("08:30")),
      timezone: Schema.Literal("UTC").pipe(settingsDefault("UTC")),
    }),
  ),
});
