import { createHash } from "node:crypto";
import type {
  CheckoutDiff,
  CheckoutDiffFile,
  CheckoutDiffInput,
  DiffMode,
} from "../../../../coordination/crew/reporting/fleet-status";
import type {
  V1Diff,
  V1DiffContent,
  V1DiffFile,
  V1DiffFilePage,
  V1DiffMode,
} from "./types";

/** Reads one crew diff page from a ship's captain; undefined when it cannot. */
export type CrewDiffSource = (
  ship: string,
  input: CheckoutDiffInput,
  signal: AbortSignal,
) => Promise<CheckoutDiff | undefined>;

export type CrewDiffRead = number | V1Diff | V1DiffFilePage;

export type CrewDiffApi = {
  read(
    route: { ship: string; member: string; file: boolean },
    query: URLSearchParams,
    signal: AbortSignal,
  ): Promise<CrewDiffRead>;
};

/** `/api/v1/ships/{id}/crew/{member}/diff` and its `/file` route. */
export const crewDiffRoute =
  /^\/api\/v1\/ships\/([^/]+)\/crew\/([^/]+)\/diff(\/file)?$/;

const limits = {
  /** Computations at once, per gateway. */
  slots: 2,
  budgetMs: 10_000,
  cacheMs: 30_000,
  cacheEntries: 16,
  cacheBytes: 16 * 1024 * 1024,
};

const modes = new Set<string>(["branch", "committed", "working"]);
const fingerprintPattern = /^[a-f0-9]{32}$/;
const projectPattern = /^[a-z][a-z0-9_-]{0,47}$/;

const parameters = {
  list: new Set(["mode", "project", "page"]),
  file: new Set(["mode", "project", "path", "at", "page", "side"]),
};

/**
 * The path rule of the status file reader: repository-relative, with no
 * empty, `.` or `..` component, NUL, backslash or control character.
 */
