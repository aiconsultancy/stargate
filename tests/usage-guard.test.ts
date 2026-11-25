import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import pino from "pino";
import { startUsageGuard } from "../src/app/usage-guard";
import {
  type QuotaSnapshot,
  crewUsageBlock,
} from "../src/backends/quota/quota";
import { UsageGuard } from "../src/backends/quota/usage-guard";
import { usageGuardSchema } from "../src/backends/quota/quota-watch";
import { configSchema } from "../src/config";

const proxy = {
  baseURL: "http://127.0.0.1:8317",
  managementKeyFile: "/private/management.key",
};

const settings = { enabled: true, sender: "atlas", proxy };
const signal = new AbortController().signal;

function account(
  provider: "claude" | "codex",
  remainingPercent: number,
  observedAt: number,
  resetAt: number,
): QuotaSnapshot["accounts"][number] {
  return {
    provider,
    account: `${provider}-1`,
    status: "ok",
    observedAt,
    windows: [
      {
        scope: "subscription",
        window: "weekly",
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        resetAt,
        active: null,
      },
    ],
  };
}

test("guard persists per-captain crossings, freezes stale cutoffs, and re-arms after verified recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-guard-"));
  const file = join(directory, "quota.json");

  const config = Schema.decodeUnknownSync(usageGuardSchema)({
    ...settings,
    stateFile: file,
  });

  const log: string[] = [];
  const sent: string[] = [];

  const targets = [
    { account: "orion", channel: "#orion" },
    { account: "vega", channel: "#vega" },
    { account: "draco", channel: "#draco" },
  ];

  let now = Date.parse("2026-12-01T15:00:00Z");
  const reset = now + 180_000;
  let snapshot: QuotaSnapshot["accounts"] = [];
  let ready = false;

  const create = () =>
    new UsageGuard(
      { ...config, stateFile: file },
      {
        read: async () => ({
          status: "ok",
          observedAt: now,
          cached: false,
          accounts: snapshot,
        }),
      },
      targets,
      async ({ channel }, message) => {
        if (channel === "#vega" && !ready) {
          throw new Error("Offline");
        }

        return async () => {
          sent.push(`${channel} ${message}`);

          if (channel === "#draco") {
            throw new Error("Uncertain send");
          }
        };
      },
      {
        warn: (fields: unknown, message?: string) => {
          log.push(message ?? String(fields));
        },
      },
      () => now,
    );

  try {
    snapshot = [
      account("claude", 25, now, reset),
      account("codex", 80, now, reset),
    ];
    await create().tick(signal);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("#orion Usage guard: Claude 25% remaining");
    expect(sent[0]).toContain("Stand down extra crew");
    expect(log).toContain(
      "Usage guard delivery uncertain; attempt will not be repeated",
    );
    expect(
      await crewUsageBlock(file, "claude-proxy/claude-fixture"),
    ).toBeUndefined();

    ready = true;
    await create().tick(signal);
    expect(sent).toHaveLength(3);
    expect(sent[2]).toContain("#vega Usage guard:");

    now += 60_000;
    snapshot = [
      account("claude", 20, now, reset),
      account("codex", 80, now, reset),
    ];
    await create().tick(signal);
    expect(sent).toHaveLength(6);
    expect(sent[3]).toContain("finish or checkpoint and push");
    expect(await crewUsageBlock(file, "claude-proxy/claude-fixture")).toBe(
      "claude",
    );
    expect(
      await crewUsageBlock(file, "openai-proxy/gpt-fixture"),
    ).toBeUndefined();
    expect((await stat(file)).mode & 0o777).toBe(0o644);

    now = reset;
    await create().tick(signal);
    expect(sent).toHaveLength(6);
    expect(log).toContain(
      "Usage guard quota reading is stale; retaining last verified policy",
    );
    expect(await crewUsageBlock(file, "claude-proxy/claude-fixture")).toBe(
      "claude",
    );

    snapshot = [account("claude", 100, now, reset + 180_000)];
    await create().tick(signal);
    expect(sent).toHaveLength(9);
    expect(sent[6]).toContain("Usage is back.");
    expect(log).toContain(
      "Usage guard quota reading unavailable; retaining last verified policy",
    );
    expect(
      await crewUsageBlock(file, "claude-proxy/claude-fixture"),
    ).toBeUndefined();

    now += 60_000;
    snapshot = [account("claude", 23, now, reset + 180_000)];
    await create().tick(signal);
    expect(sent).toHaveLength(12);
    expect(sent[9]).toContain("Claude 23% remaining");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const registration = (
  id: string,
  role: "rear_admiral" | "captain",
  channels: string[],
) => ({
  id,
  account: id,
  server: { host: "irc.example.com", port: 6697, tls: true },
  passwordEnv: `IRC_${id.toUpperCase()}`,
  channels,
  access: {},
  backend: {
    type: "opencode",
    directory: "/example",
    url: "http://127.0.0.1:4096",
  },
  fleetPolicy: {
    role,
    humanAccounts: ["operator"],
    assignedCheckout: "/example",
    capabilities: ["read_code"],
  },
});

test("guard sends one named PRIVMSG per captain from the rear admiral's IRC connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-guard-irc-"));
  const file = join(directory, "quota.json");
  const log = pino({ enabled: false });

  const config = Schema.decodeUnknownSync(configSchema)({
    dataDirectory: directory,
    usageGuard: { ...settings, stateFile: file },
    irc: [
      registration("atlas", "rear_admiral", ["#starbase", "#orion", "#vega"]),
      registration("orion", "captain", ["#orion", "#starbase"]),
      registration("vega", "captain", ["#vega", "#starbase"]),
      registration("draco", "captain", ["#draco", "#starbase"]),
    ],
  });

  const messages: [string, string][] = [];

  if (!config.usageGuard) {
    throw new Error("Missing IRC fixture guard");
  }

  try {
    const guard = startUsageGuard({
      config: config.usageGuard,
      registrations: config.irc,
      allowed: () => true,
      log,
      reader: {
        read: async () => {
          const now = Date.now();

          return {
            status: "ok",
            observedAt: now,
            cached: false,
            accounts: [account("codex", 20, now, now + 60_000)],
          };
        },
      },
      client: {
        fold: (name) => name.toLowerCase(),
        registered: true,
        inChannel: () => true,
        verifiedNick: async (account) => `${account}-online`,
        recipientGuard: () => () => true,
        budget: () => 400,
        privmsg: async (channel, text, _tags, allowed) => {
          expect(allowed?.()).toBe(true);
          messages.push([channel, text]);
        },
      },
    });

    await guard.tick(signal);
    expect(
      messages.map(([channel, text]) => [
        channel,
        text.split(" ", 6).join(" "),
      ]),
    ).toEqual([
      ["#orion", "@orion-online Usage guard: Codex 20% remaining"],
      ["#vega", "@vega-online Usage guard: Codex 20% remaining"],
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("enabled guard requires a rear admiral and correctly ordered thresholds", () => {
  const dataDirectory = "/example/data";
  const guard = { ...settings, stateFile: "/example/quota.json" };
  const parse = Schema.decodeUnknownSync(configSchema);

  expect(() => parse({ dataDirectory, usageGuard: guard })).toThrow(
    "rear admiral",
  );
  expect(() =>
    parse({
      dataDirectory,
      irc: [registration("atlas", "rear_admiral", ["#starbase"])],
      usageGuard: {
        ...guard,
        providers: {
          claude: {
            modelPrefixes: ["anthropic/"],
            limits: [
              { remainingPercent: 25, action: "warn" },
              { remainingPercent: 26, action: "pause" },
            ],
          },
        },
      },
    }),
  ).toThrow("warning must be higher");
});
