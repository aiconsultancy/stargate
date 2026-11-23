import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, Schema } from "effect";
import {
  createHealthReader,
  readStarfleetSnapshot,
} from "../src/health/health";
import { healthConfigSchema } from "../src/health/config";
import { maintenanceSchema } from "../src/maintenance/nightly/config";
import { bot } from "./fixtures";

const now = Date.parse("2026-11-18T12:00:00Z");
const canary = "SECRET-private-path-token-prompt";

const status = {
  checks: {
    backendRead: { state: "available", reason: canary },
    pinnedSession: { state: "failed", reason: canary },
  },
  history: { state: "unknown", incidents: [] },
};

const sources = {
  host: async () => ({
    load: [1, 2, 3],
    cores: 8,
    totalMemory: 16_000,
    availableMemory: 8000,
    uptimeSeconds: 123,
    disks: [],
    processes: [
      { pid: 12, label: "opencode", cpuPercent: 20, memoryBytes: 4096 },
    ],
    processCoverage: "sampled",
    growth: { label: "root", bytes: 1_048_576, intervalSeconds: 60 },
    rebootPending: true,
    timeSynchronized: true,
  }),
  status: async () => status,
  ready: async () => ({
    schema: "stargate.ready.v1",
    pid: 1,
    readyAt: now - 1000,
    version: "1.2.3",
  }),
  reports: async () => ({ reports: [], unreadable: 1 }),
  alert: async () => null,
  starfleet: async () => ({
    schema: "stargate.health.starfleet.v1",
    observedAt: new Date(now - 2000).toISOString(),
    services: {
      avondale: "active",
      stargate: "failed",
      opencode: "unknown",
      proxy: "inactive",
    },
  }),
  uptime: () => 50,
};

function reader(extra: Partial<Parameters<typeof createHealthReader>[0]> = {}) {
  return createHealthReader({
    bot,
    dataDirectory: "/unused",
    backend: {},
    now: () => now,
    sources,
    ...extra,
  });
}

test("health shows current drain and deadline stragglers without private payloads", async () => {
  const text = await reader({
    sources: {
      ...sources,
      drain: async () => ({
        schema: "stargate.maintenance.drain.v1",
        runID: "run-health",
        pid: process.pid,
        job: "nightly",
        services: ["gateway", "opencode"],
        startedAt: now - 1000,
        deadlineAt: now + 600_000,
        phase: "draining",
        stragglers: [
          { taskID: "task_busy", sessionID: "ses_worker", reason: "busy-crew" },
        ],
      }),
    },
  })("stargate");

  expect(text).toContain("restart drain draining");
  expect(text).toContain("task_busy");
  expect(text).toContain("ses_worker");
  expect(text).toContain(new Date(now + 600_000).toISOString());
  expect(text).not.toContain(canary);
});

test("strict health settings accept absolute paths and reject executable or relative settings", () => {
  expect(
    Schema.decodeUnknownSync(healthConfigSchema)({}).stalledAfterSeconds,
  ).toBe(1800);
  expect(
    Schema.decodeUnknownSync(healthConfigSchema)({}).snapshotMaxAgeSeconds,
  ).toBe(900);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(healthConfigSchema)({
        starfleetSnapshotFile: "relative",
      }),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(healthConfigSchema)({
        opencodeDataDirectory: "/safe\0bad",
      }),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(healthConfigSchema)({ command: "az" }),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(healthConfigSchema)({
        stalledAfterSeconds: 59,
      }),
    ),
  ).toBe(false);
});

test("every section and summary render bounded safe observed values and explicit unknowns", async () => {
  const read = reader();

  for (const section of [
    undefined,
    "host",
    "agents",
    "stargate",
    "opencode",
    "proxy",
    "services",
    "starfleet",
  ]) {
    const text = await read(section);
    expect(text.length).toBeLessThan(3000);
    expect(text).toContain("unknown");
    expect(text).not.toContain(canary);

    if (section) expect(text.toLowerCase()).toContain(section);
  }

  expect(await read("opencode")).toContain("✓ backend read");
  expect(await read("opencode")).toContain("✗ pinned session");
  const summary = await read();

  for (const section of [
    "host",
    "agents",
    "stargate",
    "opencode",
    "proxy",
    "services",
    "starfleet",
  ])
    expect(summary).toContain(section);
  expect(await read("host")).toContain("1/2/3");
  expect(await read("host")).toContain("opencode PID 12 CPU 20%");
  expect(await read("host")).toContain("growth root 1MiB over 60s");
  expect(await read("stargate")).toContain("1.2.3");
  expect(await read("starfleet")).toContain("✗ stargate failed");
});

