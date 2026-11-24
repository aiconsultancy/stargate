import { expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { lstat, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  setImmediate as nextTurn,
  setTimeout as wait,
} from "node:timers/promises";
import type { ApiV1Config } from "../src/observability/dashboard/api/v1/config";
import { diffEvents } from "../src/observability/dashboard/api/v1/diff";
import {
  type ApiV1Diff,
  createEventStreams,
} from "../src/observability/dashboard/api/v1/events";
import { cacheOpenCodeVersion } from "../src/observability/dashboard/api/v1/gateway";
import { startHostMetrics } from "../src/observability/dashboard/api/v1/host";
import { startApiV1Server } from "../src/observability/dashboard/api/v1/server";
import { apiToken } from "../src/observability/dashboard/api/v1/token";
import type {
  ApiV1Source,
  V1CrewMember,
  V1Event,
  V1Fleet,
  V1Host,
  V1ShipDetail,
} from "../src/observability/dashboard/api/v1/types";
import { openCodeServerVersion } from "../src/backends/factory";
import { OpenCodeBackend } from "../src/backends/opencode/opencode";
import { backendSchema } from "../src/config";
import { decodeSettings } from "../src/config/settings-errors";

const member: V1CrewMember = {
  id: "engineer",
  name: "Engineer",
  role: null,
  model: null,
  backend: "opencode",
  activity: "idle",
  since: null,
  idleSince: null,
  contexts: [],
  subagents: [],
};

const ship: V1ShipDetail = {
  id: "explorer",
  name: "Explorer",
  captain: {
    id: "explorer",
    name: "Explorer",
    role: "captain",
    transport: "slack",
    backend: "opencode",
    model: null,
    queue: { queued: 0, running: 0, responding: 0, done: 0, failed: 0 },
    activity: "idle",
    since: null,
  },
  repository: null,
  available: true,
  crew: { people: 1, busy: 0, queued: 0 },
  features: [],
  crewMembers: [member],
};

const { crewMembers: _crew, ...summary } = ship;

const overview = {
  apiVersion: 1,
  generatedAt: 123_456_789,
  name: "Example",
  admiral: null,
  ships: [summary],
  longestIdle: null,
} as const satisfies Omit<V1Fleet, "host" | "gateway">;

const features = [
  { key: "api", label: "Fleet API", enabled: true, defaultEnabled: false },
];

const source: ApiV1Source = {
  fleet: async () => overview,
  ship: async (id) => (id === ship.id ? ship : undefined),
  crew: async (id, name) =>
    id === ship.id && name === member.id ? { ship: id, member } : undefined,
  gatewayFeatures: () => features,
};

const versionLookup = async () => "2.3.2";

const gateway = {
  version: "1.2.3",
  opencodeVersion: versionLookup,
  startedAt: 123_456_000,
};

function reservePort() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null),
  });
}

