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
import { MesijClient } from "./mesij";
import { crewPermissions } from "./policy";
import {
  CrewError,
  type CrewID,
  type CrewNotice,
  CrewState,
  type CrewTask,
  type Peer,
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
export const mailInputSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("send"),
    taskID,
    to: agentIDSchema,
    text,
    key: z.string().min(1).max(100),
    replyTo: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
  }),
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
});
export type CrewCaller = {
  sessionID: string;
  agent: string;
  signal: AbortSignal;
};
export type CrewSession = Pick<
  SessionInfo,
  "id" | "parentID" | "agent" | "location" | "metadata"
>;
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
  peers?: Peer[];
  task?: CrewTask;
  notices?: CrewNotice[];
};

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

export class CrewEngine {
  private constructor(
    readonly options: CrewOptions & { team: NonNullable<CrewOptions["team"]> },
    readonly state: CrewState,
    private readonly sessions: CrewSessions,
    private readonly mailer: Pick<MesijClient, "register" | "send" | "inbox">,
    private readonly agents?: CrewAgents,
  ) {}

  static async open(
    input: unknown,
    sessions: CrewSessions,
    mailer?: Pick<MesijClient, "register" | "send" | "inbox">,
    agents?: CrewAgents,
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
        .map(({ id, permissionProfile }) => ({
          id,
          permissionProfile,
          directory: resolve(options.worktrees[id] ?? ""),
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

  async mail(raw: unknown, caller: CrewCaller) {
    const parsed = mailInputSchema.safeParse(raw);
    if (!parsed.success)
      throw new CrewError(
        "Invalid pogo_mail input. Supply a task ID and the operation's declared fields.",
      );
    const input = parsed.data;
    try {
      await this.authorize(caller);
      if (input.op === "send" && input.to !== "captain") this.member(input.to);
      let source: CrewTask;
      if (caller.agent === this.options.team.captain.id) {
        await this.captain(caller);
        source = this.ownedCaptainTask(input.taskID, caller);
      } else source = this.ownedWorkerTask(input.taskID, caller);
      if (source.status === "queued" || source.status === "cancelled")
        throw new CrewError(
          "Queued or cancelled work has no active mail lineage.",
        );
      const actor = this.actor(caller.sessionID);
      await this.mailer.register(actor, caller.sessionID, caller.signal);
      if (input.op === "send") {
        const target =
          input.to === "captain" ? source : this.state.activeTask(input.to);
        if (!target || target.originCaptainID !== source.originCaptainID)
          throw new CrewError(
            "Mail recipient must have an active task in the same captain lineage.",
          );
        if (input.to !== "captain") await this.ensure(input.to, caller.signal);
        const recipient =
          input.to === "captain"
            ? source.originCaptainID
            : target.workerSessionID;
        await this.mailer.register(
          this.actor(recipient),
          recipient,
          caller.signal,
        );
        const receipt = await this.mailer.send(
          {
            actor,
            sessionID: caller.sessionID,
            to: recipient,
            text: JSON.stringify({
              namespace: this.options.namespace,
              sourceTaskID: source.id,
              targetTaskID: target.id,
              originCaptainID: source.originCaptainID,
              sender: caller.sessionID,
              recipient,
              text: input.text,
            }),
            key: createHash("sha256")
              .update(
                JSON.stringify([
                  this.options.namespace,
                  source.id,
                  target.id,
                  caller.sessionID,
                  recipient,
                  input.key,
                ]),
              )
              .digest("hex"),
            ...(input.replyTo ? { replyTo: input.replyTo } : {}),
          },
          caller.signal,
        );
        return { status: "sent", ...receipt };
      }
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
        if (
          !origin ||
          mail.namespace !== this.options.namespace ||
          mail.originCaptainID !== source.originCaptainID ||
          origin.originCaptainID !== source.originCaptainID ||
          mail.targetTaskID !== source.id ||
          mail.recipient !== caller.sessionID ||
          mail.sender !== event.sessionID ||
          event.actor !== this.actor(mail.sender) ||
          (mail.sender !== origin.originCaptainID &&
            mail.sender !== origin.workerSessionID)
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
      if ("crew" in input && input.crew) this.member(input.crew);
      if (input.op === "urgent" && input.to !== "captain")
        this.member(input.to);
      if (input.op === "complete") {
        const task = this.ownedWorkerTask(input.taskID, caller);
        this.state.complete(task.id, caller.sessionID, input.result);
        return { status: "completed" };
      }
      if (input.op === "urgent") return await this.urgent(input, caller);
      await this.captain(caller);
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
      if (task.status === "queued") task = await this.promote(task, caller);
      if (input.op === "status")
        return {
          status: task.status,
          task,
          notices: this.state.notices(task.id, 0),
        };
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
      session.agent !== this.options.team.captain.id ||
      resolve(session.location.directory) !==
        resolve(this.options.captainDirectory)
    )
      throw new CrewError(
        "Captain must be a root configured captain session in the configured project directory.",
      );
  }

  async authorize(caller: CrewCaller): Promise<void> {
    if (caller.agent === this.options.team.captain.id)
      return this.captain(caller);
    const peer = this.state.peerBySession(caller.sessionID);
    if (!peer || caller.agent !== peer.crewID)
      throw new CrewError(
        "Only the configured captain or assigned worker may use crew operations.",
      );
    this.member(peer.crewID);
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
    this.member(crewID);
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
    const metadata = session.metadata?.pogoCrew;
    if (
      session.id !== peer.sessionID ||
      session.parentID ||
      session.agent !== peer.crewID ||
      resolve(session.location.directory) !==
        resolve(this.options.worktrees[peer.crewID] ?? "") ||
      typeof metadata !== "object" ||
      metadata === null ||
      Array.isArray(metadata) ||
      metadata.namespace !== this.options.namespace ||
      metadata.crewID !== peer.crewID
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
            agentID: crewID,
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
            agent: crewID,
            title: `Pogo ${crewID}`,
            location: { directory: worktree },
            metadata: {
              pogoCrew: { namespace: this.options.namespace, crewID },
            },
            permissions: crewPermissions(member.permissionProfile),
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

  private async dispatch(
    input: Extract<CrewInput, { op: "dispatch" }>,
    caller: CrewCaller,
  ): Promise<CrewResult> {
    const peer = await this.ensure(input.crew, caller.signal);
    const active = this.state.activeTask(input.crew);
    const busy: CrewResult = {
      status: "busy",
      ...(active?.originCaptainID === caller.sessionID ? { task: active } : {}),
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
    const task = this.state.reserveTask(peer, caller.sessionID);
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
    const active = this.state.activeTask(task.crewID);
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
            `Complete only this assignment with pogo_crew ` +
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
    const observed = this.sessions
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
    try {
      for (;;) {
        const current = this.ownedCaptainTask(task.id, caller);
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
        if (idle || failed) {
          this.state.uncertain(task.id);
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

  private async urgent(
    input: Extract<CrewInput, { op: "urgent" }>,
    caller: CrewCaller,
  ): Promise<CrewResult> {
    let source: CrewTask;
    if (caller.agent === this.options.team.captain.id) {
      await this.captain(caller);
      source = this.ownedCaptainTask(input.taskID, caller);
    } else source = this.ownedWorkerTask(input.taskID, caller);
    if (source.status !== "running" && source.status !== "dispatching")
      throw new CrewError("Urgency requires an active task lineage.");
    if (input.to === "captain") {
      this.state.notice(source.id, input.text);
      return { status: "mailed" };
    }
    const target = this.state.activeTask(input.to);
    if (
      !target ||
      target.originCaptainID !== source.originCaptainID ||
      !this.state.beginNotify(target.id)
    )
      throw new CrewError(
        "Colleague urgency requires an active task in the same captain lineage.",
      );
    try {
      await this.ensure(input.to, caller.signal);
      await this.sessions.synthetic(
        {
          sessionID: target.workerSessionID,
          text: `Pogo urgent notice for task ${target.id}; source task ${source.id}.\n${input.text}`,
          description: "Task-scoped crew urgency",
          metadata: {
            pogoCrew: {
              taskID: target.id,
              sourceTaskID: source.id,
              originCaptainID: source.originCaptainID,
            },
          },
          delivery: "steer",
          resume: true,
        },
        { signal: caller.signal },
      );
      return { status: "steered" };
    } catch {
      this.state.uncertain(target.id);
      throw new CrewError(
        "Urgent delivery uncertain. Inspect worker session; notice was not automatically replayed.",
      );
    } finally {
      this.state.endNotify(target.id);
    }
  }

  close() {
    this.state.close();
  }
}
