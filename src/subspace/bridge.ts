import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
} from "node:http";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

/** Idle limit on the socket: longer than the proxy's own upstream bound. */
const socketIdleMs = 330_000;
const maxMessageBytes = 4 * 1024 * 1024;
const maxResponseBytes = 64 * 1024 * 1024;

type SocketReply = {
  status: number;
  headers: IncomingHttpHeaders;
  body: IncomingMessage;
};

/** One HTTP request over the officer's socket; never a TCP fallback. */
function socketRequest(
  socketPath: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
): Promise<SocketReply> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        socketPath,
        path,
        method,
        agent: false,
        timeout: socketIdleMs,
        headers: {
          ...headers,
          ...(body && { "content-length": String(body.length) }),
        },
      },
      (response) => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
        });
      },
    );

    outgoing.once("timeout", () => {
      outgoing.destroy(new Error("timeout"));
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

async function readAll(body: Readable, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of body) {
    const buffer = chunk as Buffer;
    size += buffer.length;

    if (size > limit) {
      body.destroy();
      throw new Error("Response too large");
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type RpcId = string | number;

const rpcError = (id: RpcId | null, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/** The words for a refusal: the proxy's own, or the API's status and title. */
function failureText(status: number, text: string) {
  try {
    const value: unknown = JSON.parse(text);

    if (isRecord(value) && value["source"] === "stargate") {
      return String(value["error"]);
    }

    const detail = isRecord(value)
      ? [value["title"], value["detail"]].find(
          (item): item is string => typeof item === "string",
        )
      : undefined;

    if (detail) {
      return `The Subspace API answered HTTP ${status}: ${detail.slice(0, 200)}`;
    }
  } catch {
    // Not JSON: the status alone.
  }

  return `The Subspace API answered HTTP ${status}`;
}

/** The data of one server-sent event, or undefined when it has none. */
function eventData(block: string) {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");

  return data || undefined;
}

/** JSON values from a `text/event-stream` body, one per event. */
async function* streamedEvents(body: Readable) {
  // One decoder for the whole stream: a character split across two chunks
  // Must not become two replacement characters.
  const decoder = new TextDecoder();
  let buffer = "";
  let size = 0;

  for await (const chunk of body) {
    const bytes = chunk as Buffer;
    size += bytes.length;

    if (size > maxResponseBytes) {
      body.destroy();

      return;
    }

    buffer += decoder.decode(bytes, { stream: true });
    let end = /\r?\n\r?\n/.exec(buffer);

    while (end) {
      const data = eventData(buffer.slice(0, end.index));
      buffer = buffer.slice(end.index + end[0].length);

      if (data) {
        yield data;
      }

      end = /\r?\n\r?\n/.exec(buffer);
    }
  }

  const rest = eventData(buffer + decoder.decode());

  if (rest) {
    yield rest;
  }
}

export type McpBridgeOptions = {
  socketPath: string;
  input: Readable;
  /** Writes one line of JSON to the harness. */
  write(line: string): void;
  /** Diagnostics for the harness's log; never protocol output. */
  report(text: string): void;
};

/**
 * Stdio MCP for a harness: each newline-delimited JSON-RPC message from
 * `input` is posted, unchanged, to the API's `/mcp` through the officer's
 * socket. A JSON answer or each event of a streamed answer becomes one line.
 * Requests run concurrently; JSON-RPC IDs pair answers with requests.
 */
export async function runMcpBridge(options: McpBridgeOptions) {
  let sessionId: string | undefined;
  let protocolVersion: string | undefined;
  const inflight = new Set<Promise<void>>();

  const emit = (value: unknown, id: RpcId | undefined) => {
    if (!isRecord(value) && !Array.isArray(value)) {
      return;
    }

    // The API answers a malformed request with ID null; give it the request's.
    const message =
      isRecord(value) && value["id"] === null && id !== undefined
        ? { ...value, id }
        : value;

    const result = isRecord(message) ? message["result"] : undefined;

    if (isRecord(result) && typeof result["protocolVersion"] === "string") {
      protocolVersion = result["protocolVersion"];
    }

    options.write(JSON.stringify(message));
  };

  const fail = (id: RpcId | undefined, message: string) => {
    if (id === undefined) {
      options.report(message);
    } else {
      options.write(JSON.stringify(rpcError(id, -32_000, message)));
    }
  };

  const forward = async (line: string, id: RpcId | undefined) => {
    let reply: SocketReply;

    try {
      reply = await socketRequest(
        options.socketPath,
        "POST",
        "/mcp",
        {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(protocolVersion && { "mcp-protocol-version": protocolVersion }),
          ...(sessionId && { "mcp-session-id": sessionId }),
        },
        Buffer.from(line, "utf8"),
      );
    } catch {
      fail(
        id,
        "The Subspace signing proxy is unavailable: is the gateway running, and is this the officer's own socket?",
      );

      return;
    }

    const session = reply.headers["mcp-session-id"];

    if (typeof session === "string") {
      sessionId = session;
    }

    const type = (reply.headers["content-type"] ?? "").split(";")[0]?.trim();

    try {
      if (type === "text/event-stream" && reply.status < 300) {
        for await (const data of streamedEvents(reply.body)) {
          try {
            emit(JSON.parse(data), id);
          } catch {
            options.report("Skipped an unreadable streamed MCP message");
          }
        }

        return;
      }

      const text = (await readAll(reply.body, maxResponseBytes)).toString(
        "utf8",
      );

      let value: unknown;

      try {
        value = text.trim() ? JSON.parse(text) : undefined;
      } catch {
        value = undefined;
      }

      if (
        (isRecord(value) && value["jsonrpc"] === "2.0") ||
        Array.isArray(value)
      ) {
        emit(value, id);
      } else if (reply.status >= 300) {
        fail(id, failureText(reply.status, text));
      } else if (value !== undefined) {
        fail(id, "The Subspace API's MCP answer is not JSON-RPC");
      }
    } catch {
      fail(id, "The Subspace API's MCP answer was cut short");
    }
  };

  const lines = createInterface({ input: options.input, crlfDelay: Infinity });

  for await (const raw of lines) {
    const line = raw.trim();

    if (!line) {
      continue;
    }

    if (Buffer.byteLength(line) > maxMessageBytes) {
      options.write(
        JSON.stringify(rpcError(null, -32_600, "Message too large")),
      );
      continue;
    }

    let message: unknown;

    try {
      message = JSON.parse(line);
    } catch {
      options.write(JSON.stringify(rpcError(null, -32_700, "Parse error")));
      continue;
    }

    const id =
      isRecord(message) &&
      (typeof message["id"] === "string" || typeof message["id"] === "number")
        ? message["id"]
        : undefined;

    // The session starts with initialize; its answer sets the version header.
    const task = forward(line, id);
    inflight.add(task);
    void task.finally(() => {
      inflight.delete(task);
    });

    if (isRecord(message) && message["method"] === "initialize") {
      await task;
    }
  }

  await Promise.allSettled(inflight);
}

export type ApiRequestOptions = {
  socketPath: string;
  method: string;
  path: string;
  body?: Buffer;
  /** Receives the response body as it arrives. */
  output: NodeJS.WritableStream;
  report(text: string): void;
};

/**
 * A plain REST call through the officer's socket, for agent skills. The body
 * goes to `output`; the exit code is 0 for a 2xx answer, 1 otherwise.
 */
export async function runApiRequest(options: ApiRequestOptions) {
  if (!options.path.startsWith("/api/v1/")) {
    options.report("The path must start with /api/v1/");

    return 2;
  }

  let reply: SocketReply;

  try {
    reply = await socketRequest(
      options.socketPath,
      options.method,
      options.path,
      {
        accept: "application/json",
        ...(options.body && { "content-type": "application/json" }),
      },
      options.body,
    );
  } catch {
    options.report(
      "The Subspace signing proxy is unavailable: is the gateway running, and is this the officer's own socket?",
    );

    return 1;
  }

  if (reply.status >= 300) {
    const text = (await readAll(reply.body, maxResponseBytes)).toString("utf8");
    options.report(failureText(reply.status, text));
    options.output.write(text);

    return 1;
  }

  for await (const chunk of reply.body) {
    options.output.write(chunk as Buffer);
  }

  return 0;
}
