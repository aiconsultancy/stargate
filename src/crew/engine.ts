import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentGetInput,
  AgentInfo,
  OpenCodeClient,
  SessionCompactInput,
  SessionCreateInput,
  SessionGetInput,
  SessionInfo,
  SessionInterruptInput,
  SessionPromptInput,
  SessionSyntheticInput,
} from "@opencode/client";
import { Result, Schema } from "effect";
import { z } from "zod";
import type { CrewStatus, CrewStatusInput } from "../crew-status";
import { QuotaReader, quotaConfigSchema, quotaInputSchema } from "../quota";
import {
  noticeTools,
  scopedUpdate,
  type UpdateReceipt,
  type UpdateSnapshot,
} from "../update-notice";
import { CrewHistoryRPC } from "./history-rpc";
import { crewFingerprint } from "./identity";
import { CrewInspectionDelegation } from "./inspection-delegation";
import {
  type InspectionAudit,
  type InspectionBinding,
  InspectionDenied,
  inspectionGrantInputSchemas,
  type inspectionGrantView,
} from "./inspection-grants";
import { MesijClient, type MesijMessage } from "./mesij";
import { crewMessageMetadataKey, resumeMessageID } from "./message-protocol";
import { CrewMessaging, type MailRoute, mailInputSchema } from "./messaging";
import { readInputOrigin } from "./origin";
import { piCrewToolDefinitions } from "./pi-extension";

export { mailInputSchema } from "./messaging";

import { redactCredentials } from "../credentials";
import { journalInputSchema } from "./journal";
import { PiCrewWorkers, type PiWorkerFactory } from "./pi-worker";
import { crewPermissions } from "./policy";
import { projectsSchema } from "./project-options";
import {
  type AbandonInput,
  abandonInputSchema,
  type CrewInspectionAPI,
  type ExecutionInspection,
  type InspectInput,
  type InspectionConnector,
  idleBoundary,
  inspectInputSchema,
  observeExecution,
  observePlacement,
  type Placement,
  type ReconcileInput,
  type ResumeInput,
  reconcileInputSchema,
  requireQuiescent,
  resumeAdmitted,
  resumeInputSchema,
  sha256,
  verifyResult,
} from "./reconciliation";
import { CrewReporter } from "./reporting";
import { MissingTaskResult, type ResultAPI, readTaskResult } from "./result";
import {
  type AbandonableStatus,
  CrewError,
  type CrewID,
  type CrewNotice,
  CrewState,
  type CrewTask,
  type Peer,
  type TaskAbandonment,
  type TaskReconciliation,
  withdrawKey,
} from "./state";
import {
  agentIDSchema,
  type CrewMember,
  defaultTeam,
  teamSchema,
} from "./team";
import {
  inspectWorkspace,
  resetWorkspace,
  stashWorkspace,
  type WorkspaceCheckpoint,
  type WorkspaceInput,
  type WorkspaceInspection,
  workspaceInputSchemas,
  workspaceRoot,
} from "./workspace";

const decodeJournalInput = Schema.decodeUnknownResult(journalInputSchema, {
  onExcessProperty: "error",
});

const directory = z
  .string()
  .refine((value) => isAbsolute(value) && !value.includes("\0"));
export const crewOptionsSchema = z
  .strictObject({
    namespace: z.string().min(1).max(256),
    stateDirectory: directory,
    captainDirectory: directory,
    projectDirectory: directory,
    worktrees: z.record(agentIDSchema, directory),
    /** Additional configured repositories; omission preserves the existing team. */
    projects: projectsSchema.optional(),
    team: teamSchema.optional(),
    quota: quotaConfigSchema.optional(),
    cron: z
      .strictObject({
        configPath: directory,
        bot: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
      })
      .optional(),
    allowCrewExpansion: z.boolean().optional(),
    exclusiveWorkerInput: z.boolean().optional(),
    mesijCommand: directory,
    /** The one native captain root; earlier roots stay history. */
    captainSessionID: z
      .string()
      .max(256)
      .regex(/^ses_[A-Za-z0-9]+$/)
      .optional(),
  })
  .superRefine((options, context) => {
    const team = options.team ?? defaultTeam;
    const ids = team.crew.map(({ id }) => id);
    if (
      Object.keys(options.worktrees).length !== ids.length ||
      ids.some((id) => !Object.hasOwn(options.worktrees, id))
    )
      context.addIssue({
        code: "custom",
        message: "Worktrees must exactly match configured crew IDs.",
      });
    const paths = [
      options.captainDirectory,
      ...Object.values(options.worktrees),
    ].map((path) => resolve(path));
    for (const [index, path] of paths.entries()) {
      for (const other of paths.slice(index + 1)) {
        const nested = (a: string, b: string) => {
          const rel = relative(a, b);
          return (
            rel === "" ||
            (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
          );
        };
        if (nested(path, other) || nested(other, path))
          context.addIssue({
            code: "custom",
            message:
              "Captain and worker directories must be distinct and non-nested.",
          });
      }
    }
  });
export type CrewOptions = z.infer<typeof crewOptionsSchema>;
const taskID = z.string().startsWith("task_").max(100);
const text = z.string().min(1).max(64000);
export const crewInputSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("roster") }),
  inspectInputSchema,
  ...inspectionGrantInputSchemas,
  reconcileInputSchema,
  resumeInputSchema,
  abandonInputSchema,
  ...workspaceInputSchemas,
  z.strictObject({ op: z.literal("ensure"), crew: agentIDSchema.optional() }),
  z.strictObject({
    op: z.literal("dispatch"),
    crew: agentIDSchema,
    text,
    queue: z.boolean().default(false),
  }),
  z.strictObject({
    op: z.literal("wait"),
    taskID,
    afterNoticeID: z.number().int().nonnegative().default(0),
  }),
  z.strictObject({ op: z.literal("status"), taskID }),
  z.strictObject({ op: z.literal("complete"), taskID, result: text }),
  z.strictObject({ op: z.literal("compact"), crew: agentIDSchema }),
  z.strictObject({
    op: z.literal("urgent"),
    taskID,
    to: agentIDSchema,
    text,
  }),
]);
export type CrewInput = z.infer<typeof crewInputSchema>;
const legacyMailInputSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("inbox"),
    taskID,
    after: z.number().int().safe().nonnegative().optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
]);
const mailEnvelopeSchema = z.strictObject({
  namespace: z.string(),
  sourceTaskID: taskID,
  targetTaskID: taskID,
  originCaptainID: z.string(),
  sender: z.string(),
  recipient: z.string(),
  text,
  statusRequestID: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type CrewCaller = {
  sessionID: string;
  agent: string;
  signal: AbortSignal;
  id?: string;
  messageID?: string;
  /** Host-only native permission recheck before delegated data leaves the owner.
   * Pi uses its saved coding-enabled conversation binding, not this callback. */
  inspectionPermission?: (resource: string) => Promise<void>;
  [piIdentity]?: true;
  /** Set by `authorizeMail`: the crew member a bound IRC session serves. */
  [ircIdentity]?: string;
};
export type CrewSession = Pick<
  SessionInfo,
  "id" | "parentID" | "agent" | "location" | "metadata" | "outcome" | "model"
> & {
  permissions?: unknown;
  time?: Pick<SessionInfo["time"], "updated" | "busy" | "idle">;
};
export type WorkerModelPeer = Peer & Pick<CrewSession, "model">;
export type ResultConnector = (
  session: CrewSession,
  signal: AbortSignal,
) => Promise<ResultAPI>;
/** Trusted owner injection only. Must evaluate effective issuer permission
 * read-only, including policies/hooks; never assert as a foreign tool caller.
 * SDK 2.2.7 has no such API, so the plugin does not supply this proof. */
export type InspectionIssuerPermission = (
  issuerSessionID: string,
  signal: AbortSignal,
) => Promise<void>;
type RequestOptions = NonNullable<
  Parameters<OpenCodeClient["session"]["get"]>[1]
>;
// Narrow SDK boundary keeps tests local and avoids fabricating full SDK objects.
export interface CrewSessions {
  get(input: SessionGetInput, request?: RequestOptions): Promise<CrewSession>;
  create(
    input: SessionCreateInput,
    request?: RequestOptions,
  ): Promise<CrewSession>;
  prompt(
    input: SessionPromptInput,
    request?: RequestOptions,
  ): Promise<{ id: string; sessionID: string }>;
  synthetic(
    input: SessionSyntheticInput,
    request?: RequestOptions,
  ): Promise<unknown>;
  compact(
    input: SessionCompactInput,
    request?: RequestOptions,
  ): Promise<unknown>;
  wait(input: SessionGetInput, request?: RequestOptions): Promise<void>;
  interrupt(
    input: SessionInterruptInput,
    request?: RequestOptions,
  ): Promise<unknown>;
}
export interface CrewAgents {
  get(
    input: AgentGetInput,
    request?: RequestOptions,
  ): Promise<{
    data: Pick<AgentInfo, "mode" | "model">;
  }>;
}
export type CrewResult = {
  status: string;
  grant?: ReturnType<typeof inspectionGrantView>;
  grants?: ReturnType<typeof inspectionGrantView>[];
  audit?: InspectionAudit[];
  nextAfter?: number;
  inspection?: {
    crew: string;
    taskID: string;
    taskStatus: CrewTask["status"];
    execution: { state: "running" | "idle" | "unknown" };
  };
  diagnostic?: string;
  peers?: Peer[];
  task?: CrewTask;
  notices?: CrewNotice[];
  members?: ReturnType<CrewEngine["roster"]>;
  active?: TaskInspection | null;
  inspectedTask?: TaskInspection | null;
  queued?: TaskInspection[];
  controlled?: boolean;
  /** sha256 of a held control token; pass to abandon only for a crash orphan. */
  controlID?: string | null;
  execution?:
    | ExecutionInspection
    | { state: "idle" | "running"; backend: "pi" }
    | { state: "unknown" };
  reconciliation?: TaskReconciliation | null;
  abandonment?: TaskAbandonment | null;
  statusRequest?: { id: string; sequence: number };
  workspace?: WorkspaceInspection;
  slot?: {
    taskID: string | null;
    status: CrewTask["status"] | null;
    controlled: boolean;
    queued: number;
  };
  checkpoint?: WorkspaceCheckpoint | null;
  executionConfirmed?: boolean;
};
type TaskInspection = Omit<CrewTask, "result"> & { hasResult: boolean };

function inspectTask(task: CrewTask): TaskInspection {
  const { result, ...metadata } = task;
  return { ...metadata, hasResult: result !== null };
}

function notFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "Session.NotFoundError"
  );
}

async function physicalDirectory(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw new CrewError(
        "Cannot verify crew directory separation. Check directory access and symbolic links.",
      );
    return join(await physicalDirectory(dirname(path)), basename(path));
  }
}

// Locations share the same worker slots. Join an in-flight report admission
// rather than racing Pi's durable conversation-creation reservation.
const reportAdmissions = new Map<string, Promise<void>>();
const piIdentity = Symbol("host-bound Pi caller");
const ircIdentity = Symbol("Stargate-bound IRC session");
// greybeard: cooperative 60s observation, not a turn/fairness guarantee. Native
// admission/read calls can overrun; add turn-aware yielding only when required.
const crewWaitWindowMs = 60_000;
/** Internal timing injection, never operator/team configuration. */
export type CrewWaitOptions = {
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  windowMs?: number;
  /** Test clock for capability expiry; never a configurable grant lifetime. */
  inspectionNow?: () => number;
};

