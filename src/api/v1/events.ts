import { readWithDeadline } from "../../read-deadline";
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
  previous: V1Snapshot | undefined,
  next: V1Snapshot & { fleet: V1Fleet },
  now: number,
) => V1Event[];

type Options = Pick<ApiV1Source, "fleet" | "ship"> & {
  diff: ApiV1Diff;
  completeFleet(
    fleet: V1Snapshot["fleet"],
    signal: AbortSignal,
  ): Promise<V1Fleet>;
  fallbackFleet(fleet: V1Snapshot["fleet"]): V1Fleet;
  readHost(): Promise<V1Host>;
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
  let pending: ReturnType<typeof readWithDeadline<T>> | undefined;
  return (parent: AbortSignal, read: (signal: AbortSignal) => Promise<T>) => {
    if (!pending) {
      pending = readWithDeadline(parent, readMs, read);
      void pending.settled.then(() => {
        pending = undefined;
      });
    }
    return pending.result;
  };
}

export function createEventStreams(
  options: Options,
  timing: typeof streamTiming & { readMs?: number } = streamTiming,
) {
  const readMs = timing.readMs ?? 20_000;
  const readOverview = holdRead<{
    overview: V1Snapshot["fleet"];
    reads: Map<string, V1ShipRead>;
  }>(timing.readMs ?? fleetOverviewReadMs);
  const enrich = holdRead<V1Fleet>(readMs);
  const pendingShips = new Set<string>();
  const cachedShips = new Map<string, V1ShipDetail>();
  let cachedOverview: V1Snapshot["fleet"] | undefined;
  let active: ReturnType<typeof startPolling> | undefined;

  function startPolling() {
    const shutdown = new AbortController();
    const clients = new Set<Client>();
    const ships = new Map<string, V1ShipDetail>();
    const pending = new Map<string, AbortController>();
    let fleet: V1Fleet | undefined;
    let overviewExpired = false;
    let publishing = false;
    let readingHost = false;

    function broadcast(events: V1Event[]) {
      if ((!fleet && !overviewExpired) || events.length === 0) return;
      const bytes = encodeEvents(events);
      for (const client of clients) client.send(bytes);
    }

    function publishFleet(next: V1Fleet) {
      const previous = fleet;
      fleet = next;
      const ids = new Set(next.ships.map(({ id }) => id));
      for (const [id, attempt] of pending) if (!ids.has(id)) attempt.abort();
      for (const id of ships.keys()) if (!ids.has(id)) ships.delete(id);
      for (const id of cachedShips.keys())
        if (!ids.has(id)) cachedShips.delete(id);
      broadcast(
        previous
          ? options.diff(
              { fleet: previous, ships: {} },
              { fleet: next, ships: {} },
              Date.now(),
            )
          : [{ type: "fleet", data: next }],
      );
    }

    function publishShip(
      summary: V1Ship,
      readAt: number,
      detail?: V1ShipDetail,
    ) {
      if (!fleet) return;
      const { id } = summary;
      const previous = ships.get(id);
      const prior = cachedShips.get(id);
      const next: V1ShipDetail =
        detail && (detail.available || !prior?.available)
          ? { ...detail, detailUpdatedAt: readAt }
          : prior?.available
            ? { ...prior, detailStale: true }
            : (prior ?? {
                ...summary,
                available: false,
                error: summary.error ?? "Ship detail unavailable.",
                crewMembers: [],
                detailUpdatedAt: readAt,
              });
      const changes: V1Event[] = previous
        ? options.diff(
            { fleet, ships: { [id]: previous } },
            { fleet, ships: { [id]: next } },
            Date.now(),
          )
        : [{ type: "ship", data: next }];
      ships.set(id, next);
      cachedShips.set(id, next);
      broadcast(changes);
    }

    async function refreshShip(summary: V1Ship, read: V1ShipRead) {
      if (shutdown.signal.aborted) return;
      const { id } = summary;
      const readAt = Date.now();
      if (pendingShips.has(id)) {
        const own = pending.get(id);
        // A prior stream or a removed ship already cancelled this wait.
        if (!own || own.signal.aborted) publishShip(summary, readAt);
        return;
      }
      const attempt = new AbortController();
      pending.set(id, attempt);
      pendingShips.add(id);
      const parent = AbortSignal.any([shutdown.signal, attempt.signal]);
      const { result, settled } = readWithDeadline(parent, readMs, read);
      try {
        const detail = await result.catch(() => undefined);
        if (!parent.aborted) publishShip(summary, readAt, detail);
      } finally {
        await settled;
        pending.delete(id);
        pendingShips.delete(id);
      }
    }

    async function poll() {
      if (publishing || shutdown.signal.aborted) return;
      publishing = true;
      try {
        const sample = await readOverview(shutdown.signal, async (signal) => {
          const reads = new Map<string, V1ShipRead>();
          const overview = await options.fleet(signal, (id, read) =>
            reads.set(id, read),
          );
          return { overview, reads };
        }).catch(() => undefined);
        if (shutdown.signal.aborted) return;
        if (sample) cachedOverview = sample.overview;
        if (!cachedOverview) {
          overviewExpired = true;
          return;
        }
        const overview = cachedOverview;
        const complete = await enrich(shutdown.signal, (signal) =>
          options.completeFleet(overview, signal),
        ).catch(() => undefined);
        if (shutdown.signal.aborted) return;
        const next = complete ?? options.fallbackFleet(overview);
        publishFleet(next);
        for (const ship of next.ships)
          void refreshShip(
            ship,
            sample?.reads.get(ship.id) ??
              ((signal) => options.ship(ship.id, signal)),
          ).catch(() => {
            // A later poll can publish this ship if its projection fails.
          });
      } catch {
        // Keep the last overview and retry while clients are present.
      } finally {
        publishing = false;
      }
    }

    async function publishHost() {
      if (readingHost) return;
      readingHost = true;
      try {
        const data = await options.readHost();
        if (!shutdown.signal.aborted) broadcast([{ type: "host", data }]);
      } catch {
        // The next sample can succeed even if a metric read failed.
      } finally {
        readingHost = false;
      }
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
