import { describe, expect, mock, spyOn, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Schema } from "effect";
import { diffEvents } from "../src/observability/dashboard/api/v1/diff";
import { createEventStreams } from "../src/observability/dashboard/api/v1/events";
import type { ApiV1Config } from "../src/observability/dashboard/api/v1/features";
import { createGitReader } from "../src/observability/dashboard/api/v1/git";
import {
  createApiV1Source,
  crewDiffSource,
  reportedGit,
} from "../src/observability/dashboard/api/v1/projection";
import type {
  CrewGitInput,
  FleetCrewStatusInput,
} from "../src/coordination/crew/reporting/fleet-status";
import { createCrewGitReader } from "../src/coordination/crew/workspace/git-state";
import { spawnGit } from "../src/coordination/crew/workspace/git-runner";
import { liveFleetGit } from "../src/coordination/crew/workspace/git-status";
import { startApiV1Server } from "../src/observability/dashboard/api/v1/server";
import { apiToken } from "../src/observability/dashboard/api/v1/token";
import type {
  V1Git,
  V1QueueCounts,
  V1RequestProgress,
  V1Task,
} from "../src/observability/dashboard/api/v1/types";
import type { AgentBackend } from "../src/backends/backend";
import { OpenCodeCrewStatus } from "../src/backends/opencode/crew-status";
import { OpenCodeBackend } from "../src/backends/opencode/opencode";
import { backendSchema, configSchema } from "../src/config";
import type { CrewStatus, CrewStatusInput } from "../src/shared/crew-status";
import {
  type DashboardShip,
  dashboardSource,
} from "../src/observability/dashboard/dashboard-source";
import type {
  HistoryChildrenInput,
  HistorySession,
} from "../src/shared/session-history";
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

function fleetTextFixture(
  reply: (mode: string) => Response | Promise<Response>,
  options?: Parameters<typeof dashboardSource>[4],
) {
  const asked: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/fleetStatus")) {
        asked.push("status");

        return Response.json({ output: statusText("redacted status") });
      }

      const mode =
        /"taskText":"(\w+)"/.exec(await request.text())?.[1] ?? "ordinary";

      asked.push(mode);

      return reply(mode);
    },
  });

  const f = fixture(options);

  const crew = new OpenCodeCrewStatus(
    OpenCode.make({ baseUrl: server.url.href }),
    () => "/fixture",
  );

  f.useCrewReader(crew);

  return { ...f, crew, asked, stop: () => server.stop(true) };
}

function statusText(summary: string) {
  return {
    members: [
      context("pilot", {
        current: task("fixture-task", "running", { summary }),
      }),
    ],
    total: 1,
    truncated: false,
  };
}

function fleetTextAnswer(mode: string) {
  const summary = mode === "full" ? `full ${"a".repeat(200)}` : mode;

  return Response.json({
    output: {
      status: statusText(summary),
      metadata: { projectDirectory: "/fixture", contexts: [] },
      ...(mode !== "ordinary" && { taskText: mode }),
    },
  });
}

