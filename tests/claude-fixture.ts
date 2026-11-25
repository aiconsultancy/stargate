/**
 * Fake Claude Code CLI for tests: speaks the SDK's stream-json protocol on
 * stdin/stdout, records its arguments and environment beside
 * CLAUDE_CONFIG_DIR, and never contacts a provider. The prompt text selects
 * the behaviour: `hang`, `fail`, `crash`, otherwise a two-message answer.
 * `stubborn` first starts a tool process that ignores SIGTERM; `detached`
 * puts it in its own session, as Claude Code does for Bash commands.
 * `linger` keeps the CLI running after its result, as a background task
 * does.
 */
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

if (process.argv.includes("--version")) {
  writeFileSync(
    join(process.cwd(), "fixture-probe.pending"),
    JSON.stringify({
      pid: process.pid,
      argv: process.argv.slice(2),
      env: process.env,
    }),
  );
  renameSync(
    join(process.cwd(), "fixture-probe.pending"),
    join(process.cwd(), "fixture-probe.json"),
  );
  const version = readFileSync(join(process.cwd(), "fixture-version"), "utf8");

  if (version === "hang") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }

  if (version === "fail") {
    console.error("private-version-error");
    process.exit(1);
  }

  console.log(version);
  process.exit(0);
}

const home = process.env["CLAUDE_CONFIG_DIR"] ?? "";

const flag = (name: string) => {
  const index = process.argv.findIndex(
    (argument) => argument === name || argument.startsWith(`${name}=`),
  );

  const argument = process.argv[index];

  if (index < 0 || argument === undefined) {
    return undefined;
  }

  return argument.includes("=")
    ? argument.slice(name.length + 1)
    : process.argv[index + 1];
};

const created = flag("--session-id");
const resumed = flag("--resume");
const session = created ?? resumed ?? "";
const transcript = join(home, "projects", "fixture", `${session}.jsonl`);

const log = (entry: object) =>
  appendFileSync(join(home, "fixture.jsonl"), `${JSON.stringify(entry)}\n`);

log({
  pid: process.pid,
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
});

const write = (frame: unknown) =>
  process.stdout.write(`${JSON.stringify(frame)}\n`);

const base = () => ({ session_id: session, uuid: crypto.randomUUID() });

function result(
  subtype: string,
  isError: boolean,
  text?: string,
  status?: number,
  errors?: string[],
) {
  write({
    type: "result",
    subtype,
    is_error: isError,
    ...(text === undefined ? {} : { result: text }),
    ...(status === undefined ? {} : { api_error_status: status }),
    ...(errors === undefined ? {} : { errors }),
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    ...base(),
  });
}

function assistant(
  id: string,
  block: object,
  error?: string,
  parent: string | null = null,
) {
  write({
    type: "assistant",
    parent_tool_use_id: parent,
    ...(error ? { error } : {}),
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "fixture",
      content: Array.isArray(block) ? block : [block],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    ...base(),
  });
}

function stream(event: object, parent: string | null = null) {
  write({
    type: "stream_event",
    parent_tool_use_id: parent,
    event,
    ...base(),
  });
}

let forwardSubagentText = false;

