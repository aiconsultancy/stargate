import { expect, mock, test } from "bun:test";
import { existsSync, lstatSync, watch } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer, request } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { ApiRoute } from "../src/api/route";
import { startApiServer } from "../src/api/server";
import {
  flockCommand,
  listenOnUnixSocket,
  removeStaleSocket,
  StartAbortedError,
  setDefaultLockCommandForTests,
  unlinkOwnSocket,
} from "../src/teams/unix-socket";

const path = "/v1/notifications/local";
const signal = () => new AbortController().signal;

function route(options: Partial<ApiRoute> = {}): ApiRoute {
  return {
    owner: "notify/local",
    method: "POST",
    path,
    limits: { maxBodyBytes: 16, timeoutMs: 1000, maxConcurrent: 4 },
    authorize: (headers) =>
      headers.get("Authorization") === "Bearer producer"
        ? { allowed: true, caller: "source" }
        : { allowed: false, response: new Response(null, { status: 401 }) },
    handle: async (request) =>
      new Response(await request.text(), { status: 202 }),
    ...options,
  };
}

async function fixture(
  routes: readonly ApiRoute[] = [route()],
  timing: { headersMs?: number; requestMs?: number } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "api-host-"));
  const socketPath = join(directory, "api.sock");
  const shutdown = new AbortController();
  try {
    const server = await startApiServer({
      listen: { unix: socketPath },
      routes,
      signal: shutdown.signal,
      timing,
      fleet: async (input) => {
        if (input.headers.get("Authorization") !== "Bearer operator")
          return new Response(null, { status: 401 });
        if (new URL(input.url).pathname === "/api/v1/events") {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode("event: heartbeat\n\n"),
                );
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }
        return new Response("fleet");
      },
    });
    return {
      ...server,
      directory,
      socketPath,
      shutdown,
      async close() {
        await server.stop();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function post(
  socketPath: string,
  body = "ok",
  headers: Record<string, string> = {},
) {
  return new Promise<{
    status: number;
    text: string;
    cors: string | undefined;
  }>((resolve, reject) => {
    const client = request(
      {
        socketPath,
        path,
        method: "POST",
        headers: {
          Authorization: "Bearer producer",
          ...headers,
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            text,
            cors: response.headers["access-control-allow-origin"],
          }),
        );
      },
    );
    client.once("error", reject);
    client.end(body);
  });
}

async function raw(
  endpoint: string | { host: string; port: number },
  text = "",
) {
  const socket =
    typeof endpoint === "string" ? connect(endpoint) : connect(endpoint);
  let output = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    output += chunk;
  });
  socket.on("error", () => {});
  const closed = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Raw API fixture did not close within two seconds"));
    }, 2000);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(output);
    });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  if (text) socket.write(text);
  return { socket, closed };
}

const wire = (headers: string, body = "", target = path) =>
  `POST ${target} HTTP/1.1\r\nHost: localhost\r\n${headers}\r\n${body}`;

test("exact notification routes isolate authority, reject aliases and read no rejected body", async () => {
  const handle = mock(route().handle);
  const host = await fixture([route({ handle })]);
  try {
    expect(await post(host.socketPath)).toMatchObject({
      status: 202,
      text: "ok",
      cors: undefined,
    });
    for (const headers of [
      { Authorization: "Bearer operator" },
      { Authorization: "", Cookie: "producer" },
      { Origin: "null" },
      { Origin: "subspace://space" },
    ]) {
      const response = await post(host.socketPath, "secret-input", headers);
      expect([401, 403]).toContain(response.status);
      expect(response.text).not.toContain("secret");
      expect(response.cors).toBeUndefined();
    }
    for (const target of [
      "/v1/notifications/%6cocal",
      "/v1//notifications/local",
      "/v1/notifications/../notifications/local",
      "/v1/notifications\\local",
      "/v1/notifications/local/",
      "/v1/notifications/disabled",
    ]) {
      const client = await raw(
        host.socketPath,
        wire(
          "Authorization: Bearer producer\r\nContent-Length: 999\r\n",
          "",
          target,
        ),
      );
      const response = await client.closed;
      expect(response).toContain("404");
      expect(response).not.toContain("producer");
    }
    const denied = await raw(host.socketPath, wire("Content-Length: 999\r\n"));
    expect(await denied.closed).toContain("401");
    const preflight = await raw(
      host.socketPath,
      `OPTIONS ${path} HTTP/1.1\r\nHost: localhost\r\nOrigin: subspace://space\r\n\r\n`,
    );
    expect(await preflight.closed).toContain("404");
    expect(handle).toHaveBeenCalledTimes(1);
  } finally {
    await host.close();
  }
});

