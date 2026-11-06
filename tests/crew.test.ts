import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SessionCreateInput } from "@opencode/client";
import {
  type CrewAgents,
  CrewEngine,
  type CrewOptions,
  type CrewSession,
  type CrewSessions,
} from "../src/crew/engine";
import type { MesijClient, MesijMessage } from "../src/crew/mesij";
import plugin from "../src/crew/plugin";
import { defaultTeam, type Team } from "../src/crew/team";

async function fixture(team?: Team) {
  const definition = team ?? defaultTeam;
  const directory = await mkdtemp("/tmp/opencode/pogo-crew-");
  const options: CrewOptions = {
    namespace: "bowser-one",
    stateDirectory: directory,
    captainDirectory: join(directory, "captain"),
    projectDirectory: directory,
    worktrees: Object.fromEntries(
      definition.crew.map(({ id }) => [id, join(directory, id)]),
    ),
    mesijCommand: "/usr/bin/mesij",
    ...(team ? { team } : {}),
  };
  const sessions = new Map<string, CrewSession>();
  for (const id of ["ses_captain_a", "ses_captain_b"]) {
    sessions.set(id, {
      id,
      agent: definition.captain.id,
      location: { directory: options.captainDirectory },
    });
  }
  const calls: { method: string; sessionID: string; text?: string }[] = [];
  const creations: SessionCreateInput[] = [];
  const messages: MesijMessage[] = [];
  let promptHook = () => {};
  let createFailure = false;
  let promptFailure = false;
  let interruptFailure = false;
  const busy = new Set<string>();
  const client: CrewSessions = {
    async get({ sessionID }) {
      const session = sessions.get(sessionID);
      if (!session) throw { _tag: "SessionNotFoundError" };
      return session;
    },
    async create(input) {
      if (!input.id || !input.location || !input.agent)
        throw new Error("Invalid fixture create");
      calls.push({ method: "create", sessionID: input.id });
      creations.push(input);
      const session = {
        id: input.id,
        agent: input.agent,
        location: input.location,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
      sessions.set(input.id, session);
      if (createFailure) throw new Error("secret raw SDK error");
      return session;
    },
    async prompt(input) {
      calls.push({
        method: "prompt",
        sessionID: input.sessionID,
        text: input.text,
      });
      busy.add(input.sessionID);
      promptHook();
      if (promptFailure) throw new Error("secret raw SDK error");
      return { id: input.id ?? "msg_fixture", sessionID: input.sessionID };
    },
    async wait({ sessionID }, request) {
      if (!busy.has(sessionID)) return;
      await new Promise<void>((_, reject) => {
        const signal = request?.signal;
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    async interrupt({ sessionID }, request) {
      expect(request?.signal?.aborted).toBe(false);
      calls.push({ method: "interrupt", sessionID });
      busy.delete(sessionID);
      if (interruptFailure) throw new Error("secret raw SDK error");
      return { interrupted: true };
    },
    async compact({ sessionID }) {
      calls.push({ method: "compact", sessionID });
    },
    async synthetic({ sessionID, text }) {
      calls.push({ method: "synthetic", sessionID, text });
    },
  };
  const mailer: Pick<MesijClient, "register" | "send" | "inbox"> = {
    async register() {
      return { id: "0".repeat(32), sequence: 0 };
    },
    async send(input) {
      const event = {
        id: String(messages.length + 1).padStart(32, "0"),
        sequence: messages.length + 1,
        actor: input.actor,
        sessionID: input.sessionID,
        to: input.to,
        type: "message.posted",
        text: input.text,
      };
      messages.push(event);
      return { id: event.id, sequence: event.sequence };
    },
    async inbox(input) {
      return messages
        .filter((message) => message.sequence > (input.after ?? 0))
        .slice(0, input.limit ?? 20);
    },
  };
  const agents: CrewAgents = {
    async get({ agentID }) {
      return {
        data: {
          mode: "primary",
          model: { providerID: "fixture", id: agentID },
        },
      };
    },
  };
  const engine = await CrewEngine.open(options, client, mailer, agents);
  const captain = (
    id = "ses_captain_a",
    signal = new AbortController().signal,
  ) => ({
    sessionID: id,
    agent: definition.captain.id,
    signal,
  });
  const worker = (sessionID: string, agent = definition.crew[0]?.id ?? "") => ({
    sessionID,
    agent,
    signal: new AbortController().signal,
  });
  return {
    options,
    engine,
    client,
    sessions,
    calls,
    creations,
    messages,
    mailer,
    agents,
    busy,
    captain,
    worker,
    onPrompt(hook: () => void) {
      promptHook = hook;
    },
    failCreate: () => {
      createFailure = true;
    },
    failPrompt: () => {
      promptFailure = true;
    },
    failInterrupt: () => {
      interruptFailure = true;
    },
    async close() {
      engine.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("crew reuses four bot-wide roots across captains and reopening", async () => {
  const f = await fixture();
  try {
    const first = await f.engine.run({ op: "ensure" }, f.captain());
    const second = await f.engine.run(
      { op: "ensure" },
      f.captain("ses_captain_b"),
    );
    expect(second.peers).toEqual(first.peers);
    expect(first.peers).toHaveLength(4);
    expect(f.calls.filter((call) => call.method === "create")).toHaveLength(4);
    expect(f.calls.filter((call) => call.method === "prompt")).toHaveLength(0);
    expect((await stat(f.engine.state.path)).mode & 0o777).toBe(0o600);
    const reopened = await CrewEngine.open(f.options, f.client);
    try {
      expect((await reopened.run({ op: "ensure" }, f.captain())).peers).toEqual(
        first.peers,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await f.close();
  }
});

const customTeam: Team = {
  captain: { id: "lead", name: "Lead" },
  crew: [
    { id: "builder", role: "Implementation", permissionProfile: "coding" },
    { id: "reader", role: "Research", permissionProfile: "research" },
  ],
};

test("custom roster authorizes real sessions and applies permission profiles", async () => {
  const f = await fixture(customTeam);
  try {
    const peers = (await f.engine.run({ op: "ensure" }, f.captain())).peers;
    expect(peers?.map((peer) => peer.crewID)).toEqual(["builder", "reader"]);
    expect(f.creations[0]?.permissions).toContainEqual({
      action: "edit",
      resource: "*",
      effect: "allow",
    });
    expect(f.creations[1]?.permissions).not.toContainEqual({
      action: "edit",
      resource: "*",
      effect: "allow",
    });
    await f.engine.authorize(f.worker(peers?.[0]?.sessionID ?? ""));
    await expect(
      f.engine.run({ op: "ensure", crew: "mario" }, f.captain()),
    ).rejects.toThrow("configured");
    const worker = f.sessions.get(peers?.[0]?.sessionID ?? "");
    if (!worker) throw new Error("Missing worker");
    worker.location.directory = "/wrong";
    await expect(f.engine.authorize(f.worker(worker.id))).rejects.toThrow(
      "identity",
    );
  } finally {
    await f.close();
  }
});

test("durable queue is opt-in, FIFO and promotes only after completion plus idle", async () => {
  const f = await fixture(customTeam);
  const reopened = await CrewEngine.open(
    f.options,
    f.client,
    f.mailer,
    f.agents,
  );
  try {
    const first = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "One" },
        f.captain(),
      )
    ).task;
    const second = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "Two", queue: true },
        f.captain(),
      )
    ).task;
    const third = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "Three", queue: true },
        f.captain(),
      )
    ).task;
    expect(second?.status).toBe("queued");
    expect(f.calls.filter((call) => call.method === "prompt")).toHaveLength(1);
    await f.engine.run(
      { op: "complete", taskID: first?.id, result: "Done" },
      f.worker(first?.workerSessionID ?? ""),
    );
    expect(
      (await reopened.run({ op: "status", taskID: second?.id }, f.captain()))
        .status,
    ).toBe("queued");
    f.busy.delete(first?.workerSessionID ?? "");
    expect(
      (await reopened.run({ op: "status", taskID: third?.id }, f.captain()))
        .status,
    ).toBe("queued");
    expect(
      (await reopened.run({ op: "status", taskID: second?.id }, f.captain()))
        .status,
    ).toBe("running");
    expect(
      f.calls.filter((call) => call.method === "prompt").at(-1)?.text,
    ).toContain("Two");
    await f.engine.run(
      { op: "complete", taskID: second?.id, result: "Done too" },
      f.worker(second?.workerSessionID ?? ""),
    );
    f.busy.delete(second?.workerSessionID ?? "");
    expect(
      (await reopened.run({ op: "status", taskID: third?.id }, f.captain()))
        .status,
    ).toBe("running");
  } finally {
    reopened.close();
    await f.close();
  }
});

