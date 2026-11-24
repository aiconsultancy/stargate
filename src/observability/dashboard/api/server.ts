import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import {
  type SocketIdentity,
  listenOnUnixSocket,
  unlinkOwnSocket,
} from "../../../lib/unix-socket";
import { type ApiRoute, apiRoutes } from "./route";

type Options = {
  listen: { hostname: string; port: number } | { unix: string };
  routes?: readonly ApiRoute[];
  fleet(request: Request, address: string | undefined): Promise<Response>;
  signal: AbortSignal;
  /** Test injection can shorten, never extend, production deadlines. */
  timing?: { headersMs?: number; requestMs?: number };
};

const maxConnections = 64;
const maxHeaders = 16 * 1024;
const maxNotificationWork = 8;
export const maxFleetReads = 8;
const maxFleetStreams = 8;

// A small timeout response may drain, but cannot retain a socket indefinitely.
const timeoutFlushMs = 100;

function failure(status: number, code: string) {
  return Response.json(
    { code, correlationId: randomUUID() },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(status === 503 && { "Retry-After": "1" }),
      },
    },
  );
}

/** The default, and the largest allowed, request deadline in milliseconds. */
export const apiRequestMs = 20_000;

function deadline(value: number | undefined, ceiling: number) {
  if (value === undefined) {
    return ceiling;
  }

  if (!Number.isInteger(value) || value <= 0 || value > ceiling) {
    throw new Error("Invalid API deadline");
  }

  return value;
}

function requestHeaders(request: IncomingMessage) {
  const headers = new Headers();

  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const key = request.rawHeaders[i];
    const value = request.rawHeaders[i + 1];

    if (key !== undefined && value !== undefined) {
      headers.append(key, value);
    }
  }

  return headers;
}

class BodyLimit extends Error {}

function readBody(
  request: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      request.pause();
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onAbort = () => {
      onError(new Error("API request aborted"));
    };

    const onData = (chunk: Buffer) => {
      size += chunk.length;

      if (size > maxBytes) {
        onError(new BodyLimit());

        return;
      }

      chunks.push(chunk);
    };

    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });

    if (signal.aborted) {
      onAbort();
    }
  });
}

async function writeResponse(
  response: Response,
  output: ServerResponse,
  signal: AbortSignal,
  head: boolean,
) {
  if (output.destroyed || output.writableEnded) {
    await response.body?.cancel();

    return;
  }

  output.statusCode = response.status;

  for (const [key, value] of response.headers) {
    output.setHeader(key, value);
  }

  // One request per connection bounds rejected bodies and pipelined work too.
  output.setHeader("Connection", "close");
  output.flushHeaders();

  if (!response.body || head) {
    await response.body?.cancel();
    output.end();

    return;
  }

  const reader = response.body.getReader();
  let cancellation: Promise<void> | undefined;

  const cancel = () => {
    cancellation ??= reader.cancel().catch(() => {});
  };

  signal.addEventListener("abort", cancel, { once: true });

  try {
    if (signal.aborted) {
      cancel();
    }

    while (!signal.aborted) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      if (!output.write(chunk.value)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            output.off("drain", done);
            signal.removeEventListener("abort", done);
            resolve();
          };

          output.once("drain", done);
          signal.addEventListener("abort", done, { once: true });

          if (signal.aborted) {
            done();
          }
        });
      }
    }

    if (!output.destroyed) {
      output.end();
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    await cancellation;
    reader.releaseLock();
  }
}

