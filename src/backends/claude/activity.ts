import type {
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Predicate } from "effect";
import type {
  ActivityOutcome,
  ActivityRequest,
  TurnActivityLog,
  TurnActivityRecorder,
} from "../backend";
import { ActivityThread, activityError } from "./activity-thread";
import type { ClaudeFrameDecision } from "./turn";

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
  owner: ActivityThread;
  canParent: boolean;
  taskType?: string;
  run?: TaskRun;
};

type TaskRun = {
  child?: ActivityThread;
  background?: boolean;
  reportedOutcome?: ActivityOutcome;
  observedOutcome?: ActivityOutcome;
  settled: boolean;
};

function settleRun(
  run: TaskRun,
  fallback: ActivityOutcome | undefined,
  at: number,
  onLost?: () => void,
) {
  if (run.settled) {
    return;
  }

  const outcome =
    run.reportedOutcome ??
    (run.background ? undefined : run.observedOutcome) ??
    fallback;

  if (outcome === undefined) {
    onLost?.();
  }

  run.settled = true;

  if (outcome === undefined) {
    run.child?.end("cancelled", at, true);
  } else {
    run.child?.end(outcome, at);
  }
}

type TaskBinding = {
  call: Call;
  runId: string | undefined;
  description: string | undefined;
  prompt: string | undefined;
};

/** One SDK query; never write SDK data to logs or change the reply pipeline. */
export class ClaudeActivity {
  private readonly calls = new Map<string, Call>();
  private readonly tasks = new Map<string, TaskBinding>();
  private readonly root: ActivityThread;

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
    return new ActivityThread(log, (id, owner, canParent) => {
      if (!this.calls.has(id)) {
        this.calls.set(id, { id, owner, canParent, run: { settled: false } });
      }
    });
  }

  private child(call: Call | undefined, sessionId = this.sessionId) {
    const run = call?.run;

    if (
      !call?.canParent ||
      !run ||
      (call.taskType !== undefined && call.taskType !== "local_agent")
    ) {
      return;
    }

    if (run.child) {
      return run.settled ? undefined : run.child;
    }

    const log = call.owner.log.child?.(call.id, sessionId);

    if (log) {
      // A status can arrive before any frame proves that a child exists.
      // Admit its later output and retain that outcome for the new writer.
      run.settled = false;
      run.child = this.thread(log);
    }

    return run.child;
  }

  private denial(id: string, at: number, name: string, message: string) {
    this.calls.get(id)?.owner.tool(id, at, (tool) => {
      tool.name = name;
      tool.status = "failed";
      tool.executed = false;
      tool.error = activityError("permission_denied", message);
    });
  }

  private user(thread: ActivityThread, frame: SDKUserMessage, at: number) {
    const blocks = frame.message.content;

    if (typeof blocks === "string") {
      return;
    }

    const results = blocks.filter((block) => block.type === "tool_result");

    for (const block of results) {
      const call = this.calls.get(block.tool_use_id);

      if (call?.owner === thread) {
        if (call.run?.child) {
          call.run.observedOutcome =
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
    const known = this.tasks.get(frame.task_id);
    const previousId = known?.runId;
    const incomingId = frame.run_id;

    // The SDK orders a task's run IDs by plain string comparison.
    if (
      previousId !== undefined &&
      incomingId !== undefined &&
      incomingId < previousId
    ) {
      return;
    }

    const newer =
      previousId !== undefined &&
      incomingId !== undefined &&
      incomingId > previousId;

    // Without a start, a different run's frames do not belong to this child.
    if (newer && frame.subtype !== "task_started") {
      return;
    }

    const explicit = "tool_use_id" in frame ? frame.tool_use_id : undefined;

    const call =
      explicit === undefined ? known?.call : this.calls.get(explicit);

    if (!call) {
      return;
    }

    if (newer && known?.call.run) {
      const previous = known.call.run;
      // The old call cannot reopen a child unless another start reuses it.
      delete known.call.run;
      settleRun(previous, undefined, at);
    }

    if (frame.subtype === "task_started") {
      call.run ??= { settled: false };
    }

    const run = call.run;
    const type = frame.subtype === "task_started" ? frame.task_type : undefined;

    if (type !== undefined) {
      call.taskType = type;
    }

    // Untyped task frames can update a child, but cannot prove one exists.
    if (call.taskType === "local_agent") {
      this.child(call, frame.session_id);
    }

    const details = frame.subtype === "task_updated" ? frame.patch : frame;
    const runId = incomingId ?? previousId;

    const description =
      ("description" in details ? details.description : undefined) ??
      known?.description;

    const prompt =
      ("prompt" in details ? details.prompt : undefined) ?? known?.prompt;

    this.tasks.set(frame.task_id, { call, runId, description, prompt });

    const background =
      "is_backgrounded" in details ? details.is_backgrounded : undefined;

    if (run && background !== undefined) {
      run.background = background;
    }

    call.owner.tool(call.id, at, (tool) => {
      const previous = tool.metadata?.["task"];

      const prior =
        !newer &&
        Predicate.isObject(previous) &&
        previous["task_id"] === frame.task_id
          ? previous
          : undefined;

      const data = {
        ...prior,
        subtype: frame.subtype,
        task_id: frame.task_id,
        run_id: runId,
        ...(call.taskType !== undefined && { task_type: call.taskType }),
        ...(description !== undefined && { description }),
        ...(prompt !== undefined && { prompt }),
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

    if (run && outcome) {
      run.reportedOutcome = outcome;
      settleRun(run, undefined, at);
    }
  }

  private result(frame: SDKResultMessage, at: number, fallback: string) {
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

    this.root.result(frame, at, fallback);
  }

  public add(frame: SDKMessage, decision: ClaudeFrameDecision) {
    try {
      const at = Date.now();

      if (frame.type === "result") {
        this.result(frame, at, decision.resultFallback);
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

        if (parent === null && this.root.ended) {
          return;
        }

        const call = parent === null ? undefined : this.calls.get(parent);
        const run = call?.run;

        const thread =
          parent === null
            ? this.root
            : frame.type === "assistant" ||
                frame.type === "user" ||
                frame.type === "stream_event"
              ? this.child(call, frame.session_id)
              : run?.settled
                ? undefined
                : run?.child;

        if (thread) {
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

    for (const call of this.calls.values()) {
      const run = call.run;

      if (!run) {
        continue;
      }

      try {
        const afterTurn = run.background && outcome !== "cancelled";

        settleRun(run, afterTurn ? undefined : outcome, at, () => {
          call.owner.tool(call.id, at, (tool) => {
            tool.unavailable = ["after-turn"];
          });
        });
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