export class CrewEngine {
  readonly inspectionDelegation: CrewInspectionDelegation;
  readonly quotas: QuotaReader;
  private readonly pi: PiCrewWorkers;
  readonly reporting: CrewReporter;
  readonly history: CrewHistoryRPC;
  private closing?: Promise<void>;
  private readonly waitNow: () => number;
  private readonly waitPoll: NonNullable<CrewWaitOptions["wait"]>;
  private readonly waitWindowMs: number;
  private constructor(
    readonly options: CrewOptions & { team: NonNullable<CrewOptions["team"]> },
    readonly state: CrewState,
    private readonly sessions: CrewSessions,
    private readonly mailer: Pick<MesijClient, "register" | "send" | "inbox">,
    private readonly agents?: CrewAgents,
    piFactory?: PiWorkerFactory,
    private readonly inspectionConnector?: InspectionConnector,
    private readonly connectResults?: ResultConnector,
    waitOptions: CrewWaitOptions = {},
    private readonly inspectionIssuerPermission?: InspectionIssuerPermission,
  ) {
    this.inspectionDelegation = new CrewInspectionDelegation(
      this,
      waitOptions.inspectionNow,
    );
    this.quotas = new QuotaReader(options.quota);
    this.waitNow = waitOptions.now ?? (() => performance.now());
    this.waitPoll =
      waitOptions.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
    this.waitWindowMs = waitOptions.windowMs ?? crewWaitWindowMs;
    this.pi = new PiCrewWorkers(
      state,
      options.stateDirectory,
      piFactory,
      undefined,
      (member) => {
        const authorize = (conversationID: string) => {
          const peer = state.peer(member.id);
          if (
            !peer ||
            member.backend?.tools !== "coding" ||
            state.piPeer(peer.sessionID)?.conversationID !== conversationID
          )
            throw new CrewError(
              "Pi tools require this member's saved conversation.",
            );
          return peer;
        };
        return {
          authorize,
          run: async (name, input, conversationID, id, signal) => {
            const peer = authorize(conversationID);
            const caller: CrewCaller = {
              sessionID: peer.sessionID,
              agent: member.id,
              id,
              signal,
              [piIdentity]: true,
            };
            if (name === "stargate_journal") return this.journal(input, caller);
            if (name === "stargate_mail") return this.mail(input, caller);
            if (name === "stargate_dm") return this.dm(input, caller);
            if (name === "stargate_quota") return this.quota(input, caller);
            return this.run(input, caller);
          },
        };
      },
      options.captainDirectory,
    );
    state.reporting.configureNames([
      options.team.captain,
      ...options.team.crew,
    ]);
    this.reporting = new CrewReporter(this);
    this.history = new CrewHistoryRPC(options.team, state, this.pi);
  }

  /** Location-authorized read surface. Unlike tool status, never reconciles,
   * promotes queued work, provisions peers, reads transcripts or invokes models.
   */
  status(
    input: CrewStatusInput,
    options: { aggregate: true },
  ): CrewStatus & { busy: number };
  status(input?: CrewStatusInput): CrewStatus;
  status(
    input: CrewStatusInput = {},
    options?: { aggregate: true },
  ): CrewStatus {
    const members = this.options.team.crew.filter(
      ({ id }) => !input.member || input.member === id,
    );
    // Aggregate callers need every active task, before either engine or router
    // pagination. Reuse that one snapshot for the visible rows as well.
    const tasks = new Map(
      members
        .slice(0, options?.aggregate ? members.length : 20)
        .map((member) => [member.id, this.state.activeTask(member.id)]),
    );
    return {
      members: members.slice(0, 20).map((member) => {
        const peer = this.state.peer(member.id);
        const task = tasks.get(member.id);
        const current = task && task.status !== "completed" ? task : null;
        return {
          id: member.id,
          name: redactCredentials(member.name ?? member.id, 100),
          backend: member.backend ? "pi-durable" : "opencode",
          provisioned: peer?.status ?? "unprovisioned",
          observed: !!current && !!member.backend && this.pi.observed(current),
          current: current ? this.state.activity.task(current) : null,
          ...this.state.activity.read(member.id),
        };
      }),
      total: members.length,
      truncated: members.length > 20,
      ...(options?.aggregate
        ? {
            busy: [...tasks.values()].filter(
              (task) => task && task.status !== "completed",
            ).length,
          }
        : {}),
    };
  }

  async quota(input: unknown, caller: CrewCaller) {
    await this.authorize(caller);
    if (!quotaInputSchema.safeParse(input).success)
      throw new CrewError(
        "Quota accepts no URL, credentials or other arguments.",
      );
    return this.quotas.read(caller.signal);
  }

  static async open(
    input: unknown,
    sessions: CrewSessions,
    mailer?: Pick<MesijClient, "register" | "send" | "inbox">,
    agents?: CrewAgents,
    piFactory?: PiWorkerFactory,
    inspectionConnector?: InspectionConnector,
    connectResults?: ResultConnector,
    waitOptions: CrewWaitOptions = {},
    inspectionIssuerPermission?: InspectionIssuerPermission,
  ) {
    const parsed = crewOptionsSchema.safeParse(input);
    if (!parsed.success)
      throw new CrewError(
        "Invalid crew plugin options. Supply exact configured crew worktrees and distinct, non-nested absolute captain/worker directories.",
      );
    const options = { ...parsed.data, team: parsed.data.team ?? defaultTeam };
    // Missing worktrees are permitted, but existing symlink ancestors must not
    // collapse separate configured paths into the same configuration tree.
    const physicalCaptain = await physicalDirectory(
      resolve(options.captainDirectory),
    );
    const physicalWorktrees = Object.fromEntries(
      await Promise.all(
        Object.entries(options.worktrees).map(async ([id, path]) => [
          id,
          await physicalDirectory(resolve(path)),
        ]),
      ),
    );
    if (
      !crewOptionsSchema.safeParse({
        ...options,
        captainDirectory: physicalCaptain,
        worktrees: physicalWorktrees,
      }).success
    )
      throw new CrewError(
        "Captain and worker directories must be distinct and non-nested, including symbolic links.",
      );
    const legacyFingerprint = JSON.stringify([
      options.namespace,
      resolve(options.projectDirectory),
      resolve(options.captainDirectory),
      ...defaultTeam.crew.map(({ id }) =>
        resolve(options.worktrees[id] ?? "/"),
      ),
    ]);
    const fingerprint = crewFingerprint(options);
    const legacyCompatible =
      options.team.captain.id === defaultTeam.captain.id &&
      options.team.crew.length === defaultTeam.crew.length &&
      defaultTeam.crew.every((old) =>
        options.team.crew.some(
          (member) =>
            member.id === old.id &&
            member.permissionProfile === old.permissionProfile,
        ),
      );
    const state = await CrewState.open(
      options.stateDirectory,
      options.namespace,
      fingerprint,
      legacyCompatible ? legacyFingerprint : undefined,
      options.allowCrewExpansion,
      options.captainSessionID,
    );
    return new CrewEngine(
      options,
      state,
      sessions,
      mailer ??
        new MesijClient({
          command: options.mesijCommand,
          projectDirectory: options.projectDirectory,
          dataDirectory: join(
            options.stateDirectory,
            "mesij",
            createHash("sha256").update(options.namespace).digest("hex"),
          ),
        }),
      agents,
      piFactory,
      inspectionConnector,
      connectResults,
      waitOptions,
      inspectionIssuerPermission,
    );
  }

  private actor(sessionID: string): string {
    const irc = this.state.ircSessions.crewID(sessionID);
    const role =
      this.state.peerBySession(sessionID)?.crewID ??
      (irc
        ? `${irc}@irc:${sessionID}`
        : `${this.options.team.captain.id}:${sessionID}`);
    const namespace = createHash("sha256")
      .update(this.options.namespace)
      .digest("hex");
    return `stargate:${namespace}:${role}`;
  }

  mailActor(sessionID: string) {
    return this.actor(sessionID);
  }

  /** Passive ready-state information only: never provision, promote or notify a worker. */
  async updateNotice(
    snapshot: UpdateSnapshot,
    tools: Record<string, string>,
    signal: AbortSignal,
  ): Promise<UpdateReceipt[]> {
    const captain = this.options.captainSessionID;
    if (!captain) return [];
    const receipts: UpdateReceipt[] = [];
    for (const member of this.options.team.crew) {
      signal.throwIfAborted();
      const peer = this.state.peer(member.id);
      if (peer?.status !== "ready") continue;
      try {
        let effective: unknown;
        if (member.backend)
          effective = {
            model: member.backend.model,
            permissions: member.permissionProfile,
            tools: member.backend.tools,
          };
        else {
          const session = await this.sessions.get(
            { sessionID: peer.sessionID },
            { signal },
          );
          if (
            session.agent !== (member.agent ?? member.id) ||
            session.location.directory !== this.options.worktrees[member.id]
          )
            throw new Error("Wrong crew session");
          effective = {
            model: session.model,
            permissions: session.permissions,
          };
        }
        const selectedTools = member.backend
          ? noticeTools(
              member.backend.tools === "coding"
                ? piCrewToolDefinitions().map((tool) => ({
                    id: tool.name,
                    description: tool.description,
                    input: tool.schema,
                  }))
                : [],
            )
          : tools;
        const next = scopedUpdate(snapshot, selectedTools, effective);
        receipts.push(
          await this.state.updateNotices.deliver(
            peer.sessionID,
            next,
            member.backend ? "mail" : "queued",
            async (id, text) => {
              if (member.backend) {
                const receipt = await this.mail(
                  { op: "send", to: member.id, text, key: id },
                  {
                    sessionID: captain,
                    agent:
                      this.options.team.captain.agent ??
                      this.options.team.captain.id,
                    signal,
                  },
                );
                Schema.decodeUnknownSync(
                  Schema.Struct({ stored: Schema.Literal(true) }),
                )(receipt);
              } else
                this.state.updateNotices.queueContext(
                  peer.sessionID,
                  id,
                  this.options.namespace,
                );
            },
            this.options.namespace,
          ),
        );
      } catch {
        receipts.push({ sessionID: peer.sessionID, status: "uncertain" });
      }
    }
    return receipts;
  }

  /** Consume only for this roster's native worker, at an already-running model context boundary. */
  updateNoticeContext(
    sessionID: string,
    agent: string,
    system: { type: "text"; text: string }[],
  ) {
    if (
      agent ===
        (this.options.team.captain.agent ?? this.options.team.captain.id) &&
      !this.state.peerBySession(sessionID)
    ) {
      this.state.updateNotices.consumeContext(
        sessionID,
        this.options.namespace,
        (text) => system.push({ type: "text", text }),
      );
      return;
    }
    const peer = this.state.peerBySession(sessionID);
    const member = this.options.team.crew.find(
      (member) => member.id === peer?.crewID,
    );
    if (
      peer?.status !== "ready" ||
      !member ||
      member.backend ||
      agent !== (member.agent ?? member.id)
    )
      return;
    this.state.updateNotices.consumeContext(
      sessionID,
      this.options.namespace,
      (text) => system.push({ type: "text", text }),
    );
  }

  async queueCaptainNotice(
    input: { sessionID: string; id: string; text: string },
    signal: AbortSignal,
  ) {
    const session = await this.sessions.get(
      { sessionID: input.sessionID },
      { signal },
    );
    if (
      session.id !== input.sessionID ||
      session.agent !==
        (this.options.team.captain.agent ?? this.options.team.captain.id) ||
      session.location.directory !== this.options.captainDirectory ||
      this.state.peerBySession(session.id)
    )
      throw new Error("Update notice captain identity changed");
    this.state.updateNotices.queueExternalContext(
      session.id,
      input.id,
      input.text,
      this.options.namespace,
    );
    return { id: input.id, sessionID: session.id };
  }

  /** Same captain context: equal IDs, or both lineage of the pinned root. */
  sameCaptain(stored: string | undefined, captainID: string): boolean {
    return (
      stored === captainID ||
      (stored !== undefined &&
        this.state.captainLineage(stored) &&
        this.state.captainLineage(captainID))
    );
  }

  /** Authority: only an authenticated pinned root inherits earlier roots. */
  private ownsCaptainLineage(stored: string, caller: CrewCaller): boolean {
    return (
      stored === caller.sessionID ||
      (caller.agent === this.options.team.captain.id &&
        caller.sessionID === this.options.captainSessionID &&
        this.state.captainLineage(stored))
    );
  }

  /** Stored origin for state guards when this captain owns the task. */
  private captainOrigin(task: CrewTask, caller: CrewCaller): string {
    return this.ownsCaptainLineage(task.originCaptainID, caller)
      ? task.originCaptainID
      : caller.sessionID;
  }

  mailTask(
    caller: CrewCaller,
    id?: string,
    historical = false,
  ): CrewTask | null {
    // An IRC session never has a task, not even its member's current one.
    if (caller[ircIdentity]) {
      if (id)
        throw new CrewError("IRC sessions have no task context; omit taskID.");
      return null;
    }
    const task = id
      ? caller.agent === this.options.team.captain.id
        ? historical && this.state.requestedStatus(id, caller.sessionID)
          ? this.state.task(id)
          : this.ownedCaptainTask(id, caller)
        : this.ownedWorkerTask(id, caller)
      : this.state.activeTask(caller.agent);
    if (task && ["dispatching", "running", "cancelling"].includes(task.status))
      return task;
    if (id && historical) return task;
    if (id)
      throw new CrewError(
        "Mail send requires a current task or a validated reply; this task is no longer current.",
      );
    return null;
  }

  /** Installed inspect receipts authorize only exact status replies, not work. */
  statusRequestRoute(id: string): MailRoute | null {
    const request = this.state.statusRequest(id);
    const task = request && this.state.task(request.taskID);
    if (
      !request ||
      request.receiptID !== id ||
      !task ||
      task.workerSessionID !== request.workerSessionID
    )
      return null;
    return {
      id,
      sender: request.captainID,
      recipient: request.workerSessionID,
      captainID: request.captainID,
      sourceTaskID: task.id,
      targetTaskID: task.id,
    };
  }

