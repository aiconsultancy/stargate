import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Predicate } from "effect";
import type {
  ActivityContent,
  ActivityItem,
  ActivityOutcome,
  ActivityRequest,
  ActivityTokens,
  TurnActivityLog,
  TurnActivityRecorder,
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

const activityError = (type: string, message: string) => ({
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
  /** The CLI commonly emits one final assistant envelope per block. */
  finalIndex: number;
  settled: boolean;
  openingTokens?: ActivityTokens | undefined;
};

class Thread {
  private readonly messages = new Map<string, Message>();
  private streaming: Message | undefined;
  public ended = false;
  public background = false;
  public observedOutcome: ActivityOutcome | undefined;

  public constructor(
    public readonly log: TurnActivityLog,
    private readonly remember: (
      id: string,
      owner: Thread,
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
        finalIndex: 0,
        settled: false,
      };
      this.messages.set(id, message);
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

        if (mode === "final" || mode === "stop" || mode === "redacted") {
          item.status = "completed";
        }
      },
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

  public end(outcome: ActivityOutcome, at: number) {
    if (this.ended) {
      return;
    }

    this.ended = true;

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

type Task = Extract<
  SDKMessage,
  {
    subtype:
      | "task_started"
      | "task_progress"
      | "task_updated"
      | "task_notification";
  }
>;

type Call = {
  id: string;
  owner: Thread;
  canParent: boolean;
  taskType?: string;
  background?: boolean;
  taskOutcome?: ActivityOutcome;
};

/** One SDK query; never write SDK data to logs or change the reply pipeline. */
export class ClaudeActivity {
  private readonly calls = new Map<string, Call>();
  private readonly children = new Map<string, Thread>();
  private readonly tasks = new Map<
    string,
    { call: Call; runId: string | undefined }
  >();
  private readonly root: Thread;

  private constructor(
    log: TurnActivityLog,
    private readonly sessionId: string,
  ) {
    this.root = this.thread(log);
  }

  public static start(
    recorder: TurnActivityRecorder | undefined,
    sessionId: string,
    requests?: () => readonly ActivityRequest[],
  ): ClaudeActivity | undefined {
    if (!recorder) {
      return;
    }

    let links: readonly ActivityRequest[] | undefined;

    try {
      links = requests?.();
    } catch {
      // An unavailable link should not prevent recording the query.
    }

    try {
      return new ClaudeActivity(recorder.begin(links, sessionId), sessionId);
    } catch {
      // Observability is best effort, even with a third-party recorder.
      return;
    }
  }

  private thread(log: TurnActivityLog) {
    return new Thread(log, (id, owner, canParent) => {
      if (!this.calls.has(id)) {
        this.calls.set(id, { id, owner, canParent });
      }
    });
  }

  private child(call: Call | undefined, sessionId = this.sessionId) {
    if (
      !call?.canParent ||
      (call.taskType !== undefined && call.taskType !== "local_agent")
    ) {
      return;
    }

    let child = this.children.get(call.id);

    if (!child) {
      const log = call.owner.log.child?.(call.id, sessionId);

      if (log) {
        child = this.thread(log);
        child.background = call.background ?? false;
        this.children.set(call.id, child);
      }
    }

    return child;
  }

  private denial(id: string, at: number, name: string, message: string) {
    this.calls.get(id)?.owner.tool(id, at, (tool) => {
      tool.name = name;
      tool.status = "failed";
      tool.executed = false;
      tool.error = activityError("permission_denied", message);
    });
  }

  private user(thread: Thread, frame: SDKUserMessage, at: number) {
    const blocks = frame.message.content;

    if (typeof blocks === "string") {
      return;
    }

    const results = blocks.filter((block) => block.type === "tool_result");

    for (const block of results) {
      if (this.calls.get(block.tool_use_id)?.owner === thread) {
        const child = this.children.get(block.tool_use_id);

        if (child) {
          child.observedOutcome =
            block.is_error === true ? "failed" : "completed";
        }

        thread.toolResult(
          block.tool_use_id,
          at,
          block.content,
          block.is_error === true,
          results.length === 1 ? frame.tool_use_result : undefined,
        );
      }
    }
  }

  private task(frame: Task, at: number) {
    const explicit = "tool_use_id" in frame ? frame.tool_use_id : undefined;
    const known = this.tasks.get(frame.task_id);

    const sameRun =
      known &&
      (frame.run_id === undefined ||
        known.runId === undefined ||
        known.runId === frame.run_id);

    const call =
      explicit === undefined
        ? sameRun
          ? known.call
          : undefined
        : this.calls.get(explicit);

    if (!call) {
      return;
    }

    const type = frame.subtype === "task_started" ? frame.task_type : undefined;

    if (type !== undefined) {
      call.taskType = type;
    }

    // Untyped task frames can update a child, but cannot prove one exists.
    const child =
      call.taskType === "local_agent"
        ? this.child(call, frame.session_id)
        : call.taskType === undefined
          ? this.children.get(call.id)
          : undefined;

    const runId = frame.run_id ?? known?.runId;
    this.tasks.set(frame.task_id, { call, runId });

    const task = {
      subtype: frame.subtype,
      task_id: frame.task_id,
      run_id: runId,
    };

    const details = frame.subtype === "task_updated" ? frame.patch : frame;

    const background =
      "is_backgrounded" in details ? details.is_backgrounded : undefined;

    if (background !== undefined) {
      call.background = background;

      if (child) {
        child.background = background;
      }
    }

    call.owner.tool(call.id, at, (tool) => {
      const previous = tool.metadata?.["task"];

      const prior =
        Predicate.isObject(previous) && previous["run_id"] === runId
          ? previous
          : undefined;

      const data = {
        ...prior,
        ...task,
        ...(call.taskType !== undefined && { task_type: call.taskType }),
        ...("description" in details && { description: details.description }),
        ...("prompt" in details && { prompt: details.prompt }),
        ...("summary" in details && { summary: details.summary }),
        ...("usage" in details && { usage: details.usage }),
        ...("status" in details && { status: details.status }),
        ...("error" in details && { error: details.error }),
        ...(background !== undefined && { is_backgrounded: background }),
      };

      tool.metadata = { ...tool.metadata, task: data };
    });

    const status = "status" in details ? details.status : undefined;

    const outcome =
      status === "completed" || status === "failed"
        ? status
        : status === "stopped" || status === "killed"
          ? "cancelled"
          : undefined;

    if (outcome) {
      call.taskOutcome = outcome;
      child?.end(outcome, at);
    }
  }

  private result(frame: SDKResultMessage, at: number) {
    for (const denied of frame.permission_denials ?? []) {
      const call = this.calls.get(denied.tool_use_id);

      call?.owner.tool(call.id, at, (tool) => {
        tool.name = denied.tool_name;
        tool.input ??= denied.tool_input;
        tool.status = "failed";
        tool.executed = false;
        tool.error ??= activityError("permission_denied", "Permission denied");
      });
    }

    if (Predicate.isObject(frame.usage)) {
      this.root.log.setUsage?.({
        steps: frame.num_turns,
        tokens: tokens(frame.usage),
        cost: frame.total_cost_usd,
      });
    }
  }

  /** Do not count collection-only frames as reply or tool-execution evidence. */
  public replyFrame(frame: SDKMessage, visiblePartials: boolean): boolean {
    try {
      if (frame.type === "stream_event") {
        return visiblePartials && frame.parent_tool_use_id === null;
      }

      if (frame.type === "assistant" && frame.parent_tool_use_id !== null) {
        return frame.message.content.some((block) => block.type === "tool_use");
      }

      if (frame.type === "user" && frame.parent_tool_use_id !== null) {
        const content = frame.message.content;

        return (
          typeof content !== "string" &&
          content.some((block) => block.type === "tool_result")
        );
      }
    } catch {
      // Leave malformed frames to the existing reply decoder.
    }

    return true;
  }

  public add(frame: SDKMessage) {
    try {
      const at = Date.now();

      if (frame.type === "result") {
        this.result(frame, at);
      } else if (frame.type === "system") {
        switch (frame.subtype) {
          case "permission_denied":
            this.denial(frame.tool_use_id, at, frame.tool_name, frame.message);
            break;
          case "task_started":
          case "task_updated":
          case "task_progress":
          case "task_notification":
            this.task(frame, at);
            break;
          default:
            // Other system frames do not describe a turn item.
            break;
        }
      } else if ("parent_tool_use_id" in frame) {
        const parent = frame.parent_tool_use_id;

        const thread =
          parent === null
            ? this.root
            : frame.type === "assistant" ||
                frame.type === "user" ||
                frame.type === "stream_event"
              ? this.child(this.calls.get(parent), frame.session_id)
              : this.children.get(parent);

        if (thread && !thread.ended) {
          switch (frame.type) {
            case "stream_event":
              thread.stream(frame.event, at);
              break;
            case "assistant":
              thread.assistant(frame, at);
              break;
            case "user":
              this.user(thread, frame, at);
              break;
            case "tool_progress": {
              const id = frame.tool_use_id;

              if (this.calls.get(id)?.owner === thread) {
                thread.tool(id, at, (tool) => {
                  tool.metadata = {
                    ...tool.metadata,
                    elapsed_time_seconds: frame.elapsed_time_seconds,
                    ...(frame.task_id !== undefined && {
                      task_id: frame.task_id,
                    }),
                  };
                });
              }

              break;
            }
          }
        }
      }
    } catch {
      // A malformed frame or unavailable recorder cannot affect delivery.
    }
  }

  public end(outcome: ActivityOutcome) {
    const at = Date.now();

    if (outcome !== "cancelled") {
      for (const call of this.calls.values()) {
        if (
          call.background &&
          !call.taskOutcome &&
          !this.children.has(call.id)
        ) {
          try {
            call.owner.tool(call.id, at, (tool) => {
              tool.unavailable = ["after-turn"];
            });
          } catch {
            // One unavailable recorder must not stop the rest settling.
          }
        }
      }
    }

    for (const [id, child] of this.children) {
      try {
        const call = this.calls.get(id);

        if (
          !child.ended &&
          child.background &&
          outcome !== "cancelled" &&
          !call?.taskOutcome
        ) {
          call?.owner.tool(id, at, (tool) => {
            tool.unavailable = ["after-turn"];
          });
          child.end("cancelled", at);
        } else {
          child.end(
            outcome === "cancelled"
              ? outcome
              : (call?.taskOutcome ?? child.observedOutcome ?? outcome),
            at,
          );
        }
      } catch {
        // Continue settling the other logs if this one is unavailable.
      }
    }

    try {
      this.root.end(outcome, at);
    } catch {
      // Best-effort instrumentation.
    }
  }
}