test("invalid sections perform no collection and give only valid section guidance", async () => {
  let calls = 0;

  const read = reader({
    sources: {
      ...sources,
      host: async () => {
        calls++;
        throw Error(canary);
      },
    },
  });

  expect(await read(canary)).toContain(
    "host, agents, stargate, opencode, proxy, services, starfleet",
  );
  expect(await read(canary)).not.toContain(canary);
  expect(calls).toBe(0);
  await read("services");
  expect(calls).toBe(0);
});

test("source failures remain unknown without raw exceptions or false all-clear", async () => {
  const fail = async () => {
    throw Error(canary);
  };

  const read = reader({
    sources: {
      host: fail,
      status: fail,
      ready: fail,
      reports: fail,
      alert: fail,
      starfleet: fail,
      uptime: () => 0,
    },
  });

  const text = await read();
  expect(text).not.toContain(canary);
  expect(text).not.toContain("✓");
  expect(text).toContain("unknown");
});

test("crew ownership never implies native activity and absent activity cannot prove a stall", async () => {
  const current = {
    id: "task_123",
    status: "running" as const,
    kind: "assignment" as const,
    summary: canary,
    phase: canary,
    progress: canary,
    createdAt: now - 9_000_000,
    startedAt: now - 9_000_000,
    updatedAt: now - 9_000_000,
    finishedAt: null,
  };

  const read = reader({
    backend: {
      crewStatus: async () => ({
        members: [
          {
            id: "apollo",
            name: canary,
            backend: "opencode",
            provisioned: "ready",
            observed: true,
            current,
            queuedCount: 2,
            queued: [],
            lastOutcome: null,
            recent: [],
            recentCount: 0,
          },
        ],
        total: 1,
        truncated: false,
      }),
    },
  });

  const text = await read("agents");
  expect(text).toContain("ownership running");
  expect(text).toContain("task_123");
  expect(text).toContain("native activity unknown");
  expect(text).toContain("stalled unknown");
  expect(text).not.toContain(canary);
  expect(text).not.toContain("idle");
});

test("expired and inactive quota never becomes healthy availability", async () => {
  const read = reader({
    backend: {
      quota: async () => ({
        status: "ok",
        observedAt: now,
        cached: true,
        accounts: [
          {
            provider: "codex",
            account: "codex-1",
            status: "ok",
            observedAt: now,
            windows: [
              {
                window: "5h",
                scope: "subscription",
                usedPercent: 20,
                remainingPercent: 80,
                resetAt: now - 1,
                active: true,
              },
              {
                window: "weekly",
                scope: "subscription",
                usedPercent: 10,
                remainingPercent: 90,
                resetAt: now + 1000,
                active: false,
              },
            ],
          },
        ],
      }),
    },
  });

  const text = await read("proxy");
  expect(text).toContain("codex-1");
  expect(text).toContain("availability unknown");
  expect(text).toContain("reset passed");
  expect(text).toContain("inactive");
  expect(text).not.toContain("✓");
});

test("bounded detail preserves unknown coverage when crew rows overflow", async () => {
  const read = reader({
    backend: {
      crewStatus: async () => ({
        members: Array.from({ length: 20 }, (_, i) => ({
          id: `crew-${i}`,
          name: canary,
          backend: "opencode",
          provisioned: "ready",
          observed: true,
          current: null,
          queuedCount: 0,
          queued: [],
          lastOutcome: null,
          recent: [],
          recentCount: 0,
        })),
        total: 25,
        truncated: true,
      }),
    },
  });

  const text = await read("agents");
  expect(text.length).toBeLessThan(3000);
  expect(text).toContain("truncated");
  expect(text).toContain("native activity unknown");
});

