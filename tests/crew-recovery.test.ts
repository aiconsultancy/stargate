import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { OpenCodeClient } from "@opencode/client";
import {
  CrewEngine,
  type CrewSession,
  type CrewSessions,
  type ResultConnector,
} from "../src/crew/engine";
import type { ResultAPI, ResultMessage } from "../src/crew/result";
import type { CrewTask } from "../src/crew/state";

async function fixture() {
  const directory = await mkdtemp("/tmp/opencode/pogo-recovery-");
  const options = {
    namespace: "recovery",
    stateDirectory: directory,
    captainDirectory: join(directory, "captain"),
    projectDirectory: directory,
    worktrees: { worker: join(directory, "worker") },
    mesijCommand: "/usr/bin/mesij",
    team: {
      captain: { id: "captain" },
      crew: [
        { id: "worker", role: "Implementation", permissionProfile: "coding" },
      ],
    },
  };
  const captain = {
    sessionID: "ses_captain",
    agent: "captain",
    signal: new AbortController().signal,
    id: "recovery-call",
  };
  const sessions = new Map<string, CrewSession>([
    [
      captain.sessionID,
      {
        id: captain.sessionID,
        agent: captain.agent,
        location: { directory: options.captainDirectory },
      },
    ],
  ]);
  const messages: ResultMessage[] = [];
  const busy = new Set<string>();
  let prompts = 0;
  let synthetics = 0;
  let reads = 0;
  let failRead = false;
  let onRead = () => {};
  const native: CrewSessions = {
    async get({ sessionID }) {
      const session = sessions.get(sessionID);
      if (!session) throw { _tag: "Session.NotFoundError" };
      return session;
    },
    async create(input) {
      if (!input.id || !input.agent || !input.location)
        throw new Error("Missing fixture identity");
      const session = {
        id: input.id,
        agent: input.agent,
        location: input.location,
        metadata: input.metadata ?? {},
      };
      sessions.set(session.id, session);
      return session;
    },
    async prompt(input) {
      prompts++;
      busy.add(input.sessionID);
      messages.push({
        id: input.id ?? "missing",
        type: "user",
        text: input.text,
        metadata: input.metadata ?? {},
        time: { created: 1 },
      });
      return { id: input.id ?? "missing", sessionID: input.sessionID };
    },
    async wait({ sessionID }, request) {
      if (!busy.has(sessionID)) return;
      const signal = request?.signal;
      await new Promise<void>((_, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    async interrupt() {
      throw new Error("Recovery must not interrupt");
    },
    async synthetic(input) {
      synthetics++;
      expect(input.delivery).toBe("steer");
      messages.push({
        id: "msg_urgent",
        type: "synthetic",
        text: input.text,
        metadata: input.metadata ?? {},
        time: { created: 2 },
      });
    },
    async compact() {
      throw new Error("Recovery must not compact");
    },
  };
  const api: ResultAPI = {
    message: {
      async list(input, request) {
        request?.signal?.throwIfAborted();
        reads++;
        onRead();
        if (failRead) throw new Error("PRIVATE_API_DETAILS");
        expect(input.order).toBe(input.cursor ? undefined : "desc");
        const offset = Number(input.cursor ?? 0);
        const reversed = messages.toReversed();
        const data = reversed.slice(offset, offset + 2);
        const next = offset + data.length;
        return {
          data,
          cursor: { next: next < reversed.length ? String(next) : null },
        };
      },
    },
  };
  const connect: ResultConnector = async (session, signal) => {
    signal.throwIfAborted();
    expect(session.agent).toBe("worker");
    return api;
  };
  const engine = await CrewEngine.open(
    options,
    native,
    {
      async register() {
        return { id: "0".repeat(32), sequence: 0 };
      },
      async send() {
        return { id: "1".repeat(32), sequence: 1 };
      },
      async inbox() {
        return [];
      },
    },
    undefined,
    undefined,
    undefined,
    connect,
  );
  const dispatch = async () => {
    const task = (
      await engine.run(
        { op: "dispatch", crew: "worker", text: "Implement" },
        captain,
      )
    ).task;
    if (!task) throw new Error("Missing fixture task");
    return task;
  };
  const finish = (
    task: CrewTask,
    outcome: "succeeded" | "interrupted" = "succeeded",
  ) => {
    const session = sessions.get(task.workerSessionID);
    if (!session) throw new Error("Missing worker");
    session.outcome = outcome;
    busy.delete(session.id);
    messages.push({
      id: "msg_result",
      type: "assistant",
      agent: "worker",
      finish: "stop",
      content: [{ type: "text", text: "Implemented and tested." }],
      time: { created: 2, completed: 3 },
    });
  };
  return {
    engine,
    captain,
    sessions,
    messages,
    busy,
    dispatch,
    finish,
    connect,
    native,
    options,
    counts: () => ({ prompts, synthetics, reads }),
    failRead: (value = true) => {
      failRead = value;
    },
    onRead: (hook: () => void) => {
      onRead = hook;
    },
    async close() {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("recovery reader accepts installed SDK message objects", () => {
  const compatible = (client: OpenCodeClient): ResultAPI => client;
  expect(compatible).toBeFunction();
});

test("mapped native profiles recover old-named uncertain answers and retain old session authority", async () => {
  const f = await fixture();
  let mapped: CrewEngine | undefined;
  try {
    const task = await f.dispatch();
    f.engine.state.uncertain(task.id);
    f.finish(task);
    mapped = await CrewEngine.open(
      {
        ...f.options,
        team: {
          captain: { id: "captain", agent: "ship-captain-captain" },
          crew: [
            {
              id: "worker",
              agent: "ship-crew-worker",
              role: "Implementation",
              permissionProfile: "coding",
            },
          ],
        },
      },
      f.native,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => ({
        message: {
          async list() {
            return { data: f.messages.toReversed(), cursor: {} };
          },
        },
      }),
    );
    await mapped.captain(f.captain);
    await mapped.authorize({
      sessionID: task.workerSessionID,
      agent: "worker",
      signal: f.captain.signal,
    });
    const session = f.sessions.get(task.workerSessionID);
    if (!session) throw new Error("Missing native peer");
    session.agent = "ship-crew-worker";
    const result = await mapped.run(
      { op: "status", taskID: task.id },
      f.captain,
    );
    expect(result.task).toMatchObject({
      status: "completed",
      result: "Implemented and tested.",
    });
    expect(f.counts().prompts).toBe(1);
  } finally {
    await mapped?.close();
    await f.close();
  }
});

for (const op of ["status", "wait"] as const) {
  test(`${op} adopts a successful final answer without an explicit complete call`, async () => {
    const f = await fixture();
    try {
      const task = await f.dispatch();
      f.finish(task);
      const result = await f.engine.run({ op, taskID: task.id }, f.captain);
      expect(result).toMatchObject({
        status: "completed",
        task: { result: "Implemented and tested." },
      });
      expect(f.counts().prompts).toBe(1);
      expect(f.counts().reads).toBe(1);
    } finally {
      await f.close();
    }
  });
}

test("dispatch recovers an uncertain slot and admits new work without replaying old input", async () => {
  const f = await fixture();
  try {
    const first = await f.dispatch();
    f.finish(first);
    f.engine.state.uncertain(first.id);
    const next = await f.dispatch();
    expect(next.status).toBe("running");
    expect(next.id).not.toBe(first.id);
    expect(next.workerSessionID).toBe(first.workerSessionID);
    expect(f.engine.state.task(first.id)).toMatchObject({
      status: "completed",
      released: 1,
    });
    expect(f.counts().prompts).toBe(2);
  } finally {
    await f.close();
  }
});

for (const notice of [
  "task-scoped",
  "different-task",
  "different-captain",
  "unrelated",
] as const) {
  test(`recovery handles ${notice} synthetic input after an actual urgency call`, async () => {
    const f = await fixture();
    try {
      const task = await f.dispatch();
      expect(
        await f.engine.run(
          {
            op: "urgent",
            taskID: task.id,
            to: "worker",
            text: "Use the verified result and finish this task.",
          },
          f.captain,
        ),
      ).toMatchObject({ status: "steered" });
      const message = f.messages.at(-1);
      if (!message) throw new Error("Missing urgency message");
      expect(message.metadata).toEqual({
        pogoCrew: {
          messageID: "1".repeat(32),
          taskID: task.id,
          sourceTaskID: task.id,
          originCaptainID: f.captain.sessionID,
        },
      });
      if (notice === "different-task")
        message.metadata = {
          pogoCrew: {
            taskID: "task_other",
            sourceTaskID: task.id,
            originCaptainID: f.captain.sessionID,
          },
        };
      if (notice === "different-captain")
        message.metadata = {
          pogoCrew: {
            taskID: task.id,
            sourceTaskID: task.id,
            originCaptainID: "ses_other",
          },
        };
      if (notice === "unrelated") message.metadata = {};
      f.finish(task);
      const result = await f.engine.run(
        { op: "status", taskID: task.id },
        f.captain,
      );
      if (notice === "task-scoped")
        expect(result).toMatchObject({
          status: "completed",
          task: { result: "Implemented and tested." },
        });
      else {
        expect(result.status).toBe("uncertain");
        expect(result.diagnostic).toContain("A later input follows this task");
      }
      expect(f.counts().synthetics).toBe(1);
      expect(f.counts().prompts).toBe(1);
    } finally {
      await f.close();
    }
  });
}

test("recovery survives reopening and traverses message pages and skill records", async () => {
  const f = await fixture();
  const reopened = await CrewEngine.open(
    f.options,
    f.native,
    undefined,
    undefined,
    undefined,
    undefined,
    f.connect,
  );
  try {
    const task = await f.dispatch();
    f.messages.push({ id: "msg_skill", type: "skill", time: { created: 2 } });
    f.finish(task);
    f.engine.state.uncertain(task.id);
    expect(
      await reopened.run({ op: "status", taskID: task.id }, f.captain),
    ).toMatchObject({ status: "completed" });
    expect(f.counts().reads).toBe(2);
    expect(f.counts().prompts).toBe(1);
  } finally {
    await reopened.close();
    await f.close();
  }
});

test("busy workers remain running and do not read result history", async () => {
  const f = await fixture();
  try {
    const task = await f.dispatch();
    expect(
      await f.engine.run({ op: "status", taskID: task.id }, f.captain),
    ).toMatchObject({ status: "running" });
    expect(f.counts().reads).toBe(0);
  } finally {
    await f.close();
  }
});

test("task-marked DM without a source task preserves result recovery", async () => {
  const f = await fixture();
  try {
    const task = await f.dispatch();
    const receipt = await f.engine.dm(
      { op: "send", to: "worker", text: "Restate final result" },
      { ...f.captain, id: "task-free-dm" },
    );
    expect(receipt).toMatchObject({ notification: "accepted" });
    expect(f.messages.at(-1)?.metadata).toMatchObject({
      pogoCrew: { taskID: task.id, messageID: "1".repeat(32) },
    });
    expect(f.messages.at(-1)?.metadata?.["pogoCrew"]).not.toHaveProperty(
      "sourceTaskID",
    );
    f.finish(task);
    expect(
      (await f.engine.run({ op: "status", taskID: task.id }, f.captain)).task
        ?.status,
    ).toBe("completed");
  } finally {
    await f.close();
  }
});

for (const failure of [
  "interrupted",
  "no-answer",
  "failed-answer",
  "unfinished",
  "later-input",
  "wrong-envelope",
  "wrong-session",
  "api",
] as const) {
  test(`recovery leaves ${failure} uncertain with an actionable diagnostic`, async () => {
    const f = await fixture();
    try {
      const task = await f.dispatch();
      f.finish(task, failure === "interrupted" ? "interrupted" : "succeeded");
      if (failure === "no-answer") f.messages.pop();
      const answer = f.messages.at(-1);
      if (failure === "failed-answer" && answer)
        answer.error = { message: "PRIVATE_ERROR" };
      if (failure === "unfinished" && answer) answer.finish = "length";
      if (failure === "later-input")
        f.messages.push({
          id: "other",
          type: "user",
          text: "Unrelated",
          time: { created: 4 },
        });
      if (failure === "wrong-envelope") {
        const input = f.messages[0];
        if (input) input.text = "Different assignment";
      }
      if (failure === "wrong-session") {
        const session = f.sessions.get(task.workerSessionID);
        if (session) session.agent = "other";
      }
      if (failure === "api") f.failRead();
      const result = await f.engine.run(
        { op: "status", taskID: task.id },
        f.captain,
      );
      expect(result.status).toBe("uncertain");
      expect(result.diagnostic).toContain(task.id);
      expect(result.diagnostic).not.toContain("PRIVATE_API_DETAILS");
      expect(f.counts().prompts).toBe(1);
    } finally {
      await f.close();
    }
  });
}

test("concurrent explicit completion wins over automatic result adoption", async () => {
  const f = await fixture();
  try {
    const task = await f.dispatch();
    f.finish(task);
    f.onRead(() =>
      f.engine.state.complete(task.id, task.workerSessionID, "Explicit result"),
    );
    expect(
      await f.engine.run({ op: "status", taskID: task.id }, f.captain),
    ).toMatchObject({ task: { result: "Explicit result" } });
  } finally {
    await f.close();
  }
});

test("cancellation stops history recovery before completion is persisted", async () => {
  const f = await fixture();
  try {
    const task = await f.dispatch();
    f.finish(task);
    const controller = new AbortController();
    f.onRead(() => controller.abort());
    await expect(
      f.engine.run(
        { op: "status", taskID: task.id },
        { ...f.captain, signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(f.engine.state.task(task.id)?.status).not.toBe("completed");
    expect(f.counts().prompts).toBe(1);
  } finally {
    await f.close();
  }
});

test("retrying status recovers the same uncertain task after the API returns", async () => {
  const f = await fixture();
  try {
    const task = await f.dispatch();
    f.finish(task);
    f.failRead();
    expect(
      await f.engine.run({ op: "status", taskID: task.id }, f.captain),
    ).toMatchObject({ status: "uncertain" });
    f.failRead(false);
    expect(
      await f.engine.run({ op: "status", taskID: task.id }, f.captain),
    ).toMatchObject({ status: "completed", task: { id: task.id } });
    expect(f.counts().prompts).toBe(1);
  } finally {
    await f.close();
  }
});

test("queued task checks recover the previous answer before FIFO promotion", async () => {
  const f = await fixture();
  try {
    const task = await f.dispatch();
    const queued = (
      await f.engine.run(
        { op: "dispatch", crew: "worker", text: "Next", queue: true },
        f.captain,
      )
    ).task;
    if (!queued) throw new Error("Missing queued task");
    f.finish(task);
    expect(
      await f.engine.run({ op: "status", taskID: queued.id }, f.captain),
    ).toMatchObject({ status: "running", task: { id: queued.id } });
    expect(f.engine.state.task(task.id)).toMatchObject({
      status: "completed",
      released: 1,
    });
    expect(f.counts().prompts).toBe(2);
  } finally {
    await f.close();
  }
});

test("a changed task status or expected input cannot be overwritten by recovery", async () => {
  const f = await fixture();
  try {
    const task = await f.dispatch();
    expect(
      f.engine.state.recoverResult({ ...task, inputID: "other" }, "Wrong")
        .status,
    ).toBe("running");
    f.finish(task);
    f.onRead(() => {
      f.engine.state.beginCancel(task.id, f.captain.sessionID);
    });
    expect(
      await f.engine.run({ op: "status", taskID: task.id }, f.captain),
    ).toMatchObject({ status: "cancelling", task: { result: null } });
  } finally {
    await f.close();
  }
});