test("cancelling queued wait never interrupts another captain's running task", async () => {
  const f = await fixture(customTeam);
  try {
    const running = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "One" },
        f.captain(),
      )
    ).task;
    const queued = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "Two", queue: true },
        f.captain("ses_captain_b"),
      )
    ).task;
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.engine.run(
        { op: "wait", taskID: queued?.id },
        f.captain("ses_captain_b", controller.signal),
      ),
    ).rejects.toThrow("cancelled");
    expect(f.calls.some((call) => call.method === "interrupt")).toBe(false);
    expect(f.engine.state.task(queued?.id ?? "")?.status).toBe("cancelled");
    expect(f.engine.state.activeTask("builder")?.id).toBe(running?.id);
  } finally {
    await f.close();
  }
});

test("worker control reserves across instances without blocking other slots", async () => {
  const f = await fixture(customTeam);
  const second = await CrewEngine.open(f.options, f.client, f.mailer, f.agents);
  try {
    await f.engine.withWorkerControl("builder", f.captain(), async (peer) => {
      expect(peer.crewID).toBe("builder");
      expect(
        (
          await second.run(
            { op: "dispatch", crew: "builder", text: "Blocked" },
            f.captain(),
          )
        ).status,
      ).toBe("busy");
      expect(
        (
          await second.run(
            { op: "dispatch", crew: "reader", text: "Independent" },
            f.captain(),
          )
        ).status,
      ).toBe("running");
      await expect(
        second.withWorkerControl("builder", f.captain(), async () => {}),
      ).rejects.toThrow("control");
    });
    expect(
      (
        await second.run(
          { op: "dispatch", crew: "builder", text: "After control" },
          f.captain(),
        )
      ).status,
    ).toBe("running");
    await expect(
      f.engine.withWorkerControl("builder", f.captain(), async () => {}),
    ).rejects.toThrow("running");
  } finally {
    second.close();
    await f.close();
  }
});

