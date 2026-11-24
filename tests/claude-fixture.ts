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
) {
  write({
    type: "result",
    subtype,
    is_error: isError,
    ...(text === undefined ? {} : { result: text }),
    ...(status === undefined ? {} : { api_error_status: status }),
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

function assistant(id: string, block: object, error?: string) {
  write({
    type: "assistant",
    parent_tool_use_id: null,
    ...(error ? { error } : {}),
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "fixture",
      content: [block],
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

  // "fail", "fail:<cause>" or "fail:<cause>:<status>"; "tool" runs one first.
  const failure = /fail(?::(\w+))?(?::(\d+))?/.exec(text);

  if (failure) {
    if (text.includes("tool")) {
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
