import { once } from "node:events";
import { lstatSync } from "node:fs";
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import { dirname } from "node:path";
import type { Logger } from "pino";
import { close } from "../lib/http-util";
import {
  type Ownership,
  type SocketIdentity,
  listenOnUnixSocket,
  unlinkOwnSocket,
} from "../lib/unix-socket";
import type { AgentKey } from "./certificate";
import { SubspaceFileError } from "./files";
import { mintAgentToken } from "./token";
import { type SubspaceUpstream, SubspaceUpstreamError } from "./upstream";

/** Request headers a caller may pass on; every other one is dropped. */
export const forwardedRequestHeaders = [
  "accept",
  "content-type",
  "if-match",
  "if-none-match",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "x-correlation-id",
] as const;

/** Response headers passed back; cookies and redirect targets never are. */
const returnedResponseHeaders = [
  "allow",
  "cache-control",
  "content-disposition",
  "content-type",
  "etag",
  "last-modified",
  "mcp-protocol-version",
  "mcp-session-id",
  "retry-after",
  "x-correlation-id",
] as const;

const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const maxRequestBytes = 8 * 1024 * 1024;
const maxResponseBytes = 64 * 1024 * 1024;
const maxConcurrent = 32;
const warningIntervalMs = 60_000;

/**
 * The upstream path for a request target, or undefined. Only origin-form
 * `/api/v1/` paths and the MCP endpoint `/mcp`, exactly as normalised: no
 * dot segments, encoded slashes, encoded dots, backslashes or fragments. The
 * query passes as sent.
 */