async function startFixture(
  options: {
    config?: Partial<ApiV1Config>;
    source?: ApiV1Source;
    diff?: ApiV1Diff;
    fleetReadMs?: number;
    timing?: { headersMs?: number; requestMs?: number };
  } = {},
) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "stargate-api-"));
  const shutdown = new AbortController();
  const reservation = reservePort();
  const listen = `127.0.0.1:${reservation.port}`;
  await reservation.stop(true);

  try {
    const server = await startApiV1Server({
      config: { listen, ...options.config },
      dataDirectory,
      source: options.source ?? source,
      diff: options.diff ?? (() => []),
      gateway,
      ...(options.fleetReadMs !== undefined
        ? { fleetReadMs: options.fleetReadMs }
        : {}),
      ...(options.timing ? { timing: options.timing } : {}),
      signal: shutdown.signal,
    });

    const token = await apiToken(dataDirectory);

    function get(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);

      if (!headers.has("Authorization")) {
        headers.set("Authorization", `Bearer ${token}`);
      }

      return fetch(new URL(path, server.url), { ...init, headers });
    }

    return {
      get,
      url: server.url,
      shutdown,
      dataDirectory,
      stop: server.stop,
      async close() {
        await server.stop();
        await rm(dataDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(dataDirectory, { recursive: true, force: true });
    throw error;
  }
}

test("HTTP fleet returns cached host metrics when enrichment exceeds the request deadline", async () => {
  const server = await startFixture({ fleetReadMs: 150 });
  const held = Promise.withResolvers<never>();
  const entered = Promise.withResolvers<void>();

  try {
    const first = await server.get("/api/v1/fleet");
    expect(first.status).toBe(200);
    const before = (await first.json()) as V1Fleet;

    const stall = spyOn(fs, "statfs").mockImplementation(() => {
      entered.resolve();

      return held.promise;
    });

    try {
      const response = server.get("/api/v1/fleet", {
        signal: AbortSignal.timeout(650),
      });

      await Promise.race([entered.promise, response]);
      expect(stall).toHaveBeenCalled();
      const fallback = await response;
      expect(fallback.status).toBe(200);
      expect((await fallback.json()) as V1Fleet).toMatchObject({
        host: before.host,
      });
    } finally {
      stall.mockRestore();
      held.reject(new Error("Fixture closed"));
      await held.promise.catch(() => {});
    }
  } finally {
    await server.close();
  }
});

test("HTTP fleet fallback answers before the host request deadline with default read settings", async () => {
  // No fleetReadMs: the route must derive its deadline from the host's.
  const server = await startFixture({ timing: { requestMs: 600 } });
  const held = Promise.withResolvers<never>();

  try {
    const first = await server.get("/api/v1/fleet");
    expect(first.status).toBe(200);
    const before = (await first.json()) as V1Fleet;
    const stall = spyOn(fs, "statfs").mockImplementation(() => held.promise);

    try {
      const fallback = await server.get("/api/v1/fleet", {
        signal: AbortSignal.timeout(2000),
      });

      expect(fallback.status).toBe(200);
      expect((await fallback.json()) as V1Fleet).toMatchObject({
        host: before.host,
      });
    } finally {
      stall.mockRestore();
      held.reject(new Error("Fixture closed"));
      await held.promise.catch(() => {});
    }
  } finally {
    await server.close();
  }
});

test("peer allowlist applies before CORS or authentication and ignores forwarded headers", async () => {
  const server = await startFixture({
    config: { allowedNetworks: ["100.64.0.0/10", "::1/128"] },
  });

  try {
    for (const method of ["OPTIONS", "GET", "POST"]) {
      const response = await server.get("/api/v1/fleet", {
        method,
        headers: {
          Origin: "subspace://space",
          "X-Forwarded-For": "100.101.102.103",
          "CF-Connecting-IP": "100.101.102.103",
        },
      });

      expect(response.status).toBe(403);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(await response.text()).toBe("");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  } finally {
    await server.close();
  }
});

test("preflight validates origin without a bearer token and limits methods and headers", async () => {
  const server = await startFixture();

  try {
    const url = new URL("/api/v1/events", server.url);
    const origin = "subspace://space-1";

    const response = await fetch(url, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,last-event-id",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
      "Authorization, Last-Event-ID",
    );
    expect(response.headers.get("Access-Control-Max-Age")).toBe("600");
    expect(response.headers.get("Vary")).toBe("Origin");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toBe("");

    for (const init of [
      {},
      { headers: { Origin: "https://subspace.fake.example" } },
      { headers: { Origin: "https://subspace.com" } },
      { headers: { Origin: "https://subspace.dev" } },
    ]) {
      const denied = await fetch(url, { ...init, method: "OPTIONS" });
      expect(denied.status).toBe(403);
      expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }

    const deniedMethod = await fetch(url, {
      method: "POST",
      headers: { Origin: origin },
    });

    expect(deniedMethod.status).toBe(405);
    expect(deniedMethod.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    expect(deniedMethod.headers.get("Access-Control-Allow-Origin")).toBe(
      origin,
    );
  } finally {
    await server.close();
  }
});

test("an explicit WebView2 Space origin receives CORS headers", async () => {
  const origin = "https://subspace.fleet-console";
  const server = await startFixture({ config: { corsOrigins: [origin] } });

  try {
    const response = await server.get("/api/v1/fleet", {
      headers: { Origin: origin },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
  } finally {
    await server.close();
  }
});

test("host metrics use a label for a data directory on a different filesystem", async () => {
  // /dev is mounted separately on Linux (devtmpfs/tmpfs) and macOS (devfs).
  const metrics = startHostMetrics("/dev/fd");

  try {
    expect(metrics.snapshot().disks).toEqual([]);
    const pending = metrics.read();
    expect(metrics.read()).toBe(pending);
    const sampled = await pending;
    expect(metrics.snapshot()).toBe(sampled);
    expect(sampled.disks.map(({ path }) => path)).toEqual(["/", "data"]);
  } finally {
    metrics.stop();
  }
});

test("bearer authentication challenges and throttles failures without locking out valid tokens", async () => {
  const server = await startFixture();

  try {
    const origin = "subspace://space-1";
    const route = "/api/v1/fleet";
    const url = new URL(route, server.url);
    const missing = await fetch(url, { headers: { Origin: origin } });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(missing.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(missing.headers.get("Content-Type")).toContain("application/json");

    const authorization = `Bearer ${"a".repeat(43)}`;

    for (let index = 0; index < 4; index++) {
      const wrong = await server.get(route, {
        headers: { Authorization: authorization },
      });

      expect(wrong.status).toBe(401);
    }

    const throttled = await server.get(route, {
      headers: { Authorization: authorization },
    });

    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get("Retry-After"))).toBeGreaterThan(0);
    const right = await server.get(route, { headers: { Origin: origin } });
    expect(right.status).toBe(200);
    expect(right.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    const fleet = (await right.json()) as V1Fleet;
    expect(fleet).toMatchObject({
      name: hostname(),
      gateway: {
        version: gateway.version,
        startedAt: gateway.startedAt,
        bunVersion: Bun.version,
        opencodeVersion: "2.3.2",
        features,
      },
      host: {
        hostname: hostname(),
        cpu: { usage: null },
        memory: { totalBytes: expect.any(Number) },
      },
    });
    expect(fleet.host.memory.availableBytes).toBeGreaterThan(0);
    expect(fleet.host.disks[0]?.path).toBe("/");
    expect(fleet.host.disks[0]?.totalBytes).toBeGreaterThan(0);
  } finally {
    await server.close();
  }
});

test("routes return source data, handle encoded IDs and HEAD, and contain source failures", async () => {
  const fakes = {
    ...source,
    ship: async (id: string, signal: AbortSignal) => {
      if (id === "fail") {
        throw new Error("private source error");
      }

      return source.ship(id, signal);
    },
  };

  const server = await startFixture({
    config: {
      fleetName: "Example fleet",
      corsOrigins: ["https://console.example.com"],
    },
    source: fakes,
  });

  try {
    const fleet = await server.get("/api/v1/fleet", {
      headers: { Origin: "https://console.example.com" },
    });

    expect(fleet.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://console.example.com",
    );
    expect(fleet.headers.get("Cache-Control")).toBe("no-store");
    expect((await fleet.json()) as V1Fleet).toMatchObject({
      ...overview,
      name: "Example fleet",
    });

    const detail = await server.get("/api/v1/ships/%65xplorer", {
      headers: { Origin: "subspace://space" },
    });

    expect(detail.status).toBe(200);
    expect(detail.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await detail.json()).toEqual(ship);
    expect(
      await (await server.get("/api/v1/ships/explorer/crew/engineer")).json(),
    ).toEqual({ ship: "explorer", member });
    const head = await server.get("/api/v1/ships/explorer", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    for (const path of [
      "/api/v1/ships/unknown",
      "/api/v1/ships/explorer/crew/unknown",
      "/api/v1/ships/a%2fb",
      "/api/v1/ships/%ff",
      "/api/v1/unknown",
    ]) {
      expect((await server.get(path)).status).toBe(404);
    }

    expect(
      (await server.get("/api/v1/ships/unknown", { method: "HEAD" })).status,
    ).toBe(404);
    const failed = await server.get("/api/v1/ships/fail");
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe("");
    expect((await server.get("/api/v1/ships/explorer")).status).toBe(200);
  } finally {
    await server.close();
  }
});

test("disconnected HTTP clients cancel source reads", async () => {
  const entered = Promise.withResolvers<AbortSignal>();

  const fakes = {
    ...source,
    ship: async (_id: string, signal: AbortSignal) => {
      entered.resolve(signal);
      await wait(3000, undefined, { signal });

      return ship;
    },
  };

  const server = await startFixture({ source: fakes });

  try {
    const client = new AbortController();

    const response = server.get("/api/v1/ships/explorer", {
      signal: client.signal,
    });

    const signal = await entered.promise;
    const aborted = Promise.withResolvers<void>();
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    client.abort();
    await expect(response).rejects.toThrow();
    await aborted.promise;
    expect(signal.aborted).toBe(true);
  } finally {
    await server.close();
  }
});

test("HTTP detail deadlines release the handlers but retain capacity for uncooperative reads", async () => {
  const held = Promise.withResolvers<void>();

  const readingShip = mock(async () => {
    await held.promise;

    return ship;
  });

  const readingCrew = mock(async () => {
    await held.promise;

    return { ship: ship.id, member };
  });

  const server = await startFixture({
    source: { ...source, ship: readingShip, crew: readingCrew },
    timing: { requestMs: 160 },
  });

  const shipPath = "/api/v1/ships/explorer";
  const crewPath = `${shipPath}/crew/engineer`;

  const get = (path: string) =>
    server.get(path, { signal: AbortSignal.timeout(1000) });

  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        get(index % 2 ? crewPath : shipPath),
      ),
    );

    expect(results.map(({ status }) => status)).toEqual(Array(8).fill(500));
    expect((await get(shipPath)).status).toBe(503);
    expect((await get(crewPath)).status).toBe(503);
    expect(readingShip).toHaveBeenCalledTimes(4);
    expect(readingCrew).toHaveBeenCalledTimes(4);
    held.resolve();
    await nextTurn();
    expect((await get(shipPath)).status).toBe(200);
    expect((await get(crewPath)).status).toBe(200);
  } finally {
    held.resolve();
    await server.close();
  }
});

test.each([
  ["overview", ["/api/v1/fleet"]],
  [
    "detail",
    ["/api/v1/ships/explorer", "/api/v1/ships/explorer/crew/engineer"],
  ],
] as const)(
  "HTTP %s reads bound active and abandoned work",
  async (_kind, paths) => {
    const held = Promise.withResolvers<void>();
    const retry = Promise.withResolvers<void>();
    let gate: Promise<void> | undefined = held.promise;
    const reads = mock(async () => gate);

    const read = async <T>(value: T) => {
      await reads();

      return value;
    };

    const server = await startFixture({
      source: {
        ...source,
        fleet: () => read(overview),
        ship: () => read(ship),
        crew: () => read({ ship: ship.id, member }),
      },
      timing: { requestMs: 160 },
      fleetReadMs: 40,
    });

    const clock = spyOn(performance, "now").mockReturnValue(0);

    try {
      const batch = () =>
        Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            server.get(paths.at(index % paths.length) ?? paths[0]),
          ),
        );

      expect((await batch()).map(({ status }) => status)).toEqual(
        Array(8).fill(500),
      );
      // A 160 ms host deadline leaves 144 ms for the HTTP read.
      clock.mockReturnValue(431);
      expect((await server.get(paths[0])).status).toBe(503);
      clock.mockReturnValue(432);
      gate = retry.promise;
      expect((await batch()).map(({ status }) => status)).toEqual(
        Array(8).fill(500),
      );
      gate = undefined;

      for (const now of [864, 1296, 1728]) {
        clock.mockReturnValue(now);
        expect((await server.get(paths[0])).status).toBe(503);
      }

      expect(reads).toHaveBeenCalledTimes(16);
      held.resolve();
      expect((await server.get(paths[0])).status).toBe(200);
    } finally {
      clock.mockRestore();
      held.resolve();
      retry.resolve();
      await server.close();
    }
  },
);

test("bind errors fail startup with Fleet API context", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "stargate-api-bind-"));
  const reservation = reservePort();

  try {
    await expect(
      startApiV1Server({
        config: { listen: `127.0.0.1:${reservation.port}` },
        dataDirectory,
        source,
        diff: () => [],
        gateway,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Cannot start Fleet API listener");
  } finally {
    await reservation.stop(true);
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("Unix Fleet uses the private socket and operator bearer, not TCP peer CIDRs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-api-unix-"));
  let server: Awaited<ReturnType<typeof startApiV1Server>> | undefined;

  try {
    server = await startApiV1Server({
      config: { listen: "unix", allowedNetworks: ["10.0.0.0/8"] },
      dataDirectory: directory,
      source,
      diff: () => [],
      gateway,
      signal: new AbortController().signal,
    });
    const token = await apiToken(directory);
    const socketPath = join(directory, "api.sock");
    expect((await lstat(socketPath)).mode & 0o777).toBe(0o600);

    const get = (authorization?: string) =>
      new Promise<number>((resolve, reject) => {
        const client = request(
          {
            socketPath,
            path: "/api/v1/fleet",
            headers: authorization ? { Authorization: authorization } : {},
          },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );

        client.once("error", reject);
        client.end();
      });

    expect(await get()).toBe(401);
    expect(await get(`Bearer ${token}`)).toBe(200);
  } finally {
    await server?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Fleet abort observes cleanup rejection and retains explicit stop error", async () => {
  const host = await startFixture({ config: { listen: "unix" } });
  const moved = `${host.dataDirectory}.moved`;
  const unhandled: unknown[] = [];

  const onUnhandled = (error: unknown) => {
    unhandled.push(error);
  };

  let directoryMoved = false;
  process.on("unhandledRejection", onUnhandled);

  try {
    await rename(host.dataDirectory, moved);
    directoryMoved = true;
    await writeFile(host.dataDirectory, "owned replacement");
    host.shutdown.abort();
    await nextTurn();
    await nextTurn();
    expect(unhandled).toEqual([]);
    const stopping = host.stop();
    const error: unknown = await stopping.catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: "ENOTDIR",
      path: join(host.dataDirectory, "api.sock"),
    });
    expect(host.stop()).toBe(stopping);
    expect(await host.stop().catch((error: unknown) => error)).toBe(error);
  } finally {
    await host.stop().catch(() => {});
    process.off("unhandledRejection", onUnhandled);

    if (directoryMoved) {
      await rm(host.dataDirectory, { force: true });
      await rename(moved, host.dataDirectory);
    }

    await rm(host.dataDirectory, { recursive: true, force: true });
  }
});

