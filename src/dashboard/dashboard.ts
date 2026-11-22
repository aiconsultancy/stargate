import { createHash } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { Option, Schema } from "effect";
import type { Logger } from "pino";
import { dashboardBranding, isDashboardFavicon } from "./dashboard-branding";
import type { DashboardSource } from "./dashboard-model";
import {
  historyChildrenInputSchema,
  historyEntriesInputSchema,
} from "../shared/session-history";
import { close as closeHttpServer } from "../lib/http-util";
import {
  listenOnUnixSocket,
  type Ownership,
  type SocketIdentity,
  unlinkOwnSocket,
} from "../lib/unix-socket";

const decodeChildren = Schema.decodeUnknownOption(historyChildrenInputSchema);
const decodeEntries = Schema.decodeUnknownOption(historyEntriesInputSchema);

type Options = {
  source: DashboardSource;
  html: string;
  signal: AbortSignal;
  log: Pick<Logger, "warn">;
  /** Test seam; production uses a twenty-second deadline. */
  timeoutMs?: number;
};

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

function contentPolicy(html: string): string {
  const hashes = { script: new Set<string>(), style: new Set<string>() };

  // Reject external assets; only exact bundled favicon data may use link href.
  if (
    /(?:https?|wss?|ftp):\/\/|(?:url\(\s*["']?|@import\s*["'])\s*\/\//i.test(
      html,
    )
  ) {
    throw new Error("Dashboard HTML must be self-contained");
  }

  let block: { kind: "script" | "style"; body: string } | undefined;
  new HTMLRewriter()
    .on("*", {
      element(element) {
        const name = element.tagName;

        const favicon =
          name === "link" &&
          element.getAttribute("rel") === "icon" &&
          element.getAttribute("type") === "image/png" &&
          element.getAttribute("sizes") === "32x32" &&
          isDashboardFavicon(element.getAttribute("href") ?? "") &&
          [null, "(prefers-color-scheme: dark)"].includes(
            element.getAttribute("media"),
          ) &&
          [...element.attributes].every(([key]) =>
            ["rel", "type", "sizes", "href", "media"].includes(key),
          );

        for (const [key, value] of element.attributes) {
          const embeddedFavicon =
            favicon && key === "href" && isDashboardFavicon(value);

          if (
            key.startsWith("on") ||
            ((name === "script" || name === "style" || name === "link") &&
              (key === "src" || key === "href") &&
              !embeddedFavicon) ||
            (/^\s*(?:[a-z][\w+.-]*:|\/\/)/i.test(value) &&
              !(name === "img" && key === "src" && /^data:/i.test(value)) &&
              !embeddedFavicon)
          ) {
            throw new Error("Dashboard HTML must be self-contained");
          }
        }

        if (name === "script" || name === "style") {
          const inline = { kind: name, body: "" } satisfies {
            kind: "script" | "style";
            body: string;
          };

          block = inline;
          element.onEndTag(() => {
            hashes[inline.kind].add(
              `'sha256-${createHash("sha256").update(inline.body).digest("base64")}'`,
            );
            block = undefined;
          });
        }
      },
    })
    .on("script, style", {
      text(text) {
        if (block) block.body += text.text;
      },
    })
    .transform(html);

  if (block)
    throw new Error("Dashboard HTML contains an unclosed inline block");

  return [
    "default-src 'none'",
    `script-src ${[...hashes.script].join(" ") || "'none'"}`,
    `style-src ${[...hashes.style].join(" ") || "'none'"}`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function createDashboard(options: Options) {
  const html = dashboardBranding(options.html);
  const policy = contentPolicy(html);
  const pending = new Set<Promise<unknown>>();

  async function fetch(request: Request): Promise<Response> {
    const head = request.method === "HEAD";

    const respond = (
      status: number,
      body: unknown,
      extra: Record<string, string> = {},
    ) =>
      new Response(head ? null : JSON.stringify(body), {
        status,
        headers: {
          ...headers,
          "Content-Type": "application/json; charset=utf-8",
          ...extra,
        },
      });

    const error = (
      status: number,
      text: string,
      extra?: Record<string, string>,
    ) => respond(status, { error: text }, extra);

    if (request.method !== "GET" && !head) {
      return error(405, "Method not allowed", { Allow: "GET, HEAD" });
    }

    const url = new URL(request.url);

    const route = /^\/api\/ships\/([^/]+)(?:\/(sessions|entries))?$/.exec(
      url.pathname,
    );

    const kind =
      url.pathname === "/api/fleet" ? "fleet" : (route?.[2] ?? "ship");

    if (url.pathname !== "/" && url.pathname !== "/api/fleet" && !route) {
      return error(404, "Not found");
    }

    const allowed =
      kind === "sessions"
        ? ["parent", "cursor"]
        : kind === "entries"
          ? ["session", "cursor", "order", "detail", "limit"]
          : [];

    for (const key of url.searchParams.keys()) {
      if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) {
        return error(400, "Invalid request");
      }
    }

    if (url.pathname === "/") {
      return new Response(head ? null : html, {
        headers: {
          ...headers,
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": policy,
        },
      });
    }

    const id = route?.[1] ?? "";

    if (route && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
      return error(400, "Invalid request");
    }

    const query = Object.fromEntries(url.searchParams);

    const children = decodeChildren({
      parentID: query["parent"],
      ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
    });

    const entries = decodeEntries({
      sessionID: query["session"],
      ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
      ...(query["order"] !== undefined ? { order: query["order"] } : {}),
      ...(query["detail"] !== undefined ? { detail: query["detail"] } : {}),
      ...(query["limit"] !== undefined
        ? {
            limit: /^\d+$/.test(query["limit"])
              ? Number(query["limit"])
              : Number.NaN,
          }
        : {}),
    });

    if (
      (kind === "sessions" && Option.isNone(children)) ||
      (kind === "entries" && Option.isNone(entries))
    ) {
      return error(400, "Invalid request");
    }

    if (options.signal.aborted) return error(503, "Service unavailable");

    if (pending.size >= 8)
      return error(503, "Service unavailable", { "Retry-After": "1" });

    const signal = AbortSignal.any([
      options.signal,
      AbortSignal.timeout(options.timeoutMs ?? 20_000),
    ]);

    const work = Promise.resolve().then<unknown>(() => {
      switch (kind) {
        case "fleet":
          return options.source.fleet(signal);
        case "sessions":
          if (Option.isSome(children))
            return options.source.children(
              id,
              {
                parentID: children.value.parentID,
                ...(children.value.cursor === undefined
                  ? {}
                  : { cursor: children.value.cursor }),
              },
              signal,
            );
          break;
        case "entries":
          if (Option.isSome(entries))
            return options.source.entries(id, entries.value, signal);
          break;
        default:
          return options.source.ship(id, signal);
      }

      return undefined;
    });

    pending.add(work);
    // Keep the slot until underlying work ends, even if it ignores cancellation.
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    let onAbort = () => {};

    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });

      if (signal.aborted) onAbort();
    });

    try {
      const result = await Promise.race([work, aborted]);

      return result === undefined
        ? error(404, "Not found")
        : respond(200, result);
    } catch {
      if (options.signal.aborted) return error(503, "Service unavailable");

      if (signal.aborted) return error(504, "Gateway timeout");
      options.log.warn({ route: kind }, "Dashboard source failed");

      return error(502, "Bad gateway");
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  return {
    fetch,
    drain: async () => {
      await Promise.allSettled([...pending]);
    },
  };
}

export function dashboardHandler(
  options: Options,
): (request: Request) => Promise<Response> {
  return createDashboard(options).fetch;
}

export async function startDashboard(
  options: Options & {
    socket: string;
    groupAccess?: boolean;
    ownership?: Ownership;
  },
): Promise<{ stop(): Promise<void> }> {
  const parent = await lstat(dirname(options.socket));

  if (
    !parent.isDirectory() ||
    parent.uid !== process.getuid?.() ||
    (options.groupAccess
      ? (parent.mode & 0o7777) !== 0o2750
      : (parent.mode & 0o077) !== 0)
  ) {
    throw new Error(
      options.groupAccess
        ? "Shared dashboard socket directory must be owned by the current user with mode 2750 and its operator group"
        : "Dashboard socket directory must be private and owned by the current user",
    );
  }

  const shutdown = new AbortController();

  const dashboard = createDashboard({
    ...options,
    signal: AbortSignal.any([options.signal, shutdown.signal]),
  });

  if (options.groupAccess) {
    // The existing listener checks every ancestor and binds under umask 0117.
    // The setgid directory controls the operator group; no chgrp or home access.
    const server = createServer((request, response) => {
      request.resume();
      void Promise.resolve()
        .then(() =>
          dashboard.fetch(
            new Request(new URL(request.url ?? "/", "http://dashboard.local"), {
              method:
                request.method === "GET" || request.method === "HEAD"
                  ? request.method
                  : "POST",
            }),
          ),
        )
        .then(async (result) => {
          response.writeHead(result.status, Object.fromEntries(result.headers));
          response.end(Buffer.from(await result.arrayBuffer()));
        })
        .catch(() => {
          if (!response.headersSent)
            response.writeHead(502, { "Cache-Control": "no-store" });
          response.end();
        });
    });

    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 1000;
    let identity: SocketIdentity | undefined;

    try {
      identity = await listenOnUnixSocket(
        server,
        options.socket,
        options.ownership,
      );
    } catch (error) {
      await closeHttpServer(server);
      throw error;
    }

    let stopping: Promise<void> | undefined;

    return {
      stop() {
        stopping ??= (async () => {
          shutdown.abort();
          await closeHttpServer(server);
          await dashboard.drain();
          unlinkOwnSocket(options.socket, identity, options.ownership);
        })();

        return stopping;
      },
    };
  }

  const old = await socketStat(options.socket);

  if (old) {
    if (!old.isSocket())
      throw new Error("Dashboard socket path is not a socket");
    await unlink(options.socket);
  }

  const server = Bun.serve({
    unix: options.socket,
    fetch(request, server) {
      server.timeout(request, 30);

      return dashboard.fetch(request);
    },
  });

  // Bun removes its socket path on stop. The caller's exclusive lock on this
  // Directory means no other process creates that path meanwhile.
  try {
    await chmod(options.socket, 0o600);
  } catch (error) {
    await server.stop(true);
    throw error;
  }

  let stopping: Promise<void> | undefined;

  return {
    stop() {
      stopping ??= (async () => {
        shutdown.abort();
        await server.stop();
        await dashboard.drain();
      })();

      return stopping;
    },
  };
}

async function socketStat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}
