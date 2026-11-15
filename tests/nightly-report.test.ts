import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { configSchema } from "../src/config";
import { maintenanceSchema } from "../src/nightly/config";
import { recoveryBudgetMs, undoBounds } from "../src/nightly/journal";
import { MaintenanceOutbox } from "../src/nightly/outbox";
import {
  limits,
  queueNotice,
  type Report,
  reportSchema,
  summary,
  writeReport,
} from "../src/nightly/report";
import {
  buildMaintenanceUnits,
  buildUpdateCommand,
  startTimeoutMinutes,
} from "../src/nightly/timer";
import { occurrence } from "../src/nightly/window";

const root = await mkdtemp("/tmp/opencode/stargate-report-");
afterAll(() => rm(root, { recursive: true, force: true }));

const report: Report = {
  schema: "stargate.maintenance.report.v1",
  runID: "4b7d1c3e-9a5f-4e2b-8c1d-2f3a4b5c6d7e",
  installID: "abc",
  mode: "run",
  outcome: "partial",
  window: {
    timeZone: "Europe/London",
    localStart: "00:00",
    localEnd: "01:00",
    opens: "2026-11-12T00:00:00.000Z",
    plannedStart: "2026-11-12T00:07:00.000Z",
    deadline: "2026-11-12T00:50:00.000Z",
    closes: "2026-11-12T01:00:00.000Z",
    jitterMinutes: 7,
  },
  startedAt: "2026-11-12T00:07:01.000Z",
  finishedAt: "2026-11-12T00:12:00.000Z",
  components: [
    {
      id: "stargate",
      before: "0.4.0",
      after: "0.4.0",
      candidate: "0.5.0",
      status: "rolled-back",
      reason: "readiness-failed",
    },
    {
      id: "npm:@openai/codex",
      before: "0.167.2",
      after: "0.168.0",
      candidate: "0.168.0",
      status: "updated",
    },
    {
      id: "npm:@anthropic-ai/claude-code",
      before: "2.1.322",
      after: "2.1.322",
      candidate: "2.1.322",
      status: "unchanged",
    },
  ],
  models: [
    {
      scope: "crew-session",
      target: "ses_a",
      from: "claude-proxy/claude-opus-5-5#high",
      to: "claude-proxy/claude-opus-5-6#high",
      status: "applied",
    },
    {
      scope: "crew-session",
      target: "ses_b\nInjected: line",
      from: "claude-proxy/claude-opus-5-5#high",
      to: "claude-proxy/claude-opus-5-6#high",
      status: "applied",
    },
  ],
  steps: [{ name: "idle-gate", status: "ok", at: "2026-11-12T00:07:01.000Z" }],
  rollbacks: [
    { component: "stargate", from: "0.5.0", to: "0.4.0", status: "ok" },
  ],
  restarts: [
    { service: "gateway", status: "failed", at: "2026-11-12T00:10:00.000Z" },
  ],
};

describe("maintenance report", () => {
  test("schema is versioned, strict and closed over reason codes", () => {
    expect(reportSchema.parse(report)).toEqual(report);
    expect(reportSchema.safeParse({ ...report, extra: 1 }).success).toBe(false);
    expect(
      reportSchema.safeParse({
        ...report,
        schema: "stargate.maintenance.report.v2",
      }).success,
    ).toBe(false);
    expect(
      reportSchema.safeParse({ ...report, reason: "raw error text" }).success,
    ).toBe(false);
    const json = z.toJSONSchema(reportSchema) as { properties: object };
    expect(Object.keys(json.properties)).toContain("components");
  });

  test("written privately and summarized concisely", async () => {
    const written = await writeReport(root, report);
    expect(written.name).toBe(
      "20261112T000701000Z-4b7d1c3e-9a5f-4e2b-8c1d-2f3a4b5c6d7e.json",
    );
    expect((await Bun.file(written.path).stat()).mode & 0o777).toBe(0o600);
    const text = summary(report, written.name);
    expect(text).toStartWith(
      "Nightly maintenance 00:00–01:00 Europe/London: partial.",
    );
    expect(text).toContain(
      "- stargate: rolled-back 0.4.0 → 0.4.0 (readiness failed)",
    );
    expect(text).toContain("- npm:@openai/codex: updated 0.167.2 → 0.168.0");
    expect(text).toContain("Unchanged: 1 component(s).");
    expect(text).toContain(
      "- model claude-proxy/claude-opus-5-5#high → claude-proxy/claude-opus-5-6#high: 2 applied",
    );
    expect(text).toContain("Rollbacks: stargate ok.");
    expect(text).not.toContain("Injected");
    expect(text.length).toBeLessThanOrEqual(2800);
  });
});

