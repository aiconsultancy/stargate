import { dirname, resolve } from "node:path";
import type { Config } from "../../config";
import { checkCodexPaths, codexSearchPath, trustedPath } from "../codex-paths";

/** Every Codex backend of a configuration, for `stargate config check`. */
export async function checkCodexConfiguration(config: Config, path: string) {
  const data = resolve(dirname(resolve(path)), config.dataDirectory);

  const backends = [
    ...config.bots.map((bot) => bot.backend),
    ...config.irc.flatMap((irc) => [
      irc.backend,
      ...irc.crew.map((member) => member.backend),
    ]),
  ];

  for (const backend of backends) {
    if (backend.type !== "codex") continue;

    const roots =
      backend.sandbox === "read-only"
        ? []
        : [await trustedPath(backend.directory)];

    if (backend.sandbox === "workspace-write") await trustedPath(data, roots);
    await checkCodexPaths(backend, data);
    await codexSearchPath(backend.extraPath, undefined, roots);
  }
}
