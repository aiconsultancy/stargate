import { createHash } from "node:crypto";
import type { CrewTask } from "./state";

/** Owner-approved stable OpenCode MESSAGE key, not a session/config/tool alias. */
export const crewMessageMetadataKey = "pogoCrew";

/** Historical native inputs stay immutable; new inputs use the Stargate label. */
export function taskEnvelopePayload(text: string | undefined) {
  const line = text?.split("\n", 1)[0];
  if (line === undefined) return;
  const prefix = ["Stargate task envelope: ", "Pogo task envelope: "].find(
    (prefix) => line.startsWith(prefix),
  );
  return prefix === undefined ? undefined : line.slice(prefix.length);
}

type TaskBinding = Pick<CrewTask, "id" | "inputID" | "originCaptainID">;

export function resumeMessageID(task: TaskBinding, idleAt: number): string {
  const binding = JSON.stringify([
    "crew-resume",
    task.id,
    task.inputID,
    idleAt,
  ]);
  return `msg_${createHash("sha256").update(binding).digest("hex").slice(0, 32)}`;
}

/** A resume must use the exact original task, captain, input and idle boundary. */
export function isTaskResume(
  message: { id: string; type: string; metadata?: Record<string, unknown> },
  task: TaskBinding,
): boolean {
  const metadata = message.metadata?.[crewMessageMetadataKey];
  return (
    message.type === "synthetic" &&
    metadata !== null &&
    typeof metadata === "object" &&
    "resumeIdleAt" in metadata &&
    typeof metadata.resumeIdleAt === "number" &&
    Number.isSafeInteger(metadata.resumeIdleAt) &&
    metadata.resumeIdleAt > 0 &&
    "taskID" in metadata &&
    metadata.taskID === task.id &&
    "sourceTaskID" in metadata &&
    metadata.sourceTaskID === task.id &&
    "originCaptainID" in metadata &&
    metadata.originCaptainID === task.originCaptainID &&
    message.id === resumeMessageID(task, metadata.resumeIdleAt)
  );
}