function fixture(
  options?: Parameters<typeof dashboardSource>[4],
  overrides?: Pick<
    Parameters<typeof createApiV1Source>[0],
    "git" | "pullRequest" | "requests"
  >,
  captainGit?: AgentBackend["crewGit"],
) {
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
  const crewSignals = new Map<string, AbortSignal>();
  const queue = new Map<string, V1QueueCounts>();

  const calls = {
    status: [] as string[],
    children: [] as string[],
    git: [] as string[],
    diffs: [] as { ship: string; member: string }[],
    taskText: [] as string[],
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
      title: `Review ${privateProject}-pilot-default with token=fixture-value`,
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

    if (found instanceof Error) {
      throw found;
    }

    if (!found) {
      return { members: [], total: 0, truncated: false };
    }

    if (!member) {
      return found;
    }

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
      async checkoutDiff(input) {
        calls.diffs.push({ ship: id, member: input.member });

        return { kind: "missing" };
      },
      ...(id === "captain" && captainGit && { crewGit: captainGit }),
      ...(id === "captain"
        ? {
            async fleetCrewStatus(
              input: FleetCrewStatusInput,
              signal: AbortSignal,
            ) {
              calls.taskText.push(input.taskText ?? "ordinary");
              crewSignals.set(id, signal);
              const scoped = await status(id, input);

              return {
                kind: "answer",
                answer: {
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
                  ...(input.taskText && { taskText: input.taskText }),
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
      transcript: {
        sessionIDs: () => [],
        ownsSession: () => false,
      },
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
      if (!directory) {
        return null;
      }

      calls.git.push(directory);

      return {
        branch: "test/change",
        head: "123abcd",
        base: "origin/main",
        ahead: 1,
        behind: 0,
        changedFiles: 0,
        repository: "example/project",
        checkedAt: at,
      };
    },
    pullRequest: () => null,
    ...overrides,
  });

  return {
    dashboard,
    source,
    diffs: crewDiffSource({ config: () => config, dashboard }),
    calls,
    statuses,
    crewSignals,
    advance: () => ++at,
    useCrewReader(reader: OpenCodeCrewStatus) {
      const backend = dashboard.fleetBackend("captain");

      if (!backend) {
        throw new Error("Missing fixture captain");
      }

      backend.fleetCrewStatus = reader.fleetCrewStatus.bind(reader);
      backend.crewStatus = reader.crewStatus.bind(reader);
    },
    replaceBackend: (id: string) => {
      const ship = ships.find((entry) => entry.bot.id === id);

      if (ship) {
        ship.backend = { ...ship.backend };
      }
    },
    useConfig: (next: (current: ApiV1Config) => ApiV1Config) => {
      config = next(config);
    },
    queue: (id: string, next: Partial<V1QueueCounts>) =>
      queue.set(id, { ...counts, ...next }),
    set: (id: string, members: CrewStatus["members"], truncated = false) =>
      statuses.set(id, { members, total: members.length, truncated }),
  };
}

test("IRC Fleet detail includes live request progress unless explicitly disabled", async () => {
  const progress: V1RequestProgress = {
    request: 1,
    stage: "reasoning",
    observedAt: 4_000_000,
    status: "running",
    disconnected: false,
    stale: false,
    failure: null,
  };

  const requests = mock(() => [progress]);
  const f = fixture(undefined, { requests });
  expect((await f.source.ship("other", signal))?.captain.requests).toEqual([
    progress,
  ]);
  f.useConfig((config) => ({
    ...config,
    irc:
      config.irc?.map((registration) => ({
        ...registration,
        features: { ...registration.features, liveProgress: false },
      })) ?? [],
  }));
  expect((await f.source.ship("other", signal))?.captain).not.toHaveProperty(
    "requests",
  );
  expect(requests).toHaveBeenCalledTimes(1);
});

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
  const fallbackFleet = (
    overview: Awaited<ReturnType<typeof source.fleet>>,
  ) => ({
    ...overview,
    host: eventHost,
    gateway: {
      version: "1.0.0",
      bunVersion: "1.0.0",
      opencodeVersion: null,
      startedAt: 1,
      features: [],
    },
  });

  return createEventStreams(
    {
      ...source,
      diff: diffEvents,
      readHost: async () => eventHost,
      snapshotHost: () => eventHost,
      completeFleet: async (overview) => fallbackFleet(overview),
      fallbackFleet,
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

    if (next.done) {
      throw new Error(`Missing frame containing ${marker}`);
    }

    frames += decoder.decode(next.value, { stream: true });
  }

  return frames;
}

describe("Fleet API projection", () => {
  test("HTTP fleet returns healthy ships before the host deadline when a cold captain stalls", async () => {
    const shutdown = new AbortController();
    const f = fixture({ fleetSignal: shutdown.signal });
    const held = Promise.withResolvers<CrewStatus>();
    f.statuses.set("captain", held.promise);
    f.set("other", [context("pilot")]);
    const dataDirectory = await mkdtemp(join(tmpdir(), "stargate-api-"));

    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null),
    });

    const listen = `127.0.0.1:${reservation.port}`;
    await reservation.stop(true);
    let server: Awaited<ReturnType<typeof startApiV1Server>> | undefined;

    try {
      server = await startApiV1Server({
        config: { listen },
        dataDirectory,
        source: f.source,
        diff: diffEvents,
        gateway: {
          version: "1.0.0",
          startedAt: 1,
          opencodeVersion: async () => null,
        },
        signal: shutdown.signal,
        timing: { requestMs: 300 },
      });

      const response = await fetch(new URL("/api/v1/fleet", server.url), {
        headers: { Authorization: `Bearer ${await apiToken(dataDirectory)}` },
        signal: AbortSignal.timeout(1000),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ships: [
          {
            id: "captain",
            available: false,
            error: "Crew status unavailable.",
          },
          { id: "other", available: true, crew: { people: 1 } },
        ],
      });
      expect(f.crewSignals.get("captain")?.aborted).toBe(false);
    } finally {
      shutdown.abort();
      held.resolve({ members: [], total: 0, truncated: false });
      await server?.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  test("a timed-out fleet probe leaves ordinary crew status without old checkout metadata", async () => {
    const metadata = {
      projectDirectory: "/fixture",
      contexts: [{ member: "pilot", project: "ops", directory: "/old" }],
    };

    const held = Promise.withResolvers<void>();
    let stall = false;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const status = {
          members: [
            context("pilot", {
              project: "ops",
              name: stall ? "Reprovisioned pilot" : "Test Pilot",
            }),
          ],
          total: 1,
          truncated: false,
        };

        if (!new URL(request.url).pathname.endsWith("/fleetStatus")) {
          return Response.json({ output: status });
        }

        if (stall) {
          await held.promise;
        }

        return Response.json({ output: { status, metadata } });
      },
    });

    const config = Schema.decodeUnknownSync(backendSchema)({
      type: "opencode",
      url: server.url.href,
      directory: "/",
    });

    if (config.type !== "opencode") {
      throw new Error("Invalid backend fixture");
    }

    const backend = new OpenCodeBackend(config);

    try {
      expect(await backend.fleetCrewStatus({}, signal)).toMatchObject({
        kind: "answer",
        answer: {
          status: { members: [{ id: "pilot", project: "ops" }] },
          metadata,
        },
      });
      stall = true;
      const reading = AbortSignal.timeout(1000);
      expect(await backend.fleetCrewStatus({}, reading)).toEqual({
        kind: "unavailable",
      });
      expect(await backend.crewStatus({}, reading)).toMatchObject({
        members: [{ id: "pilot", project: "ops", name: "Reprovisioned pilot" }],
      });
    } finally {
      held.resolve();
      await backend.close();
      await server.stop(true);
    }
  });

  test("OpenCode adapts to a fleet probe slower than its initial budget", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        await Bun.sleep(550);

        return Response.json({
          output: {
            status: { members: [], total: 0, truncated: false },
            metadata: { projectDirectory: "/fixture", contexts: [] },
          },
        });
      },
    });

    const config = Schema.decodeUnknownSync(backendSchema)({
      type: "opencode",
      url: server.url.href,
      directory: "/",
    });

    if (config.type !== "opencode") {
      throw new Error("Invalid backend fixture");
    }

    const backend = new OpenCodeBackend(config);

    try {
      expect(await backend.fleetCrewStatus({}, signal)).toEqual({
        kind: "unavailable",
      });

      let recovered:
        | Awaited<ReturnType<typeof backend.fleetCrewStatus>>
        | undefined;

      for (let i = 0; i < 20 && recovered?.kind !== "answer"; i++) {
        await Bun.sleep(5); // Fetch may still be aborting after the deadline.
        recovered = await backend.fleetCrewStatus({}, signal);
      }

      expect(recovered).toMatchObject({
        kind: "answer",
        answer: { metadata: { projectDirectory: "/fixture" } },
      });
      expect(await backend.fleetCrewStatus({}, signal)).toMatchObject({
        kind: "answer",
        answer: { metadata: { projectDirectory: "/fixture" } },
      });
    } finally {
      await backend.close();
      await server.stop(true);
    }
  });

  test("concurrent OpenCode fleet callers share checkout metadata", async () => {
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const status = { members: [], total: 0, truncated: false };
    const metadata = { projectDirectory: "/fixture", contexts: [] };
    const filtered = { projectDirectory: "/filtered", contexts: [] };

    const fetchProbe = mock(async () => {
      if (fetchProbe.mock.calls.length === 1) {
        started.resolve();
        await held.promise;

        return Response.json({ output: { status, metadata } });
      }

      return Response.json({ output: { status, metadata: filtered } });
    });

    const config = Schema.decodeUnknownSync(backendSchema)({
      type: "opencode",
      url: "http://127.0.0.1:1",
      directory: "/",
    });

    if (config.type !== "opencode") {
      throw new Error("Invalid backend fixture");
    }

    const backend = new OpenCodeBackend(
      config,
      OpenCode.make({
        baseUrl: config.url,
        fetch: Object.assign(fetchProbe, { preconnect: fetch.preconnect }),
      }),
    );

    try {
      const caller = new AbortController();
      const first = backend.fleetCrewStatus({}, caller.signal);
      await started.promise;
      const second = backend.fleetCrewStatus({}, signal);
      const different = backend.fleetCrewStatus({ member: "pilot" }, signal);
      caller.abort();
      await expect(first).rejects.toMatchObject({ name: "AbortError" });
      expect(fetchProbe).toHaveBeenCalledTimes(1);
      held.resolve();
      expect(await second).toEqual({
        kind: "answer",
        answer: { status, metadata },
      });
      expect(await different).toEqual({
        kind: "answer",
        answer: { status, metadata: filtered },
      });
      expect(fetchProbe).toHaveBeenCalledTimes(2);
    } finally {
      held.resolve();
      await backend.close();
    }
  });

  test("OpenCode waits for a timed-out fleet probe to settle before probing again", async () => {
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const status = { members: [], total: 0, truncated: false };
    const metadata = { projectDirectory: "/fixture", contexts: [] };
    let probes = 0;

    const mockFetch = async (url: URL | RequestInfo) => {
      const path = new URL(url instanceof Request ? url.url : url).pathname;

      if (!path.endsWith("/fleetStatus")) {
        return Response.json({ output: status });
      }

      if (++probes === 1) {
        started.resolve();
        await held.promise;
      }

      return Response.json({ output: { status, metadata } });
    };

    const config = Schema.decodeUnknownSync(backendSchema)({
      type: "opencode",
      url: "http://127.0.0.1:1",
      directory: "/",
    });

    if (config.type !== "opencode") {
      throw new Error("Invalid backend fixture");
    }

    const backend = new OpenCodeBackend(
      config,
      OpenCode.make({
        baseUrl: config.url,
        fetch: Object.assign(mockFetch, { preconnect: fetch.preconnect }),
      }),
    );

    const deadline = new AbortController();

    const timeout = spyOn(AbortSignal, "timeout").mockReturnValueOnce(
      deadline.signal,
    );

    try {
      const first = backend.fleetCrewStatus({}, signal);
      await started.promise;
      deadline.abort(new DOMException("Fixture deadline", "TimeoutError"));
      expect(await first).toEqual({ kind: "unavailable" });
      expect(await backend.fleetCrewStatus({}, signal)).toEqual({
        kind: "unavailable",
      });
      expect(await backend.crewStatus({}, signal)).toEqual(status);
      expect(probes).toBe(1);
      held.resolve();
      await Bun.sleep(0);
      expect(await backend.fleetCrewStatus({}, signal)).toEqual({
        kind: "answer",
        answer: { status, metadata },
      });
      expect(probes).toBe(2);
    } finally {
      timeout.mockRestore();
      held.resolve();
      await backend.close();
    }
  });

  test("OpenCode backs off and allows one retry after abandoning a stuck fleet probe", async () => {
    const first = Promise.withResolvers<void>();
    const retry = Promise.withResolvers<void>();
    const status = { members: [], total: 0, truncated: false };
    const metadata = { projectDirectory: "/fixture", contexts: [] };

    const fetchProbe = mock(async () => {
      switch (fetchProbe.mock.calls.length) {
        case 1:
        case 2:
          return new Response("Unavailable", { status: 500 });
        case 3:
          await first.promise;
          break;
        case 4:
          await retry.promise;
      }

      return Response.json({ output: { status, metadata } });
    });

    const config = Schema.decodeUnknownSync(backendSchema)({
      type: "opencode",
      url: "http://127.0.0.1:1",
      directory: "/",
    });

    if (config.type !== "opencode") {
      throw new Error("Invalid backend fixture");
    }

    const backend = new OpenCodeBackend(
      config,
      OpenCode.make({
        baseUrl: config.url,
        fetch: Object.assign(fetchProbe, { preconnect: fetch.preconnect }),
      }),
    );

    const clock = spyOn(performance, "now").mockReturnValue(0);
    const timeout = spyOn(AbortSignal, "timeout");
    const hardCap = 3 * 6400;

    const startAndTimeOut = async (count: number) => {
      const deadline = new AbortController();
      timeout.mockReturnValueOnce(deadline.signal);
      const read = backend.fleetCrewStatus({}, signal);
      await Bun.sleep(0);
      expect(fetchProbe).toHaveBeenCalledTimes(count);
      deadline.abort(new DOMException("Fixture deadline", "TimeoutError"));
      expect(await read).toEqual({ kind: "unavailable" });
    };

    try {
      expect(await backend.fleetCrewStatus({}, signal)).toEqual({
        kind: "unavailable",
      });
      expect(await backend.fleetCrewStatus({}, signal)).toEqual({
        kind: "unavailable",
      });
      await startAndTimeOut(3);

      clock.mockReturnValue(hardCap - 1);
      expect(await backend.fleetCrewStatus({}, signal)).toEqual({
        kind: "unavailable",
      });
      clock.mockReturnValue(hardCap);
      expect(await backend.fleetCrewStatus({}, signal)).toEqual({
        kind: "unavailable",
      });
      clock.mockReturnValue(hardCap + 59_999);
      expect(await backend.fleetCrewStatus({}, signal)).toEqual({
        kind: "unavailable",
      });
      expect(fetchProbe).toHaveBeenCalledTimes(3);

      clock.mockReturnValue(hardCap + 60_000);
      await startAndTimeOut(4);
      clock.mockReturnValue(2 * hardCap + 60_000);
      expect(await backend.fleetCrewStatus({}, signal)).toEqual({
        kind: "unavailable",
      });
      expect(fetchProbe).toHaveBeenCalledTimes(4);

      first.resolve();
      await Bun.sleep(0);
      expect(await backend.fleetCrewStatus({}, signal)).toEqual({
        kind: "answer",
        answer: { status, metadata },
      });
      expect(fetchProbe).toHaveBeenCalledTimes(5);
    } finally {
      timeout.mockRestore();
      clock.mockRestore();
      first.resolve();
      retry.resolve();
      await backend.close();
    }
  });

  test("a cancelled OpenCode fleet probe leaves ordinary status available", async () => {
    const methods: string[] = [];

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const method = new URL(request.url).pathname.split("/").at(-1) ?? "";
        methods.push(method);

        if (method === "fleetStatus") {
          await Bun.sleep(1300);
        }

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

    if (config.type !== "opencode") {
      throw new Error("Invalid backend fixture");
    }

    const backend = new OpenCodeBackend(config);

    try {
      const caller = new AbortController();
      const cancelled = backend.fleetCrewStatus({}, caller.signal);

      while (!methods.length) {
        await Bun.sleep(5);
      }

      caller.abort();
      await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
      const reading = AbortSignal.timeout(1000);
      expect(await backend.crewStatus({}, reading)).toMatchObject({
        members: [],
      });
      expect(methods).toEqual(["fleetStatus", "status"]);
    } finally {
      await backend.close();
      await server.stop(true);
    }
  });

  test("the first fleet request waits for slow shared crew status", async () => {
    const f = fixture({ fleetCrewReadMs: 25 });
    const held = Promise.withResolvers<CrewStatus>();
    f.statuses.set("captain", held.promise);
    const first = f.source.fleet(signal);
    await Bun.sleep(60);
    held.resolve({ members: [context("pilot")], total: 1, truncated: false });
    expect(
      (await first).ships.find(({ id }) => id === "captain"),
    ).toMatchObject({
      available: true,
      crew: { people: 1 },
    });
    expect(f.calls.status.filter((id) => id === "captain")).toHaveLength(1);
  });

  test("a refresh retains a crew sample older than five seconds until the new result arrives", async () => {
    const f = fixture({ fleetCrewReadMs: 25 });
    f.set("captain", [context("pilot")]);
    await f.source.fleet(signal);
    const next = Promise.withResolvers<CrewStatus>();
    f.statuses.set("captain", next.promise);

    const clock = spyOn(performance, "now").mockReturnValue(
      performance.now() + 6000,
    );

    try {
      const fleet = await f.source.fleet(signal);
      expect(fleet.ships.find(({ id }) => id === "captain")).toMatchObject({
        available: true,
        crew: { people: 1 },
      });
      expect(f.calls.status.filter((id) => id === "captain")).toHaveLength(2);
      next.resolve({
        members: [context("pilot"), context("navigator")],
        total: 2,
        truncated: false,
      });
      await Bun.sleep(0);
      expect(
        (await f.source.fleet(signal)).ships.find(({ id }) => id === "captain"),
      ).toMatchObject({
        available: true,
        crew: { people: 2 },
      });
    } finally {
      clock.mockRestore();
      next.resolve({ members: [], total: 0, truncated: false });
    }
  });

  test("an expired crew failure waits for the shared refresh", async () => {
    const f = fixture({ fleetCrewReadMs: 5 });
    f.statuses.set("captain", new Error("Fixture unavailable"));

    const captain = (fleet: Awaited<ReturnType<typeof f.source.fleet>>) =>
      fleet.ships.find(({ id }) => id === "captain");

    expect(captain(await f.source.fleet(signal))?.available).toBe(false);
    const held = Promise.withResolvers<CrewStatus>();
    f.statuses.set("captain", held.promise);

    const clock = spyOn(performance, "now").mockReturnValue(
      performance.now() + 24_000,
    );

    const refresh = f.source.fleet(signal);

    try {
      expect(
        await Promise.race([
          refresh.then(() => "stale"),
          Bun.sleep(30).then(() => "pending"),
        ]),
      ).toBe("pending");
      held.resolve({ members: [context("pilot")], total: 1, truncated: false });
      expect(captain(await refresh)).toMatchObject({
        available: true,
        crew: { people: 1 },
      });
    } finally {
      clock.mockRestore();
      held.resolve({ members: [], total: 0, truncated: false });
      await refresh;
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

  test("shutdown cancels the shared crew sample", async () => {
    const shutdown = new AbortController();
    const f = fixture({ fleetSignal: shutdown.signal });
    const held = Promise.withResolvers<CrewStatus>();
    f.statuses.set("captain", held.promise);
    const read = f.source.fleet(signal);
    void read.catch(() => {});

    try {
      await Bun.sleep(0);
      const backendRead = f.crewSignals.get("captain");
      expect(backendRead?.aborted).toBe(false);
      shutdown.abort();
      await expect(read).rejects.toMatchObject({ name: "AbortError" });
      expect(backendRead?.aborted).toBe(true);
    } finally {
      held.resolve({ members: [], total: 0, truncated: false });
      await read.catch(() => {});
    }
  });

  test("reload invalidates cached crew samples without opening more backend slots", async () => {
    const f = fixture({ fleetCrewReadMs: 5 });
    await f.source.fleet(signal);
    const held = Promise.withResolvers<CrewStatus>();
    f.statuses.set("captain", held.promise);
    const first = f.source.fleet(signal);
    const reads = [first];
    void first.catch(() => {});

    try {
      await Bun.sleep(0);

      for (let i = 0; i < 3; i++) {
        f.dashboard.invalidateFleetCrew();
        const read = f.source.fleet(signal);
        void read.catch(() => {});
        reads.push(read);
        await Bun.sleep(0);
      }

      expect(f.calls.status.filter((id) => id === "captain")).toHaveLength(2);
      const last = reads[reads.length - 1] ?? first;
      expect(
        await Promise.race([
          Promise.race([first, last]).then(() => "cached"),
          Bun.sleep(25).then(() => "pending"),
        ]),
      ).toBe("pending");
      held.resolve({ members: [context("pilot")], total: 1, truncated: false });
      expect(await first).toEqual(await last);
      expect(
        (await last).ships.find(({ id }) => id === "captain"),
      ).toMatchObject({
        available: true,
        crew: { people: 1 },
      });
    } finally {
      held.resolve({ members: [], total: 0, truncated: false });
      await Promise.allSettled(reads);
    }
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

        if (method === "fleetStatus") {
          return Response.json(
            {
              _tag: missing ? "RpcError" : "RpcInternalError",
              type: missing ? "rpc.method_not_found" : "rpc.internal",
              message: "Fixture RPC failure",
            },
            { status: missing ? 400 : 500 },
          );
        }

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

      if (config.type !== "opencode") {
        throw new Error("Invalid backend fixture");
      }

      const backend = new OpenCodeBackend(config);

      try {
        expect(await backend.fleetCrewStatus({}, signal)).toEqual({
          kind: "unavailable",
        });
        missing = true;
        expect(await backend.fleetCrewStatus({}, signal)).toEqual({
          kind: "unsupported",
        });
        expect(await backend.fleetCrewStatus({}, signal)).toEqual({
          kind: "unsupported",
        });
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

  test("task text modes: a plugin that rejects the field is asked again without it, then not for a minute", async () => {
    const asked: string[] = [];
    let old = false;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const mode =
          /"taskText":"(\w+)"/.exec(await request.text())?.[1] ?? "ordinary";

        asked.push(mode);

        if (old && mode !== "ordinary") {
          return Response.json(
            {
              _tag: "RpcError",
              type: "rpc.invalid_input",
              message: "Fixture RPC failure",
            },
            { status: 400 },
          );
        }

        return Response.json({
          output: {
            status: { members: [], total: 0, truncated: false },
            metadata: { projectDirectory: "/fixture", contexts: [] },
            ...(mode !== "ordinary" && { taskText: mode }),
          },
        });
      },
    });

    try {
      const config = Schema.decodeUnknownSync(backendSchema)({
        type: "opencode",
        url: server.url.href,
        directory: "/",
      });

      if (config.type !== "opencode") {
        throw new Error("Invalid backend fixture");
      }

      const backend = new OpenCodeBackend(config);
      const full = { member: "pilot", taskText: "full" } as const;
      const unredacted = { taskText: "unredacted" } as const;

      try {
        expect(await backend.fleetCrewStatus(full, signal)).toMatchObject({
          kind: "answer",
          answer: { taskText: "full" },
        });
        expect(
          await backend.fleetCrewStatus({ member: "pilot" }, signal),
        ).not.toHaveProperty("answer.taskText");
        expect(await backend.fleetCrewStatus(unredacted, signal)).toMatchObject(
          { kind: "answer", answer: { taskText: "unredacted" } },
        );
        expect(asked).toEqual(["full", "ordinary", "unredacted"]);

        old = true;
        const masked = await backend.fleetCrewStatus(unredacted, signal);
        expect(masked).toMatchObject({
          kind: "unsupported",
          answer: { metadata: { contexts: [] } },
        });
        expect(masked).not.toHaveProperty("answer.taskText");
        expect(await backend.fleetCrewStatus(full, signal)).toEqual(masked);
        expect(asked.slice(3)).toEqual(["unredacted", "ordinary", "ordinary"]);
      } finally {
        await backend.close();
      }
    } finally {
      await server.stop(true);
    }
  });

  test.each(["crew", "ship", "sample"] as const)(
    "slow current plugin: %s waits past the ordinary probe for task text",
    async (route) => {
      const f = fleetTextFixture(async (mode) => {
        await Bun.sleep(500);

        return fleetTextAnswer(mode);
      });

      try {
        if (route === "crew") {
          const detail = await f.source.crew("captain", "pilot", signal);
          expect(detail?.member.contexts[0]?.current?.summary).toBe(
            `full ${"a".repeat(200)}`,
          );
        } else if (route === "ship") {
          const detail = await f.source.ship("captain", signal);
          expect(detail?.crewMembers[0]?.contexts[0]?.current?.summary).toBe(
            "unredacted",
          );
        } else {
          const sample = await f.dashboard.fleetWithCrew(
            signal,
            new Set(["captain"]),
          );

          const captain = sample.ships.find(
            ({ summary }) => summary.id === "captain",
          );

          expect(captain?.members?.[0]?.contexts[0]?.current?.summary).toBe(
            "unredacted",
          );
        }

        expect(f.asked).toEqual([route === "crew" ? "full" : "unredacted"]);
      } finally {
        await f.stop();
      }
    },
  );

  test.each(["full", "ordinary"] as const)(
    "task text request rejects a %s reply to an unredacted request",
    async (wrongMode) => {
      const f = fleetTextFixture(() => fleetTextAnswer(wrongMode));

      try {
        expect(await f.source.ship("captain", signal)).toMatchObject({
          available: false,
          error: "Crew status unavailable.",
          crewMembers: [],
        });
        expect(f.asked).toEqual(["unredacted"]);
      } finally {
        await f.stop();
      }
    },
  );

  test("task text backoff is unavailable, not unsupported or an ordinary read", async () => {
    const f = fleetTextFixture(() =>
      Response.json(
        {
          _tag: "RpcInternalError",
          type: "rpc.internal",
          message: "Fixture RPC failure",
        },
        { status: 500 },
      ),
    );

    try {
      // Only task text failures back off the task text lane.
      for (let attempt = 0; attempt < 3; attempt++) {
        await f.crew.fleetCrewStatus(
          { member: "pilot", taskText: "full" },
          signal,
        );
      }

      await expect(f.source.crew("captain", "pilot", signal)).rejects.toThrow(
        "Crew status unavailable.",
      );
      expect(f.asked).toEqual(["full", "full", "full"]);
    } finally {
      await f.stop();
    }
  });

  test("HTTP crew detail returns 503 when the current plugin misses its deadline", async () => {
    const held = Promise.withResolvers<Response>();

    const f = fleetTextFixture(() => held.promise, {
      fleetCrewDeadlineMs: 700,
    });

    const dataDirectory = await mkdtemp(join(tmpdir(), "stargate-api-"));
    const shutdown = new AbortController();

    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null),
    });

    const listen = `127.0.0.1:${reservation.port}`;
    await reservation.stop(true);
    let server: Awaited<ReturnType<typeof startApiV1Server>> | undefined;

    try {
      server = await startApiV1Server({
        config: { listen },
        dataDirectory,
        source: f.source,
        diff: diffEvents,
        gateway: {
          version: "1.0.0",
          startedAt: 1,
          opencodeVersion: async () => null,
        },
        signal: shutdown.signal,
        timing: { requestMs: 1500 },
      });

      const response = await fetch(
        new URL("/api/v1/ships/captain/crew/pilot", server.url),
        {
          headers: { Authorization: `Bearer ${await apiToken(dataDirectory)}` },
          signal: AbortSignal.timeout(2500),
        },
      );

      expect(response.status).toBe(503);
      expect(await response.text()).toBe("");
      expect(f.asked).toEqual(["full"]);
    } finally {
      held.resolve(fleetTextAnswer("full"));
      shutdown.abort();
      await server?.stop();
      await f.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  test("HTTP crew detail for a member the plugin rejects answers 404 with no RPC", async () => {
    const f = fleetTextFixture((mode) => fleetTextAnswer(mode));
    const dataDirectory = await mkdtemp(join(tmpdir(), "stargate-api-"));
    const shutdown = new AbortController();

    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null),
    });

    const listen = `127.0.0.1:${reservation.port}`;
    await reservation.stop(true);
    let server: Awaited<ReturnType<typeof startApiV1Server>> | undefined;

    try {
      server = await startApiV1Server({
        config: { listen },
        dataDirectory,
        source: f.source,
        diff: diffEvents,
        gateway: {
          version: "1.0.0",
          startedAt: 1,
          opencodeVersion: async () => null,
        },
        signal: shutdown.signal,
      });

      const token = await apiToken(dataDirectory);

      // Each passes the route's own check, but not the plugin's member schema.
      for (const member of ["Pilot", "pilot.x", "-pilot", "pilot%20x"]) {
        for (const method of ["GET", "HEAD"]) {
          const response = await fetch(
            new URL(`/api/v1/ships/captain/crew/${member}`, server.url),
            { method, headers: { Authorization: `Bearer ${token}` } },
          );

          expect(response.status).toBe(404);
        }
      }

      expect(f.asked).toEqual([]);
    } finally {
      shutdown.abort();
      await server?.stop();
      await f.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  test("an unavailable Fleet sample cannot reuse ordinary text from a legacy read", async () => {
    let now = performance.now();
    const clock = spyOn(performance, "now").mockImplementation(() => now);

    const f = fleetTextFixture((mode) => {
      if (mode === "ordinary" || now >= upgradedAt) {
        return fleetTextAnswer("ordinary");
      }

      return Response.json(
        {
          _tag: "RpcError",
          type: "rpc.invalid_input",
          message: "Legacy fixture",
        },
        { status: 400 },
      );
    });

    const upgradedAt = now + 60_001;

    const sample = async () =>
      (await f.dashboard.fleetWithCrew(signal, new Set(["captain"]))).ships[0];

    try {
      expect(
        (await sample())?.members?.[0]?.contexts[0]?.current?.summary,
      ).toBe("ordinary");
      now = upgradedAt;
      const unavailable = await sample();
      expect(unavailable?.error).toBe("Crew status unavailable.");
      expect(unavailable?.members).toBeUndefined();
      expect(f.asked).toEqual(["unredacted", "ordinary", "unredacted"]);
    } finally {
      clock.mockRestore();
      await f.stop();
    }
  });

  test.each(["rpc.method_not_found", "rpc.invalid_input"] as const)(
    "only explicit legacy failure %s gives the plugin's ordinary text",
    async (legacy) => {
      const f = fleetTextFixture((mode) =>
        mode === "ordinary"
          ? fleetTextAnswer(mode)
          : Response.json(
              { _tag: "RpcError", type: legacy, message: "Legacy fixture" },
              { status: 400 },
            ),
      );

      try {
        const first = await f.source.crew("captain", "pilot", signal);
        const second = await f.source.crew("captain", "pilot", signal);

        const status =
          legacy === "rpc.method_not_found" ? "status" : "ordinary";

        const expected = status === "status" ? "redacted status" : "ordinary";
        expect(first?.member.contexts[0]?.current?.summary).toBe(expected);
        expect(second?.member.contexts[0]?.current?.summary).toBe(expected);
        expect(f.asked).toEqual(["full", status, status]);
      } finally {
        await f.stop();
      }
    },
  );

  test("an older OpenCode plugin without crewGit is skipped for a minute", async () => {
    const methods: string[] = [];
    let missing = false;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        methods.push(new URL(request.url).pathname.split("/").at(-1) ?? "");

        if (missing) {
          return Response.json(
            {
              _tag: "RpcError",
              type: "rpc.method_not_found",
              message: "Fixture RPC failure",
            },
            { status: 400 },
          );
        }

        return Response.json({
          output: {
            project: { directory: "/fixture", git: null },
            contexts: [],
          },
        });
      },
    });

    try {
      const config = Schema.decodeUnknownSync(backendSchema)({
        type: "opencode",
        url: server.url.href,
        directory: "/",
      });

      if (config.type !== "opencode") {
        throw new Error("Invalid backend fixture");
      }

      const backend = new OpenCodeBackend(config);

      try {
        expect(await backend.crewGit({ member: "pilot" }, signal)).toEqual({
          project: { directory: "/fixture", git: null },
          contexts: [],
        });
        missing = true;
        expect(await backend.crewGit({}, signal)).toBeUndefined();
        expect(await backend.crewGit({}, signal)).toBeUndefined();
        expect(methods).toEqual(["crewGit", "crewGit"]);
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

        if (method === "fleetStatus") {
          return new Response("Not found", { status: 404 });
        }

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

    if (config.type !== "opencode") {
      throw new Error("Invalid backend fixture");
    }

    const backend = new OpenCodeBackend(config);

    try {
      for (let i = 0; i < 4; i++) {
        expect(await backend.fleetCrewStatus({}, signal)).toEqual({
          kind: "unavailable",
        });
      }

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

      if (!reader) {
        throw new Error("Cannot open event stream");
      }

      const initial = await nextEvent(
        reader,
        'event: ship\ndata: {"id":"captain"',
      );

      const at = /"detailUpdatedAt":(\d+)/.exec(initial)?.[1];
      expect(at).toBeDefined();
      f.advance();
      f.statuses.set("captain", new Error("Crew offline"));
      const unavailable = await nextEvent(reader, '"available":false');
      expect(unavailable).toContain("event: fleet");
      expect(unavailable).toContain('"kind":"availability"');
      const stale = await nextEvent(reader, '"detailStale":true');
      expect(stale).toContain('"id":"running"');
      expect(stale).toContain(`"detailUpdatedAt":${at}`);

      const detail = stale
        .split("\n")
        .find(
          (line) =>
            line.startsWith('data: {"id":"captain"') &&
            line.includes('"detailStale":true'),
        );

      expect(detail && JSON.parse(detail.slice(6))).toMatchObject({
        available: false,
        error: "Crew status unavailable.",
      });
    } finally {
      streams.stop();
    }
  });

  test("a reused crew sample keeps its observation time when other detail changes", async () => {
    const f = fixture({ fleetCrewReadMs: 5, fleetCrewDeadlineMs: 180 });
    const held = Promise.withResolvers<CrewStatus>();
    f.set("captain", [context("pilot")]);

    const streams = fleetEvents(f.source, {
      pollMs: 30,
      hostMs: 1000,
      heartbeatMs: 1000,
    });

    try {
      const reader = streams.open(AbortSignal.timeout(750))?.getReader();

      if (!reader) {
        throw new Error("Cannot open event stream");
      }

      const marker = 'event: ship\ndata: {"id":"captain"';

      const detailLine = (frames: string) =>
        frames
          .split("\n")
          .find(
            (line) =>
              line.startsWith('data: {"id":"captain"') &&
              line.includes('"crewMembers"'),
          ) ?? "";

      const initial = detailLine(await nextEvent(reader, marker));
      const at = /"detailUpdatedAt":(\d+)/.exec(initial)?.[1];
      expect(at).toBeDefined();
      f.advance();
      f.statuses.set("captain", held.promise);
      f.queue("captain", { running: 7 });
      const refreshed = detailLine(await nextEvent(reader, marker));
      expect(refreshed).toContain('"running":7');
      expect(refreshed).toContain('"id":"pilot"');
      expect(refreshed).toContain(`"detailUpdatedAt":${at}`);
    } finally {
      streams.stop();
      held.resolve({ members: [], total: 0, truncated: false });
    }
  });

  test("a crew refresh can recover after an abort-ignoring read reaches its hard cap", async () => {
    const f = fixture({ fleetCrewReadMs: 5, fleetCrewDeadlineMs: 25 });
    const held = Promise.withResolvers<CrewStatus>();
    f.statuses.set("captain", held.promise);

    const streams = fleetEvents(f.source, {
      pollMs: 10,
      hostMs: 1000,
      heartbeatMs: 1000,
    });

    try {
      const reader = streams.open(AbortSignal.timeout(450))?.getReader();

      if (!reader) {
        throw new Error("Cannot open event stream");
      }

      expect(
        await nextEvent(reader, '"error":"Crew status unavailable."'),
      ).toContain('"available":false');
      f.set("captain", [context("recovered-after-cap")]);
      expect(await nextEvent(reader, '"id":"recovered-after-cap"')).toContain(
        '"available":true',
      );
    } finally {
      streams.stop();
      held.resolve({ members: [], total: 0, truncated: false });
    }
  });

  test("the captain's crew plugin reads a worktree the gateway cannot", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "stargate-api-captain-git-")),
    );

    const home = join(root, "captain-home");
    const worktree = join(home, "worktrees", "pilot");

    try {
      await mkdir(worktree, { recursive: true });

      for (const args of [
        ["init", "-q", "-b", "task/pilot"],
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "first",
        ],
        ["remote", "add", "origin", "https://github.com/example/project.git"],
      ]) {
        expect(
          Bun.spawnSync(["git", ...args], { cwd: worktree }).exitCode,
        ).toBe(0);
      }

      await writeFile(join(worktree, "draft.txt"), "draft\n");

      // The captain owns the worktree and reads it before the home is closed.
      const captainState = await createCrewGitReader(
        liveFleetGit(spawnGit),
        () => 7,
      )(worktree, signal);

      await chmod(home, 0o000);
      const gatewayRead = createGitReader(() => 7);

      // Root ignores permissions; the boundary only exists for other users.
      if (process.getuid?.() !== 0) {
        expect(await gatewayRead(worktree, signal)).toMatchObject({
          branch: null,
          error: "Git state unavailable.",
        });
      }

      const requests: CrewGitInput[] = [];
      const pullRequest = mock(() => null);

      const f = fixture(
        undefined,
        { git: gatewayRead, pullRequest },
        async (input) => {
          requests.push(input);

          return {
            project: { directory: root, git: null },
            contexts: [
              {
                member: "pilot",
                project: null,
                directory: worktree,
                git: captainState,
              },
            ],
          };
        },
      );

      f.set("captain", [context("pilot")]);
      f.useConfig((config) => ({
        ...config,
        api: {
          listen: ":8484",
          pullRequestRepositories: { [worktree]: "example/project" },
        },
      }));

      const detail = await f.source.crew("captain", "pilot", signal);
      expect(requests).toContainEqual({ member: "pilot" });
      expect(detail?.member.contexts[0]?.git).toEqual({
        branch: "task/pilot",
        head: captainState?.commit?.slice(0, 7) ?? "missing",
        base: null,
        ahead: null,
        behind: null,
        changedFiles: 1,
        repository: "example/project",
        checkedAt: 7,
        commit: captainState?.commit ?? "missing",
        worktree,
        dirty: true,
        source: "captain",
        // The crew diff's state, for a crew member's checkout only.
        fingerprint: captainState?.fingerprint ?? "missing",
      });
      expect(captainState?.fingerprint).toMatch(/^[a-f0-9]{32}$/);
      expect(detail?.member.contexts[0]).toMatchObject({
        pullRequest: null,
        pullRequestKnown: true,
      });
      expect(pullRequest).toHaveBeenCalledWith("example/project", "task/pilot");
    } finally {
      await chmod(home, 0o700).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  test("v1 projection preserves a preamble-shaped assignment and serializes the selected view unchanged", async () => {
    const assignment =
      'Configured Stargate project: sample.\nUse only your permanent worktree: "/fixture".\n\nRead the assigned repository';

    const trailer = `Edit\t${privateProject}-pilot-default/notes with Authorization: Bearer fixture-value token=fixture-value`;
    const text = `${"🚀".repeat(450)} ${trailer}`;

    expect(text.length).toBeGreaterThan(400);
    const f = fixture();
    f.set("captain", [
      context("pilot", {
        current: task("task-1", "running", {
          summary: assignment,
          phase: text,
          progress: text,
        }),
      }),
    ]);

    const detail = await f.source.crew("captain", "pilot", signal);
    expect(detail?.member.contexts[0]?.current).toMatchObject({
      summary: assignment,
      phase: text,
      progress: text,
    });
    // Crew detail alone asks the plugin for full task text.
    expect(f.calls.taskText).toEqual(["full"]);

    const boundedTask = {
      summary: assignment,
      phase: Array.from(trailer).slice(0, 80).join(""),
      progress: Array.from(text).slice(-400).join(""),
    };

    // The plugin, not the gateway projection, supplies the bounded fields.
    f.set("captain", [
      context("pilot", { current: task("task-1", "running", boundedTask) }),
    ]);
    const ship = await f.source.ship("captain", signal);
    expect(f.calls.taskText).toEqual(["full", "unredacted"]);
    const current = ship?.crewMembers[0]?.contexts[0]?.current;
    expect(current).toMatchObject(boundedTask);
    expect(current?.progress).toContain(
      "Bearer fixture-value token=fixture-value",
    );
    expect(current?.phase).toContain(`${privateProject}-pilot-default`);

    // The fleet sample, which also feeds each ship's event, asks unredacted.
    let readShip: ((reading: AbortSignal) => Promise<unknown>) | undefined;

    await f.source.fleet(signal, (id, read) => {
      if (id === "captain") {
        readShip = read;
      }
    });
    expect(f.calls.taskText.slice(2)).toEqual(["unredacted"]);
    expect(await readShip?.(signal)).toMatchObject({
      crewMembers: [{ contexts: [{ current: boundedTask }] }],
    });
    expect(
      (await f.dashboard.ship("captain", signal))?.crewMembers?.[0]?.contexts[0]
        ?.current?.summary,
    ).toBe(assignment);
  });

  test("crew diffs go to a captain's backend, never a rear admiral's", async () => {
    const f = fixture();

    const input = {
      member: "pilot",
      project: null,
      mode: "branch" as const,
      request: { kind: "list" as const, start: 0 },
    };

    expect(await f.diffs("captain", input, signal)).toEqual({
      kind: "missing",
    });
    expect(await f.diffs("admiral", input, signal)).toBeUndefined();
    expect(await f.diffs("nobody", input, signal)).toBeUndefined();
    expect(f.calls.diffs).toEqual([{ ship: "captain", member: "pilot" }]);
  });

  test("only a crew checkout's Git state carries the diff fingerprint", () => {
    const state = {
      branch: "feature",
      commit: "a".repeat(40),
      base: null,
      ahead: null,
      behind: null,
      changedFiles: 0,
      remote: null,
      checkedAt: 1,
      fingerprint: "b".repeat(32),
    };

    expect(reportedGit(state, "/fixture")).not.toHaveProperty("fingerprint");
    expect(reportedGit(state, "/fixture", true)).toMatchObject({
      fingerprint: "b".repeat(32),
    });
  });

  test("v1 projection: crew detail returns control and bidi characters in task progress unchanged", async () => {
    // ESC, BEL, a C1 control (CSI) and RIGHT-TO-LEFT OVERRIDE.
    const progress = "Build \u001b[31mred\u001b[0m \u0007 \u009b2J \u202eevil";
    const f = fixture();
    f.set("captain", [
      context("pilot", {
        current: task("task-1", "running", { progress }),
      }),
    ]);

    const detail = await f.source.crew("captain", "pilot", signal);
    expect(detail?.member.contexts[0]?.current?.progress).toBe(progress);
  });

  test("credential-shaped branch and base names from the plugin are reported as written", () => {
    expect(
      reportedGit(
        {
          branch: "fix/token=fixture-value",
          commit: "a".repeat(40),
          base: "origin/sk-fixture",
          ahead: 0,
          behind: 0,
          changedFiles: 0,
          remote: null,
          checkedAt: 1,
        },
        "/fixture",
      ),
    ).toMatchObject({
      branch: "fix/token=fixture-value",
      base: "origin/sk-fixture",
    });
  });

  test("an older captain plugin leaves the gateway reading Git itself", async () => {
    const f = fixture(undefined, undefined, async () => undefined);
    f.set("captain", [context("pilot")]);
    const detail = await f.source.crew("captain", "pilot", signal);

    expect(f.calls.git).toEqual([`${privateProject}-pilot-default`]);
    expect(detail?.member.contexts[0]?.git).toMatchObject({
      branch: "test/change",
      worktree: `${privateProject}-pilot-default`,
      dirty: false,
      source: "gateway",
    });
  });

  test("one failed captain Git request falls back to the gateway for ship detail", async () => {
    const crewGit = mock(async (_input: CrewGitInput, _signal: AbortSignal) => {
      throw new Error("Captain did not answer");
    });

    const f = fixture(undefined, undefined, crewGit);
    f.set("captain", [context("pilot")]);

    const ship = await f.source.ship("captain", signal);

    expect(crewGit.mock.calls).toEqual([[{}, signal]]);
    expect(f.calls.git).toEqual([
      `${privateProject}-pilot-default`,
      privateProject,
    ]);
    expect(ship).toMatchObject({ repository: "example/project" });
    expect(ship?.crewMembers[0]?.contexts[0]?.git).toMatchObject({
      source: "gateway",
    });

    crewGit.mockClear();
    f.calls.git.length = 0;

    const fleet = await f.source.fleet(signal);

    expect(crewGit).toHaveBeenCalledTimes(1);
    expect(crewGit.mock.calls[0]?.[0]).toEqual({ crew: false });
    expect(f.calls.git).toContain(privateProject);
    expect(fleet.ships.find(({ id }) => id === "captain")).toMatchObject({
      repository: "example/project",
    });
  });

  test("a reported context the plugin does not know has no Git state", async () => {
    const f = fixture(undefined, undefined, async () => ({
      project: { directory: "/fixture", git: null },
      contexts: [],
    }));

    f.set("captain", [context("pilot")]);
    const detail = await f.source.crew("captain", "pilot", signal);

    expect(f.calls.git).toEqual([]);
    expect(detail?.member.contexts[0]?.git).toBeNull();
  });

  test("only a configured checkout binding can authorize a PR lookup", async () => {
    const pullRequest = mock(() => null);

    const f = fixture(undefined, {
      git: async (directory): Promise<V1Git | null> =>
        directory
          ? {
              branch: "test/change",
              head: "123abcd",
              base: null,
              ahead: null,
              behind: null,
              changedFiles: 0,
              repository: null,
              pushRepository: "untrusted/private",
              checkedAt: 1,
            }
          : null,
      pullRequest,
    });

    f.set("captain", [context("pilot"), context("pilot", { project: "ops" })]);

    const read = async () =>
      (await f.source.ship("captain", signal))?.crewMembers[0]?.contexts;

    expect((await read())?.[0]).not.toHaveProperty("pullRequestKnown");
    expect(pullRequest).not.toHaveBeenCalled();

    f.useConfig((config) => ({
      ...config,
      api: {
        listen: ":8484",
        pullRequestRepositories: {
          [`${privateProject}-pilot-default`]: "example/approved",
        },
      },
    }));
    const contexts = await read();
    expect(contexts?.[0]).toMatchObject({
      pullRequest: null,
      pullRequestKnown: true,
    });
    expect(contexts?.[1]).not.toHaveProperty("pullRequestKnown");
    expect(pullRequest).toHaveBeenCalledTimes(1);
    expect(pullRequest).toHaveBeenCalledWith("example/approved", "test/change");
  });

  test.each(["while connected", "across reconnects"])(
    "a replacement backend invalidates old crew details %s",
    async (connection) => {
      const f = fixture();
      f.set("captain", [context("old-crew")]);
      const held = Promise.withResolvers<void>();
      const started = Promise.withResolvers<AbortSignal>();

      const streams = fleetEvents(
        {
          ...f.source,
          fleet: (signal, capture) =>
            f.source.fleet(signal, (id, read) =>
              capture?.(id, async (reading) => {
                const detail = await read(reading);

                if (
                  detail?.crewMembers.some(
                    (member) => member.id === "old-pending",
                  )
                ) {
                  started.resolve(reading);
                  await held.promise;
                }

                return detail;
              }),
            ),
        },
        { pollMs: 15, hostMs: 1000, heartbeatMs: 1000, readMs: 1000 },
      );

      try {
        const first = streams.open(AbortSignal.timeout(700))?.getReader();

        if (!first) {
          throw new Error("Cannot open stream");
        }

        await nextEvent(first, '"id":"old-crew"');
        f.set("captain", [context("old-pending")]);
        const reading = await started.promise;

        if (connection === "across reconnects") {
          await first.cancel();
          f.useConfig((config) => ({
            ...config,
            bots: config.bots.map((bot) => ({
              ...bot,
              backend: { ...bot.backend, directory: "/replacement" },
            })),
          }));
        }

        f.replaceBackend("captain");
        f.statuses.set("captain", new Error("Replacement offline"));
        const next = streams.open(AbortSignal.timeout(700))?.getReader();

        if (!next) {
          throw new Error("Cannot reopen stream");
        }

        const unavailable = await nextEvent(
          next,
          'event: ship\ndata: {"id":"captain"',
        );

        expect(reading.aborted).toBe(true);
        expect(unavailable).toContain('"crewMembers":[]');
        expect(unavailable).not.toContain("old-crew");
        held.resolve();
        f.set("captain", [context("new-crew")]);
        const recovered = await nextEvent(next, '"id":"new-crew"');
        expect(recovered).not.toContain("old-pending");
      } finally {
        held.resolve();
        streams.stop();
      }
    },
  );

  test("publishes an initial crew error detail and a single recovery activity", async () => {
    const f = fixture();
    f.statuses.set("captain", new Error("Crew offline"));
    f.queue("captain", { queued: 2 });

    const streams = fleetEvents(f.source, {
      pollMs: 20,
      hostMs: 1000,
      heartbeatMs: 1000,
    });

    try {
      const reader = streams.open(AbortSignal.timeout(700))?.getReader();

      if (!reader) {
        throw new Error("Cannot open event stream");
      }

      const failed = (
        await nextEvent(reader, 'event: ship\ndata: {"id":"captain"')
      )
        .split("\n")
        .find((line) => line.startsWith('data: {"id":"captain"'));

      expect(failed && JSON.parse(failed.slice(6))).toMatchObject({
        available: false,
        error: "Crew status unavailable.",
        captain: { queue: { queued: 2 } },
        crewMembers: [],
      });
      f.set("captain", [context("recovered")]);
      const recovered = await nextEvent(reader, '"id":"recovered"');
      expect(recovered.match(/"kind":"availability"/g)).toHaveLength(1);
    } finally {
      streams.stop();
    }
  });

  test("a stalled crew backend leaves healthy overview and detail updates streaming", async () => {
    const f = fixture({ fleetCrewReadMs: 40, fleetCrewDeadlineMs: 140 });
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

      if (!reader) {
        throw new Error("Cannot open event stream");
      }

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

      if (!(unavailable + stale).includes("healthy-task")) {
        expect(await nextEvent(reader, "healthy-task")).toContain(
          "event: ship",
        );
      }

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

      if (!reader) {
        throw new Error("Cannot open event stream");
      }

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
    // A crew name that differs from its ID keeps the ID and model beside it.
    expect(ship?.crewMembers[0]).toMatchObject({
      id: "pilot",
      name: "Test Pilot",
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
    // An unnamed member is shown by its ID, as before.
    expect(ship?.crewMembers[1]).toMatchObject({
      id: "new",
      name: "new",
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

  test("uses only scoped roots, returns the newest three children and shows task text as written", async () => {
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
          summary: "Check the ops worktree",
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
    // Subagent titles are crew output too, shown as written.
    expect(
      detail?.member.subagents.find((child) => child.id === "second")?.title,
    ).toBe(`Review ${privateProject}-pilot-default with token=fixture-value`);
    expect(f.calls.status.at(-1)).toBe("captain/pilot");
    expect(f.calls.git.sort()).toEqual([
      `${privateProject}-pilot-default`,
      `${privateProject}-pilot-ops`,
    ]);
    expect(
      detail?.member.contexts.map((context) => context.git?.worktree),
    ).toEqual([
      `${privateProject}-pilot-default`,
      `${privateProject}-pilot-ops`,
    ]);
    // Task text keeps checkout paths and credential-shaped text.
    expect(detail?.member.contexts[0]?.current?.summary).toBe(
      "Authorization: Bearer fixture-value",
    );
    expect(detail?.member.contexts[1]?.current).toMatchObject({
      summary: "Check the ops worktree",
      progress: `Working in ${privateProject}-pilot-ops`,
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
