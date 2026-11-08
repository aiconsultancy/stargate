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
import { z } from "zod";
import type { CrewStatus, CrewStatusInput } from "../crew-status";
import { MesijClient, type MesijMessage } from "./mesij";
import { CrewMessaging, type MailRoute, mailInputSchema } from "./messaging";

export { mailInputSchema } from "./messaging";

import { journalInputSchema } from "./journal";
import { PiCrewWorkers, type PiWorkerFactory } from "./pi-worker";
import { crewPermissions } from "./policy";
import {
  type ExecutionInspection,
  type InspectInput,
  type InspectionConnector,
  inspectInputSchema,
  observeExecution,
  type ReconcileInput,
  reconcileInputSchema,
  requireQuiescent,
  sha256,
  verifyResult,
} from "./reconciliation";
import { CrewReporter, redactActivity } from "./reporting";
import { type ResultAPI, readTaskResult } from "./result";
import {
  CrewError,
  type CrewID,
  type CrewNotice,
  CrewState,
  type CrewTask,
  type Peer,
  type TaskReconciliation,
} from "./state";
import {
  agentIDSchema,
  type CrewMember,
  defaultTeam,
  teamSchema,
} from "./team";

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
    team: teamSchema.optional(),
    allowCrewExpansion: z.boolean().optional(),
    mesijCommand: directory,
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
  reconcileInputSchema,
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
  [piIdentity]?: true;
};
export type CrewSession = Pick<
  SessionInfo,
  "id" | "parentID" | "agent" | "location" | "metadata" | "outcome"
> & {
  time?: Pick<SessionInfo["time"], "updated" | "busy" | "idle">;
};
export type ResultConnector = (
  session: CrewSession,
  signal: AbortSignal,
) => Promise<ResultAPI>;
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
  diagnostic?: string;
  peers?: Peer[];
  task?: CrewTask;
  notices?: CrewNotice[];
  members?: ReturnType<CrewEngine["roster"]>;
  active?: TaskInspection | null;
  inspectedTask?: TaskInspection | null;
  queued?: TaskInspection[];
  controlled?: boolean;
  execution?:
    | ExecutionInspection
    | { state: "idle" | "running"; backend: "pi" };
  reconciliation?: TaskReconciliation | null;
  statusRequest?: { id: string; sequence: number };
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

export class CrewEngine {
  private readonly pi: PiCrewWorkers;
  readonly reporting: CrewReporter;
  private closing?: Promise<void>;
  private constructor(
    readonly options: CrewOptions & { team: NonNullable<CrewOptions["team"]> },
    readonly state: CrewState,
    private readonly sessions: CrewSessions,
    private readonly mailer: Pick<MesijClient, "register" | "send" | "inbox">,
    private readonly agents?: CrewAgents,
    piFactory?: PiWorkerFactory,
    private readonly inspectionConnector?: InspectionConnector,
    private readonly connectResults?: ResultConnector,
  ) {
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
            if (name === "pogo_journal") return this.journal(input, caller);
            if (name === "pogo_mail") return this.mail(input, caller);
            if (name === "pogo_dm") return this.dm(input, caller);
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
  }

  /** Location-authorized read surface. Unlike tool status, never reconciles,
   * promotes queued work, provisions peers, reads transcripts or invokes models.
   */
  status(input: CrewStatusInput = {}): CrewStatus {
    const members = this.options.team.crew.filter(
      ({ id }) => !input.member || input.member === id,
    );
    return {
      members: members.slice(0, 20).map((member) => {
        const peer = this.state.peer(member.id);
        const task = this.state.activeTask(member.id);
        const current = task && task.status !== "completed" ? task : null;
        return {
          id: member.id,
          name: redactActivity(member.name ?? member.id, 100),
          backend: member.backend ? "pi-durable" : "opencode",
          provisioned: peer?.status ?? "unprovisioned",
          observed: !!current && !!member.backend && this.pi.observed(current),
          current: current ? this.state.activity.task(current) : null,
          ...this.state.activity.read(member.id),
        };
      }),
      total: members.length,
      truncated: members.length > 20,
    };
  }