/** Replay SDK stream-json frames, one final assistant envelope per block. */
function activityFrames() {
  const emit = (frame: object) => write({ ...base(), ...frame });

  const usage = {
    input_tokens: 3,
    output_tokens: 7,
    cache_read_input_tokens: 4,
    cache_creation_input_tokens: 5,
  };

  const partial = process.argv.includes("--include-partial-messages")
    ? stream
    : () => {};

  const id = "msg_activity";
  const model = "fixture";
  partial({
    type: "message_start",
    message: { id, model, usage: { ...usage, output_tokens: 0 } },
  });

  const blocks = [
    [
      { type: "thinking", thinking: "" },
      { type: "thinking_delta", thinking: "think\u0002" },
      { type: "thinking", thinking: "think\u0002" },
    ],
    [
      { type: "redacted_thinking", data: "provider-ciphertext" },
      null,
      { type: "redacted_thinking", data: "provider-ciphertext" },
    ],
    [
      { type: "text", text: "" },
      { type: "text_delta", text: "reply\n\t" },
      { type: "text", text: "reply\n\t" },
    ],
    ...["tool_ok", "tool_denied", "tool_child", "tool_background"].map((id) => [
      {
        type: "tool_use",
        id,
        name:
          id.startsWith("tool_c") || id.endsWith("background")
            ? "Agent"
            : "Read",
        input: {},
      },
      { type: "input_json_delta", partial_json: '{"key": "value"}' },
      {
        type: "tool_use",
        id,
        name:
          id.startsWith("tool_c") || id.endsWith("background")
            ? "Agent"
            : "Read",
        input: { key: "value" },
      },
    ]),
    [
      {
        type: "server_tool_use",
        id: "tool_server",
        name: "web_search",
        input: {},
      },
      { type: "input_json_delta", partial_json: '{"query":"fixture"}' },
      {
        type: "server_tool_use",
        id: "tool_server",
        name: "web_search",
        input: { query: "fixture" },
      },
    ],
  ] as const;

  for (const [index, [start, delta, final]] of blocks.entries()) {
    partial({ type: "content_block_start", index, content_block: start });

    if (delta) {
      partial({ type: "content_block_delta", index, delta });
    }

    partial({ type: "content_block_stop", index });

    if (final) {
      assistant(id, final);
    }
  }

  partial({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage });
  partial({ type: "message_stop" });
  emit({
    type: "tool_progress",
    tool_use_id: "tool_ok",
    tool_name: "Read",
    parent_tool_use_id: null,
    elapsed_time_seconds: 1.5,
  });
  emit({
    type: "system",
    subtype: "permission_denied",
    tool_use_id: "tool_denied",
    tool_name: "Read",
    message: "Permission denied (fixture)",
  });

  for (const [id, text, failed] of [
    ["tool_ok", "tool output\u0001", false],
    ["tool_denied", "denial result", true],
  ] as const) {
    emit({
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content: text,
            is_error: failed,
          },
        ],
      },
      tool_use_result: { text },
    });
  }

  emit({
    type: "system",
    subtype: "task_started",
    task_id: "task-1",
    run_id: "run-1",
    tool_use_id: "tool_child",
    description: "child",
    is_backgrounded: false,
  });
  emit({
    type: "system",
    subtype: "task_started",
    task_id: "task-2",
    run_id: "run-2",
    tool_use_id: "tool_background",
    task_type: "local_agent",
    description: "background",
    is_backgrounded: true,
  });

  if (forwardSubagentText) {
    assistant(
      "msg_child",
      { type: "text", text: "child only" },
      undefined,
      "tool_child",
    );
    assistant(
      "msg_unknown",
      { type: "text", text: "unlinked" },
      undefined,
      "unknown",
    );
    const child = (event: object) => partial(event, "tool_child");
    child({
      type: "message_start",
      message: { id: "msg_child_partial", model, usage },
    });
    child({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    });
    child({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "child thought" },
    });
    child({ type: "content_block_stop", index: 0 });
    child({
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    });
    child({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "child partial" },
    });
    child({ type: "content_block_stop", index: 1 });
    child({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage });
    child({ type: "message_stop" });
  }

  emit({
    type: "system",
    subtype: "task_progress",
    task_id: "task-1",
    run_id: "run-1",
    tool_use_id: "tool_child",
    description: "updated child",
    usage: { total_tokens: 5, duration_ms: 3, tool_uses: 1 },
  });
  emit({
    type: "system",
    subtype: "task_updated",
    task_id: "task-1",
    run_id: "run-1",
    patch: { description: "updated child" },
  });
  emit({
    type: "system",
    subtype: "task_notification",
    task_id: "task-1",
    run_id: "run-1",
    status: "completed",
    summary: "child finished",
  });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "reply\n\t",
    num_turns: 1,
    total_cost_usd: 0.25,
    usage,
    permission_denials: [],
  });
}

/** A tool process that survives SIGTERM, in the CLI's group or not. */
async function stubborn(detached: boolean) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
    ],
    { stdio: ["ignore", "pipe", "ignore"], detached },
  );

  await new Promise((resolve) => child.stdout.once("data", resolve));
  log({ grandchild: child.pid });
}

