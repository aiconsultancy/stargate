import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
import type { CrewEngine } from "./engine";
import { projectSelectionSchema } from "./project-options";
import {
  abandonInputSchema,
  inspectInputSchema,
  reconcileInputSchema,
} from "./reconciliation";
import { workspaceInputSchemas } from "./workspace";

export const recoveryRequestSchema = z.strictObject({
  sessionID: z.string().min(1).max(256),
  project: projectSelectionSchema.optional(),
  request: z.discriminatedUnion("op", [
    inspectInputSchema,
    reconcileInputSchema,
    abandonInputSchema,
    ...workspaceInputSchemas,
  ]),
});
export const CrewRecovery = Rpc.define({
  id: "stargate.crew.recovery",
  events: {},
  methods: {
    run: { input: recoveryRequestSchema, output: z.string() },
  },
});

/** Authenticated operator transport; engine validates the native root identity. */
export async function runRecoveryOperator(
  engine: CrewEngine,
  raw: unknown,
  signal: AbortSignal,
): Promise<string> {
  const input = recoveryRequestSchema.parse(raw);
  return JSON.stringify(
    await engine.run(input.request, {
      sessionID: input.sessionID,
      agent: engine.options.team.captain.id,
      signal,
    }),
  );
}