export function apiPath(target: string | undefined) {
  if (!target?.startsWith("/") || target.startsWith("//")) {
    return;
  }

  const query = target.indexOf("?");
  const path = query === -1 ? target : target.slice(0, query);

  if (/[\\#]|%(?:2f|5c|2e|00)/i.test(path)) {
    return;
  }

  const url = new URL(target, "http://officer.invalid");

  if (
    url.origin !== "http://officer.invalid" ||
    url.pathname !== path ||
    (url.pathname !== "/mcp" && !url.pathname.startsWith("/api/v1/"))
  ) {
    return;
  }

  return `${url.pathname}${url.search}`;
}

/** The proxy's own refusals; the bridge shows `error` to the harness. */
function refuse(response: ServerResponse, status: number, message: string) {
  if (response.headersSent) {
    response.destroy();

    return;
  }

  const text = JSON.stringify({ error: message, source: "stargate" });
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

class TooLarge extends Error {}

async function requestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;

    if (size > maxRequestBytes) {
      throw new TooLarge();
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

export type OfficerProxyOptions = {
  officer: string;
  socketPath: string;
  upstream: SubspaceUpstream;
  /** The officer's current key; rejects when its bundle is unusable. */
  key(): Promise<AgentKey>;
  log: Logger;
  fetch?: typeof fetch;
  /** Socket test seam (start-up lock command); production uses the defaults. */
  ownership?: Ownership;
};

/**
 * Refuses a socket directory that anyone besides the gateway user and its
 * group may enter. The group is the officer's engine group, so only that
 * officer's processes reach the socket.
 */
export function checkSocketDirectory(directory: string, officer: string) {
  const stats = lstatSync(directory);

  if ((stats.mode & 0o007) !== 0) {
    throw new SubspaceFileError(
      `${officer}'s Subspace socket directory must give others no access (for example mode 2750)`,
    );
  }

  return stats;
}

/**
 * One officer's signing proxy: a Unix socket that only that officer's engine
 * group can reach. Every request it forwards carries a fresh token signed
 * with that officer's key; the caller never sees the key or a token.
 */
export class OfficerProxy {
  private server: Server | undefined;
  private identity: SocketIdentity | undefined;
  private readonly stop = new AbortController();
  private readonly pending = new Set<Promise<void>>();
  private readonly warned = new Map<string, number>();
  private closed = false;

  private constructor(private readonly options: OfficerProxyOptions) {}

  public static async open(options: OfficerProxyOptions) {
    const proxy = new OfficerProxy(options);

    try {
      await proxy.listen();

      return proxy;
    } catch (error) {
      await proxy.close();
      throw error;
    }
  }

  /** One plain warning per kind and interval; never a header, body or token. */
  private warn(kind: string, message: string, status?: number) {
    const now = Date.now();

    if (now - (this.warned.get(kind) ?? 0) < warningIntervalMs) {
      return;
    }

    this.warned.set(kind, now);
    this.options.log.warn(status === undefined ? {} : { status }, message);
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const method = request.method ?? "";
    const path = apiPath(request.url);

    if (!methods.has(method)) {
      refuse(response, 405, "This method is not forwarded to the Subspace API");

      return;
    }

    if (!path) {
      refuse(
        response,
        404,
        "Only /api/v1/ paths and /mcp reach the Subspace API",
      );

      return;
    }

    if (this.pending.size >= maxConcurrent) {
      refuse(response, 503, "Too many Subspace API requests at once; retry");

      return;
    }

    const disconnected = new AbortController();
    response.once("close", () => {
      if (!response.writableFinished) {
        disconnected.abort();
      }
    });

    const signal = AbortSignal.any([
      this.stop.signal,
      disconnected.signal,
      AbortSignal.timeout(this.options.upstream.timeoutMs),
    ]);

    let body: Buffer | undefined;

    try {
      body =
        method === "GET" || method === "HEAD"
          ? undefined
          : await requestBody(request);
    } catch (error) {
      refuse(
        response,
        error instanceof TooLarge ? 413 : 400,
        error instanceof TooLarge
          ? "The request body is too large"
          : "The request body could not be read",
      );

      return;
    }

    const headers = new Headers();

    for (const name of forwardedRequestHeaders) {
      const value = request.headers[name];

      if (typeof value === "string") {
        headers.set(name, value);
      }
    }

    let upstream: Response;

    try {
      for (const [name, value] of this.options.upstream.accessHeaders()) {
        headers.set(name, value);
      }

      const key = await this.options.key();

      headers.set(
        "authorization",
        `Bearer ${mintAgentToken(key, this.options.upstream.audience)}`,
      );
      upstream = await (this.options.fetch ?? fetch)(
        `${this.options.upstream.base}${path}`,
        {
          method,
          headers,
          ...(body && body.length > 0 && { body: new Uint8Array(body) }),
          // A redirect is returned, never followed, and its target withheld.
          redirect: "manual",
          signal,
        },
      );
    } catch (error) {
      if (error instanceof SubspaceUpstreamError) {
        refuse(response, 503, error.message);

        return;
      }

      if (error instanceof SubspaceFileError) {
        this.warn("key", "Subspace officer key unavailable");
        refuse(
          response,
          503,
          "This officer's Subspace key is unavailable; run stargate subspace enrol",
        );

        return;
      }

      if (this.stop.signal.aborted || disconnected.signal.aborted) {
        response.destroy();

        return;
      }

      const timedOut = signal.aborted;
      this.warn(
        timedOut ? "timeout" : "unreachable",
        timedOut
          ? "The Subspace API did not answer in time"
          : "The Subspace API is unreachable",
      );
      refuse(
        response,
        timedOut ? 504 : 502,
        timedOut
          ? "The Subspace API did not answer in time"
          : "The Subspace API is unreachable",
      );

      return;
    }

    if (upstream.status === 401 || upstream.status === 403) {
      this.warn(
        "refused",
        "The Subspace API refused this officer's agent token; check its enrolment",
        upstream.status,
      );
    }

    await this.relay(upstream, response, signal);
  }

  /** Status, allowed headers and the body as it streams, bounded in size. */
  private async relay(
    upstream: Response,
    response: ServerResponse,
    signal: AbortSignal,
  ) {
    const headers: Record<string, string> = {};

    for (const name of returnedResponseHeaders) {
      const value = upstream.headers.get(name);

      if (value !== null) {
        headers[name] = value;
      }
    }

    response.writeHead(upstream.status, headers);
    const reader = upstream.body?.getReader();
    let size = 0;

    try {
      for (;;) {
        if (!reader) {
          break;
        }

        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        size += value.byteLength;

        if (size > maxResponseBytes) {
          throw new TooLarge();
        }

        if (!response.write(value)) {
          await once(response, "drain", { signal });
        }
      }

      response.end();
    } catch {
      await reader?.cancel().catch(() => {});
      response.destroy();
    }
  }

  private async listen() {
    const directory = dirname(this.options.socketPath);
    const before = checkSocketDirectory(directory, this.options.officer);

    const server = createServer((request, response) => {
      const operation = this.handle(request, response).catch(() => {
        // Never let one request stop the gateway; withhold the cause.
        refuse(response, 500, "The signing proxy failed this request");
      });

      this.pending.add(operation);
      void operation.finally(() => {
        this.pending.delete(operation);
      });
    });

    this.server = server;
    this.identity = await listenOnUnixSocket(
      server,
      this.options.socketPath,
      this.options.ownership,
    );

    // Without the setgid bit some systems give the socket the gateway's own
    // Group, and the officer could not connect; say so instead of failing quietly.
    if (
      (before.mode & 0o070) !== 0 &&
      lstatSync(this.options.socketPath).gid !== before.gid
    ) {
      throw new SubspaceFileError(
        `${this.options.officer}'s Subspace socket did not get its directory's group; set the directory's setgid bit (mode 2750)`,
      );
    }
  }

  public async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.stop.abort();

    if (this.server) {
      await close(this.server);
    }

    await Promise.allSettled(this.pending);
    unlinkOwnSocket(
      this.options.socketPath,
      this.identity,
      this.options.ownership,
    );
    this.identity = undefined;
  }
}
