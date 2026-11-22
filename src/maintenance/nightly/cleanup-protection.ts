import { dirname, resolve } from "node:path";
import type { Config } from "../../config";
import type { Crew } from "./crews";

/** Runtime roots are protected even when operators configure an ancestor. */
export function cleanupProtection(
  config: Config,
  configPath: string,
  crews: Crew[],
) {
  const m = config.maintenance;
  return [
    resolve(dirname(configPath)),
    resolve(config.dataDirectory),
    ...config.bots.flatMap((bot) =>
      "directory" in bot.backend ? [bot.backend.directory] : [],
    ),
    ...config.irc.flatMap((registration) =>
      "directory" in registration.backend
        ? [registration.backend.directory]
        : [],
    ),
    ...crews.flatMap((crew) => [
      crew.stateDirectory,
      ...crew.roots.map((root) => root.directory),
      ...(crew.worktreeDirectories ?? []),
    ]),
    ...(m?.stargate ? [m.stargate.root] : []),
    ...(m?.cliproxyapi
      ? [dirname(m.cliproxyapi.link), dirname(m.cliproxyapi.binary)]
      : []),
    ...(m?.agentClis ? [m.agentClis.prefix] : []),
  ];
}
