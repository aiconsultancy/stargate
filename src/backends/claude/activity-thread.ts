import type {
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Predicate } from "effect";
import type {
  ActivityContent,
  ActivityItem,
  ActivityOutcome,
  ActivityTokens,
  TurnActivityLog,
} from "../backend";

type Step = Extract<ActivityItem, { kind: "step" }>;

type Tool = Extract<ActivityItem, { kind: "tool" }>;

type Event = SDKPartialAssistantMessage["event"];

type Block = SDKAssistantMessage["message"]["content"][number];

type Usage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

function tokens(
  usage: Usage,
  previous?: ActivityTokens | null,
): ActivityTokens {
  return {
    input: usage.input_tokens ?? previous?.input ?? 0,
    output: usage.output_tokens ?? previous?.output ?? 0,
    reasoning: 0,
    cacheRead: usage.cache_read_input_tokens ?? previous?.cacheRead ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? previous?.cacheWrite ?? 0,
  };
}

export const activityError = (type: string, message: string) => ({
  type,
  message,
  status: null,
  responseBody: null,
  retryAfterMs: null,
});

/** Preserve structured result blocks that have no native Fleet content type. */
function content(input: unknown): ActivityContent[] {
  const blocks: unknown[] = Array.isArray(input) ? input : [input];

  return blocks.flatMap((block) => {
    if (typeof block === "string") {
      return [{ type: "text" as const, text: block }];
    }

    if (
      Predicate.isObject(block) &&
      block["type"] === "text" &&
      typeof block["text"] === "string"
    ) {
      return [{ type: "text" as const, text: block["text"] }];
    }

    const json = JSON.stringify(block);

    return json === undefined ? [] : [{ type: "text" as const, text: json }];
  });
}

type Message = {
  id: string;
  model: string;
  blocks: Map<number, Block["type"]>;
  tools: Map<number, string>;
  finalizedText: Map<number, string>;
  stoppedText: Map<number, string>;
  /** The CLI commonly emits one final assistant envelope per block. */
  finalIndex: number;
  settled: boolean;
  openingTokens?: ActivityTokens | undefined;
};

export class ActivityThread {
  private readonly messages = new Map<string, Message>();
  private streaming: Message | undefined;
  private latest: Message | undefined;
  public ended = false;

  public constructor(
    public readonly log: TurnActivityLog,
    private readonly remember: (
      id: string,
      owner: ActivityThread,
      canParent: boolean,
    ) => void,
  ) {}

  private message(id: string, model: string) {
    let message = this.messages.get(id);

    if (!message) {
      message = {
        id,
        model,
        blocks: new Map(),
        tools: new Map(),
        finalizedText: new Map(),
        stoppedText: new Map(),
        finalIndex: 0,
        settled: false,
      };
      this.messages.set(id, message);
      this.latest = message;
    }

    return message;
  }

  private step(message: Message, at: number, change: (step: Step) => void) {
    this.log.update(
      `step:${message.id}`,
      at,
      () => ({
        kind: "step",
        status: "running",
        model: { provider: "anthropic", id: message.model, variant: null },
        firstTokenAt: null,
        streamedAt: null,
        endedAt: null,
        finish: null,
        tokens: null,
        cost: null,
        error: null,
        unavailable: ["cost", "tokens.reasoning"],
      }),
      (item) => {
        if (item.kind === "step") {
          change(item);
        }
      },
    );
  }

  public tool(id: string, at: number, change: (tool: Tool) => void) {
    this.log.update(
      `tool:${id}`,
      at,
      () => ({
        kind: "tool",
        callId: id,
        name: null,
        status: "input",
        rawInput: "",
        input: null,
        executed: null,
        metadata: null,
        content: null,
        error: null,
      }),
      (item) => {
        if (item.kind === "tool") {
          change(item);
        }
      },
    );
  }

  private text(
    message: Message,
    index: number,
    kind: "text" | "reasoning",
    at: number,
    text: string,
    mode: "start" | "delta" | "final" | "stop" | "redacted",
  ) {
    this.log.update(
      `block:${message.id}:${index}`,
      at,
      () => ({
        kind,
        status: "streaming",
        text: "",
        ...(mode === "redacted" && { unavailable: ["text"] }),
      }),
      (item) => {
        if (item.kind !== kind) {
          return;
        }

        if (mode === "delta" && item.status === "streaming") {
          item.text += text;
        } else if (mode === "final" || mode === "start") {
          item.text = text;
        }

        if (kind === "text") {
          if (mode === "stop" && item.status === "streaming") {
            message.stoppedText.set(index, item.text);
          } else if (mode === "start" || mode === "final") {
            message.stoppedText.delete(index);
          }
        }

        if (mode === "final" || mode === "stop" || mode === "redacted") {
          item.status = "completed";
        }
      },
    );
  }

