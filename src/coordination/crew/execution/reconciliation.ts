import { createHash } from "node:crypto";
import type {
  MessageListInput,
  OpenCodeClient,
  SessionGetInput,
  SessionInboxCancelInput,
  SessionInfo,
  SessionMessageInfo,
} from "@opencode/client";
import { Schema } from "effect";
import {
  settingsDefault,
  settingsPattern,
  settingsStartsWith,
  settingsStruct,
} from "../../../config/settings-schema";
import { isNativeInstructionContext } from "../../../backends/opencode/instruction-context";
import {
  crewMessageMetadataKey,
  isTaskResume,
  taskEnvelopePayload,
} from "../message-protocol";
import {
  ShellCompletionContext,
  type ShellContextRecord,
  isShellCompletionCandidate,
} from "./shell-context";
import { CrewError, type CrewTask } from "./state";
import { agentIDSchema } from "../team";

type CrewSession = Pick<
  SessionInfo,
  "id" | "parentID" | "agent" | "location" | "metadata" | "outcome" | "model"
> & {
  permissions?: unknown;
  time?: Pick<SessionInfo["time"], "updated" | "busy" | "idle">;
};

const id = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxCodePoints(256),
);

export const inspectInputSchema = settingsStruct({
  op: Schema.Literal("inspect"),
  crew: agentIDSchema,
  taskID: Schema.optional(
    Schema.String.check(
      settingsStartsWith("task_"),
      Schema.isMaxCodePoints(100),
    ),
  ),
  requestStatus: Schema.optional(
    settingsStruct({
      key: Schema.String.check(
        Schema.isMinCodePoints(1),
        Schema.isMaxCodePoints(100),
      ),
    }),
  ),
});

export const reconcileInputSchema = settingsStruct({
  op: Schema.Literal("reconcile"),
  taskID: Schema.String.check(
    settingsStartsWith("task_"),
    Schema.isMaxCodePoints(100),
  ),
  expected: settingsStruct({
    status: Schema.Literal("uncertain"),
    workerSessionID: id,
    originCaptainID: id,
    inputID: id,
  }),
  resultMessageID: id,
  resultSha256: Schema.String.check(settingsPattern(/^[a-f0-9]{64}$/)),
  reason: Schema.Trim.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(2000),
  ),
});

/** Captain continuation of one verified, idle native assignment. */
export const resumeInputSchema = settingsStruct({
  op: Schema.Literal("resume"),
  taskID: Schema.String.check(
    settingsStartsWith("task_"),
    Schema.isMaxCodePoints(100),
  ),
  expected: settingsStruct({
    workerSessionID: id,
    originCaptainID: id,
    inputID: id,
    idleAt: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
  }),
});

export type ResumeInput = typeof resumeInputSchema.Type;

/** Captain override for blocked slots. Copy expected fields from inspect. */
export const abandonInputSchema = settingsStruct({
  op: Schema.Literal("abandon"),
  taskID: Schema.String.check(
    settingsStartsWith("task_"),
    Schema.isMaxCodePoints(100),
  ),
  expected: settingsStruct({
    status: Schema.Literals([
      "dispatching",
      "running",
      "cancelling",
      "uncertain",
    ]),
    workerSessionID: id,
    originCaptainID: id,
    inputID: id,
    controlID: Schema.NullOr(
      Schema.String.check(settingsPattern(/^[a-f0-9]{64}$/)),
    ).pipe(settingsDefault(null)),
  }),
  reason: Schema.Trim.check(
    Schema.isMinCodePoints(1),
    Schema.isMaxCodePoints(2000),
  ),
  key: Schema.String.check(settingsPattern(/^[A-Za-z0-9._-]{1,100}$/)),
  acknowledgeUnconfirmedStop: Schema.Literal(true),
});

export type InspectInput = typeof inspectInputSchema.Type;

export type ReconcileInput = typeof reconcileInputSchema.Type;

export type AbandonInput = typeof abandonInputSchema.Type;

type RequestOptions = NonNullable<
  Parameters<OpenCodeClient["session"]["get"]>[1]
>;

