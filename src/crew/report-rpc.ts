import { Rpc } from "@opencode/plugin/rpc";
import { Schema } from "effect";
import { z } from "zod";
import { activitySnapshotSchema } from "../activity";
import { crewStatusInputSchema, crewStatusSchema } from "../crew-status";
import { quotaInputSchema, quotaSnapshotSchema } from "../quota";
import {
  exactStruct,
  historyChildrenInputSchema,
  historyDescribeInputSchema,
  historyEntriesInputSchema,
  historyEntryPageSchema,
  historySessionPageSchema,
  historySessionsSchema,
} from "../session-history";

// Clients require Standard Schema definitions; OpenCode still decodes and
// encodes these Effect codecs directly, without caller parse options.
const portable = Schema.toStandardSchemaV1;
const owner = z.strictObject({
  sessionID: z.string().min(1).max(100),
  id: z.string().min(1).max(100),
});
export const CrewReporting = Rpc.define({
  id: "stargate.crew.reporting",
  events: {},
  methods: {
    quota: { input: quotaInputSchema, output: quotaSnapshotSchema },
    status: { input: crewStatusInputSchema, output: crewStatusSchema },
    // Read-only operator history. Roots list every provisioned crew member.
    // Describe, children and entries serve only this team's `pi:` sessions;
    // callers read OpenCode sessions through the server API instead.
    historyRoots: {
      input: portable(exactStruct({})),
      output: portable(historySessionsSchema),
    },
    historyDescribe: {
      input: portable(historyDescribeInputSchema),
      output: portable(historySessionsSchema),
    },
    historyChildren: {
      input: portable(historyChildrenInputSchema),
      output: portable(historySessionPageSchema),
    },
    historyEntries: {
      input: portable(historyEntriesInputSchema),
      output: portable(historyEntryPageSchema),
    },
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
