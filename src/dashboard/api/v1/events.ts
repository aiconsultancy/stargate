import { isDeepStrictEqual } from "node:util";
import { createReadSlot, readWithDeadline } from "../../../lib/read-deadline";
import type { V1EventSnapshot } from "./diff";
import { hostSampleOrder } from "./host";
import type {
  ApiV1Source,
  V1Event,
  V1Fleet,
  V1Host,
  V1Ship,
  V1ShipDetail,
  V1ShipRead,
  V1Snapshot,
} from "./types";

export type ApiV1Diff = (
  previous: V1EventSnapshot | undefined,
  next: V1EventSnapshot,
  now: number,
) => V1Event[];

type Options = Pick<ApiV1Source, "fleet" | "ship" | "shipIdentities"> & {
  diff: ApiV1Diff;
  completeFleet(
    fleet: V1Snapshot["fleet"],
    signal: AbortSignal,
  ): Promise<V1Fleet>;
  fallbackFleet(fleet: V1Snapshot["fleet"]): V1Fleet;
  readHost(): Promise<V1Host>;
  snapshotHost(): V1Host;
};

type Client = {
  send(bytes: Uint8Array): void;
  close(error?: Error): void;
};

type ShipReadSlot = {
  slot: ReturnType<typeof createReadSlot<V1ShipDetail | undefined>>;
  attempt?: {
    controller: AbortController;
    available: boolean;
    readAt: number;
    result: Promise<V1ShipDetail | undefined>;
    failed: boolean;
  };
};

const maxClients = 8;
const bufferBytes = 256 * 1024;
const encoder = new TextEncoder();
const streamTiming = { pollMs: 3000, hostMs: 10_000, heartbeatMs: 15_000 };
// Leave time for overview projection after a cold 20-second crew read.
export const fleetOverviewReadMs = 25_000;

function encodeEvents(events: V1Event[]) {
  return encoder.encode(
    events
      .map(
        ({ type, data }) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
      )
      .join(""),
  );
}

function holdRead<T>(readMs: number) {
  const slot = createReadSlot<T>(readMs);
  return (parent: AbortSignal, read: (signal: AbortSignal) => Promise<T>) =>
    (slot.pending ?? slot.start(parent, read)).result;
}