async function nextFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  type: string,
  marker = `event: ${type}\n`,
) {
  const decoder = new TextDecoder();
  let text = "";

  while (!text.includes(marker) || !text.endsWith("\n\n")) {
    const chunk = await reader.read();

    if (chunk.done) {
      throw new Error("Event stream closed before the expected frame");
    }

    text += decoder.decode(chunk.value, { stream: true });
  }

  return text;
}

test("HTTP event streams send initial frames with CORS, cap clients and clean up", async () => {
  const fleet = mock(source.fleet);
  const server = await startFixture({ source: { ...source, fleet } });

  try {
    const route = "/api/v1/events";
    const head = await server.get(route, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe("text/event-stream");
    expect(fleet).toHaveBeenCalledTimes(0);

    const readers = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const response = await server.get(route, {
          headers: { Origin: "subspace://space" },
        });

        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("text/event-stream");
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
          "subspace://space",
        );
        expect(response.headers.get("Cache-Control")).toBe("no-store");

        if (!response.body) {
          throw new Error("Missing event stream");
        }

        return response.body.getReader();
      }),
    );

    const first = readers[0];

    if (!first) {
      throw new Error("Missing first event stream");
    }

    const initial = await nextFrame(first, "ship");
    const [fleetFrame, shipFrame] = initial.split("\n\n");
    expect(fleetFrame?.split("\n")[0]).toBe("event: fleet");
    expect(
      JSON.parse(fleetFrame?.split("\n")[1]?.slice(6) ?? ""),
    ).toMatchObject({
      name: hostname(),
      gateway: { version: "1.2.3" },
    });
    expect(shipFrame?.split("\n")[0]).toBe("event: ship");
    expect(JSON.parse(shipFrame?.split("\n")[1]?.slice(6) ?? "")).toEqual({
      ...ship,
      detailUpdatedAt: expect.any(Number),
    });
    expect(fleet).toHaveBeenCalledTimes(1);
    expect((await server.get(route)).status).toBe(503);

    await Promise.all(readers.map((reader) => reader.cancel()));
    let reconnected: Response | undefined;

    for (let attempt = 0; attempt < 50; attempt++) {
      reconnected = await server.get(route);

      if (reconnected.status !== 503) {
        break;
      }

      await Bun.sleep(10);
    }

    expect(reconnected?.status).toBe(200);
    server.shutdown.abort();
    await reconnected?.body?.cancel().catch(() => {});
  } finally {
    await server.close();
  }
});

const host: V1Host = {
  hostname: "example",
  platform: "linux",
  arch: "arm64",
  uptimeSec: 100,
  cpu: { cores: 4, usage: 0.3, load: [0.1, 0.2, 0.3] },
  memory: { totalBytes: 4096, availableBytes: 1024 },
  disks: [],
  sampledAt: 123_456_789,
};

const activity: V1Event = {
  type: "activity",
  data: {
    ship: "explorer",
    member: "engineer",
    kind: "dispatch",
    text: "Engineer started\nwork",
    at: 123_456_789,
  },
};

function fallbackFleet(fleet: Omit<V1Fleet, "host" | "gateway">): V1Fleet {
  return {
    ...fleet,
    host,
    gateway: {
      version: gateway.version,
      startedAt: gateway.startedAt,
      bunVersion: Bun.version,
      opencodeVersion: null,
      features,
    },
  };
}

