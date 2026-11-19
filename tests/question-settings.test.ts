import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  questionSettingsPath,
  resolveQuestionSettings,
  saveQuestionSettings,
} from "../src/question-settings";
import { bot } from "./fixtures";

test("question authority rejects symbolic, oversized and non-private files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "questions-authority-"));
  try {
    const config = bot();
    if (config.backend.type !== "opencode")
      throw new Error("Expected OpenCode");
    config.backend.directory = directory;
    config.backend.agent = "captain";
    const settings = {
      enabled: true,
      timeoutMs: 900_000,
      answer: "allowed",
    } as const;
    const disabled = {
      enabled: false,
      timeoutMs: 900_000,
      answer: "requester",
    } as const;
    await saveQuestionSettings(
      directory,
      "captain",
      settings,
      AbortSignal.timeout(5000),
    );
    const path = questionSettingsPath(directory, "captain");
    const target = join(directory, "foreign.json");
    await writeFile(target, JSON.stringify(settings), { mode: 0o600 });
    await rm(path);
    await symlink(target, path);
    expect(await resolveQuestionSettings(config)).toEqual(disabled);
    await rm(path);
    await writeFile(path, `${JSON.stringify(settings)}${" ".repeat(4096)}`, {
      mode: 0o600,
    });
    expect(await resolveQuestionSettings(config)).toEqual(disabled);
    await writeFile(path, JSON.stringify(settings));
    await chmod(path, 0o644);
    expect(await resolveQuestionSettings(config)).toEqual(disabled);
    await chmod(path, 0o600);
    expect(await resolveQuestionSettings(config)).toEqual(settings);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("question settings are private, atomic, isolated and fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "questions-settings-"));
  try {
    const config = bot();
    if (config.backend.type !== "opencode")
      throw new Error("Expected OpenCode");
    config.backend.directory = directory;
    config.backend.agent = "captain";
    const defaults = {
      enabled: false,
      timeoutMs: 900_000,
      answer: "requester",
    } as const;
    expect(await resolveQuestionSettings(config)).toEqual(defaults);
    const settings = {
      enabled: true,
      timeoutMs: 300_000,
      answer: "allowed",
    } as const;
    await saveQuestionSettings(
      directory,
      "captain",
      settings,
      AbortSignal.timeout(5000),
    );
    expect(await resolveQuestionSettings(config)).toEqual(settings);
    const path = questionSettingsPath(directory, "captain");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect(await readdir(dirname(path))).toHaveLength(1);
    await expect(
      saveQuestionSettings(directory, "captain", settings, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(await resolveQuestionSettings(config)).toEqual(settings);
    config.backend.agent = "other";
    expect(await resolveQuestionSettings(config)).toEqual(defaults);
    config.backend.agent = "captain";
    for (const value of [
      "bad json",
      JSON.stringify({ ...settings, timeoutMs: 1 }),
      JSON.stringify({ ...settings, answer: "anyone" }),
      JSON.stringify({ ...settings, extra: true }),
      JSON.stringify({ enabled: true }),
    ]) {
      await writeFile(path, value);
      expect(await resolveQuestionSettings(config)).toEqual(defaults);
    }
    await rm(path);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path));
    expect(await resolveQuestionSettings(config)).toEqual(defaults);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
