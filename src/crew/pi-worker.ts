import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentBackend, BackendContext, TextSink } from "../backend";
import type { BackendConfig } from "../config";
import { piDefinitionPath, piMemberDefinition } from "./instructions";
import type { PiCrewBinding } from "./pi-extension";
import { redactActivity } from "./reporting";
import { CrewError, type CrewState, type CrewTask, type Peer } from "./state";
import type { CrewMember } from "./team";

type PiConfig = Extract<BackendConfig, { type: "pi-durable" }>;
export interface PiWorkerBackend extends AgentBackend {
  waitForIdle?(sessionID: string, signal: AbortSignal): Promise<void>;
  notify?(
    sessionID: string,
    id: string,
    text: string,
    delivery: "steer" | "queue",
    signal: AbortSignal,
  ): Promise<void>;
  /** Internal Pi result selection: visible progress is separate from the final
   * answer persisted as this task's canonical result. Slack keeps its default.
   */
  prompt(
    sessionID: string,
    text: string,
    signal: AbortSignal,
    onText?: TextSink,
    result?: "final",
  ): Promise<string>;
  /** Same crew slot, but enforced tools-off and input-only model context.
   * Absence fails closed; normal maintenance prompt is never a fallback.
   */
  promptReport?(
    sessionID: string,
    text: string,
    signal: AbortSignal,
    onText?: TextSink,
  ): Promise<string>;
}
export type PiWorkerFactory = (
  config: PiConfig,
  context: BackendContext,
) => Promise<PiWorkerBackend>;
type Execution = {
  taskID: string;
  controller: AbortController;
  done: Promise<void>;
};
// All location plugins in this process observe the same in-flight execution.
const executions = new Map<string, Execution>();
const notifications = new Set<string>();
type Pooled = { backend: Promise<PiWorkerBackend>; owners: Set<PiCrewWorkers> };
const pool = new Map<string, Pooled>();

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
  private readonly leases = new Set<string>();
  private readonly owned = new Set<Execution>();
  private closed = false;

  constructor(
    private readonly state: CrewState,
    private readonly stateDirectory: string,
    private readonly factory: PiWorkerFactory = async (config, context) => {
      const { PiDurableBackend } = await import("../backends/pi-durable");
      return PiDurableBackend.open(config, context);
    },
    private readonly scheduleProgress: (callback: () => void) => () => void = (
      callback,
    ) => {
      const timer = setTimeout(callback, 1000);
      return () => clearTimeout(timer);
    },
    private readonly binding?: (member: CrewMember) => PiCrewBinding,
    private readonly captainDirectory?: string,
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
        const dataDirectory = join(
          await realpath(resolve(this.stateDirectory)),
          "pi",
          hash,
        );
        const pooled = pool.get(dataDirectory);
        if (pooled) {
          pooled.owners.add(this);
          this.leases.add(dataDirectory);
          return pooled.backend;
        }
        const owners = new Set([this]);
        const current = () => {
          const owner = owners.values().next().value;
          const binding = owner?.binding?.(member);
          if (!binding) throw new CrewError("Pi crew binding unavailable.");
          return binding;
        };
        const opening = (async () => {
          await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
          await chmod(dataDirectory, 0o700);
          const instructions = this.captainDirectory
            ? await readFile(
                piDefinitionPath(this.captainDirectory, member),
                "utf8",
              ).catch((error: unknown) => {
                if (
                  typeof error === "object" &&
                  error !== null &&
                  "code" in error &&
                  error.code === "ENOENT"
                )
                  return piMemberDefinition(
                    member,
                    directory,
                    this.captainDirectory ?? "",
                  );
                throw new CrewError(
                  "Pi member definition is unreadable; check the trusted definition file.",
                );
              })
            : member.instructions;
          return this.factory(
            {
              ...definition,
              directory,
              systemPrompt: [
                maintenanceInstructions,
                `Name: ${member.name ?? member.id}. Role: ${member.role}.`,
                definition.systemPrompt,
                instructions,
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
            {
              dataDirectory,
              ...(this.captainDirectory
                ? {
                    workingAgreement: {
                      path: join(this.captainDirectory, "WAYS_OF_WORKING.md"),
                      owns: (id: string) => {
                        const owner = owners.values().next().value;
                        const peer = owner?.state.peer(member.id);
                        return (
                          !!peer &&
                          owner?.state.piPeer(peer.sessionID)
                            ?.conversationID === id
                        );
                      },
                    },
                  }
                : {}),
              ...(this.binding && definition.tools === "coding"
                ? {
                    crew: {
                      authorize: (id: string) => current().authorize(id),
                      run: (
                        name: string,
                        input: unknown,
                        id: string,
                        call: string,
                        signal: AbortSignal,
                      ) => current().run(name, input, id, call, signal),
                    },
                  }
                : {}),
            },
          );
        })();
        pool.set(dataDirectory, { backend: opening, owners });
        this.leases.add(dataDirectory);
        return opening;
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

  async idle(
    peer: Peer,
    member: CrewMember,
    directory: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (executions.has(this.key(peer)) || notifications.has(this.key(peer)))
      return false;
    const conversationID = this.state.piPeer(peer.sessionID)?.conversationID;
    if (!conversationID) return false;
    try {
      const backend = await this.backend(member, directory);
      await backend.waitForIdle?.(
        conversationID,
        AbortSignal.any([signal, AbortSignal.timeout(100)]),
      );
      return (
        !executions.has(this.key(peer)) && !notifications.has(this.key(peer))
      );
    } catch {
      return false;
    }
  }

  async notify(
    member: CrewMember,
    directory: string,
    peer: Peer,
    id: string,
    text: string,
    delivery: "steer" | "queue",
    signal: AbortSignal,
  ): Promise<string> {
    const conversationID = this.state.piPeer(peer.sessionID)?.conversationID;
    if (!conversationID) return "unavailable";
    const backend = await this.backend(member, directory);
    if (!backend.notify) return "unsupported";
    notifications.add(this.key(peer));
    try {
      await backend.notify(conversationID, id, text, delivery, signal);
      return "accepted";
    } catch {
      return "uncertain";
    } finally {
      notifications.delete(this.key(peer));
    }
  }

  /** Observation only: never initialize a backend or reconcile durable state. */
  observed(task: CrewTask): boolean {
    return (
      executions.get(`${this.state.path}:${task.workerSessionID}`)?.taskID ===
      task.id
    );
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
    if (
      this.closed ||
      executions.has(this.key(peer)) ||
      notifications.has(this.key(peer))
    )
      throw new CrewError("Pi worker is busy or closing.");
    const conversationID = this.state.piPeer(peer.sessionID)?.conversationID;
    if (!conversationID)
      throw new CrewError("Pi worker has no confirmed conversation.");
    const execution: Execution = {
      taskID: task.id,
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
      let pendingProgress: string | undefined;
      let cancelProgress: (() => void) | undefined;
      let observing = true;
      const flushProgress = () => {
        if (pendingProgress === undefined) return;
        try {
          this.state.activity.progress(task.id, pendingProgress);
          pendingProgress = undefined;
        } catch {
          // Status is best effort. Never fail execution or expose raw SQLite
          // errors; the next active timer may retry the bounded latest snapshot.
        }
      };
      const stopProgress = () => {
        observing = false;
        cancelProgress?.();
        cancelProgress = undefined;
        signal.removeEventListener("abort", stopProgress);
        flushProgress();
        pendingProgress = undefined;
      };
      const scheduleProgress = () => {
        cancelProgress = this.scheduleProgress(() => {
          cancelProgress = undefined;
          if (
            !observing ||
            signal.aborted ||
            this.closed ||
            pendingProgress === undefined
          )
            return;
          flushProgress();
          scheduleProgress();
        });
      };
      const onText: TextSink = (text) => {
        if (!observing || signal.aborted || this.closed) return;
        // Bound and redact before buffering, not just at the SQLite boundary.
        pendingProgress = redactActivity(text, 64000).slice(-400);
        if (cancelProgress) return;
        flushProgress();
        scheduleProgress();
      };
      signal.addEventListener("abort", stopProgress, { once: true });
      try {
        const backend = await this.backend(member, directory);
        signal.throwIfAborted();
        const isReport = this.state.reporting.isReport(task.id);
        if (isReport && !backend.promptReport)
          throw new CrewError("Pi backend cannot enforce read-only reporting.");
        const answer =
          isReport && backend.promptReport
            ? await backend.promptReport(conversationID, text, signal, onText)
            : await backend.prompt(
                conversationID,
                `Captain assignment ${task.id}:\n\n${text}`,
                signal,
                onText,
                "final",
              );
        signal.throwIfAborted();
        stopProgress();
        this.state.complete(
          task.id,
          peer.sessionID,
          answer.trim().slice(0, 64000) ||
            "Worker finished without a text result.",
        );
      } catch {
        stopProgress();
        this.state.uncertain(
          task.id,
          signal.aborted ? "uncertain" : "Execution failed; outcome uncertain",
        );
      } finally {
        stopProgress();
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
      [...this.leases].map(async (key) => {
        const entry = pool.get(key);
        if (!entry) return;
        entry.owners.delete(this);
        if (entry.owners.size) return;
        pool.delete(key);
        await (await entry.backend).close();
      }),
    );
  }
}