  /** Read installed status envelopes without a second mail store or new aliases. */
  legacyStatusRoute(event: MesijMessage): MailRoute | null {
    let value: unknown;
    try {
      value = JSON.parse(event.text);
    } catch {
      return null;
    }
    const envelope = mailEnvelopeSchema.safeParse(value);
    if (!envelope.success || !envelope.data.statusRequestID) return null;
    const mail = envelope.data;
    const request = this.state.statusRequest(envelope.data.statusRequestID);
    const route = request?.receiptID
      ? this.statusRequestRoute(request.receiptID)
      : null;
    const task = request && this.state.task(request.taskID);
    if (
      !route ||
      !task ||
      mail.namespace !== this.options.namespace ||
      mail.sourceTaskID !== task.id ||
      mail.targetTaskID !== task.id ||
      mail.originCaptainID !== task.originCaptainID ||
      mail.sender !== event.sessionID ||
      mail.recipient !== event.to ||
      event.actor !== this.actor(mail.sender)
    )
      return null;
    if (
      event.id === route.id &&
      mail.sender === route.sender &&
      mail.recipient === route.recipient
    )
      return route;
    if (
      event.replyTo === route.id &&
      mail.sender === route.recipient &&
      mail.recipient === route.sender
    )
      return {
        ...route,
        id: event.id,
        sender: mail.sender,
        recipient: mail.recipient,
      };
    return null;
  }

  async mail(raw: unknown, caller: CrewCaller) {
    caller = this.logicalCaller(caller);
    const input = mailInputSchema.safeParse(raw);
    if (!input.success) throw new CrewError("Invalid stargate_mail input.");
    const result = await this.message(raw, caller, false);
    if (input.data.op !== "inbox" || !input.data.taskID) return result;
    // Keep pre-upgrade task envelopes readable without rewriting Mesij history.
    const legacy = await this.legacyMail(input.data, caller);
    if (!("messages" in result) || !("messages" in legacy)) return result;
    const messages = [
      ...(result.messages ?? []),
      ...legacy.messages.filter(
        (message) =>
          !(result.messages ?? []).some((current) => current.id === message.id),
      ),
    ].sort((a, b) => a.sequence - b.sequence);
    return {
      ...result,
      messages,
      nextAfter: Math.max(
        "nextAfter" in result ? (result.nextAfter ?? 0) : 0,
        legacy.nextAfter ?? 0,
      ),
    };
  }

  async dm(raw: unknown, caller: CrewCaller) {
    return this.message(raw, this.logicalCaller(caller), true);
  }

  private async message(raw: unknown, caller: CrewCaller, direct: boolean) {
    try {
      return await new CrewMessaging(this, this.mailer).run(
        raw,
        caller,
        direct,
      );
    } catch (error) {
      if (error instanceof CrewError) throw error;
      throw new CrewError(
        "Mail admission unconfirmed. Retry only the same key; raw details withheld.",
      );
    }
  }

  async notifyMail(
    route: MailRoute,
    caller: CrewCaller,
    text: string,
    delivery: "steer" | "queue",
  ): Promise<string> {
    // A reply to an IRC session waits in its inbox: nothing prompts it.
    if (this.state.ircSessions.crewID(route.recipient)) return "inbox";
    const peer = this.state.peerBySession(route.recipient);
    const task = peer ? this.state.activeTask(peer.crewID) : null;
    const busy =
      task && ["running", "dispatching"].includes(task.status) ? task : null;
    if (peer?.status !== "ready" && peer) return "unavailable";
    if (
      peer &&
      (this.state.controlled(peer.crewID) ||
        (task &&
          ((task.status !== "completed" &&
            !this.sameCaptain(task.originCaptainID, route.captainID)) ||
            !["running", "dispatching", "completed"].includes(task.status) ||
            task.notifying)))
    )
      return "deferred";
    const senderCaptainID =
      caller.agent === this.options.team.captain.id
        ? caller.sessionID
        : caller[ircIdentity]
          ? this.options.captainSessionID
          : this.mailTask(caller)?.originCaptainID;
    if (busy && !this.sameCaptain(senderCaptainID, route.captainID))
      return "deferred";
    // A DM captured for an occupied task must not turn into a free-worker
    // wake if status/wait collected it while Mesij was storing the message.
    // sourceTaskID belongs to the sender, not this worker's assignment.
    if (
      peer &&
      route.targetTaskID &&
      (route.targetTaskID !== task?.id || task.status === "completed")
    )
      return "inbox";
    if (busy && delivery === "queue" && !this.member(busy.crewID).backend)
      return "unsupported";
    const framing = `Stargate DM ${route.id} from ${caller.agent}.\n${text}\n\nReply through stargate_mail or stargate_dm with replyTo=${route.id}; a final answer is not a peer reply.${busy ? ` Your final answer remains task ${busy.id}'s result; restate it if you had already finished.` : ""}`;
    let originInputID: string | null = null;
    if (!peer && route.sourceTaskID) {
      const source = this.state.task(route.sourceTaskID);
      if (source && this.sameCaptain(source.originCaptainID, route.recipient))
        this.state.noticeOnce(route.id, source.id, framing);
      // A pin can inherit old task authority, never its native input namespace.
      if (source?.originCaptainID === route.recipient)
        originInputID = source.originInputID;
    }
    if (busy && !this.state.beginNotify(busy.id)) return "deferred";
    let control: string | undefined;
    try {
      if (peer && !busy) {
        control = this.state.reserveControl(peer.crewID);
        if (!(await this.idle(peer, caller.signal))) return "deferred";
      }
      if (peer && !this.member(peer.crewID).backend)
        this.validPeer(
          await this.sessions.get(
            { sessionID: peer.sessionID },
            { signal: caller.signal },
          ),
          peer,
        );
      if (peer && busy) {
        // Do not append input after an ended, uncollected task turn. Leave
        // mail durable; status/wait owns canonical retained-answer recovery.
        // Idle alone is not evidence of a successful task result.
        if (await this.idle(peer, caller.signal)) return "inbox";
        caller.signal.throwIfAborted();
        const current = this.state.task(busy.id);
        if (current?.status === "completed") return "inbox";
        if (!current || !["running", "dispatching"].includes(current.status))
          return "deferred";
      }
      if (peer && this.member(peer.crewID).backend) {
        return await this.pi.notify(
          this.member(peer.crewID),
          this.options.worktrees[peer.crewID] ?? "",
          peer,
          route.id,
          framing,
          delivery,
          caller.signal,
        );
      }
      await this.sessions.synthetic(
        {
          sessionID: route.recipient,
          id: `msg_${route.id}`,
          text: framing,
          description: "Crew direct message",
          metadata: {
            [crewMessageMetadataKey]: {
              ...(busy ? { taskID: busy.id } : {}),
              ...(route.sourceTaskID
                ? { sourceTaskID: route.sourceTaskID }
                : {}),
              originCaptainID: route.captainID,
              ...(originInputID ? { originInputID } : {}),
              messageID: route.id,
            },
          },
          delivery: peer ? delivery : "queue",
          resume: !busy,
        },
        { signal: caller.signal },
      );
      return "accepted";
    } catch {
      return "uncertain";
    } finally {
      if (busy) this.state.endNotify(busy.id);
      if (peer && control) this.state.releaseControl(peer.crewID, control);
    }
  }

  roster() {
    return [this.options.team.captain, ...this.options.team.crew].map(
      (member) => {
        const worker = this.options.team.crew.find(
          ({ id }) => id === member.id,
        );
        const supported = !worker?.backend || worker.backend.tools === "coding";
        return {
          id: member.id,
          name: member.name ?? member.id,
          role: worker?.role ?? "Captain and coordinator",
          aliases: worker ? [] : ["captain"],
          backend: worker?.backend ? "pi-durable" : "opencode",
          mail: supported,
          dm: supported ? ["steer", "queue"] : [],
          busyQueue: !!worker?.backend && supported,
        };
      },
    );
  }

  logicalCaller(caller: CrewCaller): CrewCaller {
    const captain = this.options.team.captain;
    if (caller.agent === (captain.agent ?? captain.id))
      return { ...caller, agent: captain.id };
    const member = this.options.team.crew.find(
      (member) => caller.agent === (member.agent ?? member.id),
    );
    return member ? { ...caller, agent: member.id } : caller;
  }

  async journal(raw: unknown, caller: CrewCaller) {
    caller = this.logicalCaller(caller);
    const input = decodeJournalInput(raw);
    if (Result.isFailure(input))
      throw new CrewError("Invalid stargate_journal input.");
    await this.authorize(caller);
    const task = this.mailTask(caller);
    const captainID =
      caller.agent === this.options.team.captain.id
        ? caller.sessionID
        : (task?.originCaptainID ?? "");
    const store = this.state.reporting.journal;
    // A pinned team has one captain; its lineage shares one journal context.
    const lineage = this.state.captainLineage(captainID);
    if (input.success.op === "read")
      return {
        ...store.read(
          lineage ? null : captainID,
          input.success.after,
          input.success.limit,
          captainID ? input.success.member : caller.agent,
        ),
        entry: undefined,
      };
    if (!caller.id)
      throw new CrewError("Journal append requires a host tool-call identity.");
    const entry = store.append(
      {
        member: caller.agent,
        captainID: this.state.captainRoute(captainID),
        taskID: task?.id ?? null,
        kind: "note",
        text: input.success.text,
      },
      `${caller.sessionID}:${caller.id}`,
    );
    return { entry, entries: [entry], nextAfter: entry.id, truncated: false };
  }

  private async legacyMail(raw: unknown, caller: CrewCaller) {
    const parsed = legacyMailInputSchema.safeParse(raw);
    if (!parsed.success)
      throw new CrewError(
        "Invalid stargate_mail input. Supply a task ID and the operation's declared fields.",
      );
    const input = parsed.data;
    try {
      await this.authorize(caller);
      let source: CrewTask;
      if (caller.agent === this.options.team.captain.id) {
        await this.captain(caller);
        const requested = this.state.task(input.taskID);
        source =
          input.op === "inbox" &&
          requested &&
          this.state.requestedStatus(requested.id, caller.sessionID)
            ? requested
            : this.ownedCaptainTask(input.taskID, caller);
      } else source = this.ownedWorkerTask(input.taskID, caller);
      this.member(source.crewID);
      if (source.status === "queued" || source.status === "cancelled")
        throw new CrewError(
          "Queued or cancelled work has no active mail lineage.",
        );
      const actor = this.actor(caller.sessionID);
      await this.mailer.register(actor, caller.sessionID, caller.signal);
      const after = this.state.mailCursor(
        caller.sessionID,
        source.id,
        input.after,
      );
      const events = await this.mailer.inbox(
        { sessionID: caller.sessionID, after, limit: input.limit },
        caller.signal,
      );
      const messages: {
        id: string;
        sequence: number;
        from: string;
        text: string;
        sourceTaskID: string;
      }[] = [];
      for (const event of events) {
        if (event.to !== caller.sessionID) continue; // Mesij also returns sent/mentioned messages.
        let value: unknown;
        try {
          value = JSON.parse(event.text);
        } catch {
          continue;
        }
        const envelope = mailEnvelopeSchema.safeParse(value);
        if (!envelope.success) continue;
        const mail = envelope.data;
        const origin = this.state.task(mail.sourceTaskID);
        const statusRequest = mail.statusRequestID
          ? this.state.statusRequest(mail.statusRequestID)
          : null;
        const statusLineage =
          statusRequest?.taskID === source.id &&
          statusRequest.workerSessionID === source.workerSessionID &&
          ((mail.sender === statusRequest.captainID &&
            mail.recipient === statusRequest.workerSessionID) ||
            (mail.sender === statusRequest.workerSessionID &&
              mail.recipient === statusRequest.captainID));
        if (
          !origin ||
          mail.namespace !== this.options.namespace ||
          mail.originCaptainID !== source.originCaptainID ||
          origin.originCaptainID !== source.originCaptainID ||
          mail.targetTaskID !== source.id ||
          mail.recipient !== caller.sessionID ||
          mail.sender !== event.sessionID ||
          event.actor !== this.actor(mail.sender) ||
          (!this.ownsCaptainLineage(source.originCaptainID, caller) &&
            caller.agent === this.options.team.captain.id &&
            !statusLineage) ||
          (mail.sender !== origin.originCaptainID &&
            mail.sender !== origin.workerSessionID &&
            !statusLineage)
        )
          continue;
        messages.push({
          id: event.id,
          sequence: event.sequence,
          from:
            this.state.peerBySession(mail.sender)?.crewID ??
            this.options.team.captain.id,
          text: mail.text,
          sourceTaskID: origin.id,
        });
      }
      // Explicit after acknowledges the prior page. A lost response can be read again.
      return {
        status: "inbox",
        messages,
        nextAfter: events.at(-1)?.sequence ?? after,
      };
    } catch (error) {
      if (error instanceof CrewError) throw error;
      throw new CrewError(
        "Mesij operation unavailable or unconfirmed. Retry sends with the same key; raw details withheld.",
      );
    }
  }