test("two teams sharing one server isolate roots, results, mail and urgency", async () => {
  const a = await fixture(customTeam);
  const b = await fixture(customTeam);
  const otherOptions = { ...b.options, namespace: "other-team" };
  const other = await CrewEngine.open(
    otherOptions,
    a.client,
    a.mailer,
    a.agents,
  );
  const otherCaller = { ...b.captain(), sessionID: "ses_other_captain" };
  a.sessions.set(otherCaller.sessionID, {
    id: otherCaller.sessionID,
    agent: customTeam.captain.id,
    location: { directory: otherOptions.captainDirectory },
  });
  try {
    const first = (
      await a.engine.run(
        { op: "dispatch", crew: "builder", text: "Team A" },
        a.captain(),
      )
    ).task;
    const second = (
      await other.run(
        { op: "dispatch", crew: "builder", text: "Team B" },
        otherCaller,
      )
    ).task;
    expect(second?.workerSessionID).not.toBe(first?.workerSessionID);
    await expect(
      other.run({ op: "status", taskID: first?.id }, otherCaller),
    ).rejects.toThrow("does not own");
    await expect(
      other.authorize(a.worker(first?.workerSessionID ?? "")),
    ).rejects.toThrow("assigned worker");
    await expect(other.captain(a.captain())).rejects.toThrow("configured");
    await a.engine.mail(
      {
        op: "send",
        taskID: first?.id,
        to: "captain",
        key: "same",
        text: "A private mail",
      },
      a.worker(first?.workerSessionID ?? ""),
    );
    await other.mail(
      {
        op: "send",
        taskID: second?.id,
        to: "captain",
        key: "same",
        text: "B private mail",
      },
      a.worker(second?.workerSessionID ?? ""),
    );
    expect(
      (
        await a.engine.mail({ op: "inbox", taskID: first?.id }, a.captain())
      ).messages?.map((mail) => mail.text),
    ).toEqual(["A private mail"]);
    expect(
      (
        await other.mail({ op: "inbox", taskID: second?.id }, otherCaller)
      ).messages?.map((mail) => mail.text),
    ).toEqual(["B private mail"]);
    await other.run(
      { op: "urgent", taskID: second?.id, to: "builder", text: "B only" },
      a.worker(second?.workerSessionID ?? ""),
    );
    expect(
      a.calls
        .filter((call) => call.method === "synthetic")
        .map((call) => call.sessionID),
    ).toEqual([second?.workerSessionID ?? ""]);
    await other.run(
      { op: "complete", taskID: second?.id, result: "B result" },
      a.worker(second?.workerSessionID ?? ""),
    );
    expect(
      (await other.run({ op: "status", taskID: second?.id }, otherCaller)).task
        ?.result,
    ).toBe("B result");
    expect(
      (await a.engine.run({ op: "status", taskID: first?.id }, a.captain()))
        .task?.result,
    ).toBeNull();
  } finally {
    other.close();
    await a.close();
    await b.close();
  }
});