  private hasStoppedPreview(text: string) {
    const message = this.latest;

    if (!message?.stoppedText.size) {
      return false;
    }

    const indices = [...message.blocks].flatMap(([index, kind]) =>
      kind === "text" ? [index] : [],
    );

    return (
      indices.every((index) => message.stoppedText.has(index)) &&
      indices
        .toSorted((a, b) => a - b)
        .values()
        .map((index) => message.stoppedText.get(index))
        .filter(Boolean)
        .toArray()
        .join("\n") === text
    );
  }

  private block(
    message: Message,
    index: number,
    block: Block,
    at: number,
    final: boolean,
  ) {
    message.blocks.set(index, block.type);
    const mode = final ? "final" : "start";

    switch (block.type) {
      case "text":
        if (final) {
          message.finalizedText.set(index, block.text);
        }

        this.text(message, index, "text", at, block.text, mode);
        break;
      case "thinking":
        if (final) {
          message.finalizedText.set(index, block.thinking);
        }

        this.text(message, index, "reasoning", at, block.thinking, mode);
        break;
      case "redacted_thinking":
        this.text(message, index, "reasoning", at, "", "redacted");
        break;
      case "tool_use":
      case "server_tool_use":
      case "mcp_tool_use":
        this.remember(block.id, this, block.type === "tool_use");
        message.tools.set(index, block.id);
        this.tool(block.id, at, (tool) => {
          tool.name = block.name;

          if (final) {
            tool.input = Predicate.isObject(block.input) ? block.input : null;

            if (tool.status === "input") {
              tool.status = "running";
            }
          }
        });
        break;
      default:
        if ("tool_use_id" in block && "content" in block) {
          const id = block.tool_use_id;

          if ([...message.tools.values()].includes(id)) {
            this.toolResult(
              id,
              at,
              block.content,
              "is_error" in block && block.is_error,
            );
          }
        }
    }
  }

  public toolResult(
    id: string,
    at: number,
    result: unknown,
    failed: boolean,
    structured?: unknown,
  ) {
    this.tool(id, at, (tool) => {
      tool.content = content(result);

      if (structured !== undefined) {
        tool.metadata = { ...tool.metadata, tool_use_result: structured };
      }

      // A denial can be followed by a synthetic tool_result: it did not run.
      if (tool.executed !== false) {
        tool.executed = true;
        tool.status = failed ? "failed" : "completed";
      }
    });
  }

  public stream(event: Event, at: number) {
    if (event.type === "message_start") {
      const message = this.message(event.message.id, event.message.model);
      this.streaming = message;
      message.openingTokens = Predicate.isObject(event.message.usage)
        ? tokens(event.message.usage)
        : undefined;
      this.step(message, at, () => {});

      return;
    }

    const message = this.streaming;

    if (!message) {
      return;
    }

    switch (event.type) {
      case "content_block_start":
        this.block(message, event.index, event.content_block, at, false);
        break;
      case "content_block_delta": {
        this.step(message, at, (step) => {
          step.firstTokenAt ??= at;
          step.streamedAt = at;
        });
        const { delta, index } = event;

        if (delta.type === "text_delta") {
          this.text(message, index, "text", at, delta.text, "delta");
        } else if (delta.type === "thinking_delta") {
          this.text(message, index, "reasoning", at, delta.thinking, "delta");
        } else if (delta.type === "input_json_delta") {
          const id = message.tools.get(index);

          if (id) {
            this.tool(id, at, (tool) => {
              tool.rawInput += delta.partial_json;
            });
          }
        }

        break;
      }

      case "content_block_stop": {
        const kind = message.blocks.get(event.index);

        if (kind === "text" || kind === "thinking") {
          this.text(
            message,
            event.index,
            kind === "text" ? "text" : "reasoning",
            at,
            "",
            "stop",
          );
        }

        break;
      }

      case "message_delta":
        this.step(message, at, (step) => {
          step.tokens = tokens(
            event.usage,
            step.tokens ?? message.openingTokens,
          );

          if (event.delta.stop_reason) {
            step.finish = event.delta.stop_reason;
            step.status = "completed";
            step.endedAt = at;
            message.settled = true;
          }
        });
        break;
      case "message_stop":
        this.streaming = undefined;
        break;
    }
  }