export function diffPathAllowed(path: string) {
  return (
    path.length > 0 &&
    // Code points, as the plugin's schema counts them.
    Array.from(path).length <= 4096 &&
    !/[\p{Cc}\\]/u.test(path) &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

type Cursor = {
  /** Which request continues. */
  k: "list" | "patch" | "content";
  /** The fingerprint it belongs to. */
  f: string;
  /** Where the next page starts: a file index or a byte offset. */
  o: number;
  /** The scope it was issued for: target, mode and path. */
  h: string;
  s?: "old" | "new";
};

const scopeOf = (parts: unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);

const encodeCursor = (cursor: Cursor) =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");

function decodeCursor(text: string): Cursor | undefined {
  if (text.length > 512 || !/^[A-Za-z0-9_-]+$/.test(text)) {
    return;
  }

  try {
    const value: unknown = JSON.parse(
      Buffer.from(text, "base64url").toString("utf8"),
    );

    if (typeof value !== "object" || value === null) {
      return;
    }

    const { k, f, o, h, s } = value as Record<string, unknown>;

    if (
      (k !== "list" && k !== "patch" && k !== "content") ||
      typeof f !== "string" ||
      !fingerprintPattern.test(f) ||
      typeof o !== "number" ||
      !Number.isSafeInteger(o) ||
      o < 0 ||
      typeof h !== "string" ||
      (k === "content" ? s !== "old" && s !== "new" : s !== undefined) ||
      Object.keys(value).length !== (k === "content" ? 5 : 4)
    ) {
      return;
    }

    return { k, f, o, h, ...(k === "content" && { s: s as "old" | "new" }) };
  } catch {
    return;
  }
}

type Query = {
  mode: DiffMode;
  project: string | null;
  path?: string;
  at?: string;
  page?: string;
  side?: "old" | "new";
};

function parseQuery(query: URLSearchParams, file: boolean): Query | undefined {
  const allowed = file ? parameters.file : parameters.list;
  const values = new Map<string, string>();

  for (const [key, value] of query) {
    if (!allowed.has(key) || values.has(key)) {
      return;
    }

    values.set(key, value);
  }

  const mode = values.get("mode") ?? "branch";
  const project = values.get("project");
  const path = values.get("path");
  const at = values.get("at");
  const side = values.get("side");
  const page = values.get("page");

  if (
    !modes.has(mode) ||
    (project !== undefined && !projectPattern.test(project)) ||
    (file && (path === undefined || !diffPathAllowed(path))) ||
    (at !== undefined && !fingerprintPattern.test(at)) ||
    (side !== undefined && side !== "old" && side !== "new")
  ) {
    return;
  }

  return {
    mode: mode as DiffMode,
    project: project ?? null,
    ...(path !== undefined && { path }),
    ...(at !== undefined && { at }),
    ...(page !== undefined && { page }),
    ...(side !== undefined && { side }),
  };
}

type Target = { ship: string; member: string; project: string | null };

/** The plugin request for a query, or the status that refuses it. */
function plan(
  target: Target,
  query: Query,
  file: boolean,
): { input: CheckoutDiffInput; scope: string } | number {
  const base = {
    member: target.member,
    project: target.project,
    mode: query.mode,
  };

  if (!file) {
    const scope = scopeOf(["list", target, query.mode]);

    if (query.page === undefined) {
      return { input: { ...base, request: { kind: "list", start: 0 } }, scope };
    }

    const cursor = decodeCursor(query.page);

    if (cursor?.k !== "list" || cursor.h !== scope || cursor.o === 0) {
      return 400;
    }

    return {
      input: {
        ...base,
        at: cursor.f,
        request: { kind: "list", start: cursor.o },
      },
      scope,
    };
  }

  const path = query.path ?? "";
  const scope = scopeOf(["file", target, query.mode, path]);
  const at = query.at === undefined ? {} : { at: query.at };

  if (query.page === undefined) {
    return {
      input: {
        ...base,
        ...at,
        request:
          query.side === undefined
            ? { kind: "patch", path, offset: 0 }
            : { kind: "content", path, side: query.side, offset: 0 },
      },
      scope,
    };
  }

  const cursor = decodeCursor(query.page);

  if (
    !cursor ||
    cursor.k === "list" ||
    cursor.h !== scope ||
    (query.at !== undefined && query.at !== cursor.f) ||
    (cursor.k === "patch" && query.side !== undefined) ||
    (cursor.k === "content" &&
      query.side !== undefined &&
      query.side !== cursor.s)
  ) {
    return 400;
  }

  return {
    input: {
      ...base,
      at: cursor.f,
      request:
        cursor.k === "patch"
          ? { kind: "patch", path, offset: cursor.o }
          : { kind: "content", path, side: cursor.s, offset: cursor.o },
    },
    scope,
  };
}

const targetKey = (target: Target) =>
  JSON.stringify([target.ship, target.member, target.project]);

/** Roughly what an answer holds in memory: UTF-16 text counts thrice. */
function cachedBytes(value: CheckoutDiff) {
  switch (value.kind) {
    case "list":
      return value.files.reduce(
        (sum, file) => sum + 512 + (file.patch?.length ?? 0) * 3,
        0,
      );
    case "patch":
      return (value.file.patch?.length ?? 0) * 3;
    case "content":
      return value.data.length;
    default:
      return 0;
  }
}

type Cached = {
  target: string;
  at: number;
  bytes: number;
  value: CheckoutDiff;
};

/** The computation outcome: an answer, no answer, or the budget ran out. */
type Outcome = CheckoutDiff | undefined | "timeout";

/** The v1 shape of a plugin answer: cursors are made here, never there. */
function present(
  target: Target,
  mode: V1DiffMode,
  result: CheckoutDiff,
): CrewDiffRead {
  const fileScope = (path: string) => scopeOf(["file", target, mode, path]);

  const file = (entry: CheckoutDiffFile, fingerprint: string): V1DiffFile => ({
    path: entry.path,
    previousPath: entry.previousPath,
    status: entry.status,
    additions: entry.additions,
    deletions: entry.deletions,
    ...(entry.untracked && { untracked: true }),
    ...(entry.binary && { binary: true }),
    ...(entry.size !== undefined && { size: entry.size }),
    patch: entry.patch,
    ...(entry.patchNext !== undefined && {
      patchNextPage: encodeCursor({
        k: "patch",
        f: fingerprint,
        o: entry.patchNext,
        h: fileScope(entry.path),
      }),
    }),
    ...(entry.kind && { kind: entry.kind }),
  });

  switch (result.kind) {
    case "missing":
    case "absent":
      return 404;
    case "stale":
      return 409;
    case "list":
      return {
        ...target,
        mode,
        fingerprint: result.fingerprint,
        unstable: result.unstable,
        branch: result.branch,
        base: result.base,
        head: result.head,
        total: result.total,
        additions: result.additions,
        deletions: result.deletions,
        files: result.files.map((entry) => file(entry, result.fingerprint)),
        ...(result.next !== null && {
          nextPage: encodeCursor({
            k: "list",
            f: result.fingerprint,
            o: result.next,
            h: scopeOf(["list", target, mode]),
          }),
        }),
      };
    case "patch":
      return {
        fingerprint: result.fingerprint,
        file: file(result.file, result.fingerprint),
      };
    case "content": {
      const content: V1DiffContent = {
        side: result.side,
        encoding: "base64",
        offset: result.offset,
        size: result.size,
        data: result.data,
        ...(result.next !== null && {
          nextPage: encodeCursor({
            k: "content",
            f: result.fingerprint,
            o: result.next,
            h: fileScope(result.file.path),
            s: result.side,
          }),
        }),
      };

      return {
        fingerprint: result.fingerprint,
        file: { ...file(result.file, result.fingerprint), patch: null },
        content,
      };
    }
  }
}

type Flight = {
  key: string;
  result: Promise<Outcome>;
  controller: AbortController;
  waiters: number;
};

/**
 * Crew diffs for the operator listener. At most two computations run at
 * once, apart from the shared Fleet read slots; identical requests share
 * one; answers pinned to a fingerprint are kept 30 seconds in memory.
 */
export function crewDiffApi(
  source: CrewDiffSource,
  options: { budgetMs?: number; now?: () => number } = {},
): CrewDiffApi {
  const budgetMs = options.budgetMs ?? limits.budgetMs;
  const now = options.now ?? performance.now.bind(performance);
  const flights = new Map<string, Flight>();
  const cache = new Map<string, Cached>();
  let cacheBytes = 0;
  let running = 0;

  function evict(predicate: (key: string, entry: Cached) => boolean) {
    for (const [key, entry] of cache) {
      if (predicate(key, entry)) {
        cache.delete(key);
        cacheBytes -= entry.bytes;
      }
    }
  }

  function remember(target: string, key: string, value: CheckoutDiff) {
    const bytes = cachedBytes(value);

    if (bytes > limits.cacheBytes) {
      return;
    }

    const old = cache.get(key);

    if (old) {
      cache.delete(key);
      cacheBytes -= old.bytes;
    }

    cache.set(key, { target, at: now(), bytes, value });
    cacheBytes += bytes;

    // Oldest first: a Map keeps insertion order.
    for (const [first, entry] of cache) {
      if (
        cache.size <= limits.cacheEntries &&
        cacheBytes <= limits.cacheBytes
      ) {
        break;
      }

      cache.delete(first);
      cacheBytes -= entry.bytes;
    }
  }

  /** Forget `flight`, unless a newer computation already took its key. */
  function leave(flight: Flight) {
    if (flights.get(flight.key) === flight) {
      flights.delete(flight.key);
    }
  }

  /** Start or join the computation for `key`; undefined when slots are full. */
  function join(key: string, run: (signal: AbortSignal) => Promise<Outcome>) {
    const current = flights.get(key);

    if (current) {
      return current;
    }

    if (running >= limits.slots) {
      return;
    }

    const controller = new AbortController();

    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(budgetMs),
    ]);

    // The slot stays taken until the computation, and so Git, has ended:
    // Its flight may have left `flights` long before.
    running++;

    const flight: Flight = {
      key,
      result: run(signal).finally(() => {
        running--;
        leave(flight);
      }),
      controller,
      waiters: 0,
    };

    // Waiters see the outcome; this keeps an unwatched failure handled.
    flight.result.catch(() => {});
    flights.set(key, flight);

    return flight;
  }

  async function wait(flight: Flight, signal: AbortSignal) {
    flight.waiters++;

    const left = Promise.withResolvers<never>();

    const onAbort = () => {
      left.reject(signal.reason);
    };

    signal.addEventListener("abort", onAbort, { once: true });

    try {
      signal.throwIfAborted();

      return await Promise.race([flight.result, left.promise]);
    } finally {
      signal.removeEventListener("abort", onAbort);

      // The last waiter to leave stops the computation and Git. While it
      // Unwinds nobody may join it: an identical request starts afresh.
      if (--flight.waiters === 0) {
        flight.controller.abort();
        leave(flight);
      }
    }
  }

  return {
    async read(route, raw, signal) {
      const query = parseQuery(raw, route.file);

      if (!query) {
        return 400;
      }

      const target: Target = {
        ship: route.ship,
        member: route.member,
        project: query.project,
      };

      const planned = plan(target, query, route.file);

      if (typeof planned === "number") {
        return planned;
      }

      const { input } = planned;
      const tkey = targetKey(target);

      const keyAt = (at: string | undefined) =>
        JSON.stringify([tkey, input.mode, input.request, at ?? null]);

      const key = keyAt(input.at);

      evict((_key, entry) => now() - entry.at > limits.cacheMs);

      // Only an answer pinned to a fingerprint may come from memory.
      const hit = input.at === undefined ? undefined : cache.get(key);

      if (hit) {
        return present(target, query.mode, hit.value);
      }

      const flight = join(key, async (computing) => {
        try {
          return await source(target.ship, input, computing);
        } catch (error) {
          if (
            computing.reason instanceof DOMException &&
            computing.reason.name === "TimeoutError"
          ) {
            return "timeout";
          }

          throw error;
        }
      });

      if (!flight) {
        return 503;
      }

      const result = await wait(flight, signal).catch((error: unknown) => {
        signal.throwIfAborted();

        throw error;
      });

      if (result === "timeout") {
        return 503;
      }

      if (!result) {
        return 404;
      }

      if (result.kind === "stale") {
        evict((_key, entry) => entry.target === tkey);
      } else if (
        result.kind !== "missing" &&
        // Nothing asks again for a fresh first page or an unstable list.
        !(result.kind === "list" && (result.unstable || input.at === undefined))
      ) {
        remember(tkey, keyAt(result.fingerprint), result);
      }

      return present(target, query.mode, result);
    },
  };
}