/** One transport owner. Stop aborts and waits for actual handler settlement. */
export async function startApiServer(options: Options) {
  const routes = apiRoutes(options.routes ?? []);

  if (routes.length > 0 && !("unix" in options.listen)) {
    throw new Error("Additional API routes require private Unix mode");
  }

  const headersMs = deadline(options.timing?.headersMs, 10_000);
  const requestMs = deadline(options.timing?.requestMs, apiRequestMs);
  options.signal.throwIfAborted();
  const sockets = new Map<Socket, ReturnType<typeof setTimeout>>();
  const started = new WeakSet<Socket>();
  const work = new Set<Promise<void>>();
  const producers = new Set<AbortController>();
  const lifetime = new AbortController();
  const counts = new Map<string, number>();
  let notifications = 0;
  let reads = 0;
  let streams = 0;
  let accepting = true;
  let stopping: Promise<void> | undefined;
  let identity: SocketIdentity | undefined;

  const server = createServer(
    { maxHeaderSize: maxHeaders },
    (request, output) => {
      const timer = sockets.get(request.socket);

      if (timer) {
        clearTimeout(timer);
      }

      if (started.has(request.socket) || lifetime.signal.aborted) {
        request.socket.destroy();

        return;
      }

      started.add(request.socket);

      const running = handle(request, output).catch(() => {
        output.destroy();
      });

      work.add(running);
      void running.finally(() => {
        work.delete(running);
      });
    },
  );

  server.headersTimeout = headersMs;
  // Absolute request timers below also cover handler and response work.
  server.requestTimeout = 0;
  server.on("connection", (socket) => {
    if (sockets.size >= maxConnections || lifetime.signal.aborted) {
      socket.destroy();

      return;
    }

    const timer = setTimeout(() => {
      socket.destroy();
    }, headersMs);

    sockets.set(socket, timer);
    socket.on("error", () => {});
    socket.once("close", () => {
      clearTimeout(timer);
      sockets.delete(socket);
    });
  });
  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });
  // Do not send 100 Continue before route authorization and limits.
  server.on("checkContinue", (request, output) => {
    server.emit("request", request, output);
  });
  server.on("checkExpectation", (_request, output) => {
    output.writeHead(417, { Connection: "close" });
    output.end();
  });

  async function handle(request: IncomingMessage, output: ServerResponse) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, lifetime.signal]);

    const disconnected = () => {
      controller.abort();
    };

    const closed = () => {
      if (!output.writableFinished) {
        disconnected();
      }
    };

    output.once("close", closed);
    output.once("error", disconnected);
    request.once("aborted", disconnected);
    request.once("error", disconnected);
    const path = (request.url ?? "").split("?")[0] ?? "";

    const route = routes.find(
      (candidate) =>
        candidate.path === path && candidate.method === request.method,
    );

    const fleet = path.startsWith("/api/v1/");

    const streaming =
      fleet && path === "/api/v1/events" && request.method === "GET";

    const duration = Math.min(requestMs, route?.limits.timeoutMs ?? requestMs);
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    const clearFlush = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
    };

    const destroy = () => {
      clearFlush();
      request.socket.destroy();
    };

    const abort = () => {
      if (!flushTimer) {
        destroy();
      }
    };

    request.socket.once("close", clearFlush);

    // Fleet streams keep their independent heartbeat/idle lifetime.
    const timer = streaming
      ? undefined
      : setTimeout(() => {
          if (!output.headersSent && !output.destroyed) {
            flushTimer = setTimeout(destroy, timeoutFlushMs);
            output.writeHead(503, {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
              "Retry-After": "1",
              Connection: "close",
            });
            output.end(
              JSON.stringify({
                code: "request_timeout",
                correlationId: randomUUID(),
              }),
            );
          }

          controller.abort();

          if (!flushTimer) {
            output.destroy();
          }
        }, duration);

    signal.addEventListener("abort", abort, { once: true });
    output.once("finish", destroy);
    let admitted = false;

    try {
      let response: Response;
      const headers = requestHeaders(request);

      if (route) {
        if (
          !accepting ||
          notifications >= maxNotificationWork ||
          (counts.get(route.owner) ?? 0) >= route.limits.maxConcurrent
        ) {
          response = failure(503, "unavailable");
        } else {
          notifications++;
          counts.set(route.owner, (counts.get(route.owner) ?? 0) + 1);
          producers.add(controller);
          admitted = true;

          const auth = headers.has("Origin")
            ? { allowed: false as const, response: failure(403, "forbidden") }
            : route.authorize(headers);

          if (!auth.allowed) {
            response = auth.response;
          } else if (
            Number(headers.get("Content-Length") ?? 0) >
            route.limits.maxBodyBytes
          ) {
            response = failure(413, "body_too_large");
          } else {
            if (headers.get("Expect")?.toLowerCase() === "100-continue") {
              output.writeContinue();
            }

            const body = await readBody(
              request,
              route.limits.maxBodyBytes,
              signal,
            );

            signal.throwIfAborted();

            const input = new Request(`http://localhost${request.url}`, {
              method: route.method,
              headers,
              body: Uint8Array.from(body),
              signal,
            });

            response = await route.handle(input, auth.caller, signal);
          }
        }

        for (const key of [...response.headers.keys()]) {
          if (key.startsWith("access-control-")) {
            response.headers.delete(key);
          }
        }
      } else if (fleet) {
        if (streaming ? streams >= maxFleetStreams : reads >= maxFleetReads) {
          response = failure(503, "unavailable");
        } else {
          if (streaming) {
            streams++;
          } else {
            reads++;
          }

          admitted = true;

          if (streaming) {
            request.socket.setTimeout(60_000, destroy);
          }

          response = await options.fleet(
            new Request(`http://localhost${request.url}`, {
              method: request.method ?? "GET",
              headers,
              signal,
            }),
            "unix" in options.listen ? undefined : request.socket.remoteAddress,
          );
        }
      } else {
        response = failure(404, "not_found");
      }

      await writeResponse(response, output, signal, request.method === "HEAD");
    } catch (error) {
      if (!signal.aborted) {
        await writeResponse(
          failure(
            error instanceof BodyLimit ? 413 : 500,
            error instanceof BodyLimit ? "body_too_large" : "internal_error",
          ),
          output,
          signal,
          request.method === "HEAD",
        );
      }
    } finally {
      if (timer) {
        clearTimeout(timer);
      }

      signal.removeEventListener("abort", abort);
      output.off("close", closed);
      request.off("aborted", disconnected);
      producers.delete(controller);

      if (admitted) {
        if (route) {
          notifications--;
          counts.set(route.owner, (counts.get(route.owner) ?? 1) - 1);
        } else if (streaming) {
          streams--;
        } else {
          reads--;
        }
      }
    }
  }

  const closeAdmission = () => {
    accepting = false;

    for (const controller of producers) {
      controller.abort();
    }
  };

  const cancel = () => {
    closeAdmission();
    lifetime.abort();

    for (const [socket, timer] of sockets) {
      clearTimeout(timer);
      socket.destroy();
    }
  };

  options.signal.addEventListener("abort", cancel, { once: true });

  try {
    options.signal.throwIfAborted();

    if ("unix" in options.listen) {
      identity = await listenOnUnixSocket(server, options.listen.unix, {
        mode: 0o600,
        signal: options.signal,
      });
    } else {
      const listen = options.listen;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(listen.port, listen.hostname, () => {
          server.off("error", reject);
          resolve();
        });
      });
    }

    options.signal.throwIfAborted();
  } catch (error) {
    options.signal.removeEventListener("abort", cancel);
    cancel();

    try {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      }

      if ("unix" in options.listen) {
        unlinkOwnSocket(options.listen.unix, identity);
      }
    } finally {
      await Promise.allSettled(work);
    }

    throw error;
  }

  const address = server.address();
  const url = new URL("http://localhost/");

  if (address !== null && typeof address !== "string") {
    url.hostname =
      address.family === "IPv6" ? `[${address.address}]` : address.address;
    url.port = String(address.port);
  }

  const stop = () => {
    if (stopping !== undefined) {
      return stopping;
    }

    options.signal.removeEventListener("abort", onAbort);
    cancel();
    stopping = (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });

        if ("unix" in options.listen) {
          unlinkOwnSocket(options.listen.unix, identity);
        }
      } finally {
        await Promise.allSettled(work);
      }
    })();

    return stopping;
  };

  const onAbort = () => {
    void stop().catch(() => {});
  };

  options.signal.addEventListener("abort", onAbort, { once: true });
  options.signal.removeEventListener("abort", cancel);

  if (options.signal.aborted) {
    await stop();
    options.signal.throwIfAborted();
  }

  return {
    url,
    socketPath: "unix" in options.listen ? options.listen.unix : undefined,
    closeAdmission,
    stop,
  };
}