async function completeFleet(fleet: Omit<V1Fleet, "host" | "gateway">) {
  return fallbackFleet(fleet);
}

test("host frames use the fresh sample and keep it while the next disk read stalls", async () => {
  const cached = { ...host, sampledAt: host.sampledAt + 100 };
  const held = Promise.withResolvers<V1Host>();
  let latest = host;

  const readHost = mock(async () => {
    if (readHost.mock.calls.length === 1) {
      await Bun.sleep(1);
      latest = cached;

      return latest;
    }

    return held.promise;
  });

  const streams = createEventStreams(
    {
      ...source,
      diff: diffEvents,
      readHost,
      snapshotHost: () => latest,
      completeFleet,
      fallbackFleet,
    },
    { pollMs: 10, hostMs: 15, heartbeatMs: 20 },
  );

  try {
    const reader = streams.open(AbortSignal.timeout(400))?.getReader();

    if (!reader) {
      throw new Error("Cannot open event stream");
    }

    for (let i = 0; i < 3; i++) {
      const frame = await nextFrame(reader, "host");
      expect(frame).toContain(`"sampledAt":${cached.sampledAt}`);
    }

    expect(readHost).toHaveBeenCalledTimes(2);
  } finally {
    streams.stop();
    held.resolve(host);
  }
});

test("host samples stay in the order they were taken when the wall clock steps back", async () => {
  // Real samples from the host sampler, so they carry their sampling order.
  const metrics = startHostMetrics("/dev/fd");
  const clock = spyOn(Date, "now");
  const enrichment = Promise.withResolvers<V1Fleet>();
  let streams: ReturnType<typeof createEventStreams> | undefined;

  try {
    clock.mockReturnValue(2_000_000);
    const older = await metrics.read();
    await Bun.sleep(5);
    clock.mockReturnValue(1_000_000); // The wall clock steps back
    await metrics.read();
    const newer = metrics.snapshot();
    clock.mockRestore(); // The stream itself runs on the real clock
    expect(newer.sampledAt).toBeLessThan(older.sampledAt);
    streams = createEventStreams(
      {
        ...source,
        diff: diffEvents,
        completeFleet: () => enrichment.promise,
        // Like production, the fallback uses the sampler's own latest sample.
        fallbackFleet: (fleet) => ({ ...fallbackFleet(fleet), host: newer }),
        readHost: async () => newer,
        snapshotHost: () => newer,
      },
      { pollMs: 1000, hostMs: 15, heartbeatMs: 1000 },
    );
    const reader = streams.open(AbortSignal.timeout(750))?.getReader();

    if (!reader) {
      throw new Error("Cannot open event stream");
    }

    expect(await nextFrame(reader, "host")).toContain(
      `"sampledAt":${newer.sampledAt}`,
    );
    // Delayed enrichment carries the sample taken first, although its
    // Wall-clock time is later: the stream must keep the newer sample.
    const enriched = fallbackFleet(overview);
    enrichment.resolve({
      ...enriched,
      host: older,
      gateway: { ...enriched.gateway, opencodeVersion: "2.3.2" },
    });
    expect(
      await nextFrame(reader, "fleet", '"opencodeVersion":"2.3.2"'),
    ).toContain(`"sampledAt":${newer.sampledAt}`);
  } finally {
    streams?.stop();
    enrichment.resolve(fallbackFleet(overview));
    clock.mockRestore();
    metrics.stop();
  }
});

test("delayed gateway enrichment keeps the newest host sample in the stream", async () => {
  const latest = { ...host, sampledAt: host.sampledAt + 100 };
  const enrichment = Promise.withResolvers<V1Fleet>();

  const readHost = mock(async () =>
    readHost.mock.calls.length === 2 ? host : latest,
  );

  const streams = createEventStreams(
    {
      ...source,
      diff: diffEvents,
      completeFleet: () => enrichment.promise,
      fallbackFleet,
      readHost,
      snapshotHost: () => host,
    },
    { pollMs: 1000, hostMs: 15, heartbeatMs: 1000 },
  );

  try {
    const reader = streams.open(AbortSignal.timeout(750))?.getReader();

    if (!reader) {
      throw new Error("Cannot open event stream");
    }

    expect(await nextFrame(reader, "host")).toContain(
      `"sampledAt":${latest.sampledAt}`,
    );
    const enriched = fallbackFleet(overview);
    enrichment.resolve({
      ...enriched,
      gateway: { ...enriched.gateway, opencodeVersion: "2.3.2" },
    });

    const fleetFrame = await nextFrame(
      reader,
      "fleet",
      '"opencodeVersion":"2.3.2"',
    );

    expect(fleetFrame).toContain(`"sampledAt":${latest.sampledAt}`);
    expect(await nextFrame(reader, "host")).toContain(
      `"sampledAt":${latest.sampledAt}`,
    );
    expect(readHost.mock.calls.length).toBeGreaterThanOrEqual(3);
  } finally {
    streams.stop();
    enrichment.resolve(fallbackFleet(overview));
  }
});

test.each(["overview", "enrichment", "ship"])(
  "a hung %s read can retry after its hard cap with at most one abandoned read",
  async (kind) => {
    const first = Promise.withResolvers<never>();
    const second = Promise.withResolvers<never>();
    const retried = Promise.withResolvers<void>();
    const recovered = kind === "enrichment" ? "2.3.2" : "Recovered sample";

    const attempt = mock(async <T>(value: T) => {
      if (attempt.mock.calls.length === 1) {
        return first.promise;
      }

      if (attempt.mock.calls.length === 2) {
        retried.resolve();

        return second.promise;
      }

      return value;
    });

    const streams = createEventStreams(
      {
        ...source,
        fleet: async () =>
          kind === "overview"
            ? attempt({ ...overview, name: recovered })
            : overview,
        ship: async () =>
          kind === "ship" ? attempt({ ...ship, name: recovered }) : ship,
        completeFleet: async (fleet) => {
          const next = fallbackFleet(fleet);

          return kind === "enrichment"
            ? attempt({
                ...next,
                gateway: { ...next.gateway, opencodeVersion: recovered },
              })
            : next;
        },
        diff: diffEvents,
        readHost: async () => host,
        snapshotHost: () => host,
        fallbackFleet,
      },
      { pollMs: 10, hostMs: 1000, heartbeatMs: 15, readMs: 25 },
    );

    try {
      const reader = streams.open(AbortSignal.timeout(700))?.getReader();

      if (!reader) {
        throw new Error("Cannot open event stream");
      }

      await Promise.race([
        retried.promise,
        wait(350).then(() => {
          throw new Error("Read slot did not retry");
        }),
      ]);
      await Bun.sleep(110);
      expect(attempt).toHaveBeenCalledTimes(2);
      first.reject(new Error("Abandoned read settled"));
      expect(
        await nextFrame(reader, kind === "ship" ? "ship" : "fleet", recovered),
      ).toContain(recovered);
    } finally {
      streams.stop();
      first.reject(new Error("Fixture closed"));
      second.reject(new Error("Fixture closed"));
      await Promise.allSettled([first.promise, second.promise]);
    }
  },
);

