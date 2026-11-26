import { timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { readWithDeadline } from "../../../../lib/read-deadline";
import type { ApiRoute } from "../route";
import type { ActivityApi } from "./activity";
import { type CrewDiffApi, crewDiffRoute } from "./crew-diff";
import { apiRequestMs, maxFleetReads, startApiServer } from "../server";
import type { ApiV1Config } from "./config";
import {
  type ApiV1Diff,
  createEventStreams,
  fleetOverviewReadMs,
} from "./events";
import { type OpenCodeVersionLookup, cacheOpenCodeVersion } from "./gateway";
import { startHostMetrics } from "./host";
import {
  defaultCorsOrigins,
  networkMatcher,
  originMatcher,
  parseApiListen,
  peerAddress,
  privateNetworks,
} from "./network";
import {
  type OfficerSocket,
  OfficerSocketError,
  checkOfficerSocketGroup,
  officerDirectories,
  officerTarget,
  shipRoute,
} from "./officers";
import { apiToken } from "./token";
import {
  type ApiV1Source,
  CrewStatusUnavailable,
  type V1ActivityItemPage,
  type V1AgentActivity,
  type V1Fleet,
  type V1Gateway,
  type V1Snapshot,
} from "./types";

type Options = {
  /** The operator listener, behind the fleet token; absent for officers alone. */
  config?: ApiV1Config | undefined;
  /** Officers' read-only sockets, with no token: see docs/api.md#officers. */
  officers?: readonly OfficerSocket[];
  dataDirectory: string;
  source: ApiV1Source;
  diff: ApiV1Diff;
  gateway: Pick<V1Gateway, "version" | "startedAt"> & {
    opencodeVersion: OpenCodeVersionLookup;
  };
  signal: AbortSignal;
  /**
   * Officer turn activity, for the operator listener only: officers' sockets
   * serve neither the route nor the event. Absent, both answer 404.
   */
  activity?: ActivityApi;
  /**
   * Crew diffs, for the operator listener only, like turn activity. Absent,
   * the diff routes answer 404.
   */
  crewDiff?: CrewDiffApi;
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

    if (value && timingSafeEqual(secret, Buffer.from(value))) {
      return 200;
    }

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
    return;
  }
}

type ApiServer = Awaited<ReturnType<typeof startApiServer>>;

/**
 * An `agent`, `crew` or `turn` parameter subscribes to turn activity and is
 * validated first: a status to answer, or the subscriber's watch. Without
 * any, the stream is unchanged and ignores its query as before.
 */
function activityWatch(
  core: Pick<FleetCore, "activity">,
  query: URLSearchParams,
) {
  if (!query.has("agent") && !query.has("crew") && !query.has("turn")) {
    return;
  }

  const subscription = core.activity?.subscribe(query);

  return subscription?.status === 200
    ? subscription.watch
    : (subscription?.status ?? 404);
}

type DetailRead = (
  signal: AbortSignal,
) => Promise<
  | NonNullable<Awaited<ReturnType<ApiV1Source["ship" | "crew"]>>>
  | V1AgentActivity
  | V1ActivityItemPage
  | number
>;

/**
 * Match a ship, crew or agent activity path before any read slot is taken. An
 * unknown or invalid path answers its status at once; only a matched route
 * starts a read, which is undefined when every read slot is busy.
 */
function readDetail(
  core: Pick<FleetCore, "crew" | "ship" | "activity">,
  url: URL,
  start: (read: DetailRead) => ReturnType<DetailRead> | undefined,
) {
  const agent = /^\/api\/v1\/agents\/([^/]+)\/activity$/.exec(url.pathname);

  const crew = /^\/api\/v1\/ships\/([^/]+)\/crew\/([^/]+)\/activity$/.exec(
    url.pathname,
  );

  if (agent || crew) {
    const id = routeId((agent ?? crew)?.[1] ?? "");
    const member = crew && routeId(crew[2] ?? "");

    const read =
      id === undefined || member === undefined
        ? undefined
        : member === null
          ? core.activity?.read(id, url.searchParams)
          : core.activity?.readCrew?.(id, member, url.searchParams);

    return read?.status === 200
      ? start(() => Promise.resolve(read.body))
      : (read?.status ?? 404);
  }

  const match = shipRoute.exec(url.pathname);
  const id = match?.[1] && routeId(match[1]);
  const member = match?.[2] && routeId(match[2]);

  if (!id || (match?.[2] && !member)) {
    return 404;
  }

  return start(
    async (signal) =>
      (await (member
        ? core.crew(id, member, signal)
        : core.ship(id, signal))) ?? 404,
  );
}

