import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { lstat, mkdir, stat } from "node:fs/promises";
import { type IncomingMessage, request } from "node:http";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { Schema } from "effect";
import {
  officerFleetSockets,
  subspaceAgentsSection,
} from "../src/config/composition";
import {
  flockCommand,
  setDefaultLockCommandForTests,
} from "../src/lib/unix-socket";
import {
  type OfficerSocket,
  checkOfficerSocketPaths,
  officerTarget,
  runFleetRequest,
} from "../src/observability/dashboard/api/v1/officers";
import { startApiV1Server } from "../src/observability/dashboard/api/v1/server";
import { apiToken } from "../src/observability/dashboard/api/v1/token";
import type {
  ApiV1Source,
  V1CrewMember,
  V1Fleet,
  V1ShipDetail,
} from "../src/observability/dashboard/api/v1/types";
import {
  captain,
  childDirectory,
  overSocket,
  ownership,
  privateDirectory,
  removeDirectories,
} from "./subspace-fixture";

const cleanup: (() => unknown)[] = [];

// Util-linux flock is absent on some development hosts; the fixture's is not.
beforeAll(() => {
  if (ownership.lockCommand) {
    setDefaultLockCommandForTests(ownership.lockCommand);
  }
});

afterAll(() => {
  setDefaultLockCommandForTests(flockCommand);
});

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }

  await removeDirectories();
});

const member: V1CrewMember = {
  id: "engineer",
  name: "Engineer",
  role: null,
  model: null,
  backend: "opencode",
  activity: "idle",
  since: null,
  idleSince: null,
  contexts: [],
  subagents: [],
};

const ship: V1ShipDetail = {
  id: "explorer",
  name: "Explorer",
  captain: {
    id: "explorer",
    name: "Explorer",
    role: "captain",
    transport: "irc",
    backend: "opencode",
    model: null,
    queue: { queued: 0, running: 0, responding: 0, done: 0, failed: 0 },
    activity: "idle",
    since: null,
  },
  repository: null,
  available: true,
  crew: { people: 1, busy: 0, queued: 0 },
  features: [],
  crewMembers: [member],
};

const { crewMembers: _crew, ...summary } = ship;

// Two ships: an officer of one reads the other's too.
const source: ApiV1Source = {
  fleet: async () => ({
    apiVersion: 1,
    generatedAt: 123_456_789,
    name: "ignored",
    admiral: null,
    ships: [summary, { ...summary, id: "surveyor", name: "Surveyor" }],
    longestIdle: null,
  }),
  ship: async (id) => (id === ship.id ? ship : undefined),
  crew: async (id, name) =>
    id === ship.id && name === member.id ? { ship: id, member } : undefined,
  gatewayFeatures: () => [],
};

const gateway = {
  version: "1.2.3",
  opencodeVersion: async () => null,
  startedAt: 123_456_000,
};

/** Officers' directories under one parent, each with an exact mode. */
async function officerDirectories(modes: Record<string, number>) {
  const parent = await privateDirectory("sg-");
  const sockets: OfficerSocket[] = [];

  for (const [officer, mode] of Object.entries(modes)) {
    sockets.push({
      officer,
      socketPath: join(
        await childDirectory(parent, officer, mode),
        "fleet-api.sock",
      ),
    });
  }

  return sockets;
}

async function start(officers: readonly OfficerSocket[], listen?: string) {
  const dataDirectory = await privateDirectory();
  const shutdown = new AbortController();

  const server = await startApiV1Server({
    ...(listen && { config: { listen, fleetName: "Example fleet" } }),
    officers,
    dataDirectory,
    source,
    diff: () => [],
    gateway,
    signal: shutdown.signal,
  });

  cleanup.push(() => server.stop());

  return { server, dataDirectory };
}

const json = (answer: { body: string }) => JSON.parse(answer.body) as unknown;

