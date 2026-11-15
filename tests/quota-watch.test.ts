import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../src/config";
import type { QuotaSnapshot } from "../src/quota";
import { QuotaWatch, quotaWatchSchema } from "../src/quota-watch";
import { isAllowedChannel } from "../src/routing";

const start = Date.parse("2026-11-15T12:00:00Z");
const config = {
  proxy: {
    baseURL: "http://127.0.0.1:8317",
    managementKeyFile: "/private/management.key",
  },
  report: { bot: "captain", channel: "C123" },
};

type Account = QuotaSnapshot["accounts"][number];

function account(
  provider: Account["provider"],
  remaining: number,
  now: number,
  index = 1,
): Account {
  return {
    provider,
    account: `${provider}-${index}`,
    status: "ok",
    observedAt: now,
    windows: [
      {
        window: "weekly",
        scope: "subscription",
        usedPercent: 100 - remaining,
        remainingPercent: remaining,
        active: null,
        resetAt: now + 3600_000,
      },
    ],
  };
}

test("quota notices and launch policy track the two providers independently across restarts", async () => {
  const path = await mkdtemp(join(tmpdir(), "pogo-quota-watch-"));
  const stateFile = join(path, "crew", "quota.json");
  const settings = quotaWatchSchema.parse({ ...config, stateFile });
  const messages: string[] = [];
  let now = start;
  let accounts: Account[] = [];
  const create = () =>
    new QuotaWatch(
      settings,
      {
        read: async () => ({
          status: "partial",
          observedAt: now,
          cached: false,
          accounts,
        }),
      },
      async (text) => {
        messages.push(text);
      },
      { warn: () => {} },
      () => now,
    );
  const signal = new AbortController().signal;
  const state = async (): Promise<unknown> =>
    JSON.parse(await readFile(stateFile, "utf8"));
  try {
    accounts = [account("claude", 25, now), account("codex", 75, now)];
    await create().tick(signal);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Claude crew quota");
    expect(messages[0]).toContain("at most one");
    expect(await state()).toEqual({
      claude: { mode: "limited", observedAt: now / 1000 },
      codex: { mode: "normal", observedAt: now / 1000 },
    });

    now += 120_000;
    accounts = [account("claude", 20, now), account("codex", 15, now)];
    await create().tick(signal);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain("Codex crew quota");
    expect(messages[1]).toContain("Pause crew launches and resumes");

    now += 120_000;
    // A past reset and a provider failure cannot clear either warning.
    accounts = [
      { ...account("claude", 100, now), status: "unavailable" },
      {
        ...account("codex", 100, now),
        windows: account("codex", 100, now - 7200_000).windows,
      },
    ];
    await create().tick(signal);
    expect(messages).toHaveLength(2);
    expect(await state()).toEqual({
      claude: { mode: "limited", observedAt: (now - 120_000) / 1000 },
      codex: { mode: "paused", observedAt: (now - 120_000) / 1000 },
    });

    now += 120_000;
    accounts = [account("claude", 14, now), account("codex", 26, now)];
    await create().tick(signal);
    expect(messages).toHaveLength(3);
    expect(messages[2]).toContain("Claude crew quota: 15% or less");
    expect(messages[2]).toContain("Codex crew quota: Quota restored");
    expect(await state()).toEqual({
      claude: { mode: "paused", observedAt: now / 1000 },
      codex: { mode: "normal", observedAt: now / 1000 },
    });
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("quota compares the tightest windows without adding account percentages", async () => {
  const path = await mkdtemp(join(tmpdir(), "pogo-quota-watch-pool-"));
  const stateFile = join(path, "quota.json");
  const settings = quotaWatchSchema.parse({
    ...config,
    stateFile,
    providers: ["claude"],
  });
  const a = account("claude", 90, start);
  const b = account("claude", 14, start, 2);
  const weekly = account("claude", 20, start).windows[0];
  if (!weekly) throw new Error("Missing fixture limit");
  a.windows.push({ ...weekly, window: "5h" });
  a.windows.push({ ...weekly, scope: "fable", remainingPercent: 0 });
  const watcher = new QuotaWatch(
    settings,
    {
      read: async () => ({
        status: "ok",
        observedAt: start,
        cached: false,
        accounts: [a, b, account("codex", 10, start)],
      }),
    },
    async () => {},
    { warn: () => {} },
    () => start,
  );
  try {
    await watcher.tick(new AbortController().signal);
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual({
      claude: { mode: "limited", observedAt: start / 1000 },
    });
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("quota report config authorises one outbound destination without opening inbound Slack access", () => {
  const bot = {
    id: "captain",
    slack: {
      appId: "A123",
      appTokenEnv: "APP_TOKEN",
      botTokenEnv: "BOT_TOKEN",
    },
    access: { users: ["U123"], channels: ["C456"], deniedChannels: ["C789"] },
    backend: { type: "module", module: "/private/backend.ts" },
  };
  const quotaWatch = { ...config, stateFile: "/private/quota.json" };
  const parsed = configSchema.parse({ bots: [bot], quotaWatch });
  const reporter = parsed.bots[0];
  if (!reporter) throw new Error("Missing report bot fixture");
  expect(isAllowedChannel(reporter, quotaWatch.report.channel)).toBe(false);
  expect(
    configSchema.safeParse({
      bots: [bot],
      quotaWatch: {
        ...quotaWatch,
        report: { ...quotaWatch.report, channel: "C789" },
      },
    }).success,
  ).toBe(false);
  expect(
    configSchema.safeParse({
      bots: [bot],
      quotaWatch: {
        ...quotaWatch,
        report: { ...quotaWatch.report, bot: "other" },
      },
    }).success,
  ).toBe(false);
});