/** What every Fleet API read needs, the same for operators and officers. */
type FleetCore = Pick<ApiV1Source, "crew" | "ship" | "shipIdentities"> & {
  diff: ApiV1Diff;
  activity?: Options["activity"];
  crewDiff?: Options["crewDiff"];
  readFleet: ApiV1Source["fleet"];
  completeFleet: (
    fleet: V1Snapshot["fleet"],
    signal: AbortSignal,
  ) => Promise<V1Fleet>;
  fallbackFleet: (fleet: V1Snapshot["fleet"]) => V1Fleet;
  host: ReturnType<typeof startHostMetrics>;
  lifetime: AbortSignal;
  httpReadMs: number;
  fleetReadMs: number;
};

/**
 * Event streams and HTTP read slots. Operators and officers each get their
 * own, so officers' reads can never use up the slots people's consoles need.
 */
function fleetReaders(core: FleetCore) {
  const events = createEventStreams({
    fleet: core.readFleet,
    ...(core.shipIdentities && { shipIdentities: core.shipIdentities }),
    ship: (id, signal) => core.ship(id, signal),
    diff: core.diff,
    completeFleet: core.completeFleet,
    fallbackFleet: core.fallbackFleet,
    readHost: core.host.read,
    snapshotHost: core.host.snapshot,
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
      if (abandonedReads.size >= maxFleetReads || abandonAt > now) {
        break;
      }

      httpReads.delete(settled);
      abandonedReads.add(settled);
    }

    if (httpReads.size >= maxFleetReads) {
      return;
    }

    const { result, settled } = readWithDeadline(signal, undefined, read);
    httpReads.set(settled, now + 3 * core.httpReadMs);
    void settled.then(() => {
      httpReads.delete(settled);
      abandonedReads.delete(settled);
    });

    return result;
  }

  return { events, startHttpRead };
}

type FleetReaders = ReturnType<typeof fleetReaders>;

/** A Fleet API read, once the caller is admitted; the same for everyone. */
async function answer(
  core: FleetCore,
  { events, startHttpRead }: FleetReaders,
  request: Request,
  headers: Headers,
) {
  const empty = (status: number) => new Response(null, { status, headers });
  const method = request.method;
  const url = new URL(request.url);
  const { pathname } = url;
  const { fleetReadMs } = core;

  try {
    const signal = AbortSignal.any([request.signal, core.lifetime]);

    if (pathname === "/api/v1/events") {
      const watch = activityWatch(core, url.searchParams);

      if (typeof watch === "number") {
        return empty(watch);
      }

      if (method === "HEAD") {
        headers.set("Content-Type", "text/event-stream");

        return empty(200);
      }

      const stream = events.open(signal, watch);

      if (!stream) {
        return empty(503);
      }

      headers.set("Content-Type", "text/event-stream");

      return new Response(stream, { headers });
    }

    // The shared host answers 503 and drops the response when its request
    // Deadline passes, so HTTP reads end a margin earlier: the fleet
    // Fallback, or the route's own error, can still be sent.
    const read = AbortSignal.any([
      signal,
      AbortSignal.timeout(
        pathname === "/api/v1/fleet" ? fleetReadMs : core.httpReadMs,
      ),
    ]);

    if (pathname === "/api/v1/fleet") {
      if (method === "HEAD") {
        return empty(200);
      }

      // Leave room for checkout projection and a response after crew waits.
      const crewDeadline = AbortSignal.timeout(
        fleetReadMs - Math.min(5000, Math.ceil(fleetReadMs / 3)),
      );

      let fleet: V1Snapshot["fleet"] | undefined;

      const overview = startHttpRead(read, async (reading) => {
        const sample = await core.readFleet(reading, undefined, crewDeadline);
        reading.throwIfAborted();
        fleet = sample;

        return core.completeFleet(sample, reading);
      });

      if (!overview) {
        return empty(503);
      }

      const result = await overview.catch((error: unknown) => {
        signal.throwIfAborted();

        if (fleet && read.aborted && error === read.reason) {
          return core.fallbackFleet(fleet);
        }

        throw error;
      });

      signal.throwIfAborted();

      return Response.json(result, { headers });
    }

    const diff = crewDiffRoute.exec(pathname);

    // Crew diffs have their own two slots, never the shared read slots.
    if (diff && core.crewDiff) {
      const ship = routeId(diff[1] ?? "");
      const member = routeId(diff[2] ?? "");

      const result =
        ship && member
          ? await core.crewDiff.read(
              { ship, member, file: diff[3] !== undefined },
              url.searchParams,
              read,
            )
          : 404;

      read.throwIfAborted();

      return typeof result === "number" || method === "HEAD"
        ? empty(typeof result === "number" ? result : 200)
        : Response.json(result, { headers });
    }

    const detail = readDetail(core, url, (run) => startHttpRead(read, run));

    if (typeof detail !== "object") {
      return empty(detail ?? 503);
    }

    const result = await detail.catch((error: unknown) => {
      if (
        error instanceof CrewStatusUnavailable ||
        (!signal.aborted &&
          read.aborted &&
          error === read.reason &&
          shipRoute.test(pathname))
      ) {
        return 503;
      }

      throw error;
    });

    if (typeof result === "number") {
      return empty(result);
    }

    read.throwIfAborted();

    return method === "HEAD" ? empty(200) : Response.json(result, { headers });
  } catch {
    return empty(500);
  }
}

