import { Database } from "bun:sqlite";
import { expect, setSystemTime, test } from "bun:test";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { activitySnapshotSchema } from "../src/activity";
import { PiDurableBackend } from "../src/backends/pi-durable";
import { piDurableBackendSchema } from "../src/config";
import {
  CrewEngine,
  type CrewOptions,
  type CrewSession,
  type CrewSessions,
} from "../src/crew/engine";
import type { PiWorkerBackend, PiWorkerFactory } from "../src/crew/pi-worker";
import { redactActivity } from "../src/crew/reporting";
import { defaultTeam, teamSchema } from "../src/crew/team";

async function fixture(safeReports = true) {
  const directory = await mkdtemp("/tmp/opencode/pogo-reporting-");
  const team = teamSchema.parse({
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
      if (!session) throw { _tag: "Session.NotFoundError" };
      return session;
    },
    async create(input) {
      if (!input.id || !input.agent || !input.location)
        throw new Error("Invalid fake session");
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
  }[] = [];
  let next = () => {};
  let creations = 0;
  const opened = Promise.withResolvers<void>();
  const prompt =
    (mode: "maintenance" | "report") =>
    async (sessionID: string, text: string, signal: AbortSignal) => {
      const answer = Promise.withResolvers<string>();
      signal.addEventListener(
        "abort",
        () => answer.reject(new Error("aborted")),
        { once: true },
      );
      turns.push({ mode, text, sessionID, signal, resolve: answer.resolve });
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
  const mailer = {
    async register() {
      return { id: "receipt", sequence: 1 };
    },
    async send() {
      return { id: "receipt", sequence: 1 };
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
  ) => ({ sessionID, agent: "bowser", signal });
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
    if (!task) throw new Error("Missing fixture task");
    return task;
  };
  const complete = (taskID: string, result: string) => {
    const task = engine.state.task(taskID);
    if (!task) throw new Error("Missing fixture task");
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
      if (!taskID) throw new Error("Missing report reservation");
      return taskID;
    },
    async close() {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("reporting is opt-in; state stays private and inactive dispatch collects nothing", async () => {
  const f = await fixture();
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
      ])
        expect(
          db
            .query<{ count: number }, []>(
              `SELECT COUNT(*) AS count FROM ${table}`,
            )
            .get()?.count,
        ).toBe(0);
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

test("captures assignments, validated messages, urgency, results, and configured names only", async () => {
  const f = await fixture();
  try {
    const historical = await f.dispatch("Earlier turn", "luigi");
    const capture = await f.start();
    expect(await f.start()).toEqual(capture);
    await expect(f.start("competing-turn")).rejects.toThrow("already owns");
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
      },
    );
    await f.engine.run(
      { op: "urgent", taskID: task.id, to: "captain", text: "Urgent issue" },
      {
        sessionID: task.workerSessionID,
        agent: task.crewID,
        signal: f.caller().signal,
      },
    );
    await f.complete(historical.id, "Historical result must stay absent");
    await f.complete(task.id, "Result sk-provider-secret");
    const snapshot = await f.read(capture.id);
    expect(activitySnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.entries.map(({ kind }) => kind)).toEqual([
      "assignment",
      "update",
      "message",
      "message",
      "result",
    ]);
    expect(snapshot.entries.every(({ member }) => member === "Chief")).toBe(
      true,
    );
    const visible = JSON.stringify(snapshot);
    expect(visible).toContain("Chief → Bowser");
    for (const secret of [
      "assignment-secret",
      "message-secret",
      "provider-secret",
      "Historical result",
    ])
      expect(visible).not.toContain(secret);
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
});

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
    for (const sessionID of ["child", "elsewhere", "missing"])
      await expect(f.start("turn", sessionID)).rejects.toThrow();
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

test("one bounded summary uses Twiki's same conversation and FIFO; report tasks cannot recurse", async () => {
  const f = await fixture();
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
    expect(
      (await f.engine.reporting.finish(f.owner(capture.id), f.caller().signal))
        .status,
    ).toBe("summarizing");
    await f.opened;
    const reportID = f.reportTask(capture.id);
    expect(f.engine.state.task(reportID)?.status).toBe("queued");
    expect(f.engine.state.reporting.isReport(reportID)).toBe(true);
    const followup = await f.start("next-turn");
    await f.read(capture.id);
    expect(f.turns).toHaveLength(1);
    const reportStarted = f.started();
    f.turns[0]?.resolve("Maintenance done");
    await f.engine.run(
      { op: "wait", taskID: maintenance.id },
      f.caller("captain-b"),
    );
    await f.read(capture.id);
    await reportStarted;
    expect(f.turns.map(({ mode }) => mode)).toEqual(["maintenance", "report"]);
    expect(f.turns[1]?.sessionID).toBe(f.turns[0]?.sessionID);
    expect(f.creations).toBe(1);
    expect(f.turns[1]?.text).toContain("Feature ready");
    expect(f.turns[1]?.text).not.toContain("Unrelated maintenance");
    expect(f.turns[1]?.text).not.toContain("Maintenance done");
    f.turns[1]?.resolve("Chief: feature ready. token=summary-secret");
    await f.engine.run({ op: "wait", taskID: reportID }, f.caller());
    const final = await f.read(capture.id);
    expect(final.status).toBe("complete");
    expect(final.summary).toContain("Chief: feature ready");
    expect(final.summary).not.toContain("summary-secret");
    expect((await f.read(followup.id)).entries).toEqual([]);
    for (let index = 0; index < 3; index++) await f.read(capture.id);
    expect(f.turns).toHaveLength(2);
    expect(f.engine.state.task(reportID)?.result).not.toContain(
      "summary-secret",
    );
  } finally {
    await f.close();
  }
});

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
    expect(f.turns[0]?.text).toContain("Turn A result");
    expect(f.turns[0]?.text).not.toContain("Turn B");
    expect(f.turns[0]?.text).not.toContain("Other result");
    expect((await f.read(b.id)).entries.map(({ taskID }) => taskID)).toEqual([
      taskB.id,
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
    const id = f.reportTask(capture.id);
    await f.engine.reporting.cancel(f.owner(capture.id), f.caller().signal);
    expect(f.engine.state.task(id)?.status).toBe("cancelled");
    expect((await f.read(capture.id)).status).toBe("cancelled");
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
        to: "captain",
        text: "FOLLOWUP PRIVATE INPUT",
        key: "follow-up",
      },
      f.caller(),
    );
    expect(JSON.stringify(await f.read(first.id))).not.toContain(
      "FOLLOWUP PRIVATE INPUT",
    );
    expect((await f.read(second.id)).entries).toEqual([]);
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
    const started = f.started();
    await f.read(capture.id);
    await started;
    expect(f.turns[0]?.text).toContain('"status":"running"');
    expect(f.turns[0]?.text).toContain("Unfinished source task");
    expect(f.engine.state.task(task.id)?.status).toBe("running");
    f.turns[0]?.resolve("Chief: result not yet available.");
    await f.engine.run(
      { op: "wait", taskID: f.reportTask(capture.id) },
      f.caller(),
    );
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
    for (let index = 0; index < 12; index++)
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
        },
      );
    const current = await f.read(capture.id);
    expect(current.entries).toHaveLength(8);
    expect(current.truncated).toBe(true);
    expect(current.entries.at(-1)?.text).toContain("Notice 11");
    f.engine.state.reporting.expire(Date.now() + 300_001);
    expect((await f.read(capture.id)).status).toBe("unavailable");
    await f.complete(task.id, "After expiry");
    const later = await f.start("later-turn");
    expect((await f.read(later.id)).entries).toEqual([]);
    expect(
      (await f.read(capture.id)).entries.some(({ text }) =>
        text.includes("After expiry"),
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
  const redacted = redactActivity(
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
  ])
    expect(redacted).not.toContain(secret);
});