test("route definitions reject duplicates, aliases and reserved claims before binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "api-registration-"));
  const socketPath = join(directory, "api.sock");
  try {
    for (const routes of [
      [route(), route()],
      [route(), route({ owner: "notify/other" })],
      [route(), route({ path: "/v1/notifications/other" })],
      ...[
        "/api/v1/fleet",
        "/api/messages",
        "/v1/health/live",
        "/v1/metrics",
        "/v1/config",
        "/v1/notifications/%6cocal",
        "/v1/notifications/a/b",
        "/v1/notifications/..",
      ].map((path) => [route({ path })]),
      [route({ owner: "health/local" })],
      [
        route({
          limits: { maxBodyBytes: 0, timeoutMs: 100, maxConcurrent: 4 },
        }),
      ],
      [
        route({
          limits: { maxBodyBytes: 16, timeoutMs: 20_001, maxConcurrent: 4 },
        }),
      ],
    ]) {
      await expect(
        startApiServer({
          listen: { unix: socketPath },
          routes,
          fleet: async () => new Response(),
          signal: signal(),
        }),
      ).rejects.toThrow();
      await expect(lstat(socketPath)).rejects.toThrow();
    }
    await expect(
      startApiServer({
        listen: { hostname: "127.0.0.1", port: 0 },
        routes: [route()],
        fleet: async () => new Response(),
        signal: signal(),
      }),
    ).rejects.toThrow("private Unix mode");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("body bytes are counted for chunked input and framing errors never reach handlers", async () => {
  const handle = mock(route().handle);
  const host = await fixture([
    route({
      handle,
      limits: { maxBodyBytes: 4, timeoutMs: 500, maxConcurrent: 4 },
    }),
  ]);
  try {
    expect(await post(host.socketPath, "four")).toMatchObject({
      status: 202,
      text: "four",
    });
    for (const [headers, body] of [
      ["Content-Length: 5\r\n", ""],
      ["Transfer-Encoding: chunked\r\n", "3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n"],
    ]) {
      const client = await raw(
        host.socketPath,
        wire(`Authorization: Bearer producer\r\n${headers}`, body),
      );
      expect(await client.closed).toContain("413");
    }
    for (const headers of [
      "Content-Length: 3\r\nContent-Length: 5\r\n",
      "Content-Length: nope\r\n",
      "Content-Length: 3\r\nTransfer-Encoding: chunked\r\n",
    ]) {
      const client = await raw(
        host.socketPath,
        wire(`Authorization: Bearer producer\r\n${headers}`, "abc"),
      );
      expect(await client.closed).not.toContain("202");
    }
    expect(handle).toHaveBeenCalledTimes(1);
    const absent = await raw(
      host.socketPath,
      wire("Authorization: Bearer producer\r\n"),
    );
    expect(await absent.closed).toContain("202");
    expect(handle).toHaveBeenCalledTimes(2);
  } finally {
    await host.close();
  }
});

test("absolute header/body deadlines close trickling connections and enforce header bytes", async () => {
  const handle = mock(route().handle);
  const host = await fixture([route({ handle })], {
    headersMs: 80,
    requestMs: 100,
  });
  let trickle: ReturnType<typeof setInterval> | undefined;
  try {
    const header = await raw(host.socketPath, "POST / HTTP/1.1\r\nX-Trickle: ");
    trickle = setInterval(() => header.socket.write("a"), 10);
    expect(await header.closed).toBe("");
    clearInterval(trickle);
    const huge = await raw(
      host.socketPath,
      wire(
        `Authorization: Bearer producer\r\nX-Large: ${"x".repeat(17 * 1024)}\r\n`,
      ),
    );
    expect(await huge.closed).not.toContain("202");
    const body = await raw(
      host.socketPath,
      wire("Authorization: Bearer producer\r\nContent-Length: 16\r\n"),
    );
    trickle = setInterval(() => body.socket.write("a"), 15);
    expect(await body.closed).toContain("503");
    clearInterval(trickle);
    expect(handle).not.toHaveBeenCalled();
    expect((await post(host.socketPath)).status).toBe(202);
  } finally {
    clearInterval(trickle);
    await host.close();
  }
});

test("handler failures return a fixed error without stopping other requests", async () => {
  let fail = true;
  const host = await fixture([
    route({
      handle: async () => {
        if (fail) {
          fail = false;
          throw new Error("private-handler-secret");
        }
        return new Response("accepted", { status: 202 });
      },
    }),
  ]);
  try {
    const failed = await post(host.socketPath);
    expect(failed.status).toBe(500);
    expect(JSON.parse(failed.text)).toEqual({
      code: "internal_error",
      correlationId: expect.any(String),
    });
    expect(failed.text).not.toContain("private-handler-secret");
    expect((await post(host.socketPath)).status).toBe(202);
  } finally {
    await host.close();
  }
});

test("64 pre-header connections are bounded and release capacity at their deadline", async () => {
  const host = await fixture([], { headersMs: 150 });
  const clients: Socket[] = [];
  try {
    const accepted = await Promise.all(
      Array.from({ length: 64 }, async () => {
        const client = await raw(
          host.socketPath,
          "GET /api/v1/fleet HTTP/1.1\r\n",
        );
        clients.push(client.socket);
        return client;
      }),
    );
    const excess = await raw(host.socketPath);
    expect(
      await Promise.race([
        excess.closed.then(() => "excess"),
        accepted[0]?.closed.then(() => "accepted"),
      ]),
    ).toBe("excess");
    expect(await excess.closed).toBe("");
    await Promise.all(accepted.map((client) => client.closed));
    const next = await raw(
      host.socketPath,
      "GET /api/v1/fleet HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer operator\r\n\r\n",
    );
    expect(await next.closed).toContain("fleet");
  } finally {
    for (const client of clients) client.destroy();
    await host.close();
  }
});

test("TCP uses the same absolute header deadline without mounting producers", async () => {
  const host = await startApiServer({
    listen: { hostname: "127.0.0.1", port: 0 },
    signal: signal(),
    timing: { headersMs: 40 },
    fleet: async () => new Response("fleet"),
  });
  try {
    const endpoint = { host: host.url.hostname, port: Number(host.url.port) };
    const slow = await raw(endpoint, "GET /api/v1/fleet HTTP/1.1\r\n");
    expect(await slow.closed).toBe("");
    const next = await raw(
      endpoint,
      "GET /api/v1/fleet HTTP/1.1\r\nHost: localhost\r\n\r\n",
    );
    expect(await next.closed).toContain("fleet");
    const absent = await raw(endpoint, wire("Content-Length: 999\r\n"));
    expect(await absent.closed).toContain("404");
  } finally {
    await host.stop();
  }
});

test("notification slots remain held after timeout while Fleet reads and streams progress", async () => {
  const settled = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  const handle = async (
    _input: Request,
    _caller: unknown,
    signal: AbortSignal,
  ) => {
    signals.push(signal);
    if (signals.length === 8) entered.resolve();
    await settled.promise;
    return new Response("done", { status: 202 });
  };
  const second = "/v1/notifications/second";
  const host = await fixture(
    [
      route({ handle }),
      route({ owner: "notify/second", path: second, handle }),
      route({ owner: "notify/third", path: "/v1/notifications/third" }),
    ],
    { requestMs: 120 },
  );
  const clients: Socket[] = [];
  try {
    const active = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const client = await raw(
          host.socketPath,
          wire(
            "Authorization: Bearer producer\r\nContent-Length: 0\r\n",
            "",
            path,
          ),
        );
        clients.push(client.socket);
        return client;
      }),
    );
    expect((await post(host.socketPath)).status).toBe(503);
    const other = await raw(
      host.socketPath,
      wire(
        "Authorization: Bearer producer\r\nContent-Length: 0\r\n",
        "",
        "/v1/notifications/third",
      ),
    );
    expect(await other.closed).toContain("202");
    active.push(
      ...(await Promise.all(
        Array.from({ length: 4 }, async () => {
          const client = await raw(
            host.socketPath,
            wire(
              "Authorization: Bearer producer\r\nContent-Length: 0\r\n",
              "",
              second,
            ),
          );
          clients.push(client.socket);
          return client;
        }),
      )),
    );
    await entered.promise;
    expect((await post(host.socketPath)).status).toBe(503);
    const total = await raw(
      host.socketPath,
      wire(
        "Authorization: Bearer producer\r\nContent-Length: 0\r\n",
        "",
        "/v1/notifications/third",
      ),
    );
    expect(await total.closed).toContain("503");
    const fleet = await raw(
      host.socketPath,
      "GET /api/v1/fleet HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer operator\r\n\r\n",
    );
    expect(await fleet.closed).toContain("fleet");
    const event = await raw(
      host.socketPath,
      "GET /api/v1/events HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer operator\r\n\r\n",
    );
    clients.push(event.socket);
    const heartbeat = Promise.withResolvers<void>();
    event.socket.on("data", (text: string) => {
      if (text.includes("heartbeat")) heartbeat.resolve();
    });
    await heartbeat.promise;
    await Promise.all(active.map((client) => client.closed));
    expect(signals).toHaveLength(8);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect((await post(host.socketPath)).status).toBe(503);
    settled.resolve();
    expect((await post(host.socketPath)).status).toBe(202);
    event.socket.destroy();
    await event.closed;
  } finally {
    settled.resolve();
    for (const client of clients) client.destroy();
    await host.close();
  }
});

