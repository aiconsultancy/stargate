import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DateTime, Result, Schema } from "effect";
import { officerRequestLines } from "./officer-stdio";
import {
  PreviewRefused,
  bundleSchema,
  decodeBundle,
  maxRequestBytes,
  previewName,
  previewNamePattern,
  readBundle,
} from "./preview-bundle";
import { previewStore } from "./preview-store";

const protocolVersions = new Set(["2025-11-25", "2025-06-18", "2025-03-26"]);
const nameSchema = Schema.Struct({ name: previewName });

const decodeName = Schema.decodeUnknownResult(nameSchema, {
  onExcessProperty: "error",
});

const commandSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("publish"),
    name: previewName,
    files: bundleSchema,
  }),
  Schema.Struct({ action: Schema.Literal("unpublish"), name: previewName }),
]);

const decodeCommand = Schema.decodeUnknownResult(commandSchema, {
  onExcessProperty: "error",
});

const decodeRpc = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      jsonrpc: Schema.Literal("2.0"),
      id: Schema.optionalKey(
        Schema.Union([Schema.String, Schema.Number, Schema.Null]),
      ),
      method: Schema.String,
      params: Schema.optionalKey(
        Schema.Struct({
          protocolVersion: Schema.optionalKey(Schema.String),
          name: Schema.optionalKey(Schema.String),
          arguments: Schema.optionalKey(Schema.Unknown),
        }),
      ),
    }),
  ),
);

const decodeBrokerError = Schema.decodeUnknownResult(
  Schema.Struct({ error: Schema.String }),
);

const toolSchema = {
  type: "object",
  properties: { name: { type: "string", pattern: previewNamePattern.source } },
  required: ["name"],
  additionalProperties: false,
};

const tools = [
  {
    name: "publish",
    description:
      "Publish a staged static mockup directory of this name. Reuse the same name to update its URL and renew its seven-day lifetime.",
    inputSchema: toolSchema,
  },
  {
    name: "unpublish",
    description: "Withdraw your live preview of this name.",
    inputSchema: toolSchema,
  },
];

async function callTool(
  socket: string,
  staging: string,
  tool: string,
  args: unknown,
) {
  const parsed = decodeName(args);

  if (Result.isFailure(parsed)) {
    throw new PreviewRefused(
      "Use a lower-case preview name with letters, digits or hyphens.",
    );
  }

  const { name } = parsed.success;
  const signal = AbortSignal.timeout(30_000);

  const command =
    tool === "publish"
      ? { action: tool, name, files: await readBundle(staging, name, signal) }
      : { action: tool, name };

  const response = await fetch("http://preview.local/", {
    method: "POST",
    unix: socket,
    body: JSON.stringify(command),
    signal,
  });

  const value: unknown = await response.json();

  if (!response.ok) {
    const error = decodeBrokerError(value);
    throw new PreviewRefused(
      Result.isSuccess(error)
        ? error.success.error
        : "The preview service rejected the request.",
    );
  }

  return value;
}

async function serveMcp(socket: string, staging: string) {
  for await (const line of officerRequestLines(8192)) {
    const parsed = decodeRpc(line);

    if (Result.isFailure(parsed)) {
      console.log(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32_600, message: "Invalid request" },
        }),
      );
      continue;
    }

    const { id, method, params } = parsed.success;

    if (id === undefined) {
      continue;
    }

    const reply = { jsonrpc: "2.0", id };

    if (method === "initialize") {
      const version = params?.protocolVersion ?? "";

      console.log(
        JSON.stringify({
          ...reply,
          result: {
            protocolVersion: protocolVersions.has(version)
              ? version
              : "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "stargate_serve", version: "1" },
          },
        }),
      );
    } else if (method === "tools/list") {
      console.log(JSON.stringify({ ...reply, result: { tools } }));
    } else if (method === "ping") {
      console.log(JSON.stringify({ ...reply, result: {} }));
    } else if (
      method === "tools/call" &&
      (params?.name === "publish" || params?.name === "unpublish")
    ) {
      let text: string;
      let isError = false;

      try {
        text = JSON.stringify(
          await callTool(socket, staging, params.name, params.arguments),
        );
      } catch (error) {
        isError = true;
        text =
          error instanceof PreviewRefused
            ? error.message
            : "Could not read the staged mockup or reach the preview service. Check the staging directory and fleet service.";
      }

      console.log(
        JSON.stringify({
          ...reply,
          result: { isError, content: [{ type: "text", text }] },
        }),
      );
    } else {
      console.log(
        JSON.stringify({
          ...reply,
          error: { code: -32_601, message: "Method or tool not found" },
        }),
      );
    }
  }
}

function serveBroker(
  root: string,
  sockets: string,
  baseUrl: string,
  owners: string[],
) {
  const url = new URL(baseUrl);

  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      (url.protocol !== "http:" || url.hostname !== "127.0.0.1"))
  ) {
    throw new Error(
      "Use a dedicated HTTPS origin or an HTTP loopback origin for the preview base URL.",
    );
  }

  const store = previewStore(root, url.href);

  function collect() {
    store.collect(DateTime.toEpochMillis(DateTime.nowUnsafe()));
  }

  collect();

  for (const owner of owners) {
    const socket = join(sockets, owner, "publish.sock");
    const prior = lstatSync(socket, { throwIfNoEntry: false });

    if (prior) {
      if (!prior.isSocket()) {
        throw new Error(
          "The preview publisher path already exists and is not a socket.",
        );
      }

      unlinkSync(socket);
    }

    Bun.serve({
      unix: socket,
      maxRequestBodySize: maxRequestBytes,
      async fetch(request) {
        if (request.method !== "POST") {
          return new Response(null, { status: 405 });
        }

        const data: unknown = await request.json().catch(() => null);
        const result = decodeCommand(data);

        if (Result.isFailure(result)) {
          return Response.json(
            { error: "Invalid preview request." },
            { status: 400 },
          );
        }

        const command = result.success;

        try {
          return Response.json(
            command.action === "publish"
              ? store.publish(owner, command.name, decodeBundle(command.files))
              : store.unpublish(owner, command.name),
          );
        } catch (error) {
          if (error instanceof PreviewRefused) {
            return Response.json({ error: error.message }, { status: 400 });
          }

          console.error(
            "The preview publisher could not update its managed storage.",
          );

          return Response.json(
            { error: "Could not update the preview." },
            { status: 500 },
          );
        }
      },
    });
    chmodSync(socket, 0o660);
  }

  setInterval(() => {
    try {
      collect();
    } catch {
      console.error(
        "The preview publisher could not clean up expired previews.",
      );
    }
  }, 15_000);
}

if (import.meta.main) {
  const [mode, first, second, base, ...owners] = Bun.argv.slice(2);

  if (
    mode === "mcp" &&
    first &&
    second &&
    isAbsolute(first) &&
    isAbsolute(second) &&
    base === undefined
  ) {
    await serveMcp(first, second);
  } else if (
    mode === "broker" &&
    first &&
    second &&
    isAbsolute(first) &&
    isAbsolute(second) &&
    base?.endsWith("/") &&
    owners.length > 0 &&
    owners.every((owner) => /^[a-z0-9][a-z0-9_-]{0,31}$/.test(owner)) &&
    new Set(owners).size === owners.length
  ) {
    serveBroker(first, second, base, owners);
  } else {
    console.error(
      "Usage: officer-previews.ts mcp <socket> <staging> | broker <storage> <sockets> <base-url/> <captain>...",
    );
    process.exitCode = 2;
  }
}
