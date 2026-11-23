import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { dashboardHandler, startDashboard } from "../src/dashboard/dashboard";
import type { DashboardSource } from "../src/dashboard/dashboard-model";
import type { Ownership } from "../src/lib/unix-socket";

const html =
  '<!doctype html><style>body { color: red; }</style><script>console.log("ok");</script>';

const fleet = { generatedAt: 1, ships: [] };

function fixture(overrides: Partial<DashboardSource> = {}, timeoutMs = 20_000) {
  const calls: unknown[] = [];
  const warnings: unknown[][] = [];

  const source: DashboardSource = {
    fleet: async (signal) => {
      calls.push(["fleet", signal]);

      return fleet;
    },
    ship: async (id, signal) => {
      calls.push(["ship", id, signal]);

      return undefined;
    },
    children: async (id, input, signal) => {
      calls.push(["sessions", id, input, signal]);

      return { sessions: [] };
    },
    entries: async (id, input, signal) => {
      calls.push(["entries", id, input, signal]);

      return { entries: [] };
    },
    ...overrides,
  };

  const controller = new AbortController();

  const log = pino(
    { level: "warn" },
    {
      write: (line) => {
        warnings.push([JSON.parse(line)]);
      },
    },
  );

  const options = { source, html, signal: controller.signal, log, timeoutMs };
  const handler = dashboardHandler(options);

  return {
    calls,
    warnings,
    controller,
    options,
    handler,
    get: (path: string, method = "GET") =>
      handler(new Request(`http://dashboard${path}`, { method })),
  };
}

test("HTML and API routes set private response headers and exact CSP hashes", async () => {
  const f = fixture();
  const page = await f.get("/");
  expect(await page.text()).toBe(html);
  expect(page.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  const policy = page.headers.get("Content-Security-Policy");

  for (const body of ["body { color: red; }", 'console.log("ok");']) {
    expect(policy).toContain(
      `'sha256-${createHash("sha256").update(body).digest("base64")}'`,
    );
  }

  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain("connect-src 'self'");
  expect(policy).not.toContain("unsafe-inline");

  for (const path of [
    "/",
    "/api/fleet",
    "/missing",
    "/api/ships/BAD",
    "/api/fleet?bad=1",
  ]) {
    const response = await f.get(path);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  }

  expect(await (await f.get("/api/fleet")).json()).toEqual(fleet);
  expect(
    await (
      await f.get("/api/ships/galactica/sessions?parent=pi%3Aabc&cursor=next")
    ).json(),
  ).toEqual({ sessions: [] });
  expect(
    await (
      await f.get(
        "/api/ships/galactica/entries?session=s1&cursor=&order=asc&detail=full&limit=50",
      )
    ).json(),
  ).toEqual({ entries: [] });
  expect(f.calls).toContainEqual([
    "sessions",
    "galactica",
    { parentID: "pi:abc", cursor: "next" },
    expect.any(AbortSignal),
  ]);
  expect(f.calls).toContainEqual([
    "entries",
    "galactica",
    { sessionID: "s1", order: "asc", detail: "full", limit: 50 },
    expect.any(AbortSignal),
  ]);
  await f.get("/api/ships/galactica/entries?session=s1");
  expect(f.calls).toContainEqual([
    "entries",
    "galactica",
    { sessionID: "s1", order: "desc", detail: "summary", limit: 30 },
    expect.any(AbortSignal),
  ]);
});

test("HEAD has GET status and headers but no body; other methods return 405", async () => {
  const f = fixture();

  for (const path of [
    "/",
    "/api/fleet",
    "/api/ships/galactica/sessions?parent=s1",
    "/api/ships/galactica/entries?session=s1",
    "/unknown",
    "/api/ships/BAD",
  ]) {
    const head = await f.get(path, "HEAD");
    const get = await f.get(path);
    expect(head.status).toBe(get.status);
    expect([...head.headers]).toEqual([...get.headers]);
    expect(await head.text()).toBe("");
  }

  for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
    const response = await f.get("/api/fleet", method);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
  }
});

