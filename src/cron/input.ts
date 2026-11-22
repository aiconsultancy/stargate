import { Cron } from "croner";
import { z } from "zod";
import { cronAdvancedFields } from "./advanced";

const inputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  expression: z.string().trim().max(100).default(""),
  timezone: z.string().trim().min(1).max(100).default("UTC"),
  prompt: z.string().trim().min(1).max(12_000),
  report: z.enum(["immediate", "daily"]).optional(),
  ...cronAdvancedFields,
});

export type CronInput = z.infer<typeof inputSchema>;

/** Errors never include supplied parser input, model output or task text. */
export function validateCronInput(
  raw: unknown,
  now: number,
): { input: CronInput; nextAt: number } {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid cron input or field length.");
  const input = parsed.data;
  input.expression = input.expression.replace(/\s+/g, " ");
  if (!input.expression && !input.trigger)
    throw new Error("A schedule or quota trigger is required.");
  if (input.expression && input.expression.split(" ").length !== 5)
    throw new Error("Invalid cron expression: use five fields.");
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime()))
    throw new Error("Invalid cron reference time.");
  try {
    if (/^[+-]/.test(input.timezone)) throw new Error();
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
      throw new Error();
    return { input, nextAt };
  } catch {
    throw new Error("Invalid cron expression or no future occurrence.");
  }
}
