import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TextSink } from "../src/backend";
import {
  CrewEngine,
  type CrewOptions,
  type CrewSession,
  type CrewSessions,
} from "../src/crew/engine";
import { canExpandCrew } from "../src/crew/identity";
import { piDefinitionPath } from "../src/crew/instructions";
import type { MesijInbox, MesijMessage, MesijSend } from "../src/crew/mesij";
import type { PiCrewBinding } from "../src/crew/pi-extension";
import {
  PiCrewWorkers,
  type PiWorkerBackend,
  type PiWorkerFactory,
} from "../src/crew/pi-worker";
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
  let opens = 0;
  const definitions: string[] = [];
  let closes = 0;
  let binding: PiCrewBinding | undefined;
  const notifications: { id: string; delivery: string; text: string }[] = [];
  let failCreate = false;
  let failOpens = 0;
  const lifecycle: string[] = [];
  let closeGate: Promise<void> | undefined;
  const started = () => {
    const pending = Promise.withResolvers<void>();
    nextTurn = pending.resolve;
    return pending.promise;
  };
  let nextTurn = () => {};
  const factory: PiWorkerFactory = async (config, context) => {
    if (failOpens > 0) {
      failOpens--;
      throw new Error("private open error");
    }
    definitions.push(config.systemPrompt ?? "");
    opens++;
    lifecycle.push("open");
    binding = context.crew;
    expect(config.directory).toBe(options.worktrees["twiki"] ?? "");
    expect(config.systemPrompt).toContain("explicit operator approval");
    expect(config.systemPrompt).toContain(
      join(options.captainDirectory, "WAYS_OF_WORKING.md"),
    );
    const backend: PiWorkerBackend = {
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
      async waitForIdle() {},
      async notify(_sessionID, id, text, delivery) {
        notifications.push({ id, text, delivery });
      },
      async close() {
        lifecycle.push("close started");
        await closeGate;
        closes++;
        lifecycle.push("close finished");
      },
    };
    return backend;
  };
  let mailSequence = 0;
  const mailMessages: MesijMessage[] = [];
  const mailer = {
    async register() {
      return { id: "0".repeat(32), sequence: 0 };
    },
    async send(input: MesijSend) {
      const sequence = ++mailSequence;
      const receipt = { id: String(sequence).padStart(32, "0"), sequence };
      mailMessages.push({
        ...receipt,
        actor: input.actor,
        sessionID: input.sessionID,
        to: input.to,
        text: input.text,
        type: "message",
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      });
      return receipt;
    },
    async inbox(input: MesijInbox) {
      return mailMessages
        .filter(
          (message) =>
            message.to === input.sessionID &&
            message.sequence > (input.after ?? 0),
        )
        .slice(0, input.limit ?? 20);
    },
  };
  const engine = await CrewEngine.open(
    options,
    sessions,
    mailer,
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
    id: "captain-call",
  });
  return {
    directory,
    definitions,
    get binding() {
      return binding;
    },
    get opens() {
      return opens;
    },
    get closes() {
      return closes;
    },
    notifications,
    mailer,
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
    failOpens(count: number) {
      failOpens = count;
    },
    lifecycle,
    holdClose(gate: Promise<void>) {
      closeGate = gate;
    },
    async close() {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("oversized Pi mail is refused before storage and does not jam later inbox pages", async () => {
  const f = await fixture();
  try {
    await f.engine.run({ op: "ensure", crew: "twiki" }, f.caller());
    for (const text of [
      "x".repeat(64000),
      "🌌".repeat(15000),
      '"'.repeat(30000),
    ]) {
      expect(
        await f.engine.mail({ op: "send", to: "twiki", text }, f.caller()),
      ).toMatchObject({
        stored: false,
        notification: "unsupported",
        diagnostic:
          "Message is too large for the Pi inbox; mail was not stored.",
      });
    }
    expect(
      await f.engine.mail(
        { op: "send", to: "twiki", text: "Readable follow-up" },
        f.caller(),
      ),
    ).toMatchObject({ stored: true, sequence: 1 });
    if (!f.binding) throw new Error("Missing Pi binding");
    expect(
      await f.binding.run(
        "pogo_mail",
        { op: "inbox", limit: 1 },
        "17",
        "read-mail",
        new AbortController().signal,
      ),
    ).toMatchObject({
      messages: [{ text: "Readable follow-up" }],
      nextAfter: 1,
    });
  } finally {
    await f.close();
  }
});

test("installed Pi inspection observes native idle and running state without prompting", async () => {
  const f = await fixture();
  try {
    await f.engine.run({ op: "ensure", crew: "twiki" }, f.caller());
    expect(
      (
        await f.engine.run(
          { op: "inspect", crew: "twiki" },
          f.caller("captain-b"),
        )
      ).execution,
    ).toEqual({ state: "idle", backend: "pi" });
    const started = f.started();
    const task = (
      await f.engine.run(
        {
          op: "dispatch",
          crew: "twiki",
          text: "Inspect without changing work",
        },
        f.caller(),
      )
    ).task;
    await started;
    expect(
      (
        await f.engine.run(
          { op: "inspect", crew: "twiki" },
          f.caller("captain-b"),
        )
      ).execution,
    ).toEqual({ state: "running", backend: "pi" });
    expect(f.turns).toHaveLength(1);
    await expect(
      f.engine.run(
        { op: "inspect", crew: "twiki", requestStatus: { key: "status" } },
        f.caller("captain-b"),
      ),
    ).rejects.toThrow("do not support Mesij status requests");
    f.turns[0]?.resolve("Done");
    if (!task) throw new Error("Missing task");
    await f.engine.run({ op: "wait", taskID: task.id }, f.caller());
    expect(
      (await f.engine.run({ op: "inspect", crew: "twiki" }, f.caller()))
        .execution,
    ).toEqual({ state: "idle", backend: "pi" });
    expect(f.notifications).toEqual([]);
  } finally {
    await f.close();
  }
});

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

test("Pi coordination is host-bound and location plugins share one native storage owner", async () => {
  const f = await fixture();
  const second = await CrewEngine.open(
    f.options,
    f.sessions,
    f.mailer,
    undefined,
    f.factory,
  );
  try {
    const started = f.started();
    const task = (
      await f.engine.run(
        { op: "dispatch", crew: "twiki", text: "Bound work" },
        f.caller(),
      )
    ).task;
    await started;
    if (!task || !f.binding) throw new Error("Missing Pi binding");
    expect(() => f.binding?.authorize("18")).toThrow("saved conversation");
    const note = await f.binding.run(
      "pogo_journal",
      { op: "append", text: "Pi milestone" },
      "17",
      "pi-call-1",
      f.caller().signal,
    );
    expect(note).toMatchObject({
      entry: { member: "twiki", taskID: task.id, kind: "note" },
    });
    expect(
      await f.engine.dm(
        { op: "send", to: "twiki", text: "Follow up", delivery: "queue" },
        f.caller(),
      ),
    ).toMatchObject({ stored: true, notification: "accepted" });
    expect(
      await second.dm(
        { op: "send", to: "twiki", text: "Clarify", delivery: "steer" },
        { ...f.caller(), id: "second-call" },
      ),
    ).toMatchObject({ notification: "accepted" });
    expect(f.notifications.map(({ delivery }) => delivery)).toEqual([
      "queue",
      "steer",
    ]);
    expect(f.notifications[0]?.id).toHaveLength(32);
    expect(f.opens).toBe(1);
    f.turns[0]?.resolve("Complete");
    await f.engine.run({ op: "wait", taskID: task.id }, f.caller());
    await f.engine.close();
    expect(f.closes).toBe(0);
    expect(
      await f.binding.run(
        "pogo_crew",
        { op: "roster" },
        "17",
        "pi-call-2",
        f.caller().signal,
      ),
    ).toMatchObject({ status: "roster" });
    await second.close();
    expect(f.closes).toBe(1);
  } finally {
    await second.close();
    await f.close();
  }
});

test("Pi consumes the trusted member definition without creating an OpenCode profile", async () => {
  const f = await fixture();
  try {
    const member = f.engine.options.team.crew.find(({ id }) => id === "twiki");
    if (!member) throw new Error("Missing Pi member");
    const path = piDefinitionPath(f.options.captainDirectory, member);
    await mkdir(
      join(f.options.captainDirectory, ".local", "ship", "definitions"),
      { recursive: true },
    );
    await writeFile(
      path,
      `Captain-maintained Pi definition.\nShared working agreement: ${join(f.options.captainDirectory, "WAYS_OF_WORKING.md")}\n`,
    );
    await f.engine.run({ op: "ensure", crew: "twiki" }, f.caller());
    expect(f.definitions[0]).toContain("Captain-maintained Pi definition.");
    expect(f.nativeCalls.some((call) => call.startsWith("create:"))).toBe(
      false,
    );
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

test("a failed Pi harness open is retried, not cached for the process", async () => {
  const f = await fixture();
  try {
    f.failOpens(1);
    await expect(
      f.engine.run({ op: "ensure", crew: "twiki" }, f.caller()),
    ).rejects.toThrow();
    // No conversation was reserved, so a later ensure may open and create it.
    await f.engine.run({ op: "ensure", crew: "twiki" }, f.caller());
    expect(f.opens).toBe(1);
    expect(f.creations).toBe(1);
  } finally {
    await f.close();
  }
});

test("a new owner reopens a Pi store only after the last owner closed it", async () => {
  const f = await fixture();
  const gate = Promise.withResolvers<void>();
  let reopened: CrewEngine | undefined;
  try {
    await f.engine.run({ op: "ensure", crew: "twiki" }, f.caller());
    f.holdClose(gate.promise);
    const closing = f.engine.close();
    while (!f.lifecycle.includes("close started")) await Bun.sleep(1);
    reopened = await CrewEngine.open(
      f.options,
      f.sessions,
      f.mailer,
      undefined,
      f.factory,
    );
    const owner = reopened;
    const dispatch = owner.run(
      { op: "dispatch", crew: "twiki", text: "Inspect" },
      f.caller(),
    );
    await Bun.sleep(20);
    expect(f.lifecycle).toEqual(["open", "close started"]);
    gate.resolve();
    await closing;
    await dispatch;
    expect(f.lifecycle).toEqual([
      "open",
      "close started",
      "close finished",
      "open",
    ]);
  } finally {
    gate.resolve();
    await reopened?.close();
    await f.close();
  }
});

test("a closed Pi owner cannot acquire a harness after a pending open", async () => {
  const f = await fixture();
  const gate = Promise.withResolvers<void>();
  const closeStarted = Promise.withResolvers<void>();
  const factory: PiWorkerFactory = async (config, context) => {
    const backend = await f.factory(config, context);
    const close = backend.close.bind(backend);
    backend.close = async () => {
      closeStarted.resolve();
      await close();
    };
    return backend;
  };
  const owner = () =>
    new PiCrewWorkers(
      f.engine.state,
      f.options.stateDirectory,
      factory,
      undefined,
      undefined,
      f.options.captainDirectory,
    );
  const previous = owner();
  const closed = owner();
  const live = owner();
  try {
    const member = f.options.team?.crew.find(({ id }) => id === "twiki");
    const directory = f.options.worktrees["twiki"];
    if (!member || !directory) throw new Error("Missing Pi worker");
    await previous.canReport(member, directory);
    f.holdClose(gate.promise);
    const closing = previous.close();
    await closeStarted.promise;

    // Acquisition yields at realpath while the previous harness is closing.
    const acquisition = closed.canReport(member, directory);
    await closed.close();
    expect(f.opens).toBe(1);
    gate.resolve();
    await closing;
    await expect(acquisition).rejects.toThrow("closing");
    expect(f.opens).toBe(1);

    await live.canReport(member, directory);
    expect(f.opens).toBe(2);
    await live.close();
    // No lease from the closed owner can keep the replacement harness alive.
    expect(f.closes).toBe(2);
  } finally {
    gate.resolve();
    await previous.close();
    await closed.close();
    await live.close();
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
    expect(
      await f.engine.mail(
        {
          op: "send",
          to: "twiki",
          key: "message",
          text: "hello",
        },
        f.caller(),
      ),
    ).toMatchObject({ stored: true, notification: "not_requested" });
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
