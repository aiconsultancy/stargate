import { isAbsolute } from "node:path";
import { Schema } from "effect";
import { z } from "zod";
import { crewStatusSchema } from "../shared/crew-status";
import { exactStruct } from "../shared/session-history";
import { legacySetting } from "../settings-legacy";
import { effectProjectKeySchema } from "./project-options";
import { agentIDSchema } from "./team";

const directory = Schema.String.check(
  Schema.isBetweenCodePoints(1, 4096),
  Schema.makeFilter((path) => isAbsolute(path) && !path.includes("\0")),
);
const metadata = exactStruct({
  projectDirectory: directory,
  contexts: Schema.Array(
    exactStruct({
      member: agentIDSchema,
      project: Schema.NullOr(effectProjectKeySchema),
      directory,
      role: Schema.optional(Schema.String.check(Schema.isMaxCodePoints(1000))),
      model: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
    }),
  ).check(Schema.isMaxLength(20)),
});

/** Internal, location-scoped RPC. Checkout paths stay out of both HTTP APIs. */
export const fleetCrewStatusInputSchema = exactStruct({
  member: Schema.optional(agentIDSchema),
});
export const fleetCrewStatusSchema = z.strictObject({
  status: crewStatusSchema,
  metadata: legacySetting(metadata),
});
export type FleetCrewStatus = z.infer<typeof fleetCrewStatusSchema>;
