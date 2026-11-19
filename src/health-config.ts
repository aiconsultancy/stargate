import { isAbsolute } from "node:path";
import { Schema } from "effect";
import {
  settingsDefault,
  settingsRefine,
  settingsStruct,
} from "./settings-schema";

const absolutePath = Schema.String.check(Schema.isMinCodePoints(1))
  .check(Schema.isMaxCodePoints(4096))
  .check(
    settingsRefine((value) => isAbsolute(value) && !value.includes("\0"), {
      message: "Invalid input",
    }),
  );
export const healthConfigSchema = settingsStruct({
  starfleetSnapshotFile: Schema.optional(absolutePath),
  opencodeDataDirectory: Schema.optional(absolutePath),
  crewWorktreesDirectory: Schema.optional(absolutePath),
  stalledAfterSeconds: Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(60))
    .check(Schema.isLessThanOrEqualTo(86400))
    .pipe(settingsDefault(1800)),
  snapshotMaxAgeSeconds: Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(60))
    .check(Schema.isLessThanOrEqualTo(86400))
    .pipe(settingsDefault(900)),
});
export type HealthConfig = typeof healthConfigSchema.Type;
