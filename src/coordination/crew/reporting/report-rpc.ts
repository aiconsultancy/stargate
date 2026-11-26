import { Rpc } from "@opencode/plugin/rpc";
import { Schema } from "effect";
import { activitySnapshotSchema } from "../../../chat/activity/activity";
import {
  crewStatusInputSchema,
  crewStatusSchema,
} from "../../../shared/crew-status";
import {
  cronEvaluateInputSchema,
  cronEvaluationSchema,
  cronModelInputSchema,
  cronModelSchema,
} from "../../../automation/cron/advanced";
import { maintenanceDrainSchema } from "../../../automation/maintenance/maintenance-drain";
import {
  quotaInputSchema,
  quotaObservationSchema,
  quotaSnapshotSchema,
} from "../../../backends/quota/quota";
import {
  exactStruct,
  historyChildrenInputSchema,
  historyDescribeInputSchema,
  historyEntriesInputSchema,
  historyEntryPageSchema,
  historySessionPageSchema,
  historySessionsSchema,
} from "../../../shared/session-history";
import {
  settingsPattern,
  settingsStruct,
} from "../../../config/settings-schema";
import { updateSnapshotSchema } from "../../../automation/maintenance/update-notice";
import {
  checkoutDiffInputSchema,
  checkoutDiffSchema,
  crewGitInputSchema,
  crewGitSchema,
  crewTurnsInputSchema,
  crewTurnsSchema,
  fleetCrewStatusInputSchema,
  fleetCrewStatusSchema,
} from "./fleet-status";
import { messagePortableSchema } from "../messaging/message-tool-input";

// Clients require Standard Schema definitions; OpenCode still decodes and
// Encodes these Effect codecs directly, without caller parse options.
const portable = Schema.toStandardSchemaV1;

const owner = settingsStruct({
  sessionID: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(100),
  ),
  id: Schema.String.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(100),
  ),
});

export const CrewReporting = Rpc.define({
  id: "stargate.crew.reporting",
  events: {},
  methods: {
    queueUpdateNotice: {
      input: portable(
        Schema.toStandardJSONSchemaV1(
          Schema.Struct({
            sessionID: Schema.String.check(
              Schema.isMinLength(1),
              Schema.isMaxLength(256),
            ),
            id: Schema.String.check(
              Schema.isMinLength(1),
              Schema.isMaxLength(256),
            ),
            text: Schema.String.check(Schema.isMaxLength(6000)),
          }),
        ),
      ),
      output: portable(
        Schema.toStandardJSONSchemaV1(
          Schema.Struct({ id: Schema.String, sessionID: Schema.String }),
        ),
      ),
    },
    updateTools: {
      input: Schema.toStandardSchemaV1(
        Schema.toStandardJSONSchemaV1(Schema.Struct({})),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.toStandardJSONSchemaV1(
          Schema.Record(Schema.String, Schema.String),
        ),
      ),
    },
    updateNotice: {
      input: Schema.toStandardSchemaV1(
        Schema.toStandardJSONSchemaV1(updateSnapshotSchema),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.toStandardJSONSchemaV1(
          Schema.Array(
            Schema.Struct({
              sessionID: Schema.String,
              status: Schema.Literals([
                "queued",
                "mail",
                "unchanged",
                "uncertain",
              ]),
            }),
          ),
        ),
      ),
    },
    // Passive: queues pin/crew contexts and Pi mail; never prompts or wakes.
    maintenanceNotice: {
      input: Schema.toStandardSchemaV1(
        Schema.toStandardJSONSchemaV1(maintenanceDrainSchema),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.toStandardJSONSchemaV1(
          Schema.Array(
            Schema.Struct({
              sessionID: Schema.String,
              status: Schema.Literals([
                "queued",
                "mail",
                "unchanged",
                "uncertain",
              ]),
            }),
          ),
        ),
      ),
    },
    // Starts only drain-queued crew tasks, through the existing promotion.
    resumeMaintenance: {
      input: Schema.toStandardSchemaV1(
        Schema.toStandardJSONSchemaV1(Schema.Struct({})),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.toStandardJSONSchemaV1(
          Schema.Struct({
            resumed: Schema.Finite.check(Schema.isInt()),
            remaining: Schema.Finite.check(Schema.isInt()),
          }),
        ),
      ),
    },
    quota: {
      input: portable(quotaInputSchema),
      output: portable(quotaSnapshotSchema),
    },
    cronQuota: {
      input: portable(quotaInputSchema),
      output: portable(quotaObservationSchema),
    },
    cronModel: {
      input: portable(cronModelInputSchema),
      output: portable(settingsStruct({ model: cronModelSchema })),
    },
    cronEvaluate: {
      input: portable(cronEvaluateInputSchema),
      output: portable(cronEvaluationSchema),
    },
    status: {
      input: portable(crewStatusInputSchema),
      output: portable(crewStatusSchema),
    },
    fleetStatus: {
      input: portable(fleetCrewStatusInputSchema),
      output: portable(fleetCrewStatusSchema),
    },
    // Read-only Git state, read as the captain who owns the worktrees.
    crewGit: {
      input: portable(crewGitInputSchema),
      output: portable(crewGitSchema),
    },
    // Read-only peer sessions and task inputs, to attribute crew turns.
    crewTurns: {
      input: portable(crewTurnsInputSchema),
      output: portable(crewTurnsSchema),
    },
    // Read-only crew diff of one configured worktree, read as the captain.
    checkoutDiff: {
      input: portable(checkoutDiffInputSchema),
      output: portable(checkoutDiffSchema),
    },
    // Read-only operator history. Roots list every provisioned crew member.
    // Describe, children and entries serve only this team's `pi:` sessions;
    // Callers read OpenCode sessions through the server API instead.
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
      input: messagePortableSchema(
        settingsStruct({
          sessionID: Schema.String.check(
            Schema.isMinCodePoints(1),
            Schema.isMaxCodePoints(100),
          ),
          requestID: Schema.String.check(
            Schema.isMinCodePoints(1),
            Schema.isMaxCodePoints(100),
          ),
          reporter: Schema.optional(
            Schema.String.check(settingsPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/)),
          ),
        }),
      ),
      output: messagePortableSchema(activitySnapshotSchema),
    },
    read: {
      input: messagePortableSchema(
        settingsStruct({
          ...owner.fields,
          passive: Schema.optional(Schema.Boolean),
        }),
      ),
      output: messagePortableSchema(activitySnapshotSchema),
    },
    finish: {
      input: messagePortableSchema(owner),
      output: messagePortableSchema(activitySnapshotSchema),
    },
    cancel: {
      input: messagePortableSchema(owner),
      output: messagePortableSchema(Schema.Boolean),
    },
  },
});