test("unknown routes and undefined source results return safe 404", async () => {
  const f = fixture({
    children: async () => undefined,
    entries: async () => undefined,
  });

  for (const path of [
    "/missing",
    "/prefix/",
    "/api/fleet/",
    "/api/ships/ship/other",
    "/api/ships/ship",
    "/api/ships/ship/sessions?parent=x",
    "/api/ships/ship/entries?session=x",
  ]) {
    const response = await f.get(path);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  }
});

test("ship route returns source view without mutation", async () => {
  // A real view from the contract, with no transcript or credential fields.
  const ship = {
    generatedAt: 1,
    id: "ship",
    name: "Ship",
    bot: {
      id: "ship",
      slack: { appId: "A1", team: "T1", user: "U1" },
      access: {
        users: [],
        channels: [],
        deniedUsers: [],
        deniedChannels: [],
        mentionOnly: true,
      },
      backend: { type: "module" as const },
      concurrency: 1,
      turnTimeoutMs: 1000,
    },
    crew: null,
    queue: {
      counts: {
        queued: 0,
        running: 0,
        responding: 0,
        done: 0,
        failed: 0,
      },
      recent: [],
    },
    cron: { fileBacked: false, jobs: [], runs: [] },
    sessions: [],
    sessionsMore: false,
  };

  const f = fixture({ ship: async () => ship });
  const response = await f.get("/api/ships/ship");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(ship);
});

test("invalid and repeated parameters fail before reading the source", async () => {
  const f = fixture();

  const paths = [
    "/?x=1",
    "/api/fleet?cursor=1",
    "/api/ships/UPPER",
    `/api/ships/${"a".repeat(65)}`,
    "/api/ships/%2F",
    "/api/ships/-bad",
    "/api/ships/a?x=1",
    "/api/ships/a/sessions",
    "/api/ships/a/sessions?parent=",
    "/api/ships/a/sessions?parent=a&parent=b",
    "/api/ships/a/sessions?parent=a&limit=1",
    "/api/ships/a/entries",
    "/api/ships/a/entries?session=",
    "/api/ships/a/entries?session=a&cursor=x&cursor=y",
    "/api/ships/a/entries?session=a&unknown=x",
    "/api/ships/a/entries?session=a&order=random",
    "/api/ships/a/entries?session=a&detail=secret",
    ...["0", "51", "1.5", "NaN", "", "1e1", "-1"].map(
      (limit) => `/api/ships/a/entries?session=a&limit=${limit}`,
    ),
    `/api/ships/a/entries?session=${"x".repeat(513)}`,
    `/api/ships/a/entries?session=a&cursor=${"x".repeat(4097)}`,
  ];

  for (const path of paths) {
    const response = await f.get(path);
    expect(response.status, path).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request" });
  }

  expect(f.calls).toEqual([]);
});

test("history query bounds count Unicode code points", async () => {
  const f = fixture();
  const emoji = (count: number) => encodeURIComponent("😀".repeat(count));

  for (const path of [
    `/api/ships/a/sessions?parent=${emoji(512)}&cursor=${emoji(4096)}`,
    `/api/ships/a/entries?session=${emoji(512)}&cursor=${emoji(4096)}`,
  ])
    expect((await f.get(path)).status, path.slice(0, 40)).toBe(200);
  expect(f.calls).toHaveLength(2);

  for (const path of [
    `/api/ships/a/sessions?parent=${emoji(513)}`,
    `/api/ships/a/sessions?parent=a&cursor=${emoji(4097)}`,
    `/api/ships/a/entries?session=${emoji(513)}`,
    `/api/ships/a/entries?session=a&cursor=${emoji(4097)}`,
  ]) {
    const response = await f.get(path);
    expect(response.status, path.slice(0, 40)).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request" });
  }

  expect(f.calls).toHaveLength(2);
});

test("external assets and event handlers throw during handler creation", () => {
  const f = fixture();

  for (const asset of [
    '<script src="app.js"></script>',
    '<link rel="stylesheet" href="app.css">',
    '<style href="app.css"></style>',
    '<body onload="bad()">',
    "<button ONCLICK=bad()>",
    '<img src="//outside/image">',
    '<style>@import "https://outside/style.css";</style>',
    '<script src = "/local.js"></script>',
  ]) {
    expect(
      () => dashboardHandler({ ...f.options, html: asset }),
      asset,
    ).toThrow("self-contained");
  }
});