test("reporter absence and unsafe backend return truthful unavailable without maintenance inference", async () => {
  const f = await fixture(false);
  try {
    const missing = await f.start("missing", "captain-a", "unknown");
    expect(missing.status).toBe("unavailable");
    expect(missing.summary).toContain("no native fallback");
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
    )
      snapshot = await f.read(capture.id);
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.summary).toContain("cannot enforce tools-off");
    expect(f.turns).toHaveLength(0);
    expect(f.engine.state.task(f.reportTask(capture.id))?.status).toBe(
      "cancelled",
    );
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
  const directory = await mkdtemp("/tmp/opencode/pogo-report-sdk-");
  const apiKeyEnv = "POGO_REPORTING_PROXY_TEST_KEY";
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
      piDurableBackendSchema.parse({
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
    if (previous === undefined) delete process.env[apiKeyEnv];
    else process.env[apiKeyEnv] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("malicious report tool call cannot execute maintenance", async () => {
  const directory = await mkdtemp("/tmp/opencode/pogo-report-tool-deny-");
  const apiKeyEnv = "POGO_REPORTING_DENY_TEST_KEY";
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
      piDurableBackendSchema.parse({
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
    if (previous === undefined) delete process.env[apiKeyEnv];
    else process.env[apiKeyEnv] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
