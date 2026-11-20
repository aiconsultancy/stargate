import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { diffEvents } from "../src/api/v1/diff";
import { createEventStreams } from "../src/api/v1/events";
import type { ApiV1Config } from "../src/api/v1/features";
import { createApiV1Source } from "../src/api/v1/projection";
import type { V1Git, V1QueueCounts, V1Task } from "../src/api/v1/types";
import type { AgentBackend } from "../src/backend";
import { OpenCodeBackend } from "../src/backends/opencode";
import { backendSchema, configSchema } from "../src/config";
import type { CrewStatus, CrewStatusInput } from "../src/crew-status";
import { type DashboardShip, dashboardSource } from "../src/dashboard-source";
import type {
  HistoryChildrenInput,
  HistorySession,
} from "../src/session-history";
import { bot, identity } from "./fixtures";

const signal = new AbortController().signal;
const privateProject = "/fictional/checkouts/project";

function task(
  id: string,
  status: V1Task["status"],
  extra: Partial<V1Task> = {},
): V1Task {
  return {
    id,
    status,
    kind: "assignment",
    summary: "Verify the change",
    phase: "",
    progress: "",
    createdAt: null,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    ...extra,
  };
}

function context(
  id: string,
  extra: Partial<CrewStatus["members"][number]> = {},
): CrewStatus["members"][number] {
  return {
    id,
    name: id === "pilot" ? "Test Pilot" : id,
    backend: "opencode",
    provisioned: "ready",
    observed: false,
    current: null,
    queuedCount: 0,
    queued: [],
    lastOutcome: null,
    recent: [],
    recentCount: 0,
    ...extra,
  };
}

function session(
  id: string,
  extra: Partial<HistorySession> = {},
): HistorySession {
  return { id, harness: "opencode", kind: "subagent", ...extra };
}