test("an availability transition supersedes an older healthy detail read", async () => {
  const held = Promise.withResolvers<V1ShipDetail>();
  const started = Promise.withResolvers<AbortSignal>();
  const offline = { ...summary, available: false, error: "Crew unavailable." };
  let available = true;

  const streams = createEventStreams(
    {
      ...source,
      fleet: async (_signal, capture) => {
        capture?.(ship.id, async (signal) => {
          if (!available) {
            return { ...offline, crewMembers: [] };
          }

          started.resolve(signal);

          return held.promise;
        });

        return { ...overview, ships: [available ? summary : offline] };
      },
      diff: diffEvents,
      completeFleet,
      fallbackFleet,
      readHost: async () => host,
      snapshotHost: () => host,
    },
    { pollMs: 20, hostMs: 1000, heartbeatMs: 1000, readMs: 500 },
  );

  try {
    const reader = streams.open(AbortSignal.timeout(750))?.getReader();

    if (!reader) {
      throw new Error("Cannot open event stream");
    }

    await nextFrame(reader, "fleet");
    const reading = await started.promise;
    available = false;
    expect(await nextFrame(reader, "fleet")).toContain('"available":false');
    held.resolve({ ...ship, name: "Superseded healthy detail" });
    const detail = await nextFrame(reader, "ship");
    expect(detail).toContain('"available":false');
    expect(reading.aborted).toBe(true);
  } finally {
    held.resolve(ship);
    streams.stop();
  }
});

test("a joining client gets stale retained detail as soon as the captain is unavailable", async () => {
  const held = Promise.withResolvers<V1ShipDetail>();
  const enrichment = Promise.withResolvers<V1Fleet>();
  const started = Promise.withResolvers<void>();
  const offline = { ...summary, available: false, error: "Crew unavailable." };
  const detailUpdatedAt = 123;
  let available = true;

  const streams = createEventStreams(
    {
      ...source,
      fleet: async () => ({
        ...overview,
        ships: [available ? summary : offline],
      }),
      ship: async () => {
        if (available) {
          return { ...ship, detailUpdatedAt };
        }

        started.resolve();

        return held.promise;
      },
      diff: diffEvents,
      completeFleet: (fleet) =>
        available ? completeFleet(fleet) : enrichment.promise,
      fallbackFleet,
      readHost: async () => host,
      snapshotHost: () => host,
    },
    { pollMs: 20, hostMs: 1000, heartbeatMs: 1000, readMs: 1000 },
  );

  const signal = AbortSignal.timeout(600);

  try {
    const reader = streams.open(signal)?.getReader();

    if (!reader) {
      throw new Error("Cannot open event stream");
    }

    await nextFrame(reader, "ship");
    available = false;
    expect(await nextFrame(reader, "fleet")).toContain('"available":false');
    await started.promise;
    const late = streams.open(signal)?.getReader();

    if (!late) {
      throw new Error("Cannot join event stream");
    }

    const snapshot = await nextFrame(late, "ship");
    const [fleetFrame, shipFrame] = snapshot.split("\n\n");
    expect(fleetFrame).toContain('"available":false');
    const detail = JSON.parse(shipFrame?.split("\n")[1]?.slice(6) ?? "");
    expect(detail).toMatchObject({
      available: false,
      error: offline.error,
      detailStale: true,
      detailUpdatedAt,
      crewMembers: ship.crewMembers,
    });
    const enriched = fallbackFleet(overview);
    enrichment.resolve({
      ...enriched,
      gateway: { ...enriched.gateway, opencodeVersion: "2.3.2" },
      host: { ...host, sampledAt: 987_654_321 },
    });
    const updated = await nextFrame(late, "fleet");
    expect(updated).toContain('"opencodeVersion":"2.3.2"');
    expect(updated).toContain('"available":false');
    expect(await nextFrame(late, "host")).toContain('"sampledAt":987654321');
  } finally {
    enrichment.resolve(fallbackFleet(overview));
    held.resolve({ ...offline, crewMembers: [] });
    streams.stop();
  }
});

test("availability recovery waits for fresh detail while an older read drains", async () => {
  const held = Promise.withResolvers<V1ShipDetail>();
  const started = Promise.withResolvers<void>();
  const offline = { ...summary, available: false };
  let available = false;

  const streams = createEventStreams(
    {
      ...source,
      fleet: async () => ({
        ...overview,
        ships: [available ? summary : offline],
      }),
      ship: async () => {
        if (available) {
          return ship;
        }

        started.resolve();

        return held.promise;
      },
      diff: diffEvents,
      completeFleet,
      fallbackFleet,
      readHost: async () => host,
      snapshotHost: () => host,
    },
    { pollMs: 10, hostMs: 1000, heartbeatMs: 30, readMs: 500 },
  );

  try {
    const reader = streams.open(AbortSignal.timeout(500))?.getReader();

    if (!reader) {
      throw new Error("Cannot open event stream");
    }

    expect(await nextFrame(reader, "fleet")).toContain('"available":false');
    await started.promise;
    available = true;
    expect(await nextFrame(reader, "fleet")).toContain('"available":true');
    expect(await nextFrame(reader, "heartbeat")).not.toContain("event: ship");
    held.resolve({ ...offline, crewMembers: [] });
    expect(await nextFrame(reader, "ship")).toContain('"available":true');
  } finally {
    held.resolve(ship);
    streams.stop();
  }
});

test("a replacement backend can publish detail while its predecessor still holds a read slot", async () => {
  const held = Promise.withResolvers<V1ShipDetail>();
  const started = Promise.withResolvers<AbortSignal>();
  let backend = "original";

  const streams = createEventStreams(
    {
      ...source,
      shipIdentities: () => new Map([[ship.id, backend]]),
      ship: async (_id, signal) => {
        if (backend === "replacement") {
          return { ...ship, name: "Replacement" };
        }

        started.resolve(signal);

        return held.promise;
      },
      diff: diffEvents,
      completeFleet,
      fallbackFleet,
      readHost: async () => host,
      snapshotHost: () => host,
    },
    { pollMs: 10, hostMs: 1000, heartbeatMs: 1000, readMs: 500 },
  );

  try {
    const signal = AbortSignal.timeout(500);
    const reader = streams.open(signal)?.getReader();

    if (!reader) {
      throw new Error("Cannot open event stream");
    }

    await nextFrame(reader, "fleet");
    const original = await started.promise;
    backend = "replacement";
    expect((await reader.read()).done).toBe(true);
    const reconnected = streams.open(signal)?.getReader();

    if (!reconnected) {
      throw new Error("Cannot reopen event stream");
    }

    await nextFrame(reconnected, "fleet");
    expect(await nextFrame(reconnected, "ship")).toContain(
      '"name":"Replacement"',
    );
    expect(original.aborted).toBe(true);
  } finally {
    held.resolve(ship);
    streams.stop();
  }
});

