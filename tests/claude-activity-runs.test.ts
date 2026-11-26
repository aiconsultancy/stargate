import { expect, test } from "bun:test";
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeActivity } from "../src/backends/claude/activity";
import { createActivityHub } from "../src/observability/dashboard/api/v1/activity";

const sessionId = "test-session";
const callId = "tool_resumed";
const taskId = "task-resumed";
const envelope = () => ({ uuid: crypto.randomUUID(), session_id: sessionId });

function fixture() {
  const hub = createActivityHub();
  const activity = ClaudeActivity.start(hub.recorder("officer"), sessionId);

  if (!activity) {
    throw new Error("Expected Claude activity recorder");
  }

  const add = (frame: SDKMessage) =>
    activity.add(frame, {
      changed: false,
      resultFallback: "",
    });

  const task = (
    frame:
      | SDKTaskNotificationMessage
      | SDKTaskProgressMessage
      | SDKTaskStartedMessage
      | SDKTaskUpdatedMessage,
  ) => add(frame);

  function assistant(
    id: string,
    block: SDKAssistantMessage["message"]["content"][number],
    parent: string | null,
  ) {
    add({
      ...envelope(),
      type: "assistant",
      parent_tool_use_id: parent,
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "fixture",
        content: [block],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        container: null,
        context_management: null,
        diagnostics: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation: null,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          fallback_credit: null,
          inference_geo: null,
          iterations: null,
          output_tokens_details: null,
          server_tool_use: null,
          service_tier: null,
          speed: null,
        },
      },
    });
  }

  const spawn = (toolUseId: string) =>
    assistant(
      `msg_${toolUseId}`,
      { type: "tool_use", id: toolUseId, name: "Agent", input: {} },
      null,
    );

  spawn(callId);

  const taskFrame = (runId: string) => ({
    ...envelope(),
    type: "system" as const,
    task_id: taskId,
    run_id: runId,
  });

  return {
    task,
    taskFrame,
    spawn,
    start(runId: string, first = false, toolUseId = callId) {
      task({
        ...taskFrame(runId),
        subtype: "task_started",
        tool_use_id: toolUseId,
        task_type: "local_agent",
        description: "Review the fixture",
        ...(first && { prompt: "Check the examples", is_backgrounded: true }),
      });
    },
    output(runId: string, toolUseId = callId) {
      // Both runs reuse a message ID; deduplication must be scoped to each child.
      assistant(
        "msg_child",
        { type: "text", text: `Output ${runId}`, citations: null },
        toolUseId,
      );
    },
    toolResult() {
      add({
        ...envelope(),
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: callId,
              content: "Tool result",
            },
          ],
        },
      });
    },
    finish(runId: string, status: "stopped" | "failed") {
      task({
        ...taskFrame(runId),
        subtype: "task_notification",
        tool_use_id: callId,
        status,
        output_file: "fixture.jsonl",
        summary: `Run ${runId} ${status}`,
      });
    },
    end: () => activity.end("completed"),
    children: () =>
      hub.turns("officer")?.turns.filter((turn) => turn.session?.parent) ?? [],
    tool: () =>
      hub
        .turns("officer")
        ?.turns[0]?.items.find(
          (item) => item.kind === "tool" && item.callId === callId,
        ),
  };
}

test.each(["paused", "running", "settled"] as const)(
  "a resumed Claude task owns a new child after a %s run",
  (state) => {
    const f = fixture();
    f.start("001", true);
    f.output("001");

    if (state === "paused") {
      f.task({
        ...f.taskFrame("001"),
        subtype: "task_updated",
        patch: { status: "paused" },
      });
    } else if (state === "settled") {
      f.finish("001", "stopped");
    }

    expect(f.children().map(({ status }) => status)).toEqual([
      state === "settled" ? "cancelled" : "running",
    ]);
    f.start("002");

    const live = f.children();
    expect(live.map(({ status }) => status)).toEqual(["cancelled", "running"]);
    expect(live[0]?.endedAt).toBeNumber();
    expect(live[0]?.lost).toBe(state === "settled" ? undefined : true);

    if (state !== "settled") {
      expect(live[0]?.items[0]).toMatchObject({
        kind: "step",
        status: "running",
        endedAt: null,
      });
    }

    f.output("002");
    f.finish("001", "failed"); // Late, explicitly linked to the same tool.
    expect(f.children()[1]?.status).toBe("running");
    f.finish("002", "failed");
    f.end();

    const children = f.children();
    expect(children.map(({ status }) => status)).toEqual([
      "cancelled",
      "failed",
    ]);
    expect(
      children.map(({ items }) =>
        items.flatMap((item) =>
          item.kind === "text" && "text" in item ? [item.text] : [],
        ),
      ),
    ).toEqual([["Output 001"], ["Output 002"]]);
    expect(children[0]).toEqual(live[0]);
    expect(children[1]?.lost).toBeUndefined();
  },
);