test("stop waits for nonsettling handler work after aborting its signal", async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const settle = Promise.withResolvers<void>();
  const host = await fixture([
    route({
      handle: async (_request, _caller, signal) => {
        entered.resolve(signal);
        await settle.promise;
        return new Response();
      },
    }),
  ]);
  let stopped = false;
  try {
    const client = await raw(
      host.socketPath,
      wire("Authorization: Bearer producer\r\nContent-Length: 0\r\n"),
    );
    const signal = await entered.promise;
    const stopping = host.stop().then(() => {
      stopped = true;
    });
    await client.closed;
    expect(signal.aborted).toBe(true);
    // One filesystem round trip lets native close settle, but not the handler.
    await expect(lstat(host.socketPath)).rejects.toThrow();
    expect(stopped).toBe(false);
    settle.resolve();
    await stopping;
    expect(stopped).toBe(true);
  } finally {
    settle.resolve();
    await host.close();
  }
});

test("stop preserves socket cleanup failure only after handler settlement", async () => {
  const entered = Promise.withResolvers<void>();
  const settle = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const host = await fixture([
    route({
      handle: async () => {
        entered.resolve();
        try {
          await settle.promise;
          return new Response();
        } finally {
          finished.resolve();
        }
      },
    }),
  ]);
  const moved = `${host.directory}.moved`;
  let directoryMoved = false;
  let stopSettled = false;
  let outcome: Promise<unknown> | undefined;
  try {
    const client = await raw(
      host.socketPath,
      wire("Authorization: Bearer producer\r\nContent-Length: 0\r\n"),
    );
    await entered.promise;
    await rename(host.directory, moved);
    directoryMoved = true;
    await writeFile(host.directory, "owned replacement");
    const stopping = host.stop();
    outcome = stopping.then(
      () => {
        stopSettled = true;
        return undefined;
      },
      (error: unknown) => {
        stopSettled = true;
        return error;
      },
    );
    expect(host.stop()).toBe(stopping);
    await client.closed;
    await nextTurn();
    expect(stopSettled).toBe(false);
    settle.resolve();
    expect(await outcome).toMatchObject({ code: "ENOTDIR" });
    await finished.promise;
    expect(stopSettled).toBe(true);
  } finally {
    settle.resolve();
    await outcome;
    await nextTurn();
    if (directoryMoved) {
      await rm(host.directory, { force: true });
      await rename(moved, host.directory);
    }
    await host.stop().catch(() => {});
    await rm(host.directory, { recursive: true, force: true });
  }
});

