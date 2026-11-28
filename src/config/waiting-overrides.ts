import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import { settingsStruct } from "./settings-schema";
import { type WaitingSettings, waitingDelaySchema } from "./waiting";

export {
  waitingDelaySchema,
  waitingSchema,
  type WaitingSettings,
} from "./waiting";

type WaitingRegistration = {
  id: string;
  displayName?: string | undefined;
  waiting: WaitingSettings;
  backend:
    | { type: "opencode"; directory: string; agent?: string | undefined }
    | {
        type:
          | "pi-durable"
          | "claude"
          | "codex"
          | "acp"
          | "antigravity"
          | "module";
      };
};

const overrideSchema = settingsStruct({ delayMs: waitingDelaySchema });
const decodeOverride = Schema.decodeUnknownSync(overrideSchema);

/** Shared captain workspace settings, isolated by configured agent identity. */
export function waitingSettingsPath(directory: string, agent: string): string {
  const id = createHash("sha256").update(agent).digest("hex");

  return join(directory, ".local", "stargate-waiting", `${id}.json`);
}

/** Cosmetic settings fail back to config; corrupt files never fail a turn. */
export async function resolveWaiting<
  T extends Pick<WaitingRegistration, "backend" | "waiting">,
>(bot: T): Promise<WaitingSettings> {
  const backend = bot.backend;

  if (backend.type !== "opencode" || !backend.agent) {
    return bot.waiting;
  }

  try {
    const override = decodeOverride(
      await Bun.file(
        waitingSettingsPath(backend.directory, backend.agent),
      ).json(),
    );

    return { ...bot.waiting, ...override };
  } catch {
    return bot.waiting;
  }
}

/** Caller must verify captain authority before invoking this private write. */
export async function saveWaitingDelay(
  directory: string,
  agent: string,
  delayMs: number | null,
  signal: AbortSignal,
): Promise<void> {
  const settings = decodeOverride({ delayMs });
  signal.throwIfAborted();
  const path = waitingSettingsPath(directory, agent);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporary, `${JSON.stringify(settings)}\n`, {
      flag: "wx",
      mode: 0o600,
      signal,
    });
    signal.throwIfAborted();
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export { botDisplayName, waitingPhrase } from "../shared/waiting";
