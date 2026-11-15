import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  CrewEngine,
  type CrewResult,
  type CrewSession,
  type CrewSessions,
} from "../src/crew/engine";
import type { PiWorkerBackend, PiWorkerFactory } from "../src/crew/pi-worker";
import type {
  CrewInspectionAPI,
  EvidenceMessage,
} from "../src/crew/reconciliation";
import { runRecoveryOperator } from "../src/crew/recovery-rpc";
import type { CrewTask } from "../src/crew/state";
import { gitProcessOptions } from "../src/crew/workspace";
import { crewStatusSchema } from "../src/crew-status";

const crew = ["bosun", "chief", "roslin"] as const;

function git(directory: string, ...args: string[]) {
  const run = Bun.spawnSync(
    [
      "git",
      "-C",
      directory,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ],
    { env: { PATH: process.env["PATH"] ?? "", HOME: directory } },
  );
  if (run.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

async function fixture(options: { repository?: boolean } = {}) {
  const base = await mkdtemp("/tmp/opencode/stargate-admin-");
  const project = join(base, "project");
  const worktrees = Object.fromEntries(
    crew.map((id) => [id, join(base, "worktrees", id)]),
  );
  if (options.repository) {
    await mkdir(project, { recursive: true });
    git(project, "init", "-q", "-b", "main");
    await writeFile(join(project, "README.md"), "base\n");
    await writeFile(join(project, "notes.txt"), "notes\n");
    await writeFile(join(project, ".gitignore"), ".env\n");
    git(project, "add", ".");
    git(project, "commit", "-q", "-m", "base");
    git(
      project,
      "worktree",
      "add",
      "-q",
      "-b",
      "crew/bosun",
      worktrees["bosun"] ?? "",
    );
  }
  const config = {
    namespace: "admin",
    stateDirectory: join(base, "state"),
    captainDirectory: join(base, "captain"),
    projectDirectory: project,
    worktrees,
    mesijCommand: "/usr/bin/mesij",
    team: {
      captain: { id: "captain" },
      crew: crew.map((id) => ({
        id,
        role: "Implementation",
        permissionProfile: "coding" as const,
      })),
    },
  };
  await mkdir(config.captainDirectory, { recursive: true });
  const sessions = new Map<string, CrewSession>();
  for (const id of ["ses_captain_a", "ses_captain_b"])
    sessions.set(id, {
      id,
      agent: "captain",
      location: { directory: config.captainDirectory },
    });
  const calls: string[] = [];
  const busy = new Set<string>();
  const inbox = new Map<string, string[]>();
  const history = new Map<string, EvidenceMessage[]>();
  const pages = new Map<
    string,
    { offset: number; type?: string | undefined }
  >();
  const state = {
    placement: "placed" as "placed" | "queued",
    loseReceipt: false,
    nativeDown: false,
    inspectionDown: false,
  };
  const native: CrewSessions = {
    async get({ sessionID }) {
      if (state.nativeDown) throw new Error("PRIVATE native outage");
      const session = sessions.get(sessionID);
      if (!session) throw { _tag: "Session.NotFoundError" };
      return session;
    },
    async create(input) {
      if (!input.id || !input.agent || !input.location)
        throw new Error("Invalid fixture create");
      const session = {
        id: input.id,
        agent: input.agent,
        location: input.location,
        metadata: input.metadata ?? {},
        time: { updated: 1, busy: 1, idle: 1 },
        outcome: "succeeded" as const,
      };
      sessions.set(session.id, session);
      return session;
    },
    async prompt(input) {
      calls.push(`prompt:${input.sessionID}`);
      const id = input.id ?? "missing";
      if (state.placement === "queued")
        inbox.set(input.sessionID, [...(inbox.get(input.sessionID) ?? []), id]);
      else
        history.set(input.sessionID, [
          ...(history.get(input.sessionID) ?? []),
          {
            id,
            type: "user",
            text: input.text,
            metadata: input.metadata ?? {},
            time: { created: 10 },
          },
        ]);
      busy.add(input.sessionID);
      if (state.loseReceipt) throw new Error("PRIVATE lost receipt");
      return { id, sessionID: input.sessionID };
    },
    async wait({ sessionID }, request) {
      if (state.nativeDown) throw new Error("PRIVATE native outage");
      if (!busy.has(sessionID)) return;
      const signal = request?.signal;
      await new Promise<void>((_, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    async interrupt({ sessionID }) {
      calls.push(`interrupt:${sessionID}`);
      if (state.nativeDown) throw new Error("PRIVATE native outage");
      busy.delete(sessionID);
      return { interrupted: true };
    },
    async synthetic() {
      calls.push("synthetic");
    },
    async compact() {
      calls.push("compact");
    },
  };
  const api: CrewInspectionAPI = {
    session: {
      get: (input, request) => native.get(input, request),
      async active() {
        if (state.inspectionDown) throw new Error("PRIVATE inspection outage");
        return Object.fromEntries(
          [...busy].map((id) => [id, { type: "busy" }]),
        );
      },
      inbox: {
        async list({ sessionID }) {
          if (state.inspectionDown)
            throw new Error("PRIVATE inspection outage");
          return (inbox.get(sessionID) ?? []).map((id) => ({ id }));
        },
        async cancel({ sessionID, inboxID }) {
          calls.push(`withdraw:${inboxID}`);
          inbox.set(
            sessionID,
            (inbox.get(sessionID) ?? []).filter((id) => id !== inboxID),
          );
        },
      },
      form: { list: async () => [] },
    },
    permission: { list: async () => [] },
    message: {
      // Native-like pages: newest first, optional type filter kept by cursor.
      async list(input) {
        if (state.inspectionDown) throw new Error("PRIVATE inspection outage");
        const query = input.cursor
          ? pages.get(input.cursor)
          : { offset: 0, type: input.type };
        if (!query) throw new Error("Unknown cursor");
        const all = (history.get(input.sessionID) ?? [])
          .toReversed()
          .filter(({ type }) => !query.type || type === query.type);
        const data = all.slice(
          query.offset,
          query.offset + (input.limit ?? 100),
        );
        const offset = query.offset + data.length;
        let next: string | null = null;
        if (offset < all.length) {
          next = `cursor-${pages.size}`;
          pages.set(next, { offset, type: query.type });
        }
        return { data, cursor: { next } };
      },
    },
  };
  const engine = await CrewEngine.open(
    config,
    native,
    {
      register: async () => ({ id: "0".repeat(32), sequence: 0 }),
      send: async () => ({ id: "1".repeat(32), sequence: 1 }),
      inbox: async () => [],
    },
    undefined,
    undefined,
    async () => {
      if (state.inspectionDown) throw new Error("PRIVATE inspection outage");
      return api;
    },
    async () => api,
  );
  let call = 0;
  const captain = (
    id = "ses_captain_a",
    signal = new AbortController().signal,
  ) => ({
    sessionID: id,
    agent: "captain",
    signal,
    id: `call-${++call}`,
  });
  const worker = (sessionID: string, agent: string) => ({
    sessionID,
    agent,
    signal: new AbortController().signal,
    id: `call-${++call}`,
  });
  const dispatch = async (id: string, text = "Work", queue = false) => {
    const result = await engine.run(
      { op: "dispatch", crew: id, text, queue },
      captain(),
    );
    if (!result.task)
      throw new Error(`Missing task: ${JSON.stringify(result)}`);
    return result;
  };
  /** Native turn ended without a successful answer; idle but unproven. */
  const interrupted = (task: CrewTask) => {
    const session = sessions.get(task.workerSessionID);
    if (session) session.outcome = "interrupted";
    busy.delete(task.workerSessionID);
  };
  const expected = (task: CrewTask, controlID: string | null = null) => ({
    status: task.status as "uncertain",
    workerSessionID: task.workerSessionID,
    originCaptainID: task.originCaptainID,
    inputID: task.inputID,
    controlID,
  });
  return {
    base,
    project,
    worktrees,
    config,
    engine,
    sessions,
    calls,
    busy,
    inbox,
    history,
    state,
    captain,
    worker,
    dispatch,
    interrupted,
    expected,
    prompts: () => calls.filter((call) => call.startsWith("prompt")).length,
    async close() {
      await engine.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const abandon = (
  f: Fixture,
  task: CrewTask,
  extra: Partial<{
    reason: string;
    key: string;
    controlID: string | null;
  }> = {},
) => ({
  op: "abandon" as const,
  taskID: task.id,
  expected: f.expected(task, extra.controlID ?? null),
  reason: extra.reason ?? "Interrupted turn has no retained answer.",
  key: extra.key ?? "abandon-1",
  acknowledgeUnconfirmedStop: true as const,
});

test("captain recovers idle uncertain slots without replay, promotion or result loss", async () => {
  const f = await fixture();
  try {
    // Bosun: interrupted, idle, no final answer. Dispatch stays busy.
    const bosun = (await f.dispatch("bosun")).task as CrewTask;
    f.interrupted(bosun);
    const status = await f.engine.run(
      { op: "status", taskID: bosun.id },
      f.captain(),
    );
    expect(status.status).toBe("uncertain");
    expect(
      (
        await f.engine.run(
          { op: "dispatch", crew: "bosun", text: "Inspect" },
          f.captain(),
        )
      ).status,
    ).toBe("busy");
    // Chief: uncertain with a queued successor. Roslin: completed result.
    const chief = (await f.dispatch("chief")).task as CrewTask;
    const queued = (await f.dispatch("chief", "Next", true)).task as CrewTask;
    f.interrupted(chief);
    f.engine.state.uncertain(chief.id);
    const roslin = (await f.dispatch("roslin")).task as CrewTask;
    await f.engine.run(
      { op: "complete", taskID: roslin.id, result: "Roslin result" },
      f.worker(roslin.workerSessionID, "roslin"),
    );
    f.busy.delete(roslin.workerSessionID);
    const before = f.prompts();
    f.engine.state.notice(bosun.id, "Retained notice");

    const inspected = await f.engine.run(
      { op: "inspect", crew: "bosun" },
      f.captain("ses_captain_b"),
    );
    expect(inspected).toMatchObject({
      active: { id: bosun.id, status: "uncertain" },
      execution: { state: "idle", outcome: "interrupted" },
      controlID: null,
    });
    const current = f.engine.state.task(bosun.id) as CrewTask;
    const result = await f.engine.run(
      abandon(f, current),
      f.captain("ses_captain_b"),
    );
    expect(result).toMatchObject({
      status: "abandoned",
      task: { id: bosun.id, status: "abandoned", released: 1, result: null },
      abandonment: {
        taskID: bosun.id,
        workerSessionID: bosun.workerSessionID,
        originCaptainID: "ses_captain_a",
        inputID: bosun.inputID,
        abandonedBy: "ses_captain_b",
        previousStatus: "uncertain",
        stop: "confirmed",
      },
    });
    expect(f.engine.state.notices(bosun.id, 0)[0]?.text).toBe(
      "Retained notice",
    );
    expect(f.engine.state.controlled("bosun")).toBe(false);
    expect(
      (await f.engine.run({ op: "status", taskID: bosun.id }, f.captain()))
        .status,
    ).toBe("abandoned");
    // Read-only status view: no current blocker, known terminal outcome.
    const view = crewStatusSchema.parse(f.engine.status({ member: "bosun" }));
    expect(view.members[0]).toMatchObject({
      current: null,
      observed: false,
      lastOutcome: { id: bosun.id, status: "abandoned", phase: "abandoned" },
    });

    // Chief's FIFO stays queued; Roslin's completed result is not abandonable.
    await f.engine.run(
      abandon(f, f.engine.state.task(chief.id) as CrewTask),
      f.captain("ses_captain_b"),
    );
    expect(f.engine.state.queuedTasks("chief").map(({ id }) => id)).toEqual([
      queued.id,
    ]);
    await expect(
      f.engine.run(
        abandon(f, { ...roslin, status: "uncertain" }),
        f.captain("ses_captain_b"),
      ),
    ).rejects.toThrow("keep their result");
    expect(f.engine.state.task(roslin.id)?.result).toBe("Roslin result");
    expect(f.prompts()).toBe(before);
    expect(f.calls.some((call) => call.startsWith("interrupt"))).toBe(false);

    // Fresh work follows ordinary native idle checks; old work cannot revive.
    const next = (await f.dispatch("bosun", "Fresh")).task as CrewTask;
    expect(next).toMatchObject({ status: "running" });
    expect(next.id).not.toBe(bosun.id);
    await expect(
      f.engine.run(
        { op: "complete", taskID: bosun.id, result: "Late" },
        f.worker(bosun.workerSessionID, "bosun"),
      ),
    ).rejects.toThrow("not current");
    expect(f.engine.state.recoverResult(current, "Late").status).toBe(
      "abandoned",
    );
    expect(
      f.engine.state.recoverResult(
        f.engine.state.task(bosun.id) as CrewTask,
        "Late",
      ),
    ).toMatchObject({ status: "abandoned", result: null });
    expect(f.engine.state.task(next.id)?.status).toBe("running");
    expect(f.prompts()).toBe(before + 1);
  } finally {
    await f.close();
  }
});

test("abandon is idempotent, CAS-guarded and captain-only", async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    const task = (await f.dispatch("bosun")).task as CrewTask;
    f.interrupted(task);
    f.engine.state.uncertain(task.id);
    const current = f.engine.state.task(task.id) as CrewTask;
    await expect(
      f.engine.run(
        {
          ...abandon(f, current),
          expected: { ...f.expected(current), inputID: "msg_stale" },
        },
        f.captain(),
      ),
    ).rejects.toThrow("stale");
    await expect(
      f.engine.run(abandon(f, { ...current, status: "running" }), f.captain()),
    ).rejects.toThrow("ownership or state changed");
    await expect(
      f.engine.run(
        abandon(f, current),
        f.worker(task.workerSessionID, "bosun"),
      ),
    ).rejects.toThrow("captain sessions");
    f.sessions.set("ses_foreign", {
      id: "ses_foreign",
      agent: "captain",
      location: { directory: other.config.captainDirectory },
    });
    await expect(
      f.engine.run(abandon(f, current), f.captain("ses_foreign")),
    ).rejects.toThrow("root configured captain");
    await expect(
      f.engine.run(
        { ...abandon(f, current), acknowledgeUnconfirmedStop: false },
        f.captain(),
      ),
    ).rejects.toThrow("Invalid stargate_crew input");
    expect(f.engine.state.abandonment(task.id)).toBeNull();
    const first = await f.engine.run(abandon(f, current), f.captain());
    expect(await f.engine.run(abandon(f, current), f.captain())).toEqual(first);
    // Authenticated operator RPC uses the same captain validation and audit.
    expect(
      JSON.parse(
        await runRecoveryOperator(
          f.engine,
          { sessionID: "ses_captain_b", request: abandon(f, current) },
          new AbortController().signal,
        ),
      ),
    ).toEqual(JSON.parse(JSON.stringify(first)));
    await expect(
      runRecoveryOperator(
        f.engine,
        {
          sessionID: "ses_captain_b",
          request: { ...abandon(f, current), key: "bad key" },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    await expect(
      f.engine.run(abandon(f, current, { reason: "Other" }), f.captain()),
    ).rejects.toThrow("already released");
    const foreign = (await other.dispatch("bosun")).task as CrewTask;
    await expect(
      f.engine.run(abandon(f, foreign), f.captain()),
    ).rejects.toThrow("not in this team's state");
  } finally {
    await other.close();
    await f.close();
  }
});

test("unknown native state keeps local ownership visible and abandons honestly", async () => {
  const f = await fixture();
  try {
    const task = (await f.dispatch("bosun")).task as CrewTask;
    f.state.inspectionDown = true;
    const inspected = await f.engine.run(
      { op: "inspect", crew: "bosun" },
      f.captain(),
    );
    expect(inspected).toMatchObject({
      active: { id: task.id, status: "running", inputID: task.inputID },
      execution: { state: "unknown" },
    });
    expect(inspected.diagnostic).toContain("Native execution unknown");
    expect(inspected.diagnostic).not.toContain("PRIVATE");
    await expect(
      f.engine.run(
        { op: "inspect", crew: "bosun", requestStatus: { key: "s" } },
        f.captain(),
      ),
    ).rejects.toThrow();
    // Worker still busy; history API down: no proof of own placement.
    const abandoned = await f.engine.run(
      abandon(f, task, { key: "unknown" }),
      f.captain(),
    );
    expect(abandoned.abandonment).toMatchObject({
      stop: "unconfirmed",
      previousStatus: "running",
    });
    expect(abandoned.diagnostic).toContain("unconfirmed");
    expect(abandoned.task?.status).toBe("abandoned");
    expect(f.engine.status({ member: "bosun" }).members[0]).toMatchObject({
      current: null,
      lastOutcome: {
        status: "abandoned",
        phase: "abandoned; native stop unconfirmed",
      },
    });
    expect(f.calls.some((call) => call.startsWith("interrupt"))).toBe(false);
    const prompts = f.prompts();
    expect(
      (
        await f.engine.run(
          { op: "dispatch", crew: "bosun", text: "Overlap" },
          f.captain(),
        )
      ).status,
    ).toBe("busy");
    expect(f.prompts()).toBe(prompts);
  } finally {
    await f.close();
  }
});

test("abandon interrupts only proven own placement and late completion stays rejected", async () => {
  const f = await fixture();
  try {
    const task = (await f.dispatch("bosun")).task as CrewTask;
    const result = await f.engine.run(abandon(f, task), f.captain());
    expect(result.abandonment).toMatchObject({
      stop: "confirmed",
      previousStatus: "running",
    });
    expect(f.calls).toContain(`interrupt:${task.workerSessionID}`);
    await expect(
      f.engine.run(
        { op: "complete", taskID: task.id, result: "Late" },
        f.worker(task.workerSessionID, "bosun"),
      ),
    ).rejects.toThrow("not current");
    expect(f.engine.state.task(task.id)).toMatchObject({
      status: "abandoned",
      result: null,
    });
  } finally {
    await f.close();
  }
});

test("held controls need the inspected controlID; live controls are never cleared", async () => {
  const f = await fixture();
  try {
    const task = (await f.dispatch("bosun")).task as CrewTask;
    f.interrupted(task);
    f.engine.state.uncertain(task.id);
    const current = f.engine.state.task(task.id) as CrewTask;
    const live = f.engine.state.reserveReconciliation(current);
    const liveID = (
      await f.engine.run({ op: "inspect", crew: "bosun" }, f.captain())
    ).controlID;
    await expect(
      f.engine.run(abandon(f, current), f.captain()),
    ).rejects.toThrow("controlID");
    await expect(
      f.engine.run(
        abandon(f, current, { controlID: liveID ?? null }),
        f.captain(),
      ),
    ).rejects.toThrow("operation in this process");
    f.engine.state.releaseControl("bosun", live);
    // Crash-held control: present in SQLite, not owned by this process.
    const db = new Database(f.engine.state.path);
    try {
      db.query("INSERT INTO worker_controls VALUES ('bosun','orphan')").run();
    } finally {
      db.close();
    }
    const orphan = (
      await f.engine.run({ op: "inspect", crew: "bosun" }, f.captain())
    ).controlID;
    const result = await f.engine.run(
      abandon(f, current, { controlID: orphan ?? null }),
      f.captain(),
    );
    expect(result.abandonment?.clearedControlID).toBe(orphan ?? "missing");
    expect(f.engine.state.controlled("bosun")).toBe(false);
  } finally {
    await f.close();
  }
});

test("a crash-pending abandon resumes its own stop attempt once", async () => {
  const f = await fixture();
  try {
    const task = (await f.dispatch("bosun")).task as CrewTask;
    f.interrupted(task);
    f.engine.state.uncertain(task.id);
    const db = new Database(f.engine.state.path);
    try {
      db.query("UPDATE tasks SET released=1 WHERE id=?").run(task.id);
      db.query("INSERT INTO worker_controls VALUES ('bosun','crashed')").run();
      db.query(`INSERT INTO task_abandonments
        (taskID,crewID,workerSessionID,originCaptainID,inputID,abandonedBy,
         previousStatus,reason,operationKey,controlToken,stop,createdAt)
        VALUES (?,?,?,?,?,?,'uncertain',?,?,'crashed','pending',1)`).run(
        task.id,
        "bosun",
        task.workerSessionID,
        task.originCaptainID,
        task.inputID,
        "ses_captain_a",
        "Interrupted turn has no retained answer.",
        "abandon-1",
      );
    } finally {
      db.close();
    }
    const result = await f.engine.run(
      abandon(f, { ...task, status: "uncertain" }),
      f.captain(),
    );
    expect(result.abandonment?.stop).toBe("confirmed");
    expect(f.engine.state.controlled("bosun")).toBe(false);
  } finally {
    await f.close();
  }
});

test("lost receipt with own input queued runs without resubmission; cancel withdraws only it", async () => {
  const f = await fixture();
  try {
    // Idle probe passes, then foreign native work starts and the own input
    // queues behind it; the prompt receipt is lost.
    f.state.placement = "queued";
    f.state.loseReceipt = true;
    const admitted = await f.engine.run(
      { op: "dispatch", crew: "bosun", text: "Queued behind foreign work" },
      f.captain(),
    );
    expect(admitted).toMatchObject({ status: "running" });
    expect(admitted.diagnostic).toContain("queued natively");
    const task = admitted.task as CrewTask;
    expect(f.inbox.get(task.workerSessionID)).toEqual([task.inputID]);
    expect(f.prompts()).toBe(1);
    const status = await f.engine.run(
      { op: "status", taskID: task.id },
      f.captain(),
    );
    expect(status.task?.status).toBe("running");
    const controller = new AbortController();
    const pending = f.engine.run(
      { op: "wait", taskID: task.id },
      f.captain("ses_captain_a", controller.signal),
    );
    controller.abort();
    await expect(pending).rejects.toThrow("withdrawn before execution");
    expect(f.calls).toContain(`withdraw:${task.inputID}`);
    expect(f.calls.some((call) => call.startsWith("interrupt"))).toBe(false);
    expect(f.engine.state.activeTask("bosun")).toBeNull();
    expect(f.engine.state.abandonment(task.id)).toMatchObject({
      stop: "confirmed",
      previousStatus: "cancelling",
      operationKey: "stargate:cancel",
    });
    expect(f.engine.state.task(task.id)).toMatchObject({
      status: "cancelled",
      released: 1,
    });
    expect(
      (await f.engine.run({ op: "status", taskID: task.id }, f.captain()))
        .status,
    ).toBe("cancelled");
    expect(f.prompts()).toBe(1);
  } finally {
    await f.close();
  }
});

test("lost receipt after placement recovers the own answer; observation loss allows exact completion", async () => {
  const f = await fixture();
  try {
    f.state.loseReceipt = true;
    const admitted = await f.dispatch("bosun");
    expect(admitted.status).toBe("running");
    expect(admitted.diagnostic).toContain("placed natively");
    const task = admitted.task as CrewTask;
    f.history.get(task.workerSessionID)?.push({
      id: "msg_answer",
      type: "assistant",
      agent: "bosun",
      finish: "stop",
      content: [{ type: "text", text: "Own answer" }],
      time: { created: 11, completed: 12 },
    });
    f.busy.delete(task.workerSessionID);
    expect(
      await f.engine.run({ op: "status", taskID: task.id }, f.captain()),
    ).toMatchObject({ status: "completed", task: { result: "Own answer" } });
    expect(f.prompts()).toBe(1);

    f.state.loseReceipt = false;
    const second = (await f.dispatch("bosun", "Second")).task as CrewTask;
    f.engine.state.uncertain(second.id); // Observation failed, worker continues.
    await f.engine.run(
      { op: "complete", taskID: second.id, result: "Legitimate" },
      f.worker(second.workerSessionID, "bosun"),
    );
    expect(f.engine.state.task(second.id)).toMatchObject({
      status: "completed",
      result: "Legitimate",
    });
  } finally {
    await f.close();
  }
});

test("uncertain task with own input still queued on an active worker is readmitted", async () => {
  const f = await fixture();
  try {
    f.state.placement = "queued";
    const task = (await f.dispatch("bosun")).task as CrewTask;
    f.engine.state.uncertain(task.id);
    const status = await f.engine.run(
      { op: "status", taskID: task.id },
      f.captain(),
    );
    expect(status).toMatchObject({ status: "running" });
    expect(status.diagnostic).toContain("without resubmission");
    expect(f.prompts()).toBe(1);
  } finally {
    await f.close();
  }
});

async function dirty(f: Fixture) {
  const root = f.worktrees["bosun"] ?? "";
  await writeFile(join(root, "README.md"), "staged\n");
  git(root, "add", "README.md");
  await writeFile(join(root, "notes.txt"), "unstaged\n");
  await writeFile(join(root, "new.txt"), "untracked\n");
  await writeFile(join(root, ".env"), "TOKEN=fixture-secret\n");
  return root;
}

const inspect = async (f: Fixture, caller = f.captain()) =>
  (await f.engine.run(
    { op: "workspace", crew: "bosun" },
    caller,
  )) as CrewResult & {
    workspace: NonNullable<CrewResult["workspace"]>;
  };

test("workspace inspection is read-only and bounded to the configured worktree", async () => {
  const f = await fixture({ repository: true });
  try {
    const root = await dirty(f);
    const before = git(
      root,
      "status",
      "--porcelain=v2",
      "--untracked-files=all",
    );
    const result = await f.engine.run(
      { op: "workspace", crew: "bosun", patch: true },
      f.captain(),
    );
    expect(result).toMatchObject({
      status: "workspace",
      slot: { taskID: null, controlled: false, queued: 0 },
      workspace: { head: git(root, "rev-parse", "HEAD"), branch: "crew/bosun" },
    });
    expect(result.workspace?.changes).toEqual([
      { path: "README.md", index: "M", worktree: ".", kind: "tracked" },
      { path: "notes.txt", index: ".", worktree: "M", kind: "tracked" },
      { path: "new.txt", index: "?", worktree: "?", kind: "untracked" },
    ]);
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(result.workspace?.patch?.text).toContain("+unstaged");
    expect(git(root, "status", "--porcelain=v2", "--untracked-files=all")).toBe(
      before,
    );
    expect(git(root, "stash", "list")).toBe("");
    expect(f.calls).toEqual([]);
    await expect(
      f.engine.run(
        { op: "workspace", crew: "bosun" },
        f.worker("ses_worker", "bosun"),
      ),
    ).rejects.toThrow();
    await expect(
      f.engine.run({ op: "workspace", crew: "intruder" }, f.captain()),
    ).rejects.toThrow("Unknown configured crew member");
  } finally {
    await f.close();
  }
});

test("workspace refuses symlinked, foreign and nested repositories", async () => {
  const f = await fixture({ repository: true });
  try {
    const run = (id: string) =>
      f.engine.run({ op: "workspace", crew: id }, f.captain());
    await symlink(f.worktrees["bosun"] ?? "", f.worktrees["chief"] ?? "");
    await expect(run("chief")).rejects.toThrow("not a symlink");
    await rm(f.worktrees["chief"] ?? "");
    const foreign = join(f.base, "foreign");
    await mkdir(foreign);
    git(foreign, "init", "-q", "-b", "main");
    git(foreign, "commit", "-q", "--allow-empty", "-m", "foreign");
    git(
      foreign,
      "worktree",
      "add",
      "-q",
      "-b",
      "other",
      f.worktrees["chief"] ?? "",
    );
    await expect(run("chief")).rejects.toThrow("does not belong");
    // A plain directory inside another repository is not its own worktree.
    git(join(f.base, "worktrees"), "init", "-q", "-b", "main");
    await mkdir(f.worktrees["roslin"] ?? "");
    await expect(run("roslin")).rejects.toThrow("own Git worktree root");
    expect((await run("bosun")).status).toBe("workspace");
  } finally {
    await f.close();
  }
});

test("stash retains staged, unstaged and untracked changes but never ignored files", async () => {
  const f = await fixture({ repository: true });
  try {
    await f.engine.run({ op: "ensure", crew: "bosun" }, f.captain());
    const root = await dirty(f);
    const { workspace } = await inspect(f);
    const result = await f.engine.run(
      {
        op: "stash",
        crew: "bosun",
        expected: {
          head: workspace.head,
          fingerprint: workspace.fingerprint,
          taskID: null,
        },
      },
      f.captain(),
    );
    const oid = result.checkpoint?.oid ?? "";
    expect(result).toMatchObject({
      status: "stashed",
      executionConfirmed: true,
    });
    expect(result.checkpoint?.restore).toContain(`stash apply --index ${oid}`);
    expect(git(root, "stash", "list", "--format=%H")).toBe(oid);
    expect(git(root, "show", `${oid}^2:README.md`)).toBe("staged");
    expect(git(root, "show", `${oid}:notes.txt`)).toBe("unstaged");
    expect(git(root, "show", `${oid}^3:new.txt`)).toBe("untracked");
    expect(() => git(root, "show", `${oid}^3:.env`)).toThrow();
    expect(await readFile(join(root, ".env"), "utf8")).toContain(
      "fixture-secret",
    );
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(f.prompts()).toBe(0);
  } finally {
    await f.close();
  }
});

test("reset requires exact state and acknowledgement, and keeps a recoverable checkpoint", async () => {
  const f = await fixture({ repository: true });
  try {
    await f.engine.run({ op: "ensure", crew: "bosun" }, f.captain());
    const root = await dirty(f);
    const { workspace } = await inspect(f);
    const expected = {
      head: workspace.head,
      fingerprint: workspace.fingerprint,
      taskID: null,
    };
    await expect(
      f.engine.run({ op: "reset", crew: "bosun", expected }, f.captain()),
    ).rejects.toThrow("Invalid stargate_crew input");
    await writeFile(join(root, "new.txt"), "changed after inspection\n");
    await expect(
      f.engine.run(
        { op: "reset", crew: "bosun", expected, acknowledgeDiscard: true },
        f.captain(),
      ),
    ).rejects.toThrow("differ from the inspected state");
    expect(git(root, "stash", "list")).toBe("");
    const fresh = (await inspect(f)).workspace;
    const moved = git(
      root,
      "commit-tree",
      "HEAD^{tree}",
      "-p",
      "HEAD",
      "-m",
      "moved",
    );
    git(root, "update-ref", "HEAD", moved);
    await expect(
      f.engine.run(
        {
          op: "reset",
          crew: "bosun",
          expected: {
            ...expected,
            head: fresh.head,
            fingerprint: fresh.fingerprint,
          },
          acknowledgeDiscard: true,
        },
        f.captain(),
      ),
    ).rejects.toThrow("differ from the inspected state");
    git(root, "update-ref", "HEAD", fresh.head);
    const exact = (await inspect(f)).workspace;
    const result = await f.engine.run(
      {
        op: "reset",
        crew: "bosun",
        expected: {
          head: exact.head,
          fingerprint: exact.fingerprint,
          taskID: null,
        },
        acknowledgeDiscard: true,
      },
      f.captain(),
    );
    const oid = result.checkpoint?.oid ?? "";
    expect(result.status).toBe("reset");
    expect(git(root, "status", "--porcelain")).toBe("?? new.txt");
    expect(git(root, "stash", "list", "--format=%H")).toBe(oid);
    git(root, "stash", "apply", "-q", "--index", oid);
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("unstaged\n");
    expect(git(root, "diff", "--cached", "--name-only")).toBe("README.md");
  } finally {
    await f.close();
  }
});

test("workspace mutation is blocked by active work, held controls, slot races and unconfirmed idle", async () => {
  const f = await fixture({ repository: true });
  try {
    await dirty(f);
    const running = (await f.dispatch("bosun")).task as CrewTask;
    const seen = (await inspect(f)).workspace;
    const expected = {
      head: seen.head,
      fingerprint: seen.fingerprint,
      taskID: running.id,
    };
    const stash = { op: "stash" as const, crew: "bosun", expected };
    await expect(f.engine.run(stash, f.captain())).rejects.toThrow(
      "Stargate-active work",
    );
    await f.engine.run(
      { op: "complete", taskID: running.id, result: "Done" },
      f.worker(running.workerSessionID, "bosun"),
    );
    // Still busy natively: idle unconfirmed needs explicit acknowledgement.
    await expect(f.engine.run(stash, f.captain())).rejects.toThrow(
      "acknowledgeUnconfirmedExecution",
    );
    const token = f.engine.state.reserveControl("bosun");
    await expect(
      f.engine.run(
        { ...stash, acknowledgeUnconfirmedExecution: true },
        f.captain(),
      ),
    ).rejects.toThrow("control is reserved");
    // Held workspace control blocks a racing dispatch.
    f.busy.delete(running.workerSessionID);
    expect(
      (
        await f.engine.run(
          { op: "dispatch", crew: "bosun", text: "Race" },
          f.captain(),
        )
      ).status,
    ).toBe("busy");
    f.engine.state.releaseControl("bosun", token);
    const next = (await f.dispatch("bosun", "New task")).task as CrewTask;
    await expect(
      f.engine.run(
        { ...stash, acknowledgeUnconfirmedExecution: true },
        f.captain(),
      ),
    ).rejects.toThrow("slot changed");
    expect(next.status).toBe("running");
    expect(git(f.worktrees["bosun"] ?? "", "stash", "list")).toBe("");
  } finally {
    await f.close();
  }
});

test("Pi status adopts only the bound committed answer after restart; abandoned tasks stay released", async () => {
  const base = await mkdtemp("/tmp/opencode/stargate-admin-pi-");
  const answers = new Map<string, string>();
  const requests: string[] = [];
  const backend: PiWorkerBackend = {
    createSession: async () => "17",
    prompt: async () => {
      requests.push("prompt");
      throw new Error("Recovery must not prompt");
    },
    interrupt: async () => {},
    waitForIdle: async () => {},
    close: async () => {},
  };
  const factory: PiWorkerFactory = Object.assign(async () => backend, {
    recover: async (_context: unknown, conversation: string, request: string) =>
      answers.get(`${conversation}:${request}`),
  });
  const captainDirectory = join(base, "captain");
  const engine = await CrewEngine.open(
    {
      namespace: "admin-pi",
      stateDirectory: join(base, "state"),
      captainDirectory,
      projectDirectory: base,
      worktrees: { twiki: join(base, "twiki") },
      mesijCommand: "/usr/bin/mesij",
      team: {
        captain: { id: "captain" },
        crew: [
          {
            id: "twiki",
            role: "Maintenance",
            permissionProfile: "coding",
            backend: {
              type: "pi-durable",
              model: "openai/fixture-model",
              tools: "coding",
            },
          },
        ],
      },
    },
    {
      get: async ({ sessionID }) => ({
        id: sessionID,
        agent: "captain",
        location: { directory: captainDirectory },
      }),
      create: async () => {
        throw new Error("Pi must not create OpenCode sessions");
      },
      prompt: async () => {
        throw new Error("Pi must not prompt OpenCode");
      },
      synthetic: async () => {},
      compact: async () => {},
      wait: async () => {},
      interrupt: async () => {},
    },
    {
      register: async () => ({ id: "0".repeat(32), sequence: 0 }),
      send: async () => ({ id: "1".repeat(32), sequence: 1 }),
      inbox: async () => [],
    },
    undefined,
    factory,
  );
  const captain = {
    sessionID: "ses_captain",
    agent: "captain",
    signal: new AbortController().signal,
  };
  try {
    const peer = (await engine.run({ op: "ensure", crew: "twiki" }, captain))
      .peers?.[0];
    if (!peer) throw new Error("Missing Pi peer");
    // Crash after native admission: bound conversation, no live execution.
    const admit = (text: string) => {
      const task = engine.state.reserveTask(peer, captain.sessionID, text);
      if (!task) throw new Error("Missing Pi task");
      engine.state.running(task.id);
      engine.state.savePiTaskConversation(task.id, "17");
      return task;
    };
    const task = admit("Maintain");
    const status = (id: string) =>
      engine.run({ op: "status", taskID: id }, captain);
    expect((await status(task.id)).status).toBe("uncertain");
    answers.set(`17:${task.inputID}`, "Committed answer");
    expect(await status(task.id)).toMatchObject({
      status: "completed",
      task: { result: "Committed answer" },
    });
    expect(engine.state.release(task.id)).toBe(true);
    const later = admit("Later");
    const current = engine.state.task(later.id) as CrewTask;
    const abandoned = await engine.run(
      {
        op: "abandon",
        taskID: later.id,
        expected: {
          status: "running",
          workerSessionID: current.workerSessionID,
          originCaptainID: current.originCaptainID,
          inputID: current.inputID,
        },
        reason: "Captain decided to stop this maintenance.",
        key: "pi",
        acknowledgeUnconfirmedStop: true,
      },
      captain,
    );
    expect(abandoned.abandonment?.stop).toBe("confirmed");
    answers.set(`17:${later.inputID}`, "Late answer");
    expect(await status(later.id)).toMatchObject({
      status: "abandoned",
      task: { result: null, released: 1 },
    });
    expect(requests).toEqual([]);
  } finally {
    await engine.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("legacy task status CHECK upgrades in place and keeps uncertain rows", async () => {
  const f = await fixture();
  try {
    const task = (await f.dispatch("bosun")).task as CrewTask;
    f.engine.state.uncertain(task.id);
    f.engine.state.notice(task.id, "Legacy notice");
    await f.engine.close();
    // Recreate the pre-upgrade CHECK while keeping every row and rowid.
    const db = new Database(f.engine.state.path);
    try {
      db.exec(`PRAGMA foreign_keys=OFF;
        CREATE TABLE tasks_legacy (
          id TEXT PRIMARY KEY, crewID TEXT NOT NULL REFERENCES peers(crewID),
          workerSessionID TEXT NOT NULL, originCaptainID TEXT NOT NULL,
          inputID TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK(status IN
            ('dispatching','running','completed','cancelling','uncertain')),
          result TEXT, released INTEGER NOT NULL DEFAULT 0,
          notifying INTEGER NOT NULL DEFAULT 0);
        INSERT INTO tasks_legacy (rowid,id,crewID,workerSessionID,originCaptainID,inputID,status,result,released,notifying)
          SELECT rowid,id,crewID,workerSessionID,originCaptainID,inputID,status,result,released,notifying FROM tasks;
        DROP TABLE tasks; ALTER TABLE tasks_legacy RENAME TO tasks;`);
      expect(() =>
        db.query("UPDATE tasks SET status='abandoned' WHERE id=?").run(task.id),
      ).toThrow();
    } finally {
      db.close();
    }
    const before = new Database(f.engine.state.path);
    const legacyRowid = before
      .query<{ rowid: number }, [string]>("SELECT rowid FROM tasks WHERE id=?")
      .get(task.id)?.rowid;
    before.close();
    const reopened = await CrewEngine.open(f.config, {
      get: async ({ sessionID }) => {
        const session = f.sessions.get(sessionID);
        if (!session) throw { _tag: "Session.NotFoundError" };
        return session;
      },
      create: async () => {
        throw new Error("No create");
      },
      prompt: async () => {
        throw new Error("No prompt");
      },
      synthetic: async () => {},
      compact: async () => {},
      wait: async () => {},
      interrupt: async () => {},
    });
    try {
      expect(reopened.state.task(task.id)).toMatchObject({
        status: "uncertain",
        released: 0,
      });
      expect(reopened.state.notices(task.id, 0)[0]?.text).toBe("Legacy notice");
      const check = new Database(reopened.state.path);
      try {
        expect(
          check
            .query<{ rowid: number }, [string]>(
              "SELECT rowid FROM tasks WHERE id=?",
            )
            .get(task.id)?.rowid,
        ).toBe(legacyRowid ?? -1);
        expect(check.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        check.close();
      }
      const result = await reopened.run(
        abandon(f, reopened.state.task(task.id) as CrewTask),
        f.captain(),
      );
      expect(result.task?.status).toBe("abandoned");
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

for (const shape of ["directory-for-file", "file-for-directory"] as const)
  test(`reset and stash refuse untracked or ignored obstructions of HEAD paths: ${shape}`, async () => {
    const f = await fixture({ repository: true });
    try {
      await f.engine.run({ op: "ensure", crew: "bosun" }, f.captain());
      const root = f.worktrees["bosun"] ?? "";
      const kept: string[] = [];
      if (shape === "directory-for-file") {
        await writeFile(join(root, "tracked"), "tracked\n");
        git(root, "add", "tracked");
        git(root, "commit", "-q", "-m", "tracked file");
        git(root, "rm", "-q", "--cached", "tracked");
        await rm(join(root, "tracked"));
        await mkdir(join(root, "tracked"));
        await writeFile(join(root, "tracked", "child"), "untracked child\n");
        await writeFile(join(root, "tracked", ".env"), "TOKEN=ignored\n");
        kept.push(
          join(root, "tracked", "child"),
          join(root, "tracked", ".env"),
        );
      } else {
        await mkdir(join(root, "dir"));
        await writeFile(join(root, "dir", "a"), "a\n");
        git(root, "add", "dir");
        git(root, "commit", "-q", "-m", "tracked directory");
        git(root, "rm", "-q", "-r", "--cached", "dir");
        await rm(join(root, "dir"), { recursive: true });
        await writeFile(
          join(root, "dir"),
          "untracked file in a directory's place\n",
        );
        kept.push(join(root, "dir"));
      }
      await writeFile(join(root, "notes.txt"), "tracked change\n");
      kept.push(join(root, "notes.txt"));
      const snapshot = () =>
        Promise.all(kept.map((path) => readFile(path, "utf8")));
      const before = await snapshot();
      const head = git(root, "rev-parse", "HEAD");
      for (const op of ["reset", "stash"] as const) {
        const { workspace } = await inspect(f);
        await expect(
          f.engine.run(
            {
              op,
              crew: "bosun",
              expected: {
                head: workspace.head,
                fingerprint: workspace.fingerprint,
                taskID: null,
              },
              ...(op === "reset" ? { acknowledgeDiscard: true } : {}),
            },
            f.captain(),
          ),
        ).rejects.toThrow("HEAD would restore");
      }
      expect(await snapshot()).toEqual(before);
      expect(git(root, "stash", "list")).toBe("");
      expect(git(root, "rev-parse", "HEAD")).toBe(head);
      expect(f.engine.state.controlled("bosun")).toBe(false);
    } finally {
      await f.close();
    }
  });

for (const later of [
  "none",
  "own-steer",
  "user",
  "shell",
  "synthetic",
] as const)
  test(`placement past a long tool-heavy turn interrupts only own latest input: ${later}`, async () => {
    const f = await fixture();
    try {
      const task = (await f.dispatch("bosun")).task as CrewTask;
      const history = f.history.get(task.workerSessionID) ?? [];
      const tools = (from: number, count: number) => {
        for (let index = 0; index < count; index++)
          history.push({
            id: `msg_tool_${from + index}`,
            type: "assistant",
            agent: "bosun",
            time: { created: 20 + from + index },
          });
      };
      tools(0, 600); // Beyond the 8x64 unfiltered window.
      const metadata = (taskID: string, originCaptainID: string) => ({
        pogoCrew: { taskID, originCaptainID, messageID: "e".repeat(32) },
      });
      if (later === "user")
        history.push({
          id: "msg_foreign",
          type: "user",
          text: "Foreign",
          time: { created: 700 },
        });
      if (later === "shell")
        history.push({
          id: "msg_shell",
          type: "shell",
          time: { created: 700 },
        });
      if (later === "synthetic")
        history.push({
          id: "msg_foreign_dm",
          type: "synthetic",
          metadata: metadata("task_other", "ses_captain_b"),
          time: { created: 700 },
        });
      if (later === "own-steer")
        history.push({
          id: "msg_own_dm",
          type: "synthetic",
          metadata: metadata(task.id, task.originCaptainID),
          time: { created: 700 },
        });
      tools(600, 100);
      const result = await f.engine.run(abandon(f, task), f.captain());
      const own = later === "none" || later === "own-steer";
      expect(f.calls.includes(`interrupt:${task.workerSessionID}`)).toBe(own);
      expect(result.abandonment).toMatchObject({
        stop: own ? "confirmed" : "unconfirmed",
      });
      expect(result.abandonment?.stopDetail).toContain(
        `own input ${own ? "placed" : "superseded"}`,
      );
      expect(result.task?.status).toBe("abandoned");
    } finally {
      await f.close();
    }
  });

test("Git writes run without a timer; reads stay bounded", () => {
  const signal = new AbortController().signal;
  expect(gitProcessOptions(true)).toEqual({ killSignal: "SIGKILL" });
  expect(gitProcessOptions(true, signal)).toEqual({
    signal,
    killSignal: "SIGKILL",
  });
  expect(gitProcessOptions(false, signal)).toEqual({
    signal,
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
});
