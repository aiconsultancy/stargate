import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
import { activitySnapshotSchema } from "../activity";
import { crewStatusInputSchema, crewStatusSchema } from "../crew-status";
import { quotaInputSchema, quotaSnapshotSchema } from "../quota";

const owner = z.strictObject({
  sessionID: z.string().min(1).max(100),
  id: z.string().min(1).max(100),
});
export const CrewReporting = Rpc.define({
  id: "pogo.crew.reporting",
  events: {},
  methods: {
    quota: { input: quotaInputSchema, output: quotaSnapshotSchema },
    status: { input: crewStatusInputSchema, output: crewStatusSchema },
    start: {
      input: z.strictObject({
        sessionID: z.string().min(1).max(100),
        requestID: z.string().min(1).max(100),
        reporter: z
          .string()
          .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
          .optional(),
      }),
      output: activitySnapshotSchema,
    },
    read: {
      input: owner.extend({ passive: z.boolean().optional() }),
      output: activitySnapshotSchema,
    },
    finish: { input: owner, output: activitySnapshotSchema },
    cancel: { input: owner, output: z.boolean() },
  },
});