  static async open(
    input: unknown,
    sessions: CrewSessions,
    mailer?: Pick<MesijClient, "register" | "send" | "inbox">,
    agents?: CrewAgents,
    piFactory?: PiWorkerFactory,
    inspectionConnector?: InspectionConnector,
    connectResults?: ResultConnector,
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
    const fingerprint = JSON.stringify({
      version: 2,
      namespace: options.namespace,
      projectDirectory: resolve(options.projectDirectory),
      captain: {
        id: options.team.captain.id,
        directory: resolve(options.captainDirectory),
      },
      crew: options.team.crew
        .map(({ id, permissionProfile, backend }) => ({
          id,
          permissionProfile,
          directory: resolve(options.worktrees[id] ?? ""),
          ...(backend ? { backend } : {}),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
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
    );
  }

  private actor(sessionID: string): string {
    const role =
      this.state.peerBySession(sessionID)?.crewID ??
      `${this.options.team.captain.id}:${sessionID}`;
    const namespace = createHash("sha256")
      .update(this.options.namespace)
      .digest("hex");
    return `pogo:${namespace}:${role}`;
  }

  mailActor(sessionID: string) {
    return this.actor(sessionID);
  }

  mailTask(
    caller: CrewCaller,
    id?: string,
    historical = false,
  ): CrewTask | null {
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
    if (!input.success) throw new CrewError("Invalid pogo_mail input.");
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
    const peer = this.state.peerBySession(route.recipient);
    const task = peer ? this.state.activeTask(peer.crewID) : null;
    if (peer?.status !== "ready" && peer) return "unavailable";
    if (
      peer &&
      (this.state.controlled(peer.crewID) ||
        this.state.hasQueued(peer.crewID) ||
        (task &&
          ((task.status !== "completed" &&
            task.originCaptainID !== route.captainID) ||
            !["running", "dispatching", "completed"].includes(task.status) ||
            task.notifying)))
    )
      return "deferred";
    const busy =
      task && ["running", "dispatching"].includes(task.status) ? task : null;
    const senderCaptainID =
      caller.agent === this.options.team.captain.id
        ? caller.sessionID
        : this.mailTask(caller)?.originCaptainID;
    if (busy && senderCaptainID !== route.captainID) return "deferred";
    if (busy && delivery === "queue" && !this.member(busy.crewID).backend)
      return "unsupported";
    const framing = `Pogo DM ${route.id} from ${caller.agent}.\n${text}\n\nReply through pogo_mail or pogo_dm with replyTo=${route.id}; a final answer is not a peer reply.${busy ? ` Your final answer remains task ${busy.id}'s result; restate it if you had already finished.` : ""}`;
    if (!peer && route.sourceTaskID) {
      const source = this.state.task(route.sourceTaskID);
      if (source?.originCaptainID === route.recipient)
        this.state.noticeOnce(route.id, source.id, framing);
    }
    if (busy && !this.state.beginNotify(busy.id)) return "deferred";
    let control: string | undefined;
    try {
      if (peer && !busy) {
        control = this.state.reserveControl(peer.crewID);
        if (!(await this.idle(peer, caller.signal))) return "deferred";
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
      if (peer)
        this.validPeer(
          await this.sessions.get(
            { sessionID: peer.sessionID },
            { signal: caller.signal },
          ),
          peer,
        );
      await this.sessions.synthetic(
        {
          sessionID: route.recipient,
          id: `msg_${route.id}`,
          text: framing,
          description: "Crew direct message",
          metadata: {
            pogoCrew: {
              ...(busy ? { taskID: busy.id } : {}),
              ...(route.sourceTaskID
                ? { sourceTaskID: route.sourceTaskID }
                : {}),
              originCaptainID: route.captainID,
              messageID: route.id,
            },
          },
          delivery,
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
    const input = journalInputSchema.safeParse(raw);
    if (!input.success) throw new CrewError("Invalid pogo_journal input.");
    await this.authorize(caller);
    const task = this.mailTask(caller);
    const captainID =
      caller.agent === this.options.team.captain.id
        ? caller.sessionID
        : (task?.originCaptainID ?? "");
    const store = this.state.reporting.journal;
    if (input.data.op === "read")
      return {
        ...store.read(
          captainID,
          input.data.after,
          input.data.limit,
          captainID ? input.data.member : caller.agent,
        ),
        entry: undefined,
      };
    if (!caller.id)
      throw new CrewError("Journal append requires a host tool-call identity.");
    const entry = store.append(
      {
        member: caller.agent,
        captainID,
        taskID: task?.id ?? null,
        kind: "note",
        text: input.data.text,
      },
      `${caller.sessionID}:${caller.id}`,
    );
    return { entry, entries: [entry], nextAfter: entry.id, truncated: false };
  }

  private async legacyMail(raw: unknown, caller: CrewCaller) {
    const parsed = legacyMailInputSchema.safeParse(raw);
    if (!parsed.success)
      throw new CrewError(
        "Invalid pogo_mail input. Supply a task ID and the operation's declared fields.",
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
          (source.originCaptainID !== caller.sessionID &&
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
    if (!parsed.success)
      throw new CrewError(
        "Invalid pogo_crew input. Use the operation's declared fields.",
      );
    const input = parsed.data;
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
      if (this.member(task.crewID).backend) task = this.pi.reconcile(task);
      if (task.status === "queued") task = await this.promote(task, caller);
      if (input.op === "status") {
        const recovered = await this.reconcileResult(task, caller);
        return {
          status: recovered.task.status,
          ...recovered,
          notices: this.state.notices(task.id, 0),
        };
      }
      return await this.wait(task, input.afterNoticeID, caller);
    } catch (error) {
      if (
        input.op === "wait" &&
        authorized &&
        caller.agent === this.options.team.captain.id &&
        caller.signal.aborted
      ) {
        const task = this.ownedCaptainTask(input.taskID, caller);
        await this.cancel(task, caller);
        throw new CrewError(
          this.state.task(task.id)?.status === "cancelled"
            ? "Wait cancelled; queued task cancelled without interrupting the worker."
            : "Wait cancelled; task outcome uncertain. Inspect worker before further work.",
        );
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
    const session = await this.sessions.get(
      { sessionID: caller.sessionID },
      { signal: caller.signal },
    );
    if (
      session.parentID ||
      session.id !== caller.sessionID ||
      ![
        this.options.team.captain.agent ?? this.options.team.captain.id,
        this.options.team.captain.id,
      ].includes(session.agent ?? "") ||
      resolve(session.location.directory) !==
        resolve(this.options.captainDirectory)
    )
      throw new CrewError(
        "Captain must be a root configured captain session in the configured project directory.",
      );
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

  async withWorkerControl<T>(
    crewID: string,
    caller: CrewCaller,
    operation: (peer: Peer) => Promise<T>,
  ): Promise<T> {
    await this.captain(caller);
    if (this.member(crewID).backend)
      throw new CrewError(
        "Pi worker compaction and live model switching are not supported.",
      );
    const peer = await this.ensure(crewID, caller.signal);
    const active = this.state.activeTask(crewID);
    if (
      active &&
      active.status !== "completed" &&
      active.originCaptainID !== caller.sessionID
    )
      throw new CrewError("This crew member is busy for another captain.");
    const token = this.state.reserveControl(crewID);
    try {
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
    const metadata = session.metadata?.["pogoCrew"];
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
            title: `Pogo ${crewID}`,
            location: { directory: worktree },
            metadata: {
              pogoCrew: { namespace: this.options.namespace, crewID },
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
    if (!task || task.originCaptainID !== caller.sessionID)
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

  private async inspectionAPI(caller: CrewCaller) {
    if (!this.inspectionConnector)
      throw new CrewError(
        "Authenticated inspection API unavailable; configure this team's same-server history API. No state changed.",
      );
    const native = await this.sessions.get(
      { sessionID: caller.sessionID },
      { signal: caller.signal },
    );
    return this.inspectionConnector(native, caller.signal);
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
      reconciliation: selected ? this.state.reconciliation(selected.id) : null,
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
    const api = await this.inspectionAPI(caller);
    const live = await observeExecution(api, peer.sessionID, caller.signal);
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
            text: `Status request for task ${task.id}. Reply using pogo_mail send to=captain with this message's id as replyTo. Report status/evidence only; do not resume or replay work.`,
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

  private async dispatch(
    input: Extract<CrewInput, { op: "dispatch" }>,
    caller: CrewCaller,
  ): Promise<CrewResult> {
    const peer = await this.ensure(input.crew, caller.signal);
    let active = this.state.activeTask(input.crew);
    const recovered = active
      ? await this.reconcileResult(active, caller)
      : undefined;
    if (recovered) active = recovered.task;
    const busy: CrewResult = {
      status: "busy",
      ...(active?.originCaptainID === caller.sessionID
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
              task: this.state.enqueue(peer, caller.sessionID, input.text),
            }
          : busy;
      }
      if (!this.state.release(active.id))
        return input.queue
          ? {
              status: "queued",
              task: this.state.enqueue(peer, caller.sessionID, input.text),
            }
          : busy;
    }
    if (!active && !(await this.idle(peer, caller.signal))) {
      caller.signal.throwIfAborted();
      return input.queue
        ? {
            status: "queued",
            task: this.state.enqueue(peer, caller.sessionID, input.text),
          }
        : busy;
    }
    caller.signal.throwIfAborted();
    const task = this.state.reserveTask(peer, caller.sessionID, input.text);
    if (!task)
      return input.queue
        ? {
            status: "queued",
            task: this.state.enqueue(peer, caller.sessionID, input.text),
          }
        : { status: "busy" };
    return this.admit(task, input.text, caller);
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
            `Pogo task envelope: ${envelope}\n\n${text}\n\n` +
            `Return a final answer for only this assignment. You may also use pogo_crew ` +
            `op=complete, taskID=${task.id}, result=<your result>. ` +
            "Do not create peer/root sessions or send prompts to captains. " +
            "Use pogo_crew urgent for task-scoped urgent communication.",
          metadata: {
            pogoCrew: {
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
      if (caller.signal.aborted) await this.cancel(task, caller);
      this.state.uncertain(task.id);
      throw new CrewError(
        `Task ${task.id} admission uncertain. Inspect worker ${task.workerSessionID}; work will not be replayed automatically.`,
      );
    }
  }

  private async cancel(task: CrewTask, caller: CrewCaller) {
    if (this.state.cancelQueued(task.id, caller.sessionID)) return;
    if (!this.state.beginCancel(task.id, caller.sessionID)) return;
    try {
      if (this.member(task.crewID).backend) {
        const peer = this.state.peer(task.crewID);
        if (peer) await this.pi.interrupt(peer);
        return;
      }
      await this.sessions.interrupt(
        { sessionID: task.workerSessionID, resume: false },
        {
          signal: AbortSignal.timeout(5000),
        },
      );
    } catch {
      // Interruption can fail independently; keep the reservation uncertain.
    } finally {
      this.state.uncertain(task.id);
    }
  }

  /** Report tasks use the same slot/FIFO, but never join activity collection. */
  async reporterFree(id: string, signal: AbortSignal): Promise<boolean> {
    const member = this.options.team.crew.find((member) => member.id === id);
    const directory = this.options.worktrees[id];
    if (
      !member?.backend ||
      !directory ||
      this.state.controlled(id) ||
      this.state.hasQueued(id)
    )
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
        this.state.cancelQueued(task.id, caller.sessionID);
        throw new CrewError(
          "Activity reporter unavailable: Pi backend cannot enforce tools-off, capture-only reporting; maintenance was not run.",
        );
      }
      // Cancellation can occur while opening the backend. Recheck before any
      // durable admission; a cancelled queued report must not start maintenance.
      caller.signal.throwIfAborted();
      await this.promote(this.ownedCaptainTask(task.id, caller), caller);
    } else this.reportingTask(task.id);
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
  ): Promise<CrewResult> {
    // Queued waits do not observe/interrupt the different task occupying this slot.
    while (task.status === "queued") {
      caller.signal.throwIfAborted();
      task = await this.promote(task, caller);
      if (task.status !== "queued") break;
      await delay(25, undefined, { signal: caller.signal });
      task = this.ownedCaptainTask(task.id, caller);
    }
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
        let current = this.ownedCaptainTask(task.id, caller);
        const piWorker = Boolean(this.member(current.crewID).backend);
        if (piWorker) current = this.pi.reconcile(current);
        if (
          this.connectResults &&
          !piWorker &&
          (current.status === "uncertain" || idle)
        ) {
          const recovered = await this.reconcileResult(current, caller, idle);
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
          throw new CrewError(
            "Wait cancelled; task outcome uncertain. Inspect worker before further work.",
          );
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
        await delay(25, undefined, { signal: caller.signal });
      }
    } catch (error) {
      if (caller.signal.aborted) {
        await this.cancel(task, caller);
        throw new CrewError(
          "Wait cancelled; task outcome uncertain. Inspect worker before further work.",
        );
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
    const connect = this.connectResults;
    if (
      !connect ||
      this.member(task.crewID).backend ||
      (task.status !== "running" && task.status !== "uncertain") ||
      task.released
    )
      return { task };
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
