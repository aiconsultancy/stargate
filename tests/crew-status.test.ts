import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import pino from "pino";
import type { AgentBackend } from "../src/backends/backend";
import {
  CrewEngine,
  type CrewOptions,
  type CrewSessions,
} from "../src/coordination/crew/execution/engine";
import { crewInputSchema } from "../src/coordination/crew/input/crew-tool-input";
import { fleetCrewFullStatusSchema } from "../src/coordination/crew/reporting/fleet-status";
import { MemberActivityStore } from "../src/coordination/crew/reporting/member-activity";
import { teamSchema } from "../src/coordination/crew/team";
import { redactCredentials } from "../src/lib/credentials";
import {
  dashboardCrewMembers,
  dashboardCrewSummary,
} from "../src/observability/dashboard/dashboard-projection";
import {
  codePointHead,
  crewStatusSchema,
  crewTaskTextLimit,
  truncateCrewTaskText,
} from "../src/shared/crew-status";
import { CrewUI, crewStatusView } from "../src/transports/slack/crew-ui";
import type { CronView, SlackAck } from "../src/automation/cron/ui";
import { bot, identity } from "./fixtures";
import {
  copyCrewDatabase,
  historyTaskID,
  statusHistoryFixture,
} from "./fixtures/database-reuse";
import { fixtureRoot } from "./fixture-root";

export type CrewUIAckCompatibility<
  T extends SlackAck = Parameters<CrewUI["command"]>[1],
> = T;

