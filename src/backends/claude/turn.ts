import { Option, Schema } from "effect";
import {
  BackendFailure,
  type BackendFailureKind,
  statusKind,
} from "../../shared/request-failure";
import type { TurnStage } from "../../shared/turn-progress";

// Only main-thread frames count; subagent frames carry a parent tool ID.
const streamFrame = Schema.Struct({
  type: Schema.Literal("stream_event"),
  parent_tool_use_id: Schema.Null,
  event: Schema.Unknown,
});

const streamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("message_start"),
    message: Schema.Struct({ id: Schema.String }),
  }),
  Schema.Struct({
    type: Schema.Literal("content_block_start"),
    index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    content_block: Schema.Struct({
      type: Schema.String,
      text: Schema.optional(Schema.String),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("content_block_delta"),
    index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    delta: Schema.Struct({
      type: Schema.String,
      text: Schema.optional(Schema.String),
    }),
  }),
]);

const assistantFrame = Schema.Struct({
  type: Schema.Literal("assistant"),
  parent_tool_use_id: Schema.Null,
  message: Schema.Struct({
    id: Schema.String,
    content: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        text: Schema.optional(Schema.String),
      }),
    ),
  }),
  error: Schema.optional(Schema.String),
});

const initFrame = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("init"),
  session_id: Schema.String,
});

const resultFrame = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.String,
  is_error: Schema.Boolean,
  result: Schema.optional(Schema.String),
  api_error_status: Schema.optional(Schema.NullOr(Schema.Finite)),
});

const blockType = Schema.Struct({ type: Schema.String });

const contentWith = (type: string) =>
  Schema.Struct({
    content: Schema.Array(blockType).check(
      Schema.makeFilter((blocks) =>
        blocks.some((block) => block.type === type),
      ),
    ),
  });

// A forwarded preview or text-only child message is not evidence of tool work.
const toolFrame = Schema.Union([
  Schema.Struct({
    parent_tool_use_id: Schema.String,
    type: Schema.optional(Schema.String).check(
      Schema.makeFilter(
        (type) =>
          type !== "assistant" && type !== "user" && type !== "stream_event",
      ),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("assistant"),
    message: contentWith("tool_use"),
  }),
  Schema.Struct({
    type: Schema.Literal("user"),
    parent_tool_use_id: Schema.String,
    message: contentWith("tool_result"),
  }),
]);

const decodeStreamFrame = Schema.decodeUnknownOption(streamFrame);
const decodeStreamEvent = Schema.decodeUnknownOption(streamEvent);
const decodeAssistantFrame = Schema.decodeUnknownOption(assistantFrame);
const decodeInitFrame = Schema.decodeUnknownOption(initFrame);
const decodeResultFrame = Schema.decodeUnknownOption(resultFrame);
const isToolFrame = Schema.is(toolFrame);

/** Decoder's decision for this SDK frame, independent of any recorder. */
export type ClaudeFrameDecision = {
  changed: boolean;
  toolEvidence: boolean;
  resultFallback: string;
};

/** Fixed causes only; raw SDK, CLI and provider text never leaves here. */
const knownCauses = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "cloud_credential_error",
  "billing_error",
  "rate_limit",
  "overloaded",
  "invalid_request",
  "model_not_found",
  "server_error",
  "max_output_tokens",
  "error_during_execution",
  "error_max_turns",
  "error_max_budget_usd",
]);

/** The SDK's fixed provider causes and their shared category. */
const causeKinds: Record<string, BackendFailureKind> = {
  authentication_failed: "auth",
  oauth_org_not_allowed: "auth",
  account_on_hold: "auth",
  verification_required: "auth",
  cloud_credential_error: "auth",
  billing_error: "quota",
  rate_limit: "quota",
  model_not_found: "model",
  overloaded: "provider",
  server_error: "provider",
  invalid_request: "provider",
};

/**
 * The shared category of a failed turn, or undefined when the CLI reported
 * no provider failure (for example a turn limit). A specific HTTP status
 * (429, 401, 404, 504) wins over the SDK's cause.
 */
export function claudeFailure(turn: ClaudeTurn): BackendFailure | undefined {
  if (!turn.result || turn.result.ok) {
    return undefined;
  }

  const { cause, status } = turn.result;
  const byStatus = status === undefined ? undefined : statusKind(status);

  const kind =
    byStatus && byStatus !== "provider"
      ? byStatus
      : (causeKinds[cause] ?? byStatus);

  return kind && new BackendFailure(kind, { status, ran: turn.worked });
}

/**
 * Visible text of one turn: main-thread assistant text blocks only, never
 * thinking, tool input or tool results. Previews use streamed deltas; the
 * answer uses completed assistant messages.
 */
