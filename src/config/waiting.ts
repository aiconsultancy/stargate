import { Schema } from "effect";
import { settingsDefault, settingsStruct } from "./settings-schema";

export const waitingDelaySchema = Schema.NullOr(
  Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0))
    .check(Schema.isLessThanOrEqualTo(3_600_000)),
);

export const waitingSchema = settingsStruct({
  delayMs: waitingDelaySchema.pipe(settingsDefault(5000)),
  intervalMs: Schema.Finite.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(1000))
    .check(Schema.isLessThanOrEqualTo(3_600_000))
    .pipe(settingsDefault(10_000)),
});

export type WaitingSettings = typeof waitingSchema.Type;