  async run(raw: unknown, caller: CrewCaller): Promise<CrewResult> {
    caller = this.logicalCaller(caller);
    const parsed = crewInputSchema.safeParse(raw);
    if (!parsed.success) {
      this.inspectionDelegation.denied(raw, caller, "invalid-input");
      throw new CrewError(
        "Invalid stargate_crew input. Use the operation's declared fields.",
      );
    }
    const input = parsed.data;
    if (
      input.op === "grant-inspect" ||
      input.op === "list-inspect-grants" ||
      input.op === "revoke-inspect" ||
      input.op === "audit-inspect-grant" ||
      (input.op === "inspect" && input.grantID)
    )
      return this.inspectionDelegation.run(input, caller);
    const deadline =
      input.op === "wait" ? this.waitNow() + this.waitWindowMs : 0;
    let authorized = false;
    try {
      await this.authorize(
        input.op === "wait" && caller.signal.aborted
          ? { ...caller, signal: AbortSignal.timeout(5000) }
          : caller,
      );
      authorized = true;
      if (input.op === "roster")
        return { status: "roster", members: this.roster() };
      if ("crew" in input && input.crew) this.member(input.crew);
      if (
        input.op === "urgent" &&
        input.to !== "captain" &&
        input.to !== this.options.team.captain.id
      )
        this.member(input.to);
      if (input.op === "complete") {
        const task = this.ownedWorkerTask(input.taskID, caller);
        this.state.complete(task.id, caller.sessionID, input.result);
        return { status: "completed" };
      }
      if (input.op === "urgent") return await this.urgent(input, caller);
      if (
        input.op === "status" &&
        caller.agent !== this.options.team.captain.id
      ) {
        const task = this.ownedWorkerTask(input.taskID, caller);
        return {
          status: task.status,
          task,
          notices: this.state.notices(task.id, 0),
        };
      }
      await this.captain(caller);
      if (input.op === "inspect") return await this.inspect(input, caller);
      if (input.op === "reconcile") return await this.reconcile(input, caller);
      if (input.op === "resume") return await this.resume(input, caller);
      if (input.op === "abandon") return await this.abandon(input, caller);
      if (
        input.op === "workspace" ||
        input.op === "stash" ||
        input.op === "reset"
      )
        return await this.workspace(input, caller);
      if (input.op === "ensure") {
        const peers: Peer[] = [];
        for (const id of input.crew
          ? [input.crew]
          : this.options.team.crew.map(({ id }) => id))
          peers.push(await this.ensure(id, caller.signal));
        return { status: "ready", peers };
      }
      if (input.op === "dispatch") return await this.dispatch(input, caller);
      if (input.op === "compact") {
        await this.withWorkerControl(input.crew, caller, (peer) =>
          this.sessions.compact(
            { sessionID: peer.sessionID, delivery: "steer" },
            { signal: caller.signal },
          ),
        );
        return { status: "compaction-admitted" };
      }
      let task = this.ownedCaptainTask(input.taskID, caller);
      if (input.op === "wait") caller.signal.throwIfAborted();
      const abandoned = this.abandoned(
        task,
        input.op === "wait" ? input.afterNoticeID : 0,
      );
      if (abandoned) return abandoned;
      if (input.op === "status") {
        if (task.status === "queued") task = await this.promote(task, caller);
        await this.observeResumeReceipts(task, caller);
        const recovered = await this.reconcileResult(task, caller);
        return {
          status: recovered.task.status,
          ...recovered,
          notices: this.state.notices(task.id, 0),
        };
      }
      return await this.wait(task, input.afterNoticeID, caller, deadline);
    } catch (error) {
      if (
        input.op === "wait" &&
        authorized &&
        caller.agent === this.options.team.captain.id &&
        caller.signal.aborted
      ) {
        const task = this.ownedCaptainTask(input.taskID, caller);
        await this.cancel(task, caller);
        throw new CrewError(this.cancelled(task.id));
      }
      if (error instanceof CrewError) throw error;
      throw new CrewError(
        "Crew operation unavailable. Inspect OpenCode and crew state; raw SDK details withheld.",
      );
    }
  }

  async captain(caller: CrewCaller): Promise<void> {
    caller = this.logicalCaller(caller);
    if (
      caller.agent !== this.options.team.captain.id ||
      this.state.peerBySession(caller.sessionID)
    )
      throw new CrewError(
        `Only ${this.options.team.captain.name ?? this.options.team.captain.id} captain sessions may perform this operation.`,
      );
    const pin = this.options.captainSessionID;
    if (pin && caller.sessionID !== pin)
      throw new CrewError(
        `Only the configured ${this.options.team.captain.name ?? this.options.team.captain.id} session may perform this operation; earlier captain sessions are retained history.`,
      );
    await this.verifyCaptainRoot(caller.sessionID, caller.signal);
  }

  private async verifyCaptainRoot(sessionID: string, signal: AbortSignal) {
    const session = await this.sessions.get({ sessionID }, { signal });
    if (
      session.parentID ||
      session.id !== sessionID ||
      ![
        this.options.team.captain.agent ?? this.options.team.captain.id,
        this.options.team.captain.id,
      ].includes(session.agent ?? "") ||
      resolve(session.location.directory) !==
        resolve(this.options.captainDirectory)
    )
      throw new CrewError(
        "Captain must be a root configured captain session in the configured captain directory.",
      );
  }

  /** Stored stargate_dm sends for Stargate's IRC copies (CrewIrc outbox RPC). */
  ircOutbox(input: { after?: number | undefined; limit: number }) {
    return this.state.ircSessions.outbox(input);
  }

  /** Crew member that a bound IRC session serves, if any. */
  ircMember(sessionID: string): string | undefined {
    return this.state.ircSessions.crewID(sessionID);
  }

  /**
   * Bind a Stargate IRC session to a crew member. The session must be a root
   * OpenCode session with that member's agent in its configured worktree,
   * not the member's task session, and the team must pin its captain (IRC
   * mail uses that captain context). A binding never changes member.
   */
  async bindIrcSession(
    input: { sessionID: string; crewID: string },
    signal: AbortSignal,
  ): Promise<{ bound: true }> {
    if (input.crewID === this.options.team.captain.id)
      throw new CrewError(
        "The captain's IRC conversations use the pinned captain session; bind crew sessions only.",
      );
    const member = this.member(input.crewID);
    if (member.backend)
      throw new CrewError("Pi crew IRC sessions have no crew tools.");
    if (!this.options.captainSessionID)
      throw new CrewError(
        "IRC crew messaging needs a pinned captain session (captainSessionID).",
      );
    if (this.state.peerBySession(input.sessionID))
      throw new CrewError("A crew task session is not an IRC session.");
    await this.validIrcSession(input.sessionID, input.crewID, signal);
    if (!this.state.ircSessions.bind(input.sessionID, input.crewID))
      throw new CrewError(
        "IRC session must be a root session of that crew member; it is bound to another member.",
      );
    return { bound: true };
  }

  private async validIrcSession(
    sessionID: string,
    crewID: string,
    signal: AbortSignal,
  ) {
    const member = this.member(crewID);
    const session = await this.sessions.get({ sessionID }, { signal });
    if (
      session.id !== sessionID ||
      session.parentID ||
      ![member.agent ?? crewID, crewID].includes(session.agent ?? "") ||
      resolve(session.location.directory) !==
        resolve(this.options.worktrees[crewID] ?? "")
    )
      throw new CrewError(
        "IRC session must be a root session of that crew member's agent in its worktree.",
      );
  }

  /**
   * stargate_dm and stargate_mail: the captain and assigned workers as before, plus
   * Stargate-bound IRC sessions, which act only as their member. The member
   * comes from the binding and must equal the host's agent for the call.
   */
  async authorizeMail(caller: CrewCaller): Promise<CrewCaller> {
    caller = this.logicalCaller(caller);
    const bound = this.state.ircSessions.crewID(caller.sessionID);
    if (!bound) {
      await this.authorize(caller);
      return caller;
    }
    if (caller.agent !== bound)
      throw new CrewError(
        "This IRC session belongs to another crew member; it sends only as that member.",
      );
    if (this.member(bound).backend || !this.options.captainSessionID)
      throw new CrewError("IRC crew messaging is unavailable for this member.");
    await this.validIrcSession(caller.sessionID, bound, caller.signal);
    return { ...caller, [ircIdentity]: bound };
  }

  async authorize(caller: CrewCaller): Promise<void> {
    caller = this.logicalCaller(caller);
    if (caller.agent === this.options.team.captain.id)
      return this.captain(caller);
    const peer = this.state.peerBySession(caller.sessionID);
    if (!peer || caller.agent !== peer.crewID)
      throw new CrewError(
        "Only the configured captain or assigned worker may use crew operations.",
      );
    this.member(peer.crewID);
    if (this.member(peer.crewID).backend) {
      if (
        caller[piIdentity] &&
        this.state.piPeer(peer.sessionID)?.conversationID
      )
        return;
      throw new CrewError(
        "Pi workers cannot impersonate OpenCode tool callers.",
      );
    }
    const session = await this.sessions.get(
      { sessionID: caller.sessionID },
      { signal: caller.signal },
    );
    this.validPeer(session, peer);
  }

  private member(id: string): CrewMember {
    const member = this.options.team.crew.find((member) => member.id === id);
    if (!member) throw new CrewError("Unknown configured crew member.");
    return member;
  }

  /** Read one existing own-roster model target, without ensure, prompt or control. */
  async inspectWorkerModel(
    crewID: string,
    caller: CrewCaller,
  ): Promise<WorkerModelPeer> {
    caller = this.logicalCaller(caller);
    caller.signal.throwIfAborted();
    await this.captain(caller);
    if (this.member(crewID).backend)
      throw new CrewError(
        "Live model inspection applies only to OpenCode workers.",
      );
    const peer = this.state.peer(crewID);
    if (peer?.status !== "ready")
      throw new CrewError(
        "Worker is not provisioned; model inspection does not create sessions.",
      );
    const session = await this.sessions.get(
      { sessionID: peer.sessionID },
      { signal: caller.signal },
    );
    caller.signal.throwIfAborted();
    this.validPeer(session, peer);
    return { ...peer, ...(session.model ? { model: session.model } : {}) };
  }

  async withWorkerControl<T>(
    crewID: string,
    caller: CrewCaller,
    operation: (peer: WorkerModelPeer) => Promise<T>,
    options: { requireReady?: boolean } = {},
  ): Promise<T> {
    caller = this.logicalCaller(caller);
    await this.captain(caller);
    if (this.member(crewID).backend)
      throw new CrewError(
        "Pi worker compaction and live model switching are not supported.",
      );
    // The controls table requires a peer row. Check cheaply before reserving,
    // then recheck readiness and native identity while the guard is held.
    if (options.requireReady && this.state.peer(crewID)?.status !== "ready")
      throw new CrewError(
        "Worker is not provisioned; this control does not create sessions.",
      );
    // Legacy switch/compact callers retain provisioning. Ready-only controls
    // must not call ensure, even if a peer disappears before the guard is held.
    let peer: WorkerModelPeer | undefined = options.requireReady
      ? undefined
      : await this.ensure(crewID, caller.signal);
    const active = this.state.activeTask(crewID);
    if (
      active &&
      active.status !== "completed" &&
      !this.ownsCaptainLineage(active.originCaptainID, caller)
    )
      throw new CrewError("This crew member is busy for another captain.");
    const token = this.state.reserveControl(crewID);
    try {
      if (options.requireReady) {
        const ready = this.state.peer(crewID);
        if (ready?.status !== "ready")
          throw new CrewError(
            "Worker is not provisioned; this control does not create sessions.",
          );
        const session = await this.sessions.get(
          { sessionID: ready.sessionID },
          { signal: caller.signal },
        );
        this.validPeer(session, ready);
        peer = { ...ready, ...(session.model ? { model: session.model } : {}) };
      }
      if (!peer)
        throw new CrewError("Worker is not provisioned; control refused.");
      if (!(await this.idle(peer, caller.signal)))
        throw new CrewError("Worker is not idle; control refused.");
      caller.signal.throwIfAborted();
      return await operation(peer);
    } finally {
      this.state.releaseControl(crewID, token);
    }
  }

