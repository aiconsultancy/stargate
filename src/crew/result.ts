import type {
  MessageListInput,
  OpenCodeClient,
  SessionMessageInfo,
} from "@opencode/client";
import { z } from "zod";
import { CrewError, type CrewTask } from "./state";

type Request = NonNullable<Parameters<OpenCodeClient["message"]["list"]>[1]>;
export interface ResultMessage {
  id: string;
  type: SessionMessageInfo["type"];
  time: { created: number; completed?: number };
  text?: string;
  metadata?: Record<string, unknown>;
  agent?: string;
  finish?: string;
  error?: unknown;
  content?: ReadonlyArray<{ type: string; text?: string }>;
}
export interface ResultAPI {
  message: {
    list(
      input: MessageListInput,
      request?: Request,
    ): Promise<{
      data: ReadonlyArray<ResultMessage>;
      cursor: { next?: string | null };
    }>;
  };
}
const envelope = z.strictObject({
  taskID: z.string(),
  crewID: z.string(),
  originCaptainID: z.string(),
  inputID: z.string(),
});
const urgency = z.object({
  taskID: z.string(),
  sourceTaskID: z.string().startsWith("task_").optional(),
  messageID: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
  originCaptainID: z.string(),
});

function matchesUrgency(message: ResultMessage, task: CrewTask): boolean {
  const notice = urgency.safeParse(message.metadata?.["pogoCrew"]);
  return (
    notice.success &&
    !!(notice.data.sourceTaskID || notice.data.messageID) &&
    notice.data.taskID === task.id &&
    notice.data.originCaptainID === task.originCaptainID
  );
}

function matchesInput(message: ResultMessage, task: CrewTask): boolean {
  const prefix = "Pogo task envelope: ";
  const line = message.text?.split("\n", 1)[0];
  if (!line?.startsWith(prefix)) return false;
  try {
    const value = envelope.parse(JSON.parse(line.slice(prefix.length)));
    const metadata = message.metadata?.["pogoCrew"];
    return (
      value.taskID === task.id &&
      value.crewID === task.crewID &&
      value.originCaptainID === task.originCaptainID &&
      value.inputID === task.inputID &&
      typeof metadata === "object" &&
      metadata !== null &&
      "taskID" in metadata &&
      metadata.taskID === task.id &&
      "originCaptainID" in metadata &&
      metadata.originCaptainID === task.originCaptainID
    );
  } catch {
    return false;
  }
}

/** greybeard: scan only this task's retained turn; no semantic matching or replay. */
export async function readTaskResult(
  api: ResultAPI,
  task: CrewTask,
  signal: AbortSignal,
  workerAgent = task.crewID,
): Promise<string> {
  let cursor: string | undefined;
  let final: ResultMessage | undefined;
  const cursors = new Set<string>();
  do {
    signal.throwIfAborted();
    const page = await api.message.list(
      {
        sessionID: task.workerSessionID,
        limit: 100,
        ...(cursor ? { cursor } : { order: "desc" as const }),
      },
      { signal },
    );
    signal.throwIfAborted();
    for (const message of page.data) {
      if (message.id === task.inputID && message.type === "user") {
        if (!matchesInput(message, task))
          throw new CrewError(
            "Retained input does not match the task envelope. Restore the original input before retrying status.",
          );
        const result = (final?.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n")
          .trim();
        if (
          !final ||
          ![workerAgent, task.crewID].includes(final.agent ?? "") ||
          final.finish !== "stop" ||
          final.error !== undefined ||
          final.time.completed === undefined ||
          !result
        )
          throw new CrewError(
            "No completed visible worker answer follows this input. Resume the existing task session, then retry status; do not submit the assignment again.",
          );
        return result.slice(0, 64000);
      }
      if (
        message.type === "user" ||
        (message.type === "synthetic" && !matchesUrgency(message, task)) ||
        message.type === "shell"
      )
        throw new CrewError(
          "A later input follows this task. Read the original task turn before resuming; a later answer cannot complete it.",
        );
      if (message.type === "assistant") final ??= message;
      // Skill, compaction and model records do not start another assignment.
    }
    const next = page.cursor.next;
    if (next && cursors.has(next))
      throw new CrewError(
        "Result API repeated its cursor. Retry status when history pagination is available.",
      );
    if (next) cursors.add(next);
    cursor = next ?? undefined;
  } while (cursor);
  throw new CrewError(
    "The admitted input is absent from retained history. Restore this session's history before retrying status; do not replay the assignment.",
  );
}