test("an identity change replaces an overview that ignores cancellation", async () => {
  const held = Promise.withResolvers<Omit<V1Fleet, "host" | "gateway">>();
  const started = Promise.withResolvers<AbortSignal>();
  let backend = "original";
  let reads = 0;

  const streams = createEventStreams(
    {
      ...source,
      shipIdentities: () => new Map([[ship.id, backend]]),
      fleet: async (signal) => {
        if (++reads === 1) {
          return overview;
        }

        if (backend !== "original") {
          return { ...overview, name: "After reload" };
        }

        started.resolve(signal);

        return held.promise;
      },
      diff: diffEvents,
      completeFleet,
      fallbackFleet,
      readHost: async () => host,
      snapshotHost: () => host,
    },
    { pollMs: 10, hostMs: 1000, heartbeatMs: 1000, readMs: 500 },
  );

  try {
    const reader = streams.open(new AbortController().signal)?.getReader();

    if (!reader) {
      throw new Error("Cannot open event stream");
    }

    await nextFrame(reader, "ship");
    const reading = await started.promise;
    backend = "replacement";
    expect(
      await Promise.race([
        reader.read().then(({ done }) => done),
        wait(150, false),
      ]),
    ).toBe(true);
    expect(reading.aborted).toBe(true);
    const reconnected = streams.open(AbortSignal.timeout(150))?.getReader();

    if (!reconnected) {
      throw new Error("Cannot reopen event stream");
    }

    expect(await nextFrame(reconnected, "fleet")).toContain(
      '"name":"After reload"',
    );
  } finally {
    held.resolve(overview);
    streams.stop();
  }
});

test("a reload discards an in-flight overview even if the original roster returns", async () => {
  const original = new Map([[ship.id, "original"]]);
  const removed = new Map<string, string>();
  const held = Promise.withResolvers<typeof overview>();
  const started = Promise.withResolvers<void>();
  let roster = original;
  let reads = 0;

  const streams = createEventStreams(
    {
      ...source,
      shipIdentities: () => roster,
      fleet: async () => {
        if (++reads === 1) {
          return overview;
        }

        if (reads > 2) {
          return { ...overview, name: "After reload" };
        }

        started.resolve();

        return held.promise;
      },
      diff: diffEvents,
      completeFleet,
      fallbackFleet,
      readHost: async () => host,
      snapshotHost: () => host,
    },
    { pollMs: 10, hostMs: 1000, heartbeatMs: 1000, readMs: 500 },
  );

  const signal = AbortSignal.timeout(750);

  try {
    const reader = streams.open(signal)?.getReader();

    if (!reader) {
      throw new Error("Cannot open event stream");
    }

    await nextFrame(reader, "ship");
    await started.promise;
    roster = removed;
    const reconnected = streams.open(signal)?.getReader();

    if (!reconnected) {
      throw new Error("Cannot reopen event stream");
    }

    roster = original;
    expect(streams.open(signal)).toBeDefined();
    held.resolve(overview);
    expect(await nextFrame(reconnected, "fleet")).toContain(
      '"name":"After reload"',
    );
  } finally {
    held.resolve(overview);
    streams.stop();
  }
});

test("a failed overview is marked stale and expires from connection snapshots", async () => {
  let failing = false;

  const streams = createEventStreams(
    {
      ...source,
      fleet: async () => {
        if (failing) {
          throw new Error("Overview offline");
        }

        return overview;
      },
      diff: diffEvents,
      completeFleet,
      fallbackFleet,
      readHost: async () => host,
      snapshotHost: () => host,
    },
    { pollMs: 15, hostMs: 1000, heartbeatMs: 10, readMs: 60 },
  );

  try {
    const reader = streams.open(AbortSignal.timeout(650))?.getReader();

    if (!reader) {
      throw new Error("Cannot open event stream");
    }

    expect(await nextFrame(reader, "fleet")).not.toContain("overviewStale");
    await nextFrame(reader, "ship");
    failing = true;
    expect(await nextFrame(reader, "fleet")).toContain('"overviewStale":true');

    const closed = async () => {
      while (!(await reader.read()).done) {
        // Drain queued frames before observing the stream close.
      }

      return true;
    };

    expect(
      await Promise.race([closed(), Bun.sleep(350).then(() => false)]),
    ).toBe(true);
    const late = streams.open(AbortSignal.timeout(500))?.getReader();

    if (!late) {
      throw new Error("Cannot reopen event stream");
    }

    const first = await late.read();
    expect(new TextDecoder().decode(first.value)).toStartWith(
      "event: heartbeat",
    );
    failing = false;
    expect(await nextFrame(late, "fleet")).not.toContain("overviewStale");
  } finally {
    streams.stop();
  }
});

test("a slow ship does not delay the overview or other ship details, and retained detail is marked stale", async () => {
  const slow = { ...ship, id: "survey", name: "Survey" };
  const { crewMembers: _crew, ...slowSummary } = slow;
  let fleetName: string = overview.name;
  let surveyed = 0;
  const held = Promise.withResolvers<AbortSignal>();
  const recover = Promise.withResolvers<V1ShipDetail>();
  const timing = { pollMs: 25, hostMs: 1000, heartbeatMs: 1000, readMs: 160 };

  const streams = createEventStreams(
    {
      fleet: async () => ({
        ...overview,
        name: fleetName,
        ships: [summary, slowSummary],
      }),
      ship: async (id, signal) => {
        if (id === ship.id) {
          return { ...ship, name: fleetName };
        }

        if (++surveyed === 2) {
          held.resolve(signal);

          return recover.promise;
        }

        return slow;
      },
      diff: diffEvents,
      completeFleet,
      fallbackFleet,
      readHost: async () => host,
      snapshotHost: () => host,
    },
    timing,
  );

  const shutdown = new AbortController();
  const timeout = setTimeout(() => shutdown.abort(), 650);

  try {
    const reader = streams.open(shutdown.signal)?.getReader();

    if (!reader) {
      throw new Error("Cannot open event stream");
    }

    let initial = await nextFrame(reader, "ship");

    while (
      !initial.includes('event: ship\ndata: {"id":"survey"') ||
      !initial.includes('event: ship\ndata: {"id":"explorer"')
    ) {
      initial += await nextFrame(reader, "ship");
    }

    fleetName = "Updated fleet";
    const signal = await held.promise;
    let update = await nextFrame(reader, "fleet");

    if (!update.includes("event: ship")) {
      update += await nextFrame(reader, "ship");
    }

    expect(update).toContain('"name":"Updated fleet"');
    expect(update).toContain('"id":"explorer"');
    expect(signal.aborted).toBe(false);
    fleetName = "Another fleet update";
    expect(await nextFrame(reader, "fleet")).toContain(
      '"name":"Another fleet update"',
    );
    expect(
      await nextFrame(
        reader,
        "ship",
        '"id":"explorer","name":"Another fleet update"',
      ),
    ).toContain('"id":"explorer","name":"Another fleet update"');
    expect(signal.aborted).toBe(false);
    const stale = await nextFrame(reader, "ship", '"detailStale":true');
    expect(stale).toContain('"id":"survey"');
    expect(stale).toContain('"detailStale":true');
    expect(signal.aborted).toBe(true);

    const freshTimestamp = /"id":"survey".*?"detailUpdatedAt":(\d+)/.exec(
      initial,
    )?.[1];

    expect(freshTimestamp).toBeDefined();
    expect(stale).toContain(`"detailUpdatedAt":${freshTimestamp}`);
    const late = streams.open(shutdown.signal)?.getReader();

    if (!late) {
      throw new Error("Cannot join event stream");
    }

    expect(await nextFrame(late, "ship")).toContain('"detailStale":true');
    await late.cancel();
    await Bun.sleep(timing.pollMs * 3);
    expect(surveyed).toBe(2);
    recover.resolve({ ...slow, name: "Expired result" });
    const fresh = await nextFrame(reader, "ship", '"id":"survey"');
    expect(fresh).toContain('"id":"survey"');
    expect(fresh).not.toContain('"detailStale":true');
    expect(fresh).not.toContain("Expired result");
  } finally {
    recover.resolve(slow);
    clearTimeout(timeout);
    streams.stop();
  }
});

