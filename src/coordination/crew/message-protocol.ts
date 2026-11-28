import { createHash } from "node:crypto";

/** Owner-approved stable OpenCode MESSAGE key, not a session/config/tool alias. */
export const crewMessageMetadataKey = "pogoCrew";

/** Historical native inputs stay immutable; new inputs use the Stargate label. */
export function taskEnvelopePayload(text: string | undefined) {
  const line = text?.split("\n", 1)[0];

  if (line === undefined) {
    return;
  }

  const prefix = ["Stargate task envelope: ", "Pogo task envelope: "].find(
    (prefix) => line.startsWith(prefix),
  );

  return prefix === undefined ? undefined : line.slice(prefix.length);
}

export function crewCompletionMessageID(taskID: string) {
  return `msg_${createHash("sha256").update(`crew-completion\0${taskID}`).digest("hex")}`;
}

/** Native OpenCode deduplicates synthetic admission by session, type and ID. */
export function crewCompletionInput(
  pin: string,
  wake: { id: string; crewID: string; originInputID: string | null },
) {
  const id = crewCompletionMessageID(wake.id);

  return {
    sessionID: pin,
    id,
    text: `Stargate recorded a verified result for ${wake.crewID}'s task ${wake.id}. Read the result with stargate_crew status. Continue the existing request without repeating the assignment.`,
    description: "Crew task completed",
    metadata: {
      [crewMessageMetadataKey]: {
        sourceTaskID: wake.id,
        originCaptainID: pin,
        ...(wake.originInputID && { originInputID: wake.originInputID }),
        messageID: id,
      },
    },
    delivery: "queue" as const,
    resume: true,
  };
}

type TaskBinding = {
  id: string;
  inputID: string;
  originCaptainID: string;
};

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
