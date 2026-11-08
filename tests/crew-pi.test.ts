import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentBackend, TextSink } from "../src/backend";
import {
  CrewEngine,
  type CrewOptions,
  type CrewSession,
  type CrewSessions,
} from "../src/crew/engine";
import { canExpandCrew } from "../src/crew/identity";
import type { PiWorkerFactory } from "../src/crew/pi-worker";
import { defaultTeam, type Team, teamSchema } from "../src/crew/team";

function twikiTeam(): Team {
  return teamSchema.parse({
    ...defaultTeam,
    crew: [
      ...defaultTeam.crew,
      {
        id: "twiki",
        name: "Twiki",
        role: "Cleanup and maintenance",
        permissionProfile: "coding",
        backend: {
          type: "pi-durable",
          model: "openai/opencode-go/deepseek-v4.1-flash",
          tools: "coding",
        },
      },
    ],
  });
}

async function fixture() {
  const directory = await mkdtemp("/tmp/opencode/pogo-pi-crew-");
  const team = twikiTeam();
  const options: CrewOptions = {
    namespace: "galactica",
    stateDirectory: directory,
    projectDirectory: directory,
    captainDirectory: join(directory, "captain"),
    worktrees: Object.fromEntries(
      team.crew.map(({ id }) => [id, join(directory, id)]),
    ),
    team,
    mesijCommand: "/usr/bin/mesij",
  };
  const native = new Map<string, CrewSession>(
    ["captain-a", "captain-b"].map((id) => [
      id,
      {
        id,
        agent: "bowser",
        location: { directory: options.captainDirectory },
      },
    ]),
  );
  const nativeCalls: string[] = [];
  const sessions: CrewSessions = {
    async get({ sessionID }) {
      nativeCalls.push(`get:${sessionID}`);
      const session = native.get(sessionID);
      if (!session) throw { _tag: "Session.NotFoundError" };
      return session;
    },
    async create(input) {
      if (!input.id || !input.agent || !input.location)
        throw new Error("Invalid fixture session");
      const session = {
        id: input.id,
        agent: input.agent,
        location: input.location,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
      native.set(session.id, session);
      nativeCalls.push(`create:${input.agent}`);
      return session;
    },
    async prompt() {
      throw new Error("Pi must not prompt OpenCode");
    },
    async wait() {},
    async interrupt() {
      nativeCalls.push("interrupt");
    },
    async compact() {
      nativeCalls.push("compact");
    },
    async synthetic() {
      nativeCalls.push("synthetic");
    },
  };
  const turns: {
    text: string;
    sessionID: string;
    signal: AbortSignal;
    resolve: (text: string) => void;
    reject: (error: Error) => void;
    onText: TextSink | undefined;
  }[] = [];
  let creations = 0;
  let failCreate = false;
  const started = () => {
    const pending = Promise.withResolvers<void>();
    nextTurn = pending.resolve;
    return pending.promise;
  };
  let nextTurn = () => {};
  const factory: PiWorkerFactory = async (config) => {
    expect(config.directory).toBe(options.worktrees["twiki"] ?? "");
    expect(config.systemPrompt).toContain("explicit operator approval");
    const backend: AgentBackend = {
      async createSession() {
        creations++;
        if (failCreate) throw new Error("private provider error");
        return "17";
      },
      async prompt(sessionID, text, signal, onText) {
        const response = Promise.withResolvers<string>();
        turns.push({
          sessionID,
          text,
          signal,
          resolve: response.resolve,
          reject: response.reject,
          onText,
        });
        signal.addEventListener(
          "abort",
          () => response.reject(new Error("aborted")),
          { once: true },
        );
        nextTurn();
        return response.promise;
      },
      async interrupt() {},
      async close() {},
    };
    return backend;
  };
  const engine = await CrewEngine.open(
    options,
    sessions,
    undefined,
    undefined,
    factory,
  );
  const caller = (
    sessionID = "captain-a",
    signal = new AbortController().signal,
  ) => ({
    sessionID,
    agent: "bowser",
    signal,
  });
  return {
    directory,
    options,
    sessions,
    engine,
    factory,
    nativeCalls,
    turns,
    caller,
    started,
    get creations() {
      return creations;
    },
    failCreate() {
      failCreate = true;
    },
    async close() {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("captain dispatches persistent Pi work and collects only its own result", async () => {
  const f = await fixture();
  try {
    const started = f.started();
    const first = await f.engine.run(
      { op: "dispatch", crew: "twiki", text: "Check formatting" },
      f.caller(),
    );
    await started;
    expect(first.status).toBe("running");
    expect(f.turns[0]?.sessionID).toBe("17");
    expect(f.turns[0]?.text).toContain("Check formatting");
    await expect(
      f.engine.run(
        { op: "status", taskID: first.task?.id },
        f.caller("captain-b"),
      ),
    ).rejects.toThrow("does not own");
    expect(
      (
        await f.engine.run(
          { op: "dispatch", crew: "twiki", text: "More" },
          f.caller(),
        )
      ).status,
    ).toBe("busy");
    f.turns[0]?.resolve("Formatting verified; no files changed.");
    const result = await f.engine.run(
      { op: "wait", taskID: first.task?.id },
      f.caller(),
    );
    expect(result.status).toBe("completed");
    expect(result.task?.result).toBe("Formatting verified; no files changed.");
    const secondStarted = f.started();
    const second = await f.engine.run(
      { op: "dispatch", crew: "twiki", text: "Check docs" },
      f.caller(),
    );
    await secondStarted;
    expect(second.task?.workerSessionID).toBe(first.task?.workerSessionID);
    expect(f.creations).toBe(1);
    f.turns[1]?.resolve("Docs checked.");
    await f.engine.run({ op: "wait", taskID: second.task?.id }, f.caller());
    const reopened = await CrewEngine.open(
      f.options,
      f.sessions,
      undefined,
      undefined,
      f.factory,
    );
    try {
      expect(
        (await reopened.run({ op: "ensure", crew: "twiki" }, f.caller()))
          .peers?.[0]?.sessionID,
      ).toBe(first.task?.workerSessionID);
      expect(f.creations).toBe(1);
    } finally {
      await reopened.close();
    }
    expect(f.nativeCalls.some((call) => call.includes("create:twiki"))).toBe(
      false,
    );
    expect(
      f.nativeCalls.some((call) =>
        call.includes(first.task?.workerSessionID ?? "missing"),
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

test("Pi cancellation stops execution and never replays uncertain work", async () => {
  const f = await fixture();
  try {
    const started = f.started();
    const dispatched = await f.engine.run(
      { op: "dispatch", crew: "twiki", text: "Inspect cleanup" },
      f.caller(),
    );
    await started;
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.engine.run(
        { op: "wait", taskID: dispatched.task?.id },
        f.caller("captain-a", controller.signal),
      ),
    ).rejects.toThrow("uncertain");
    expect(f.turns[0]?.signal.aborted).toBe(true);
    expect(
      (
        await f.engine.run(
          { op: "status", taskID: dispatched.task?.id },
          f.caller(),
        )
      ).status,
    ).toBe("uncertain");
    expect(
      (
        await f.engine.run(
          { op: "dispatch", crew: "twiki", text: "Retry" },
          f.caller(),
        )
      ).status,
    ).toBe("busy");
    expect(f.turns).toHaveLength(1);
    expect(f.nativeCalls).not.toContain("interrupt");
  } finally {
    await f.close();
  }
});

test("member status observes live Pi progress across locations without another model call or queue promotion", async () => {
  const f = await fixture();
  let other: CrewEngine | undefined;
  try {
    const started = f.started();
    const first = (
      await f.engine.run(
        { op: "dispatch", crew: "twiki", text: "Inspect formatting" },
        f.caller(),
      )
    ).task;
    await started;
    f.turns[0]?.onText?.(
      "Checked files; formatting in progress. api_key=private-key",
    );
    await f.engine.run(
      {
        op: "dispatch",
        crew: "twiki",
        text: "Inspect documentation",
        queue: true,
      },
      f.caller(),
    );
    other = await CrewEngine.open(
      f.options,
      f.sessions,
      undefined,
      undefined,
      f.factory,
    );
    const before = f.nativeCalls.length;
    for (const engine of [f.engine, other]) {
      const status = engine.status({ member: "twiki" });
      expect(status.members[0]).toMatchObject({
        observed: true,
        current: {
          status: "running",
          summary: "Inspect formatting",
          progress: "Checked files; formatting in progress. api_key=[REDACTED]",
        },
        queuedCount: 1,
      });
      expect(status.members[0]?.current?.startedAt).toBeNumber();
      expect(status.members[0]?.current?.updatedAt).toBeNumber();
    }
    expect(f.nativeCalls).toHaveLength(before);
    expect(f.turns).toHaveLength(1);
    f.turns[0]?.resolve("PRIVATE RAW FINAL RESULT");
    await f.engine.run({ op: "wait", taskID: first?.id }, f.caller());
    const finished = f.engine.status({ member: "twiki" });
    expect(finished.members[0]).toMatchObject({
      observed: false,
      current: null,
      queuedCount: 1,
      lastOutcome: { status: "completed", summary: "Inspect formatting" },
    });
    expect(JSON.stringify(finished)).not.toContain("PRIVATE RAW FINAL RESULT");
    expect(f.turns).toHaveLength(1);
    expect(f.creations).toBe(1);
  } finally {
    await other?.close();
    await f.close();
  }
});

test("member status retains safe failed Pi outcome without retry or SDK error details", async () => {
  const f = await fixture();
  try {
    const started = f.started();
    const task = (
      await f.engine.run(
        { op: "dispatch", crew: "twiki", text: "Inspect failure" },
        f.caller(),
      )
    ).task;
    await started;
    f.turns[0]?.reject(new Error("Bearer private-provider-error"));
    expect(
      (await f.engine.run({ op: "wait", taskID: task?.id }, f.caller())).status,
    ).toBe("uncertain");
    const status = f.engine.status({ member: "twiki" });
    expect(status.members[0]).toMatchObject({
      observed: false,
      current: {
        status: "uncertain",
        phase: "Execution failed; outcome uncertain",
      },
      lastOutcome: { status: "uncertain" },
    });
    expect(JSON.stringify(status)).not.toContain("private-provider-error");
    expect(f.turns).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("Pi shutdown retains uncertain task and unconfirmed creation is not repeated", async () => {
  const f = await fixture();
  try {
    f.failCreate();
    await expect(
      f.engine.run({ op: "ensure", crew: "twiki" }, f.caller()),
    ).rejects.toThrow("unconfirmed");
    await expect(
      f.engine.run({ op: "ensure", crew: "twiki" }, f.caller()),
    ).rejects.toThrow("unconfirmed");
    expect(f.creations).toBe(1);
  } finally {
    await f.close();
  }
  const running = await fixture();
  try {
    const started = running.started();
    const task = (
      await running.engine.run(
        { op: "dispatch", crew: "twiki", text: "Inspect" },
        running.caller(),
      )
    ).task;
    await started;
    await running.engine.close();
    const reopened = await CrewEngine.open(
      running.options,
      running.sessions,
      undefined,
      undefined,
      running.factory,
    );
    try {
      expect(
        (
          await reopened.run(
            { op: "status", taskID: task?.id },
            running.caller(),
          )
        ).status,
      ).toBe("uncertain");
      expect(running.turns).toHaveLength(1);
    } finally {
      await reopened.close();
    }
  } finally {
    await running.close();
  }
});

test("Pi FIFO remains captain-polled and native-only controls fail clearly", async () => {
  const f = await fixture();
  try {
    const started = f.started();
    const first = (
      await f.engine.run(
        { op: "dispatch", crew: "twiki", text: "First" },
        f.caller(),
      )
    ).task;
    await started;
    const queued = await f.engine.run(
      { op: "dispatch", crew: "twiki", text: "Second", queue: true },
      f.caller(),
    );
    expect(queued.status).toBe("queued");
    f.turns[0]?.resolve("First done");
    await f.engine.run({ op: "wait", taskID: first?.id }, f.caller());
    expect(f.turns).toHaveLength(1);
    const secondStarted = f.started();
    await f.engine.run({ op: "status", taskID: queued.task?.id }, f.caller());
    await secondStarted;
    f.turns[1]?.resolve("Second done");
    expect(
      (await f.engine.run({ op: "wait", taskID: queued.task?.id }, f.caller()))
        .task?.result,
    ).toBe("Second done");
    await expect(
      f.engine.run({ op: "compact", crew: "twiki" }, f.caller()),
    ).rejects.toThrow("not supported");
    await expect(
      f.engine.mail(
        {
          op: "send",
          to: "twiki",
          taskID: first?.id,
          key: "message",
          text: "hello",
        },
        f.caller(),
      ),
    ).rejects.toThrow("not Mesij");
  } finally {
    await f.close();
  }
});

test("explicit Pi roster expansion preserves all native peers and results", async () => {
  const f = await fixture();
  await f.engine.close();
  const oldOptions = {
    ...f.options,
    team: defaultTeam,
    worktrees: Object.fromEntries(
      Object.entries(f.options.worktrees).filter(([id]) => id !== "twiki"),
    ),
  };
  // Use a separate namespace because the fixture already persisted the new identity.
  oldOptions.namespace = "upgrade";
  const original = await CrewEngine.open(oldOptions, f.sessions);
  const peers = (await original.run({ op: "ensure" }, f.caller())).peers;
  const peer = peers?.[0];
  if (!peer) throw new Error("Missing original peer");
  const task = original.state.reserveTask(peer, "captain-a");
  if (!task) throw new Error("Missing original task");
  original.state.complete(task.id, peer.sessionID, "Retained result");
  await original.close();
  const legacy = new Database(original.state.path);
  legacy.exec(`
    PRAGMA foreign_keys=OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE peers_legacy (
      crewID TEXT PRIMARY KEY CHECK(crewID IN ('mario','luigi','daisy','toad')),
      sessionID TEXT NOT NULL UNIQUE, status TEXT NOT NULL
    );
    INSERT INTO peers_legacy SELECT * FROM peers;
    DROP TABLE peers;
    ALTER TABLE peers_legacy RENAME TO peers;
    COMMIT;
  `);
  legacy.close();
  const expanded = { ...f.options, namespace: "upgrade" };
  try {
    await expect(CrewEngine.open(expanded, f.sessions)).rejects.toThrow(
      "configuration changed",
    );
    const upgraded = await CrewEngine.open(
      { ...expanded, allowCrewExpansion: true },
      f.sessions,
      undefined,
      undefined,
      f.factory,
    );
    try {
      for (const previous of peers ?? [])
        expect(upgraded.state.peer(previous.crewID)).toEqual(previous);
      expect(upgraded.state.task(task.id)?.result).toBe("Retained result");
      expect(
        (await upgraded.run({ op: "ensure", crew: "twiki" }, f.caller()))
          .status,
      ).toBe("ready");
    } finally {
      await upgraded.close();
    }
  } finally {
    await f.close();
  }
});

test("explicit OpenCode roster expansion preserves native and Pi peers and tasks", async () => {
  const f = await fixture();
  try {
    const peers = (await f.engine.run({ op: "ensure" }, f.caller())).peers;
    const peer = peers?.find(({ crewID }) => crewID === "mario");
    if (!peer) throw new Error("Missing original peer");
    const task = f.engine.state.reserveTask(peer, "captain-a");
    if (!task) throw new Error("Missing original task");
    f.engine.state.complete(task.id, peer.sessionID, "Retained native result");
    const savedTask = f.engine.state.task(task.id);
    const statePath = f.engine.state.path;
    await f.engine.close();
    const existingTeam = teamSchema.parse(f.options.team);
    const expanded = {
      ...f.options,
      team: teamSchema.parse({
        ...existingTeam,
        crew: [
          ...existingTeam.crew,
          {
            id: "bosun",
            role: "Ship maintenance",
            permissionProfile: "coding",
          },
        ],
      }),
      worktrees: { ...f.options.worktrees, bosun: join(f.directory, "bosun") },
    };
    await expect(CrewEngine.open(expanded, f.sessions)).rejects.toThrow(
      "configuration changed",
    );
    const upgraded = await CrewEngine.open(
      { ...expanded, allowCrewExpansion: true },
      f.sessions,
      undefined,
      undefined,
      f.factory,
    );
    let bosunSessionID: string | undefined;
    try {
      expect(upgraded.state.path).toBe(statePath);
      for (const previous of peers ?? [])
        expect(upgraded.state.peer(previous.crewID)).toEqual(previous);
      expect(upgraded.state.task(task.id)).toEqual(savedTask);
      const ensured = await upgraded.run(
        { op: "ensure", crew: "bosun" },
        f.caller(),
      );
      expect(ensured.status).toBe("ready");
      bosunSessionID = upgraded.state.peer("bosun")?.sessionID;
      expect(bosunSessionID).toBeDefined();
      expect(f.nativeCalls).toContain("create:bosun");
    } finally {
      await upgraded.close();
    }
    const reopened = await CrewEngine.open(expanded, f.sessions);
    try {
      expect(reopened.state.peer("bosun")?.sessionID).toBe(bosunSessionID);
      for (const previous of peers ?? [])
        expect(reopened.state.peer(previous.crewID)).toEqual(previous);
      expect(reopened.state.task(task.id)).toEqual(savedTask);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

test("roster expansion accepts OpenCode additions but rejects rebinding and removal", () => {
  const old = {
    version: 2,
    namespace: "crew",
    projectDirectory: "/project",
    captain: { id: "adama", directory: "/captain" },
    crew: [{ id: "chief", directory: "/chief", permissionProfile: "coding" }],
  };
  const added = {
    id: "twiki",
    directory: "/twiki",
    permissionProfile: "coding",
    backend: { type: "pi-durable" },
  };
  const next = { ...old, crew: [...old.crew, added] };
  const before = JSON.stringify(old);
  expect(canExpandCrew(before, JSON.stringify(next))).toBe(true);
  expect(
    canExpandCrew(
      before,
      JSON.stringify({
        ...next,
        captain: { id: "other", directory: "/captain" },
      }),
    ),
  ).toBe(false);
  expect(
    canExpandCrew(
      before,
      JSON.stringify({
        ...next,
        crew: [{ ...old.crew[0], directory: "/other" }, added],
      }),
    ),
  ).toBe(false);
  expect(
    canExpandCrew(before, JSON.stringify({ ...next, crew: [added] })),
  ).toBe(false);
  for (const changed of [
    { ...next, namespace: "another" },
    { ...next, projectDirectory: "/other" },
    { ...next, captain: { ...old.captain, directory: "/other" } },
  ])
    expect(canExpandCrew(before, JSON.stringify(changed))).toBe(false);
  expect(
    canExpandCrew(
      before,
      JSON.stringify({
        ...next,
        crew: [
          ...old.crew,
          { id: "bosun", directory: "/bosun", permissionProfile: "coding" },
        ],
      }),
    ),
  ).toBe(true);
});