describe("gateway delivery of summaries", () => {
  test("posts each notice once, refuses other channels, never repeats", async () => {
    const data = await mkdtemp(join(root, "outbox-"));
    const notice = (name: string, channel: string) =>
      queueNotice(data, {
        schema: "stargate.maintenance.notice.v1",
        channel,
        text: `summary ${name}`,
        report: `${name}.json`,
      });
    await notice("a", "C123");
    await notice("b", "C999");
    await notice("c", "C123");
    const posted: string[] = [];
    let fail = true;
    const outbox = new MaintenanceOutbox(
      data,
      (channel) => channel === "C123",
      async (_channel, text) => {
        if (text === "summary c" && fail) {
          fail = false;
          throw new Error("slack timeout");
        }
        posted.push(text);
      },
      { warn: () => {} },
    );
    const signal = AbortSignal.timeout(5000);
    expect(await outbox.deliver(signal)).toBe(1);
    expect(await outbox.deliver(signal)).toBe(0);
    expect(posted).toEqual(["summary a"]);
    expect((await readdir(join(data, "maintenance", "outbox"))).sort()).toEqual(
      ["a.json.sent", "b.json.refused", "c.json.failed"],
    );
  });
});

describe("systemd units", () => {
  test("an update unit refuses paths that the service manager would rewrite", () => {
    const input = {
      unit: "stargate-update-0-2-0-1",
      configPath: "/home/me/.config/stargate/stargate.json",
      executable: "/usr/bin/bun",
      entrypoint: "/home/me/.local/share/stargate/current/src/main.ts",
      path: "/usr/bin:/bin",
      version: "0.2.0",
      retryFailed: false,
      runMinutes: 100,
      recoveryMinutes: 50,
    };
    const command = buildUpdateCommand(input);
    // Waits until the command has started, so a failed start is an error.
    expect(command.slice(0, 4)).toEqual([
      "systemd-run",
      "--user",
      "--service-type=exec",
      "--collect",
    ]);
    expect(command).not.toContain("--no-block");
    expect(command).toContain("--property=TimeoutStopSec=50min");
    // Everything after `--` is the command itself, one argument each.
    expect(command.slice(command.indexOf("--") + 1)).toEqual([
      "/usr/bin/bun",
      "/home/me/.local/share/stargate/current/src/main.ts",
      "maintenance",
      "update",
      "--version",
      "0.2.0",
      "--now",
      "--foreground",
      "--config",
      "/home/me/.config/stargate/stargate.json",
    ]);
    for (const bad of [
      { configPath: "stargate.json" },
      { configPath: "/home/me/100%/stargate.json" },
      { entrypoint: "/home/$USER/main.ts" },
      { version: "0.2.0; reboot" },
      { version: "v0.2.0" },
      { unit: "bad unit" },
    ])
      expect(() => buildUpdateCommand({ ...input, ...bad })).toThrow();
  });

  test("timer starts at the jittered local time; service is a bounded oneshot", () => {
    const units = buildMaintenanceUnits({
      name: "stargate-maintenance",
      configPath: "/home/me/.config/stargate/stargate.json",
      executable: "/usr/bin/bun",
      entrypoint: "/home/me/.local/share/stargate/current/src/main.ts",
      path: "/usr/bin:/bin",
      spec: {
        start: "00:00",
        end: "01:00",
        timeZone: "Europe/London",
        jitterMinutes: 15,
        reserveMinutes: 10,
      },
      jitter: 9,
      recoveryMinutes: 50,
    });
    expect(units.timer).toContain("OnCalendar=*-*-* 00:09:00 Europe/London");
    expect(units.timer).toContain("Persistent=false");
    expect(units.timer).toContain("Unit=stargate-maintenance.service");
    expect(units.service).toContain("Type=oneshot");
    expect(units.service).toContain(
      'ExecStart="/usr/bin/bun" "/home/me/.local/share/stargate/current/src/main.ts" maintenance run --config "/home/me/.config/stargate/stargate.json"',
    );
    expect(units.service).toContain('Environment="PATH=/usr/bin:/bin"');
    // Window 60 + fall-back hour 60 - jitter 9 + recovery 50.
    expect(units.service).toContain("TimeoutStartSec=161min");
    expect(units.service).toContain("TimeoutStopSec=50min");
    expect(units.service).toContain(
      'ExecStopPost="/usr/bin/bun" "/home/me/.local/share/stargate/current/src/main.ts" maintenance recover --after-run --config "/home/me/.config/stargate/stargate.json"',
    );
    expect(units.service).toContain("UMask=0077");
    expect(() =>
      buildMaintenanceUnits({
        name: "../x",
        configPath: "/a",
        executable: "/b",
        entrypoint: "/c",
        path: "",
        spec: {
          start: "00:00",
          end: "01:00",
          timeZone: "UTC",
          jitterMinutes: 0,
          reserveMinutes: 10,
        },
        jitter: 0,
        recoveryMinutes: 30,
      }),
    ).toThrow("Invalid timer name");
  });
});

