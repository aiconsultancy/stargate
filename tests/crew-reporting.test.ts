import { Database } from "bun:sqlite";
import { expect, setSystemTime, test } from "bun:test";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fixtureRoot } from "./fixture-root";
import { join } from "node:path";
import { Result, Schema } from "effect";
import pino from "pino";
import { activitySnapshotSchema } from "../src/chat/activity/activity";
import { ActivityDelivery } from "../src/chat/activity/activity-delivery";
import type { AgentBackend, TextSink } from "../src/backends/backend";
import { PiDurableBackend } from "../src/backends/pi/pi-durable";
import { piDurableBackendSchema } from "../src/config";
import { redactCredentials } from "../src/lib/credentials";
import {
  CrewEngine,
  type CrewOptions,
  type CrewSession,
  type CrewSessions,
} from "../src/coordination/crew/execution/engine";
import type {
  PiWorkerBackend,
  PiWorkerFactory,
} from "../src/coordination/crew/pi/pi-worker";
import { defaultTeam, teamSchema } from "../src/coordination/crew/team";
import { openStore } from "../src/app/open-store";

const diskIntegrationTimeoutMs = 30_000;

async function fixture(safeReports = true, root = fixtureRoot()) {
  const directory = await mkdtemp(join(root, "stargate-reporting-"));

  const team = Schema.decodeUnknownSync(teamSchema)({
    ...defaultTeam,
    crew: [
      ...defaultTeam.crew.map((member) => ({
        ...member,
        ...(member.id === "mario" ? { id: "chief", name: "Chief" } : {}),
      })),
      {
        id: "twiki",
        name: "Twiki",
        role: "Maintenance",
        permissionProfile: "coding",
        backend: { type: "pi-durable", model: "openai/test", tools: "coding" },
      },
    ],
  });

  const options: CrewOptions = {
    namespace: "report-test",
    stateDirectory: directory,
    captainDirectory: join(directory, "captain"),
    projectDirectory: directory,
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

  const sessions: CrewSessions = {
    async get({ sessionID }) {
      const session = native.get(sessionID);

      if (!session) {
        throw { _tag: "Session.NotFoundError" };
      }

      return session;
    },
    async create(input) {
      if (!input.id || !input.agent || !input.location) {
        throw new Error("Invalid fake session");
      }

      const session: CrewSession = {
        id: input.id,
        agent: input.agent,
        location: input.location,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };

      native.set(session.id, session);

      return session;
    },
    async prompt({ sessionID, id }) {
      return { sessionID, id: id ?? "input" };
    },
    async wait() {},
    async interrupt() {},
    async synthetic() {},
    async compact() {},
  };

  const turns: {
    mode: "maintenance" | "report";
    text: string;
    sessionID: string;
    signal: AbortSignal;
    resolve: (text: string) => void;
    onText: TextSink | undefined;
  }[] = [];

  let next = () => {};
  let creations = 0;
  const opened = Promise.withResolvers<void>();

  const prompt =
    (mode: "maintenance" | "report") =>
    async (
      sessionID: string,
      text: string,
      signal: AbortSignal,
      onText?: TextSink,
    ) => {
      const answer = Promise.withResolvers<string>();
      signal.addEventListener(
        "abort",
        () => answer.reject(new Error("aborted")),
        { once: true },
      );
      turns.push({
        mode,
        text,
        sessionID,
        signal,
        resolve: answer.resolve,
        onText,
      });
      next();

      return answer.promise;
    };

  const factory: PiWorkerFactory = async () => {
    opened.resolve();

    const backend: PiWorkerBackend = {
      async createSession() {
        creations++;

        return "17";
      },
      prompt: prompt("maintenance"),
      ...(safeReports ? { promptReport: prompt("report") } : {}),
      async close() {},
    };

    return backend;
  };

  let mailSequence = 0;

  const mailer = {
    async register() {
      return { id: "receipt", sequence: 1 };
    },
    async send() {
      const sequence = ++mailSequence;

      return { id: String(sequence).padStart(32, "0"), sequence };
    },
    async inbox() {
      return [];
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
  ) => ({ sessionID, agent: "bowser", signal, id: "captain-call" });

  const start = (
    requestID = "turn-a",
    sessionID = "captain-a",
    reporter = "twiki",
  ) =>
    engine.reporting.start({ sessionID, requestID, reporter }, caller().signal);

  const owner = (id: string, sessionID = "captain-a") => ({ id, sessionID });

  const read = (id: string, sessionID = "captain-a") =>
    engine.reporting.read(owner(id, sessionID), caller().signal);

  const dispatch = async (
    text: string,
    crew = "chief",
    sessionID = "captain-a",
    queue = false,
  ) => {
    const task = (
      await engine.run({ op: "dispatch", text, crew, queue }, caller(sessionID))
    ).task;

    if (!task) {
      throw new Error("Missing fixture task");
    }

    return task;
  };

  const complete = (taskID: string, result: string) => {
    const task = engine.state.task(taskID);

    if (!task) {
      throw new Error("Missing fixture task");
    }

    return engine.run(
      { op: "complete", taskID, result },
      {
        sessionID: task.workerSessionID,
        agent: task.crewID,
        signal: caller().signal,
      },
    );
  };

  return {
    directory,
    options,
    engine,
    sessions,
    factory,
    native,
    caller,
    owner,
    start,
    read,
    dispatch,
    complete,
    turns,
    opened: opened.promise,
    started() {
      const event = Promise.withResolvers<void>();
      next = event.resolve;

      return event.promise;
    },
    get creations() {
      return creations;
    },
    reportTask(id: string) {
      const taskID = engine.state.reporting.owned("captain-a", id).reportTaskID;

      if (!taskID) {
        throw new Error("Missing report reservation");
      }

      return taskID;
    },
    async close() {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("reporting is opt-in; state stays private and inactive dispatch collects nothing", async () => {
  const f = await fixture(true, tmpdir());

  try {
    const task = await f.dispatch("Private assignment");
    await f.complete(task.id, "Private result");
    const db = new Database(f.engine.state.path, { readonly: true });

    try {
      for (const table of [
        "activity_captures",
        "activity_tasks",
        "activity_entries",
        "activity_report_tasks",
      ]) {
        expect(
          db
            .query<{ count: number }, []>(
              `SELECT COUNT(*) AS count FROM ${table}`,
            )
            .get()?.count,
        ).toBe(0);
      }
    } finally {
      db.close();
    }

    expect((await stat(f.engine.state.path)).mode & 0o777).toBe(0o600);
    expect(f.turns).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("empty capture finishes without starting or queuing Twiki inference", async () => {
  const f = await fixture();

  try {
    const capture = await f.start();

    const finished = await f.engine.reporting.finish(
      f.owner(capture.id),
      f.caller().signal,
    );

    expect(finished).toMatchObject({ status: "complete", entries: [] });
    expect(
      f.engine.state.reporting.owned("captain-a", capture.id).reportTaskID,
    ).toBeNull();
    expect(f.turns).toEqual([]);
  } finally {
    await f.close();
  }
});

test("journal-only activity needs no reporter, retains late facts and never calls a model", async () => {
  const f = await fixture();

  try {
    const capture = await f.engine.reporting.start(
      { sessionID: "captain-a", requestID: "facts-only" },
      f.caller().signal,
    );

    await f.engine.journal(
      { op: "append", text: "Captain checked inputs" },
      { ...f.caller(), id: "note-1" },
    );
    expect((await f.read(capture.id)).entries[0]).toMatchObject({
      kind: "note",
      member: "Bowser",
    });
    await f.engine.reporting.finish(f.owner(capture.id), f.caller().signal);
    let final = await f.read(capture.id);

    for (
      let attempt = 0;
      attempt < 10 && final.status === "summarizing";
      attempt++
    ) {
      final = await f.read(capture.id);
    }

    expect(final.status).toBe("complete");
    expect(final.summary).toContain("no reporter");
    await f.engine.journal(
      { op: "append", text: "Late verification passed" },
      { ...f.caller(), id: "note-2" },
    );
    const late = await f.read(capture.id);
    expect(late.revision).toBeGreaterThan(final.revision);
    expect(late.entries.at(-1)?.text).toBe("Late verification passed");
    expect(f.turns).toEqual([]);
    expect((await f.read(capture.id)).revision).toBe(late.revision);
  } finally {
    await f.close();
  }
});

test("saved Stop dry-reads a summarizing capture without admitting a report", async () => {
  const f = await fixture();
  const store = openStore(":memory:");
  let delivery: ActivityDelivery | undefined;

  try {
    const capture = await f.start();
    const task = await f.dispatch("Running source");
    await f.engine.reporting.finish(f.owner(capture.id), f.caller().signal);
    await f.complete(task.id, "Ready, but collection was stopped");
    store.enqueue({
      eventId: "stopped",
      botKey: "bot",
      conversation: "thread",
      channel: "D1",
      thread: "1",
      user: "U1",
      text: "request",
    });
    const job = store.ready("bot", Date.now(), 1)[0];

    if (!job) {
      throw new Error("Missing job");
    }

    store.activityRecords.saveActivity(job.id, {
      capture: capture.id,
      ts: "box",
      revision: 0,
      done: true,
    });

    const backend: AgentBackend = {
      async createSession() {
        throw new Error("No session creation");
      },
      async prompt() {
        throw new Error("No prompt");
      },
      async close() {},
      resumeActivity() {
        return {
          read: (signal, passive) =>
            f.engine.reporting.read(
              { ...f.owner(capture.id), ...(passive ? { passive } : {}) },
              signal,
            ),
          finish: (signal) =>
            f.engine.reporting.finish(f.owner(capture.id), signal),
          async cancel() {
            throw new Error("Unconfirmed previous cancel");
          },
        };
      },
    };

    const published = Promise.withResolvers<void>();
    let status = "";
    delivery = new ActivityDelivery(
      backend,
      {
        async post() {},
        async activity(_channel, _thread, view) {
          status = view.status;
          published.resolve();

          return "box";
        },
      },
      () => ({ detail: "summary" }),
      () => true,
      pino({ enabled: false }),
      { store: store.activityRecords },
    );
    await delivery.resume(job, "captain-a", f.caller().signal);
    await published.promise;
    await delivery.close();
    await f.engine.reporting.close();
    expect(status).toBe("cancelled");
    expect(f.turns).toEqual([]);
    expect(f.engine.state.reporting.reportTaskID(capture.id)).toBeUndefined();
  } finally {
    await delivery?.close();
    store.close();
    await f.close();
  }
});

test("a final model summary cannot hide later journal facts or run again", async () => {
  const f = await fixture();

  try {
    const capture = await f.start();
    await f.engine.journal(
      { op: "append", text: "Checks passed" },
      { ...f.caller(), id: "before-report" },
    );
    const started = f.started();
    await f.engine.reporting.finish(f.owner(capture.id), f.caller().signal);
    await started;
    f.turns[0]?.resolve("Captain: checks passed.");
    await f.engine.run(
      { op: "wait", taskID: f.reportTask(capture.id) },
      f.caller(),
    );
    expect((await f.read(capture.id)).summary).toBe("Captain: checks passed.");
    await f.engine.journal(
      { op: "append", text: "Late correction" },
      { ...f.caller(), id: "after-report" },
    );
    expect(await f.read(capture.id)).toMatchObject({
      status: "complete",
      summary: "Summary predates later journal facts.",
    });
    expect((await f.read(capture.id)).entries.at(-1)?.text).toBe(
      "Late correction",
    );
    expect(f.turns).toHaveLength(1);
    const db = new Database(f.engine.state.path, { readonly: true });

    try {
      expect(db.query("SELECT * FROM activity_entries").all()).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test("reporter's maintenance is not crew activity and cannot cause a report of itself", async () => {
  const f = await fixture();

  try {
    const capture = await f.start();
    const started = f.started();
    const maintenance = await f.dispatch("Twiki maintenance", "twiki");
    await started;
    f.turns[0]?.resolve("Maintenance done");
    await f.engine.run({ op: "wait", taskID: maintenance.id }, f.caller());

    const finished = await f.engine.reporting.finish(
      f.owner(capture.id),
      f.caller().signal,
    );

    expect(finished).toMatchObject({ status: "complete", entries: [] });
    expect(f.turns.map(({ mode }) => mode)).toEqual(["maintenance"]);
    expect(
      f.engine.state.reporting.owned("captain-a", capture.id).reportTaskID,
    ).toBeNull();
  } finally {
    await f.close();
  }
});

test("active capture read renews its lease beyond five minutes", async () => {
  const f = await fixture();

  try {
    const capture = await f.start();
    const started = Date.now();

    for (let minute = 1; minute <= 6; minute++) {
      setSystemTime(started + minute * 60_000);
      expect((await f.read(capture.id)).status).toBe("collecting");
      expect(
        f.engine.state.reporting.owned("captain-a", capture.id).expires,
      ).toBeGreaterThan(Date.now() + 30_000);
    }
  } finally {
    setSystemTime();
    await f.close();
  }
});

test(
  "captures assignments, validated messages, urgency, results, and configured names only",
  async () => {
    const f = await fixture(true, tmpdir());

    try {
      const historical = await f.dispatch("Earlier turn", "luigi");
      const capture = await f.start();
      expect(await f.start()).toEqual(capture);

      const task = await f.dispatch(
        "Inspect API_KEY=assignment-secret xoxb-111-secret",
      );

      await f.engine.mail(
        {
          op: "send",
          taskID: task.id,
          to: "captain",
          text: "Found issue Bearer message-secret",
          key: "one",
        },
        {
          sessionID: task.workerSessionID,
          agent: task.crewID,
          signal: f.caller().signal,
          id: "urgent-call",
        },
      );
      await f.engine.run(
        { op: "urgent", taskID: task.id, to: "captain", text: "Urgent issue" },
        {
          sessionID: task.workerSessionID,
          agent: task.crewID,
          signal: f.caller().signal,
          id: "actual-urgent-call",
        },
      );
      await f.complete(historical.id, "Historical result must stay absent");
      await f.complete(task.id, "Result sk-provider-secret");
      const snapshot = await f.read(capture.id);
      expect(
        Result.isSuccess(
          Schema.decodeUnknownResult(activitySnapshotSchema)(snapshot),
        ),
      ).toBe(true);
      expect(snapshot.entries.map(({ kind }) => kind)).toEqual([
        "assignment",
        "update",
        "message",
        "message",
        "result",
        "result",
      ]);
      expect(
        snapshot.entries
          .filter(({ taskID }) => taskID === task.id)
          .every(({ member }) => member === "Chief"),
      ).toBe(true);
      const visible = JSON.stringify(snapshot);
      expect(visible).toContain("Chief → Bowser");

      for (const secret of [
        "assignment-secret",
        "message-secret",
        "provider-secret",
      ]) {
        expect(visible).not.toContain(secret);
      }

      const db = new Database(f.engine.state.path, { readonly: true });

      try {
        const persisted = JSON.stringify(
          db.query("SELECT * FROM activity_entries").all(),
        );

        expect(persisted).not.toContain("assignment-secret");
        expect(persisted).not.toContain("message-secret");
      } finally {
        db.close();
      }
    } finally {
      await f.close();
    }
  },
  diskIntegrationTimeoutMs,
);

test("exact capture ownership rejects other captains, workers, child sessions, and locations", async () => {
  const f = await fixture();

  try {
    const capture = await f.start();
    await expect(f.read(capture.id, "captain-b")).rejects.toThrow(
      "does not own",
    );
    await expect(
      f.engine.reporting.finish(
        f.owner(capture.id, "captain-b"),
        f.caller().signal,
      ),
    ).rejects.toThrow("does not own");
    await expect(
      f.engine.reporting.cancel(
        f.owner(capture.id, "captain-b"),
        f.caller().signal,
      ),
    ).rejects.toThrow("does not own");
    f.native.set("child", {
      id: "child",
      parentID: "captain-a",
      agent: "bowser",
      location: { directory: f.options.captainDirectory },
    });
    f.native.set("elsewhere", {
      id: "elsewhere",
      agent: "bowser",
      location: { directory: "/other" },
    });

    for (const sessionID of ["child", "elsewhere", "missing"]) {
      await expect(f.start("turn", sessionID)).rejects.toThrow();
    }

    const task = await f.dispatch("Worker task");
    await expect(f.start("worker-turn", task.workerSessionID)).rejects.toThrow(
      "captain",
    );
    const abort = new AbortController();
    abort.abort();
    await expect(
      f.engine.reporting.read(f.owner(capture.id), abort.signal),
    ).rejects.toThrow();
    expect((await f.read(capture.id)).status).toBe("collecting");
  } finally {
    await f.close();
  }
});

// Allow durable fixture setup and report/task writes on a shared test host.
test(
  "busy reporter is skipped; facts remain visible and unrelated maintenance continues",
  async () => {
    const f = await fixture(true, tmpdir());

    try {
      const maintenanceStarted = f.started();

      const maintenance = await f.dispatch(
        "Unrelated maintenance",
        "twiki",
        "captain-b",
      );

      await maintenanceStarted;
      const capture = await f.start();
      const task = await f.dispatch("Build feature");
      await f.complete(task.id, "Feature ready");
      await f.engine.reporting.finish(f.owner(capture.id), f.caller().signal);
      let final = await f.read(capture.id);

      for (
        let attempt = 0;
        attempt < 10 && final.status === "summarizing";
        attempt++
      ) {
        final = await f.read(capture.id);
      }

      expect(final.status).toBe("complete");
      expect(final.summary).toContain("Summary skipped");
      expect(JSON.stringify(final.entries)).toContain("Feature ready");
      expect(f.engine.state.reporting.reportTaskID(capture.id)).toBeUndefined();
      expect(f.turns[0]?.signal.aborted).toBe(false);
      f.turns[0]?.resolve("Maintenance done");
      await f.engine.run(
        { op: "wait", taskID: maintenance.id },
        f.caller("captain-b"),
      );

      for (let index = 0; index < 3; index++) {
        await f.read(capture.id);
      }

      expect(f.turns).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
  diskIntegrationTimeoutMs,
);

test("finish waits only linked tasks; later turns and other captains cannot enter summary", async () => {
  const f = await fixture();

  try {
    const a = await f.start();
    const taskA = await f.dispatch("Turn A assignment");
    await f.engine.reporting.finish(f.owner(a.id), f.caller().signal);
    expect(f.turns).toHaveLength(0);
    const b = await f.start("turn-b");
    const taskB = await f.dispatch("Turn B queued", "chief", "captain-a", true);
    const other = await f.start("other-captain", "captain-b");
    const taskOther = await f.dispatch("Other captain", "luigi", "captain-b");
    await f.complete(taskA.id, "Turn A result");
    await f.complete(taskOther.id, "Other result");
    const started = f.started();
    await f.read(a.id);
    await started;
    expect(f.turns[0]?.text).toContain("Turn A assignment");
    expect(f.turns[0]?.text).not.toContain("Turn A result");
    expect(f.turns[0]?.text).not.toContain("Turn B");
    expect(f.turns[0]?.text).not.toContain("Other result");
    expect((await f.read(b.id)).entries.map(({ taskID }) => taskID)).toEqual([
      taskB.id,
      taskA.id,
    ]);
    expect(
      (await f.read(other.id, "captain-b")).entries.every(
        ({ taskID }) => taskID === taskOther.id,
      ),
    ).toBe(true);
    f.turns[0]?.resolve("Chief finished A");
    await f.engine.run({ op: "wait", taskID: f.reportTask(a.id) }, f.caller());
  } finally {
    await f.close();
  }
});

test("queued reporting cancellation never interrupts Twiki's unrelated maintenance", async () => {
  const f = await fixture();

  try {
    const started = f.started();
    const maintenance = await f.dispatch("Keep running", "twiki", "captain-b");
    await started;
    const capture = await f.start();
    const task = await f.dispatch("Feature");
    await f.complete(task.id, "Ready");
    await f.engine.reporting.finish(f.owner(capture.id), f.caller().signal);
    await f.engine.reporting.cancel(f.owner(capture.id), f.caller().signal);
    expect(f.engine.state.reporting.reportTaskID(capture.id)).toBeUndefined();
    expect(["complete", "cancelled"]).toContain(
      (await f.read(capture.id)).status,
    );
    expect(f.turns[0]?.signal.aborted).toBe(false);
    f.turns[0]?.resolve("Done");
    await f.engine.run(
      { op: "wait", taskID: maintenance.id },
      f.caller("captain-b"),
    );
    expect(f.turns).toHaveLength(1);
  } finally {
    await f.close();
  }
});

for (const operation of ["finish", "read"] as const) {
  test(`${operation} report job survives RPC abort after return`, async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    const reporterFree = f.engine.reporterFree.bind(f.engine);
    f.engine.reporterFree = async (id, signal) => {
      entered.resolve(signal);
      await release.promise;
      signal.throwIfAborted();

      return reporterFree(id, signal);
    };

    try {
      const capture = await f.start();
      const task = await f.dispatch("Feature");

      if (operation === "read") {
        await f.engine.reporting.finish(f.owner(capture.id), f.caller().signal);
      }

      await f.complete(task.id, "Ready");
      const rpc = new AbortController();
      const started = f.started();
      await f.engine.reporting[operation](f.owner(capture.id), rpc.signal);
      const ownerSignal = await entered.promise;
      rpc.abort();
      expect(ownerSignal.aborted).toBe(false);
      release.resolve();
      await started;
      f.turns[0]?.resolve("Chief: ready");
      await f.engine.run(
        { op: "wait", taskID: f.reportTask(capture.id) },
        f.caller(),
      );
      expect((await f.read(capture.id)).status).toBe("complete");
    } finally {
      release.resolve();
      await f.close();
    }
  });
}

for (const phase of ["reporterFree", "progressReport"] as const) {
  for (const stop of ["cancel", "close"] as const) {
    test(`${stop} aborts and drains ${phase} before releasing reporting ownership`, async () => {
      const f = await fixture();
      const entered = Promise.withResolvers<AbortSignal>();
      const release = Promise.withResolvers<void>();
      let ownerSignal: AbortSignal | undefined;
      let drained = false;

      const block = async (signal: AbortSignal) => {
        ownerSignal = signal;
        entered.resolve(signal);

        try {
          await release.promise;
        } finally {
          drained = true;
        }
      };

      if (phase === "reporterFree") {
        const original = f.engine.reporterFree.bind(f.engine);
        f.engine.reporterFree = async (id, signal) => {
          await block(signal);

          return original(id, signal);
        };
      } else {
        const original = f.engine.progressReport.bind(f.engine);
        f.engine.progressReport = async (id, caller) => {
          await block(caller.signal);

          // A busy admission may return without promoting or throwing.
          if (caller.signal.aborted) {
            return;
          }

          return original(id, caller);
        };
      }

      try {
        const capture = await f.start();
        const task = await f.dispatch("Feature");
        await f.complete(task.id, "Ready");
        await f.engine.reporting.finish(f.owner(capture.id), f.caller().signal);
        await entered.promise;
        let stopped = false;

        const stopping = (
          stop === "cancel"
            ? f.engine.reporting.cancel(f.owner(capture.id), f.caller().signal)
            : f.engine.reporting.close()
        ).then(() => {
          stopped = true;
        });

        // Cancellation verifies the RPC caller before it can abort owned work.
        if (stop === "cancel") {
          await f.engine.reporting.read(
            { ...f.owner(capture.id), passive: true },
            f.caller().signal,
          );
        }

        expect(ownerSignal?.aborted).toBe(true);
        expect(stopped).toBe(false);
        expect(drained).toBe(false);
        release.resolve();
        await stopping;
        expect(drained).toBe(true);
        expect(f.turns).toEqual([]);
        const reportID = f.engine.state.reporting.reportTaskID(capture.id);

        if (phase === "progressReport") {
          expect(reportID).toBeDefined();
          expect(f.engine.state.task(reportID ?? "")).toMatchObject({
            status: "cancelled",
            released: 1,
          });
        } else {
          expect(reportID).toBeUndefined();
        }

        expect(
          f.engine.state.reporting.owned("captain-a", capture.id).status,
        ).toBe(stop === "cancel" ? "cancelled" : "unavailable");
      } finally {
        release.resolve();
        await f.close();
      }
    });
  }
}

test("failed queued report cleanup records safe unavailable and drains", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.engine.progressReport = async () => {
    entered.resolve();
    await release.promise;
    throw new Error("private admission details");
  };

  f.engine.cancelReport = async () => {
    throw new Error("private cleanup details");
  };

  try {
    const capture = await f.start();
    const task = await f.dispatch("Feature");
    await f.complete(task.id, "Ready");
    await f.engine.reporting.finish(f.owner(capture.id), f.caller().signal);
    await entered.promise;

    const closing = f.engine.reporting.close().then(
      () => "closed",
      (error: unknown) => error,
    );

    release.resolve();
    expect(await closing).toBe("closed");
    expect(
      f.engine.state.reporting.owned("captain-a", capture.id),
    ).toMatchObject({
      status: "unavailable",
      summary: "Activity reporter cleanup unconfirmed; raw details withheld.",
    });
    expect(f.turns).toEqual([]);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("accepted capture cancellation does not access state after concurrent close", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.engine.reporterFree = async () => {
    entered.resolve();
    await release.promise;

    return true;
  };

  try {
    const capture = await f.start();
    const task = await f.dispatch("Feature");
    await f.complete(task.id, "Ready");
    await f.engine.reporting.finish(f.owner(capture.id), f.caller().signal);
    await entered.promise;

    const cancelling = f.engine.reporting
      .cancel(f.owner(capture.id), f.caller().signal)
      .then(
        (result) => result,
        (error: unknown) => error,
      );

    expect(
      await f.engine.reporting.read(
        { ...f.owner(capture.id), passive: true },
        f.caller().signal,
      ),
    ).toMatchObject({ status: "cancelled" });
    let lateAccess = 0;
    f.engine.state.reporting.owned = () => {
      lateAccess++;
      throw new Error("State accessed after reporter close");
    };

    f.engine.cancelReport = async () => {
      lateAccess++;
      throw new Error("Engine accessed after reporter close");
    };

    const closing = f.engine.close();
    release.resolve();
    await closing;
    expect(await cancelling).toBe(true);
    expect(lateAccess).toBe(0);
    expect(f.turns).toEqual([]);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("reporter close rejects verification that resumes after owner drain", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  try {
    const capture = await f.start();
    const task = await f.dispatch("Feature");
    await f.complete(task.id, "Ready");
    const get = f.sessions.get.bind(f.sessions);
    f.sessions.get = async (...args) => {
      const session = await get(...args);
      entered.resolve();
      await release.promise;

      return session;
    };

    const finishing = f.engine.reporting.finish(
      f.owner(capture.id),
      f.caller().signal,
    );

    const outcome = finishing.then(
      () => new Error("Unexpected reporting success"),
      (error: unknown) => error,
    );

    await entered.promise;
    await f.engine.close();
    release.resolve();
    expect(await outcome).toMatchObject({
      message: "Activity reporter is closing.",
    });
    expect(f.turns).toEqual([]);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("pre-aborted reporting RPCs cannot authorize jobs or cancel captures", async () => {
  const f = await fixture();

  try {
    const capture = await f.start();
    const task = await f.dispatch("Feature");
    await f.complete(task.id, "Ready");
    const signal = AbortSignal.abort();

    for (const operation of ["read", "finish", "cancel"] as const) {
      await expect(
        f.engine.reporting[operation](f.owner(capture.id), signal),
      ).rejects.toThrow();
    }

    await expect(
      f.engine.reporting.start(
        { sessionID: "captain-a", requestID: "denied" },
        signal,
      ),
    ).rejects.toThrow();
    expect((await f.read(capture.id)).status).toBe("collecting");
    expect(f.engine.state.reporting.reportTaskID(capture.id)).toBeUndefined();
    expect(f.turns).toEqual([]);
  } finally {
    await f.close();
  }
});

test("active reporting cancellation aborts only its own task", async () => {
  const f = await fixture();

  try {
    const capture = await f.start();
    const task = await f.dispatch("Feature");
    await f.complete(task.id, "Ready");
    const started = f.started();
    await f.engine.reporting.finish(f.owner(capture.id), f.caller().signal);
    await started;
    await f.engine.reporting.cancel(f.owner(capture.id), f.caller().signal);
    expect(f.turns[0]?.signal.aborted).toBe(true);
    expect((await f.read(capture.id)).status).toBe("cancelled");
    expect(f.engine.state.task(f.reportTask(capture.id))?.status).toBe(
      "uncertain",
    );
  } finally {
    await f.close();
  }
});

test("follow-up captain messages cannot enter an earlier turn's linked task capture", async () => {
  const f = await fixture();

  try {
    const first = await f.start();
    const task = await f.dispatch("Original task");
    await f.engine.reporting.finish(f.owner(first.id), f.caller().signal);
    const second = await f.start("follow-up");
    await f.engine.mail(
      {
        op: "send",
        taskID: task.id,
        to: "chief",
        text: "FOLLOWUP PRIVATE INPUT",
        key: "follow-up",
      },
      f.caller(),
    );
    expect(JSON.stringify(await f.read(first.id))).not.toContain(
      "FOLLOWUP PRIVATE INPUT",
    );
    expect(JSON.stringify((await f.read(second.id)).entries)).toContain(
      "FOLLOWUP PRIVATE INPUT",
    );
  } finally {
    await f.close();
  }
});

test("deadline reports missing results without promoting unrelated source tasks", async () => {
  const f = await fixture();

  try {
    const capture = await f.start();
    const task = await f.dispatch("Unfinished source task");
    await f.engine.reporting.finish(f.owner(capture.id), f.caller().signal);
    expect(f.turns).toHaveLength(0);
    const db = new Database(f.engine.state.path);

    try {
      db.query("UPDATE activity_captures SET deadline=0 WHERE id=?").run(
        capture.id,
      );
    } finally {
      db.close();
    }

    const final = await f.read(capture.id);
    expect(final.summary).toContain("deadline reached");
    expect(JSON.stringify(final.entries)).toContain("Unfinished source task");
    expect(f.engine.state.task(task.id)?.status).toBe("running");
    expect(f.turns).toEqual([]);
    expect((await f.read(capture.id)).status).toBe("complete");
  } finally {
    await f.close();
  }
});

test("concurrent location engines reserve only one reporting task", async () => {
  const f = await fixture();

  const other = await CrewEngine.open(
    f.options,
    f.sessions,
    undefined,
    undefined,
    f.factory,
  );

  try {
    const capture = await f.start();
    const task = await f.dispatch("Feature");
    await f.complete(task.id, "Ready");
    const started = f.started();
    await Promise.all([
      f.engine.reporting.finish(f.owner(capture.id), f.caller().signal),
      other.reporting.finish(f.owner(capture.id), f.caller().signal),
    ]);
    await started;
    const db = new Database(f.engine.state.path, { readonly: true });

    try {
      expect(
        db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM activity_report_tasks WHERE captureID=?",
          )
          .get(capture.id)?.count,
      ).toBe(1);
    } finally {
      db.close();
    }

    expect(f.turns).toHaveLength(1);
    f.turns[0]?.resolve("Chief: ready");
    await f.engine.run(
      { op: "wait", taskID: f.reportTask(capture.id) },
      f.caller(),
    );
    expect((await f.read(capture.id)).status).toBe("complete");
  } finally {
    await other.close();
    await f.close();
  }
});

test("abandoned capture expires; bounded windows and input redaction survive persistence", async () => {
  const f = await fixture();

  try {
    const capture = await f.start();
    const task = await f.dispatch("A".repeat(2000));

    for (let index = 0; index < 12; index++) {
      await f.engine.run(
        {
          op: "urgent",
          taskID: task.id,
          to: "captain",
          text: `Notice ${index}`,
        },
        {
          sessionID: task.workerSessionID,
          agent: task.crewID,
          signal: f.caller().signal,
          id: `urgent-${index}`,
        },
      );
    }

    const current = await f.read(capture.id);
    expect(current.entries).toHaveLength(8);
    expect(current.truncated).toBe(true);
    expect(current.entries.at(-1)?.text).toContain("Notice 11");
    f.engine.state.reporting.expire(Date.now() + 300_001);
    expect((await f.read(capture.id)).status).toBe("unavailable");
    await f.complete(task.id, "After expiry");
    const later = await f.start("later-turn");
    expect((await f.read(later.id)).entries).toEqual([]);
    expect((await f.read(later.id)).entries).toEqual([]);
  } finally {
    await f.close();
  }

  const redacted = redactCredentials(
    [
      "xoxb-111-slack xapp-111-app sk-proj-provider ghp_github",
      "Authorization: Bearer bearer-secret",
      "password='quoted secret'",
      '"API_KEY": "json-secret"',
      "credential=another-secret",
      [
        ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
        "private-secret",
        ["-----END", "PRIVATE KEY-----"].join(" "),
      ].join("\n"),
    ].join("\n"),
  );

  for (const secret of [
    "111-slack",
    "111-app",
    "proj-provider",
    "ghp_github",
    "bearer-secret",
    "quoted secret",
    "json-secret",
    "another-secret",
    "private-secret",
  ]) {
    expect(redacted).not.toContain(secret);
  }
});

test("reporter absence and unsafe backend return truthful unavailable without maintenance inference", async () => {
  const f = await fixture(false);

  try {
    const missing = await f.start("missing", "captain-a", "unknown");
    expect(missing.status).toBe("collecting");
    expect(missing.summary).toContain("Summary skipped");
    const capture = await f.start();
    const task = await f.dispatch("Feature");
    await f.complete(task.id, "Ready");
    await f.engine.reporting.finish(f.owner(capture.id), f.caller().signal);
    await f.opened;
    let snapshot = await f.read(capture.id);

    for (
      let attempt = 0;
      attempt < 10 && snapshot.status === "summarizing";
      attempt++
    ) {
      snapshot = await f.read(capture.id);
    }

    expect(snapshot.status).toBe("complete");
    expect(snapshot.summary).toContain("Summary skipped");
    expect(f.turns).toHaveLength(0);
    expect(f.engine.state.reporting.reportTaskID(capture.id)).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("restart preserves capture/task identity and does not replay unconfirmed reporting", async () => {
  const f = await fixture();

  try {
    const capture = await f.start();
    const task = await f.dispatch("Feature");
    await f.complete(task.id, "Ready");
    const started = f.started();
    await f.engine.reporting.finish(f.owner(capture.id), f.caller().signal);
    await started;
    const reportID = f.reportTask(capture.id);
    const sessionID = f.engine.state.task(reportID)?.workerSessionID;
    await f.engine.close();

    const reopened = await CrewEngine.open(
      f.options,
      f.sessions,
      undefined,
      undefined,
      f.factory,
    );

    try {
      const snapshot = await reopened.reporting.read(
        f.owner(capture.id),
        f.caller().signal,
      );

      expect(snapshot.status).toBe("unavailable");
      expect(reopened.state.task(reportID)?.workerSessionID).toBe(sessionID);
      expect(reopened.state.task(reportID)?.status).toBe("uncertain");
      expect(f.turns).toHaveLength(1);
      expect(f.creations).toBe(1);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

function completion(content: string, toolCall?: object) {
  const chunk = (delta: object, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({
      id: "report-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "opencode-go/deepseek-v4.1-flash",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;

  return new Response(
    chunk({ role: "assistant" }) +
      chunk(toolCall ? { tool_calls: [toolCall] } : { content }) +
      chunk({}, toolCall ? "tool_calls" : "stop") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("real Pi reporting uses fresh context and no tools; maintenance conversation stays unchanged", async () => {
  const directory = await mkdtemp(join(fixtureRoot(), "stargate-report-sdk-"));
  const apiKeyEnv = "STARGATE_REPORTING_PROXY_TEST_KEY";
  const previous = process.env[apiKeyEnv];
  process.env[apiKeyEnv] = "fixture-only";

  const requests: { body: Record<string, unknown>; session: string | null }[] =
    [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests.push({
        body: await request.json(),
        session: request.headers.get("x-opencode-session"),
      });

      return completion(`Fixture answer ${requests.length}`);
    },
  });

  let backend: PiDurableBackend | undefined;
  const signal = new AbortController().signal;

  try {
    backend = await PiDurableBackend.open(
      Schema.decodeUnknownSync(piDurableBackendSchema)({
        type: "pi-durable",
        model: "openai/opencode-go/deepseek-v4.1-flash",
        directory,
        tools: "coding",
        systemPrompt: "UNRELATED MAINTENANCE INSTRUCTIONS",
        provider: { baseURL: new URL("/v1", server.url).href, apiKeyEnv },
      }),
      { dataDirectory: directory },
    );

    const maintenance = await backend.createSession({
      key: "worker",
      title: "Twiki",
      signal,
    });

    await backend.prompt(maintenance, "PRIVATE OTHER SLACK THREAD", signal);
    await backend.promptReport(maintenance, "ONLY SANITIZED CAPTURE A", signal);
    await backend.promptReport(maintenance, "ONLY SANITIZED CAPTURE B", signal);
    await backend.prompt(maintenance, "Continue original maintenance", signal);
    expect(requests).toHaveLength(4);

    for (const index of [1, 2]) {
      const body = requests[index]?.body;
      expect(body?.["tools"] ?? []).toEqual([]);
      const messages = JSON.stringify(body?.["messages"]);
      expect(messages).not.toContain("PRIVATE OTHER SLACK THREAD");
      expect(messages).not.toContain("UNRELATED MAINTENANCE INSTRUCTIONS");
      expect(messages).not.toContain("Fixture answer 1");
      expect(messages).toContain(index === 1 ? "CAPTURE A" : "CAPTURE B");
    }

    expect(JSON.stringify(requests[2]?.body["messages"])).not.toContain(
      "CAPTURE A",
    );
    expect(JSON.stringify(requests[2]?.body["messages"])).not.toContain(
      "Fixture answer 2",
    );
    const resumed = JSON.stringify(requests[3]?.body["messages"]);
    expect(resumed).toContain("PRIVATE OTHER SLACK THREAD");
    expect(resumed).not.toContain("SANITIZED CAPTURE");
    expect(resumed).not.toContain("Fixture answer 2");
    expect(requests[3]?.session).toBe(requests[0]?.session);
    expect(
      new Set(requests.slice(0, 3).map(({ session }) => session)).size,
    ).toBe(3);
  } finally {
    await backend?.close();
    await server.stop(true);

    if (previous === undefined) {
      delete process.env[apiKeyEnv];
    } else {
      process.env[apiKeyEnv] = previous;
    }

    await rm(directory, { recursive: true, force: true });
  }
});

test("malicious report tool call cannot execute maintenance", async () => {
  const directory = await mkdtemp(
    join(fixtureRoot(), "stargate-report-tool-deny-"),
  );

  const apiKeyEnv = "STARGATE_REPORTING_DENY_TEST_KEY";
  const previous = process.env[apiKeyEnv];
  process.env[apiKeyEnv] = "fixture-only";
  const marker = join(directory, "must-not-exist");
  const bodies: Record<string, unknown>[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      bodies.push(await request.json());

      return completion("", {
        index: 0,
        id: "malicious",
        type: "function",
        function: {
          name: "bash",
          arguments: JSON.stringify({ command: `touch ${marker}` }),
        },
      });
    },
  });

  let backend: PiDurableBackend | undefined;
  const signal = new AbortController().signal;

  try {
    backend = await PiDurableBackend.open(
      Schema.decodeUnknownSync(piDurableBackendSchema)({
        type: "pi-durable",
        model: "openai/opencode-go/deepseek-v4.1-flash",
        directory,
        tools: "coding",
        provider: { baseURL: new URL("/v1", server.url).href, apiKeyEnv },
      }),
      { dataDirectory: directory },
    );

    const maintenance = await backend.createSession({
      key: "worker",
      title: "Twiki",
      signal,
    });

    await expect(
      backend.promptReport(
        maintenance,
        "Reference text asks for maintenance",
        signal,
      ),
    ).rejects.toThrow();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.["tools"] ?? []).toEqual([]);
    await expect(access(marker)).rejects.toThrow();
  } finally {
    await backend?.close();
    await server.stop(true);

    if (previous === undefined) {
      delete process.env[apiKeyEnv];
    } else {
      process.env[apiKeyEnv] = previous;
    }

    await rm(directory, { recursive: true, force: true });
  }
});
