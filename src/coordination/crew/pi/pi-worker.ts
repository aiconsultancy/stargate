import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Attachment } from "../../../chat/attachments/attachments";
import type {
  AgentBackend,
  BackendContext,
  TextSink,
} from "../../../backends/backend";
import type { piDurableBackendSchema } from "../../../backends/pi/config";
import type { SessionHistory } from "../../../shared/session-history";
import { crewTaskTextLimit } from "../../../shared/crew-status";
import {
  piDefinitionPath,
  piMemberDefinition,
  workingAgreementNotice,
} from "../instructions";
import { type PiCrewBinding, piCrewExtension } from "./pi-extension";
import {
  CrewError,
  type CrewState,
  type CrewTask,
  type Peer,
} from "../execution/state";
import type { CrewMember } from "../team";
import { activityProgressBuffer } from "../reporting/member-activity";

type PiConfig = typeof piDurableBackendSchema.Type;

type PiWorkerContext = BackendContext & { crew?: PiCrewBinding };

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
    result?: "final" | ((id: string) => void),
    requestId?: string | readonly Attachment[],
  ): Promise<string>;
  /** Same crew slot, but enforced tools-off and input-only model context.
   * Absence fails closed; normal maintenance prompt is never a fallback.
   */
  promptReport?(
    sessionID: string,
    text: string,
    signal: AbortSignal,
    onText?: TextSink,
    receipt?: {
      requestId: string;
      onConversation: (conversationID: string) => void;
    },
  ): Promise<string>;
}

export type PiWorkerFactory = ((
  config: PiConfig,
  context: PiWorkerContext,
) => Promise<PiWorkerBackend>) & {
  /** Must inspect committed receipts without scheduling or submitting work. */
  recover?: (
    context: BackendContext,
    conversationID: string,
    requestID: string,
    signal: AbortSignal,
  ) => Promise<string | undefined>;
};

const nativeFactory: PiWorkerFactory = Object.assign(
  async (config: PiConfig, { crew, ...context }: PiWorkerContext) => {
    const { PiDurableBackend } =
      await import("../../../backends/pi/pi-durable");

    return PiDurableBackend.open(
      config,
      context,
      crew && ((readHistory) => piCrewExtension(crew, readHistory)),
    );
  },
  {
    async recover(
      context: BackendContext,
      conversationID: string,
      requestID: string,
      signal: AbortSignal,
    ) {
      const { PiDurableBackend } =
        await import("../../../backends/pi/pi-durable");

      return PiDurableBackend.recover(
        context,
        conversationID,
        requestID,
        signal,
      );
    },
  },
);

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

