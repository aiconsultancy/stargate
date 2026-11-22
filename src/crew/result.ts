import type {
  MessageListInput,
  OpenCodeClient,
  SessionMessageInfo,
} from "@opencode/client";
import { Result, Schema } from "effect";
import {
  settingsPattern,
  settingsStartsWith,
  settingsStruct,
} from "../config/settings-schema";
import { isNativeInstructionContext } from "./instruction-context";
import {
  crewMessageMetadataKey,
  isTaskResume,
  taskEnvelopePayload,
} from "./message-protocol";
import {
  ShellCompletionContext,
  type ShellContextRecord,
} from "./shell-context";
import { CrewError, type CrewTask } from "./state";

type Request = NonNullable<Parameters<OpenCodeClient["message"]["list"]>[1]>;
export interface ResultMessage extends ShellContextRecord {
  id: string;
  type: SessionMessageInfo["type"];
  time: { created: number; completed?: number };
  text?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  agent?: string;
  finish?: string;
  error?: unknown;
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
const envelope = settingsStruct({
  taskID: Schema.String,
  crewID: Schema.String,
  originCaptainID: Schema.String,
  inputID: Schema.String,
});
const urgency = Schema.Struct({
  taskID: Schema.String,
  sourceTaskID: Schema.optional(
    Schema.String.check(settingsStartsWith("task_")),
  ),
  messageID: Schema.optional(
    Schema.String.check(settingsPattern(/^[a-f0-9]{32}$/)),
  ),
  originCaptainID: Schema.String,
});

function matchesUrgency(message: ResultMessage, task: CrewTask): boolean {
  const metadata = message.metadata?.[crewMessageMetadataKey];
  if (metadata && typeof metadata === "object" && "resumeIdleAt" in metadata)
    return isTaskResume(message, task);
  const notice = Schema.decodeUnknownResult(urgency)(metadata);
  return (
    Result.isSuccess(notice) &&
    !!(notice.success.sourceTaskID || notice.success.messageID) &&
    notice.success.taskID === task.id &&
    notice.success.originCaptainID === task.originCaptainID
  );
}

function matchesInput(message: ResultMessage, task: CrewTask): boolean {
  const payload = taskEnvelopePayload(message.text);
  if (payload === undefined) return false;
  try {
    const value = Schema.decodeUnknownSync(envelope)(JSON.parse(payload));
    const metadata = message.metadata?.[crewMessageMetadataKey];
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

export class MissingTaskResult extends CrewError {}

/** greybeard: scan only this task's retained turn; no semantic matching or replay. */
export async function readTaskResult(
  api: ResultAPI,
  task: CrewTask,
  signal: AbortSignal,
  workerAgent = task.crewID,
): Promise<string> {
  let cursor: string | undefined;
  let final: ResultMessage | undefined;
  let unansweredShellCallback = false;
  const cursors = new Set<string>();
  const shellContext = new ShellCompletionContext(workerAgent, task.crewID);
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
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
    if (page.data.length > 100)
      throw new CrewError("Invalid result history page.");
    for (const message of page.data) {
      if (message.id === task.inputID && message.type === "user") {
        if (!matchesInput(message, task))
          throw new CrewError(
            "Retained input does not match the task envelope. Restore the original input before retrying status.",
          );
        if (!shellContext.finish(message.time.created))
          throw new CrewError(
            "A shell callback lacks unique task-owned launch proof; result refused.",
          );
        const result = (final?.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n")
          .trim();
        if (
          !final ||
          unansweredShellCallback ||
          ![workerAgent, task.crewID].includes(final.agent ?? "") ||
          final.finish !== "stop" ||
          final.error !== undefined ||
          final.time.completed === undefined ||
          !result
        )
          throw new MissingTaskResult(
            "No completed visible worker answer follows this input. Resume the existing task session, then retry status; do not submit the assignment again.",
          );
        return result.slice(0, 64000);
      }
      const shellCandidate = shellContext.track(message);
      if (shellCandidate && !final) unansweredShellCallback = true;
      if (
        message.type === "user" ||
        (message.type === "synthetic" &&
          !matchesUrgency(message, task) &&
          !isNativeInstructionContext(message) &&
          !shellCandidate) ||
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
    if (!cursor) break;
  }
  if (cursor)
    throw new CrewError(
      "Result history scan bound exceeded (100 pages, up to 10,000 records). The original input is unverified beyond this window; inspect its retained turn without replaying it.",
    );
  throw new CrewError(
    "The admitted input is absent from retained history. Restore this session's history before retrying status; do not replay the assignment.",
  );
}