  public assistant(frame: SDKAssistantMessage, at: number) {
    const { id, model, content: blocks, stop_reason, usage } = frame.message;
    const message = this.message(id, model);
    this.step(message, at, (step) => {
      // Singleton envelopes may carry a usage snapshot from before the delta.
      if (!message.settled && Predicate.isObject(usage)) {
        step.tokens = tokens(usage, step.tokens);
      }

      if (frame.error || (!message.settled && stop_reason)) {
        step.finish = stop_reason;
        step.endedAt = at;
        step.status = frame.error ? "failed" : "completed";
        step.error = frame.error
          ? activityError(frame.error, frame.error)
          : null;
        message.settled = true;
      }
    });

    // An SDK synthetic error message is not assistant output sent to the model.
    if (frame.error) {
      message.stoppedText.clear();

      return;
    }

    const only = blocks.length === 1 ? blocks[0] : undefined;

    const toolIndex =
      only && "id" in only
        ? [...message.tools].find(([, id]) => id === only.id)?.[0]
        : undefined;

    const matchingIndex =
      only &&
      [...message.blocks].find(
        ([index, kind]) => index >= message.finalIndex && kind === only.type,
      )?.[0];

    // Match finalized text and tool IDs, not just the known block types.
    // A batch that repeats all known content exactly is still ambiguous.
    const whole =
      blocks.length > 1 &&
      blocks.length >= message.blocks.size &&
      [...message.blocks].every(
        ([index, kind]) => blocks[index]?.type === kind,
      ) &&
      [...message.tools].every(([index, id]) => {
        const block = blocks[index];

        return block !== undefined && "id" in block && block.id === id;
      }) &&
      [...message.finalizedText].every(([index, text]) => {
        const block = blocks[index];

        return block?.type === "text"
          ? block.text === text
          : block?.type === "thinking" && block.thinking === text;
      });

    const start = whole
      ? 0
      : (toolIndex ?? matchingIndex ?? message.finalIndex);

    for (const [offset, block] of blocks.entries()) {
      this.block(message, start + offset, block, at, true);
    }

    message.finalIndex = Math.max(message.finalIndex, start + blocks.length);
  }

  public result(frame: SDKResultMessage, at: number, fallback: string) {
    if (fallback && !this.hasStoppedPreview(fallback)) {
      this.log.update("result:text", at, () => ({
        kind: "text",
        status: "completed",
        text: fallback,
      }));
    }

    const errors =
      frame.subtype === "success"
        ? frame.is_error && typeof frame.result === "string"
          ? [frame.result]
          : []
        : (frame.errors ?? []);

    if (frame.subtype !== "success" || frame.is_error) {
      const type = frame.subtype === "success" ? "is_error" : frame.subtype;

      this.log.update("result:error", at, () => ({
        kind: "step",
        status: "failed",
        model: null,
        firstTokenAt: null,
        streamedAt: null,
        endedAt: at,
        finish: frame.subtype,
        tokens: null,
        cost: null,
        error: {
          ...activityError(type, errors.join("\n") || type),
          status:
            frame.subtype === "success"
              ? (frame.api_error_status ?? null)
              : null,
        },
      }));
    }

    if (Predicate.isObject(frame.usage)) {
      this.log.setUsage?.({
        steps: frame.num_turns,
        tokens: tokens(frame.usage),
        cost: frame.total_cost_usd,
      });
    }
  }

  public end(outcome: ActivityOutcome, at: number, lost?: true) {
    if (this.ended) {
      return;
    }

    this.ended = true;

    if (lost) {
      this.log.end(outcome, lost);

      return;
    }

    try {
      for (const message of this.messages.values()) {
        if (!message.settled) {
          this.step(message, at, (step) => {
            step.endedAt = at;
            step.status = outcome === "completed" ? "completed" : "failed";
          });
        }
      }
    } finally {
      this.log.end(outcome);
    }
  }
}
