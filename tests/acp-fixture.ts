#!/usr/bin/env bun
/**
 * Fake ACP / Antigravity agent over stdio JSON-RPC 2.0 for automated tests.
 * Behaviour is controlled by `STARGATE_ACP_FIXTURE_SCENARIO` and logs to
 * `STARGATE_ACP_FIXTURE_LOG` (NDJSON).
 */
import { appendFileSync } from "node:fs";

const scenario = process.env["STARGATE_ACP_FIXTURE_SCENARIO"] ?? "basic";
const logPath = process.env["STARGATE_ACP_FIXTURE_LOG"];

function record(entry: Record<string, unknown>) {
  if (logPath) {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  }
}

function send(message: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

if (process.argv.includes("--version")) {
  const version = process.env["STARGATE_ACP_FIXTURE_VERSION"] ?? "1.5.15";
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

record({
  type: "start",
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: {
    GEMINI_HOME: process.env["GEMINI_HOME"],
    GEMINI_API_KEY: process.env["GEMINI_API_KEY"],
    GOOGLE_API_KEY: process.env["GOOGLE_API_KEY"],
    GOOGLE_CLOUD_PROJECT: process.env["GOOGLE_CLOUD_PROJECT"],
    AGY_ACP_FORCE_FILE_STORAGE: process.env["AGY_ACP_FORCE_FILE_STORAGE"],
    AGY_CLI_DISABLE_AUTO_UPDATE: process.env["AGY_CLI_DISABLE_AUTO_UPDATE"],
    BROWSER: process.env["BROWSER"],
    SECRET_FROM_ENV: process.env["SECRET_FROM_ENV"],
    HOST_SECRET: process.env["HOST_SECRET"],
    STARGATE_ACP_TURN: process.env["STARGATE_ACP_TURN"],
  },
});

let nextClientRequestId = 100;

const pendingClientRequests = new Map<
  number,
  (result: Record<string, unknown>) => void
>();

function askClient(method: string, params: Record<string, unknown>) {
  const id = nextClientRequestId++;

  return new Promise<Record<string, unknown>>((resolve) => {
    pendingClientRequests.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

let activePromptId: number | string | undefined;

async function handleRequest(
  id: number | string,
  method: string,
  params: Record<string, unknown>,
) {
  record({ type: "request", method, params });

  if (method === "initialize") {
    if (scenario === "auth-stdout") {
      process.stdout.write(
        "Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/auth?state=x\n",
      );

      return;
    }

    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "fake-acp", version: "1.5.15" },
        agentCapabilities: {
          loadSession: scenario !== "resume-only",
          sessionCapabilities: { resume: {} },
          _meta: {
            antigravity: {
              systemPrompt: { append: true },
            },
          },
        },
      },
    });

    return;
  }

  if (method === "authenticate") {
    if (scenario === "auth-required") {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32_000, message: "Authentication required" },
      });

      return;
    }

    send({ jsonrpc: "2.0", id, result: {} });

    return;
  }

  if (method === "session/new") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        sessionId: "native-sess-1",
        modes: {
          currentModeId: "auto",
          availableModes: [{ id: "default" }, { id: "auto" }],
        },
        configOptions: [
          {
            id: "model",
            type: "select",
            currentValue: "gemini-3.8-flash",
            options: [
              { value: "gemini-3.8-flash" },
              { value: "claude-sonnet-5-5" },
            ],
          },
          {
            id: "thought_level",
            type: "select",
            category: "thought_level",
            currentValue: "medium",
            options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
          },
        ],
      },
    });

    return;
  }

  if (method === "session/load") {
    const sid = String(params["sessionId"] ?? "native-sess-1");
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "OLD REPLAYED TEXT" },
        },
      },
    });

    if (scenario === "replay-stall") {
      // Intentionally omit JSON-RPC response to verify replay-idle settling.
      return;
    }

    send({ jsonrpc: "2.0", id, result: { sessionId: sid } });

    return;
  }

  if (method === "session/resume") {
    const sid = String(params["sessionId"] ?? "native-sess-1");
    send({
      jsonrpc: "2.0",
      id,
      result: {
        sessionId: sid,
        modes: {
          currentModeId: "default",
          availableModes: [{ id: "default" }],
        },
        configOptions: [
          {
            id: "model",
            type: "select",
            currentValue: "gemini-3.8-flash",
            options: [{ value: "gemini-3.8-flash" }],
          },
        ],
      },
    });

    return;
  }

  if (
    method === "session/set_mode" ||
    method === "session/set_config_option" ||
    method === "session/set_model"
  ) {
    send({ jsonrpc: "2.0", id, result: {} });

    return;
  }

  if (method === "session/prompt") {
    const sid = String(params["sessionId"] ?? "native-sess-1");
    activePromptId = id;

    if (scenario === "copilot-lost-session") {
      send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32_603,
          message:
            "session event delivery failed: session not found: native-sess-1",
        },
      });

      return;
    }

    if (scenario === "slow-cancel") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "working..." },
          },
        },
      });

      return;
    }

    if (scenario === "permission-check") {
      const targetPath =
        process.env["STARGATE_ACP_TEST_TARGET_PATH"] ?? "ok.txt";

      const toolKind = process.env["STARGATE_ACP_TEST_TOOL_KIND"] ?? "edit";

      const outcome = await askClient("session/request_permission", {
        sessionId: sid,
        toolCall: {
          toolCallId: "call-1",
          title: "Modify file",
          kind: toolKind,
          locations: [{ path: targetPath }],
          rawInput: { path: targetPath },
        },
        options: [
          { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
          { optionId: "reject-once", kind: "reject_once", name: "Reject once" },
        ],
      });

      record({ type: "permission-outcome", outcome });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-1",
            title: "Modify file",
            kind: toolKind,
            status: "completed",
            rawInput: { path: targetPath },
          },
        },
      });

      const selected =
        (outcome["outcome"] as Record<string, unknown> | undefined)?.[
          "optionId"
        ] ?? "cancelled";

      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `decision:${String(selected)}` },
          },
        },
      });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });

      return;
    }

    if (scenario === "copilot-subagent") {
      send({
        jsonrpc: "2.0",
        method: "github.com/copilot/sessionEvent",
        params: {
          sessionId: sid,
          type: "subagent.started",
          agentId: "sub-1",
          data: { toolCallId: "task-1" },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "github.com/copilot/sessionEvent",
        params: {
          sessionId: sid,
          type: "assistant.message_delta",
          agentId: "sub-1",
          data: { deltaContent: "SUBAGENT NOISE" },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "SUBAGENT NOISE" },
          },
        },
      });
    }

    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "hidden reasoning" },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello " },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "world!" },
        },
      },
    });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  }
}

let buffer = "";

process.stdin.setEncoding("utf8");

process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let nl = buffer.indexOf("\n");

  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);

    if (line.length > 0) {
      const msg = JSON.parse(line) as Record<string, unknown>;

      if (typeof msg["method"] === "string" && msg["id"] !== undefined) {
        void handleRequest(
          msg["id"] as number | string,
          msg["method"],
          (msg["params"] as Record<string, unknown> | undefined) ?? {},
        );
      } else if (msg["method"] === "session/cancel") {
        record({ type: "notification", method: "session/cancel" });

        if (activePromptId !== undefined) {
          const promptId = activePromptId;
          activePromptId = undefined;
          send({
            jsonrpc: "2.0",
            id: promptId,
            result: { stopReason: "cancelled" },
          });
        }
      } else if (typeof msg["id"] === "number") {
        const resolver = pendingClientRequests.get(msg["id"]);

        if (resolver) {
          pendingClientRequests.delete(msg["id"]);
          resolver(
            (msg["result"] as Record<string, unknown> | undefined) ?? {},
          );
        }
      }
    }

    nl = buffer.indexOf("\n");
  }
});
