import { expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type { ApiV1Config } from "../src/api/v1/config";
import { type ApiV1Diff, createEventStreams } from "../src/api/v1/events";
import { cacheOpenCodeVersion } from "../src/api/v1/gateway";
import { startApiV1Server } from "../src/api/v1/server";
import { apiToken } from "../src/api/v1/token";
import type {
  ApiV1Source,
  V1CrewMember,
  V1Event,
  V1Fleet,
  V1Host,
  V1ShipDetail,
} from "../src/api/v1/types";
import { OpenCodeBackend } from "../src/backends/opencode";
import { backendSchema } from "../src/config";
import { decodeSettings } from "../src/settings-errors";

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
  generatedAt: 123456789,
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
  startedAt: 123456000,
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
      signal: shutdown.signal,
    });
    const token = await apiToken(dataDirectory);
    function get(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      if (!headers.has("Authorization"))
        headers.set("Authorization", `Bearer ${token}`);
      return fetch(new URL(path, server.url), { ...init, headers });
    }
    return {
      get,
      url: server.url,
      shutdown,
      dataDirectory,
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
    const origin = "https://subspace.abcdef";
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
      if (id === "fail") throw new Error("private source error");
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

async function nextFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  type: string,
) {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(`event: ${type}\n`) || !text.endsWith("\n\n")) {
    const chunk = await reader.read();
    if (chunk.done)
      throw new Error("Event stream closed before the expected frame");
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
        if (!response.body) throw new Error("Missing event stream");
        return response.body.getReader();
      }),
    );
    const first = readers[0];
    if (!first) throw new Error("Missing first event stream");
    const initial = await nextFrame(first, "ship");
    const [fleetFrame, shipFrame] = initial.split("\n\n");
    expect(fleetFrame?.split("\n")[0]).toBe("event: fleet");
    expect(
      JSON.parse(fleetFrame?.split("\n")[1]?.slice(6) ?? ""),
    ).toMatchObject({
      name: hostname(),
      gateway: { version: "1.2.3" },
    });
    expect(shipFrame).toBe(`event: ship\ndata: ${JSON.stringify(ship)}`);
    expect(fleet).toHaveBeenCalledTimes(1);
    expect((await server.get(route)).status).toBe(503);

    await Promise.all(readers.map((reader) => reader.cancel()));
    let reconnected: Response | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      reconnected = await server.get(route);
      if (reconnected.status !== 503) break;
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
  sampledAt: 123456789,
};
const activity: V1Event = {
  type: "activity",
  data: {
    ship: "explorer",
    member: "engineer",
    kind: "dispatch",
    text: "Engineer started\nwork",
    at: 123456789,
  },
};

function completeFleet(
  fleet: Omit<V1Fleet, "host" | "gateway">,
): Promise<V1Fleet> {
  return Promise.resolve({
    ...fleet,
    host,
    gateway: {
      version: gateway.version,
      startedAt: gateway.startedAt,
      bunVersion: Bun.version,
      opencodeVersion: null,
      features,
    },
  });
}

test("event poller is shared, diffs sequential snapshots, emits timers and stops with the last client", async () => {
  const fleet = mock(source.fleet);
  const diff = mock<ApiV1Diff>((previous) => (previous ? [activity] : []));
  const streams = createEventStreams(
    {
      ...source,
      fleet,
      diff,
      readHost: async () => host,
      completeFleet,
    },
    { pollMs: 25, hostMs: 50, heartbeatMs: 65 },
  );
  const signal = new AbortController().signal;
  try {
    expect(fleet).toHaveBeenCalledTimes(0);
    const left = streams.open(signal)?.getReader();
    const right = streams.open(signal)?.getReader();
    if (!left || !right) throw new Error("Cannot open event streams");
    const initial = await nextFrame(left, "ship");
    expect(await nextFrame(right, "ship")).toBe(initial);
    expect(diff.mock.calls[0]?.[0]).toBeUndefined();
    expect(diff.mock.calls[0]?.[1].ships[ship.id]).toEqual(ship);
    expect(await nextFrame(left, "activity")).toContain(
      `event: activity\ndata: ${JSON.stringify(activity.data)}\n\n`,
    );
    expect(diff.mock.calls[1]?.[0]).toBe(diff.mock.calls[0]?.[1]);
    await left.cancel();
    const timed = await nextFrame(right, "heartbeat");
    expect(timed).toContain(`event: host\ndata: ${JSON.stringify(host)}\n\n`);
    await right.cancel();
    const count = fleet.mock.calls.length;
    await Bun.sleep(75);
    expect(fleet).toHaveBeenCalledTimes(count);
    const next = streams.open(signal)?.getReader();
    if (!next) throw new Error("Cannot reopen event stream");
    await nextFrame(next, "ship");
    expect(diff.mock.calls.at(-1)?.[0]).toBeUndefined();
    streams.stop();
    expect((await next.read()).done).toBe(true);
  } finally {
    streams.stop();
  }
});

test("event poller aborts the in-flight snapshot when its last client disconnects", async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const streams = createEventStreams({
    ...source,
    fleet: async (signal) => {
      entered.resolve(signal);
      await wait(3000, undefined, { signal });
      return overview;
    },
    diff: () => [],
    readHost: async () => host,
    completeFleet,
  });
  try {
    const stream = streams.open(new AbortController().signal);
    const signal = await entered.promise;
    expect(signal.aborted).toBe(false);
    await stream?.cancel();
    expect(signal.aborted).toBe(true);
  } finally {
    streams.stop();
  }
});

test("the event poller drops a stream whose unread frames fill its buffer", async () => {
  const broadcast = Promise.withResolvers<void>();
  const streams = createEventStreams(
    {
      ...source,
      diff: (previous) => {
        if (!previous) return [];
        broadcast.resolve();
        return Array.from({ length: 2500 }, () => activity);
      },
      readHost: async () => host,
      completeFleet,
    },
    { pollMs: 25, hostMs: 1000, heartbeatMs: 1000 },
  );
  try {
    const stream = streams.open(new AbortController().signal);
    if (!stream) throw new Error("Cannot open event stream");
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
      if (redirect)
        return Response.redirect(new URL("/unexpected", request.url));
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
    if (config.type !== "opencode") throw new Error("Invalid test backend");
    const backend = new OpenCodeBackend(config);
    try {
      const signal = new AbortController().signal;
      expect(await backend.serverVersion(signal)).toBe("2.3.2");
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