test("abort observes cleanup rejection without changing explicit stop failure", async () => {
  const host = await fixture([]);
  const moved = `${host.directory}.moved`;
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => {
    unhandled.push(error);
  };
  let directoryMoved = false;
  process.on("unhandledRejection", onUnhandled);
  try {
    await rename(host.directory, moved);
    directoryMoved = true;
    await writeFile(host.directory, "owned replacement");
    host.shutdown.abort();
    // Let native close and rejection tracking finish before a caller collects.
    await nextTurn();
    await nextTurn();
    expect(unhandled).toEqual([]);
    const stopping = host.stop();
    const error: unknown = await stopping.catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "ENOTDIR", path: host.socketPath });
    expect(host.stop()).toBe(stopping);
    expect(await host.stop().catch((error: unknown) => error)).toBe(error);
  } finally {
    await host.stop().catch(() => {});
    process.off("unhandledRejection", onUnhandled);
    if (directoryMoved) {
      await rm(host.directory, { force: true });
      await rename(moved, host.directory);
    }
    await rm(host.directory, { recursive: true, force: true });
  }
});

test("eight Fleet reads have a separate bounded budget from notification work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "api-read-budget-"));
  const socketPath = join(directory, "api.sock");
  const entered = Promise.withResolvers<void>();
  const settle = Promise.withResolvers<void>();
  let reads = 0;
  const host = await startApiServer({
    listen: { unix: socketPath },
    signal: signal(),
    routes: [route()],
    timing: { requestMs: 500 },
    fleet: async () => {
      reads++;
      if (reads === 8) entered.resolve();
      await settle.promise;
      return new Response("fleet");
    },
  });
  const clients: Socket[] = [];
  try {
    const active = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const client = await raw(
          socketPath,
          "GET /api/v1/fleet HTTP/1.1\r\nHost: localhost\r\n\r\n",
        );
        clients.push(client.socket);
        return client;
      }),
    );
    await entered.promise;
    const excess = await raw(
      socketPath,
      "GET /api/v1/fleet HTTP/1.1\r\nHost: localhost\r\n\r\n",
    );
    expect(await excess.closed).toContain("unavailable");
    expect(reads).toBe(8);
    expect((await post(socketPath)).status).toBe(202);
    settle.resolve();
    for (const client of active) expect(await client.closed).toContain("fleet");
  } finally {
    settle.resolve();
    for (const client of clients) client.destroy();
    await host.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the response bridge applies backpressure and cancels a blocked reader on stop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "api-backpressure-"));
  const socketPath = join(directory, "api.sock");
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  let pulled = 0;
  const host = await startApiServer({
    listen: { unix: socketPath },
    signal: signal(),
    fleet: async (input) =>
      new URL(input.url).pathname === "/api/v1/fleet"
        ? new Response("fleet")
        : new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  pulled++;
                  entered.resolve();
                  controller.enqueue(new Uint8Array(64 * 1024));
                  if (pulled === 256) controller.close();
                },
                cancel() {
                  cancelled.resolve();
                },
              },
              { highWaterMark: 0 },
            ),
          ),
  });
  const client = connect(socketPath);
  client.on("error", () => {});
  client.pause();
  try {
    await new Promise<void>((resolve) => client.once("connect", resolve));
    client.write("GET /api/v1/events HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await entered.promise;
    const other = await raw(
      socketPath,
      "GET /api/v1/fleet HTTP/1.1\r\nHost: localhost\r\n\r\n",
    );
    expect(await other.closed).toContain("fleet");
    expect(pulled).toBeLessThan(16);
    await host.stop();
    await cancelled.promise;
  } finally {
    client.destroy();
    await host.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("disconnect aborts handlers; early admission close leaves Fleet available", async () => {
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const host = await fixture([
    route({
      handle: async (_input, _caller, signal) => {
        entered.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              resolve();
            },
            { once: true },
          ),
        );
        return new Response();
      },
    }),
  ]);
  try {
    const client = await raw(
      host.socketPath,
      wire("Authorization: Bearer producer\r\nContent-Length: 0\r\n"),
    );
    await entered.promise;
    client.socket.destroy();
    await client.closed;
    await aborted.promise;
    host.closeAdmission();
    expect((await post(host.socketPath)).status).toBe(503);
    const fleet = await raw(
      host.socketPath,
      "GET /api/v1/fleet HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer operator\r\n\r\n",
    );
    expect(await fleet.closed).toContain("fleet");
  } finally {
    await host.close();
  }
});