async function fixture(history = false) {
  const directory = await mkdtemp(
    join(fixtureRoot(), "stargate-member-status-"),
  );

  const team = Schema.decodeUnknownSync(teamSchema)({
    captain: { id: "adama" },
    crew: [
      { id: "chief", role: "Engineering", permissionProfile: "coding" },
      {
        id: "twiki",
        name: "Twiki",
        role: "Maintenance",
        permissionProfile: "coding",
        backend: { type: "pi-durable", model: "openai/local" },
      },
      { id: "new", role: "Not provisioned", permissionProfile: "coding" },
    ],
  });

  const options: CrewOptions = {
    namespace: "status",
    stateDirectory: directory,
    projectDirectory: directory,
    captainDirectory: join(directory, "captain"),
    team,
    worktrees: Object.fromEntries(
      team.crew.map(({ id }) => [id, join(directory, id)]),
    ),
    mesijCommand: "/usr/bin/mesij",
  };

  let calls = 0;

  const forbidden = async (): Promise<never> => {
    calls++;
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

  if (history) {
    await copyCrewDatabase(directory, options.namespace, statusHistoryFixture);
  }

  const engine = await CrewEngine.open(
    options,
    sessions,
    undefined,
    undefined,
    forbidden,
  );

  return {
    directory,
    engine,
    options,
    sessions,
    get calls() {
      return calls;
    },
    async close() {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("read-only roster shows Pi/OpenCode/unprovisioned, stale running and bounded FIFO without reconciliation", async () => {
  const f = await fixture();

  try {
    const chief = f.engine.state.reservePeer("chief");
    const twiki = f.engine.state.reservePeer("twiki");
    f.engine.state.readyPeer("twiki");

    const native = f.engine.state.reserveTask(
      chief,
      "captain",
      "Review engineering",
    );

    const maintenance = f.engine.state.reserveTask(
      twiki,
      "captain",
      "Twiki cleanup token=topsecret",
    );

    if (!native || !maintenance) {
      throw new Error("Missing task");
    }

    f.engine.state.running(native.id);
    f.engine.state.running(maintenance.id);

    for (let i = 0; i < 7; i++) {
      f.engine.state.enqueue(twiki, "captain", `Queued cleanup ${i}`);
    }

    const db = new Database(f.engine.state.path, { readonly: true });

    try {
      const before = db.serialize();

      const roster = Schema.decodeUnknownSync(crewStatusSchema)(
        f.engine.status(),
      );

      expect(roster.members.map(({ backend }) => backend)).toEqual([
        "opencode",
        "pi-durable",
        "opencode",
      ]);
      expect(roster.members[2]).toMatchObject({
        provisioned: "unprovisioned",
        current: null,
        queuedCount: 0,
        lastOutcome: null,
      });
      expect(roster.members[0]).toMatchObject({
        provisioned: "pending",
        observed: false,
        current: { status: "running" },
      });
      const detail = f.engine.status({ member: "twiki" });
      expect(detail.members).toHaveLength(1);
      expect(detail.members[0]).toMatchObject({
        provisioned: "ready",
        observed: false,
        current: {
          status: "running",
          summary: "Twiki cleanup token=[REDACTED]",
        },
        queuedCount: 7,
      });
      expect(detail.members[0]?.queued.map(({ summary }) => summary)).toEqual(
        Array.from({ length: 5 }, (_, i) => `Queued cleanup ${i}`),
      );
      expect(JSON.stringify(crewStatusView(detail, true))).toContain(
        "showing 5 of 7 (truncated)",
      );
      expect(f.engine.status({ member: "missing" }).members).toEqual([]);
      expect(f.calls).toBe(0);
      expect(db.serialize().equals(before)).toBe(true);
      expect(f.engine.state.task(maintenance.id)?.status).toBe("running");
      expect(f.engine.state.task(native.id)?.status).toBe("running");
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test("crew status readers show raw stored task text exactly as before: redacted and bounded on read", async () => {
  const f = await fixture();

  try {
    const twiki = f.engine.state.reservePeer("twiki");
    f.engine.state.readyPeer("twiki");
    const assignment = `Deploy with token=fixture-value ${"é".repeat(300)} end`;
    const progress = `${"p".repeat(500)} password=fixture-value tail`;
    const task = f.engine.state.reserveTask(twiki, "captain", assignment);

    if (!task) {
      throw new Error("Missing task");
    }

    f.engine.state.running(task.id);
    f.engine.state.activity.progress(task.id, progress);
    f.engine.state.enqueue(twiki, "captain", assignment);

    // What the store held before it kept raw text.
    const summary = redactCredentials(assignment, 180);
    const tail = redactCredentials(progress, 64_000).slice(-400);
    expect(summary).toContain("token=[REDACTED]");
    expect(tail).toContain("password=[REDACTED]");

    // Crew status RPC and tool: the engine's ordinary status.
    const status = f.engine.status({ member: "twiki" });
    const member = status.members[0];
    expect(member?.current).toMatchObject({ summary, progress: tail });
    expect(member?.queued.map((queued) => queued.summary)).toEqual([summary]);

    // Health parses with the shared CrewStatus caps, which raw text exceeds.
    expect(Schema.decodeUnknownSync(crewStatusSchema)(status)).toEqual(status);

    // Slack crew UI and the operator dashboard render only that status.
    for (const shown of [
      crewStatusView(status, true),
      crewStatusView(f.engine.status(), false),
      dashboardCrewMembers(status),
      dashboardCrewSummary(status),
    ]) {
      expect(JSON.stringify(shown)).not.toContain("fixture-value");
    }

    expect(JSON.stringify(crewStatusView(status, true))).toContain(
      "token=[REDACTED]",
    );

    // Only an explicit full-text read sees the stored text.
    const full = f.engine.status({ member: "twiki" }, { taskText: "full" });
    expect(full.members[0]?.current).toMatchObject({
      summary: assignment,
      progress,
    });
    expect(full.members[0]?.queued[0]?.summary).toBe(assignment);

    // Raw text keeps control and bidi characters; ordinary readers still
    // Strip C0/C1 controls on read, as before.
    const controls = "Run \u001b[2J \u0007 \u009b1m \u202edone";
    f.engine.state.activity.progress(task.id, controls);
    expect(
      f.engine.status({ member: "twiki" }, { taskText: "full" }).members[0]
        ?.current?.progress,
    ).toBe(controls);
    expect(
      f.engine.status({ member: "twiki" }).members[0]?.current?.progress,
    ).toBe(redactCredentials(controls, 64_000).slice(-400));
  } finally {
    await f.close();
  }
});

test("ordinary task text masks credentials revealed by stripping controls", async () => {
  const f = await fixture();

  try {
    const peer = f.engine.state.reservePeer("twiki");
    f.engine.state.readyPeer("twiki");
    const text = "Check to\u0007ken=fixture-value before deployment";
    const task = f.engine.state.reserveTask(peer, "captain", text);

    if (!task) {
      throw new Error("Missing task");
    }

    f.engine.state.running(task.id);
    f.engine.state.activity.progress(task.id, text);
    const masked = "Check token=[REDACTED] before deployment";
    expect(
      f.engine.status({ member: "twiki" }).members[0]?.current,
    ).toMatchObject({ summary: masked, progress: masked });

    for (const taskText of ["unredacted", "full"] as const) {
      const status = f.engine.status({ member: "twiki" }, { taskText });
      expect(status.members[0]?.current).toMatchObject({
        summary: text,
        progress: text,
      });
    }
  } finally {
    await f.close();
  }
});

test("Fleet task text keeps a clipped preamble as stored, for both retained and modern assignments", async () => {
  const f = await fixture();

  try {
    const state = f.engine.state;
    const peer = state.reservePeer("twiki");
    state.readyPeer(peer.crewID);
    const scaffold = `Configured Stargate project: sample.\nUse only your permanent worktree: "/${"x".repeat(180)}"`;

    // Pre-#76 stored the first 180 characters of the prefixed input.
    const summary = scaffold.slice(0, 180);
    const current = state.reserveTask(peer, "captain", summary);

    if (!current) {
      throw new Error("Missing modern assignment");
    }

    state.running(current.id);
    const retained = state.enqueue(peer, "captain", "Retained assignment");
    const db = new Database(state.path);

    try {
      db.run("UPDATE member_activity SET summary=? WHERE taskID=?", [
        summary,
        retained.id,
      ]);
    } finally {
      db.close();
    }

    for (const taskText of ["unredacted", "full"] as const) {
      const { members } = f.engine.status(
        { member: peer.crewID },
        { taskText },
      );

      expect(members[0]?.current).toMatchObject({ id: current.id, summary });
      expect(members[0]?.queued).toEqual([
        expect.objectContaining({ id: retained.id, summary }),
      ]);
    }
  } finally {
    await f.close();
  }
});

test("ordinary task summary and progress replace a surrogate split at the display cut", async () => {
  const f = await fixture();

  try {
    const peer = f.engine.state.reservePeer("twiki");
    f.engine.state.readyPeer("twiki");

    const task = f.engine.state.reserveTask(
      peer,
      "captain",
      `x${"😀".repeat(90)}`,
    );

    if (!task) {
      throw new Error("Missing task");
    }

    f.engine.state.running(task.id);
    f.engine.state.activity.progress(task.id, `${"😀".repeat(200)}y`);
    const current = f.engine.status({ member: "twiki" }).members[0]?.current;
    expect(current).toMatchObject({
      summary: `x${"😀".repeat(89)}\uFFFD`,
      progress: `\uFFFD${"😀".repeat(199)}y`,
    });
  } finally {
    await f.close();
  }
});

test("code-point head keeps the astral pair at the 64,000-code-point boundary", () => {
  const exact = `${"a".repeat(crewTaskTextLimit - 1)}😀`;
  expect(codePointHead(exact, crewTaskTextLimit)).toBe(exact);
  expect(codePointHead(`${exact}😀`, crewTaskTextLimit)).toBe(exact);
});

test("code-point head handles small limits without splitting an astral character", () => {
  expect(codePointHead("short", 5)).toBe("short");
  expect(codePointHead("a😀b", 2)).toBe("a😀");
  expect(codePointHead("😀", 0)).toBe("");
});

test("stored task text is cut at 64,000 code points without splitting a surrogate pair", async () => {
  const f = await fixture();

  try {
    // One unit, then pairs: the cut lands mid-pair in UTF-16 units.
    const astral = `x${"😀".repeat(70_000)}`;
    const cut = truncateCrewTaskText(astral);
    expect(Array.from(cut)).toHaveLength(crewTaskTextLimit);
    expect(cut).toBe(`x${"😀".repeat(crewTaskTextLimit - 1)}`);
    expect(cut.isWellFormed()).toBe(true);

    const dispatch = Schema.decodeUnknownSync(crewInputSchema);
    const input = { op: "dispatch", crew: "twiki", text: cut };
    expect(dispatch(input)).toMatchObject({ text: cut });
    expect(() => dispatch({ ...input, text: `${cut}😀` })).toThrow();

    // Only the head is scanned, however long the input is.
    expect(truncateCrewTaskText("a".repeat(10_000_000))).toBe(
      "a".repeat(crewTaskTextLimit),
    );

    const twiki = f.engine.state.reservePeer("twiki");
    f.engine.state.readyPeer("twiki");
    const task = f.engine.state.reserveTask(twiki, "captain", astral);

    if (!task) {
      throw new Error("Missing task");
    }

    f.engine.state.running(task.id);
    f.engine.state.activity.progress(task.id, `${astral}y`);
    const progress = `${"😀".repeat(crewTaskTextLimit - 1)}y`;

    const read = (taskText: "unredacted" | "full") =>
      f.engine.status({ member: "twiki" }, { taskText }).members[0]?.current;

    expect(read("full")).toMatchObject({ summary: cut, progress });

    const fleet = {
      status: f.engine.status({ member: "twiki" }, { taskText: "full" }),
      metadata: { projectDirectory: "/fixture", contexts: [] },
      taskText: "full" as const,
    };

    const decodeFleet = Schema.decodeUnknownSync(fleetCrewFullStatusSchema);
    expect(decodeFleet(fleet)).toEqual(fleet);
    const stored = fleet.status.members[0]?.current;

    if (!stored) {
      throw new Error("Missing current task");
    }

    stored.progress = `${cut}😀`;
    expect(() => decodeFleet(fleet)).toThrow();
    // Unredacted keeps the summary's start and the progress tail, whole pairs.
    expect(read("unredacted")).toMatchObject({
      summary: `x${"😀".repeat(179)}`,
      progress: `${"😀".repeat(399)}y`,
    });
    expect(
      f.engine.status({ member: "twiki" }).members[0]?.current?.progress,
    ).toBe(`\uFFFD${"😀".repeat(199)}y`);
  } finally {
    await f.close();
  }
});

test("a credential the progress cut splits stays masked for ordinary readers and whole in the full view", async () => {
  const f = await fixture();

  try {
    const twiki = f.engine.state.reservePeer("twiki");
    f.engine.state.readyPeer("twiki");
    const task = f.engine.state.reserveTask(twiki, "captain", "Rotate keys");

    if (!task) {
      throw new Error("Missing task");
    }

    f.engine.state.running(task.id);

    // The key's header falls just before the last 64,000 code points.
    const header = `${["-----BEGIN", "PRIVATE KEY-----"].join(" ")}\n`;
    const body = "Zm9v".repeat(crewTaskTextLimit / 4);
    f.engine.state.activity.progress(task.id, `Key: ${header}${body}`);

    const read = (taskText?: "unredacted" | "full") =>
      f.engine.status({ member: "twiki" }, taskText && { taskText }).members[0]
        ?.current?.progress;

    expect(read()).toBe("Key: [REDACTED PRIVATE KEY]");
    expect(read("full")).toBe(body);
    expect(read("unredacted")).toBe(body.slice(-400));

    // Progress that fits is masked on read, as before.
    f.engine.state.activity.progress(task.id, `Key: ${header}Zm9v`);
    expect(read()).toBe("Key: [REDACTED PRIVATE KEY]");
    expect(read("full")).toBe(`Key: ${header}Zm9v`);

    // Rows from before the column are masked on read; opening only adds it.
    const legacy = new Database(":memory:");
    legacy.run(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, crewID TEXT);
      CREATE TABLE member_activity (
        taskID TEXT PRIMARY KEY, crewID TEXT NOT NULL,
        kind TEXT NOT NULL, summary TEXT NOT NULL,
        phase TEXT NOT NULL, progress TEXT NOT NULL DEFAULT '',
        createdAt INTEGER, startedAt INTEGER, updatedAt INTEGER,
        finishedAt INTEGER
      );
      INSERT INTO member_activity (taskID,crewID,kind,summary,phase,progress)
        VALUES ('old','twiki','assignment','Old','running','token=old-value');
    `);
    const store = new MemberActivityStore(legacy);
    new MemberActivityStore(legacy);
    expect(store.task({ id: "old", status: "running" }).progress).toBe(
      "token=[REDACTED]",
    );
    expect(store.task({ id: "old", status: "running" }, "full").progress).toBe(
      "token=old-value",
    );
    legacy.close();
  } finally {
    await f.close();
  }
});

test("the same stored tail, stored again with a key header before the cut, updates the ordinary copy", async () => {
  const f = await fixture();

  try {
    const twiki = f.engine.state.reservePeer("twiki");
    f.engine.state.readyPeer("twiki");
    const task = f.engine.state.reserveTask(twiki, "captain", "Rotate keys");

    if (!task) {
      throw new Error("Missing task");
    }

    f.engine.state.running(task.id);

    const read = (taskText?: "full") =>
      f.engine.status({ member: "twiki" }, taskText && { taskText }).members[0]
        ?.current?.progress;

    // Exactly the stored limit: nothing is cut, so no masked copy is kept.
    const header = `${["-----BEGIN", "PRIVATE KEY-----"].join(" ")}\n`;
    const body = "Zm9v".repeat(crewTaskTextLimit / 4);
    f.engine.state.activity.progress(task.id, body);
    expect(read()).toBe(body.slice(-400));

    // The raw tail is unchanged; only the copy masked before the cut is new.
    f.engine.state.activity.progress(task.id, `Key: ${header}${body}`);
    expect(read("full")).toBe(body);
    expect(read()).toBe("Key: [REDACTED PRIVATE KEY]");
  } finally {
    await f.close();
  }
});

test("legacy uncertain task stays uncertain with unknown times and no raw result or session IDs", async () => {
  const f = await fixture();

  try {
    const peer = f.engine.state.reservePeer("twiki");
    f.engine.state.readyPeer("twiki");
    const db = new Database(f.engine.state.path);
    db.query(`INSERT INTO tasks (id,crewID,workerSessionID,originCaptainID,inputID,status)
      VALUES ('task_legacy','twiki',?,'private-captain','private-input','uncertain')`).run(
      peer.sessionID,
    );
    db.exec("DROP TABLE member_activity");
    db.close();
    await f.engine.close();
    const reopened = await CrewEngine.open(f.options, f.sessions);

    try {
      const inspect = new Database(reopened.state.path, { readonly: true });
      const before = inspect.serialize();
      const status = reopened.status({ member: "twiki" });
      expect(status.members[0]?.current).toMatchObject({
        status: "uncertain",
        kind: "unknown",
        createdAt: null,
        startedAt: null,
        updatedAt: null,
        finishedAt: null,
      });
      const view = JSON.stringify(crewStatusView(status, true));
      expect(view).toContain(
        "Outcome uncertain: no proof running or finished. No retry made.",
      );
      expect(view).toContain(
        "Since recorded start: unknown; last update: unknown",
      );
      expect(view).not.toContain(peer.sessionID);
      expect(view).not.toContain("private-captain");
      expect(inspect.serialize().equals(before)).toBe(true);
      inspect.close();
      expect(reopened.state.task("task_legacy")).toMatchObject({
        status: "uncertain",
        result: null,
        released: 0,
      });
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

test("large rosters are explicitly truncated while direct member queries remain available", async () => {
  const f = await fixture();
  let large: CrewEngine | undefined;

  try {
    const crew = Array.from({ length: 24 }, (_, index) => ({
      id: `worker-${index}`,
      role: "Engineering",
      permissionProfile: "coding" as const,
    }));

    large = await CrewEngine.open(
      {
        ...f.options,
        namespace: "large",
        team: { captain: { id: "adama" }, crew },
        worktrees: Object.fromEntries(
          crew.map(({ id }) => [id, join(f.directory, id)]),
        ),
      },
      f.sessions,
    );
    const roster = large.status();
    expect(roster).toMatchObject({ total: 24, truncated: true });
    expect(roster.members).toHaveLength(20);
    const view = crewStatusView(roster, false);
    expect(view.blocks).toHaveLength(22);
    expect(JSON.stringify(view)).toContain(
      "Roster truncated: showing 20 of 24",
    );
    expect(large.status({ member: "worker-23" })).toMatchObject({
      members: [{ id: "worker-23", provisioned: "unprovisioned" }],
      total: 1,
      truncated: false,
    });
    expect(f.calls).toBe(0);
  } finally {
    await large?.close();
    await f.close();
  }
});

test("durable status bounds recent metadata, retains outcomes and never returns raw results/notices", async () => {
  const f = await fixture(true);

  try {
    const peer = f.engine.state.reservePeer("chief");

    const tasks = Array.from({ length: 24 }, (_, i) => {
      const task = f.engine.state.task(historyTaskID(i));

      if (!task) {
        throw new Error("Missing saved task");
      }

      return task;
    });

    // Historical task/results/notices are saved. Exercise real metadata writes,
    // Redaction and trimming on one owned setup connection, not the engine's.
    const setup = new Database(f.engine.state.path, { strict: true });

    try {
      const activity = new MemberActivityStore(setup);

      const phase = setup.query(
        "UPDATE tasks SET status=?,released=? WHERE id=?",
      );

      setup
        .transaction(() => {
          for (let i = 0; i < 24; i++) {
            const task = tasks[i];

            if (!task) {
              throw new Error("Missing saved task");
            }

            phase.run("dispatching", 0, task.id);
            activity.assignment(
              { ...task, status: "dispatching", released: 0 },
              `Engineering ${i}`,
            );
            phase.run("running", 0, task.id);
            activity.phase(
              { ...task, status: "running", released: 0 },
              "running",
            );
            activity.progress(
              task.id,
              `Visible check ${i}; Bearer secretauth; password=hunter2`,
            );
            phase.run("completed", 0, task.id);
            activity.phase({ ...task, released: 0 }, "completed");
            phase.run("completed", 1, task.id);
          }
        })
        .immediate();
    } finally {
      setup.close();
    }

    const status = f.engine.status({ member: "chief" });
    expect(status.members[0]).toMatchObject({
      current: null,
      recentCount: 24,
      lastOutcome: { status: "completed", summary: "Engineering 23" },
    });
    expect(status.members[0]?.recent).toHaveLength(8);
    const serialized = JSON.stringify(status);

    for (const secret of [
      "secretauth",
      "hunter2",
      "RAW PRIVATE",
      "private reasoning",
      peer.sessionID,
    ]) {
      expect(serialized).not.toContain(secret);
    }

    expect(serialized).toContain("Visible check 23");
    const db = new Database(f.engine.state.path, { readonly: true });
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM member_activity",
        )
        .get()?.count,
    ).toBe(12);
    expect(
      db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM tasks")
        .get()?.count,
    ).toBe(24);
    db.close();
    expect(f.engine.state.task(tasks[0]?.id ?? "")?.result).toBe(
      "RAW PRIVATE FINAL RESULT",
    );
    expect(JSON.stringify(crewStatusView(status, true))).toContain(
      "showing 8 of 24 (truncated",
    );
  } finally {
    await f.close();
  }
});

function command(text = "crew twiki") {
  return {
    command: "/stargate",
    text,
    api_app_id: "A123",
    team_id: "T123",
    user_id: "U123",
    channel_id: "C123",
    trigger_id: "trigger",
  };
}

test("crew modal ACKs and opens before slow reads, shows literal progress, needs no pairing operator", async () => {
  const f = await fixture();

  try {
    const peer = f.engine.state.reservePeer("twiki");

    const task = f.engine.state.reserveTask(
      peer,
      "captain",
      "Review <@UOTHER> & <!channel>",
    );

    if (!task) {
      throw new Error("Missing task");
    }

    f.engine.state.running(task.id);
    f.engine.state.activity.progress(
      task.id,
      "Visible <https://example.test|link> xoxb-secret-token",
    );
    const order: string[] = [];
    const views: CronView[] = [];
    const read = Promise.withResolvers<void>();

    const backend: Pick<AgentBackend, "crewStatus"> = {
      async crewStatus(input) {
        order.push("read");
        await read.promise;

        return f.engine.status(input);
      },
    };

    const ui = new CrewUI(
      bot(),
      identity,
      backend,
      {
        async open(_trigger, view) {
          order.push("open");
          views.push(view);

          return "V123";
        },
        async update(_viewID, view) {
          order.push("update");
          views.push(view);
        },
      },
      pino({ enabled: false }),
      new AbortController().signal,
    );

    const running = ui.command(command(), async () => {
      order.push("ack");
    });

    // Both continuations run through microtasks, without a wall-clock sleep.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["ack", "open", "read"]);
    read.resolve();
    await running;
    expect(order).toEqual(["ack", "open", "read", "update"]);
    expect(f.calls).toBe(0);
    const view = views.at(-1);
    const text = JSON.stringify(view);
    expect(text).toContain("Review <@UOTHER> & <!channel>");
    expect(text).toContain("Visible <https://example.test|link>");
    expect(text).not.toContain("xoxb-secret-token");

    for (const block of view?.blocks ?? []) {
      expect(block).toMatchObject({
        type: "section",
        text: { type: "plain_text", emoji: false },
      });
    }
  } finally {
    await f.close();
  }
});

test("crew status fails closed across app/workspace/user/channel/bots and unsupported backends", async () => {
  const f = await fixture();

  try {
    const config = bot();
    config.access.users = ["*"];
    config.access.channels = ["*"];
    config.access.deniedUsers = ["UDENIED"];
    config.access.deniedChannels = ["CDENIED"];
    let reads = 0;
    let opens = 0;

    const api = {
      async open() {
        opens++;

        return "V123";
      },
      async update() {},
    };

    const backend = {
      async crewStatus() {
        reads++;

        return f.engine.status();
      },
    };

    const ui = new CrewUI(
      config,
      identity,
      backend,
      api,
      pino({ enabled: false }),
      new AbortController().signal,
    );

    const acks: (Record<string, unknown> | undefined)[] = [];

    const ack = async (value?: Record<string, unknown>) => {
      acks.push(value);
    };

    for (const changes of [
      { api_app_id: "AOTHER" },
      { team_id: "TOTHER" },
      { user_id: "UDENIED" },
      { channel_id: "CDENIED" },
      { user_id: "UBOT" },
      { bot_id: "BOTHER" },
      { is_bot: true },
      { user_name: "slackbot" },
      { user_id: "C123" },
      { text: "crew twiki extra" },
      { text: "pair" },
    ]) {
      await ui.command({ ...command(), ...changes }, ack);
    }

    expect(opens).toBe(0);
    expect(reads).toBe(0);
    expect(acks).toHaveLength(11);

    for (const payload of acks) {
      expect(payload).toMatchObject({ response_type: "ephemeral" });
    }

    config.access.users = ["U123"];
    config.access.channels = ["C123"];
    await ui.command({ ...command(), user_id: "UOTHER" }, ack);
    await ui.command({ ...command(), channel_id: "COTHER" }, ack);

    const unsupported = new CrewUI(
      config,
      identity,
      {},
      api,
      pino({ enabled: false }),
      new AbortController().signal,
    );

    await unsupported.command(command(), ack);
    expect(opens).toBe(0);
    expect(reads).toBe(0);
  } finally {
    await f.close();
  }
});

test("crew UI hides backend errors, checks deadlines and rechecks access before delivery", async () => {
  const config = bot();
  const views: CronView[] = [];
  const logs: string[] = [];
  const log = pino({ level: "error" }, { write: (line) => logs.push(line) });

  const api = {
    async open() {
      return "V123";
    },
    async update(_id: string, view: CronView) {
      views.push(view);
    },
  };

  const failed = new CrewUI(
    config,
    identity,
    {
      async crewStatus() {
        throw new Error("Bearer do-not-leak-raw-SDK");
      },
    },
    api,
    log,
    new AbortController().signal,
  );

  let acknowledgements = 0;

  const ack = async () => {
    acknowledgements++;
  };

  await failed.command(command(), ack);
  expect(JSON.stringify(views)).toContain(
    "Crew status unavailable or timed out",
  );
  expect(JSON.stringify([views, logs])).not.toContain("do-not-leak");
  const deadline = new AbortController();
  deadline.abort();
  let reads = 0;

  const timed = new CrewUI(
    config,
    identity,
    {
      async crewStatus() {
        reads++;
        throw new Error("Must not read");
      },
    },
    api,
    log,
    new AbortController().signal,
    () => deadline.signal,
  );

  await timed.command(command(), ack);
  expect(reads).toBe(0);

  const revoked = new CrewUI(
    config,
    identity,
    {
      async crewStatus() {
        config.access.deniedUsers.push("U123");

        return { members: [], total: 0, truncated: false };
      },
    },
    api,
    log,
    new AbortController().signal,
  );

  const count = views.length;
  await revoked.command(command(), ack);
  expect(views).toHaveLength(count);
  expect(acknowledgements).toBe(3);
});
