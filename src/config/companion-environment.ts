import { parseEnv } from "node:util";

/** Fill missing process environment entries from the config companion. */
export async function loadEnvironment(configPath: string) {
  const file = Bun.file(`${configPath}.env`);

  if (await file.exists()) {
    for (const [key, value] of Object.entries(parseEnv(await file.text()))) {
      process.env[key] ??= value;
    }
  }
}