function fixture(options?: Parameters<typeof dashboardSource>[4]) {
  let at = 4_000_000;
  let config: ApiV1Config = Schema.decodeUnknownSync(configSchema)({
    bots: [bot("captain")],
    irc: [
      {
        id: "other",
        server: { host: "irc.example.test", port: 6697, tls: true },
        account: "other",
        passwordEnv: "IRC_EXAMPLE_PASSWORD",
        channels: ["#example"],
        backend: {
          type: "opencode",
          directory: "/other",
          url: "https://remote.example.test",
        },
        crew: [
          {
            id: "worker",
            account: "worker",
            passwordEnv: "IRC_WORKER_PASSWORD",
            channels: ["#example"],
            backend: {
              type: "pi-durable",
              model: "openai/local",
              directory: "/other-worker",
            },
          },
        ],
      },
    ],
    teams: [
      {
        id: "admiral",
        botClientId: "24651ef6-55ec-47a2-87bf-695f094ee7de",
        tenantId: "70baf6be-37eb-4532-8000-f71944694e71",
        socketPath: "/local/socket",
        access: { users: ["edb029d2-beff-4c27-808f-eadd1aa996f9"] },
        backend: {
          type: "opencode",
          directory: "/admiral",
          url: "http://127.0.0.1:4096",
        },
        fleetPolicy: {
          role: "rear_admiral",
          humanAccounts: ["operator"],
          assignedCheckout: "/admiral",
          capabilities: ["dispatch"],
        },
      },
    ],
  });
  const statuses = new Map<string, CrewStatus | Error | Promise<CrewStatus>>();
  const queue = new Map<string, V1QueueCounts>();
  const calls = {
    status: [] as string[],
    children: [] as string[],
    git: [] as string[],
  };
  const roots = [
    session("root-default", {
      kind: "crew",
      member: "pilot",
      model: "test/fallback",
    }),
    session("root-ops", { kind: "crew", member: "pilot" }),
    session("root-other", { kind: "crew", member: "other" }),
  ];
  const children = [
    session("newest", { parentID: "root-ops", updatedAt: at, title: "Review" }),
    session("second", {
      parentID: "root-default",
      updatedAt: at - 1,
      title: "Authorization: Bearer fixture-value",
    }),
    session("third", { parentID: "root-ops", updatedAt: at - 2 }),
    session("fourth", { parentID: "root-default", updatedAt: at - 3 }),
    session("old", { parentID: "root-default", updatedAt: 500 }),
    session("unknown-time", { parentID: "root-default" }),
    session("unrelated", { parentID: "root-other", updatedAt: at }),
  ];

  async function status(
    id: string,
    { member }: CrewStatusInput,
  ): Promise<CrewStatus> {
    calls.status.push(member ? `${id}/${member}` : id);
    const found = await statuses.get(id);
    if (found instanceof Error) throw found;
    if (!found) return { members: [], total: 0, truncated: false };
    if (!member) return found;
    const members = found.members.filter((context) => context.id === member);
    return { members, total: members.length, truncated: false };
  }
  const ships: DashboardShip[] = [];
  for (const entry of [
    ...config.bots,
    ...(config.irc ?? []),
    ...(config.teams ?? []),
    { ...bot(), id: "other-worker" },
  ]) {
    const id = entry.id;
    const backend: AgentBackend = {
      async createSession() {
        throw new Error("Read attempted to create a session");
      },
      async prompt() {
        throw new Error("Read attempted to prompt");
      },
      async close() {},
      async crewStatus(input) {
        return status(id, input);
      },
      ...(id === "captain"
        ? {
            async fleetCrewStatus(input: CrewStatusInput) {
              const scoped = await status(id, input);
              return {
                status: scoped,
                metadata: {
                  projectDirectory: privateProject,
                  contexts: scoped.members.map((context) => ({
                    member: context.id,
                    project:
                      context.project === "default"
                        ? null
                        : (context.project ?? null),
                    directory: `${privateProject}-${context.id}-${context.project ?? "default"}`,
                    role: "Flight testing",
                    model: "test/custom",
                  })),
                },
              };
            },
            history: {
              async roots() {
                return roots;
              },
              async describe() {
                return [];
              },
              async children({
                parentID,
                updatedSince,
                limit,
              }: HistoryChildrenInput) {
                calls.children.push(parentID);
                expect(updatedSince).toBe(at - 3_600_000);
                expect(limit).toBe(3);
                return {
                  sessions: children.filter(
                    (child) => child.parentID === parentID,
                  ),
                };
              },
              async entries() {
                throw new Error("Read attempted to access a transcript");
              },
            },
          }
        : {}),
    };
    const {
      displayName,
      backend: settings,
      concurrency,
      turnTimeoutMs,
    } = entry;
    ships.push({
      bot: { id, displayName, backend: settings, concurrency, turnTimeoutMs },
      identity,
      key: id,
      backend,
    });
  }
  const now = () => at;
  const counts = { queued: 0, running: 0, responding: 0, done: 0, failed: 0 };
  const dashboard = dashboardSource(
    ships,
    {
      queueCounts: (key) => queue.get(key) ?? counts,
      recentJobs: () => [],
      sessionIDs: () => [],
      ownsSession: () => false,
    },
    { report: () => [], recentRuns: () => [] },
    now,
    options,
  );
  const source = createApiV1Source({
    config: () => config,
    dashboard,
    now,
    git: async (directory): Promise<V1Git | null> => {
      if (!directory) return null;
      calls.git.push(directory);
      return {
        branch: "test/change",
        head: "123abcd",
        base: "origin/main",
        ahead: 1,
        behind: 0,
        changedFiles: 0,
        repository: "example/project",
        pushRepository: "example/project",
        checkedAt: at,
      };
    },
    pullRequest: () => null,
  });
  return {
    dashboard,
    source,
    calls,
    statuses,
    advance: () => ++at,
    useConfig: (next: (current: ApiV1Config) => ApiV1Config) => {
      config = next(config);
    },
    queue: (id: string, next: Partial<V1QueueCounts>) =>
      queue.set(id, { ...counts, ...next }),
    set: (id: string, members: CrewStatus["members"], truncated = false) =>
      statuses.set(id, { members, total: members.length, truncated }),
  };
}

const eventHost = {
  hostname: "example",
  platform: "linux",
  arch: "arm64",
  uptimeSec: 1,
  cpu: { cores: 1, usage: null, load: [0, 0, 0] as [number, number, number] },
  memory: { totalBytes: 100, availableBytes: 50 },
  disks: [],
  sampledAt: 1,
};