test("empty route list leaves notifications absent and stop cancels stream readers", async () => {
  const cancelled = Promise.withResolvers<void>();
  let streamCancelled = false;
  const directory = await mkdtemp(join(tmpdir(), "api-stream-"));
  const socketPath = join(directory, "api.sock");
  const host = await startApiServer({
    listen: { unix: socketPath },
    signal: signal(),
    timing: { requestMs: 40 },
    fleet: async (input) => {
      if (new URL(input.url).pathname === "/api/v1/fleet")
        return new Promise<Response>((resolve) => {
          input.signal.addEventListener(
            "abort",
            () => resolve(new Response()),
            {
              once: true,
            },
          );
        });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("initial"));
          },
          cancel() {
            streamCancelled = true;
            cancelled.resolve();
          },
        }),
      );
    },
  });
  try {
    expect((await post(socketPath)).status).toBe(404);
    const client = await raw(
      socketPath,
      "GET /api/v1/events HTTP/1.1\r\nHost: localhost\r\n\r\n",
    );
    const initial = Promise.withResolvers<void>();
    client.socket.on("data", (text: string) => {
      if (text.includes("initial")) initial.resolve();
    });
    await initial.promise;
    const read = await raw(
      socketPath,
      "GET /api/v1/fleet HTTP/1.1\r\nHost: localhost\r\n\r\n",
    );
    expect(await read.closed).toContain("503");
    expect(streamCancelled).toBe(false);
    await host.stop();
    await cancelled.promise;
    await client.closed;
    await expect(lstat(socketPath)).rejects.toThrow();
  } finally {
    await host.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup abort cancels a published SSE stream and awaits reader settlement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "api-start-abort-"));
  const socketPath = join(directory, "api.sock");
  const releasePath = join(directory, "release-lock");
  const lockReleasing = Promise.withResolvers<void>();
  const socketRemoved = Promise.withResolvers<void>();
  const watcher = watch(directory, (_event, name) => {
    if (name === "lock-releasing") lockReleasing.resolve();
    if (name === "api.sock" && !existsSync(socketPath)) socketRemoved.resolve();
  });
  const lockProgram = `
    import { existsSync, watch, writeFileSync } from "node:fs";
    const deadline = setTimeout(() => process.exit(2), 1500);
    const released = new Promise((resolve) => {
      const finish = () => { watcher.close(); resolve(); };
      const watcher = watch(${JSON.stringify(directory)}, (_event, name) => {
        if (name === "release-lock") finish();
      });
      if (existsSync(${JSON.stringify(releasePath)})) finish();
    });
    process.stdout.write("R");
    for await (const _chunk of process.stdin) {}
    writeFileSync(${JSON.stringify(join(directory, "lock-releasing"))}, "");
    await released;
    clearTimeout(deadline);
  `;
  // Keep the real kernel flock. Only its command's exit after stdin EOF is held.
  setDefaultLockCommandForTests((path, waitSeconds) => {
    const command = flockCommand(path, waitSeconds);
    return {
      ...command,
      args: [...command.args.slice(0, -3), process.execPath, "-e", lockProgram],
    };
  });
  const shutdown = new AbortController();
  const entered = Promise.withResolvers<AbortSignal>();
  const firstFrame = Promise.withResolvers<void>();
  const cancelStarted = Promise.withResolvers<void>();
  const cancelSettled = Promise.withResolvers<void>();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let startupSettled = false;
  const starting = startApiServer({
    listen: { unix: socketPath },
    signal: shutdown.signal,
    fleet: async (input) => {
      if (input.headers.get("Authorization") !== "Bearer operator")
        return new Response(null, { status: 401 });
      entered.resolve(input.signal);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const frame = new TextEncoder().encode("event: heartbeat\n\n");
            controller.enqueue(frame);
            heartbeat = setInterval(() => controller.enqueue(frame), 10);
          },
          cancel() {
            clearInterval(heartbeat);
            cancelStarted.resolve();
            return cancelSettled.promise;
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const outcome = starting.then(
    (server) => {
      startupSettled = true;
      return { server };
    },
    (error: unknown) => {
      startupSettled = true;
      return { error };
    },
  );
  let client: Awaited<ReturnType<typeof raw>> | undefined;
  try {
    await Promise.race([
      lockReleasing.promise,
      outcome.then(() => {
        throw new Error("Startup finished before the release fixture");
      }),
    ]);
    expect(existsSync(socketPath)).toBe(true);
    client = await raw(
      socketPath,
      "GET /api/v1/events HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer operator\r\n\r\n",
    );
    client.socket.on("data", (text: string) => {
      if (text.includes("event: heartbeat")) firstFrame.resolve();
    });
    const requestSignal = await entered.promise;
    await firstFrame.promise;
    expect(startupSettled).toBe(false);
    shutdown.abort();
    await nextTurn();
    expect(requestSignal.aborted).toBe(true);
    await cancelStarted.promise;
    await writeFile(releasePath, "");
    await socketRemoved.promise;
    await nextTurn();
    expect(startupSettled).toBe(false);
    cancelSettled.resolve();
    const result = await outcome;
    expect("error" in result ? result.error : undefined).toBeInstanceOf(
      StartAbortedError,
    );
    expect(await client.closed).toContain("event: heartbeat");
    await expect(lstat(socketPath)).rejects.toThrow();
  } finally {
    shutdown.abort();
    cancelSettled.resolve();
    clearInterval(heartbeat);
    client?.socket.destroy();
    await writeFile(releasePath, "");
    const result = await outcome;
    if ("server" in result) await result.server.stop();
    await client?.closed;
    watcher.close();
    setDefaultLockCommandForTests(flockCommand);
    await rm(directory, { recursive: true, force: true });
  }
});

test("private socket publication protects replacement from native close and explicit cleanup", async () => {
  const host = await fixture([]);
  const successor = createServer();
  try {
    await rename(host.socketPath, join(host.directory, "old.sock"));
    await new Promise<void>((resolve) =>
      successor.listen(host.socketPath, resolve),
    );
    const replacement = await lstat(host.socketPath);
    await host.stop();
    expect((await lstat(host.socketPath)).ino).toBe(replacement.ino);
  } finally {
    await new Promise<void>((resolve) => successor.close(() => resolve()));
    await host.close();
  }
});

test("private helper preserves occupied paths, group defaults and foreign sockets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "api-ownership-"));
  const path = join(directory, "api.sock");
  const live = createServer();
  try {
    await chmod(directory, 0o750);
    await expect(
      listenOnUnixSocket(createServer(), path, { mode: 0o600 }),
    ).rejects.toThrow("must have mode 0700");
    await chmod(directory, 0o700);
    for (const kind of ["file", "symlink"] as const) {
      if (kind === "file") await writeFile(path, "keep");
      else await symlink("missing", path);
      await expect(
        listenOnUnixSocket(createServer(), path, { mode: 0o600 }),
      ).rejects.toThrow();
      expect((await lstat(path)).isSymbolicLink()).toBe(kind === "symlink");
      await unlink(path);
    }
    const identity = await listenOnUnixSocket(live, path);
    expect((await lstat(path)).mode & 0o777).toBe(0o660);
    await expect(
      listenOnUnixSocket(createServer(), path, { mode: 0o600 }),
    ).rejects.toThrow("another process");
    await expect(
      removeStaleSocket(
        path,
        { stillHeld: () => true },
        { uid: (process.getuid?.() ?? 0) + 1 },
      ),
    ).rejects.toThrow("another user");
    expect((await lstat(path)).ino).toBe(Number(identity.ino));
    await new Promise<void>((resolve) => live.close(() => resolve()));
    unlinkOwnSocket(path, identity);
  } finally {
    if (live.listening)
      await new Promise<void>((resolve) => live.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stale owned socket is replaced with a born-private socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "api-stale-"));
  const path = join(directory, "api.sock");
  const retired = join(directory, "retired.sock");
  const old = createServer();
  const current = createServer();
  let bornMode: number | undefined;
  current.once("listening", () => {
    const path = current.address();
    if (typeof path === "string") bornMode = lstatSync(path).mode & 0o777;
  });
  try {
    await new Promise<void>((resolve) => old.listen(path, resolve));
    await rename(path, retired);
    await new Promise<void>((resolve) => old.close(() => resolve()));
    await rename(retired, path);
    const identity = await listenOnUnixSocket(current, path, { mode: 0o600 });
    expect(bornMode).toBe(0o600);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await new Promise<void>((resolve) => current.close(() => resolve()));
    unlinkOwnSocket(path, identity);
    await expect(lstat(path)).rejects.toThrow();
  } finally {
    for (const server of [old, current])
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