test("identity changes refuse rebinding; invalid and overlapping worktrees fail", async () => {
  const f = await fixture(customTeam);
  try {
    const changed: Team = { ...customTeam, captain: { id: "different-lead" } };
    await expect(
      CrewEngine.open({ ...f.options, team: changed }, f.client),
    ).rejects.toThrow("new namespace");
    await expect(
      CrewEngine.open(
        {
          ...f.options,
          worktrees: { ...f.options.worktrees, extra: "/extra" },
        },
        f.client,
      ),
    ).rejects.toThrow("exact configured");
    await expect(
      CrewEngine.open(
        { ...f.options, captainDirectory: f.options.projectDirectory },
        f.client,
      ),
    ).rejects.toThrow("non-nested");
    await mkdir(f.options.captainDirectory);
    const alias = join(f.options.projectDirectory, "captain-alias");
    await symlink(f.options.captainDirectory, alias);
    await expect(
      CrewEngine.open(
        {
          ...f.options,
          worktrees: { ...f.options.worktrees, builder: join(alias, "nested") },
        },
        f.client,
      ),
    ).rejects.toThrow("symbolic links");
  } finally {
    await f.close();
  }
});

test("queued prompt uncertainty never replays and preserves later FIFO work", async () => {
  const f = await fixture(customTeam);
  try {
    const first = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "First" },
        f.captain(),
      )
    ).task;
    const queued = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "Ambiguous", queue: true },
        f.captain(),
      )
    ).task;
    const later = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "Later", queue: true },
        f.captain(),
      )
    ).task;
    await f.engine.run(
      { op: "complete", taskID: first?.id, result: "Done" },
      f.worker(first?.workerSessionID ?? ""),
    );
    f.busy.delete(first?.workerSessionID ?? "");
    f.failPrompt();
    await expect(
      f.engine.run({ op: "status", taskID: queued?.id }, f.captain()),
    ).rejects.toThrow("not be replayed");
    expect(
      (await f.engine.run({ op: "status", taskID: queued?.id }, f.captain()))
        .status,
    ).toBe("uncertain");
    expect(
      (await f.engine.run({ op: "status", taskID: later?.id }, f.captain()))
        .status,
    ).toBe("queued");
    expect(f.calls.filter((call) => call.method === "prompt")).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("default Bowser legacy fingerprint reopens with the same task and worker IDs", async () => {
  const f = await fixture();
  try {
    const task = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "Legacy" },
        f.captain(),
      )
    ).task;
    await f.engine.run(
      { op: "complete", taskID: task?.id, result: "Legacy result" },
      f.worker(task?.workerSessionID ?? ""),
    );
    const db = new Database(f.engine.state.path);
    const oldFingerprint = JSON.stringify([
      f.options.namespace,
      resolve(f.options.projectDirectory),
      resolve(f.options.captainDirectory),
      ...defaultTeam.crew.map(({ id }) =>
        resolve(f.options.worktrees[id] ?? ""),
      ),
    ]);
    db.query("UPDATE identity SET value=?").run(oldFingerprint);
    db.close();
    const changed: Team = {
      ...defaultTeam,
      crew: defaultTeam.crew.map((member) => ({
        ...member,
        permissionProfile: "coding",
      })),
    };
    await expect(
      CrewEngine.open({ ...f.options, team: changed }, f.client),
    ).rejects.toThrow("configuration changed");
    const reopened = await CrewEngine.open(
      f.options,
      f.client,
      f.mailer,
      f.agents,
    );
    try {
      const saved = await reopened.run(
        { op: "status", taskID: task?.id },
        f.captain(),
      );
      expect(saved.task?.workerSessionID).toBe(task?.workerSessionID);
      expect(saved.task?.result).toBe("Legacy result");
      expect(
        (await reopened.run({ op: "ensure", crew: "mario" }, f.captain()))
          .peers?.[0]?.sessionID,
      ).toBe(task?.workerSessionID);
    } finally {
      reopened.close();
    }
  } finally {
    await f.close();
  }
});

