import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import type { BotConfig } from "../../config";

const questionSettingsSchema = Schema.Struct({
  enabled: Schema.Boolean,
  timeoutMs: Schema.Literals([300_000, 900_000, 3_600_000]),
  answer: Schema.Literals(["requester", "allowed"]),
});

export const decodeQuestionSettings = Schema.decodeUnknownSync(
  questionSettingsSchema,
  {
    onExcessProperty: "error",
  },
);

export type QuestionSettings = {
  enabled: boolean;
  timeoutMs: number;
  answer: "requester" | "allowed";
};

const defaults: QuestionSettings = {
  enabled: false,
  timeoutMs: 900_000,
  answer: "requester",
};

export function questionSettingsPath(directory: string, agent: string): string {
  const id = createHash("sha256").update(agent).digest("hex");

  return join(directory, ".local", "stargate-questions", `${id}.json`);
}

const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** Distinguish a missing file from a broken link or invalid state directory. */
async function questionSettingsAbsent(directory: string, path: string) {
  if (!(await stat(directory)).isDirectory()) return false;

  for (const parent of [join(directory, ".local"), dirname(path)]) {
    try {
      if (!(await lstat(parent)).isDirectory()) return false;
    } catch (error) {
      return missing(error);
    }
  }

  return lstat(path).then(() => false, missing);
}

/** Invalid or unreadable settings always fail closed. */
export async function resolveQuestionSettings(
  bot: Pick<BotConfig, "backend">,
  enableWhenMissing = false,
): Promise<QuestionSettings> {
  const backend = bot.backend;

  if (backend.type === "opencode" && backend.agent) {
    try {
      const path = questionSettingsPath(backend.directory, backend.agent);

      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ).catch(async (error: unknown) => {
        if (
          enableWhenMissing &&
          missing(error) &&
          (await questionSettingsAbsent(backend.directory, path))
        )
          return;
        throw error;
      });

      if (!file) return { ...defaults, enabled: true };

      try {
        const before = await file.stat({ bigint: true });
        const uid = process.getuid?.();

        if (
          !before.isFile() ||
          before.size > 4096n ||
          (before.mode & 0o077n) !== 0n ||
          uid === undefined ||
          before.uid !== BigInt(uid)
        )
          throw new Error("Private question settings required");
        const bytes = Buffer.alloc(4097);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);

        if (bytesRead > 4096) throw new Error("Question settings too large");
        const after = await file.stat({ bigint: true });
        const current = await lstat(path, { bigint: true });

        const identity = (info: typeof before) =>
          `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;

        if (
          identity(before) !== identity(after) ||
          identity(after) !== identity(current)
        )
          throw new Error("Question settings changed during read");

        return decodeQuestionSettings(
          JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")),
        );
      } finally {
        await file.close();
      }
    } catch {
      // Do not log persisted content or filesystem errors.
    }
  }

  return { ...defaults };
}

/** Caller verifies captain authority and mutation admission before writing. */
export async function saveQuestionSettings(
  directory: string,
  agent: string,
  settings: QuestionSettings,
  signal: AbortSignal,
): Promise<void> {
  const decoded = decodeQuestionSettings(settings);
  signal.throwIfAborted();
  const path = questionSettingsPath(directory, agent);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporary, `${JSON.stringify(decoded)}\n`, {
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

export function operatorControl(text: string) {
  return /^(show|answer)\s+(Q[0-9a-f]{10})(?:\s+([^\r\n]+))?$/i.exec(
    text.trim(),
  );
}