test("unchanged ship details publish each successful sample time", async () => {
  const streams = createEventStreams(
    {
      ...source,
      diff: diffEvents,
      completeFleet,
      fallbackFleet,
      readHost: async () => host,
      snapshotHost: () => host,
    },
    { pollMs: 20, hostMs: 1000, heartbeatMs: 1000 },
  );

  try {
    const reader = streams.open(AbortSignal.timeout(500))?.getReader();

    if (!reader) {
      throw new Error("Cannot open event stream");
    }

    const timestamp = (frame: string) =>
      Number(/"detailUpdatedAt":(\d+)/.exec(frame)?.[1]);

    const first = timestamp(await nextFrame(reader, "ship"));
    const update = await nextFrame(reader, "ship-sampled");
    expect(timestamp(update)).toBeGreaterThan(first);
    expect(update).not.toContain('"crewMembers"');
  } finally {
    streams.stop();
  }
});

test("event poller shares reads, diffs each ship against its prior detail and stops with the last client", async () => {
  const fleet = mock(source.fleet);

  const diff = mock<ApiV1Diff>((previous, next) =>
    previous?.ships[ship.id] && next.ships[ship.id] ? [activity] : [],
  );

  const streams = createEventStreams(
    {
      ...source,
      fleet,
      diff,
      readHost: async () => host,
      snapshotHost: () => host,
      completeFleet,
      fallbackFleet,
    },
    { pollMs: 25, hostMs: 50, heartbeatMs: 65 },
  );

  const signal = new AbortController().signal;

  try {
    expect(fleet).toHaveBeenCalledTimes(0);
    const left = streams.open(signal)?.getReader();
    const right = streams.open(signal)?.getReader();

    if (!left || !right) {
      throw new Error("Cannot open event streams");
    }

    const initial = await nextFrame(left, "ship");
    expect(await nextFrame(right, "ship")).toBe(initial);
    expect(await nextFrame(left, "activity")).toContain(
      `event: activity\ndata: ${JSON.stringify(activity.data)}\n\n`,
    );
    const details = diff.mock.calls.find(([, next]) => next.ships[ship.id]);
    expect(details?.[0]?.ships[ship.id]).toEqual({
      ...ship,
      detailUpdatedAt: expect.any(Number),
    });
    expect(details?.[1].ships[ship.id]).toEqual({
      ...ship,
      detailUpdatedAt: expect.any(Number),
    });
    await left.cancel();
    const timed = await nextFrame(right, "heartbeat");
    expect(timed).toContain(`event: host\ndata: ${JSON.stringify(host)}\n\n`);
    await right.cancel();
    const count = fleet.mock.calls.length;
    await Bun.sleep(75);
    expect(fleet).toHaveBeenCalledTimes(count);
    diff.mockClear();
    const next = streams.open(signal)?.getReader();

    if (!next) {
      throw new Error("Cannot reopen event stream");
    }

    await nextFrame(next, "ship");
    expect(diff).toHaveBeenCalledTimes(0);
    streams.stop();
    expect((await next.read()).done).toBe(true);
  } finally {
    streams.stop();
  }
});

test("stopping event streams aborts the shared snapshot after the last client disconnects", async () => {
  const entered = Promise.withResolvers<AbortSignal>();

  const streams = createEventStreams({
    ...source,
    fleet: async (signal) => {
      entered.resolve(signal);
      await wait(500, undefined, { signal });

      return overview;
    },
    diff: () => [],
    readHost: async () => host,
    snapshotHost: () => host,
    completeFleet,
    fallbackFleet,
  });

  try {
    const stream = streams.open(new AbortController().signal);
    const signal = await entered.promise;
    expect(signal.aborted).toBe(false);
    await stream?.cancel();
    expect(signal.aborted).toBe(false);
    streams.stop();
    expect(signal.aborted).toBe(true);
  } finally {
    streams.stop();
  }
});

test.each(["overview", "ship", "enrichment"] as const)(
  "a reconnect can use a pending %s read from the last poller",
  async (kind) => {
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();

    const read = mock(async <T>(value: T) => {
      if (read.mock.calls.length === 1) {
        entered.resolve();
        await held.promise;
      }

      return value;
    });

    const streams = createEventStreams(
      {
        ...source,
        fleet: async () => (kind === "overview" ? read(overview) : overview),
        ship: async () => (kind === "ship" ? read(ship) : ship),
        completeFleet: async (snapshot) => {
          const next = fallbackFleet(snapshot);

          return kind === "enrichment"
            ? read({
                ...next,
                gateway: { ...next.gateway, opencodeVersion: "2.3.2" },
              })
            : next;
        },
        diff: diffEvents,
        fallbackFleet,
        readHost: async () => host,
        snapshotHost: () => host,
      },
      { pollMs: 250, hostMs: 1000, heartbeatMs: 1000, readMs: 500 },
    );

    const signal = AbortSignal.timeout(175);

    try {
      const first = streams.open(signal);

      if (!first) {
        throw new Error("Cannot open event stream");
      }

      await entered.promise;
      await first.cancel();
      const next = streams.open(signal)?.getReader();

      if (!next) {
        throw new Error("Cannot reopen event stream");
      }

      if (kind !== "overview") {
        await nextFrame(next, "fleet");
      }

      held.resolve();

      if (kind === "ship") {
        expect(await nextFrame(next, "ship")).toContain('"id":"explorer"');
      } else if (kind === "enrichment") {
        expect(
          await nextFrame(next, "fleet", '"opencodeVersion":"2.3.2"'),
        ).toContain('"opencodeVersion":"2.3.2"');
      } else {
        expect(await nextFrame(next, "fleet")).toContain('"name":"Example"');
      }

      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      held.resolve();
      streams.stop();
    }
  },
);

test("timed-out enrichment keeps its slot while current overviews publish across reconnects", async () => {
  const held = Promise.withResolvers<V1Fleet>();
  const started = Promise.withResolvers<void>();
  let name: string = overview.name;

  const read = mock(async (value: typeof overview) => {
    started.resolve();

    if (read.mock.calls.length === 1) {
      return held.promise;
    }

    const next = fallbackFleet(value);

    return {
      ...next,
      gateway: { ...next.gateway, opencodeVersion: "2.3.2" },
    };
  });

  const streams = createEventStreams(
    {
      ...source,
      fleet: async () => ({ ...overview, name }),
      diff: diffEvents,
      readHost: async () => host,
      snapshotHost: () => host,
      completeFleet: read,
      fallbackFleet,
    },
    { pollMs: 10, hostMs: 1000, heartbeatMs: 1000, readMs: 25 },
  );

  try {
    const stream = streams.open(AbortSignal.timeout(500))?.getReader();

    if (!stream) {
      throw new Error("Cannot open event stream");
    }

    await started.promise;
    expect(await nextFrame(stream, "fleet")).toContain(`"name":"${name}"`);
    await nextFrame(stream, "ship");
    expect(read).toHaveBeenCalledTimes(1);
    await stream.cancel();
    name = "Reconnected fleet";
    const reader = streams.open(AbortSignal.timeout(500))?.getReader();

    if (!reader) {
      throw new Error("Cannot reopen event stream");
    }

    expect(await nextFrame(reader, "fleet")).toContain(`"name":"${name}"`);
    name = "Later fleet update";
    expect(await nextFrame(reader, "fleet")).toContain(`"name":"${name}"`);
    expect(read).toHaveBeenCalledTimes(1);
    held.resolve(await completeFleet({ ...overview, name: "Expired" }));
    const fresh = await nextFrame(reader, "fleet", '"opencodeVersion":"2.3.2"');
    expect(fresh).toContain(`"name":"${name}"`);
    expect(read.mock.calls.length).toBeGreaterThan(1);
  } finally {
    held.resolve(await completeFleet(overview));
    streams.stop();
  }
});