describe("kill timer and daylight saving time", () => {
  test("covers the longest real window of the year plus recovery", () => {
    for (const spec of [
      { start: "00:00", end: "01:00" },
      { start: "01:00", end: "02:00" },
      { start: "00:30", end: "01:30" },
      { start: "23:30", end: "01:30" },
    ]) {
      const window = {
        ...spec,
        timeZone: "Europe/London",
        jitterMinutes: 15,
        reserveMinutes: 10,
      };
      for (const jitter of [0, 15]) {
        let longest = 0;
        let day = Temporal.PlainDate.from("2026-01-01");
        for (let i = 0; i < 366; i++, day = day.add({ days: 1 })) {
          const night = occurrence(day, window, jitter);
          longest = Math.max(longest, night.closes - night.start);
        }
        const recoveryMinutes = 30;
        const minutes = startTimeoutMinutes(spec, jitter, recoveryMinutes);
        expect(minutes * 60_000).toBeGreaterThanOrEqual(
          longest + recoveryMinutes * 60_000,
        );
      }
    }
    // The 01:00-02:00 window is 120 minutes on the fall-back night.
    const fallBack = occurrence(
      Temporal.PlainDate.from("2026-10-25"),
      {
        start: "01:00",
        end: "02:00",
        timeZone: "Europe/London",
        jitterMinutes: 0,
        reserveMinutes: 10,
      },
      0,
    );
    expect((fallBack.closes - fallBack.opens) / 60_000).toBe(120);
  });
});

describe("undo budget", () => {
  test("TimeoutStopSec follows the configured packages and session cap", () => {
    const one = maintenanceSchema.parse({
      agentClis: { prefix: "/p", packages: [{ name: "a", command: "a" }] },
    });
    const four = maintenanceSchema.parse({ agentClis: { prefix: "/p" } });
    const extra = recoveryBudgetMs(four) - recoveryBudgetMs(one);
    expect(extra).toBe(3 * undoBounds.npmPerPackage);
    expect(recoveryBudgetMs(one)).toBeGreaterThanOrEqual(
      undoBounds.sessions +
        undoBounds.npmPerPackage +
        undoBounds.openCode +
        undoBounds.gateway,
    );
    const units = buildMaintenanceUnits({
      name: "stargate-maintenance",
      configPath: "/c/stargate.json",
      executable: "/usr/bin/bun",
      entrypoint: "/r/current/src/main.ts",
      path: "/usr/bin",
      spec: {
        start: "00:00",
        end: "01:00",
        timeZone: "UTC",
        jitterMinutes: 0,
        reserveMinutes: 10,
      },
      jitter: 0,
      recoveryMinutes: Math.ceil(recoveryBudgetMs(four) / 60_000),
    });
    expect(units.service).toContain(
      `TimeoutStopSec=${Math.ceil(recoveryBudgetMs(four) / 60_000)}min`,
    );
  });
});

describe("bounded reports", () => {
  test("oversized arrays and fields are truncated and counted, never rejected", async () => {
    const data = await mkdtemp(join(root, "bounded-"));
    const many = Array.from({ length: limits.models + 5 }, (_, i) => ({
      scope: "crew-session" as const,
      target: `ses_${i}`,
      from: `openai-proxy/${"x".repeat(400)}`,
      to: "openai-proxy/gpt-6.2-sol",
      status: "applied" as const,
    }));
    const written = await writeReport(data, { ...report, models: many });
    const saved = reportSchema.parse(
      JSON.parse(await readFile(written.path, "utf8")),
    );
    expect(saved.models).toHaveLength(limits.models);
    expect(saved.truncated).toEqual({ models: 5 });
    expect(saved.models[0]?.from.length).toBeLessThanOrEqual(300);
    expect(saved.outcome).toBe(report.outcome);
  });
});

describe("configuration boundary", () => {
  const bot = {
    id: "helper",
    slack: { appId: "A1", appTokenEnv: "APP", botTokenEnv: "BOT" },
    access: { users: ["U1"], channels: ["C1"], deniedChannels: ["C2"] },
    backend: {
      type: "opencode",
      url: "http://localhost:4096",
      directory: "/w",
    },
  };
  test("report channel must be allowed for an existing bot", () => {
    const parse = (report: unknown) =>
      configSchema.safeParse({ bots: [bot], maintenance: { report } }).success;
    expect(parse({ bot: "helper", channel: "C1" })).toBe(true);
    expect(parse({ bot: "helper", channel: "C0EXAMPLE05" })).toBe(false);
    expect(parse({ bot: "other", channel: "C1" })).toBe(false);
    expect(
      configSchema.safeParse({
        bots: [{ ...bot, access: { ...bot.access, channels: ["*"] } }],
        maintenance: { report: { bot: "helper", channel: "C2" } },
      }).success,
    ).toBe(false);
  });
});
