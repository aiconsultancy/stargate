import { Option, Schema } from "effect";
import { isNativeInstructionContext } from "../../crew/instruction-context";
import { crewMessageMetadataKey } from "../../crew/message-protocol";

const decodeCrewOrigin = Schema.decodeUnknownOption(
  Schema.Struct({
    originCaptainID: Schema.String,
    originInputID: Schema.optional(Schema.NonEmptyString),
  }),
);

const decodeRestart = Schema.decodeUnknownOption(
  Schema.Struct({ notice: Schema.Literal("restart") }),
  { onExcessProperty: "error" },
);

// OpenCode 2.3.0 SessionRunner.continueOutputLimit emits same-turn context
// Without description or metadata, not an asynchronous completion.
const outputLimitContinuation =
  "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces.";

type BoundaryMessage = {
  id: string;
  type: string;
  text?: string;
  description?: string;
  metadata?: Record<string, unknown>;
};

/** Resolve one native input boundary; unmapped wakes clear public ownership. */
export function inputBoundary(
  message: BoundaryMessage,
  sessionID: string,
): string | undefined {
  if (message.type === "user" || message.type === "shell") return message.id;

  // A shell callback is not a continuation of the latest chat. A reader with
  // Retained launch ancestry may replace this native-only boundary.
  if (message.type === "synthetic" && message.metadata?.["source"] === "shell")
    return message.id;

  if (message.type !== "synthetic") return;

  if (
    message.metadata &&
    Object.hasOwn(message.metadata, crewMessageMetadataKey)
  ) {
    const origin = decodeCrewOrigin(message.metadata[crewMessageMetadataKey]);

    return Option.isSome(origin) && origin.value.originCaptainID === sessionID
      ? (origin.value.originInputID ?? message.id)
      : message.id;
  }

  // These native context records do not start asynchronous work. Every other
  // Unproven synthetic input clears ownership, including missing metadata.
  if (
    isNativeInstructionContext(message) ||
    Option.isSome(decodeRestart(message.metadata)) ||
    (message.text === outputLimitContinuation &&
      message.description === undefined &&
      (message.metadata === undefined ||
        Object.keys(message.metadata).length === 0))
  )
    return;

  return message.id;
}

/** Retain ordering and boundaries, never tool payloads or metadata. */
export type InputBoundaryRecord = {
  id: string;
  type: string;
  input?: string;
};

export function boundaryRecord(
  message: BoundaryMessage,
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

/** A preceding assistant or raw input closes a descending wake batch scan. */
export function closesBoundaryContext(message: InputBoundaryRecord): boolean {
  return (
    message.type === "assistant" ||
    message.type === "user" ||
    message.type === "shell"
  );
}

export function resolveBoundaryContext(
  descending: readonly InputBoundaryRecord[],
): string | undefined {
  const fold = new InputBoundaryFold();
  let input: string | undefined;

  for (let index = descending.length - 1; index >= 0; index--) {
    const message = descending[index];

    if (message) input = fold.next(message) ?? input;
  }

  return input;
}
