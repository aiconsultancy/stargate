import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { type IncomingMessage, request } from "node:http";
import { join } from "node:path";
import { Schema } from "effect";
import type { AgentBackend } from "../src/backends/backend";
import { configSchema } from "../src/config";
import {
  CrewEngine,
  type CrewSessions,
} from "../src/coordination/crew/execution/engine";
import type {
  FleetCrewStatus,
  FleetCrewStatusInput,
} from "../src/coordination/crew/reporting/fleet-status";
import { teamSchema } from "../src/coordination/crew/team";
import {
  flockCommand,
  setDefaultLockCommandForTests,
} from "../src/lib/unix-socket";
import { diffEvents } from "../src/observability/dashboard/api/v1/diff";
import type { ApiV1Config } from "../src/observability/dashboard/api/v1/features";
import { createApiV1Source } from "../src/observability/dashboard/api/v1/projection";
import { startApiV1Server } from "../src/observability/dashboard/api/v1/server";
import { apiToken } from "../src/observability/dashboard/api/v1/token";
import type {
  V1CrewDetail,
  V1ShipDetail,
  V1Task,
} from "../src/observability/dashboard/api/v1/types";
import { dashboardSource } from "../src/observability/dashboard/dashboard-source";
import type { CrewStatus, CrewTaskTextMode } from "../src/shared/crew-status";
import { fixtureRoot } from "./fixture-root";
import { bot, identity } from "./fixtures";
import {
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

// A credential, a control character and more than the ordinary bounds.
const assignment = `Deploy with token=fixture-value \u0007 now ${"é".repeat(200)}`;

// Stripping the control reveals a credential in the last 400 points.
const progress = `${"p".repeat(500)} Check to\u0007ken=fixture-value \u001b[2J done`;

/** The crew plugin's store, read through the engine as its RPC reads it. */
async function crewPlugin() {
  const directory = await mkdtemp(join(fixtureRoot(), "stargate-officer-"));

  const team = Schema.decodeUnknownSync(teamSchema)({
    captain: { id: "adama" },
    crew: [
      {
        id: "twiki",
        name: "Twiki",
        role: "Maintenance",
        permissionProfile: "coding",
        backend: { type: "pi-durable", model: "openai/local" },
      },
    ],
  });

  const forbidden = async (): Promise<never> => {
    throw new Error("Status must not call an agent API");
  };

  const sessions: CrewSessions = {
    get: forbidden,
    create: forbidden,
    prompt: forbidden,
    wait: forbidden,
    interrupt: forbidden,
    synthetic: forbidden,
    compact: forbidden,
  };

  const engine = await CrewEngine.open(
    {
      namespace: "officer",
      stateDirectory: directory,
      projectDirectory: directory,
      captainDirectory: join(directory, "captain"),
      team,
      worktrees: { twiki: join(directory, "twiki") },
      mesijCommand: "/usr/bin/mesij",
    },
    sessions,
    undefined,
    undefined,
    forbidden,
  );

  cleanup.push(async () => {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  });

  const peer = engine.state.reservePeer("twiki");
  engine.state.readyPeer("twiki");
  const task = engine.state.reserveTask(peer, "captain", assignment);

  if (!task) {
    throw new Error("Missing task");
  }

  engine.state.running(task.id);
  engine.state.activity.progress(task.id, progress);

  const asked: string[] = [];

  /** As the plugin's fleetStatus answers: the mode names its view. */
  function fleetStatus({
    taskText,
    ...filter
  }: FleetCrewStatusInput): FleetCrewStatus {
    asked.push(taskText ?? "ordinary");
    const status = engine.status(filter, { taskText: taskText ?? "ordinary" });
    const metadata = { projectDirectory: directory, contexts: [] };

    return taskText ? { status, metadata, taskText } : { status, metadata };
  }

  const view = (mode: CrewTaskTextMode, member?: string) =>
    current(
      engine.status(member ? { member } : {}, { taskText: mode }).members[0]
        ?.current,
    );

  return { fleetStatus, asked, view };
}

/** The task text a reader is shown. */
function current(
  task: Pick<V1Task, "summary" | "progress"> | null | undefined,
) {
  return task && { summary: task.summary, progress: task.progress };
}

async function start() {
  const plugin = await crewPlugin();

  const backend: AgentBackend = {
    async createSession() {
      throw new Error("Read attempted to create a session");
    },
    async prompt() {
      throw new Error("Read attempted to prompt");
    },
    async close() {},
    async crewStatus(input): Promise<CrewStatus> {
      return plugin.fleetStatus(input).status;
    },
    async fleetCrewStatus(input) {
      return { kind: "answer", answer: plugin.fleetStatus(input) };
    },
  };

  const settings = bot("captain");

  const config: ApiV1Config = Schema.decodeUnknownSync(configSchema)({
    bots: [settings],
  });

  const shutdown = new AbortController();

  const dashboard = dashboardSource(
    [{ bot: settings, identity, key: "captain", backend }],
    {
      queueCounts: () => ({
        queued: 0,
        running: 0,
        responding: 0,
        done: 0,
        failed: 0,
      }),
      recentJobs: () => [],
      transcript: { sessionIDs: () => [], ownsSession: () => false },
    },
    { report: () => [], recentRuns: () => [] },
    Date.now,
    { fleetSignal: shutdown.signal },
  );

  const source = createApiV1Source({
    config: () => config,
    dashboard,
    git: async () => null,
    pullRequest: () => null,
  });

  const parent = await privateDirectory("sg-");

  const socketPath = join(
    await childDirectory(parent, "captain-a", 0o700),
    "fleet-api.sock",
  );

  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null),
  });

  const listen = `127.0.0.1:${reservation.port}`;
  await reservation.stop(true);
  const dataDirectory = await privateDirectory();

  const server = await startApiV1Server({
    config: { listen, fleetName: "Example fleet" },
    officers: [{ officer: "captain-a", socketPath }],
    dataDirectory,
    source,
    diff: diffEvents,
    gateway: {
      version: "1.2.3",
      opencodeVersion: async () => null,
      startedAt: 1,
    },
    signal: shutdown.signal,
  });

  cleanup.push(async () => {
    shutdown.abort();
    await server.stop();
  });

  const token = await apiToken(dataDirectory);

  const operator = (path: string) =>
    fetch(new URL(path, server.url), {
      headers: { Authorization: `Bearer ${token}` },
    });

  const officer = async (path: string) => {
    const answer = await overSocket(socketPath, "GET", path);

    expect(answer.status).toBe(200);

    return JSON.parse(answer.body) as unknown;
  };

  return { plugin, operator, officer, socketPath };
}