  private validPeer(session: CrewSession, peer: Peer) {
    this.member(peer.crewID);
    const metadata = session.metadata?.["stargateCrew"];
    if (
      session.id !== peer.sessionID ||
      session.parentID ||
      ![this.member(peer.crewID).agent ?? peer.crewID, peer.crewID].includes(
        session.agent ?? "",
      ) ||
      resolve(session.location.directory) !==
        resolve(this.options.worktrees[peer.crewID] ?? "") ||
      typeof metadata !== "object" ||
      metadata === null ||
      Array.isArray(metadata) ||
      metadata["namespace"] !== this.options.namespace ||
      metadata["crewID"] !== peer.crewID
    )
      throw new CrewError(
        "Crew session identity changed. Restore its agent, directory and metadata; do not recreate it.",
      );
  }

  private async ensure(crewID: CrewID, signal: AbortSignal): Promise<Peer> {
    const member = this.member(crewID);
    const worktree = this.options.worktrees[crewID];
    if (!worktree) throw new CrewError("Missing configured worker directory.");
    const peer = this.state.reservePeer(crewID);
    if (member.backend) {
      await this.pi.ensure(member, worktree, peer, signal);
      this.state.readyPeer(crewID);
      return { ...peer, status: "ready" };
    }
    let session: CrewSession;
    try {
      session = await this.sessions.get(
        { sessionID: peer.sessionID },
        { signal },
      );
    } catch (error) {
      if (!notFound(error)) throw error;
      if (peer.status === "ready")
        throw new CrewError(
          `Crew session ${peer.sessionID} is missing. Restore OpenCode data; automatic recreation is disabled.`,
        );
      try {
        const agent = await this.agents?.get(
          {
            agentID: member.agent ?? crewID,
            location: { directory: worktree },
          },
          { signal },
        );
        if (agent && agent.data.mode !== "primary")
          throw new CrewError(
            "Crew agent definitions must use mode primary. Validate the generated profile before ensuring sessions.",
          );
        // Stable ID persisted BEFORE creation; retries cannot create new peers.
        session = await this.sessions.create(
          {
            id: peer.sessionID,
            agent: member.agent ?? crewID,
            title: `Stargate ${crewID}`,
            location: { directory: worktree },
            metadata: {
              stargateCrew: { namespace: this.options.namespace, crewID },
            },
            permissions: crewPermissions(
              member.permissionProfile,
              this.options.team.toolAccess,
            ),
            ...(agent?.data.model ? { model: agent.data.model } : {}),
          },
          { signal },
        );
      } catch (error) {
        if (error instanceof CrewError) throw error;
        throw new CrewError(
          "Crew creation not confirmed. Retry ensure to inspect/adopt the reserved session ID; do not delete state.",
        );
      }
    }
    this.validPeer(session, peer);
    this.state.readyPeer(crewID);
    return { ...peer, status: "ready" };
  }

  private ownedCaptainTask(id: string, caller: CrewCaller): CrewTask {
    const task = this.state.task(id);
    if (!task || !this.ownsCaptainLineage(task.originCaptainID, caller))
      throw new CrewError("This captain does not own the requested task.");
    return task;
  }

  private ownedWorkerTask(id: string, caller: CrewCaller): CrewTask {
    const task = this.state.task(id);
    if (
      !task ||
      task.workerSessionID !== caller.sessionID ||
      caller.agent !== task.crewID
    )
      throw new CrewError(
        "Only the assigned worker may use this task operation.",
      );
    return task;
  }

  /** Capability issuance requires an explicit pinned root, not rank, a human
   * account claim, a previous captain, or a synthesized tool caller. */
  async verifyInspectionIssuer(sessionID: string, signal: AbortSignal) {
    if (
      !this.options.captainSessionID ||
      sessionID !== this.options.captainSessionID ||
      this.state.peerBySession(sessionID)
    )
      throw new InspectionDenied("identity");
    await this.verifyCaptainRoot(sessionID, signal);
  }

  async verifyIssuerInspectionPermission(
    sessionID: string,
    signal: AbortSignal,
  ): Promise<void> {
    const verify = this.inspectionIssuerPermission;
    if (!verify) throw new InspectionDenied("unavailable");
    const verified: Promise<void> = verify(sessionID, signal);
    await verified;
    signal.throwIfAborted();
  }

  hostBoundInspectionPi(caller: CrewCaller): boolean {
    const peer = this.state.peerBySession(caller.sessionID);
    return !!(
      caller[piIdentity] &&
      peer &&
      peer.crewID === caller.agent &&
      this.member(peer.crewID).backend?.tools === "coding" &&
      this.state.piPeer(peer.sessionID)?.conversationID
    );
  }

  /** Synchronous final gate: exact current order, ownership and controller.
   * Legacy lineage is deliberately not authority to delegate another task. */
  inspectionBinding(
    crew: string,
    taskID: string,
    issuer: string,
  ): InspectionBinding {
    const member = this.member(crew);
    const task = this.state.activeTask(crew);
    const peer = this.state.peer(crew);
    if (
      !task ||
      !peer ||
      peer.status !== "ready" ||
      task.id !== taskID ||
      task.status !== "running" ||
      task.released !== 0 ||
      task.notifying !== 0 ||
      task.originCaptainID !== issuer ||
      peer.sessionID !== task.workerSessionID
    )
      throw new InspectionDenied("task");
    if (this.state.controlled(crew)) throw new InspectionDenied("controller");
    const conversationID = member.backend
      ? (this.state.piPeer(peer.sessionID)?.conversationID ?? null)
      : null;
    if (
      member.backend &&
      (member.backend.tools !== "coding" || !conversationID)
    )
      throw new InspectionDenied("identity");
    return {
      crew,
      taskID,
      sessionID: peer.sessionID,
      inputID: task.inputID,
      conversationID,
    };
  }

  async verifyInspectionPeer(crew: string, signal: AbortSignal) {
    const peer = this.state.peer(crew);
    if (peer?.status !== "ready") throw new InspectionDenied("identity");
    if (this.member(crew).backend) {
      if (!this.state.piPeer(peer.sessionID)?.conversationID)
        throw new InspectionDenied("identity");
      return;
    }
    const native = await this.sessions.get(
      { sessionID: peer.sessionID },
      { signal },
    );
    this.validPeer(native, peer);
  }

  async readDelegatedInspection(
    resource: InspectionBinding,
    signal: AbortSignal,
  ): Promise<NonNullable<CrewResult["inspection"]>> {
    const task = this.state.activeTask(resource.crew);
    if (!task || task.id !== resource.taskID)
      throw new InspectionDenied("task");
    let execution: NonNullable<CrewResult["inspection"]>["execution"] = {
      state: "unknown",
    };
    if (this.member(resource.crew).backend) {
      // Observation only: idle() can open a Pi runtime; do not call it here.
      execution = { state: this.pi.observed(task) ? "running" : "unknown" };
    } else if (this.inspectionConnector) {
      const peer = this.state.peer(resource.crew);
      if (!peer) throw new InspectionDenied("identity");
      const native = await this.sessions.get(
        { sessionID: peer.sessionID },
        { signal },
      );
      this.validPeer(native, peer);
      try {
        // Same-server anchor is the verified target, not a captain identity.
        const api = await this.inspectionConnection(native, signal);
        const live = await observeExecution(api, peer.sessionID, signal);
        this.validPeer(live.session, peer);
        execution = { state: live.execution.state };
      } catch {
        signal.throwIfAborted();
        // No raw SDK detail, outcomes, prompts, results, queue or control IDs.
      }
    }
    return {
      crew: resource.crew,
      taskID: resource.taskID,
      taskStatus: task.status,
      execution,
    };
  }

  private async inspectionAPI(caller: CrewCaller) {
    if (!this.inspectionConnector)
      throw new CrewError(
        "Authenticated inspection API unavailable; configure this team's same-server history API. No state changed.",
      );
    const native = await this.sessions.get(
      { sessionID: caller.sessionID },
      { signal: caller.signal },
    );
    return this.inspectionConnection(native, caller.signal);
  }

  private async inspectionConnection(
    native: CrewSession,
    signal: AbortSignal,
  ): Promise<CrewInspectionAPI> {
    const connect = this.inspectionConnector;
    if (!connect) throw new InspectionDenied("unavailable");
    return connect(native, signal);
  }

  private async inspect(
    input: InspectInput,
    caller: CrewCaller,
  ): Promise<CrewResult> {
    const member = this.member(input.crew);
    const peer = this.state.peer(input.crew);
    const active = this.state.activeTask(input.crew);
    const selected = input.taskID ? this.state.task(input.taskID) : active;
    if (input.taskID && (!selected || selected.crewID !== input.crew))
      throw new CrewError(
        "Requested task is not assigned to this team's member.",
      );
    const result: CrewResult = {
      status: peer ? "inspected" : "not-ensured",
      peers: peer ? [peer] : [],
      active: active ? inspectTask(active) : null,
      inspectedTask: selected ? inspectTask(selected) : null,
      queued: this.state.queuedTasks(input.crew).map(inspectTask),
      controlled: this.state.controlled(input.crew),
      controlID: this.state.controlID(input.crew),
      reconciliation: selected ? this.state.reconciliation(selected.id) : null,
      abandonment: selected ? this.state.abandonment(selected.id) : null,
    };
    if (!peer) {
      if (input.requestStatus)
        throw new CrewError(
          "Worker has no registered session/task to interrogate.",
        );
      return result;
    }
    if (member.backend) {
      if (input.requestStatus)
        throw new CrewError("Pi workers do not support Mesij status requests.");
      result.execution = {
        state: (await this.idle(peer, caller.signal)) ? "idle" : "running",
        backend: "pi",
      };
      return result;
    }
    let live: Awaited<ReturnType<typeof observeExecution>>;
    try {
      live = await observeExecution(
        await this.inspectionAPI(caller),
        peer.sessionID,
        caller.signal,
      );
    } catch (error) {
      caller.signal.throwIfAborted();
      // Status requests need a validated live identity; plain reads keep the
      // local ownership the captain needs for reconcile or abandon.
      if (input.requestStatus) throw error;
      result.execution = { state: "unknown" };
      result.diagnostic = `Native execution unknown: ${error instanceof CrewError ? error.message : "inspection API unavailable; raw details withheld."} Local ownership above is current. Retry inspect, or abandon with acknowledgeUnconfirmedStop.`;
      return result;
    }
    this.validPeer(live.session, peer);
    result.execution = live.execution;
    if (input.requestStatus) {
      if (!active || selected?.id !== active.id)
        throw new CrewError("Status requests require the current active task.");
      result.statusRequest = await this.requestStatus(
        active,
        input.requestStatus.key,
        caller,
      );
    }
    return result;
  }

  private async requestStatus(task: CrewTask, key: string, caller: CrewCaller) {
    const id = sha256(
      JSON.stringify([
        this.options.namespace,
        "status-request",
        task.id,
        caller.sessionID,
        key,
      ]),
    );
    this.state.reserveStatusRequest(id, task, caller.sessionID);
    try {
      await this.mailer.register(
        this.actor(caller.sessionID),
        caller.sessionID,
        caller.signal,
      );
      await this.mailer.register(
        this.actor(task.workerSessionID),
        task.workerSessionID,
        caller.signal,
      );
      const receipt = await this.mailer.send(
        {
          actor: this.actor(caller.sessionID),
          sessionID: caller.sessionID,
          to: task.workerSessionID,
          key: id,
          text: JSON.stringify({
            namespace: this.options.namespace,
            sourceTaskID: task.id,
            targetTaskID: task.id,
            originCaptainID: task.originCaptainID,
            sender: caller.sessionID,
            recipient: task.workerSessionID,
            statusRequestID: id,
            text: `Status request for task ${task.id}. Reply using stargate_mail send to=captain with this message's id as replyTo. Report status/evidence only; do not resume or replay work.`,
          }),
        },
        caller.signal,
      );
      this.state.statusRequestReceipt(id, receipt.id);
      const route = this.statusRequestRoute(receipt.id);
      if (route) this.state.mailRoutes.save(route);
      return receipt;
    } catch {
      throw new CrewError(
        "Mesij status request unconfirmed; retry inspect with the same requestStatus key. Worker was not prompted.",
      );
    }
  }