test("queued wait promotes once under contention and returns the owned result", async () => {
  const f = await fixture(customTeam);
  const second = await CrewEngine.open(f.options, f.client, f.mailer, f.agents);
  try {
    const running = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "First" },
        f.captain(),
      )
    ).task;
    const queued = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "Second", queue: true },
        f.captain(),
      )
    ).task;
    await f.engine.run(
      { op: "complete", taskID: running?.id, result: "Done" },
      f.worker(running?.workerSessionID ?? ""),
    );
    f.busy.delete(running?.workerSessionID ?? "");
    f.onPrompt(() => {
      const current = f.engine.state.activeTask("builder");
      if (!current) throw new Error("Missing task");
      f.engine.state.complete(
        current.id,
        current.workerSessionID,
        "Queued result",
      );
      f.busy.delete(current.workerSessionID);
    });
    const results = await Promise.all([
      f.engine.run({ op: "wait", taskID: queued?.id }, f.captain()),
      second.run({ op: "status", taskID: queued?.id }, f.captain()),
    ]);
    expect(results[0]?.task?.result).toBe("Queued result");
    expect(results[0]?.status).toBe("completed");
    expect(f.calls.filter((call) => call.method === "prompt")).toHaveLength(2);
  } finally {
    second.close();
    await f.close();
  }
});

test("external worker activity blocks admission and controls always release", async () => {
  const f = await fixture(customTeam);
  try {
    const peer = (
      await f.engine.run({ op: "ensure", crew: "builder" }, f.captain())
    ).peers?.[0];
    if (!peer) throw new Error("Missing peer");
    f.busy.add(peer.sessionID);
    const queued = await f.engine.run(
      { op: "dispatch", crew: "builder", text: "Wait for idle", queue: true },
      f.captain(),
    );
    expect(queued.status).toBe("queued");
    expect(f.calls.filter((call) => call.method === "prompt")).toHaveLength(0);
    await expect(
      f.engine.withWorkerControl("builder", f.captain(), async () => {}),
    ).rejects.toThrow("not idle");
    f.busy.delete(peer.sessionID);
    await expect(
      f.engine.withWorkerControl("builder", f.captain(), async () => {
        throw new Error("callback failed");
      }),
    ).rejects.toThrow("callback failed");
    expect(
      (
        await f.engine.run(
          { op: "status", taskID: queued.task?.id },
          f.captain(),
        )
      ).status,
    ).toBe("running");
  } finally {
    await f.close();
  }
});

