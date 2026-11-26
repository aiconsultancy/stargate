import {
  officerRequest,
  requiredOptions,
  runOfficerRequest,
} from "./github-officer";
import { GitHubRefused, check, field, object } from "./github-wire";
import { officerRequestLines } from "./officer-stdio";

const tool = {
  name: "operate",
  description:
    "Run a GitHub operation using your configured App and repository policy. For writes with an uncertain outcome, check the remote state before retrying.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["operation", "repo"],
    properties: {
      operation: { enum: Object.keys(requiredOptions) },
      repo: { type: "string", description: "Configured repository key." },
      directory: { type: "string", description: "Own checkout path for push." },
      branch: { type: "string", description: "Feature branch for push." },
      input: {
        type: "string",
        description: "Path under your home to the JSON payload.",
      },
      pr: { type: "integer", minimum: 1, description: "Pull request number." },
      "expected-head": {
        type: "string",
        description: "Full 40-character PR head SHA.",
      },
      "proof-id": { type: "string", description: "Native review proof ID." },
      output: {
        type: "string",
        description: "Own-home output path for review context.",
      },
    },
  },
};

function toolRequest(input: unknown) {
  const { operation, ...fields } = object(input);
  check(typeof operation === "string", "Choose an operation.");

  const args = Object.entries(fields).map(([key, value]) => {
    check(
      Object.hasOwn(tool.inputSchema.properties, key) &&
        (key === "pr"
          ? Number.isSafeInteger(value)
          : typeof value === "string"),
      "Unexpected operation argument.",
    );

    check(
      typeof value === "number" || typeof value === "string",
      "Unexpected option value.",
    );

    return `--${key}=${String(value)}`;
  });

  return officerRequest([operation, ...args]);
}

async function serve(adapter: string) {
  const versions = new Set([
    "2024-11-05",
    "2025-03-26",
    "2025-06-18",
    "2025-11-25",
  ]);

  for await (const line of officerRequestLines(32_768)) {
    let id: string | number | null = null;

    let reply:
      | { result: unknown }
      | { error: { code: number; message: string } } = {
      error: { code: -32_600, message: "Invalid request" },
    };

    try {
      const request = object(JSON.parse(line));
      const value = request["id"];

      if (value === undefined && request["jsonrpc"] === "2.0") {
        continue;
      }

      check(
        request["jsonrpc"] === "2.0" &&
          (value === null ||
            typeof value === "string" ||
            typeof value === "number"),
        "Invalid request",
      );
      id = value;
      const params = request["params"];

      switch (request["method"]) {
        case "initialize": {
          const advertised = field(params, "protocolVersion");

          const protocolVersion =
            typeof advertised === "string" && versions.has(advertised)
              ? advertised
              : "2025-06-18";

          reply = {
            result: {
              protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "github-officer", version: "1" },
            },
          };
          break;
        }

        case "ping":
          reply = { result: {} };
          break;
        case "tools/list":
          reply = { result: { tools: [tool] } };
          break;
        case "tools/call":
          if (field(params, "name") === tool.name) {
            try {
              const result = await runOfficerRequest(
                adapter,
                toolRequest(field(params, "arguments")),
              );

              reply = {
                result: {
                  content: [{ type: "text", text: JSON.stringify(result) }],
                },
              };
            } catch (error) {
              const text =
                error instanceof GitHubRefused
                  ? error.message
                  : "GitHub operation refused or unconfirmed. Inspect remote state before retrying writes.";

              reply = {
                result: { isError: true, content: [{ type: "text", text }] },
              };
            }
          }

          break;
      }
    } catch {
      // A malformed request gets a JSON-RPC error without echoing its contents.
    }

    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, ...reply })}\n`,
    );
  }
}

if (import.meta.main) {
  const adapter = process.argv[2];

  if (process.argv.length !== 3 || !adapter?.startsWith("/")) {
    process.stderr.write("Configure the installed GitHub adapter.\n");
    process.exitCode = 2;
  } else {
    await serve(adapter);
  }
}
