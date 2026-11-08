import { createHash } from "node:crypto";
import type {
  MessageListInput,
  OpenCodeClient,
  SessionGetInput,
  SessionMessageInfo,
} from "@opencode/client";
import { z } from "zod";
import type { CrewSession } from "./engine";
import { CrewError, type CrewTask } from "./state";
import { agentIDSchema } from "./team";

const id = z.string().min(1).max(256);
export const inspectInputSchema = z.strictObject({
  op: z.literal("inspect"),
  crew: agentIDSchema,
  taskID: z.string().startsWith("task_").max(100).optional(),
  requestStatus: z.strictObject({ key: z.string().min(1).max(100) }).optional(),
});
export const reconcileInputSchema = z.strictObject({
  op: z.literal("reconcile"),
  taskID: z.string().startsWith("task_").max(100),
  expected: z.strictObject({
    status: z.literal("uncertain"),
    workerSessionID: id,
    originCaptainID: id,
    inputID: id,
  }),
  resultMessageID: id,
  resultSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(1).max(2000),
});
export type InspectInput = z.infer<typeof inspectInputSchema>;
export type ReconcileInput = z.infer<typeof reconcileInputSchema>;
type RequestOptions = NonNullable<
  Parameters<OpenCodeClient["session"]["get"]>[1]
>;
export interface EvidenceMessage {
  id: string;
  type: SessionMessageInfo["type"];
  time: { created: number; completed?: number };
  metadata?: Record<string, unknown>;
  text?: string;
  agent?: string;
  finish?: string;
  error?: unknown;
  content?: ReadonlyArray<{ type: string; text?: string }>;
}
// Only authenticated read APIs. No prompts, interrupts, forms or permissions writes.
export interface CrewInspectionAPI {
  session: {
    get(input: SessionGetInput, request?: RequestOptions): Promise<CrewSession>;
    active(request?: RequestOptions): Promise<Record<string, { type: string }>>;
    inbox: {
      list(
        input: SessionGetInput,
        request?: RequestOptions,
      ): Promise<ReadonlyArray<{ id: string }>>;
    };
    form: {
      list(
        input: SessionGetInput,
        request?: RequestOptions,
      ): Promise<ReadonlyArray<{ id: string }>>;
    };
  };
  permission: {
    list(
      input: SessionGetInput,
      request?: RequestOptions,
    ): Promise<ReadonlyArray<{ id: string }>>;
  };
  message: {
    list(
      input: MessageListInput,
      request?: RequestOptions,
    ): Promise<{
      data: ReadonlyArray<EvidenceMessage>;
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
            ...(session.time.busy !== undefined
              ? { busy: session.time.busy }
              : {}),
            ...(session.time.idle !== undefined
              ? { idle: session.time.idle }
              : {}),
          }
        : null,
      outcome: session.outcome ?? null,
    },
  };
}

export function requireQuiescent(execution: ExecutionInspection): void {
  if (
    execution.state !== "idle" ||
    execution.pendingInputs ||
    execution.pendingForms ||
    execution.pendingPermissions ||
    execution.time?.idle === undefined ||
    execution.time.idle < (execution.time.busy ?? 0) ||
    execution.outcome !== "succeeded"
  )
    throw new CrewError(
      "Worker is active, has pending input/approval, or lacks a successful idle boundary; reconciliation refused. Do not interrupt or replay it.",
    );
}

const envelopeSchema = z.strictObject({
  taskID: id,
  crewID: id,
  originCaptainID: id,
  inputID: id,
});
function verifyInput(message: EvidenceMessage, task: CrewTask): string {
  try {
    const prefix = "Pogo task envelope: ";
    const line = message.text?.split("\n", 1)[0];
    if (!line?.startsWith(prefix)) throw new Error();
    const envelope = envelopeSchema.parse(
      JSON.parse(line.slice(prefix.length)),
    );
    const metadata = message.metadata?.["pogoCrew"];
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
      throw new Error();
    return sha256(message.text);
  } catch {
    throw new CrewError(
      "Retained input does not match the exact task envelope and original captain; no state changed.",
    );
  }
}

/** greybeard: bounded durable history scan; no semantic result matcher. */
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
  const cursors = new Set<string>();
  for (let pageNumber = 0; pageNumber < 8; pageNumber++) {
    signal.throwIfAborted();
    const page = await api.message.list(
      {
        sessionID: task.workerSessionID,
        order: "desc",
        limit: 64,
        ...(cursor ? { cursor } : {}),
      },
      { signal },
    );
    signal.throwIfAborted();
    if (page.data.length > 64)
      throw new CrewError("Invalid evidence page; reconciliation refused.");
    for (const message of page.data) {
      if (message.id === task.inputID && message.type === "user") {
        const inputSha256 = verifyInput(message, task);
        const result = (final?.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n");
        if (
          !final ||
          final.id !== input.resultMessageID ||
          ![workerAgent, task.crewID].includes(final.agent ?? "") ||
          final.finish !== "stop" ||
          final.error !== undefined ||
          final.time.completed === undefined ||
          final.time.created < message.time.created ||
          final.time.completed < final.time.created ||
          final.time.completed > (execution.time?.idle ?? 0) ||
          !result.trim() ||
          result.length > 64000 ||
          sha256(result) !== input.resultSha256
        )
          throw new CrewError(
            "Final result evidence does not match the reviewed message/hash and admitted input; no state changed.",
          );
        return { result, inputSha256 };
      }
      if (message.type === "assistant") {
        final ??= message;
      } else if (message.type !== "idle") {
        // Interleaved prompts, compaction or steering can change result lineage.
        throw new CrewError(
          "Another input or control message follows this task; automatic evidence matching refused. Inspect the exact task history.",
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