// A replacement harness waits until the previous one for this database closes.
const closing = new Map<string, Promise<void>>();

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
  private readonly recoveryController = new AbortController();
  private readonly recoveries = new Set<Promise<CrewTask>>();
  private readonly historyReads = new Set<Promise<unknown>>();
  private closed = false;

  public constructor(
    private readonly state: CrewState,
    private readonly stateDirectory: string,
    private readonly factory: PiWorkerFactory = nativeFactory,
    private readonly scheduleProgress: (callback: () => void) => () => void = (
      callback,
    ) => {
      const timer = setTimeout(callback, 1000);

      return () => {
        clearTimeout(timer);
      };
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
    if (this.closed) {
      throw new CrewError("Pi crew runtime is closing.");
    }

    const definition = member.backend;

    if (!definition) {
      throw new CrewError("Worker is not a Pi worker.");
    }

    let backend = this.backends.get(member.id);

    if (!backend) {
      backend = (async () => {
        const hash = createHash("sha256").update(member.id).digest("hex");

        const dataDirectory = join(
          await realpath(resolve(this.stateDirectory)),
          "pi",
          hash,
        );

        for (
          let previous = closing.get(dataDirectory);
          previous;
          previous = closing.get(dataDirectory)
        ) {
          await previous.catch(() => {});
        }

        // No await between this check and registering pool ownership.
        if (this.closed) {
          throw new CrewError("Pi crew runtime is closing.");
        }

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

          if (!binding) {
            throw new CrewError("Pi crew binding unavailable.");
          }

          return binding;
        };

        const opening = (async () => {
          await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
          await chmod(dataDirectory, 0o700);

          const captainDirectory = this.captainDirectory;

          const instructions = captainDirectory
            ? await readFile(
                piDefinitionPath(captainDirectory, member),
                "utf8",
              ).catch((error: unknown) => {
                if (
                  typeof error === "object" &&
                  error !== null &&
                  "code" in error &&
                  error.code === "ENOENT"
                ) {
                  return piMemberDefinition(
                    member,
                    directory,
                    captainDirectory,
                  );
                }

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
              ...(captainDirectory && {
                workingAgreement: {
                  createNotice: () =>
                    workingAgreementNotice(
                      join(captainDirectory, "WAYS_OF_WORKING.md"),
                    ),
                  owns: (id: string) => {
                    const owner = owners.values().next().value;
                    const peer = owner?.state.peer(member.id);

                    return (
                      !!peer &&
                      owner?.state.piPeer(peer.sessionID)?.conversationID === id
                    );
                  },
                },
              }),
              ...(this.binding &&
                definition.tools === "coding" && {
                  crew: {
                    authorize: (id: string) => {
                      current().authorize(id);
                    },
                    run: (
                      name: string,
                      input: unknown,
                      id: string,
                      call: string,
                      signal: AbortSignal,
                    ) => current().run(name, input, id, call, signal),
                  },
                }),
            },
          );
        })();

        pool.set(dataDirectory, { backend: opening, owners });
        this.leases.add(dataDirectory);
        // A failed open is not cached; the next caller opens again.
        opening.catch(() => {
          if (pool.get(dataDirectory)?.backend === opening) {
            pool.delete(dataDirectory);
          }
        });

        return opening;
      })();
      const opened = backend;
      opened.catch(() => {
        if (this.backends.get(member.id) === opened) {
          this.backends.delete(member.id);
        }
      });
      this.backends.set(member.id, backend);
    }

    return backend;
  }

  public async ensure(
    member: CrewMember,
    directory: string,
    peer: Peer,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const saved = this.state.piPeer(peer.sessionID);

    if (saved?.conversationID) {
      return;
    }

    if (saved || peer.status === "ready") {
      throw new CrewError(
        "Pi conversation creation is unconfirmed. Inspect private Pi state; automatic recreation is disabled.",
      );
    }

    const backend = await this.backend(member, directory);
    signal.throwIfAborted();

    if (!this.state.reservePiPeer(peer.sessionID)) {
      throw new CrewError(
        "Pi conversation creation is already reserved; retry ensure to inspect it.",
      );
    }

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

  public reconcile(task: CrewTask): CrewTask {
    if (
      (task.status === "running" || task.status === "dispatching") &&
      !executions.has(`${this.state.path}:${task.workerSessionID}`)
    ) {
      this.state.uncertain(task.id);
    }

    return this.state.task(task.id) ?? task;
  }

  /** Recover only this task's committed answer; never initialize a worker. */
  public async recover(
    task: CrewTask,
    member: CrewMember,
    _directory: string,
    signal: AbortSignal,
  ): Promise<CrewTask> {
    if (this.closed) {
      return task;
    }

    const recovery = this.recoverReceipt(
      task,
      member,
      AbortSignal.any([signal, this.recoveryController.signal]),
    );

    this.recoveries.add(recovery);

    try {
      return await recovery;
    } finally {
      this.recoveries.delete(recovery);
    }
  }

  private async recoverReceipt(
    task: CrewTask,
    member: CrewMember,
    signal: AbortSignal,
  ): Promise<CrewTask> {
    signal.throwIfAborted();
    const current = this.state.task(task.id) ?? task;

    if (
      this.closed ||
      current.crewID !== member.id ||
      current.released !== 0 ||
      !["dispatching", "running", "uncertain"].includes(current.status) ||
      this.observed(current)
    ) {
      return current;
    }

    const expected = this.reconcile(current);
    const conversationID = this.state.piTaskConversation(expected.id);

    if (!conversationID || !this.factory.recover) {
      return expected;
    }

    try {
      const hash = createHash("sha256").update(member.id).digest("hex");

      const dataDirectory = join(
        await realpath(resolve(this.stateDirectory)),
        "pi",
        hash,
      );

      signal.throwIfAborted();

      const answer = await this.factory.recover(
        { dataDirectory },
        conversationID,
        expected.inputID,
        signal,
      );

      signal.throwIfAborted();

      if (answer !== undefined) {
        return this.state.recoverResult(
          expected,
          answer.trim().slice(0, crewTaskTextLimit) ||
            "Worker finished without a text result.",
        );
      }
    } catch {
      // Missing/unreadable native receipts remain unresolved, not failed or done.
    }

    return this.closed ? expected : (this.state.task(task.id) ?? expected);
  }

  public async idle(
    peer: Peer,
    member: CrewMember,
    directory: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (executions.has(this.key(peer)) || notifications.has(this.key(peer))) {
      return false;
    }

    const conversationID = this.state.piPeer(peer.sessionID)?.conversationID;

    if (!conversationID) {
      return false;
    }

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

  public async notify(
    member: CrewMember,
    directory: string,
    peer: Peer,
    id: string,
    text: string,
    delivery: "steer" | "queue",
    signal: AbortSignal,
  ): Promise<string> {
    const conversationID = this.state.piPeer(peer.sessionID)?.conversationID;

    if (!conversationID) {
      return "unavailable";
    }

    const backend = await this.backend(member, directory);

    if (!backend.notify) {
      return "unsupported";
    }

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
  public observed(task: CrewTask): boolean {
    return (
      executions.get(`${this.state.path}:${task.workerSessionID}`)?.taskID ===
      task.id
    );
  }

  /** Never call backend(): that path opens a scheduling harness. A live pool
   * lease keeps its owner from closing during reads; otherwise open readOnly.
   */
  public async readHistory<T>(
    member: CrewMember,
    callerSignal: AbortSignal,
    read: (history: SessionHistory, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const signal = AbortSignal.any([
      callerSignal,
      this.recoveryController.signal,
    ]);

    const operation = (async () => {
      signal.throwIfAborted();

      if (this.closed || !member.backend) {
        throw new CrewError("Pi history unavailable or cancelled.");
      }

      const hash = createHash("sha256").update(member.id).digest("hex");

      const dataDirectory = join(
        await realpath(resolve(this.stateDirectory)),
        "pi",
        hash,
      );

      for (
        let previous = closing.get(dataDirectory);
        previous;
        previous = closing.get(dataDirectory)
      ) {
        await previous.catch(() => {});
      }

      signal.throwIfAborted();

      if (this.closed) {
        throw new CrewError("Pi history unavailable or cancelled.");
      }

      const pooled = pool.get(dataDirectory);

      if (pooled) {
        pooled.owners.add(this);
        this.leases.add(dataDirectory);
        const backend = await pooled.backend;
        signal.throwIfAborted();

        if (!backend.history) {
          throw new CrewError("Pi history unavailable or cancelled.");
        }

        return read(backend.history, signal);
      }

      const { readPiHistory } = await import("../../../backends/pi/pi-history");
      signal.throwIfAborted();

      return readPiHistory(dataDirectory, signal, (history) =>
        read(history, signal),
      );
    })();

    this.historyReads.add(operation);

    try {
      const result = await operation;
      signal.throwIfAborted();

      return result;
    } catch {
      throw new CrewError("Pi history unavailable or cancelled.");
    } finally {
      this.historyReads.delete(operation);
    }
  }

  public async canReport(
    member: CrewMember,
    directory: string,
  ): Promise<boolean> {
    return (
      typeof (await this.backend(member, directory)).promptReport === "function"
    );
  }

  public start(
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
    ) {
      throw new CrewError("Pi worker is busy or closing.");
    }

    const conversationID = this.state.piPeer(peer.sessionID)?.conversationID;

    if (!conversationID) {
      throw new CrewError("Pi worker has no confirmed conversation.");
    }

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
        if (pendingProgress === undefined) {
          return;
        }

        try {
          this.state.activity.progress(task.id, pendingProgress);
          pendingProgress = undefined;
        } catch {
          // Status is best effort. Never fail execution or expose raw SQLite
          // Errors; the next active timer may retry the bounded latest snapshot.
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
          ) {
            return;
          }

          flushProgress();
          scheduleProgress();
        });
      };

      const onText: TextSink = (text) => {
        if (!observing || signal.aborted || this.closed) {
          return;
        }

        // Bound before buffering, but keep the masker's whole window: the
        // Store masks the ordinary view from it, then makes the final cut.
        pendingProgress = activityProgressBuffer(text);

        if (cancelProgress) {
          return;
        }

        flushProgress();
        scheduleProgress();
      };

      signal.addEventListener("abort", stopProgress, { once: true });

      try {
        const backend = await this.backend(member, directory);
        signal.throwIfAborted();
        const isReport = this.state.reporting.isReport(task.id);

        if (isReport && !backend.promptReport) {
          throw new CrewError("Pi backend cannot enforce read-only reporting.");
        }

        if (!isReport) {
          this.state.savePiTaskConversation(task.id, conversationID);
        }

        const answer =
          isReport && backend.promptReport
            ? await backend.promptReport(conversationID, text, signal, onText, {
                requestId: task.inputID,
                onConversation: (id) => {
                  this.state.savePiTaskConversation(task.id, id);
                },
              })
            : await backend.prompt(
                conversationID,
                `Captain assignment ${task.id}:\n\n${text}`,
                signal,
                onText,
                "final",
                task.inputID,
              );

        signal.throwIfAborted();
        stopProgress();
        this.state.complete(
          task.id,
          peer.sessionID,
          answer.trim().slice(0, crewTaskTextLimit) ||
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

  public async interrupt(peer: Peer) {
    const execution = executions.get(this.key(peer));

    if (execution) {
      execution.controller.abort();
      await execution.done;
    }
  }

  public async close() {
    this.closed = true;
    this.recoveryController.abort();
    const running = [...this.owned];

    for (const execution of running) {
      execution.controller.abort();
    }

    // Readers own native handles through their complete cleanup, even when an
    // Opener ignores cancellation. Crew state may close only after this drain.
    await Promise.allSettled([...this.recoveries, ...this.historyReads]);
    await Promise.all(running.map(({ done }) => done));
    await Promise.allSettled(
      [...this.leases].map(async (key) => {
        const entry = pool.get(key);

        if (!entry) {
          return;
        }

        entry.owners.delete(this);

        // Other plugin instances still own this harness.
        if (entry.owners.size > 0) {
          return;
        }

        pool.delete(key);

        const closed = (async () => {
          await (await entry.backend).close();
        })().finally(() => {
          if (closing.get(key) === closed) {
            closing.delete(key);
          }
        });

        closing.set(key, closed);
        await closed;
      }),
    );
  }
}
