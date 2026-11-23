import { Cron } from "croner";
import { Result, Schema } from "effect";
import { settingsDefault, settingsStruct } from "../../config/settings-schema";
import { cronAdvancedOptions } from "./advanced";

const inputSchema = settingsStruct({
  name: Schema.Trim.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(80),
  ),
  expression: Schema.Trim.check(Schema.isMaxCodePoints(100)).pipe(
    settingsDefault(""),
  ),
  timezone: Schema.Trim.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(100),
  ).pipe(settingsDefault("UTC")),
  prompt: Schema.Trim.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(12_000),
  ),
  report: Schema.optional(Schema.Literals(["immediate", "daily"])),
  ...cronAdvancedOptions,
});

export type CronInput = typeof inputSchema.Type;

/** Errors never include supplied parser input, model output or task text. */
export function validateCronInput(
  raw: unknown,
  now: number,
): { input: CronInput; nextAt: number } {
  const parsed = Schema.decodeUnknownResult(inputSchema)(raw);

  if (Result.isFailure(parsed))
    throw new Error("Invalid cron input or field length.");
  const input = parsed.success;
  input.expression = input.expression.replace(/\s+/g, " ");

  if (!input.expression && !input.trigger)
    throw new Error("A schedule or quota trigger is required.");

  if (input.expression && input.expression.split(" ").length !== 5)
    throw new Error("Invalid cron expression: use five fields.");

  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime()))
    throw new Error("Invalid cron reference time.");

  try {
    if (/^[+-]/.test(input.timezone))
      throw new Error("Fixed-offset timezones are not IANA names.");
    new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format(now);
  } catch {
    throw new Error("Invalid cron timezone: use an IANA timezone name.");
  }

  // Event-only jobs never enter the clock due query. Zero is not a due date.
  if (!input.expression) return { input, nextAt: 0 };

  try {
    const cron = new Cron(input.expression, {
      timezone: input.timezone,
      mode: "5-part",
      paused: true,
    });

    const nextAt = cron.nextRun(new Date(now))?.getTime();

    if (nextAt === undefined || !Number.isFinite(nextAt) || nextAt <= now)
      throw new Error("The cron expression has no future occurrence.");

    return { input, nextAt };
  } catch {
    throw new Error("Invalid cron expression or no future occurrence.");
  }
}