test("root plugin metadata resolves to the installed V2 definition", () => {
  expect(plugin.id).toBe("pogo.crew");
});

test("worker urgency cannot create an idle colleague's root session", async () => {
  const f = await fixture();
  try {
    const task = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "Assigned work" },
        f.captain(),
      )
    ).task;
    if (!task) throw new Error("Missing task");
    await expect(
      f.engine.run(
        { op: "urgent", taskID: task.id, to: "luigi", text: "Question" },
        f.worker(task.workerSessionID),
      ),
    ).rejects.toThrow("same captain lineage");
    expect(f.creations).toHaveLength(1);
    expect(f.engine.state.peer("luigi")).toBeNull();
  } finally {
    await f.close();
  }
});

test("Daisy receives session-scoped read-only rules and workers cannot ensure", async () => {
  const f = await fixture();
  try {
    const peer = (
      await f.engine.run({ op: "ensure", crew: "daisy" }, f.captain())
    ).peers?.[0];
    const rules = f.creations[0]?.permissions;
    expect(rules).toContainEqual({
      action: "*",
      resource: "*",
      effect: "deny",
    });
    expect(rules).not.toContainEqual({
      action: "edit",
      resource: "*",
      effect: "allow",
    });
    expect(f.creations[0]?.parentID).toBeUndefined();
    expect(f.creations[0]?.model).toEqual({
      providerID: "fixture",
      id: "daisy",
    });
    await expect(
      f.engine.run({ op: "ensure" }, f.worker(peer?.sessionID ?? "", "daisy")),
    ).rejects.toThrow("Only Bowser");
    const captain = f.sessions.get("ses_captain_a");
    if (!captain) throw new Error("Missing fixture captain");
    captain.location.directory = "/different-workspace";
    await expect(f.engine.run({ op: "ensure" }, f.captain())).rejects.toThrow(
      "configured",
    );
  } finally {
    await f.close();
  }
});

test("independent plugin instances atomically reserve the same worker", async () => {
  const f = await fixture();
  const second = await CrewEngine.open(f.options, f.client, f.mailer);
  try {
    const results = await Promise.all([
      f.engine.run(
        { op: "dispatch", crew: "mario", text: "First" },
        f.captain(),
      ),
      second.run(
        { op: "dispatch", crew: "mario", text: "Second" },
        f.captain("ses_captain_b"),
      ),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "busy",
      "running",
    ]);
    expect(f.calls.filter((call) => call.method === "prompt")).toHaveLength(1);
    expect(new Set(f.creations.map((input) => input.id)).size).toBe(1);
  } finally {
    second.close();
    await f.close();
  }
});

test("aborted admission interrupts the reserved worker using a fresh signal", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    f.onPrompt(() => controller.abort());
    f.failPrompt();
    await expect(
      f.engine.run(
        { op: "dispatch", crew: "mario", text: "Cancelled admission" },
        f.captain("ses_captain_a", controller.signal),
      ),
    ).rejects.toThrow("uncertain");
    expect(f.calls.filter((call) => call.method === "interrupt")).toHaveLength(
      1,
    );
    expect(f.engine.state.activeTask("mario")?.status).toBe("uncertain");
  } finally {
    await f.close();
  }
});

test("same-captain colleague urgency includes the recipient's exact task ID", async () => {
  const f = await fixture();
  try {
    const mario = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "A" },
        f.captain(),
      )
    ).task;
    const luigi = (
      await f.engine.run(
        { op: "dispatch", crew: "luigi", text: "B" },
        f.captain(),
      )
    ).task;
    await f.engine.run(
      {
        op: "urgent",
        taskID: mario?.id,
        to: "luigi",
        text: "Interface changed",
      },
      f.worker(mario?.workerSessionID ?? ""),
    );
    expect(f.calls.filter((call) => call.method === "synthetic")).toEqual([
      {
        method: "synthetic",
        sessionID: luigi?.workerSessionID ?? "",
        text: `Pogo urgent notice for task ${luigi?.id}; source task ${mario?.id}.\nInterface changed`,
      },
    ]);
    await expect(
      f.engine.run(
        { op: "compact", crew: "mario" },
        f.captain("ses_captain_b"),
      ),
    ).rejects.toThrow("another captain");
  } finally {
    await f.close();
  }
});