const twiki = (detail: unknown) =>
  current(
    (detail as V1ShipDetail).crewMembers.find(({ id }) => id === "twiki")
      ?.contexts[0]?.current,
  );

function expectOrdinary(shown: ReturnType<typeof current>) {
  expect(shown?.summary.length).toBeLessThanOrEqual(180);
  expect(shown?.progress.length).toBeLessThanOrEqual(400);
  expect(JSON.stringify(shown)).not.toContain("fixture-value");

  // C0 and C1 controls, checked in the text itself: JSON escapes them.
  const controls = [`${shown?.summary}${shown?.progress}`].flatMap((text) =>
    Array.from(text).filter((character) => {
      const point = character.codePointAt(0) ?? 0;

      return point < 0x20 || (point >= 0x7f && point <= 0x9f);
    }),
  );

  expect(controls).toEqual([]);
}

/** Frames of an event stream until one contains `marker`. */
async function framesUntil(
  next: () => Promise<string | undefined>,
  marker: string,
) {
  let frames = "";

  while (!frames.includes(marker)) {
    const chunk = await next();

    if (chunk === undefined) {
      throw new Error(`Missing frame containing ${marker}`);
    }

    frames += chunk;
  }

  return frames;
}

/** The data of the first `ship` event in frames. */
function shipEvent(frames: string) {
  const data = /event: ship\ndata: (.*)\n/.exec(frames)?.[1];

  return data === undefined ? undefined : (JSON.parse(data) as unknown);
}