function fleetEvents(
  source: ReturnType<typeof fixture>["source"],
  timing?: Parameters<typeof createEventStreams>[1],
) {
  return createEventStreams(
    {
      ...source,
      diff: diffEvents,
      readHost: async () => eventHost,
      completeFleet: async (overview) => ({
        ...overview,
        host: eventHost,
        gateway: {
          version: "1.0.0",
          bunVersion: "1.0.0",
          opencodeVersion: null,
          startedAt: 1,
          features: [],
        },
      }),
    },
    timing,
  );
}

async function nextEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
) {
  const decoder = new TextDecoder();
  let frames = "";
  while (!frames.includes(marker)) {
    const next = await reader.read();
    if (next.done) throw new Error(`Missing frame containing ${marker}`);
    frames += decoder.decode(next.value, { stream: true });
  }
  return frames;
}

describe("Fleet API projection", () => {
  test("a timed-out OpenCode fleet probe leaves time for status and backs off", async () => {
    const methods: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const method = new URL(request.url).pathname.split("/").at(-1) ?? "";
        methods.push(method);
        if (method === "fleetStatus") await Bun.sleep(1_300);
        return Response.json({
          output: { members: [], total: 0, truncated: false },
        });
      },
    });
    const config = Schema.decodeUnknownSync(backendSchema)({
      type: "opencode",
      url: server.url.href,
      directory: "/",
    });
    if (config.type !== "opencode") throw new Error("Invalid backend fixture");
    const backend = new OpenCodeBackend(config);
    try {
      const caller = new AbortController();
      const cancelled = backend.fleetCrewStatus({}, caller.signal);
      while (!methods.length) await Bun.sleep(5);
      caller.abort();
      await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
      for (let i = 0; i < 4; i++) {
        const reading = AbortSignal.timeout(1_000);
        expect(await backend.fleetCrewStatus({}, reading)).toBeUndefined();
        expect(await backend.crewStatus({}, reading)).toMatchObject({
          members: [],
        });
      }
      expect(methods).toEqual([
        "fleetStatus",
        "fleetStatus",
        "status",
        "fleetStatus",
        "status",
        "fleetStatus",
        "status",
        "status",
      ]);
    } finally {
      await backend.close();
      await server.stop(true);
    }
  });

  test("a slow crew sample can become available after the fleet wait expires", async () => {
    const f = fixture({ fleetCrewReadMs: 25 });
    const held = Promise.withResolvers<CrewStatus>();
    f.statuses.set("captain", held.promise);
    const first = await f.source.fleet(signal);
    expect(first.ships.find(({ id }) => id === "captain")?.available).toBe(
      false,
    );
    held.resolve({ members: [context("pilot")], total: 1, truncated: false });
    await Bun.sleep(0);
    // The next read is slow too. It must be able to publish the late sample.
    const next = Promise.withResolvers<CrewStatus>();
    f.statuses.set("captain", next.promise);
    try {
      const fleet = await f.source.fleet(signal);
      expect(fleet.ships.find(({ id }) => id === "captain")).toMatchObject({
        available: true,
        crew: { people: 1 },
      });
      expect(f.calls.status.filter((id) => id === "captain")).toHaveLength(2);
    } finally {
      next.resolve({ members: [], total: 0, truncated: false });
    }
  });

  test("disconnecting the caller that started a crew sample leaves the shared read running", async () => {
    const f = fixture({ fleetCrewReadMs: 300 });
    const held = Promise.withResolvers<CrewStatus>();
    f.statuses.set("captain", held.promise);
    const caller = new AbortController();
    const first = f.source.fleet(caller.signal);
    await Bun.sleep(0);
    const joined = f.source.fleet(signal);
    await Bun.sleep(0);
    caller.abort();
    // Cancellation must finish even though the crew backend is still blocked.
    try {
      await expect(first).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      held.resolve({ members: [context("pilot")], total: 1, truncated: false });
    }
    expect(
      (await joined).ships.find(({ id }) => id === "captain"),
    ).toMatchObject({
      available: true,
      crew: { people: 1 },
    });
    expect(f.calls.status.filter((id) => id === "captain")).toHaveLength(1);
  });

  test("an older OpenCode plugin skips repeated missing fleet-status calls", async () => {
    const methods: string[] = [];
    let missing = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const method = new URL(request.url).pathname.split("/").at(-1) ?? "";
        methods.push(method);
        if (method === "fleetStatus")
          return Response.json(
            {
              _tag: missing ? "RpcError" : "RpcInternalError",
              type: missing ? "rpc.method_not_found" : "rpc.internal",
              message: "Fixture RPC failure",
            },
            { status: missing ? 400 : 500 },
          );
        return Response.json({
          output: { members: [], total: 0, truncated: false },
        });
      },
    });
    try {
      const config = Schema.decodeUnknownSync(backendSchema)({
        type: "opencode",
        url: server.url.href,
        directory: "/",
      });
      if (config.type !== "opencode")
        throw new Error("Invalid backend fixture");
      const backend = new OpenCodeBackend(config);
      try {
        expect(await backend.fleetCrewStatus({}, signal)).toBeUndefined();
        missing = true;
        expect(await backend.fleetCrewStatus({}, signal)).toBeUndefined();
        expect(await backend.fleetCrewStatus({}, signal)).toBeUndefined();
        expect(await backend.crewStatus({}, signal)).toMatchObject({
          members: [],
        });
        expect(methods).toEqual(["fleetStatus", "fleetStatus", "status"]);
      } finally {
        await backend.close();
      }
    } finally {
      await server.stop(true);
    }
  });

  test("backs off after repeated fleet-status failures with a different wire format", async () => {
    const methods: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const method = new URL(request.url).pathname.split("/").at(-1) ?? "";
        methods.push(method);
        if (method === "fleetStatus")
          return new Response("Not found", { status: 404 });
        return Response.json({
          output: { members: [], total: 0, truncated: false },
        });
      },
    });
    const config = Schema.decodeUnknownSync(backendSchema)({
      type: "opencode",
      url: server.url.href,
      directory: "/",
    });
    if (config.type !== "opencode") throw new Error("Invalid backend fixture");
    const backend = new OpenCodeBackend(config);
    try {
      for (let i = 0; i < 4; i++)
        expect(await backend.fleetCrewStatus({}, signal)).toBeUndefined();
      expect(await backend.crewStatus({}, signal)).toMatchObject({
        members: [],
      });
      expect(methods).toEqual([
        "fleetStatus",
        "fleetStatus",
        "fleetStatus",
        "status",
      ]);
    } finally {
      await backend.close();
      await server.stop(true);
    }
  });

  test("retains the last crew detail when a crew read fails but history still works", async () => {
    const f = fixture();
    f.set("captain", [
      context("pilot", { current: task("running", "running") }),
    ]);
    const streams = fleetEvents(f.source, {
      pollMs: 30,
      hostMs: 1000,
      heartbeatMs: 1000,
    });
    try {
      const reader = streams.open(AbortSignal.timeout(700))?.getReader();
      if (!reader) throw new Error("Cannot open event stream");
      const initial = await nextEvent(
        reader,
        'event: ship\ndata: {"id":"captain"',
      );
      const at = /"detailUpdatedAt":(\d+)/.exec(initial)?.[1];
      expect(at).toBeDefined();
      f.statuses.set("captain", new Error("Crew offline"));
      const unavailable = await nextEvent(reader, '"available":false');
      expect(unavailable).toContain("event: fleet");
      expect(unavailable).toContain('"kind":"availability"');
      const stale = await nextEvent(reader, '"detailStale":true');
      expect(stale).toContain('"id":"running"');
      expect(stale).toContain(`"detailUpdatedAt":${at}`);
    } finally {
      streams.stop();
    }
  });

  test("a stalled crew backend leaves healthy overview and detail updates streaming", async () => {
    const f = fixture({ fleetCrewReadMs: 40 });
    f.set("other", [context("remote")]);
    f.set("captain", [context("pilot")]);
    const streams = fleetEvents(f.source, {
      pollMs: 15,
      hostMs: 1000,
      heartbeatMs: 1000,
      readMs: 250,
    });
    const held = Promise.withResolvers<CrewStatus>();
    try {
      const reader = streams.open(AbortSignal.timeout(850))?.getReader();
      if (!reader) throw new Error("Cannot open event stream");
      await nextEvent(reader, 'event: ship\ndata: {"id":"other"');
      f.statuses.set("other", held.promise);
      f.set("captain", [
        context("pilot", { current: task("healthy-task", "running") }),
      ]);
      const unavailable = await nextEvent(reader, '"available":false');
      expect(unavailable).toContain("event: fleet");
      expect(unavailable).toContain('"crew":{"people":1,"busy":0,"queued":0}');
      const stale = await nextEvent(reader, '"detailStale":true');
      expect(stale).toContain('"id":"remote"');
      if (!(unavailable + stale).includes("healthy-task"))
        expect(await nextEvent(reader, "healthy-task")).toContain(
          "event: ship",
        );
      await Bun.sleep(70);
      expect(f.calls.status.filter((id) => id === "other")).toHaveLength(2);
      f.set("other", [context("recovered")]);
      held.resolve({ members: [], total: 0, truncated: false });
      expect(await nextEvent(reader, '"id":"recovered"')).toContain(
        "event: ship",
      );
    } finally {
      held.resolve({ members: [], total: 0, truncated: false });
      streams.stop();
    }
  });

  test("reuses the crew read for overview and detail in each event poll", async () => {
    const f = fixture();
    f.set("captain", [context("pilot")]);
    const streams = fleetEvents(f.source);
    try {
      const reader = streams.open(signal)?.getReader();
      if (!reader) throw new Error("Cannot open event stream");
      await nextEvent(reader, 'event: ship\ndata: {"id":"captain"');
      expect(f.calls.status.filter((id) => id === "captain")).toEqual([
        "captain",
      ]);
    } finally {
      streams.stop();
    }
  });

  test("uses top-level registrations, splits the admiral and selects the longest known idle time", async () => {
    const f = fixture();
    f.useConfig((config) => ({
      ...config,
      api: { listen: "127.0.0.1:7781", fleetName: "Test Fleet" },
    }));
    f.set(
      "captain",
      [
        context("pilot", {
          project: "default",
          lastOutcome: task("done-1", "completed", { finishedAt: 100 }),
        }),
        context("pilot", {
          project: "ops",
          lastOutcome: task("done-2", "completed", { finishedAt: 200 }),
        }),
        context("busy", {
          current: task("running", "running"),
          queuedCount: 1,
        }),
      ],
      true,
    );
    f.set("other", [
      context("remote", {
        lastOutcome: task("done-3", "completed", { finishedAt: 150 }),
      }),
    ]);
    const fleet = await f.source.fleet(signal);
    expect(fleet.name).toBe("Test Fleet");
    expect(fleet.admiral).toMatchObject({
      id: "admiral",
      role: "rear_admiral",
      transport: "teams",
    });
    expect(fleet.ships.map((ship) => ship.id)).toEqual(["captain", "other"]);
    expect(fleet.ships[0]).toMatchObject({
      captain: { activity: "idle", since: null },
      crew: { people: 2, busy: 1, queued: 1, partial: true },
      repository: "example/project",
    });
    expect(fleet.ships[1]).toMatchObject({ available: true, repository: null });
    expect(fleet.longestIdle).toEqual({
      ship: "other",
      member: "remote",
      since: 150,
    });
    expect(f.calls.git).toEqual([privateProject]);
    expect(f.calls.children).toEqual([]);
    expect(f.calls.status).not.toContain("other-worker");
    expect(JSON.stringify(fleet)).not.toContain(privateProject);

    const queued = f.advance();
    f.queue("captain", { queued: 2, responding: 1 });
    expect((await f.source.fleet(signal)).ships[0]?.captain).toMatchObject({
      activity: "queued",
      since: queued,
    });
    f.advance();
    expect((await f.source.ship("captain", signal))?.captain.since).toBe(
      queued,
    );
    const running = f.advance();
    f.queue("captain", { queued: 1, running: 1 });
    expect((await f.source.ship("captain", signal))?.captain).toMatchObject({
      activity: "running",
      since: running,
    });
    await expect(f.source.ship("admiral", signal)).resolves.toBeUndefined();
  });

  test("projects every context, prioritizes activity and derives times without inventing idleSince", async () => {
    const f = fixture();
    const first = task("queued-1", "queued", { createdAt: 20 });
    const second = task("queued-2", "queued", { createdAt: 10 });
    f.set("captain", [
      context("pilot", {
        project: "default",
        current: task("run", "dispatching", { createdAt: 40 }),
      }),
      context("pilot", {
        project: "ops",
        current: task("cancel", "cancelling", { createdAt: 15, startedAt: 30 }),
      }),
      context("pilot", {
        project: "web",
        queuedCount: 2,
        queued: [first, second],
      }),
      context("pilot", {
        project: "docs",
        lastOutcome: task("uncertain", "uncertain", { updatedAt: 50 }),
      }),
      context("pilot", { project: "tools", provisioned: "pending" }),
      context("new", { provisioned: "unprovisioned" }),
    ]);
    const ship = await f.source.ship("captain", signal);
    expect(ship?.crewMembers[0]).toMatchObject({
      role: "Flight testing",
      model: "test/custom",
      activity: "running",
      since: 30,
      idleSince: null,
      contexts: [
        { project: null, activity: "running" },
        { project: "ops", activity: "running" },
        { project: "web", activity: "queued" },
        { project: "docs", activity: "uncertain" },
        { project: "tools", activity: "unprovisioned", git: null },
      ],
    });
    expect(ship?.crewMembers[1]).toMatchObject({
      activity: "unprovisioned",
      since: null,
      idleSince: null,
    });
    f.advance();
    f.set("captain", [
      context("pilot", { queuedCount: 2, queued: [first, second] }),
      context("pilot", {
        project: "ops",
        lastOutcome: task("uncertain", "uncertain"),
      }),
      context("pilot", { project: "web" }),
    ]);
    expect(
      (await f.source.crew("captain", "pilot", signal))?.member,
    ).toMatchObject({ activity: "queued", since: 10, idleSince: null });

    const idle = f.advance();
    f.set("captain", [
      context("pilot"),
      context("pilot", {
        project: "ops",
        current: task("stale", "uncertain", { updatedAt: 2 }),
        lastOutcome: task("later", "completed", { finishedAt: 3 }),
      }),
      context("new"),
    ]);
    expect(
      (await f.source.crew("captain", "pilot", signal))?.member,
    ).toMatchObject({ activity: "idle", since: 3, idleSince: 3 });
    expect(
      (await f.source.crew("captain", "new", signal))?.member,
    ).toMatchObject({ activity: "idle", since: idle, idleSince: null });

    const uncertain = f.advance();
    f.set("captain", [
      context("pilot", { current: task("unknown", "uncertain") }),
    ]);
    expect(
      (await f.source.crew("captain", "pilot", signal))?.member,
    ).toMatchObject({
      activity: "uncertain",
      since: uncertain,
      idleSince: null,
    });
    f.advance();
    expect(
      (await f.source.crew("captain", "pilot", signal))?.member.since,
    ).toBe(uncertain);
  });

  test("uses only scoped roots, returns the newest three children and keeps paths private", async () => {
    const f = fixture();
    f.set("captain", [
      context("pilot", {
        project: "default",
        current: task("task-1", "running", {
          summary: "Authorization: Bearer fixture-value",
        }),
      }),
      context("pilot", {
        project: "ops",
        current: task("task-2", "running", {
          summary: `Configured Stargate project: ops.\nUse only your permanent worktree: "${privateProject}-pilot-ops`,
          progress: `Working in ${privateProject}-pilot-ops`,
        }),
      }),
    ]);
    expect(await f.dashboard.ship("captain", signal)).not.toHaveProperty(
      "metadata",
    );
    expect(JSON.stringify(await f.dashboard.fleet(signal))).not.toContain(
      privateProject,
    );
    const detail = await f.source.crew("captain", "pilot", signal);
    expect(detail?.member.subagents.map((child) => child.id)).toEqual([
      "newest",
      "second",
      "third",
    ]);
    expect(f.calls.children.sort()).toEqual(["root-default", "root-ops"]);
    expect(f.calls.status.at(-1)).toBe("captain/pilot");
    expect(f.calls.git.sort()).toEqual([
      `${privateProject}-pilot-default`,
      `${privateProject}-pilot-ops`,
    ]);
    expect(JSON.stringify(detail)).not.toContain(privateProject);
    expect(JSON.stringify(detail)).not.toContain("fixture-value");
    expect(detail?.member.contexts[1]?.current).toMatchObject({
      summary: "Project assignment",
      progress: "Working in [checkout]",
    });
    await expect(
      f.source.crew("other", "pilot", signal),
    ).resolves.toBeUndefined();
    f.statuses.set("other", new Error("Private failure details"));
    expect((await f.source.fleet(signal)).ships[1]).toMatchObject({
      available: false,
      crew: null,
      error: "Crew status unavailable.",
    });
    expect(await f.source.ship("other", signal)).toMatchObject({
      available: false,
      crew: null,
      error: "Crew status unavailable.",
    });
  });
});