test("source exceptions produce one route-only warning and safe 502", async () => {
  const fail = async () => {
    throw new Error("SECRET session-id private-url");
  };

  const f = fixture({ fleet: fail, ship: fail, children: fail, entries: fail });

  for (const path of [
    "/api/fleet",
    "/api/ships/id",
    "/api/ships/id/sessions?parent=secret",
    "/api/ships/id/entries?session=secret",
  ]) {
    const response = await f.get(path);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Bad gateway" });
  }

  expect(f.warnings).toHaveLength(4);
  expect(JSON.stringify(f.warnings)).not.toMatch(
    /SECRET|session-id|private-url|parent=|session=|\/api/,
  );

  for (const route of ["fleet", "ship", "sessions", "entries"])
    expect(JSON.stringify(f.warnings)).toContain(`"route":"${route}"`);
});

test("deadline aborts source and returns 504 without logging source failure", async () => {
  let received: AbortSignal | undefined;

  const f = fixture(
    {
      fleet: async (signal) => {
        received = signal;

        return await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      },
    },
    1,
  );

  const response = await f.get("/api/fleet");
  expect(response.status).toBe(504);
  expect(received?.aborted).toBe(true);
  expect(f.warnings).toEqual([]);
});

test("shutdown aborts active work and rejects new API requests with 503", async () => {
  const started = Promise.withResolvers<AbortSignal>();

  const f = fixture({
    fleet: async (signal) => {
      started.resolve(signal);

      return await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });

  const response = f.get("/api/fleet");
  const signal = await started.promise;
  f.controller.abort();
  expect((await response).status).toBe(503);
  expect(signal.aborted).toBe(true);
  expect((await f.get("/api/fleet")).status).toBe(503);
  expect(f.warnings).toEqual([]);
});

test("eight API calls occupy slots; excess gets Retry-After; settled work releases slots", async () => {
  const release = Promise.withResolvers<typeof fleet>();
  const f = fixture({ fleet: () => release.promise });
  const active = Array.from({ length: 8 }, () => f.get("/api/fleet"));
  const excess = await f.get("/api/fleet");
  expect(excess.status).toBe(503);
  expect(excess.headers.get("Retry-After")).toBe("1");
  expect((await f.get("/")).status).toBe(200);
  release.resolve(fleet);
  expect(
    (await Promise.all(active)).every((response) => response.status === 200),
  ).toBe(true);
  expect((await f.get("/api/fleet")).status).toBe(200);
});

test("Unix socket replaces stale socket, serves HTTP, has mode 0600 and cleans up", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dashboard-test-"));
  const socket = join(directory, "dashboard.sock");
  await chmod(directory, 0o700);
  const stale = createServer();
  await new Promise<void>((resolve, reject) => {
    stale.once("error", reject);
    stale.listen(socket, resolve);
  });
  const stalePath = join(directory, "stale.sock");
  // Closing node's server removes its path; preserve a stale socket via rename.
  const { rename } = await import("node:fs/promises");
  await rename(socket, stalePath);
  await new Promise<void>((resolve, reject) =>
    stale.close((error) => (error ? reject(error) : resolve())),
  );
  await rename(stalePath, socket);
  const server = await startDashboard({ ...fixture().options, socket });

  try {
    expect((await lstat(socket)).mode & 0o777).toBe(0o600);

    const response = await fetch("http://localhost/api/fleet", {
      unix: socket,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(fleet);
  } finally {
    await server.stop();
    await server.stop();
    await expect(lstat(socket)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(directory, { recursive: true, force: true });
  }
});

test("Unix socket refuses regular files and non-private parent directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dashboard-test-"));
  const socket = join(directory, "dashboard.sock");

  try {
    await chmod(directory, 0o700);
    await writeFile(socket, "keep");
    await expect(
      startDashboard({ ...fixture().options, socket }),
    ).rejects.toThrow("not a socket");
    expect(await readFile(socket, "utf8")).toBe("keep");
    await unlink(socket);
    await chmod(directory, 0o750);
    await expect(
      startDashboard({ ...fixture().options, socket }),
    ).rejects.toThrow("private");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stop waits for underlying source work and removes the socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dashboard-test-"));
  const socket = join(directory, "dashboard.sock");
  await chmod(directory, 0o700);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<typeof fleet>();

  const f = fixture({
    fleet: () => {
      entered.resolve();

      return release.promise;
    },
  });

  const server = await startDashboard({ ...f.options, socket });

  try {
    const request = fetch("http://localhost/api/fleet", { unix: socket });
    await entered.promise;
    let stopped = false;

    const stopping = server.stop().then(() => {
      stopped = true;
    });

    expect((await request).status).toBe(503);
    expect(stopped).toBe(false);
    release.resolve(fleet);
    await stopping;
    expect(await Bun.file(socket).exists()).toBe(false);
  } finally {
    release.resolve(fleet);
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("timed-out uncancellable work retains its concurrency slot", async () => {
  const release = Promise.withResolvers<typeof fleet>();
  const f = fixture({ fleet: () => release.promise }, 1);

  try {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => f.get("/api/fleet")),
    );

    expect(responses.every((response) => response.status === 504)).toBe(true);
    expect((await f.get("/api/fleet")).status).toBe(503);
  } finally {
    release.resolve(fleet);
  }
});

const sharedLock: NonNullable<Ownership["lockCommand"]> = (path) => ({
  command: "python3",
  args: [
    "-u",
    "-c",
    "import fcntl,sys;f=open(sys.argv[1]);fcntl.flock(f,fcntl.LOCK_EX);print('R',flush=True);sys.stdin.read()",
    path,
  ],
});

test("opt-in shared Unix socket inherits the protected operator group and serves only reads", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "dashboard-shared-")),
  );

  const socket = join(directory, "http.sock");

  if (!process.getuid || !process.getgid) throw new Error("POSIX IDs required");
  await chown(directory, process.getuid(), process.getgid());
  await chmod(directory, 0o2750);

  const options = {
    ...fixture().options,
    socket,
    groupAccess: true,
    ownership: { lockCommand: sharedLock },
  };

  const server = await startDashboard(options);

  try {
    const parent = await lstat(directory),
      file = await lstat(socket);

    expect(file.mode & 0o777).toBe(0o660);
    expect(file.gid).toBe(parent.gid);
    expect(file.uid === process.getuid?.()).toBe(true);
    expect(
      await (
        await fetch("http://dashboard/api/fleet", { unix: socket })
      ).json(),
    ).toEqual(fleet);

    const head = await fetch("http://dashboard/api/fleet", {
      unix: socket,
      method: "HEAD",
    });

    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
      const response = await fetch("http://dashboard/api/fleet", {
        unix: socket,
        method,
      });

      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, HEAD");
    }

    await expect(startDashboard(options)).rejects.toThrow();
    expect(
      (await fetch("http://dashboard/api/fleet", { unix: socket })).status,
    ).toBe(200);
  } finally {
    await server.stop();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("shared dashboard refuses missing setgid, writable parents, symlinks and non-normalised paths", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "dashboard-shared-")),
  );

  const directory = join(root, "operator");
  await mkdir(directory, { mode: 0o700 });

  if (!process.getuid || !process.getgid) throw new Error("POSIX IDs required");
  await chown(directory, process.getuid(), process.getgid());

  const options = {
    ...fixture().options,
    socket: join(directory, "http.sock"),
    groupAccess: true,
    ownership: { lockCommand: sharedLock },
  };

  try {
    for (const mode of [0o700, 0o750, 0o2770, 0o2755]) {
      await chmod(directory, mode);
      await expect(startDashboard(options)).rejects.toThrow();
    }

    await chmod(directory, 0o2750);
    await chmod(root, 0o770);
    await expect(startDashboard(options)).rejects.toThrow();
    await chmod(root, 0o700);
    const link = join(root, "linked");
    await symlink(directory, link);
    await expect(
      startDashboard({ ...options, socket: join(link, "http.sock") }),
    ).rejects.toThrow();
    await expect(
      startDashboard({
        ...options,
        socket: directory + "/../operator/http.sock",
      }),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