function officerStream(socketPath: string) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request(
      { socketPath, path: "/api/v1/events", agent: false },
      resolve,
    );

    outgoing.once("error", reject);
    outgoing.end();
  });
}

test("an officer's crew route carries the plugin's ordinary view; the operator's carries full text", async () => {
  const { plugin, operator, officer } = await start();
  const path = "/api/v1/ships/captain/crew/twiki";
  const ordinary = plugin.view("ordinary", "twiki");

  expectOrdinary(ordinary);
  const shown = (await officer(path)) as V1CrewDetail;
  expect(current(shown.member.contexts[0]?.current)).toEqual(ordinary);
  expect(plugin.asked).toEqual(["ordinary"]);

  const people = (await (await operator(path)).json()) as V1CrewDetail;
  expect(current(people.member.contexts[0]?.current)).toEqual({
    summary: assignment,
    progress,
  });
  expect(plugin.asked).toEqual(["ordinary", "full"]);
});

test("an officer's ship detail carries the plugin's ordinary view; the operator's carries unredacted text", async () => {
  const { plugin, operator, officer } = await start();
  const path = "/api/v1/ships/captain";
  const ordinary = plugin.view("ordinary");

  expectOrdinary(ordinary);
  expect(twiki(await officer(path))).toEqual(ordinary);
  expect(plugin.asked).toEqual(["ordinary"]);

  const unredacted = plugin.view("unredacted");
  expect(unredacted?.summary).toContain("token=fixture-value \u0007");
  expect(unredacted?.progress).toContain("to\u0007ken=fixture-value");
  expect(twiki(await (await operator(path)).json())).toEqual(unredacted);
  expect(plugin.asked).toEqual(["ordinary", "unredacted"]);
});

test("an officer's fleet overview reads only the ordinary sample; the operator's reads the unredacted one", async () => {
  const { plugin, operator, officer } = await start();
  const path = "/api/v1/fleet";

  // The overview carries counts, not task text: the sample it reads, and
  // That later feeds `ship` events, is what differs.
  expect(await officer(path)).toMatchObject({ name: "Example fleet" });
  expect(plugin.asked).toEqual(["ordinary"]);
  expect((await operator(path)).status).toBe(200);
  expect(plugin.asked).toEqual(["ordinary", "unredacted"]);
});

test("an officer's ship events carry the plugin's ordinary view; the operator's carry unredacted text", async () => {
  const { plugin, operator, socketPath } = await start();
  const decoder = new TextDecoder();

  const stream = await officerStream(socketPath);
  cleanup.push(() => stream.destroy());
  expect(stream.statusCode).toBe(200);

  const officerFrames = await new Promise<string>((resolve, reject) => {
    let frames = "";

    stream.on("data", (chunk: Buffer) => {
      frames += chunk.toString("utf8");

      if (frames.includes("event: ship\n")) {
        resolve(frames);
      }
    });

    stream.once("end", () => reject(new Error("Missing ship frame")));
  });

  const ordinary = plugin.view("ordinary");
  expectOrdinary(ordinary);
  expect(twiki(shipEvent(officerFrames))).toEqual(ordinary);
  expect(plugin.asked).not.toContain("unredacted");

  const people = await operator("/api/v1/events");
  const reader = people.body?.getReader();

  if (!reader) {
    throw new Error("Missing operator stream");
  }

  cleanup.push(() => reader.cancel());

  const operatorFrames = await framesUntil(async () => {
    const next = await reader.read();

    return next.done ? undefined : decoder.decode(next.value);
  }, "event: ship\n");

  expect(twiki(shipEvent(operatorFrames))).toEqual(plugin.view("unredacted"));
  expect(plugin.asked).toContain("unredacted");
});