  private async reconcile(
    input: ReconcileInput,
    caller: CrewCaller,
  ): Promise<CrewResult> {
    const task = this.state.task(input.taskID);
    if (!task) throw new CrewError("Task is not in this team's state.");
    if (this.member(task.crewID).backend)
      throw new CrewError(
        "Reconciliation supports native OpenCode workers only.",
      );
    if (
      task.workerSessionID !== input.expected.workerSessionID ||
      task.originCaptainID !== input.expected.originCaptainID ||
      task.inputID !== input.expected.inputID
    )
      throw new CrewError(
        "Expected ownership is stale; inspect this task again.",
      );
    const previous = this.state.reconciliation(task.id);
    if (previous) {
      if (
        task.status !== "completed" ||
        task.result === null ||
        previous.workerSessionID !== task.workerSessionID ||
        previous.originCaptainID !== task.originCaptainID ||
        previous.inputID !== task.inputID ||
        previous.resultMessageID !== input.resultMessageID ||
        previous.resultSha256 !== input.resultSha256 ||
        sha256(task.result) !== input.resultSha256
      )
        throw new CrewError(
          "Reconciliation conflicts with retained audit/result.",
        );
      return { status: "reconciled", reconciliation: previous };
    }
    const token = this.state.reserveReconciliation(task);
    try {
      const api = await this.inspectionAPI(caller);
      const peer = {
        crewID: task.crewID,
        sessionID: task.workerSessionID,
        status: "ready" as const,
      };
      const before = await observeExecution(api, peer.sessionID, caller.signal);
      this.validPeer(before.session, peer);
      requireQuiescent(before.execution);
      const proof = await verifyResult(
        api,
        task,
        input,
        before.execution,
        caller.signal,
        this.member(task.crewID).agent ?? task.crewID,
      );
      const after = await observeExecution(api, peer.sessionID, caller.signal);
      this.validPeer(after.session, peer);
      requireQuiescent(after.execution);
      if (JSON.stringify(before.execution) !== JSON.stringify(after.execution))
        throw new CrewError(
          "Worker execution changed during evidence verification; inspect again.",
        );
      caller.signal.throwIfAborted();
      const reconciliation = this.state.finishReconciliation(
        task,
        token,
        proof.result,
        {
          reconciledBy: caller.sessionID,
          resultMessageID: input.resultMessageID,
          inputSha256: proof.inputSha256,
          resultSha256: input.resultSha256,
          reason: input.reason,
        },
      );
      return { status: "reconciled", reconciliation };
    } finally {
      this.state.releaseControl(task.crewID, token);
    }
  }

  /** Receipt recovery only. Never enqueue or wake through status or abandon. */
  private async observeResumeReceipts(
    task: CrewTask,
    caller: CrewCaller,
  ): Promise<void> {
    const pending = this.state.resumeBoundaries(task.id, true);
    if (!pending.length) return;
    const signal = AbortSignal.any([caller.signal, AbortSignal.timeout(10000)]);
    try {
      const api = await this.inspectionAPI({ ...caller, signal });
      const peer = this.state.peer(task.crewID);
      if (!peer || peer.sessionID !== task.workerSessionID) return;
      this.validPeer(
        await api.session.get({ sessionID: peer.sessionID }, { signal }),
        peer,
      );
      for (const idleAt of pending) {
        if (
          await resumeAdmitted(
            api,
            peer.sessionID,
            resumeMessageID(task, idleAt),
            idleAt,
            signal,
          )
        )
          this.state.confirmResumeAttempt(task.id, idleAt);
      }
    } catch {
      caller.signal.throwIfAborted();
      // Unknown stays unconfirmed. A later status can re-read native evidence.
    }
  }

  private async resume(
    input: ResumeInput,
    caller: CrewCaller,
  ): Promise<CrewResult> {
    const task = this.ownedCaptainTask(input.taskID, caller);
    if (!this.options.exclusiveWorkerInput)
      throw new CrewError(
        "Resume requires a protected worker profile with exclusive Stargate input.",
      );
    const member = this.member(task.crewID);
    const peer = this.state.peer(task.crewID);
    const { expected } = input;
    if (member.backend)
      throw new CrewError("Resume supports native OpenCode workers only.");
    if (
      task.status !== "uncertain" ||
      task.result !== null ||
      peer?.status !== "ready" ||
      peer.sessionID !== task.workerSessionID ||
      task.workerSessionID !== expected.workerSessionID ||
      task.originCaptainID !== expected.originCaptainID ||
      task.inputID !== expected.inputID
    )
      throw new CrewError(
        "Resume requires the current uncertain task and its inspected worker, captain and input.",
      );

    const token = this.state.reserveReconciliation(task);
    const signal = AbortSignal.any([caller.signal, AbortSignal.timeout(30000)]);
    try {
      const api = await this.inspectionAPI({ ...caller, signal });
      const inspect = async () => {
        const { session, execution } = await observeExecution(
          api,
          peer.sessionID,
          signal,
        );
        this.validPeer(session, peer);
        if (idleBoundary(execution) !== expected.idleAt)
          throw new CrewError(
            "Worker changed, is busy, or has pending input or approval; inspect again before resuming.",
          );
        return execution;
      };
      const id = resumeMessageID(task, expected.idleAt);
      if (
        this.state.resumeAttempted(task.id, expected.idleAt) &&
        (await resumeAdmitted(api, peer.sessionID, id, expected.idleAt, signal))
      ) {
        this.state.confirmResumeAttempt(task.id, expected.idleAt);
        return {
          status: "resume-already-admitted",
          task,
          diagnostic:
            "This idle boundary already has its continuation. Use status on the same task.",
        };
      }
      const before = await inspect();
      const workerAgent = member.agent ?? task.crewID;
      const placement = await observePlacement(api, task, signal, workerAgent);
      if (placement === "unknown")
        throw new CrewError(
          "Native history is unverified. Inspect the existing task before resuming.",
        );
      if (placement !== "placed")
        throw new CrewError(
          "Original assignment no longer owns the native turn; resume refused.",
        );

      try {
        await readTaskResult(api, task, signal, workerAgent);
        return {
          status:
            before.outcome === "succeeded"
              ? "result-available"
              : "result-unconfirmed",
          task,
          diagnostic:
            before.outcome === "succeeded"
              ? "The original final answer is retained. Use status or reconcile to collect it."
              : "History contains a final answer, but OpenCode did not report success. Preserve the answer and inspect the native outcome.",
        };
      } catch (error) {
        if (!(error instanceof MissingTaskResult)) throw error;
      }

      const after = await inspect();
      if (JSON.stringify(before) !== JSON.stringify(after))
        throw new CrewError(
          "Worker changed during resume checks; inspect again.",
        );
      signal.throwIfAborted();
      this.state.recordResumeAttempt(
        task,
        token,
        expected.idleAt,
        caller.sessionID,
      );
      try {
        await this.sessions.synthetic(
          {
            sessionID: peer.sessionID,
            id,
            text: `Resume retained task ${task.id}. Read the captain's task mail and check your saved progress and prior tool results before continuing the remaining work. Return the final answer for this task.`,
            description: "Captain resume of retained crew task",
            metadata: {
              [crewMessageMetadataKey]: {
                taskID: task.id,
                originCaptainID: task.originCaptainID,
                sourceTaskID: task.id,
                resumeIdleAt: expected.idleAt,
              },
            },
            delivery: "queue",
            resume: true,
          },
          {
            signal: AbortSignal.any([
              caller.signal,
              AbortSignal.timeout(10000),
            ]),
          },
        );
      } catch {
        caller.signal.throwIfAborted();
        return {
          status: "resume-uncertain",
          task,
          diagnostic:
            "Resume admission is unconfirmed. Inspect the existing session. An exact retry uses the same native message ID.",
        };
      }
      this.state.confirmResumeAttempt(task.id, expected.idleAt);
      return {
        status: "resume-admitted",
        task: this.state.readmit(task, token),
        diagnostic:
          "OpenCode accepted the continuation. Use status on the same task to observe execution or collect its final answer.",
      };
    } catch (error) {
      caller.signal.throwIfAborted();
      if (signal.aborted)
        throw new CrewError(
          "Resume inspection timed out. Inspect the existing task before another attempt.",
        );
      throw error;
    } finally {
      this.state.releaseControl(task.crewID, token);
    }
  }

  private abandoned(task: CrewTask, after: number): CrewResult | null {
    const abandonment = this.state.abandonment(task.id);
    return abandonment
      ? {
          // Local terminal decision: abandoned, or cancelled before execution.
          status: task.status === "cancelled" ? "cancelled" : "abandoned",
          task,
          abandonment,
          notices: this.state.notices(task.id, after),
        }
      : null;
  }

  /** Captain override for a blocked slot whose result cannot be proven.
   * Never completes, replays, prompts or promotes; the FIFO stays queued.
   */
  private async abandon(
    input: AbandonInput,
    caller: CrewCaller,
  ): Promise<CrewResult> {
    const task = this.state.task(input.taskID);
    if (!task) throw new CrewError("Task is not in this team's state.");
    this.member(task.crewID);
    const { expected } = input;
    const previous = this.state.abandonment(task.id);
    if (previous) {
      if (
        previous.operationKey !== input.key ||
        previous.reason !== input.reason ||
        previous.previousStatus !== expected.status ||
        previous.workerSessionID !== expected.workerSessionID ||
        previous.originCaptainID !== expected.originCaptainID ||
        previous.inputID !== expected.inputID
      )
        throw new CrewError(
          "Task was already released by an abandon or proven cancellation with another key, reason or identity; inspect its retained audit.",
        );
      const token = this.state.resumeAbandon(task.id);
      if (token)
        return this.stopAbandoned(task, previous.previousStatus, token, caller);
      return {
        status: "abandoned",
        task: this.state.task(task.id) ?? task,
        abandonment: this.state.abandonment(task.id),
      };
    }
    if (task.status === "abandoned" || task.released)
      throw new CrewError(
        "Task is no longer assigned; inspect its retained state. Nothing abandoned.",
      );
    if (
      task.workerSessionID !== expected.workerSessionID ||
      task.originCaptainID !== expected.originCaptainID ||
      task.inputID !== expected.inputID
    )
      throw new CrewError(
        "Expected ownership is stale; inspect this task again.",
      );
    if (task.status === "completed")
      throw new CrewError(
        "Completed tasks keep their result; dispatch releases them normally. Nothing abandoned.",
      );
    if (task.status === "queued" || task.status === "cancelled")
      throw new CrewError(
        "Queued work has no native execution to abandon. Nothing abandoned.",
      );
    await this.observeResumeReceipts(task, caller);
    const token = this.state.beginAbandon(
      { ...task, status: expected.status, controlID: expected.controlID },
      {
        abandonedBy: caller.sessionID,
        reason: input.reason,
        operationKey: input.key,
      },
    );
    return this.stopAbandoned(task, expected.status, token, caller);
  }

  private async stopAbandoned(
    task: CrewTask,
    previous: AbandonableStatus,
    token: string,
    caller: CrewCaller,
  ): Promise<CrewResult> {
    // The local abandon is committed. Always record a stop outcome, even
    // when the caller aborts; a crash leaves "pending" for an exact retry.
    let outcome: { stop: "confirmed" | "unconfirmed"; detail: string } = {
      stop: "unconfirmed",
      detail: "Stop attempt failed; native state unknown.",
    };
    try {
      outcome = await this.stopOwnInput(task, caller, previous);
    } finally {
      this.state.finishAbandon(task.id, token, outcome.stop, outcome.detail);
    }
    return {
      status: "abandoned",
      task: this.state.task(task.id) ?? task,
      abandonment: this.state.abandonment(task.id),
      ...(outcome.stop === "unconfirmed"
        ? {
            diagnostic: `Task ${task.id} abandoned; native stop unconfirmed: ${outcome.detail} Dispatch still requires confirmed native idle. Inspect the workspace before reuse.`,
          }
        : {}),
    };
  }

