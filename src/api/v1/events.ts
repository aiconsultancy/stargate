import { isDeepStrictEqual } from "node:util";
import { createReadSlot, readWithDeadline } from "../../read-deadline";
import type { V1EventSnapshot } from "./diff";
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
  const readMs = timing.readMs ?? 20_000;
  const overviewReadMs = timing.readMs ?? fleetOverviewReadMs;
  const readOverview = holdRead<{
    generation: number;
    overview: V1Snapshot["fleet"];
    reads: Map<string, V1ShipRead>;
  }>(overviewReadMs);
  const enrich = holdRead<V1Fleet>(readMs);
  const shipReads = new Map<
    string,
    ReturnType<typeof createReadSlot<V1ShipDetail | undefined>>
  >();
  const cachedShips = new Map<string, V1ShipDetail>();
  let identities: ReadonlyMap<string, string> | undefined;
  let rosterGeneration = 0;
  let cachedOverview:
    | { overview: V1Snapshot["fleet"]; expiresAt: number }
    | undefined;
  let active: ReturnType<typeof startPolling> | undefined;

  function expireOverview() {
    if (!cachedOverview || cachedOverview.expiresAt > performance.now()) return;
    cachedOverview = undefined;
    if (active) for (const client of active.clients) client.close();
  }

  function startPolling() {
    const shutdown = new AbortController();
    const clients = new Set<Client>();
    const ships = new Map<string, V1ShipDetail>();
    const pending = new Map<string, AbortController>();
    let summaries = new Map<string, V1Ship>();
    let fleet: V1Fleet | undefined;
    let latestHost: V1Host | undefined;
    let publishing = false;
    let enriching = false;
    let readingHost = false;

    function broadcast(events: V1Event[]) {
      if (events.length === 0) return;
      const bytes = encodeEvents(events);
      for (const client of clients) client.send(bytes);
    }

    function newestHost(host: V1Host) {
      if (!latestHost || host.sampledAt >= latestHost.sampledAt)
        latestHost = host;
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
        pending.get(id)?.abort();
        cachedShips.delete(id);
      }
      cachedOverview = undefined;
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
      for (const [id, generation] of pending)
        if (summaries.get(id)?.available !== prior.get(id)?.available)
          generation.abort();
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

    async function refreshShip(id: string, read: V1ShipRead) {
      if (shutdown.signal.aborted) return;
      const readAt = Date.now();
      const key = JSON.stringify([id, identities?.get(id)]);
      const slot =
        shipReads.get(key) ??
        createReadSlot<V1ShipDetail | undefined>(readMs, () =>
          shipReads.delete(key),
        );
      if (slot.pending) {
        const own = pending.get(id);
        // A prior stream or overview generation already cancelled this wait.
        if (
          (!own || own.signal.aborted) &&
          (!summaries.get(id)?.available || cachedShips.has(id))
        )
          publishShip(id, readAt);
        return;
      }
      shipReads.set(key, slot);
      // This wait belongs to the current ship availability and identity.
      // Publishing a transition cancels that generation even if the read drains later.
      const generation = new AbortController();
      pending.set(id, generation);
      const parent = AbortSignal.any([shutdown.signal, generation.signal]);
      const { result } = slot.start(parent, read);
      try {
        const detail = await result.catch(() => undefined);
        if (parent.aborted) return;
        syncIdentities();
        if (!parent.aborted) publishShip(id, readAt, detail);
      } finally {
        if (pending.get(id) === generation) pending.delete(id);
      }
    }

    function refreshMetrics(overview: V1Snapshot["fleet"], generation: number) {
      if (enriching) return;
      enriching = true;
      void enrich(shutdown.signal, (signal) =>
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
      if (publishing || shutdown.signal.aborted) return;
      publishing = true;
      try {
        const generation = syncIdentities();
        const sample = await readOverview(shutdown.signal, async (signal) => {
          const reads = new Map<string, V1ShipRead>();
          const overview = await options.fleet(signal, (id, read) =>
            reads.set(id, read),
          );
          return { generation, overview, reads };
        }).catch(() => undefined);
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
            ship.id,
            sample.reads.get(ship.id) ??
              ((signal) => options.ship(ship.id, signal)),
          ).catch(() => {
            // A later poll can publish this ship if its projection fails.
          });
        }
        refreshMetrics(overview, generation);
      } catch {
        // Keep the last overview and retry while clients are present.
      } finally {
        publishing = false;
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
      add(client: Client) {
        clients.add(client);
        syncIdentities();
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
      if (signal.aborted || (active?.clients.size ?? 0) >= maxClients)
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
      if (active) for (const client of active.clients) client.close();
    },
  };
}
