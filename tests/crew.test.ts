import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
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

async function fixture() {
  const directory = await mkdtemp("/tmp/opencode/pogo-crew-");
  const options: CrewOptions = {
    namespace: "bowser-one",
    stateDirectory: directory,
    captainDirectory: directory,
    projectDirectory: directory,
    worktrees: {
      mario: join(directory, "mario"),
      luigi: join(directory, "luigi"),
      daisy: join(directory, "daisy"),
      toad: join(directory, "toad"),
    },
    mesijCommand: "/usr/bin/mesij",
  };
  const sessions = new Map<string, CrewSession>();
  for (const id of ["ses_captain_a", "ses_captain_b"]) {
    sessions.set(id, {
      id,
      agent: "bowser",
      location: { directory },
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
    agent: "bowser",
    signal,
  });
  const worker = (sessionID: string, agent = "mario") => ({
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

test("root plugin metadata resolves to the installed V2 definition", () => {
  expect(plugin.id).toBe("pogo.crew");
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
