import { isAbsolute } from "node:path";
import { z } from "zod";

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value) && !value.includes("\0"));
export const healthConfigSchema = z.strictObject({
  starfleetSnapshotFile: absolutePath.optional(),
  opencodeDataDirectory: absolutePath.optional(),
  crewWorktreesDirectory: absolutePath.optional(),
  stalledAfterSeconds: z.number().int().min(60).max(86400).default(1800),
  snapshotMaxAgeSeconds: z.number().int().min(60).max(86400).default(900),
});
export type HealthConfig = z.infer<typeof healthConfigSchema>;
