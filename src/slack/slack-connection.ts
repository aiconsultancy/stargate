import { setTimeout as delay } from "node:timers/promises";
import { Predicate } from "effect";
import type { Logger } from "pino";

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "closed";

type Socket = {
  start(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
};

const defaults = {
  retryMs: 1000,
  maxRetryMs: 30_000,
  outageMs: 600_000,
  attemptMs: 30_000,
};

const networkCodes = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "ABORT_ERR",
  "slack_webapi_request_error",
]);

function retryable(error: unknown, depth = 0): boolean {
  if (!Predicate.isObject(error) || depth > 5) return false;

  return (
    (typeof error["code"] === "string" && networkCodes.has(error["code"])) ||
    retryable(error["cause"], depth + 1) ||
    retryable(error["original"], depth + 1)
  );
}

/** Cancel observation without leaving timers or unhandled SDK rejections. */
function bounded<A>(work: Promise<A>, signal: AbortSignal): Promise<A> {
  return new Promise((resolve, reject) => {
    const stop = () =>
      reject(
        Object.assign(new Error("Slack connection unavailable"), {
          code: "ETIMEDOUT",
        }),
      );

    const done = () => signal.removeEventListener("abort", stop);
    signal.addEventListener("abort", stop, { once: true });
    work.then(
      (value) => {
        done();
        resolve(value);
      },
      (error: unknown) => {
        done();
        reject(error);
      },
    );

    if (signal.aborted) stop();
  });
}

/** Auth must survive the same boot-time DNS outage as connections.open. */
export async function retrySlack<A>(
  work: () => Promise<A>,
  signal?: AbortSignal,
) {
  const boundedSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(defaults.outageMs)])
    : AbortSignal.timeout(defaults.outageMs);

  let attempt = 0;

  for (;;) {
    boundedSignal.throwIfAborted();

    try {
      return await bounded(work(), boundedSignal);
    } catch (error) {
      if (boundedSignal.aborted || !retryable(error))
        throw new Error("Slack connection unavailable");
      await delay(
        Math.min(
          defaults.retryMs * 2 ** Math.min(attempt++, 10),
          defaults.maxRetryMs,
        ),
        undefined,
        { signal: boundedSignal },
      );
    }
  }
}

/** One owner for startup and later outages. The SDK's unbounded reconnect loop is disabled. */
export class SlackSocket {
  public state: ConnectionState = "closed";
  private readonly stop = new AbortController();
  private readonly first = Promise.withResolvers<void>();
  private running?: Promise<void>;
  private socket: Socket | undefined;
  private readonly timing;
  public constructor(
    private readonly create: () => Socket,
    private readonly log: Logger,
    timing: Partial<typeof defaults> = {},
  ) {
    this.timing = { ...defaults, ...timing };
    // Either startup or watch owns the rejection; never leak a raw SDK error.
    void this.first.promise.catch(() => {});
  }
  public start(signal?: AbortSignal) {
    if (!this.running) {
      const combined = signal
        ? AbortSignal.any([signal, this.stop.signal])
        : this.stop.signal;

      this.running = this.run(combined);
      void this.running.catch(() => {});
    }

    return this.first.promise;
  }
  public watch() {
    return (
      this.running ?? Promise.reject(new Error("Slack connection not started"))
    );
  }
  public async close() {
    this.stop.abort();
    await this.disconnect();
    await this.running?.catch(() => {});
    this.state = "closed";
  }
  private async disconnect() {
    const socket = this.socket;
    this.socket = undefined;

    if (socket)
      await bounded(socket.disconnect(), AbortSignal.timeout(5000)).catch(
        () => {},
      );
  }
  private async run(signal: AbortSignal) {
    let deadline = Date.now() + this.timing.outageMs;
    let attempt = 0;
    let everConnected = false;

    try {
      while (!signal.aborted) {
        if (Date.now() >= deadline)
          throw new Error("Slack connection unavailable");
        this.state = everConnected ? "reconnecting" : "connecting";

        if (attempt)
          await delay(
            Math.min(
              this.timing.retryMs * 2 ** Math.min(attempt - 1, 10),
              this.timing.maxRetryMs,
              deadline - Date.now(),
            ),
            undefined,
            { signal },
          );
        signal.throwIfAborted();
        const socket = this.create();
        this.socket = socket;
        const hello = Promise.withResolvers<void>();
        const lost = Promise.withResolvers<void>();
        let connected = false;

        const onConnected = () => {
          if (!signal.aborted) {
            connected = true;
            this.state = "connected";
            hello.resolve();
          }
        };

        const onLost = () => {
          this.state =
            everConnected || connected ? "reconnecting" : "connecting";
          lost.resolve();

          if (!connected)
            hello.reject(
              Object.assign(new Error("Slack connection unavailable"), {
                code: "ECONNRESET",
              }),
            );
        };

        void hello.promise.catch(() => {});
        socket.on("connected", onConnected);
        socket.on("disconnected", onLost);
        socket.on("close", onLost);
        socket.on("error", onLost);

        try {
          await bounded(
            Promise.all([socket.start(), hello.promise]),
            AbortSignal.any([
              signal,
              AbortSignal.timeout(
                Math.max(
                  1,
                  Math.min(this.timing.attemptMs, deadline - Date.now()),
                ),
              ),
            ]),
          );
          everConnected = true;
          attempt = 0;
          this.first.resolve();
          await bounded(lost.promise, signal);
          deadline = Date.now() + this.timing.outageMs;
        } catch (error) {
          if (signal.aborted) break;

          if (!retryable(error))
            throw new Error("Slack connection unavailable");
          this.log.warn(
            "Slack connection unavailable; retrying within outage deadline",
          );
          attempt++;
        } finally {
          socket.removeListener("connected", onConnected);
          socket.removeListener("disconnected", onLost);
          socket.removeListener("close", onLost);
          socket.removeListener("error", onLost);
          await this.disconnect();
        }
      }

      this.first.reject(new Error("Slack connection closed"));
    } catch {
      if (!signal.aborted) {
        this.state = "failed";
        this.first.reject(new Error("Slack connection unavailable"));
        throw new Error("Slack connection unavailable");
      }

      this.first.reject(new Error("Slack connection closed"));
    } finally {
      if (signal.aborted) this.state = "closed";
    }
  }
}
