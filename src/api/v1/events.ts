import type {
  ApiV1Source,
  V1Event,
  V1Fleet,
  V1Host,
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
  completeFleet(fleet: V1Snapshot["fleet"]): Promise<V1Fleet>;
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

function encodeEvents(events: V1Event[]) {
  return encoder.encode(
    events
      .map(
        ({ type, data }) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
      )
      .join(""),
  );
}

export function createEventStreams(options: Options, timing = streamTiming) {
  let active: ReturnType<typeof startPolling> | undefined;

  function startPolling() {
    const shutdown = new AbortController();
    const clients = new Map<Client, boolean>();
    let previous: V1Snapshot | undefined;
    let initial: Uint8Array | undefined;
    let polling = false;
    let readingHost = false;

    function broadcast(bytes: Uint8Array) {
      for (const [client, ready] of clients) if (ready) client.send(bytes);
    }

    async function poll() {
      if (polling) return;
      polling = true;
      // Cancel sibling reads if a read fails, as well as on stop or timeout.
      const attempt = new AbortController();
      const readSignal = AbortSignal.any([
        shutdown.signal,
        attempt.signal,
        AbortSignal.timeout(20_000),
      ]);
      try {
        const reads = new Map<string, V1ShipRead>();
        const overview = await options.fleet(readSignal, (id, read) =>
          reads.set(id, read),
        );
        readSignal.throwIfAborted();
        const [ships, fleet] = await Promise.all([
          Promise.all(
            overview.ships.map(async ({ id }) => {
              const read = reads.get(id);
              return read ? read(readSignal) : options.ship(id, readSignal);
            }),
          ),
          options.completeFleet(overview),
        ]);
        readSignal.throwIfAborted();
        const details = ships.filter((ship) => ship !== undefined);
        const next: V1Snapshot & { fleet: V1Fleet } = {
          fleet,
          ships: Object.fromEntries(details.map((ship) => [ship.id, ship])),
        };
        const changes = options.diff(previous, next, Date.now());
        const frames = encodeEvents(
          changes.map((event) =>
            event.type === "fleet" ? { type: "fleet", data: fleet } : event,
          ),
        );
        initial = encodeEvents([
          { type: "fleet", data: fleet },
          ...details.map((data) => ({ type: "ship" as const, data })),
        ]);
        previous = next;
        if (frames.length) broadcast(frames);
        for (const [client, ready] of clients) {
          if (ready) continue;
          clients.set(client, true);
          client.send(initial);
        }
      } catch {
        // Keep the last completed snapshot and retry while clients are present.
      } finally {
        attempt.abort();
        polling = false;
      }
    }

    async function publishHost() {
      if (readingHost) return;
      readingHost = true;
      try {
        const data = await options.readHost();
        if (!shutdown.signal.aborted)
          broadcast(encodeEvents([{ type: "host", data }]));
      } catch {
        // The next sample can succeed even if a metric read failed.
      } finally {
        readingHost = false;
      }
    }

    const pollTimer = setInterval(() => void poll(), timing.pollMs);
    const hostTimer = setInterval(() => void publishHost(), timing.hostMs);
    const heartbeatTimer = setInterval(() => {
      broadcast(
        encodeEvents([{ type: "heartbeat", data: { at: Date.now() } }]),
      );
    }, timing.heartbeatMs);

    return {
      clients,
      add(client: Client) {
        clients.set(client, initial !== undefined);
        if (initial) client.send(initial);
        else void poll();
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
      if (active) for (const client of active.clients.keys()) client.close();
    },
  };
}
