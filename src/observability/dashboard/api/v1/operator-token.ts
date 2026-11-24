import { dirname, resolve } from "node:path";
import type { Config } from "../../../../config";
import { apiToken } from "./token";

/** Resolve the operator command against the same data directory as the service. */
export function configuredApiToken(
  config: Pick<Config, "api" | "dataDirectory">,
  configPath: string,
  rotate?: boolean,
) {
  if (!config.api)
    throw new Error("Enable api in the Stargate configuration first.");

  return apiToken(resolve(dirname(configPath), config.dataDirectory), rotate);
}