test("officers: each reads the whole fleet on its own socket, with no token", async () => {
  const officers = await officerDirectories({
    "captain-a": 0o2750,
    "captain-b": 0o700,
  });

  await start(officers);

  for (const { socketPath } of officers) {
    const fleet = await overSocket(socketPath, "GET", "/api/v1/fleet");

    expect(fleet.status).toBe(200);
    expect(fleet.headers["cache-control"]).toBe("no-store");
    expect(json(fleet)).toMatchObject({
      ships: [{ id: "explorer" }, { id: "surveyor" }],
      gateway: { version: "1.2.3" },
    });
    expect(
      json(await overSocket(socketPath, "GET", "/api/v1/ships/explorer")),
    ).toEqual(ship);
    expect(
      json(
        await overSocket(
          socketPath,
          "GET",
          "/api/v1/ships/explorer/crew/engineer",
        ),
      ),
    ).toEqual({ ship: "explorer", member });

    const head = await overSocket(socketPath, "HEAD", "/api/v1/ships/explorer");

    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    // A token is neither needed nor checked: the socket is the identity.
    expect(
      (
        await overSocket(socketPath, "GET", "/api/v1/fleet", {
          Authorization: "Bearer not-a-token",
        })
      ).status,
    ).toBe(200);
    expect(
      (await overSocket(socketPath, "GET", "/api/v1/ships/missing")).status,
    ).toBe(404);
  }
});

test("officers: the socket is 0660 with its directory's group, and goes on stop", async () => {
  const officers = await officerDirectories({ "captain-a": 0o2750 });
  const [officer] = officers;
  const socketPath = officer?.socketPath ?? "";
  const before = await stat(join(socketPath, ".."));
  const { server } = await start(officers);
  const info = await lstat(socketPath);
  const directory = await stat(join(socketPath, ".."));

  expect(info.isSocket()).toBe(true);
  expect((info.mode & 0o777).toString(8)).toBe("660");
  expect(info.uid).toBe(process.getuid?.() ?? -1);
  expect(info.gid).toBe(directory.gid);
  // Stargate never changes the directory the installer made.
  expect(directory.mode).toBe(before.mode);
  expect(directory.gid).toBe(before.gid);
  expect(server.officerSockets).toEqual([socketPath]);
  await server.stop();
  expect(existsSync(socketPath)).toBe(false);
});

test("officers: a directory others may enter, or one officer's group in another's, stops start-up", async () => {
  const open = await officerDirectories({ "captain-a": 0o755 });

  await expect(start(open)).rejects.toThrow(
    "captain-a's socket directory must give others no access",
  );
  expect(existsSync(open[0]?.socketPath ?? "")).toBe(false);

  // Both directories admit the same group: each officer could reach the other's.
  const shared = await officerDirectories({
    "captain-a": 0o2750,
    "captain-b": 0o2750,
  });

  await expect(start(shared)).rejects.toThrow(
    "The socket directories of captain-a and captain-b share a group",
  );

  for (const { socketPath } of shared) {
    expect(existsSync(socketPath)).toBe(false);
  }

  const parent = await privateDirectory("sg-");

  await expect(
    start([
      {
        officer: "captain-a",
        socketPath: join(parent, "absent", "fleet-api.sock"),
      },
    ]),
  ).rejects.toThrow("captain-a's socket directory is missing");
});

test("officers: two officers each get a socket in their own directory only", async () => {
  const section = Schema.decodeUnknownSync(subspaceAgentsSection)({
    enabled: true,
    api: { baseUrl: "https://subspace.example.test" },
    officers: [
      captain("captain-a", {
        socketPath: "/run/example/agents/captain-a/api.sock",
      }),
      captain("captain-b", {
        socketPath: "/run/example/agents/captain-b/api.sock",
      }),
      captain("captain-c"),
    ],
  });

  expect(officerFleetSockets(section)).toEqual([
    {
      officer: "captain-a",
      socketPath: "/run/example/agents/captain-a/fleet-api.sock",
    },
    {
      officer: "captain-b",
      socketPath: "/run/example/agents/captain-b/fleet-api.sock",
    },
  ]);
  expect(officerFleetSockets(undefined)).toEqual([]);

  // Served for real: each officer's socket is in its own directory.
  // Nothing is created in the other officer's.
  const officers = await officerDirectories({
    "captain-a": 0o2750,
    "captain-b": 0o700,
  });

  await start(officers.slice(0, 1));
  expect(existsSync(officers[0]?.socketPath ?? "")).toBe(true);
  expect(existsSync(officers[1]?.socketPath ?? "")).toBe(false);
});