test("a hung overview publishes keepalives before its first sample and cached data after a reconnect", async () => {
  const first = Promise.withResolvers<Omit<V1Fleet, "host" | "gateway">>();
  const deadline = Promise.withResolvers<void>();
  const later = Promise.withResolvers<typeof overview>();
  const hung = Promise.withResolvers<void>();

  const fleet = mock(async (signal: AbortSignal) => {
    if (fleet.mock.calls.length === 1) {
      signal.addEventListener("abort", () => deadline.resolve(), {
        once: true,
      });

      return first.promise;
    }

    if (fleet.mock.calls.length === 2) {
      return overview;
    }

    hung.resolve();

    return later.promise;
  });

  const streams = createEventStreams(
    {
      ...source,
      fleet,
      diff: diffEvents,
      completeFleet,
      fallbackFleet,
      readHost: async () => host,
      snapshotHost: () => host,
    },
    { pollMs: 10, hostMs: 1000, heartbeatMs: 15, readMs: 25 },
  );

  try {
    const reader = streams.open(AbortSignal.timeout(500))?.getReader();

    if (!reader) {
      throw new Error("Cannot open event stream");
    }

    expect(await nextFrame(reader, "heartbeat")).not.toContain("event: fleet");
    expect(fleet).toHaveBeenCalledTimes(1);
    await deadline.promise;
    first.resolve({ ...overview, name: "Expired" });
    // The expired first result is suppressed. The following read can publish.
    expect(await nextFrame(reader, "fleet")).toContain(
      `"name":"${overview.name}"`,
    );
    await hung.promise;
    await reader.cancel();
    const next = streams.open(AbortSignal.timeout(500))?.getReader();

    if (!next) {
      throw new Error("Cannot reopen event stream");
    }

    expect(await nextFrame(next, "fleet")).toContain(
      `"name":"${overview.name}"`,
    );
    expect(await nextFrame(next, "ship")).toContain('"id":"explorer"');
    expect(fleet).toHaveBeenCalledTimes(3);
  } finally {
    first.resolve(overview);
    later.resolve(overview);
    streams.stop();
  }
});

test("a reconnect publishes stale detail while an expired read still holds its ship slot", async () => {
  const held = Promise.withResolvers<V1ShipDetail>();
  const entered = Promise.withResolvers<AbortSignal>();

  const read = mock(async (_id: string, signal: AbortSignal) => {
    if (read.mock.calls.length === 2) {
      entered.resolve(signal);

      return held.promise;
    }

    return ship;
  });

  const streams = createEventStreams(
    {
      ...source,
      ship: read,
      diff: diffEvents,
      completeFleet,
      fallbackFleet,
      readHost: async () => host,
      snapshotHost: () => host,
    },
    { pollMs: 15, hostMs: 1000, heartbeatMs: 1000, readMs: 40 },
  );

  try {
    const first = streams.open(AbortSignal.timeout(500))?.getReader();

    if (!first) {
      throw new Error("Cannot open event stream");
    }

    const initial = await nextFrame(first, "ship");
    const signal = await entered.promise;
    await first.cancel();

    if (!signal.aborted) {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    }

    const next = streams.open(AbortSignal.timeout(500))?.getReader();

    if (!next) {
      throw new Error("Cannot reopen event stream");
    }

    const stale = await nextFrame(next, "ship");
    expect(stale).toContain('"detailStale":true');
    const at = /"detailUpdatedAt":\d+/.exec(initial)?.[0];
    expect(at).toBeDefined();
    expect(stale).toContain(at ?? "");
    expect(read).toHaveBeenCalledTimes(2);
    held.resolve({ ...ship, name: "Expired detail" });
    const fresh = await nextFrame(next, "ship");
    expect(fresh).not.toContain("Expired detail");
    expect(fresh).not.toContain('"detailStale":true');
  } finally {
    held.resolve(ship);
    streams.stop();
  }
});

test("the event poller drops a stream whose unread frames fill its buffer", async () => {
  const broadcast = Promise.withResolvers<void>();

  const streams = createEventStreams(
    {
      ...source,
      diff: (previous) => {
        if (!previous) {
          return [];
        }

        broadcast.resolve();

        return Array.from({ length: 2500 }, () => activity);
      },
      readHost: async () => host,
      snapshotHost: () => host,
      completeFleet,
      fallbackFleet,
    },
    { pollMs: 25, hostMs: 1000, heartbeatMs: 1000 },
  );

  try {
    const stream = streams.open(new AbortController().signal);

    if (!stream) {
      throw new Error("Cannot open event stream");
    }

    await broadcast.promise;
    await expect(stream.getReader().read()).rejects.toThrow("backed up");
  } finally {
    streams.stop();
  }
});

test("OpenCode version lookup uses V2 server info and refuses redirects", async () => {
  const requests: string[] = [];
  let redirect = false;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);

      if (redirect) {
        return Response.redirect(new URL("/unexpected", request.url));
      }

      return Response.json({
        version: "2.3.2",
        pid: 1,
        urls: [],
        paths: { tmp: "/" },
      });
    },
  });

  try {
    const config = decodeSettings(backendSchema, {
      type: "opencode",
      url: server.url.href,
      directory: "/",
    });

    if (config.type !== "opencode") {
      throw new Error("Invalid test backend");
    }

    const backend = new OpenCodeBackend(config);

    try {
      const signal = new AbortController().signal;
      expect(await openCodeServerVersion(backend, signal)).toBe("2.3.2");
      redirect = true;

      const cached = cacheOpenCodeVersion(
        (signal) => backend.serverVersion(signal),
        signal,
      );

      expect(await cached()).toBeNull();
      expect(requests).toEqual(["GET /api/info", "GET /api/info"]);
    } finally {
      await backend.close();
    }
  } finally {
    await server.stop(true);
  }
});

test("OpenCode version probes share a cached result and abort at their deadline", async () => {
  const signal = new AbortController().signal;
  const lookup = mock(versionLookup);
  const version = cacheOpenCodeVersion(lookup, signal);
  expect(await Promise.all([version(), version()])).toEqual(["2.3.2", "2.3.2"]);
  expect(lookup).toHaveBeenCalledTimes(1);

  const slow = mock(
    (_signal: AbortSignal) => new Promise<string | null>(() => {}),
  );

  const bounded = cacheOpenCodeVersion(slow, signal);
  expect(await bounded()).toBeNull();
  expect(slow.mock.calls[0]?.[0].aborted).toBe(true);
  expect(await bounded()).toBeNull();
  expect(slow).toHaveBeenCalledTimes(1);
});
