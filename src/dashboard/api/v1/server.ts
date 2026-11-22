import { timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { readWithDeadline } from "../../../lib/read-deadline";
import type { ApiRoute } from "../route";
import { apiRequestMs, maxFleetReads, startApiServer } from "../server";
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
  fleetReadMs?: number;
  routes?: readonly ApiRoute[];
  /** Compose trusted producer policies against the exact loaded operator token. */
  composeRoutes?: (operatorToken: string) => readonly ApiRoute[];
  timing?: { headersMs?: number; requestMs?: number };
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

  const listen =
    config.listen === "unix"
      ? { unix: join(dataDirectory, "api.sock") }
      : parseApiListen(config.listen);

  if (!listen)
    throw new Error(
      "Fleet API requires a private-network bind address and port",
    );
  options.signal.throwIfAborted();
  const allowsPeer = networkMatcher(config.allowedNetworks ?? privateNetworks);
  const allowsOrigin = originMatcher(config.corsOrigins ?? defaultCorsOrigins);
  const operatorToken = await apiToken(dataDirectory);
  const authenticate = authentication(operatorToken);

  const routes = [
    ...(options.routes ?? []),
    ...(options.composeRoutes?.(operatorToken) ?? []),
  ];

  options.signal.throwIfAborted();
  const hostRequestMs = options.timing?.requestMs ?? apiRequestMs;

  const httpReadMs = Math.max(
    1,
    hostRequestMs - Math.min(1000, Math.ceil(hostRequestMs / 10)),
  );

  const fleetReadMs = Math.min(
    options.fleetReadMs ?? fleetOverviewReadMs,
    httpReadMs,
  );

  const lifetime = new AbortController();

  const lookupVersion = cacheOpenCodeVersion(
    options.gateway.opencodeVersion,
    lifetime.signal,
  );

  const host = startHostMetrics(dataDirectory);
  const fleetName = config.fleetName ?? hostname();

  const readFleet: ApiV1Source["fleet"] = async (
    signal,
    captureShipRead,
    crewDeadline,
  ) => ({
    ...(await source.fleet(signal, captureShipRead, crewDeadline)),
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
      host.read().catch(() => host.snapshot()),
      lookupVersion().then((version) => {
        lastOpenCodeVersion = version;
      }),
    ]);

    signal.throwIfAborted();

    return fleetWithMetrics(fleet, metrics);
  };

  const fallbackFleet = (fleet: V1Snapshot["fleet"]) =>
    fleetWithMetrics(fleet, host.snapshot());

  const shipIdentities = source.shipIdentities?.bind(source);

  const events = createEventStreams({
    fleet: readFleet,
    ...(shipIdentities && { shipIdentities }),
    ship: (id, signal) => source.ship(id, signal),
    diff: options.diff,
    completeFleet,
    fallbackFleet,
    readHost: host.read,
    snapshotHost: host.snapshot,
  });

  const httpReads = new Map<Promise<void>, number>();
  const abandonedReads = new Set<Promise<void>>();

  function startHttpRead<T>(
    signal: AbortSignal,
    read: (signal: AbortSignal) => Promise<T>,
  ) {
    const now = performance.now();

    // Reserve a bounded number of retries while stuck reads drain.
    for (const [settled, abandonAt] of httpReads) {
      if (abandonedReads.size >= maxFleetReads || abandonAt > now) break;
      httpReads.delete(settled);
      abandonedReads.add(settled);
    }

    if (httpReads.size >= maxFleetReads) return undefined;
    const { result, settled } = readWithDeadline(signal, undefined, read);
    httpReads.set(settled, now + 3 * httpReadMs);
    void settled.then(() => {
      httpReads.delete(settled);
      abandonedReads.delete(settled);
    });

    return result;
  }

  let server: Awaited<ReturnType<typeof startApiServer>>;

  try {
    server = await startApiServer({
      listen,
      routes,
      ...(options.timing ? { timing: options.timing } : {}),
      signal: AbortSignal.any([lifetime.signal, options.signal]),
      async fleet(request, remoteAddress) {
        const headers = responseHeaders();

        const empty = (status: number) =>
          new Response(null, { status, headers });

        const address = peerAddress(remoteAddress);

        if (config.listen !== "unix" && (!address || !allowsPeer(address)))
          return empty(403);
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
          address ?? "unix",
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
            headers.set("Content-Type", "text/event-stream");

            return new Response(stream, { headers });
          }

          // The shared host answers 503 and drops the response when its request
          // Deadline passes, so HTTP reads end a margin earlier: the fleet
          // Fallback, or the route's own error, can still be sent.
          const read = AbortSignal.any([
            signal,
            AbortSignal.timeout(
              pathname === "/api/v1/fleet" ? fleetReadMs : httpReadMs,
            ),
          ]);

          if (pathname === "/api/v1/fleet") {
            if (method === "HEAD") return empty(200);

            // Leave room for checkout projection and a response after crew waits.
            const crewDeadline = AbortSignal.timeout(
              fleetReadMs - Math.min(5000, Math.ceil(fleetReadMs / 3)),
            );

            let fleet: V1Snapshot["fleet"] | undefined;

            const overview = startHttpRead(read, async (reading) => {
              const sample = await readFleet(reading, undefined, crewDeadline);
              reading.throwIfAborted();
              fleet = sample;

              return completeFleet(sample, reading);
            });

            if (!overview) return empty(503);

            const result = await overview.catch((error: unknown) => {
              signal.throwIfAborted();

              if (fleet && read.aborted && error === read.reason)
                return fallbackFleet(fleet);
              throw error;
            });

            signal.throwIfAborted();

            return Response.json(result, { headers });
          }

          const match = /^\/api\/v1\/ships\/([^/]+)(?:\/crew\/([^/]+))?$/.exec(
            pathname,
          );

          const id = match?.[1] && routeId(match[1]);

          if (!id) return empty(404);
          const member = match?.[2] && routeId(match[2]);

          if (match?.[2] && !member) return empty(404);

          const detail = startHttpRead(read, async (reading) =>
            member
              ? source.crew(id, member, reading)
              : source.ship(id, reading),
          );

          if (!detail) return empty(503);
          const result = await detail;
          read.throwIfAborted();

          if (!result) return empty(404);

          return method === "HEAD"
            ? empty(200)
            : Response.json(result, { headers });
        } catch {
          return empty(500);
        }
      },
    });
  } catch {
    lifetime.abort();
    host.stop();
    events.stop();
    await source.stop?.();
    throw new Error(
      `Cannot start Fleet API listener on ${config.listen}. Check that the private address is assigned and the port is free.`,
    );
  }

  let stopping: Promise<void> | undefined;

  const stop = () => {
    if (stopping !== undefined) return stopping;
    options.signal.removeEventListener("abort", onAbort);
    lifetime.abort();
    host.stop();
    events.stop();
    stopping = Promise.all([server.stop(), source.stop?.()]).then(
      () => undefined,
    );

    return stopping;
  };

  const onAbort = () => {
    void stop().catch(() => {});
  };

  options.signal.addEventListener("abort", onAbort, { once: true });

  if (options.signal.aborted) await stop();

  return {
    url: server.url,
    socketPath: server.socketPath,
    closeAdmission: server.closeAdmission,
    stop,
  };
}
