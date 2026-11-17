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
import type { MesijMessage } from "../src/crew/mesij";
import type { ResultAPI, ResultMessage } from "../src/crew/result";
import type { CrewTask } from "../src/crew/state";

async function fixture() {
  const directory = await mkdtemp("/tmp/opencode/stargate-recovery-");
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
  const mail: MesijMessage[] = [];
  const receipts = new Map<string, MesijMessage>();
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
      async send(input) {
        let event = receipts.get(input.key);
        if (!event) {
          event = {
            actor: input.actor,
            sessionID: input.sessionID,
            to: input.to,
            text: input.text,
            ...(input.replyTo ? { replyTo: input.replyTo } : {}),
            id: String(mail.length + 1).repeat(32),
            sequence: mail.length + 1,
            type: input.replyTo ? "message.replied" : "message.posted",
          };
          receipts.set(input.key, event);
          mail.push(event);
        }
        return { id: event.id, sequence: event.sequence };
      },
      async inbox(input) {
        return mail.filter(
          (event) =>
            event.to === input.sessionID && event.sequence > (input.after ?? 0),
        );
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
    mail,
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

test("cutover reads immutable historical pogoCrew result evidence without editing or replay", async () => {
  const f = await fixture();
  try {
    const task = await f.dispatch();
    const admitted = f.messages.find((message) => message.id === task.inputID);
    if (!admitted?.text) throw new Error("Missing retained input");
    expect(admitted.metadata).toEqual({
      pogoCrew: { taskID: task.id, originCaptainID: task.originCaptainID },
    });
    admitted.text = admitted.text.replace(
      "Stargate task envelope: ",
      "Pogo task envelope: ",
    );
    admitted.metadata = {
      pogoCrew: { taskID: task.id, originCaptainID: task.originCaptainID },
    };
    f.engine.state.uncertain(task.id);
    f.finish(task);
    const history = JSON.stringify(f.messages);
    expect(
      await f.engine.run({ op: "status", taskID: task.id }, f.captain),
    ).toMatchObject({
      status: "completed",
      task: { result: "Implemented and tested." },
    });
    expect(JSON.stringify(f.messages)).toBe(history);
    expect(f.counts()).toMatchObject({ prompts: 1, synthetics: 0 });
  } finally {
    await f.close();
  }
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

  test(`${op} collects the exact ended turn after a late DM, without replay or native notification`, async () => {
    const f = await fixture();
    try {
      const task = await f.dispatch();
      f.finish(task);
      const final = f.messages.at(-1);
      const input = { op: "send", to: "worker", text: "Any update?" };
      for (let retry = 0; retry < 2; retry++)
        expect(await f.engine.dm(input, f.captain)).toMatchObject({
          stored: true,
          notification: "inbox",
        });
      expect(f.mail).toHaveLength(1);
      expect(f.counts().synthetics).toBe(0);
      expect(f.messages.at(-1)).toBe(final);
      // Deferral does not equate native idle with successful task completion.
      expect(f.engine.state.task(task.id)?.status).toBe("running");
      expect(
        await f.engine.run({ op, taskID: task.id }, f.captain),
      ).toMatchObject({
        status: "completed",
        task: { result: "Implemented and tested." },
      });
      expect(f.counts().prompts).toBe(1);
      expect(
        (
          await f.engine.mail(
            { op: "inbox" },
            {
              sessionID: task.workerSessionID,
              agent: "worker",
              signal: f.captain.signal,
            },
          )
        ).messages,
      ).toMatchObject([{ text: input.text }]);
    } finally {
      await f.close();
    }
  });
}

test("a worker ending during notification validation leaves DM in its inbox", async () => {
  const f = await fixture();
  try {
    const task = await f.dispatch();
    const get = f.native.get;
    f.native.get = async (input, request) => {
      if (input.sessionID === task.workerSessionID) f.finish(task);
      return get(input, request);
    };
    expect(
      await f.engine.dm({ op: "send", to: "worker", text: "Check" }, f.captain),
    ).toMatchObject({ stored: true, notification: "inbox" });
    expect(f.counts().synthetics).toBe(0);
    expect(
      await f.engine.run({ op: "status", taskID: task.id }, f.captain),
    ).toMatchObject({
      status: "completed",
      task: { result: "Implemented and tested." },
    });
    expect(f.counts().prompts).toBe(1);
  } finally {
    await f.close();
  }
});

test("a targeted DM collected concurrently cannot become an idle-worker wake", async () => {
  const f = await fixture();
  try {
    const task = await f.dispatch();
    const notify = f.engine.notifyMail.bind(f.engine);
    f.engine.notifyMail = async (...args) => {
      f.finish(task);
      expect(
        await f.engine.run({ op: "status", taskID: task.id }, f.captain),
      ).toMatchObject({ status: "completed" });
      return notify(...args);
    };
    expect(
      await f.engine.dm({ op: "send", to: "worker", text: "Check" }, f.captain),
    ).toMatchObject({ stored: true, notification: "inbox" });
    expect(f.counts().synthetics).toBe(0);
    expect(f.engine.state.task(task.id)?.result).toBe(
      "Implemented and tested.",
    );
  } finally {
    await f.close();
  }
});

test("notification reservation prevents slot reuse while the ended turn is collected", async () => {
  const f = await fixture();
  try {
    const task = await f.dispatch();
    const wait = f.native.wait;
    f.native.wait = async (input, request) => {
      f.native.wait = wait;
      f.finish(task);
      expect(
        await f.engine.run({ op: "status", taskID: task.id }, f.captain),
      ).toMatchObject({ status: "completed" });
      expect(
        await f.engine.run(
          { op: "dispatch", crew: "worker", text: "Next" },
          f.captain,
        ),
      ).toMatchObject({ status: "busy" });
      return wait(input, request);
    };
    expect(
      await f.engine.dm({ op: "send", to: "worker", text: "Check" }, f.captain),
    ).toMatchObject({ stored: true, notification: "inbox" });
    expect(f.engine.state.task(task.id)).toMatchObject({
      status: "completed",
      notifying: 0,
      released: 0,
    });
    expect(f.counts()).toMatchObject({ prompts: 1, synthetics: 0 });
  } finally {
    await f.close();
  }
});

test("completion after the busy probe keeps admitted steer task-marked and never resumes it", async () => {
  const f = await fixture();
  try {
    const task = await f.dispatch();
    const synthetic = f.native.synthetic;
    f.native.synthetic = async (input, request) => {
      f.finish(task);
      expect(input.resume).toBe(false);
      expect(input.metadata).toMatchObject({
        pogoCrew: { taskID: task.id },
      });
      return synthetic(input, request);
    };
    expect(
      await f.engine.dm({ op: "send", to: "worker", text: "Check" }, f.captain),
    ).toMatchObject({ stored: true, notification: "accepted" });
    expect(
      await f.engine.run({ op: "status", taskID: task.id }, f.captain),
    ).toMatchObject({
      status: "completed",
      task: { result: "Implemented and tested." },
    });
    expect(f.counts()).toMatchObject({ prompts: 1, synthetics: 1 });
  } finally {
    await f.close();
  }
});

for (const status of ["uncertain", "cancelling"] as const) {
  test(`notification defers if the occupied task becomes ${status} during its native probe`, async () => {
    const f = await fixture();
    try {
      const task = await f.dispatch();
      f.native.wait = async () => {
        if (status === "uncertain") f.engine.state.uncertain(task.id);
        else f.engine.state.beginCancel(task.id, task.originCaptainID);
        throw new Error("Native probe did not confirm idle");
      };
      expect(
        await f.engine.dm(
          { op: "send", to: "worker", text: "Check" },
          f.captain,
        ),
      ).toMatchObject({ stored: true, notification: "deferred" });
      expect(f.counts()).toMatchObject({ prompts: 1, synthetics: 0, reads: 0 });
      expect(f.engine.state.task(task.id)).toMatchObject({
        status,
        notifying: 0,
      });
    } finally {
      await f.close();
    }
  });
}

test("ordinary mail after a final answer never requests native delivery or result recovery", async () => {
  const f = await fixture();
  try {
    const task = await f.dispatch();
    f.finish(task);
    expect(
      await f.engine.mail(
        { op: "send", to: "worker", text: "Later" },
        f.captain,
      ),
    ).toMatchObject({ stored: true, notification: "not_requested" });
    expect(f.counts()).toMatchObject({ prompts: 1, synthetics: 0, reads: 0 });
    expect(f.engine.state.task(task.id)?.status).toBe("running");
  } finally {
    await f.close();
  }
});

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

test("recovery survives reopening and traverses native instruction context and skill records", async () => {
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
    f.messages.push({
      id: "msg_instructions",
      type: "synthetic",
      time: { created: 2 },
      metadata: {
        instruction: { paths: ["/fixture/worker/nested/AGENTS.md"] },
      },
      description: "Loaded nested/AGENTS.md",
      text: "Instructions from: /fixture/worker/nested/AGENTS.md\n# Fixture instructions",
    });
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
  "later-synthetic",
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
      if (failure === "later-synthetic")
        f.messages.push({
          id: "other",
          type: "synthetic",
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

for (const hasFinal of [true, false])
  test(`reopened recovery correlates background shell notices without replay; final=${hasFinal}`, async () => {
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
      for (const [index, command] of [
        'printf "fixture"',
        "cargo check --locked",
      ].entries()) {
        const shellID = `sh_fixture${index}`;
        f.messages.push({
          id: `msg_launch${index}`,
          type: "assistant",
          agent: "worker",
          finish: "tool-calls",
          time: { created: 2 + index * 2, completed: 3 + index * 2 },
          content: [
            {
              type: "tool",
              name: "shell",
              executed: false,
              state: {
                status: "completed",
                input: { command },
                content: [{ type: "text", text: "Background command" }],
                metadata: { shellID, status: "running", truncated: false },
              },
            },
          ],
        });
        f.messages.push({
          id: `msg_callback${index}`,
          type: "synthetic",
          time: { created: 3 + index * 2 },
          description: command,
          metadata: {
            source: "shell",
            shellID,
            jobID: shellID,
            state: "completed",
            truncated: false,
            exit: 0,
          },
          text: `<shell id="${shellID}" state="completed" command="${command}">\nFixture output\n</shell>`,
        });
      }
      f.finish(task);
      const final = f.messages.at(-1);
      if (!final) throw new Error("Missing fixture final");
      final.time = { created: 8, completed: 9 };
      if (!hasFinal) f.messages.pop();
      f.engine.state.uncertain(task.id);
      const retained = JSON.stringify(f.messages);
      const result = await reopened.run(
        { op: "status", taskID: task.id },
        f.captain,
      );
      expect(result).toMatchObject({
        status: hasFinal ? "completed" : "uncertain",
      });
      expect(reopened.state.task(task.id)).toMatchObject({
        workerSessionID: task.workerSessionID,
        inputID: task.inputID,
        result: hasFinal ? "Implemented and tested." : null,
      });
      if (!hasFinal) expect(reopened.state.task(task.id)?.released).toBe(0);
      expect(JSON.stringify(f.messages)).toBe(retained);
      expect(f.counts()).toMatchObject({ prompts: 1, synthetics: 0 });
    } finally {
      await reopened.close();
      await f.close();
    }
  });
