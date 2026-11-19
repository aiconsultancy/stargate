import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, Schema } from "effect";
import { botSchema } from "../src/config";
import { CrewWaiting } from "../src/crew/waiting";
import {
  botDisplayName,
  resolveWaiting,
  waitingPhrase,
  waitingSchema,
  waitingSettingsPath,
} from "../src/waiting";
import { bot } from "./fixtures";

test("waiting defaults distinguish disabled from immediate", () => {
  expect(Schema.decodeUnknownSync(waitingSchema)({})).toEqual({
    delayMs: 5000,
    intervalMs: 10000,
  });
  for (const delayMs of [0, 3000, 5000, null]) {
    expect(
      Schema.decodeUnknownSync(botSchema)({ ...bot(), waiting: { delayMs } })
        .waiting,
    ).toEqual({
      delayMs,
      intervalMs: 10000,
    });
  }
  for (const waiting of [
    { delayMs: -1 },
    { delayMs: 0.1 },
    { delayMs: "off" },
    { delayMs: 3_600_001 },
    { intervalMs: 0 },
    { intervalMs: -1 },
    { typo: true },
  ]) {
    expect(
      Result.isSuccess(Schema.decodeUnknownResult(waitingSchema)(waiting)),
    ).toBe(false);
  }
  expect(Schema.decodeUnknownSync(botSchema)(bot()).waiting.delayMs).toBe(5000);
});

test("100 varied waiting phrases use the actual agent name and wrap", () => {
  const phrases = Array.from({ length: 100 }, (_, i) =>
    waitingPhrase("Cain", i),
  );
  expect(new Set(phrases).size).toBe(100);
  for (const phrase of phrases) {
    expect(phrase).toContain("Cain");
    expect(phrase).toMatch(/^Cain is [a-z].*…$/);
    expect(phrase).not.toContain("Adama");
    expect(phrase.length).toBeLessThan(120);
  }
  expect(waitingPhrase("Cain", 100)).toBe(phrases[0] ?? "");
  expect(waitingPhrase("Cain", 0)).toBe("Cain is thinking…");
  expect(waitingPhrase("Cain", 1)).toBe("Cain is mulling it over…");
  expect(waitingPhrase("Cain", 2)).toBe("Cain is pondering…");
  expect(waitingPhrase("Cain", -1)).toBe(phrases[99] ?? "");
  expect(waitingPhrase("Cain", Number.NaN)).toBe(phrases[0] ?? "");
  expect(botDisplayName(bot())).toBe("helper");
  expect(botDisplayName({ ...bot(), displayName: "Cain" })).toBe("Cain");
});

test("captain waiting changes persist and apply without gateway restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-waiting-"));
  try {
    const config = Schema.decodeUnknownSync(botSchema)({
      ...bot(),
      backend: { ...bot().backend, directory, agent: "adama" },
      waiting: { delayMs: 5000, intervalMs: 12000 },
    });
    const authority = {
      options: {
        captainDirectory: directory,
        team: { captain: { id: "adama" } },
      },
      async captain(caller: { agent: string }) {
        if (caller.agent !== "adama") throw new Error("not captain");
      },
    };
    const tool = new CrewWaiting(authority);
    const caller = {
      agent: "adama",
      sessionID: "ses_captain",
      signal: new AbortController().signal,
    };
    expect(await resolveWaiting(config)).toEqual(config.waiting);
    for (const seconds of [3, 5, "off", 0] as const) {
      const result = await tool.run({ seconds }, caller);
      const delayMs = seconds === "off" ? null : seconds * 1000;
      expect(result).toEqual({ delayMs, effect: "subsequent-turns" });
      expect(await resolveWaiting(config)).toEqual({
        delayMs,
        intervalMs: 12000,
      });
    }
    expect(
      (await stat(waitingSettingsPath(directory, "adama"))).mode & 0o777,
    ).toBe(0o600);
    await expect(
      tool.run({ seconds: 3 }, { ...caller, agent: "worker" }),
    ).rejects.toThrow();
    expect((await resolveWaiting(config)).delayMs).toBe(0);
    await expect(tool.run({ seconds: -1 }, caller)).rejects.toThrow();
    await expect(tool.run({ seconds: 3601 }, caller)).rejects.toThrow();
    await expect(
      tool.run({ seconds: 3, path: "/arbitrary" }, caller),
    ).rejects.toThrow();
    await expect(
      tool.run(
        { seconds: 3 },
        {
          ...caller,
          signal: AbortSignal.abort(),
        },
      ),
    ).rejects.toThrow();
    expect((await resolveWaiting(config)).delayMs).toBe(0);
    expect(
      await resolveWaiting({
        ...config,
        backend: {
          type: "opencode",
          url: "http://localhost:4096",
          directory,
          agent: "cain",
          headersEnv: {},
          permissions: [],
        },
      }),
    ).toEqual(config.waiting);
    await Bun.write(waitingSettingsPath(directory, "adama"), '{"delayMs":-1}');
    expect(await resolveWaiting(config)).toEqual(config.waiting);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