export function createEventStreams(
  options: Options,
  timing: typeof streamTiming & { readMs?: number } = streamTiming,
) {
  const lifetime = new AbortController();
  const readMs = timing.readMs ?? 20_000;
  const overviewReadMs = timing.readMs ?? fleetOverviewReadMs;
  const overviewReads = createReadSlot<{
    generation: number;
    overview: V1Snapshot["fleet"];
    reads: Map<string, V1ShipRead>;
  }>(overviewReadMs);
  const enrich = holdRead<V1Fleet>(readMs);
  const shipReads = new Map<string, ShipReadSlot>();
  const cachedShips = new Map<string, V1ShipDetail>();
  let identities: ReadonlyMap<string, string> | undefined;
  let rosterGeneration = 0;
  let rosterRead = new AbortController();
  let cachedOverview:
    | { overview: V1Snapshot["fleet"]; expiresAt: number }
    | undefined;
  let active: ReturnType<typeof startPolling> | undefined;

  function shipKey(id: string, identity = identities?.get(id)) {
    return JSON.stringify([id, identity]);
  }

  function expireOverview() {
    if (!cachedOverview || cachedOverview.expiresAt > performance.now()) return;
    cachedOverview = undefined;
    if (active) for (const client of active.clients) client.close();
  }

  function startPolling() {
    const shutdown = new AbortController();
    const clients = new Set<Client>();
    const ships = new Map<string, V1ShipDetail>();
    const pending = new Set<string>();
    let summaries = new Map<string, V1Ship>();
    let fleet: V1Fleet | undefined;
    let latestHost: V1Host | undefined;
    let publishing: number | undefined;
    let enriching = false;
    let readingHost = false;

    function broadcast(events: V1Event[]) {
      if (events.length === 0) return;
      const bytes = encodeEvents(events);
      for (const client of clients) client.send(bytes);
    }

    function newestHost(host: V1Host) {
      if (!latestHost) {
        latestHost = host;
        return latestHost;
      }
      // Samples from the host sampler are ordered by when they were taken;
      // `sampledAt` is only a fallback, because a wall-clock step backwards
      // would make every later sample look older.
      const next = hostSampleOrder(host);
      const kept = hostSampleOrder(latestHost);
      const newer =
        next !== undefined && kept !== undefined
          ? next >= kept
          : host.sampledAt >= latestHost.sampledAt;
      if (newer) latestHost = host;
      return latestHost;
    }

    function publishHostSample(host: V1Host) {
      if (newestHost(host) !== host) return;
      if (fleet) fleet = { ...fleet, host };
      broadcast([{ type: "host", data: host }]);
    }

    function syncIdentities() {
      const current = options.shipIdentities?.();
      if (!current || isDeepStrictEqual(current, identities))
        return rosterGeneration;
      for (const [id, identity] of identities ?? []) {
        if (current.get(id) === identity) continue;
        shipReads.get(shipKey(id, identity))?.attempt?.controller.abort();
        cachedShips.delete(id);
      }
      rosterRead.abort();
      overviewReads.abandon();
      rosterRead = new AbortController();
      cachedOverview = undefined;
      if (fleet) for (const client of clients) client.close();
      fleet = undefined;
      ships.clear();
      identities = current;
      return ++rosterGeneration;
    }

    function publishFleet(next: V1Fleet) {
      const previous = fleet;
      next = { ...next, host: newestHost(next.host) };
      fleet = next;
      const prior = summaries;
      summaries = new Map(next.ships.map((ship) => [ship.id, ship]));
      for (const [id, previous] of prior)
        if (summaries.get(id)?.available !== previous.available)
          shipReads.get(shipKey(id))?.attempt?.controller.abort();
      for (const id of ships.keys()) if (!summaries.has(id)) ships.delete(id);
      for (const id of cachedShips.keys())
        if (!summaries.has(id)) cachedShips.delete(id);
      broadcast(
        previous
          ? options.diff(
              { fleet: previous, ships: {} },
              { fleet: next, ships: {} },
              Date.now(),
            )
          : [{ type: "fleet", data: next }],
      );
      for (const { id, available } of next.ships)
        if (
          !available &&
          prior.get(id)?.available !== false &&
          cachedShips.has(id)
        )
          publishShip(id, Date.now());
    }

    function publishShip(id: string, readAt: number, result?: V1ShipDetail) {
      const summary = summaries.get(id);
      if (!fleet || !summary) return;
      const detail =
        !summary.available && result?.available ? undefined : result;
      const previous = ships.get(id);
      const prior = cachedShips.get(id);
      const error = detail?.error ?? summary.error;
      const next: V1ShipDetail = detail?.available
        ? { ...detail, detailUpdatedAt: detail.detailUpdatedAt ?? readAt }
        : prior
          ? {
              ...prior,
              available: summary.available && detail?.available !== false,
              ...(error ? { error } : {}),
              detailStale: true,
            }
          : {
              ...(detail ?? summary),
              available: false,
              error: error ?? "Ship detail unavailable.",
              crewMembers: detail?.crewMembers ?? [],
              detailUpdatedAt:
                detail?.detailUpdatedAt ?? previous?.detailUpdatedAt ?? readAt,
            };
      const changes: V1Event[] = previous
        ? options.diff(
            { fleet, ships: { [id]: previous } },
            { fleet, ships: { [id]: next } },
            Date.now(),
          )
        : [{ type: "ship", data: next }];
      ships.set(id, next);
      if (next.available && !next.detailStale) cachedShips.set(id, next);
      broadcast(changes);
    }

    async function refreshShip({ id, available }: V1Ship, read: V1ShipRead) {
      if (shutdown.signal.aborted || pending.has(id)) return;
      const readAt = Date.now();
      const key = shipKey(id);
      const shared = shipReads.get(key) ?? {
        slot: createReadSlot<V1ShipDetail | undefined>(readMs, () =>
          shipReads.delete(key),
        ),
      };
      let attempt = shared.slot.pending ? shared.attempt : undefined;
      if (attempt && attempt.available !== available)
        attempt.controller.abort();
      if (attempt && (attempt.failed || attempt.controller.signal.aborted)) {
        if (!available || cachedShips.has(id)) publishShip(id, readAt);
        return;
      }
      if (!attempt) {
        const controller = new AbortController();
        const parent = AbortSignal.any([lifetime.signal, controller.signal]);
        const { result } = shared.slot.start(parent, read);
        const current = {
          controller,
          available,
          readAt,
          result,
          failed: false,
        };
        void result.catch(() => {
          current.failed = true;
        });
        attempt = current;
        shared.attempt = attempt;
        shipReads.set(key, shared);
      }
      pending.add(id);
      const cancelled = () =>
        shutdown.signal.aborted || attempt.controller.signal.aborted;
      try {
        const detail = await attempt.result.catch(() => undefined);
        if (cancelled()) return;
        syncIdentities();
        if (!cancelled()) publishShip(id, attempt.readAt, detail);
      } finally {
        pending.delete(id);
      }
    }

    function refreshMetrics(overview: V1Snapshot["fleet"], generation: number) {
      if (enriching) return;
      enriching = true;
      void enrich(lifetime.signal, (signal) =>
        options.completeFleet(overview, signal),
      )
        .then(({ host, gateway }) => {
          if (shutdown.signal.aborted || syncIdentities() !== generation)
            return;
          expireOverview();
          if (!cachedOverview || !fleet) return;
          const next = { ...fleet, host: newestHost(host), gateway };
          const hostChanged = !isDeepStrictEqual(fleet.host, next.host);
          if (isDeepStrictEqual(fleet.gateway, gateway)) fleet = next;
          else publishFleet(next);
          if (hostChanged) publishHostSample(next.host);
        })
        .catch(() => {
          // Keep the cached metrics and retry on a later poll.
        })
        .finally(() => {
          enriching = false;
        });
    }

    async function poll() {
      expireOverview();
      if (shutdown.signal.aborted) return;
      try {
        const generation = syncIdentities();
        if (publishing !== generation && !shutdown.signal.aborted)
          await refreshOverview(generation);
      } catch {
        // Keep the last overview and retry while clients are present.
      }
    }

    async function refreshOverview(generation: number) {
      publishing = generation;
      try {
        const attempt =
          overviewReads.pending ??
          overviewReads.start(
            AbortSignal.any([lifetime.signal, rosterRead.signal]),
            async (signal) => {
              const reads = new Map<string, V1ShipRead>();
              const overview = await options.fleet(signal, (id, read) =>
                reads.set(id, read),
              );
              return { generation, overview, reads };
            },
          );
        const sample = await attempt.result.catch(() => undefined);
        if (
          shutdown.signal.aborted ||
          syncIdentities() !== generation ||
          (sample && sample.generation !== generation)
        )
          return;
        if (sample)
          cachedOverview = {
            overview: sample.overview,
            expiresAt: performance.now() + 3 * overviewReadMs,
          };
        expireOverview();
        if (!cachedOverview) return;
        const overview = sample
          ? sample.overview
          : { ...cachedOverview.overview, overviewStale: true as const };
        const next = options.fallbackFleet(overview);
        publishFleet(next);
        for (const ship of next.ships) {
          if (!sample) {
            publishShip(ship.id, Date.now());
            continue;
          }
          void refreshShip(
            ship,
            sample.reads.get(ship.id) ??
              ((signal) => options.ship(ship.id, signal)),
          ).catch(() => {
            // A later poll can publish this ship if its projection fails.
          });
        }
        refreshMetrics(overview, generation);
      } finally {
        if (publishing === generation) publishing = undefined;
      }
    }

    async function publishHost() {
      if (shutdown.signal.aborted) return;
      if (readingHost) {
        publishHostSample(options.snapshotHost());
        return;
      }
      readingHost = true;
      const { result, settled } = readWithDeadline(shutdown.signal, 1000, () =>
        options.readHost(),
      );
      void settled.then(() => {
        readingHost = false;
      });
      const data = await result.catch(() => options.snapshotHost());
      if (!shutdown.signal.aborted) publishHostSample(data);
    }

    const pollTimer = setInterval(() => void poll(), timing.pollMs);
    const hostTimer = setInterval(() => void publishHost(), timing.hostMs);
    const heartbeatTimer = setInterval(() => {
      broadcast([{ type: "heartbeat", data: { at: Date.now() } }]);
    }, timing.heartbeatMs);

    return {
      clients,
      syncIdentities,
      add(client: Client) {
        clients.add(client);
        if (fleet) {
          client.send(
            encodeEvents([
              { type: "fleet", data: fleet },
              ...Array.from(ships.values(), (data) => ({
                type: "ship" as const,
                data,
              })),
            ]),
          );
        } else void poll();
      },
      stop() {
        shutdown.abort();
        clearInterval(pollTimer);
        clearInterval(hostTimer);
        clearInterval(heartbeatTimer);
      },
    };
  }

  return {
    open(signal: AbortSignal) {
      expireOverview();
      active?.syncIdentities();
      if (
        lifetime.signal.aborted ||
        signal.aborted ||
        (active?.clients.size ?? 0) >= maxClients
      )
        return undefined;
      active ??= startPolling();
      const session = active;
      let cleanup = () => {};
      return new ReadableStream<Uint8Array>(
        {
          start(controller) {
            const aborted = () => client.close();
            cleanup = () => {
              if (!session.clients.delete(client)) return;
              signal.removeEventListener("abort", aborted);
              if (!session.clients.size) {
                active = undefined;
                session.stop();
              }
            };
            const client: Client = {
              send(bytes) {
                const available = controller.desiredSize;
                // An empty queue can carry one full snapshot, even for a large fleet.
                if (
                  available !== null &&
                  (available === bufferBytes || bytes.length <= available)
                )
                  controller.enqueue(bytes);
                else
                  client.close(new Error("Fleet API event stream backed up"));
              },
              close(error) {
                if (!session.clients.has(client)) return;
                cleanup();
                if (error) controller.error(error);
                else controller.close();
              },
            };
            signal.addEventListener("abort", aborted, { once: true });
            session.add(client);
          },
          cancel: () => cleanup(),
        },
        new ByteLengthQueuingStrategy({ highWaterMark: bufferBytes }),
      );
    },
    stop() {
      lifetime.abort();
      if (active) for (const client of active.clients) client.close();
    },
  };
}
