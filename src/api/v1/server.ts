import { timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import type { ApiV1Config } from "./config";
import {
  type ApiV1Diff,
  createEventStreams,
  fleetOverviewReadMs,
} from "./events";
import { cacheOpenCodeVersion, type OpenCodeVersionLookup } from "./gateway";
import { startHostMetrics } from "./host";
import {
  defaultCorsOrigins,
  networkMatcher,
  originMatcher,
  parseApiListen,
  peerAddress,
  privateNetworks,
} from "./network";
import { apiToken } from "./token";
import type { ApiV1Source, V1Fleet, V1Gateway, V1Snapshot } from "./types";

type Options = {
  config: ApiV1Config;
  dataDirectory: string;
  source: ApiV1Source;
  diff: ApiV1Diff;
  gateway: Pick<V1Gateway, "version" | "startedAt"> & {
    opencodeVersion: OpenCodeVersionLookup;
  };
  signal: AbortSignal;
};

const failureWindowMs = 60_000;
const maxFailures = 5;
const maxTrackedAddresses = 4096;

function authentication(token: string) {
  const secret = Buffer.from(token);
  const failures = new Map<string, number>();
  let expiresAt = 0;
  return (address: string, authorization: string | null, headers: Headers) => {
    const value = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(
      authorization ?? "",
    )?.[1];
    if (value && timingSafeEqual(secret, Buffer.from(value))) return 200;
    const now = performance.now();
    if (now >= expiresAt) {
      failures.clear();
      expiresAt = now + failureWindowMs;
    }
    const count = failures.get(address);
    if (
      (count ?? 0) >= maxFailures ||
      (count === undefined && failures.size >= maxTrackedAddresses)
    ) {
      headers.set("Retry-After", String(Math.ceil((expiresAt - now) / 1000)));
      return 429;
    }
    failures.set(address, (count ?? 0) + 1);
    headers.set("WWW-Authenticate", "Bearer");
    return 401;
  };
}

function responseHeaders() {
  return new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
}

function routeId(encoded: string) {
  try {
    const id = decodeURIComponent(encoded);
    return id && !/[/\\\p{Cc}]/u.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

export async function startApiV1Server(options: Options) {
  const { config, dataDirectory, source } = options;
  const listen = parseApiListen(config.listen);
  if (!listen)
    throw new Error(
      "Fleet API requires a private-network bind address and port",
    );
  options.signal.throwIfAborted();
  const allowsPeer = networkMatcher(config.allowedNetworks ?? privateNetworks);
  const allowsOrigin = originMatcher(config.corsOrigins ?? defaultCorsOrigins);
  const authenticate = authentication(await apiToken(dataDirectory));
  options.signal.throwIfAborted();
  const lifetime = new AbortController();
  const lookupVersion = cacheOpenCodeVersion(
    options.gateway.opencodeVersion,
    lifetime.signal,
  );
  const host = startHostMetrics(dataDirectory);
  const fleetName = config.fleetName ?? hostname();
  const readFleet: ApiV1Source["fleet"] = async (signal, captureShipRead) => ({
    ...(await source.fleet(signal, captureShipRead)),
    name: fleetName,
  });
  let lastOpenCodeVersion: string | null = null;
  const fleetWithMetrics = (
    fleet: V1Snapshot["fleet"],
    metrics: V1Fleet["host"],
  ): V1Fleet => ({
    ...fleet,
    host: metrics,
    gateway: {
      version: options.gateway.version,
      startedAt: options.gateway.startedAt,
      bunVersion: Bun.version,
      opencodeVersion: lastOpenCodeVersion,
      features: source.gatewayFeatures(),
    },
  });
  const completeFleet = async (
    fleet: V1Snapshot["fleet"],
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const [metrics] = await Promise.all([
      host.read(),
      lookupVersion().then((version) => {
        lastOpenCodeVersion = version;
      }),
    ]);
    signal.throwIfAborted();
    return fleetWithMetrics(fleet, metrics);
  };
  const events = createEventStreams({
    fleet: readFleet,
    ship: (id, signal) => source.ship(id, signal),
    diff: options.diff,
    completeFleet,
    fallbackFleet: (fleet) => fleetWithMetrics(fleet, host.snapshot()),
    readHost: host.read,
  });

  let server: Bun.Server<undefined>;
  try {
    server = Bun.serve({
      ...listen,
      development: false,
      idleTimeout: 30,
      async fetch(request, server) {
        const headers = responseHeaders();
        const empty = (status: number) =>
          new Response(null, { status, headers });
        const address = peerAddress(server.requestIP(request)?.address);
        if (!address || !allowsPeer(address)) return empty(403);
        const requestedOrigin = request.headers.get("Origin");
        const origin = allowsOrigin(requestedOrigin) ? requestedOrigin : null;
        headers.set("Vary", "Origin");
        if (origin) headers.set("Access-Control-Allow-Origin", origin);
        const method = request.method;
        if (method === "OPTIONS") {
          if (!origin) return empty(403);
          headers.set("Access-Control-Allow-Methods", "GET");
          headers.set(
            "Access-Control-Allow-Headers",
            "Authorization, Last-Event-ID",
          );
          headers.set("Access-Control-Max-Age", "600");
          return empty(204);
        }
        if (method !== "GET" && method !== "HEAD") {
          headers.set("Allow", "GET, HEAD, OPTIONS");
          return empty(405);
        }
        const auth = authenticate(
          address,
          request.headers.get("Authorization"),
          headers,
        );
        if (auth !== 200) return empty(auth);

        const pathname = new URL(request.url).pathname;
        try {
          const signal = AbortSignal.any([request.signal, lifetime.signal]);
          if (pathname === "/api/v1/events") {
            if (method === "HEAD") {
              headers.set("Content-Type", "text/event-stream");
              return empty(200);
            }
            const stream = events.open(signal);
            if (!stream) return empty(503);
            server.timeout(request, 60);
            headers.set("Content-Type", "text/event-stream");
            return new Response(stream, { headers });
          }

          const read = AbortSignal.any([
            signal,
            AbortSignal.timeout(
              pathname === "/api/v1/fleet" ? fleetOverviewReadMs : 20_000,
            ),
          ]);
          let result:
            | V1Fleet
            | Awaited<ReturnType<ApiV1Source["ship"] | ApiV1Source["crew"]>>;
          if (pathname === "/api/v1/fleet") {
            if (method === "HEAD") return empty(200);
            const fleet = await readFleet(read);
            read.throwIfAborted();
            result = await completeFleet(fleet, read);
          } else {
            const match =
              /^\/api\/v1\/ships\/([^/]+)(?:\/crew\/([^/]+))?$/.exec(pathname);
            const id = match?.[1] && routeId(match[1]);
            if (!id) return empty(404);
            if (match?.[2]) {
              const member = routeId(match[2]);
              if (!member) return empty(404);
              result = await source.crew(id, member, read);
            } else {
              result = await source.ship(id, read);
            }
          }
          read.throwIfAborted();
          if (!result) return empty(404);
          return method === "HEAD"
            ? empty(200)
            : Response.json(result, { headers });
        } catch {
          return empty(500);
        }
      },
      error() {
        return new Response(null, { status: 500, headers: responseHeaders() });
      },
    });
  } catch {
    host.stop();
    throw new Error(
      `Cannot start Fleet API listener on ${config.listen}. Check that the private address is assigned and the port is free.`,
    );
  }

  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (stopping) return stopping;
    options.signal.removeEventListener("abort", onAbort);
    lifetime.abort();
    host.stop();
    events.stop();
    stopping = server.stop(true);
    return stopping;
  };
  const onAbort = () => {
    void stop();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) await stop();
  return { url: server.url, stop };
}