test("Mesij inbox filters sent/unrelated mail and acknowledges pages explicitly", async () => {
  const f = await fixture();
  try {
    const task = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "A" },
        f.captain(),
      )
    ).task;
    const worker = f.worker(task?.workerSessionID ?? "");
    await f.engine.mail(
      {
        op: "send",
        taskID: task?.id,
        to: "captain",
        text: "Private result",
        key: "one",
      },
      worker,
    );
    const other = (
      await f.engine.run(
        { op: "dispatch", crew: "luigi", text: "Other thread" },
        f.captain("ses_captain_b"),
      )
    ).task;
    await f.engine.mail(
      {
        op: "send",
        taskID: other?.id,
        to: "captain",
        text: "Different thread result",
        key: "one",
      },
      f.worker(other?.workerSessionID ?? "", "luigi"),
    );
    const ownInbox = await f.engine.mail(
      { op: "inbox", taskID: task?.id },
      worker,
    );
    expect(ownInbox.messages).toEqual([]);
    const captainInbox = await f.engine.mail(
      { op: "inbox", taskID: task?.id },
      f.captain(),
    );
    expect(captainInbox.messages?.[0]?.text).toBe("Private result");
    expect(captainInbox.messages).toHaveLength(1);
    expect(
      (await f.engine.mail({ op: "inbox", taskID: task?.id }, f.captain()))
        .messages,
    ).toEqual(captainInbox.messages);
    expect(
      (
        await f.engine.mail(
          { op: "inbox", taskID: task?.id, after: captainInbox.nextAfter },
          f.captain(),
        )
      ).messages,
    ).toEqual([]);
    await expect(
      f.engine.mail(
        { op: "inbox", taskID: task?.id },
        f.captain("ses_captain_b"),
      ),
    ).rejects.toThrow("does not own");
    expect(f.calls.some((call) => call.method === "synthetic")).toBe(false);
  } finally {
    await f.close();
  }
});

test("uncertain create adopts stable ID; missing ready session is not recreated", async () => {
  const f = await fixture();
  try {
    f.failCreate();
    await expect(
      f.engine.run({ op: "ensure", crew: "mario" }, f.captain()),
    ).rejects.toThrow("not confirmed");
    const result = await f.engine.run(
      { op: "ensure", crew: "mario" },
      f.captain(),
    );
    const peer = result.peers?.[0];
    expect(peer).toBeDefined();
    expect(f.calls).toHaveLength(1);
    f.sessions.delete(peer?.sessionID ?? "");
    await expect(
      f.engine.run({ op: "ensure", crew: "mario" }, f.captain()),
    ).rejects.toThrow("missing");
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("busy assignments stay bounded and task results belong to their captain", async () => {
  const f = await fixture();
  try {
    const task = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "Implement one" },
        f.captain(),
      )
    ).task;
    expect(task?.inputID).toMatch(/^msg_/);
    expect(task?.originCaptainID).toBe("ses_captain_a");
    const busy = await f.engine.run(
      { op: "dispatch", crew: "mario", text: "Different thread" },
      f.captain("ses_captain_b"),
    );
    expect(busy.status).toBe("busy");
    expect(busy.task).toBeUndefined();
    await expect(
      f.engine.run(
        { op: "wait", taskID: task?.id },
        f.captain("ses_captain_b"),
      ),
    ).rejects.toThrow("does not own");
    await expect(
      f.engine.run(
        { op: "complete", taskID: task?.id, result: "stolen" },
        f.worker("ses_unassigned"),
      ),
    ).rejects.toThrow("assigned worker");
    await f.engine.run(
      { op: "complete", taskID: task?.id, result: "Verified result" },
      f.worker(task?.workerSessionID ?? ""),
    );
    const result = await f.engine.run(
      { op: "wait", taskID: task?.id },
      f.captain(),
    );
    expect(result.task?.result).toBe("Verified result");
    const reopened = await CrewEngine.open(
      f.options,
      f.client,
      f.mailer,
      f.agents,
    );
    try {
      expect(
        (await reopened.run({ op: "status", taskID: task?.id }, f.captain()))
          .task?.result,
      ).toBe("Verified result");
    } finally {
      reopened.close();
    }
    expect(f.calls.some((call) => call.sessionID === "ses_captain_a")).toBe(
      false,
    );
  } finally {
    await f.close();
  }
});

