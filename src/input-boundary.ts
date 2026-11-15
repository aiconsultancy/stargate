import { z } from "zod";
import { crewMessageMetadataKey } from "./crew/message-protocol";

const crewOrigin = z.object({
  originCaptainID: z.string(),
  originInputID: z.string().min(1).optional(),
});

/** Resolve one native input boundary; unmapped crew wakes clear public ownership. */
export function inputBoundary(
  message: { id: string; type: string; metadata?: Record<string, unknown> },
  sessionID: string,
): string | undefined {
  if (message.type === "user" || message.type === "shell") return message.id;
  if (
    message.type !== "synthetic" ||
    !message.metadata ||
    !Object.hasOwn(message.metadata, crewMessageMetadataKey)
  )
    return;
  const origin = crewOrigin.safeParse(message.metadata[crewMessageMetadataKey]);
  return origin.success && origin.data.originCaptainID === sessionID
    ? (origin.data.originInputID ?? message.id)
    : message.id;
}

/** Retain ordering and boundaries, never tool payloads or metadata. */
export type InputBoundaryRecord = {
  id: string;
  type: string;
  input?: string;
};

export function boundaryRecord(
  message: { id: string; type: string; metadata?: Record<string, unknown> },
  sessionID: string,
): InputBoundaryRecord {
  const input = inputBoundary(message, sessionID);
  return {
    id: message.id,
    type: message.type,
    ...(input !== undefined ? { input } : {}),
  };
}

/** Fold chronological native inputs. Adjacent mixed wakes can share a turn. */
export class InputBoundaryFold {
  private previous: string | undefined;
  private adjacent = false;
  private mixed = false;

  next(message: InputBoundaryRecord): string | undefined {
    if (message.type === "assistant") {
      this.adjacent = false;
      this.mixed = false;
    }
    if (message.input === undefined) return;
    const mixed =
      message.type === "synthetic" &&
      this.adjacent &&
      (this.mixed || message.input !== this.previous);
    const input = mixed ? message.id : message.input;
    this.mixed =
      mixed || (message.type === "synthetic" && message.input === message.id);
    this.previous = input;
    this.adjacent = true;
    return input;
  }
}

/** A preceding assistant or raw input closes a descending crew batch scan. */
export function closesBoundaryContext(message: InputBoundaryRecord): boolean {
  return (
    message.type === "assistant" ||
    message.type === "user" ||
    message.type === "shell"
  );
}

export function resolveBoundaryContext(
  descending: ReadonlyArray<InputBoundaryRecord>,
): string | undefined {
  const fold = new InputBoundaryFold();
  let input: string | undefined;
  for (let index = descending.length - 1; index >= 0; index--) {
    const message = descending[index];
    if (message) input = fold.next(message) ?? input;
  }
  return input;
}