test("a resumed Claude task keeps the prior prompt but clears run metadata", () => {
  const f = fixture();
  f.start("001", true);
  f.task({
    ...f.taskFrame("001"),
    subtype: "task_progress",
    description: "Updated task description",
    summary: "Old progress",
    usage: { total_tokens: 4, tool_uses: 1, duration_ms: 100 },
  });
  f.task({
    ...f.taskFrame("001"),
    subtype: "task_updated",
    patch: { status: "paused", error: "Old error" },
  });
  f.start("002");

  const tool = f.tool();
  expect(tool).toMatchObject({
    metadata: {
      task: {
        run_id: "002",
        prompt: "Check the examples",
        description: "Review the fixture",
      },
    },
  });

  for (const field of [
    "status",
    "summary",
    "usage",
    "error",
    "is_backgrounded",
  ]) {
    expect(tool).not.toHaveProperty(`metadata.task.${field}`);
  }

  f.end();
});

test("a settled Claude run does not pass its background flag to its successor", () => {
  const f = fixture();
  f.start("001", true);
  f.finish("001", "stopped");
  f.start("002");
  f.end();

  expect(f.children().map(({ status }) => status)).toEqual([
    "cancelled",
    "completed",
  ]);
  expect(f.tool()).not.toHaveProperty("unavailable");
});

test("an after-turn background child is lost even after a launch acknowledgement", () => {
  const f = fixture();
  f.start("001", true);
  f.output("001");
  f.toolResult();
  f.end();

  expect(f.tool()).toMatchObject({
    status: "completed",
    unavailable: ["after-turn"],
  });
  expect(f.children()).toMatchObject([
    { status: "cancelled", lost: true, endedAt: expect.any(Number) },
  ]);
});

test("unsettled steps keep their last observed status after the background child ends", () => {
  const f = fixture();
  f.start("001", true);
  f.output("001");

  const step = f.children()[0]?.items[0];
  expect(step).toMatchObject({
    kind: "step",
    status: "running",
    endedAt: null,
  });
  f.end();

  expect(f.children()[0]?.items[0]).toEqual(step);
});

test.each([false, true])(
  "a superseded Claude child resolves its tool result (background: %s)",
  (background) => {
    const f = fixture();
    f.start("001", background);
    f.task({
      ...f.taskFrame("001"),
      subtype: "task_updated",
      patch: { is_backgrounded: background },
    });
    f.output("001");
    f.toolResult();
    f.start("002");

    const [previous, current] = f.children();
    expect(previous).toMatchObject({
      status: background ? "cancelled" : "completed",
      endedAt: expect.any(Number),
    });
    expect(previous?.lost).toBe(background ? true : undefined);
    expect(current?.status).toBe("running");
    f.end();
  },
);

test("a newer Claude task start settles the previous child across different calls", () => {
  const f = fixture();
  const second = "tool_successor";
  f.start("001", true);
  f.output("001");
  f.spawn(second);
  f.start("002", false, second);
  f.output("002", second);

  expect(f.children()).toMatchObject([
    { status: "cancelled", lost: true, session: { parent: { callId } } },
    { status: "running", session: { parent: { callId: second } } },
  ]);

  f.start("003");
  f.output("003");

  expect(f.children()).toMatchObject([
    { status: "cancelled", lost: true, session: { parent: { callId } } },
    {
      status: "cancelled",
      lost: true,
      session: { parent: { callId: second } },
    },
    { status: "running", session: { parent: { callId } } },
  ]);
  f.end();
  expect(f.tool()).not.toHaveProperty("unavailable");
});
