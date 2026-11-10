import { isAbsolute } from "node:path";
import { z } from "zod";

export const cronChannel = z.string().regex(/^[CGD][A-Z0-9]+$/);
export const cronUser = z.string().regex(/^[UW][A-Z0-9]+$/);
export const cronjobsSchema = z.strictObject({
  directory: z
    .string()
    .max(4096)
    .refine((path) => isAbsolute(path) && !/[\r\n\0]/.test(path)),
  channel: cronChannel,
  user: cronUser,
  dailyReport: z
    .strictObject({
      channel: cronChannel.optional(),
      time: z
        .string()
        .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
        .default("08:30"),
      timezone: z.literal("UTC").default("UTC"),
    })
    .optional(),
});