  /** Best effort, this worker only. Withdraws the task's own queued input;
   * interrupts only when its own input is the latest placed turn. Unknown or
   * foreign native work is never interrupted. Confirmed: idle, nothing queued.
   */
  private async stopOwnInput(
    task: CrewTask,
    caller: CrewCaller,
    previous: CrewTask["status"],
  ): Promise<{
    stop: "confirmed" | "unconfirmed";
    detail: string;
    withdrawn: boolean;
  }> {
    const member = this.member(task.crewID);
    const peer = this.state.peer(task.crewID);
    if (!peer || peer.sessionID !== task.workerSessionID)
      return {
        stop: "unconfirmed",
        detail: "Worker reservation differs.",
        withdrawn: false,
      };
    const signal = AbortSignal.timeout(15_000);
    if (member.backend) {
      if (this.pi.observed(task))
        await Promise.race([
          this.pi.interrupt(peer),
          delay(5000, undefined, { ref: false }),
        ]);
      return (await this.idle(peer, signal))
        ? { stop: "confirmed", detail: "Pi worker idle.", withdrawn: false }
        : {
            stop: "unconfirmed",
            detail: "Pi worker idle state unconfirmed.",
            withdrawn: false,
          };
    }
    const api = this.inspectionConnector
      ? await this.inspectionAPI({ ...caller, signal }).catch(() => null)
      : null;
    if (this.state.resumeBoundaries(task.id, true).length)
      return {
        stop: "unconfirmed",
        detail:
          "Resume admission is unconfirmed. Inspect native evidence before stopping.",
        withdrawn: false,
      };
    const resumeIDs = new Set(
      this.state
        .resumeBoundaries(task.id)
        .map((idleAt) => resumeMessageID(task, idleAt)),
    );
    if (resumeIDs.size) {
      const queuedResumes = async () =>
        (
          await api?.session.inbox.list(
            { sessionID: peer.sessionID },
            { signal },
          )
        )?.filter(({ id }) => resumeIDs.has(id));
      const stopUnconfirmed = {
        stop: "unconfirmed" as const,
        detail:
          "The task's queued resume could not be withdrawn. Inspect its native inbox.",
        withdrawn: false,
      };
      const queued = await queuedResumes().catch(() => undefined);
      if (!queued || (queued.length && !api?.session.inbox.cancel))
        return stopUnconfirmed;
      for (const { id } of queued)
        await api?.session.inbox
          .cancel?.({ sessionID: peer.sessionID, inboxID: id }, { signal })
          .catch(() => {});
      const remaining = await queuedResumes().catch(() => undefined);
      if (!remaining || remaining.length) return stopUnconfirmed;
    }
    let placement: Placement = api
      ? await observePlacement(api, task, signal, member.agent ?? task.crewID)
      : "unknown";
    let withdrawn = false;
    if (placement === "queued" && api?.session.inbox.cancel) {
      await api.session.inbox
        .cancel(
          { sessionID: task.workerSessionID, inboxID: task.inputID },
          { signal },
        )
        .catch(() => {});
      placement = await observePlacement(
        api,
        task,
        signal,
        member.agent ?? task.crewID,
      );
      withdrawn = placement === "absent";
    }
    const settled = async (ms: number) => {
      try {
        await this.sessions.wait(
          { sessionID: peer.sessionID },
          { signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]) },
        );
        return true;
      } catch {
        return false;
      }
    };
    let idle = await settled(100);
    let interrupted = false;
    if (!idle && placement === "placed") {
      try {
        await this.sessions.interrupt(
          { sessionID: peer.sessionID, resume: false },
          { signal: AbortSignal.timeout(5000) },
        );
        interrupted = true;
      } catch {
        // An unavailable native API leaves the stop unconfirmed below.
      }
      idle = await settled(2000);
    }
    const inFlight = previous === "dispatching";
    const notes = [
      withdrawn ? "own queued input withdrawn before execution" : "",
      `own input ${placement}`,
      idle ? "native idle" : "native idle unconfirmed",
      interrupted ? "interrupt accepted" : "",
      !idle && placement !== "placed"
        ? "unproven native work not interrupted"
        : "",
      inFlight ? "admission may still be in flight" : "",
    ].filter(Boolean);
    return {
      stop:
        idle && placement !== "queued" && placement !== "unknown" && !inFlight
          ? "confirmed"
          : "unconfirmed",
      detail: `${notes.join("; ")}.`,
      withdrawn: withdrawn && !inFlight,
    };
  }

  /** Uncertain native task whose own input is provably queued or the latest
   * placed turn on an active worker is still admitted: running, no resubmit.
   */
  private async readmitUncertain(
    task: CrewTask,
    caller: CrewCaller,
  ): Promise<{ task: CrewTask; diagnostic?: string }> {
    if (
      task.status !== "uncertain" ||
      task.released ||
      !this.inspectionConnector ||
      this.member(task.crewID).backend
    )
      return { task };
    const peer = this.state.peer(task.crewID);
    if (!peer || peer.sessionID !== task.workerSessionID) return { task };
    const signal = AbortSignal.any([
      caller.signal,
      AbortSignal.timeout(10_000),
    ]);
    const api = await this.inspectionAPI({ ...caller, signal }).catch(
      () => null,
    );
    const placement = api
      ? await observePlacement(
          api,
          task,
          signal,
          this.member(task.crewID).agent ?? task.crewID,
        )
      : "unknown";
    caller.signal.throwIfAborted();
    const admitted = placement === "queued" || placement === "placed";
    if (admitted && !(await this.idle(peer, signal)))
      return {
        task: this.state.readmit(task),
        diagnostic: `Task ${task.id}: own input ${task.inputID} is ${placement} natively; running without resubmission.`,
      };
    return {
      task,
      diagnostic: `Task ${task.id}: own input ${task.inputID} is ${placement} natively. ${placement === "unknown" ? "Native evidence unreadable; inspect before recovery." : "Recover a retained answer with status/reconcile, or inspect for resume or explicit abandonment."}`,
    };
  }

  private slot(crewID: string): NonNullable<CrewResult["slot"]> {
    const active = this.state.activeTask(crewID);
    return {
      taskID: active?.id ?? null,
      status: active?.status ?? null,
      controlled: this.state.controlled(crewID),
      queued: this.state.queuedTasks(crewID).length,
    };
  }

  /** Bounded Git in the configured worker worktree. Inspection is read-only;
   * stash/reset hold the dispatch control slot and require the exact state.
   */
  private async workspace(
    input: WorkspaceInput,
    caller: CrewCaller,
  ): Promise<CrewResult> {
    const root = await workspaceRoot(
      this.options.worktrees[input.crew] ?? "",
      this.options.captainDirectory,
      this.options.projectDirectory,
      caller.signal,
    );
    if (input.op === "workspace")
      return {
        status: "workspace",
        workspace: await inspectWorkspace(
          root,
          input.crew,
          caller.signal,
          input.patch,
        ),
        slot: this.slot(input.crew),
      };
    caller.signal.throwIfAborted();
    const peer = this.state.reservePeer(input.crew);
    const token = this.state.reserveWorkspace(
      input.crew,
      input.expected.taskID,
    );
    try {
      const executionConfirmed = await this.idle(peer, caller.signal);
      if (!executionConfirmed && !input.acknowledgeUnconfirmedExecution)
        throw new CrewError(
          "Worker idle state is unconfirmed; native writes can race with Git. Retry with acknowledgeUnconfirmedExecution=true only if you accept that risk. No Git change made.",
        );
      const current = await inspectWorkspace(root, input.crew, caller.signal);
      if (
        current.head !== input.expected.head ||
        current.fingerprint !== input.expected.fingerprint
      )
        throw new CrewError(
          "Workspace HEAD or changes differ from the inspected state; inspect again. No Git change made.",
        );
      if (current.nested)
        throw new CrewError(
          "Workspace contains a submodule or nested repository; review it natively. No Git change made.",
        );
      if (!current.changeCount)
        return {
          status: "clean",
          workspace: current,
          checkpoint: null,
          executionConfirmed,
        };
      caller.signal.throwIfAborted();
      const checkpoint =
        input.op === "stash"
          ? await stashWorkspace(root, input.crew)
          : await resetWorkspace(root, input.crew, current.head);
      if (checkpoint)
        this.state.reporting.journal.append(
          {
            member: input.crew,
            captainID: caller.sessionID,
            taskID: this.state.activeTask(input.crew)?.id ?? null,
            kind: "update",
            text: `Captain ${input.op === "stash" ? "stashed" : "reset"} workspace at ${current.head}; retained ${checkpoint.oid}.`,
          },
          `${input.crew}:workspace:${checkpoint.oid}`,
        );
      return {
        status: checkpoint
          ? input.op === "stash"
            ? "stashed"
            : "reset"
          : "unchanged",
        workspace: await inspectWorkspace(root, input.crew, caller.signal),
        checkpoint,
        executionConfirmed,
        ...(input.op === "reset"
          ? {
              diagnostic: checkpoint
                ? "Tracked changes were reset to HEAD; untracked and ignored files were left in place."
                : "No tracked changes to reset; untracked and ignored files were left in place.",
            }
          : {}),
      };
    } finally {
      this.state.releaseControl(input.crew, token);
    }
  }

  private async dispatch(
    input: Extract<CrewInput, { op: "dispatch" }>,
    caller: CrewCaller,
  ): Promise<CrewResult> {
    const messageID = caller.messageID;
    const originInputID = await this.dispatchOrigin(caller, messageID);
    const peer = await this.ensure(input.crew, caller.signal);
    const enqueue = () =>
      this.state.enqueue(
        peer,
        caller.sessionID,
        input.text,
        undefined,
        originInputID,
      );
    let active = this.state.activeTask(input.crew);
    const recovered = active
      ? await this.reconcileResult(active, caller)
      : undefined;
    if (recovered) active = recovered.task;
    const busy: CrewResult = {
      status: "busy",
      ...(active && this.ownsCaptainLineage(active.originCaptainID, caller)
        ? {
            task: active,
            ...(recovered?.diagnostic
              ? { diagnostic: recovered.diagnostic }
              : {}),
          }
        : {}),
    };
    if (active) {
      if (
        active.status !== "completed" ||
        active.notifying ||
        !(await this.idle(peer, caller.signal))
      ) {
        caller.signal.throwIfAborted();
        return input.queue
          ? {
              status: "queued",
              task: enqueue(),
            }
          : busy;
      }
      if (!this.state.release(active.id))
        return input.queue
          ? {
              status: "queued",
              task: enqueue(),
            }
          : busy;
    }
    if (!active && !(await this.idle(peer, caller.signal))) {
      caller.signal.throwIfAborted();
      return input.queue
        ? {
            status: "queued",
            task: enqueue(),
          }
        : busy;
    }
    caller.signal.throwIfAborted();
    const task = this.state.reserveTask(
      peer,
      caller.sessionID,
      input.text,
      originInputID,
    );
    if (!task)
      return input.queue
        ? {
            status: "queued",
            task: enqueue(),
          }
        : { status: "busy" };
    return this.admit(task, input.text, caller);
  }

  private async dispatchOrigin(
    caller: CrewCaller,
    messageID: string | undefined,
  ): Promise<string | null> {
    if (!messageID || !this.inspectionConnector) return null;
    const stop = new AbortController();
    const signal = AbortSignal.any([caller.signal, stop.signal]);
    try {
      const origin = async () =>
        readInputOrigin(
          await this.inspectionAPI({ ...caller, signal }),
          caller.sessionID,
          messageID,
          signal,
        );
      return await Promise.race([
        origin(),
        delay(5000, null, { signal, ref: false }),
      ]);
    } catch {
      caller.signal.throwIfAborted();
      // Missing or unreadable ancestry suppresses Slack routing, not the task.
      return null;
    } finally {
      stop.abort();
    }
  }

  private async idle(peer: Peer, signal: AbortSignal): Promise<boolean> {
    if (this.member(peer.crewID).backend)
      return this.pi.idle(
        peer,
        this.member(peer.crewID),
        this.options.worktrees[peer.crewID] ?? "",
        signal,
      );
    try {
      await this.sessions.wait(
        { sessionID: peer.sessionID },
        { signal: AbortSignal.any([signal, AbortSignal.timeout(100)]) },
      );
      return true;
    } catch {
      return false;
    }
  }

  private async promote(task: CrewTask, caller: CrewCaller): Promise<CrewTask> {
    caller.signal.throwIfAborted();
    const peer = await this.ensure(task.crewID, caller.signal);
    let active = this.state.activeTask(task.crewID);
    if (active) active = (await this.reconcileResult(active, caller)).task;
    if (active && (active.status !== "completed" || active.notifying))
      return task;
    if (!(await this.idle(peer, caller.signal))) return task;
    caller.signal.throwIfAborted();
    const promoted = this.state.promote(task.id, active?.id ?? null);
    if (promoted) {
      const result = await this.admit(promoted.task, promoted.text, caller);
      return result.task ?? promoted.task;
    }
    return this.state.task(task.id) ?? task;
  }

  private async admit(
    task: CrewTask,
    text: string,
    caller: CrewCaller,
  ): Promise<CrewResult> {
    const member = this.member(task.crewID);
    if (member.backend) {
      try {
        caller.signal.throwIfAborted();
        const peer = this.state.peer(task.crewID);
        const worktree = this.options.worktrees[task.crewID];
        if (!peer || !worktree)
          throw new CrewError("Pi worker reservation missing.");
        this.pi.start(member, worktree, peer, task, text);
        return { status: "running", task: this.state.task(task.id) ?? task };
      } catch {
        this.state.uncertain(task.id);
        throw new CrewError(
          "Pi task admission unconfirmed; work will not be replayed automatically.",
        );
      }
    }
    const envelope = JSON.stringify({
      taskID: task.id,
      crewID: task.crewID,
      originCaptainID: task.originCaptainID,
      inputID: task.inputID,
    });
    try {
      await this.sessions.prompt(
        {
          sessionID: task.workerSessionID,
          id: task.inputID,
          text:
            `Stargate task envelope: ${envelope}\n\n${text}\n\n` +
            `Return a final answer for only this assignment. You may also use stargate_crew ` +
            `op=complete, taskID=${task.id}, result=<your result>. ` +
            "Do not create peer/root sessions or send prompts to captains. " +
            "Use stargate_crew urgent for task-scoped urgent communication.",
          metadata: {
            [crewMessageMetadataKey]: {
              taskID: task.id,
              originCaptainID: task.originCaptainID,
            },
          },
          delivery: "queue",
          resume: true,
        },
        { signal: caller.signal },
      );
      this.state.running(task.id);
      return { status: "running", task: this.state.task(task.id) ?? task };
    } catch {
      if (caller.signal.aborted) {
        await this.cancel(task, caller);
        if (this.state.abandonment(task.id))
          throw new CrewError(this.cancelled(task.id));
      } else {
        // A lost receipt is not a lost input: correlate the persisted inputID.
        const api = await this.inspectionAPI(caller).catch(() => null);
        const placement = api
          ? await observePlacement(
              api,
              task,
              caller.signal,
              member.agent ?? task.crewID,
            )
          : "unknown";
        if (placement === "queued" || placement === "placed") {
          this.state.running(task.id);
          return {
            status: "running",
            task: this.state.task(task.id) ?? task,
            diagnostic: `Prompt receipt lost; own input ${task.inputID} is ${placement} natively. Not resubmitted.`,
          };
        }
      }
      this.state.uncertain(task.id);
      throw new CrewError(
        `Task ${task.id} admission uncertain. Inspect worker ${task.workerSessionID}; work will not be replayed automatically.`,
      );
    }
  }

  private async cancel(task: CrewTask, caller: CrewCaller) {
    const origin = this.captainOrigin(task, caller);
    if (this.state.cancelQueued(task.id, origin)) return;
    const previous = this.state.task(task.id)?.status ?? task.status;
    if (!this.state.beginCancel(task.id, origin)) return;
    try {
      if (this.member(task.crewID).backend) {
        const peer = this.state.peer(task.crewID);
        if (peer) await this.pi.interrupt(peer);
        return;
      }
      // Withdraw the own queued input first; interrupt only proven placement.
      const stop = await this.stopOwnInput(task, caller, previous);
      if (stop.withdrawn)
        this.state.withdrawCancelled(
          task,
          origin,
          stop.detail,
          caller.sessionID,
        );
    } catch {
      // Native stop can fail independently; keep the reservation uncertain.
    } finally {
      this.state.uncertain(task.id);
    }
  }

  private cancelled(taskID: string): string {
    const abandonment = this.state.abandonment(taskID);
    if (abandonment?.operationKey === withdrawKey)
      return "Wait cancelled; own input withdrawn before execution and the task cancelled without a result.";
    if (this.state.task(taskID)?.status === "cancelled")
      return "Wait cancelled; queued task cancelled without interrupting the worker.";
    if (abandonment)
      return "Wait cancelled; a captain abandoned this task. Inspect its retained audit.";
    return "Wait cancelled; task outcome uncertain. Inspect worker before further work.";
  }

  /** Tools-off reports may pass queued work, never an occupied/uncertain slot. */
  async reporterFree(id: string, signal: AbortSignal): Promise<boolean> {
    const member = this.options.team.crew.find((member) => member.id === id);
    const directory = this.options.worktrees[id];
    if (!member?.backend || !directory || this.state.controlled(id))
      return false;
    const task = this.state.activeTask(id);
    if (task && (task.status !== "completed" || task.notifying)) return false;
    if (!(await this.pi.canReport(member, directory))) return false;
    const peer = this.state.peer(id);
    return !peer || (await this.idle(peer, signal));
  }

  queueReport(
    sessionID: string,
    reporter: string,
    captureID: string,
    text: string,
  ): CrewTask {
    if (!this.member(reporter).backend)
      throw new CrewError(
        "Activity reporter must be a configured Pi Durable worker.",
      );
    return this.state.enqueue(
      this.state.reservePeer(reporter),
      sessionID,
      text,
      captureID,
    );
  }

  /** Pi: adopt only this task's committed native answer; never resubmits. */
  private piRecover(task: CrewTask, signal: AbortSignal): Promise<CrewTask> {
    return this.pi.recover(
      task,
      this.member(task.crewID),
      this.options.worktrees[task.crewID] ?? "",
      signal,
    );
  }

  reportingTask(id: string): CrewTask | null {
    const task = this.state.task(id);
    return task && this.member(task.crewID).backend
      ? this.pi.reconcile(task)
      : task;
  }

  async progressReport(id: string, caller: CrewCaller) {
    if (!this.state.reporting.isReport(id))
      throw new CrewError("Not a reporting task.");
    const task = this.ownedCaptainTask(id, caller);
    const key = `${this.state.path}:${id}`;
    let admission = reportAdmissions.get(key);
    if (!admission) {
      admission = this.admitReport(task, caller).finally(() => {
        reportAdmissions.delete(key);
      });
      reportAdmissions.set(key, admission);
    }
    await admission;
  }

  private async admitReport(task: CrewTask, caller: CrewCaller) {
    if (task.status === "queued") {
      const directory = this.options.worktrees[task.crewID];
      if (
        !directory ||
        !(await this.pi.canReport(this.member(task.crewID), directory))
      ) {
        this.state.cancelQueued(task.id, this.captainOrigin(task, caller));
        throw new CrewError(
          "Activity reporter unavailable: Pi backend cannot enforce tools-off, capture-only reporting; maintenance was not run.",
        );
      }
      // Cancellation can occur while opening the backend. Recheck before any
      // durable admission; a cancelled queued report must not start maintenance.
      caller.signal.throwIfAborted();
      await this.promote(this.ownedCaptainTask(task.id, caller), caller);
    } else await this.piRecover(task, caller.signal);
  }

  async cancelReport(id: string, caller: CrewCaller) {
    if (!this.state.reporting.isReport(id))
      throw new CrewError("Not a reporting task.");
    await this.cancel(this.ownedCaptainTask(id, caller), caller);
  }

  private async wait(
    task: CrewTask,
    after: number,
    caller: CrewCaller,
    deadline: number,
  ): Promise<CrewResult> {
    const elapsed = (current: CrewTask, notices: CrewNotice[]): CrewResult => ({
      status: current.status,
      task: current,
      notices,
      diagnostic: `Observation window elapsed; task ${current.id} is still ${current.status}. Work continues independently; nothing was cancelled or resubmitted. Reply with progress. End this turn; collect this task later with status or wait. Do not resubmit the assignment.`,
    });
    // Queued waits do not observe/interrupt the different task occupying this slot.
    while (task.status === "queued") {
      caller.signal.throwIfAborted();
      task = await this.promote(task, caller);
      caller.signal.throwIfAborted();
      if (task.status !== "queued") break;
      const notices = this.state.notices(task.id, after);
      if (notices.length) return { status: task.status, task, notices };
      const remaining = deadline - this.waitNow();
      if (remaining <= 0) return elapsed(task, notices);
      await this.waitPoll(Math.min(25, remaining), caller.signal);
      task = this.ownedCaptainTask(task.id, caller);
    }
    caller.signal.throwIfAborted();
    if (task.status === "cancelled")
      return {
        status: task.status,
        task,
        notices: this.state.notices(task.id, after),
      };
    const controller = new AbortController();
    let idle = false;
    let failed = false;
    let observed: Promise<void> | undefined;
    try {
      for (;;) {
        caller.signal.throwIfAborted();
        let current = this.ownedCaptainTask(task.id, caller);
        const abandoned = this.abandoned(current, after);
        if (abandoned) return abandoned;
        const piWorker = Boolean(this.member(current.crewID).backend);
        if (piWorker) current = await this.piRecover(current, caller.signal);
        caller.signal.throwIfAborted();
        if (
          !piWorker &&
          (current.status === "uncertain" || (this.connectResults && idle))
        ) {
          const recovered = await this.reconcileResult(current, caller, idle);
          caller.signal.throwIfAborted();
          current = recovered.task;
          if (current.status === "completed" || current.status === "uncertain")
            return {
              status: current.status,
              ...recovered,
              notices: this.state.notices(task.id, after),
            };
        }
        const notices = this.state.notices(task.id, after);
        if (caller.signal.aborted) {
          await this.cancel(current, caller);
          throw new CrewError(this.cancelled(task.id));
        }
        if (
          current.status === "completed" ||
          current.status === "uncertain" ||
          notices.length
        )
          return { status: current.status, task: current, notices };
        // A concurrent promotion reserves dispatching before SDK admission.
        // Observe idle only after admission; pre-admission idle is expected.
        if (current.status === "running" && !observed && !piWorker)
          observed = this.sessions
            .wait(
              { sessionID: task.workerSessionID },
              {
                signal: AbortSignal.any([caller.signal, controller.signal]),
              },
            )
            .then(
              () => {
                idle = true;
              },
              () => {
                failed = true;
              },
            );
        if (idle || failed) {
          this.state.uncertain(task.id);
          if (this.connectResults)
            return {
              status: "uncertain",
              task: this.state.task(task.id) ?? current,
              notices,
              diagnostic: `Task ${task.id}, worker ${task.workerSessionID}: Native execution observation failed. Retry status to recover the retained answer when the existing OpenCode server is available; do not resubmit the assignment.`,
            };
          throw new CrewError(
            "Worker ended or became unavailable without a confirmed result; task outcome uncertain.",
          );
        }
        const remaining = deadline - this.waitNow();
        if (remaining <= 0) return elapsed(current, notices);
        await this.waitPoll(Math.min(25, remaining), caller.signal);
      }
    } catch (error) {
      if (caller.signal.aborted) {
        await this.cancel(task, caller);
        throw new CrewError(this.cancelled(task.id));
      }
      throw error;
    } finally {
      controller.abort();
      await observed;
    }
  }

  private async reconcileResult(
    task: CrewTask,
    caller: CrewCaller,
    knownIdle = false,
  ): Promise<{ task: CrewTask; diagnostic?: string }> {
    if (this.member(task.crewID).backend)
      return { task: await this.piRecover(task, caller.signal) };
    let readmission: string | undefined;
    if (task.status === "uncertain" && !knownIdle) {
      const readmitted = await this.readmitUncertain(task, caller);
      if (readmitted.task.status === "running") return readmitted;
      readmission = readmitted.diagnostic;
    }
    const connect = this.connectResults;
    if (
      !connect ||
      this.member(task.crewID).backend ||
      (task.status !== "running" && task.status !== "uncertain") ||
      task.released
    )
      return { task, ...(readmission ? { diagnostic: readmission } : {}) };
    const signal = AbortSignal.any([
      caller.signal,
      AbortSignal.timeout(10_000),
    ]);
    try {
      const peer = this.state.peer(task.crewID);
      if (!peer || peer.sessionID !== task.workerSessionID)
        throw new CrewError(
          "Worker reservation differs from this task. Restore its original session mapping before retrying status.",
        );
      if (!knownIdle && !(await this.idle(peer, signal))) {
        caller.signal.throwIfAborted();
        return { task };
      }
      signal.throwIfAborted();
      const session = await this.sessions.get(
        { sessionID: peer.sessionID },
        { signal },
      );
      this.validPeer(session, peer);
      if (session.outcome !== "succeeded")
        throw new CrewError(
          `Worker is idle with outcome ${session.outcome ?? "unknown"}. Resume the existing task session and retry status after a successful final answer; do not resubmit the assignment.`,
        );
      const connection: Promise<ResultAPI> = connect(session, signal);
      const api = await connection;
      const result = await readTaskResult(
        api,
        task,
        signal,
        this.member(task.crewID).agent ?? task.crewID,
      );
      signal.throwIfAborted();
      return { task: this.state.recoverResult(task, result) };
    } catch (error) {
      caller.signal.throwIfAborted();
      const current = this.state.task(task.id) ?? task;
      if (current.status === task.status && !current.released)
        this.state.uncertain(task.id);
      const detail =
        error instanceof CrewError
          ? error.message
          : "Authenticated result API unavailable or timed out. Retry status; if it persists, configure team.historyAPI for the existing OpenCode server.";
      return {
        task: this.state.task(task.id) ?? current,
        diagnostic: `Task ${task.id}, worker ${task.workerSessionID}: ${detail}`,
      };
    }
  }

  private async urgent(
    input: Extract<CrewInput, { op: "urgent" }>,
    caller: CrewCaller,
  ): Promise<CrewResult> {
    const receipt = await this.dm(
      {
        op: "send",
        taskID: input.taskID,
        to: input.to,
        text: input.text,
        delivery: "steer",
      },
      caller,
    );
    const status =
      "notification" in receipt ? (receipt.notification ?? "stored") : "stored";
    return {
      status:
        status === "accepted"
          ? input.to === "captain" || input.to === this.options.team.captain.id
            ? "mailed"
            : "steered"
          : status,
    };
  }

  close() {
    this.closing ??= (async () => {
      try {
        await this.reporting.close();
      } finally {
        try {
          await this.pi.close();
        } finally {
          this.state.close();
        }
      }
    })();
    return this.closing;
  }
}