test("cancelling an old completed wait cannot interrupt a replacement task", async () => {
  const f = await fixture();
  try {
    const first = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "First" },
        f.captain(),
      )
    ).task;
    await f.engine.run(
      { op: "complete", taskID: first?.id, result: "Done" },
      f.worker(first?.workerSessionID ?? ""),
    );
    f.busy.delete(first?.workerSessionID ?? "");
    const replacement = await f.engine.run(
      { op: "dispatch", crew: "mario", text: "Second" },
      f.captain("ses_captain_b"),
    );
    expect(replacement.status).toBe("running");
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.engine.run(
        { op: "wait", taskID: first?.id },
        f.captain("ses_captain_a", controller.signal),
      ),
    ).rejects.toThrow("cancelled");
    expect(f.calls.filter((call) => call.method === "interrupt")).toEqual([]);
    expect(f.engine.state.activeTask("mario")?.originCaptainID).toBe(
      "ses_captain_b",
    );
  } finally {
    await f.close();
  }
});

test("prompt ambiguity is retained and never replayed", async () => {
  const f = await fixture();
  try {
    f.failPrompt();
    await expect(
      f.engine.run(
        { op: "dispatch", crew: "mario", text: "Do not replay" },
        f.captain(),
      ),
    ).rejects.toThrow("uncertain");
    expect(
      (
        await f.engine.run(
          { op: "dispatch", crew: "mario", text: "Again" },
          f.captain(),
        )
      ).status,
    ).toBe("busy");
    expect(f.calls.filter((call) => call.method === "prompt")).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("cancelled wait interrupts only its own task and preserves uncertain state", async () => {
  const f = await fixture();
  try {
    const task = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "Long task" },
        f.captain(),
      )
    ).task;
    f.failInterrupt();
    const controller = new AbortController();
    const pending = f.engine.run(
      { op: "wait", taskID: task?.id },
      f.captain("ses_captain_a", controller.signal),
    );
    controller.abort();
    await expect(pending).rejects.toThrow("uncertain");
    expect(f.engine.state.task(task?.id ?? "")?.status).toBe("uncertain");
    expect(f.calls.filter((call) => call.method === "interrupt")).toEqual([
      { method: "interrupt", sessionID: task?.workerSessionID ?? "" },
    ]);
  } finally {
    await f.close();
  }
});

test("urgent captain mail stays durable and cross-captain colleague input is rejected", async () => {
  const f = await fixture();
  try {
    const mario = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "Task A" },
        f.captain(),
      )
    ).task;
    await f.engine.run(
      { op: "dispatch", crew: "luigi", text: "Task B" },
      f.captain("ses_captain_b"),
    );
    await f.engine.run(
      {
        op: "urgent",
        taskID: mario?.id,
        to: "captain",
        text: "Approval needed",
      },
      f.worker(mario?.workerSessionID ?? ""),
    );
    const notice = await f.engine.run(
      { op: "wait", taskID: mario?.id },
      f.captain(),
    );
    expect(notice.notices?.[0]?.text).toBe("Approval needed");
    expect(f.calls.some((call) => call.method === "synthetic")).toBe(false);
    await expect(
      f.engine.run(
        {
          op: "urgent",
          taskID: mario?.id,
          to: "luigi",
          text: "Wrong thread",
        },
        f.worker(mario?.workerSessionID ?? ""),
      ),
    ).rejects.toThrow("lineage");
  } finally {
    await f.close();
  }
});