test("cached Starfleet future, stale and invalid observations are unknown", async () => {
  for (const observedAt of [now + 1, now - 901_000]) {
    const read = reader({
      sources: {
        ...sources,
        starfleet: async () => ({
          schema: "stargate.health.starfleet.v1",
          observedAt: new Date(observedAt).toISOString(),
          services: {
            avondale: "active",
            stargate: "active",
            opencode: "active",
            proxy: "active",
          },
        }),
      },
    });

    expect(await read("starfleet")).toContain("unknown");
    expect(await read("starfleet")).not.toContain("✓");
  }

  const read = reader({
    sources: {
      ...sources,
      starfleet: async () => ({
        ...(await sources.starfleet()),
        reason: canary,
      }),
    },
  });

  expect(await read("starfleet")).toContain("unknown");
  expect(await read("starfleet")).not.toContain(canary);
});

test("snapshot file reader bounds bytes and rejects foreign, missing and symbolic files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "health-"));
  const path = join(dir, "snapshot.json");

  try {
    expect(await readStarfleetSnapshot(path)).toBeNull();
    await writeFile(path, JSON.stringify(await sources.starfleet()), {
      mode: 0o600,
    });
    expect(await readStarfleetSnapshot(path)).toMatchObject({
      schema: "stargate.health.starfleet.v1",
    });
    await symlink(path, join(dir, "link"));
    expect(await readStarfleetSnapshot(join(dir, "link"))).toBeNull();
    await chmod(path, 0o644);
    expect(await readStarfleetSnapshot(path)).toBeNull();
    await chmod(path, 0o600);

    for (const text of [
      "{bad",
      "x".repeat(65_537),
      JSON.stringify({ schema: "foreign" }),
    ]) {
      await writeFile(path, text);
      expect(await readStarfleetSnapshot(path)).toBeNull();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("maintenance and cron render canonical states and no names or report text", async () => {
  const read = reader({
    sources: {
      ...sources,
      reports: async () => ({
        reports: [
          {
            startedAt: "2026-11-18T11:00:00Z",
            outcome: "completed",
            reason: canary,
          },
        ],
        unreadable: 0,
      }),
    },
    schedules: () => [
      {
        id: "cron-123",
        name: canary,
        channel: "C123",
        user: "U123",
        paused: 0,
        available: 1,
        nextAt: now + 1000,
        report: "immediate",
        lastRunAt: now - 1000,
        lastStatus: "failed",
      },
    ],
  });

  const text = await read("stargate");
  expect(text).toContain("completed 2026-11-18T11:00:00Z");
  expect(text).toContain("✗ cron cron-123 failed");
  expect(text).toContain("Slack/IRC connection unknown");
  expect(text).not.toContain(canary);
});

test("Stargate health exposes transport connection state, not process readiness alone", async () => {
  const read = reader({
    sources: {
      ...sources,
      ready: async () => ({
        schema: "stargate.ready.v1",
        pid: 1,
        readyAt: now - 1000,
        version: "0.38.1",
        transportObservedAt: now,
        transports: [
          { kind: "slack", id: "captain", state: "reconnecting" },
          { kind: "irc", id: "ship:chief", state: "connected" },
        ],
      }),
    },
  });

  const text = await read("stargate");
  expect(text).toContain("transports 1/2 connected");
  expect(text).toContain("slack captain: reconnecting");
  expect(text).toContain("irc ship:chief: connected");
});

test("OpenCode detail consumes optional canonical metadata without exposing ignored fields", async () => {
  const read = reader({
    sources: {
      ...sources,
      status: async () => ({
        ...status,
        openCode: {
          version: "2.2.7",
          activeSessions: 3,
          pendingForms: 2,
          pendingPermissions: 1,
          mcpConnected: 4,
          mcpFailed: 1,
          mcpNames: [canary],
        },
      }),
    },
  });

  const text = await read("opencode");
  expect(text).toContain("version 2.2.7");
  expect(text).toContain("active sessions 3");
  expect(text).toContain("pending forms 2");
  expect(text).toContain("permissions 1");
  expect(text).toContain("MCP connected 4; failed 1");
  expect(text).not.toContain(canary);
});

test("configured unit reads use only fixed read-only systemctl properties and suppress stderr", async () => {
  const commands: string[][] = [];

  const read = reader({
    maintenance: Schema.decodeUnknownSync(maintenanceSchema)({
      services: {
        gateway: "test-gateway.service",
        openCodeRestart: [
          "systemctl",
          "--user",
          "restart",
          "test-opencode.service",
        ],
      },
    }),
    runner: {
      run: async (command, options) => {
        commands.push([...command]);
        expect(options.timeoutMs).toBeLessThanOrEqual(5000);

        return {
          code: 0,
          stdout: `ActiveState=active\nLoadState=loaded\nDescription=${canary}`,
          stderr: canary,
        };
      },
    },
  });

  const text = await read();
  expect(commands).toHaveLength(2);

  for (const command of commands) {
    expect(command.slice(0, 3)).toEqual(["systemctl", "--user", "show"]);
    expect(command[4]).toBe("--property=LoadState,ActiveState");
    expect(command).not.toContain("restart");
  }

  expect(text).not.toContain(canary);
  expect(text).toContain("unit active");
});

test("unresponsive metadata readers do not prevent an unknown reply", async () => {
  const text = await reader({
    sources: { ...sources, status: () => new Promise(() => {}) },
  })("opencode");

  expect(text).toContain("backend read unknown");
  expect(text.length).toBeLessThan(3000);
}, 10_000);

test("summary contains exactly one aggregate status line per section", async () => {
  const text = await reader()();
  const lines = text.split("\n");
  expect(lines).toHaveLength(8);
  expect(lines[0]).toBe("Health · read-only");

  for (const [index, section] of [
    "host",
    "agents",
    "stargate",
    "opencode",
    "proxy",
    "services",
    "starfleet",
  ].entries()) {
    expect(lines[index + 1]).toMatch(new RegExp(`^[✓⚠✗] ${section}: `));
    expect(lines[index + 1]).toContain("unknown");
  }

  expect(lines[2]).toStartWith("✗ agents:");
  expect(lines[4]).toStartWith("✗ opencode:");
  expect(lines[7]).toStartWith("✗ starfleet:");
  expect(text.length).toBeLessThan(3000);
});

test("a late failed cron remains visible in summary and clipped detail aggregate", async () => {
  const read = reader({
    schedules: () =>
      Array.from({ length: 20 }, (_, index) => ({
        id: `cron-${index}-${"x".repeat(90)}`,
        name: canary,
        channel: "C123",
        user: "U123",
        paused: 0,
        available: 1,
        nextAt: now,
        report: "immediate",
        lastRunAt: now,
        lastStatus: index === 19 ? "failed" : "done",
      })),
  });

  expect(
    (await read()).split("\n").find((line) => line.includes("stargate:")),
  ).toStartWith("✗ stargate:");
  const detail = await read("stargate");
  expect(detail).toContain("✗ stargate");
  expect(detail).toContain("truncated");
  expect(detail.length).toBeLessThan(3000);
});

test("unavailable ticket fields stay explicit and ownership duration uses started time", async () => {
  const read = reader({
    backend: {
      crewStatus: async () => ({
        members: [
          {
            id: "apollo",
            name: canary,
            backend: "opencode",
            provisioned: "ready",
            observed: true,
            current: {
              id: "task_123",
              status: "running",
              kind: "assignment",
              summary: canary,
              phase: canary,
              progress: canary,
              createdAt: now - 200_000,
              startedAt: now - 120_000,
              updatedAt: now - 1000,
              finishedAt: null,
            },
            queuedCount: 0,
            queued: [],
            lastOutcome: null,
            recent: [],
            recentCount: 0,
          },
        ],
        total: 1,
        truncated: false,
      }),
    },
  });

  const agents = await read("agents");
  expect(agents).toContain("running duration 120s");
  expect(agents).toContain("last activity unknown");
  const gateway = await read("stargate");

  for (const field of [
    "last delivered unknown",
    "last-hour delivery errors unknown",
    "last-hour refused messages unknown",
    "latest release version unknown",
  ])
    expect(gateway).toContain(field);
  expect(await read("opencode")).toContain("unit started unknown");
  expect(await read("proxy")).toContain("unit started unknown");
});