export interface EvidenceMessage extends ShellContextRecord {
  id: string;
  type: SessionMessageInfo["type"];
  time: { created: number; completed?: number };
  metadata?: Record<string, unknown>;
  text?: string;
  description?: string;
  agent?: string;
  finish?: string;
  error?: unknown;
}

// Authenticated read APIs. No prompts, interrupts, forms or permission writes;
// Captain abandon alone may withdraw its own task's still-queued input.
export interface CrewInspectionAPI {
  session: {
    get(input: SessionGetInput, request?: RequestOptions): Promise<CrewSession>;
    active(request?: RequestOptions): Promise<Record<string, { type: string }>>;
    inbox: {
      list(
        input: SessionGetInput,
        request?: RequestOptions,
      ): Promise<readonly { id: string }[]>;
      cancel?(
        input: SessionInboxCancelInput,
        request?: RequestOptions,
      ): Promise<void>;
    };
    form: {
      list(
        input: SessionGetInput,
        request?: RequestOptions,
      ): Promise<readonly { id: string }[]>;
    };
  };
  permission: {
    list(
      input: SessionGetInput,
      request?: RequestOptions,
    ): Promise<readonly { id: string }[]>;
  };
  message: {
    list(
      input: MessageListInput,
      request?: RequestOptions,
    ): Promise<{
      data: readonly EvidenceMessage[];
      cursor: { next?: string | null };
    }>;
  };
}

export type InspectionConnector = (
  caller: CrewSession,
  signal: AbortSignal,
) => Promise<CrewInspectionAPI>;

export type ExecutionInspection = {
  state: "running" | "idle";
  pendingInputs: number;
  pendingForms: number;
  pendingPermissions: number;
  time: CrewSession["time"] | null;
  outcome: CrewSession["outcome"] | null;
};

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function observeExecution(
  api: CrewInspectionAPI,
  sessionID: string,
  signal: AbortSignal,
): Promise<{ session: CrewSession; execution: ExecutionInspection }> {
  signal.throwIfAborted();
  const input = { sessionID };
  const request = { signal };

  const [session, active, inbox, forms, permissions] = await Promise.all([
    api.session.get(input, request),
    api.session.active(request),
    api.session.inbox.list(input, request),
    api.session.form.list(input, request),
    api.permission.list(input, request),
  ]);

  signal.throwIfAborted();

  return {
    session,
    execution: {
      state: Object.hasOwn(active, sessionID) ? "running" : "idle",
      pendingInputs: inbox.length,
      pendingForms: forms.length,
      pendingPermissions: permissions.length,
      time: session.time
        ? {
            updated: session.time.updated,
            ...(session.time.busy !== undefined && { busy: session.time.busy }),
            ...(session.time.idle !== undefined && { idle: session.time.idle }),
          }
        : null,
      outcome: session.outcome ?? null,
    },
  };
}

/** Where the task's own prompt is natively. superseded: placed, but a later
 * user, shell or foreign synthetic input follows it, so the active turn may be
 * foreign work.
 */
export type Placement =
  | "queued"
  | "placed"
  | "superseded"
  | "absent"
  | "unknown";

type PlacementTask = Pick<
  CrewTask,
  "id" | "crewID" | "workerSessionID" | "inputID" | "originCaptainID"
>;

/** Newest first, optionally filtered. Enforce bounded pages and row counts. */
async function* newest(
  api: CrewInspectionAPI,
  sessionID: string,
  type: "user" | "shell" | "synthetic" | undefined,
  signal: AbortSignal,
): AsyncGenerator<EvidenceMessage> {
  let cursor: string | undefined;
  const cursors = new Set<string>();
  const limit = type === undefined ? 100 : 64;
  const pages = type === undefined ? 100 : 8;

  for (let page = 0; page < pages; page++) {
    signal.throwIfAborted();

    const result = await api.message.list(
      {
        sessionID,
        limit,
        ...(cursor
          ? { cursor }
          : { order: "desc" as const, ...(type && { type }) }),
      },
      { signal },
    );

    signal.throwIfAborted();

    if (result.data.length > limit)
      throw new CrewError("Invalid evidence page.");
    yield* result.data;
    const next = result.cursor.next;

    if (!next) return;

    if (cursors.has(next)) throw new CrewError("Repeated history cursor.");
    cursors.add(next);
    cursor = next;
  }

  throw new CrewError("History bound exceeded.");
}