test("officers: nothing else configured may be at an officer's Fleet API socket", () => {
  const directory = "/run/example/agents/captain-a";

  const officers = [
    { officer: "captain-a", socketPath: `${directory}/fleet-api.sock` },
  ];

  const name = "the Fleet Control socket of IRC registration example-ship";

  // Fleet Control's own name, beside it, is fine.
  checkOfficerSocketPaths(officers, [
    { path: `${directory}/fleet.sock`, name },
  ]);

  expect(() => {
    checkOfficerSocketPaths(officers, [
      { path: `${directory}/../captain-a/fleet-api.sock`, name },
    ]);
  }).toThrow(
    `captain-a's Fleet API socket ${directory}/fleet-api.sock is also ${name}`,
  );
});

test("officers: nothing is writable, and only exact Fleet API targets answer", async () => {
  const officers = await officerDirectories({ "captain-a": 0o700 });
  const socketPath = officers[0]?.socketPath ?? "";

  await start(officers);

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const refused = await overSocket(
      socketPath,
      method,
      "/api/v1/fleet",
      { "content-type": "application/json", origin: "subspace://example" },
      '{"name":"changed"}',
    );

    expect(refused.status).toBe(405);
    expect(refused.headers["allow"]).toBe("GET, HEAD");
    expect(refused.body).toBe("");
  }

  for (const target of [
    "/api/v1/unknown",
    "/api/v1/ships/explorer/crew",
    "/api/v1/ships/../fleet",
    "/api/v1/ships/%2e%2e/fleet",
    "/api/v1/ships/explorer%2Fcrew%2Fengineer",
    "/api/v1//fleet",
    "/api/v1/ships/explorer\\..",
    "/api/v1/./fleet",
    "/notify/example",
    "/api/v2/fleet",
    "/",
  ]) {
    expect((await overSocket(socketPath, "GET", target)).status, target).toBe(
      404,
    );
  }

  // A query is ignored; no browser origin is granted.
  const answer = await overSocket(socketPath, "GET", "/api/v1/fleet?x=1", {
    Origin: "subspace://example",
  });

  expect(answer.status).toBe(200);
  expect(answer.headers["access-control-allow-origin"]).toBeUndefined();
});

test("officers: the target check takes normalised Fleet API paths only", () => {
  expect(officerTarget("/api/v1/fleet")).toBe("/api/v1/fleet");
  expect(officerTarget("/api/v1/ships/explorer?x=../y")).toBe(
    "/api/v1/ships/explorer",
  );

  for (const target of [
    "",
    "api/v1/fleet",
    "//example.com/api/v1/fleet",
    "http://example.com/api/v1/fleet",
    "/api/v1/../v1/fleet",
    "/api/v1/%2E%2E/fleet",
    "/api/v1/fleet%00",
    "/api/v1/fleet#x",
    "/api/v1/ships\\explorer",
    "/api/v1//ships",
    "/api/v10/fleet",
  ]) {
    expect(officerTarget(target), target).toBeUndefined();
  }
});

test("officers: the token listener is unchanged beside them, and officers' streams use their own slots", async () => {
  const officers = await officerDirectories({
    "captain-a": 0o700,
    "captain-b": 0o700,
  });

  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null),
  });

  const listen = `127.0.0.1:${reservation.port}`;
  await reservation.stop(true);

  const { server, dataDirectory } = await start(officers, listen);
  const token = await apiToken(dataDirectory);
  const url = new URL("/api/v1/fleet", server.url);

  expect((await fetch(url)).status).toBe(401);

  const people = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  expect(people.status).toBe(200);
  expect(((await people.json()) as V1Fleet).name).toBe("Example fleet");
  expect(
    json(
      await overSocket(officers[0]?.socketPath ?? "", "GET", "/api/v1/fleet"),
    ),
  ).toMatchObject({ name: "Example fleet" });

  // Eight officer streams fill the officers' slots, across both sockets ...
  const streams: IncomingMessage[] = [];

  cleanup.push(() => {
    for (const stream of streams) {
      stream.destroy();
    }
  });

  for (let index = 0; index < 8; index++) {
    const stream = await openStream(officers[index % 2]?.socketPath ?? "");

    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toBe("text/event-stream");
    streams.push(stream);
  }

  const ninth = await openStream(officers[1]?.socketPath ?? "");

  expect(ninth.statusCode).toBe(503);
  ninth.destroy();

  // ... and people's console still gets its stream, with its first fleet frame.
  const consoleStream = await fetch(new URL("/api/v1/events", server.url), {
    headers: { Authorization: `Bearer ${token}` },
  });

  expect(consoleStream.status).toBe(200);
  await consoleStream.body?.cancel();

  const frame = await firstChunk(streams[0]);

  expect(frame).toContain("event: fleet");
});