/**
 * An officer or its crew: whoever the officer's directory lets reach the
 * socket. Reads only, exactly normalised Fleet API targets only, no token,
 * no browser origins.
 */
async function officerRequest(
  core: FleetCore,
  readers: FleetReaders,
  request: Request,
  target: string,
) {
  const headers = responseHeaders();

  if (request.method !== "GET" && request.method !== "HEAD") {
    headers.set("Allow", "GET, HEAD");

    return new Response(null, { status: 405, headers });
  }

  const path = officerTarget(target);

  // Crew diffs are the operator's only: refused by route, before any read.
  if (path === undefined || crewDiffRoute.test(path)) {
    return new Response(null, { status: 404, headers });
  }

  // Nor turn activity. The core keeps crew diffs: the route check above is
  // What refuses them, and its test proves it.
  return answer({ ...core, activity: undefined }, readers, request, headers);
}

export async function startApiV1Server(options: Options) {
  const { config, dataDirectory, source } = options;
  const officers = options.officers ?? [];

  const listen =
    config === undefined
      ? undefined
      : config.listen === "unix"
        ? { unix: join(dataDirectory, "api.sock") }
        : parseApiListen(config.listen);

  if (config && !listen) {
    throw new Error(
      "Fleet API requires a private-network bind address and port",
    );
  }

  if (!config && officers.length === 0) {
    throw new Error("Fleet API has no listener");
  }

  options.signal.throwIfAborted();
  // An officer's directory that others or another officer could enter stops
  // Start-up before anything listens.
  const directories = officerDirectories(officers);
  const allowsPeer = networkMatcher(config?.allowedNetworks ?? privateNetworks);
  const allowsOrigin = originMatcher(config?.corsOrigins ?? defaultCorsOrigins);
  const operatorToken = config ? await apiToken(dataDirectory) : undefined;

  const authenticate =
    operatorToken === undefined ? undefined : authentication(operatorToken);

  const routes =
    operatorToken === undefined
      ? []
      : [
          ...(options.routes ?? []),
          ...(options.composeRoutes?.(operatorToken) ?? []),
        ];

  options.signal.throwIfAborted();
  const hostRequestMs = options.timing?.requestMs ?? apiRequestMs;

  const httpReadMs = Math.max(
    1,
    hostRequestMs - Math.min(1000, Math.ceil(hostRequestMs / 10)),
  );

  const lifetime = new AbortController();

  const lookupVersion = cacheOpenCodeVersion(
    options.gateway.opencodeVersion,
    lifetime.signal,
  );

  const host = startHostMetrics(dataDirectory);
  const fleetName = config?.fleetName ?? hostname();
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

  const shipIdentities = source.shipIdentities?.bind(source);

  const core: FleetCore = {
    crew: (id, member, signal) => source.crew(id, member, signal),
    ship: (id, signal) => source.ship(id, signal),
    ...(shipIdentities && { shipIdentities }),
    diff: options.diff,
    ...(options.activity && { activity: options.activity }),
    ...(options.crewDiff && { crewDiff: options.crewDiff }),
    readFleet: async (signal, captureShipRead, crewDeadline) => ({
      ...(await source.fleet(signal, captureShipRead, crewDeadline)),
      name: fleetName,
    }),
    completeFleet: async (fleet, signal) => {
      signal.throwIfAborted();

      const [metrics] = await Promise.all([
        host.read().catch(() => host.snapshot()),
        lookupVersion().then((version) => {
          lastOpenCodeVersion = version;
        }),
      ]);

      signal.throwIfAborted();

      return fleetWithMetrics(fleet, metrics);
    },
    fallbackFleet: (fleet) => fleetWithMetrics(fleet, host.snapshot()),
    host,
    lifetime: lifetime.signal,
    httpReadMs,
    fleetReadMs: Math.min(
      options.fleetReadMs ?? fleetOverviewReadMs,
      httpReadMs,
    ),
  };

  const operatorReaders = fleetReaders(core);
  const officerReaders = fleetReaders(core);

  /** People: a private network peer, browser origin rules and the fleet token. */
  async function operatorRequest(
    request: Request,
    remoteAddress: string | undefined,
  ) {
    const headers = responseHeaders();
    const empty = (status: number) => new Response(null, { status, headers });
    const address = peerAddress(remoteAddress);

    if (config?.listen !== "unix" && (!address || !allowsPeer(address))) {
      return empty(403);
    }

    const requestedOrigin = request.headers.get("Origin");
    const origin = allowsOrigin(requestedOrigin) ? requestedOrigin : null;
    headers.set("Vary", "Origin");

    if (origin) {
      headers.set("Access-Control-Allow-Origin", origin);
    }

    const method = request.method;

    if (method === "OPTIONS") {
      if (!origin) {
        return empty(403);
      }

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

    const auth =
      authenticate?.(
        address ?? "unix",
        request.headers.get("Authorization"),
        headers,
      ) ?? 401;

    if (auth !== 200) {
      return empty(auth);
    }

    return answer(core, operatorReaders, request, headers);
  }

  const servers: ApiServer[] = [];
  let operatorServer: ApiServer | undefined;

  const stopReaders = () => {
    lifetime.abort();
    host.stop();
    operatorReaders.events.stop();
    officerReaders.events.stop();
  };

  try {
    if (listen) {
      operatorServer = await startApiServer({
        listen,
        routes,
        ...(options.timing && { timing: options.timing }),
        signal: AbortSignal.any([lifetime.signal, options.signal]),
        fleet: operatorRequest,
      }).catch(() => {
        throw new Error(
          `Cannot start Fleet API listener on ${config?.listen}. Check that the private address is assigned and the port is free.`,
        );
      });
      servers.push(operatorServer);
    }

    for (const officer of officers) {
      const server = await startApiServer({
        listen: { unix: officer.socketPath, group: true },
        ...(options.timing && { timing: options.timing }),
        signal: AbortSignal.any([lifetime.signal, options.signal]),
        fleet: (request, _address, target) =>
          officerRequest(core, officerReaders, request, target),
      }).catch(() => {
        throw new OfficerSocketError(
          `Cannot open ${officer.officer}'s Fleet API socket. Check its directory, and that no other gateway serves it.`,
        );
      });

      servers.push(server);
      const directory = directories.get(officer.socketPath);

      if (directory) {
        checkOfficerSocketGroup(officer, directory);
      }
    }
  } catch (error) {
    stopReaders();
    await Promise.allSettled(servers.map((server) => server.stop()));
    await source.stop?.();
    throw error;
  }

  let stopping: Promise<void> | undefined;

  const stop = () => {
    if (stopping !== undefined) {
      return stopping;
    }

    options.signal.removeEventListener("abort", onAbort);
    stopReaders();
    stopping = Promise.all([
      ...servers.map((server) => server.stop()),
      source.stop?.(),
    ]).then(() => {});

    return stopping;
  };

  const onAbort = () => {
    void stop().catch(() => {});
  };

  options.signal.addEventListener("abort", onAbort, { once: true });

  if (options.signal.aborted) {
    await stop();
  }

  return {
    /** The operator listener's address; `http://localhost/` for a socket. */
    url: operatorServer?.url ?? new URL("http://localhost/"),
    socketPath: operatorServer?.socketPath,
    officerSockets: officers.map((officer) => officer.socketPath),
    closeAdmission() {
      for (const server of servers) {
        server.closeAdmission();
      }
    },
    stop,
  };
}