export class ClaudeTurn {
  private readonly order: string[] = [];
  private readonly streamed = new Map<string, Map<number, string>>();
  private readonly complete = new Map<string, string[]>();
  private streaming: string | undefined;
  private failure: string | undefined;
  public session: string | undefined;
  /** A tool call was seen: the turn may have changed something. */
  public worked = false;
  public result:
    | { ok: true; text: string }
    | { ok: false; cause: string; status?: number }
    | undefined;

  public constructor(private readonly visiblePartials = true) {}

  public add(
    raw: unknown,
    stage?: (stage: TurnStage) => void,
  ): ClaudeFrameDecision {
    const toolEvidence = isToolFrame(raw);
    this.worked ||= toolEvidence;
    const prior = this.result;
    const changed = this.decode(raw, stage);

    return {
      changed,
      toolEvidence,
      resultFallback: prior !== this.result ? this.resultFallback() : "",
    };
  }

  private decode(raw: unknown, stage?: (stage: TurnStage) => void): boolean {
    const init = decodeInitFrame(raw);

    if (Option.isSome(init)) {
      this.session = init.value.session_id;

      return false;
    }

    const frame = decodeStreamFrame(raw);

    if (Option.isSome(frame)) {
      return (
        this.visiblePartials && this.addStreamEvent(frame.value.event, stage)
      );
    }

    const assistant = decodeAssistantFrame(raw);

    if (Option.isSome(assistant)) {
      const id = assistant.value.message.id;

      if (assistant.value.error) {
        // Error text can quote the provider; only the fixed cause is kept.
        this.failure = assistant.value.error;
        const shown = this.streamed.has(id) || this.complete.has(id);
        this.streamed.delete(id);
        this.complete.delete(id);

        return shown;
      }

      this.seen(id);

      const texts = assistant.value.message.content.flatMap((block) =>
        block.type === "text" && block.text ? [block.text] : [],
      );

      if (texts.length === 0) {
        return false;
      }

      this.complete.set(id, [...(this.complete.get(id) ?? []), ...texts]);

      return true;
    }

    const result = decodeResultFrame(raw);

    if (Option.isSome(result)) {
      const { subtype, is_error } = result.value;

      if (subtype === "success" && !is_error) {
        this.result = { ok: true, text: result.value.result ?? "" };
      } else {
        const cause = this.failure ?? subtype;
        const status = result.value.api_error_status;
        this.result = {
          ok: false,
          cause: knownCauses.has(cause) ? cause : "error",
          ...(typeof status === "number" && { status }),
        };
      }
    }

    return false;
  }

  private addStreamEvent(raw: unknown, stage?: (stage: TurnStage) => void) {
    const event = decodeStreamEvent(raw);

    if (Option.isNone(event)) {
      return false;
    }

    if (event.value.type === "message_start") {
      stage?.("model");
      this.streaming = event.value.message.id;
      this.seen(this.streaming);

      if (!this.streamed.has(this.streaming)) {
        this.streamed.set(this.streaming, new Map());
      }

      return false;
    }

    const blocks = this.streaming && this.streamed.get(this.streaming);

    if (blocks === undefined || blocks === "") {
      return false;
    }

    if (event.value.type === "content_block_start") {
      const kind = event.value.content_block.type;

      if (kind === "thinking" || kind === "redacted_thinking") {
        stage?.("reasoning");
      }

      if (kind === "tool_use" || kind === "server_tool_use") {
        stage?.("tool");
      }

      if (kind !== "text") {
        return false;
      }

      stage?.("reply");
      blocks.set(event.value.index, event.value.content_block.text ?? "");

      return true;
    }

    if (event.value.delta.type !== "text_delta" || !event.value.delta.text) {
      return false;
    }

    blocks.set(
      event.value.index,
      (blocks.get(event.value.index) ?? "") + event.value.delta.text,
    );

    return true;
  }

  private seen(id: string) {
    if (!this.order.includes(id)) {
      this.order.push(id);
    }
  }

  public visible(): string {
    return this.order
      .map((id) => {
        const blocks = this.streamed.get(id);

        const streamed = blocks
          ? [...blocks]
              .toSorted(([a], [b]) => a - b)
              .values()
              .map(([, text]) => text)
              .filter(Boolean)
              .toArray()
              .join("\n")
          : "";

        return streamed || (this.complete.get(id) ?? []).join("\n");
      })
      .filter(Boolean)
      .join("\n\n");
  }

  public answer(): string {
    const text = this.order
      .map((id) => (this.complete.get(id) ?? []).join("\n"))
      .filter(Boolean)
      .join("\n\n");

    return text || this.resultFallback();
  }

  private resultFallback() {
    return this.complete.size === 0 && this.result?.ok ? this.result.text : "";
  }
}