/** An event stream over an officer's socket: the response, still open. */
function openStream(socketPath: string) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request(
      { socketPath, path: "/api/v1/events", agent: false },
      resolve,
    );

    outgoing.once("error", reject);
    outgoing.end();
  });
}

function firstChunk(stream: IncomingMessage | undefined) {
  return new Promise<string>((resolve) => {
    stream?.once("data", (chunk: Buffer) => {
      resolve(chunk.toString("utf8"));
    });
  });
}

async function fleetRequest(socketPath: string, path: string) {
  const chunks: Buffer[] = [];
  const reports: string[] = [];

  const code = await runFleetRequest({
    socketPath,
    path,
    output: new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        done();
      },
    }),
    report: (text) => reports.push(text),
  });

  return { code, output: Buffer.concat(chunks).toString("utf8"), reports };
}

test("request command: a read through the officer's socket; exit 1 unless 2xx, 2 for other paths", async () => {
  const officers = await officerDirectories({ "captain-a": 0o700 });
  const socketPath = officers[0]?.socketPath ?? "";

  await start(officers);

  const fleet = await fleetRequest(socketPath, "/api/v1/fleet");

  expect(fleet.code).toBe(0);
  expect(fleet.reports).toEqual([]);
  expect(JSON.parse(fleet.output)).toMatchObject({
    ships: [{ id: "explorer" }, { id: "surveyor" }],
  });
  expect(
    JSON.parse(
      (await fleetRequest(socketPath, "/api/v1/ships/explorer/crew/engineer"))
        .output,
    ),
  ).toEqual({ ship: "explorer", member });
  expect(await fleetRequest(socketPath, "/api/v1/ships/missing")).toEqual({
    code: 1,
    output: "",
    reports: ["The Fleet API answered HTTP 404"],
  });

  // Not a Fleet API route, even under /api/v1/: a malformed command, not a 404.
  for (const path of [
    "/api/v1/../admin",
    "/admin",
    "api/v1/fleet",
    "/api/v1/unknown",
    "/api/v1/ships/explorer/logs",
  ]) {
    expect(await fleetRequest(socketPath, path)).toEqual({
      code: 2,
      output: "",
      reports: [expect.stringContaining("must be a Fleet API route")],
    });
  }

  const absent = await fleetRequest(
    join(socketPath, "..", "missing.sock"),
    "/api/v1/fleet",
  );

  expect(absent.code).toBe(1);
  expect(absent.reports[0]).toContain(
    "The officer's Fleet API socket is unavailable",
  );
});

test("command: stargate fleet request runs as a child process, with --socket or STARGATE_FLEET_API_SOCKET", async () => {
  const officers = await officerDirectories({ "captain-a": 0o700 });
  const socketPath = officers[0]?.socketPath ?? "";

  await start(officers);

  // The officer's harness: no configuration, no token, a minimal environment.
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const workspace = await privateDirectory("stargate-officer-");
    await mkdir(join(workspace, "empty"));

    const child = Bun.spawn(
      [process.execPath, resolve("src/main.ts"), "fleet", "request", ...args],
      {
        cwd: join(workspace, "empty"),
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env["PATH"] ?? "", ...env },
      },
    );

    cleanup.push(() => child.kill());

    return {
      code: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    };
  };

  const explicit = await run(["--socket", socketPath, "/api/v1/fleet"]);

  expect(explicit.code).toBe(0);
  expect(JSON.parse(explicit.stdout)).toMatchObject({
    ships: [{ id: "explorer" }, { id: "surveyor" }],
  });

  const fromEnvironment = await run(["/api/v1/ships/explorer"], {
    STARGATE_FLEET_API_SOCKET: socketPath,
  });

  expect(fromEnvironment.code).toBe(0);
  expect(JSON.parse(fromEnvironment.stdout)).toEqual(ship);

  const missing = await run(["--socket", socketPath, "/api/v1/ships/none"]);

  expect(missing).toMatchObject({ code: 1, stdout: "" });
  expect(missing.stderr).toContain("The Fleet API answered HTTP 404");

  const unset = await run(["/api/v1/fleet"]);

  expect(unset.code).toBe(1);
  expect(unset.stderr).toContain("Pass --socket");

  const write = await run(["--socket", socketPath, "--method", "POST", "/x"]);

  expect(write.code).toBe(1);
  expect(write.stderr).toContain("Option is not supported by this command");
}, 30_000);
