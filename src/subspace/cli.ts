import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { loadConfig } from "../config/composition";
import { enrolOfficers } from "./enrol";

export type SubspaceCliInput = {
  operation: string | undefined;
  positionals: readonly string[];
  configPath: string;
  name?: string | undefined;
  rotate?: boolean | undefined;
};

async function companionEnvironment(configPath: string) {
  try {
    return parseEnv(await readFile(`${configPath}.env`, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Cannot read credential companion.");
  }
}

/** `stargate subspace …`; returns the exit code. */
export async function subspaceCli(input: SubspaceCliInput): Promise<number> {
  switch (input.operation) {
    case "enrol": {
      if (input.positionals.length > 0) throw new Error("Use subspace --help.");
      const config = await loadConfig(input.configPath);
      const section = config.subspaceAgents;

      if (!section?.enabled)
        throw new Error(
          "Enable subspaceAgents in the Stargate configuration first.",
        );

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

    default:
      throw new Error("Unknown subspace operation. Use subspace --help.");
  }
}
