/**
 * Fake `codex app-server` CLI for tests: speaks JSON-RPC 2.0 over stdio,
 * records its arguments, RPC parameters and environment in `CODEX_HOME`, and
 * never contacts a provider. Prompt keywords select behaviour: `hang`, `fail`,
 * `crash`, `linger`, `rethread`, `stubborn`, `detached`, `deaf`, `hold`,
 * `swap`, `delta`, `wait-steer`.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const home = process.env["CODEX_HOME"] ?? "";
const args = process.argv.slice(2);

const log = (entry: Record<string, unknown>) =>
  appendFileSync(join(home, "fixture.jsonl"), `${JSON.stringify(entry)}\n`);

const send = (message: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify(message)}\n`);

let deaf = false;

process.on("SIGTERM", () => {
  if (!deaf) {
    process.exit(143);
  }
});

async function startStubborn(detached: boolean) {
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

let activeThreadId = "";
let activeTurnId = "";
let waitingForSteer = false;

function finishNormalTurn(prompt: string) {
  send({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId: activeThreadId,
      turnId: activeTurnId,
      item: {
        id: crypto.randomUUID(),
        type: "reasoning",
        text: "private reasoning",
      },
    },
  });
  send({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId: activeThreadId,
      turnId: activeTurnId,
      item: {
        id: crypto.randomUUID(),
        type: "commandExecution",
        command: "cat /secret",
        aggregatedOutput: "SECRETOUTPUT",
        exitCode: 0,
        status: "completed",
      },
    },
  });

  if (prompt.includes("delta")) {
    send({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: {
        threadId: activeThreadId,
        turnId: activeTurnId,
        itemId: "msg_1",
        delta: "Hello ",
      },
    });
    send({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: {
        threadId: activeThreadId,
        turnId: activeTurnId,
        itemId: "msg_1",
        delta: "world",
      },
    });
  } else {
    send({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: activeThreadId,
        turnId: activeTurnId,
        item: { id: "msg_1", type: "agentMessage", text: "" },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: activeThreadId,
        turnId: activeTurnId,
        item: { id: "msg_1", type: "agentMessage", text: "Hello world" },
      },
    });
  }

  send({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId: activeThreadId,
      turnId: activeTurnId,
      item: {
        id: crypto.randomUUID(),
        type: "agentMessage",
        text: "Done.",
      },
    },
  });
  send({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: {
      threadId: activeThreadId,
      turn: { id: activeTurnId, status: "completed", error: null },
    },
  });

  if (prompt.includes("linger")) {
    setInterval(() => {}, 1000);
  }
}

async function handleRequest(
  id: number | string,
  method: string,
  params: Record<string, unknown>,
) {
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: { userAgent: "fake-codex/0.170.0" },
    });

    return;
  }

  if (method === "thread/start" || method === "thread/resume") {
    const sessions = join(home, "sessions");
    mkdirSync(sessions, { recursive: true });

    const requested =
      typeof params["threadId"] === "string" ? params["threadId"] : undefined;

    if (
      method === "thread/resume" &&
      requested &&
      !existsSync(join(sessions, requested))
    ) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32_000, message: "no such thread" },
      });

      return;
    }

    const threadId =
      method === "thread/resume" &&
      process.env["STARGATE_TEST_RETHREAD"] === "1"
        ? crypto.randomUUID()
        : (requested ?? crypto.randomUUID());

    activeThreadId = threadId;
    writeFileSync(join(sessions, threadId), method);
    log({
      pid: process.pid,
      argv: args,
      env: process.env,
      cwd: process.cwd(),
      threadMethod: method,
      ...(requested ? { resumedThread: requested } : {}),
      sandbox: String(params["sandbox"] ?? ""),
      approvalPolicy: String(params["approvalPolicy"] ?? ""),
      model: String(params["model"] ?? ""),
    });
    send({
      jsonrpc: "2.0",
      id,
      result: { thread: { id: threadId } },
    });

    return;
  }

  if (method === "turn/start") {
    const input = Array.isArray(params["input"])
      ? (params["input"] as Record<string, unknown>[])
      : [];

    const prompt = input
      .filter((entry) => entry["type"] === "text")
      .map((entry) => String(entry["text"] ?? ""))
      .join("\n");

    const images = input
      .filter((entry) => entry["type"] === "localImage")
      .map((entry) => existsSync(String(entry["path"] ?? "")));

    deaf = prompt.includes("deaf");
    activeTurnId = crypto.randomUUID();
    log({
      prompt,
      images,
      effort: params["effort"] ?? null,
      sandboxPolicy: params["sandboxPolicy"] ?? null,
    });

    if (prompt.includes("overflow")) {
      send({
        jsonrpc: "2.0",
        id,
        result: { turn: { id: activeTurnId } },
      });
      process.stdout.write(`${"x".repeat(16 * 1024 * 1024 + 64)}\n`);

      return;
    }

    if (prompt.includes("server-requests")) {
      send({
        jsonrpc: "2.0",
        id,
        result: { turn: { id: activeTurnId } },
      });
      send({
        jsonrpc: "2.0",
        id: 9001,
        method: "item/commandExecution/requestApproval",
        params: { command: "rm -rf /" },
      });
      send({
        jsonrpc: "2.0",
        id: 9002,
        method: "item/tool/requestUserInput",
        params: { question: "secret?" },
      });

      return;
    }

    if (prompt.includes("foreign-turn")) {
      send({
        jsonrpc: "2.0",
        id,
        result: { turn: { id: activeTurnId } },
      });
      send({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          threadId: activeThreadId,
          turnId: "other-turn",
          itemId: "msg_foreign",
          delta: "FOREIGN",
        },
      });
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: activeThreadId,
          turn: {
            id: "other-turn",
            status: "failed",
            error: { message: "bad" },
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId: activeThreadId,
          turnId: activeTurnId,
          item: {
            id: "tool_fail",
            type: "commandExecution",
            command: "false",
            status: "failed",
          },
        },
      });
      finishNormalTurn(prompt);

      return;
    }

    if (prompt.includes("rethread")) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32_000, message: "thread changed" },
      });

      return;
    }

    send({
      jsonrpc: "2.0",
      id,
      result: { turn: { id: activeTurnId } },
    });
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: activeThreadId, turn: { id: activeTurnId } },
    });

    if (prompt.includes("stubborn")) {
      await startStubborn(prompt.includes("detached"));
    }

    if (prompt.includes("swap")) {
      const link = process.env["STARGATE_TEST_LINK"] ?? "";
      rmSync(link);
      symlinkSync(process.env["STARGATE_TEST_TARGET"] ?? "", link);
      spawnSync("git", ["--version"], { stdio: "ignore" });
    }

    if (prompt.includes("hold")) {
      const holder = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          stdio: ["ignore", "inherit", "inherit"],
          env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
        },
      );

      log({ grandchild: holder.pid });
    }

    if (prompt.includes("hang")) {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore" },
      );

      log({ grandchild: child.pid });
      setInterval(() => {}, 1000);

      return;
    }

    if (prompt.includes("wait-steer")) {
      waitingForSteer = true;
      send({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          threadId: activeThreadId,
          turnId: activeTurnId,
          itemId: "msg_1",
          delta: "Working",
        },
      });

      return;
    }

    if (prompt.includes("crash")) {
      process.stderr.write("raw stderr detail: upstream said no\n");
      process.exit(3);
    }

    if (prompt.includes("fail")) {
      const message =
        /fail=([^;]*);/.exec(prompt)?.[1] ?? "raw upstream detail";

      if (prompt.includes("tool")) {
        send({
          jsonrpc: "2.0",
          method: "item/completed",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            item: {
              id: "item_c",
              type: "commandExecution",
              command: "deploy",
              status: "completed",
            },
          },
        });
      }

      if (prompt.includes("fatal")) {
        send({
          jsonrpc: "2.0",
          method: "error",
          params: {
            threadId: activeThreadId,
            turnId: activeTurnId,
            willRetry: false,
            error: { message },
          },
        });
      } else {
        send({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: {
            threadId: activeThreadId,
            turn: {
              id: activeTurnId,
              status: "failed",
              error: { message },
            },
          },
        });
      }

      return;
    }

    finishNormalTurn(prompt);

    return;
  }

  if (method === "turn/steer") {
    const input = Array.isArray(params["input"])
      ? (params["input"] as Record<string, unknown>[])
      : [];

    const steeredText = input
      .filter((entry) => entry["type"] === "text")
      .map((entry) => String(entry["text"] ?? ""))
      .join("\n");

    log({ steered: steeredText });
    send({ jsonrpc: "2.0", id, result: {} });

    if (waitingForSteer) {
      waitingForSteer = false;
      send({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          threadId: activeThreadId,
          turnId: activeTurnId,
          itemId: "msg_1",
          delta: " -> steered!",
        },
      });
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: activeThreadId,
          turn: { id: activeTurnId, status: "completed", error: null },
        },
      });
    }

    return;
  }

  if (method === "turn/interrupt") {
    log({ interrupted: true });
    send({ jsonrpc: "2.0", id, result: {} });
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
      } else if (msg["id"] === 9001 || msg["id"] === 9002) {
        log({
          serverReplyId: msg["id"],
          result: msg["result"] ?? null,
          error: msg["error"] ?? null,
        });

        if (msg["id"] === 9002) {
          finishNormalTurn("server-requests");
        }
      }
    }

    nl = buffer.indexOf("\n");
  }
});
