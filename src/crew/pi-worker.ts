import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentBackend, BackendContext } from "../backend";
import type { BackendConfig } from "../config";
import { CrewError, type CrewState, type CrewTask, type Peer } from "./state";
import type { CrewMember } from "./team";

type PiConfig = Extract<BackendConfig, { type: "pi-durable" }>;
export interface PiWorkerBackend extends AgentBackend {
  /** Same crew slot, but enforced tools-off and input-only model context.
   * Absence fails closed; normal maintenance prompt is never a fallback.
   */
  promptReport?(
    sessionID: string,
    text: string,
    signal: AbortSignal,
  ): Promise<string>;
}
export type PiWorkerFactory = (
  config: PiConfig,
  context: BackendContext,
) => Promise<PiWorkerBackend>;
type Execution = { controller: AbortController; done: Promise<void> };
// All location plugins in this process observe the same in-flight execution.
const executions = new Map<string, Execution>();

const maintenanceInstructions = `You are a captain-managed maintenance worker.
Perform only the assigned task in your worktree. Read AGENTS.md first.
Preserve unrelated changes, credentials, runtime state and user files.
Do not delete files or data, reset Git, or stop services without
explicit operator approval relayed by the captain. If approval is absent, report the
proposed action and stop. Never message Slack, create agents, or start work
outside this assignment. Return a concise result, changed files, checks and
blockers to the captain. Do not expose private reasoning or secrets.`;

export class PiCrewWorkers {
  private readonly backends = new Map<string, Promise<PiWorkerBackend>>();
  private readonly owned = new Set<Execution>();
  private closed = false;

  constructor(
    private readonly state: CrewState,
    private readonly stateDirectory: string,
    private readonly factory: PiWorkerFactory = async (config, context) => {
      const { PiDurableBackend } = await import("../backends/pi-durable");
      return PiDurableBackend.open(config, context);
    },
  ) {}

  private key(peer: Peer): string {
    return `${this.state.path}:${peer.sessionID}`;
  }

  private backend(
    member: CrewMember,
    directory: string,
  ): Promise<PiWorkerBackend> {
    if (this.closed) throw new CrewError("Pi crew runtime is closing.");
    const definition = member.backend;
    if (!definition) throw new CrewError("Worker is not a Pi worker.");
    let backend = this.backends.get(member.id);
    if (!backend) {
      backend = (async () => {
        const hash = createHash("sha256").update(member.id).digest("hex");
        const dataDirectory = join(this.stateDirectory, "pi", hash);
        await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
        await chmod(dataDirectory, 0o700);
        return this.factory(
          {
            ...definition,
            directory,
            systemPrompt: [
              maintenanceInstructions,
              `Name: ${member.name ?? member.id}. Role: ${member.role}.`,
              definition.systemPrompt,
              member.instructions,
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
          { dataDirectory },
        );
      })();
      this.backends.set(member.id, backend);
    }
    return backend;
  }

  async ensure(
    member: CrewMember,
    directory: string,
    peer: Peer,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const saved = this.state.piPeer(peer.sessionID);
    if (saved?.conversationID) return;
    if (saved || peer.status === "ready")
      throw new CrewError(
        "Pi conversation creation is unconfirmed. Inspect private Pi state; automatic recreation is disabled.",
      );
    const backend = await this.backend(member, directory);
    signal.throwIfAborted();
    if (!this.state.reservePiPeer(peer.sessionID))
      throw new CrewError(
        "Pi conversation creation is already reserved; retry ensure to inspect it.",
      );
    try {
      const conversationID = await backend.createSession({
        key: peer.sessionID,
        title: member.name ?? member.id,
        signal,
      });
      this.state.readyPiPeer(peer.sessionID, conversationID);
    } catch {
      throw new CrewError(
        "Pi conversation creation is unconfirmed. Inspect private Pi state; automatic recreation is disabled.",
      );
    }
  }

  reconcile(task: CrewTask): CrewTask {
    if (
      (task.status === "running" || task.status === "dispatching") &&
      !executions.has(`${this.state.path}:${task.workerSessionID}`)
    ) {
      this.state.uncertain(task.id);
    }
    return this.state.task(task.id) ?? task;
  }

  idle(peer: Peer): boolean {
    return !executions.has(this.key(peer));
  }

  async canReport(member: CrewMember, directory: string): Promise<boolean> {
    return (
      typeof (await this.backend(member, directory)).promptReport === "function"
    );
  }

  start(
    member: CrewMember,
    directory: string,
    peer: Peer,
    task: CrewTask,
    text: string,
  ) {
    if (this.closed || !this.idle(peer))
      throw new CrewError("Pi worker is busy or closing.");
    const conversationID = this.state.piPeer(peer.sessionID)?.conversationID;
    if (!conversationID)
      throw new CrewError("Pi worker has no confirmed conversation.");
    const execution: Execution = {
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    executions.set(this.key(peer), execution);
    this.owned.add(execution);
    this.state.running(task.id);
    execution.done = (async () => {
      const signal = AbortSignal.any([
        execution.controller.signal,
        AbortSignal.timeout(300_000),
      ]);
      try {
        const backend = await this.backend(member, directory);
        signal.throwIfAborted();
        const isReport = this.state.reporting.isReport(task.id);
        if (isReport && !backend.promptReport)
          throw new CrewError("Pi backend cannot enforce read-only reporting.");
        const answer =
          isReport && backend.promptReport
            ? await backend.promptReport(conversationID, text, signal)
            : await backend.prompt(
                conversationID,
                `Captain assignment ${task.id}:\n\n${text}`,
                signal,
              );
        signal.throwIfAborted();
        this.state.complete(
          task.id,
          peer.sessionID,
          answer.trim().slice(0, 64000) ||
            "Worker finished without a text result.",
        );
      } catch {
        this.state.uncertain(task.id);
      } finally {
        executions.delete(this.key(peer));
        this.owned.delete(execution);
      }
    })();
  }

  async interrupt(peer: Peer) {
    const execution = executions.get(this.key(peer));
    if (execution) {
      execution.controller.abort();
      await execution.done;
    }
  }

  async close() {
    this.closed = true;
    const running = [...this.owned];
    for (const execution of running) execution.controller.abort();
    await Promise.all(running.map(({ done }) => done));
    await Promise.allSettled(
      [...this.backends.values()].map(async (opened) => {
        const backend = await opened;
        await backend.close();
      }),
    );
  }
}
