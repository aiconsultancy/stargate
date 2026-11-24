import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseEnv } from "node:util";
import { loadConfig } from "../config/composition";
import { runApiRequest, runMcpBridge } from "./bridge";
import { enrolOfficers } from "./enrol";

export type SubspaceCliInput = {
  operation: string | undefined;
  positionals: readonly string[];
  configPath: string;
  socket?: string | undefined;
  method?: string | undefined;
  input?: string | undefined;
  name?: string | undefined;
  rotate?: boolean | undefined;
};

const maxInputBytes = 8 * 1024 * 1024;
const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

async function readInput(path: string) {
  if (path === "-") {
    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of process.stdin) {
      const buffer = chunk as Buffer;
      size += buffer.length;

      if (size > maxInputBytes) {
        throw new Error("The request body is too large.");
      }

      chunks.push(buffer);
    }

    return Buffer.concat(chunks);
  }

  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);

  try {
    const stats = await file.stat();

    if (!stats.isFile() || stats.size > maxInputBytes) {
      throw new Error("--input must be a regular file of at most 8 MiB.");
    }

    return await file.readFile();
  } finally {
    await file.close();
  }
}

async function companionEnvironment(configPath: string) {
  try {
    return parseEnv(await readFile(`${configPath}.env`, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    throw new Error("Cannot read credential companion.");
  }
}

function socketPath(socket: string | undefined) {
  if (!socket || !isAbsolute(socket)) {
    throw new Error("--socket must be the officer's absolute socket path.");
  }

  return socket;
}

const report = (text: string) => {
  process.stderr.write(`${text}\n`);
};

/** `stargate subspace …`; returns the exit code. */
export async function subspaceCli(input: SubspaceCliInput): Promise<number> {
  switch (input.operation) {
    case "enrol": {
      if (input.positionals.length > 0) {
        throw new Error("Use subspace --help.");
      }

      const config = await loadConfig(input.configPath);
      const section = config.subspaceAgents;

      if (!section?.enabled) {
        throw new Error(
          "Enable subspaceAgents in the Stargate configuration first.",
        );
      }

      const outcomes = await enrolOfficers({
        section,
        dataDirectory: config.dataDirectory,
        env: {
          ...(await companionEnvironment(input.configPath)),
          ...process.env,
        },
        ...(input.rotate && { rotate: true }),
        ...(input.name && { names: [input.name] }),
      });

      console.log(JSON.stringify({ officers: outcomes }, null, 2));

      return outcomes.some((outcome) => outcome.state === "failed") ? 1 : 0;
    }

    case "mcp":
      if (input.positionals.length > 0) {
        throw new Error("Use subspace --help.");
      }

      await runMcpBridge({
        socketPath: socketPath(input.socket),
        input: process.stdin,
        write: (line) => {
          process.stdout.write(`${line}\n`);
        },
        report,
      });

      return 0;
    case "request": {
      const [path, ...rest] = input.positionals;
      const method = (input.method ?? "GET").toUpperCase();

      if (!path || rest.length > 0 || !methods.has(method)) {
        throw new Error("Use subspace --help.");
      }

      return runApiRequest({
        socketPath: socketPath(input.socket),
        method,
        path,
        ...(input.input !== undefined && {
          body: await readInput(input.input),
        }),
        output: process.stdout,
        report,
      });
    }

    default:
      throw new Error("Unknown subspace operation. Use subspace --help.");
  }
}