let linger = false;

async function answer(text: string) {
  linger = text.includes("linger");

  if (resumed && !existsSync(transcript)) {
    return result("error_during_execution", true);
  }

  mkdirSync(join(home, "projects", "fixture"), { recursive: true });
  appendFileSync(transcript, `${JSON.stringify({ type: "user", text })}\n`);
  write({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    tools: [],
    mcp_servers: [],
    model: "fixture",
    permissionMode: "dontAsk",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    apiKeySource: "none",
    claude_code_version: "fixture",
    ...base(),
  });

  if (text.includes("stubborn")) {
    await stubborn(text.includes("detached"));
  }

  if (text.includes("hang")) {
    // A tool command in the same process group must stop with the CLI.
    const child = spawn("sleep", ["600"], { stdio: "ignore" });
    log({ grandchild: child.pid });

    return;
  }

  if (text.includes("crash")) {
    process.exit(3);
  }

  if (text === "activity frames") {
    activityFrames();

    return;
  }

  if (text === "late task run activity") {
    const task = {
      type: "system",
      task_id: "task-resumed",
      tool_use_id: "tool_resumed",
    };

    assistant("msg_spawn", {
      type: "tool_use",
      id: task.tool_use_id,
      name: "Agent",
      input: {},
    });

    for (const runId of ["001", "002"]) {
      write({
        ...base(),
        ...task,
        subtype: "task_started",
        run_id: runId,
        task_type: "local_agent",
        description: `Started ${runId}`,
        is_backgrounded: runId === "002",
      });
    }

    write({
      ...base(),
      ...task,
      subtype: "task_notification",
      run_id: "001",
      status: "completed",
      summary: "Stale completion",
    });
    write({
      ...base(),
      type: "system",
      subtype: "task_updated",
      task_id: task.task_id,
      run_id: "002",
      patch: { description: "Current run updated" },
    });
    assistant("msg_observed", { type: "text", text: "Task observed" });

    return result("success", false, "Task observed");
  }

  if (text === "background bash activity") {
    assistant("msg_bash", {
      type: "tool_use",
      id: "bash_call",
      name: "Bash",
      input: { command: "echo fixture" },
    });
    write({
      type: "system",
      subtype: "task_started",
      task_id: "bash_task",
      tool_use_id: "bash_call",
      task_type: "local_bash",
      is_backgrounded: true,
      description: "background shell",
      ...base(),
    });

    return result("success", false, "bash observed");
  }

  if (text === "batched assistant activity") {
    assistant("msg_batch", { type: "thinking", thinking: "first" });
    assistant("msg_batch", [
      { type: "text", text: "second" },
      { type: "tool_use", id: "third_call", name: "Read", input: {} },
    ]);

    return result("success", false, "second");
  }

  if (text === "repeated block types activity") {
    const first = { type: "tool_use", id: "call_a", name: "Read", input: {} };
    assistant("msg_repeat", [{ type: "text", text: "first" }, first]);
    // A full replay shares both content and tool ID; the later batch does not.
    assistant("msg_repeat", [{ type: "text", text: "first" }, first]);
    assistant("msg_repeat", [
      { type: "text", text: "first" },
      { type: "tool_use", id: "call_b", name: "Read", input: {} },
    ]);

    return result("success", false, "first");
  }

  if (text === "text prefix activity") {
    assistant("msg_prefix", { type: "text", text: "a" });
    assistant("msg_prefix", [
      { type: "text", text: "b" },
      { type: "tool_use", id: "call_x", name: "Read", input: {} },
    ]);

    return result("success", false, "b");
  }

  if (text === "result only reply") {
    return result("success", false, "result-only reply");
  }

  if (text === "reply dropped after error") {
    assistant("msg_dropped", { type: "text", text: "former reply" });
    assistant(
      "msg_dropped",
      { type: "text", text: "synthetic error" },
      "rate_limit",
    );

    return result("success", false, "fallback after error");
  }

  if (text === "streamed partial reply") {
    // The preview stops at "hel"; no assistant message completes it.
    stream({ type: "message_start", message: { id: "msg_partial" } });
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hel" },
    });
    stream({ type: "content_block_stop", index: 0 });

    return result("success", false, "hello");
  }

  if (text === "result marked error") {
    return result(
      "success",
      true,
      "API Error: 529 upstream said sk-ant-api03-fixture-credential",
      529,
    );
  }

  if (text === "result errors") {
    return result("error_max_turns", true, undefined, undefined, [
      "first error",
      "second error\twith detail",
    ]);
  }

  // "fail", "fail:<cause>" or "fail:<cause>:<status>"; "tool" runs one first.
  const failure = /fail(?::(\w+))?(?::(\d+))?/.exec(text);

  if (failure) {
    if (text.startsWith("subagent result ")) {
      // Subagent tool results reach the SDK whether or not text is forwarded.
      write({
        type: "user",
        parent_tool_use_id: "parent_call",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "child_call",
              content: "child output",
              is_error: false,
            },
          ],
        },
        ...base(),
      });
    } else if (text.startsWith("subagent text ")) {
      // Only a forwarding consumer receives subagent text, and the pinned
      // CLI never sends a parented stream_event: this one proves it ignored.
      if (forwardSubagentText) {
        assistant(
          "msg_subagent_text",
          { type: "text", text: "child text" },
          undefined,
          "parent_call",
        );
        stream(
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "child delta" },
          },
          "parent_call",
        );
      }
    } else if (text.startsWith("subagent ")) {
      assistant(
        "msg_subagent_tool",
        {
          type: "tool_use",
          id: "child_call",
          name: "Read",
          input: {},
        },
        undefined,
        "parent_call",
      );
    } else if (text.includes("tool")) {
      assistant("msg_tool", {
        type: "tool_use",
        id: "toolu_1",
        name: "Bash",
        input: { command: "deploy" },
      });
    }

    assistant(
      "msg_fail",
      { type: "text", text: "API Error: raw upstream detail sk-ant-secret" },
      failure[1] ?? "rate_limit",
    );

    return result(
      "success",
      true,
      "API Error: raw upstream detail sk-ant-secret",
      failure[2] ? Number(failure[2]) : undefined,
    );
  }

  stream({ type: "message_start", message: { id: "msg_1" } });
  stream({
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "" },
  });
  stream({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "private" },
  });
  stream({
    type: "content_block_start",
    index: 1,
    content_block: { type: "text", text: "" },
  });
  stream({
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "Hello" },
  });
  stream({
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: " world" },
  });
  // Subagent text never reaches the visible reply.
  stream(
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "subagent" },
    },
    "toolu_sub",
  );
  assistant("msg_1", { type: "thinking", thinking: "private" });
  assistant("msg_1", { type: "text", text: "Hello world" });
  assistant("msg_1", {
    type: "tool_use",
    id: "toolu_1",
    name: "Read",
    input: { file_path: "/secret" },
  });
  stream({ type: "message_start", message: { id: "msg_2" } });
  stream({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "Done." },
  });
  assistant("msg_2", { type: "text", text: "Done." });
  result("success", false, "Done.");
}

let buffer = "";

process.stdin.setEncoding("utf8");

process.stdin.on("data", (chunk: string) => {
  buffer += chunk;

  for (
    let index = buffer.indexOf("\n");
    index >= 0;
    index = buffer.indexOf("\n")
  ) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);

    if (!line.trim()) {
      continue;
    }

    const frame = JSON.parse(line);
    log({ input: frame });

    if (frame.type === "control_request") {
      if (frame.request?.subtype === "initialize") {
        forwardSubagentText = frame.request.forwardSubagentText === true;
      }

      write({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: frame.request_id,
          response: { mcp_servers_applied: true },
        },
      });
    } else if (frame.type === "user") {
      const content = frame.message.content;
      void answer(
        typeof content === "string"
          ? content
          : content
              .map((block: { text?: string }) => block.text ?? "")
              .join("\n"),
      );
    }
  }
});

process.stdin.on("end", () => {
  if (linger) {
    setInterval(() => {}, 1000);
  } else {
    process.exit(0);
  }
});