/** Check native admission before a same-boundary retry; never submit a new ID. */
export async function resumeAdmitted(
  api: CrewInspectionAPI,
  sessionID: string,
  messageID: string,
  idleAt: number,
  signal: AbortSignal,
): Promise<boolean> {
  const inbox = await api.session.inbox.list({ sessionID }, { signal });

  if (inbox.some(({ id }) => id === messageID)) return true;

  for await (const message of newest(api, sessionID, "synthetic", signal)) {
    if (message.time.created < idleAt) return false;

    if (message.id === messageID) return true;
  }

  return false;
}

/** Same rule as result recovery: steering marked for this task and captain. */
function taskScoped(message: EvidenceMessage, task: PlacementTask): boolean {
  const notice = message.metadata?.[crewMessageMetadataKey];

  if (typeof notice !== "object" || notice === null) return false;
  const value = notice as Record<string, unknown>;

  if ("resumeIdleAt" in value) return isTaskResume(message, task);

  return (
    value["taskID"] === task.id &&
    value["originCaptainID"] === task.originCaptainID &&
    (typeof value["sourceTaskID"] === "string" ||
      typeof value["messageID"] === "string")
  );
}

/** Exact inputID only; inbox before history because delivery moves it.
 * Type-filtered scans keep long tool-heavy turns out of the 8x64 window.
 */
export async function observePlacement(
  api: CrewInspectionAPI,
  task: PlacementTask,
  signal: AbortSignal,
  workerAgent = task.crewID,
): Promise<Placement> {
  try {
    const sessionID = task.workerSessionID;
    const inbox = await api.session.inbox.list({ sessionID }, { signal });

    if (inbox.some(({ id }) => id === task.inputID)) return "queued";
    let own: EvidenceMessage | undefined;
    let later = false;

    for await (const message of newest(api, sessionID, "user", signal)) {
      if (message.type !== "user") continue;

      if (message.id === task.inputID) {
        own = message;
        break;
      }

      later = true;
    }

    if (!own) return "absent";

    if (later) return "superseded";
    let pendingShellCallback = false;

    // Shell and foreign synthetic inputs also start or steer other work.
    for (const type of ["shell", "synthetic"] as const)
      for await (const message of newest(api, sessionID, type, signal)) {
        if (message.time.created < own.time.created) break;

        if (message.type !== type) continue;

        if (type === "synthetic") {
          if (taskScoped(message, task) || isNativeInstructionContext(message))
            continue;

          if (isShellCompletionCandidate(message)) {
            pendingShellCallback = true;
            continue;
          }
        }

        return "superseded";
      }

    if (pendingShellCallback) {
      // Cross-type ordering needs native history, never timestamps alone.
      const proof = new ShellCompletionContext(workerAgent, task.crewID);

      for await (const message of newest(api, sessionID, undefined, signal)) {
        if (message.type === "user") {
          if (message.id !== task.inputID) return "superseded";

          if (proof.exceededBounds) return "unknown";

          return proof.finish(message.time.created) ? "placed" : "superseded";
        }

        const candidate = proof.track(message);

        if (
          message.type === "shell" ||
          (message.type === "synthetic" &&
            !taskScoped(message, task) &&
            !isNativeInstructionContext(message) &&
            !candidate)
        )
          return "superseded";
      }

      return "unknown";
    }

    return "placed";
  } catch {
    return "unknown";
  }
}

export function idleBoundary(
  execution: ExecutionInspection,
): number | undefined {
  const time = execution.time;

  if (
    execution.state === "idle" &&
    !execution.pendingInputs &&
    !execution.pendingForms &&
    !execution.pendingPermissions &&
    time?.idle !== undefined &&
    time.idle >= (time.busy ?? 0)
  )
    return time.idle;

  return undefined;
}

export function requireQuiescent(execution: ExecutionInspection): void {
  if (
    idleBoundary(execution) === undefined ||
    execution.outcome !== "succeeded"
  )
    throw new CrewError(
      "Worker is active, has pending input/approval, or lacks a successful idle boundary; reconciliation refused. Do not interrupt or replay it.",
    );
}

const envelopeSchema = settingsStruct({
  taskID: id,
  crewID: id,
  originCaptainID: id,
  inputID: id,
});

function verifyInput(message: EvidenceMessage, task: CrewTask): string {
  try {
    const payload = taskEnvelopePayload(message.text);

    if (payload === undefined)
      throw new Error("Task envelope payload is missing");

    const envelope = Schema.decodeUnknownSync(envelopeSchema)(
      JSON.parse(payload),
    );

    const metadata = message.metadata?.[crewMessageMetadataKey];

    if (
      envelope.taskID !== task.id ||
      envelope.crewID !== task.crewID ||
      envelope.originCaptainID !== task.originCaptainID ||
      envelope.inputID !== task.inputID ||
      typeof metadata !== "object" ||
      metadata === null ||
      !("taskID" in metadata) ||
      metadata.taskID !== task.id ||
      !("originCaptainID" in metadata) ||
      metadata.originCaptainID !== task.originCaptainID ||
      message.text === undefined
    )
      throw new Error("Task envelope does not match the task");

    return sha256(message.text);
  } catch {
    throw new CrewError(
      "Retained input does not match the exact task envelope and original captain; no state changed.",
    );
  }
}

/** Greybeard: bounded durable history scan; no semantic result matcher. */
export async function verifyResult(
  api: CrewInspectionAPI,
  task: CrewTask,
  input: ReconcileInput,
  execution: ExecutionInspection,
  signal: AbortSignal,
  workerAgent = task.crewID,
): Promise<{ result: string; inputSha256: string }> {
  let cursor: string | undefined;
  let final: EvidenceMessage | undefined;
  let unansweredShellCallback = false;
  const cursors = new Set<string>();
  const shellContext = new ShellCompletionContext(workerAgent, task.crewID);

  for (let pageNumber = 0; pageNumber < 8; pageNumber++) {
    signal.throwIfAborted();

    const page = await api.message.list(
      {
        sessionID: task.workerSessionID,
        order: "desc",
        limit: 64,
        ...(cursor && { cursor }),
      },
      { signal },
    );

    signal.throwIfAborted();

    if (page.data.length > 64)
      throw new CrewError("Invalid evidence page; reconciliation refused.");

    for (const message of page.data) {
      if (message.id === task.inputID && message.type === "user") {
        const inputSha256 = verifyInput(message, task);

        if (!shellContext.finish(message.time.created))
          throw new CrewError(
            "A shell callback lacks unique task-owned launch proof; reconciliation refused.",
          );

        const result = (final?.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n");

        if (
          !final ||
          unansweredShellCallback ||
          final.id !== input.resultMessageID ||
          ![workerAgent, task.crewID].includes(final.agent ?? "") ||
          final.finish !== "stop" ||
          final.error !== undefined ||
          final.time.completed === undefined ||
          final.time.created < message.time.created ||
          final.time.completed < final.time.created ||
          final.time.completed > (execution.time?.idle ?? 0) ||
          !result.trim() ||
          result.length > 64_000 ||
          sha256(result) !== input.resultSha256
        )
          throw new CrewError(
            "Final result evidence does not match the reviewed message/hash and admitted input; no state changed.",
          );

        return { result, inputSha256 };
      }

      const shellCandidate = shellContext.track(message);

      if (shellCandidate && !final) unansweredShellCallback = true;

      if (message.type === "assistant") {
        final ??= message;
      } else if (
        message.type !== "idle" &&
        !isNativeInstructionContext(message) &&
        !isTaskResume(message, task) &&
        !shellCandidate
      ) {
        // Interleaved prompts, compaction or steering can change result lineage.
        throw new CrewError(
          message.type === "compaction"
            ? "Compaction follows this task; explicit reconciliation still requires uninterrupted retained result evidence. No state changed."
            : "Another input or control message follows this task; automatic evidence matching refused. Inspect the exact task history.",
        );
      }
    }

    const next = page.cursor.next;

    if (!next) break;

    if (cursors.has(next)) break;
    cursors.add(next);
    cursor = next;
  }

  throw new CrewError(
    "Exact admitted input is missing from bounded retained history; reconciliation refused without proof.",
  );
}
