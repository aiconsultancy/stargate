import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  ConversationId,
  ConversationView,
  EntryId,
  EntryRecord,
  Observer,
  SettledSubmissionRecord,
  Submission,
  SubmissionId,
  SubmissionRecord,
} from "@earendil-works/pi-durable";
import { PiDurableBackend } from "../src/backends/pi-durable";
import { PiCrewWorkers } from "../src/crew/pi-worker";
import { CrewState, type CrewTask } from "../src/crew/state";
import { teamSchema } from "../src/crew/team";

class Clock {
  private now = 0;
  private sequence = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  readonly schedule = (callback: () => void) => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.now + 1000, callback });
    return () => {
      this.timers.delete(id);
    };
  };
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.timers].sort(([, a], [, b]) => a.at - b.at)[0];
      if (!next || next[1].at > end) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.now = end;
  }
}

function assistant(
  id: number,
  text: string,
  conversationId = 1 as ConversationId,
): EntryRecord {
  return {
    id: id as EntryId,
    conversationId,
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "openai-responses",
        provider: "openai",
        model: "local-test",
        stopReason: "stop",
        timestamp: 0,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    ],
  };
}

async function fixture(report = false) {
  const directory = await mkdtemp("/tmp/opencode/pogo-pi-progress-");
  const state = await CrewState.open(directory, "progress", "identity");
  const clock = new Clock();
  const member = teamSchema.parse({
    captain: { id: "captain" },
    crew: [
      {
        id: "twiki",
        role: "Maintenance",
        permissionProfile: "coding",
        backend: { type: "pi-durable", model: "openai/test" },
      },
    ],
  }).crew[0];
  if (!member) throw new Error("Missing member");
  const peer = state.reservePeer(member.id);
  state.readyPeer(member.id);
  state.reservePiPeer(peer.sessionID);
  state.readyPiPeer(peer.sessionID, "1");
  let observer: Observer<ConversationView> | undefined;
  let detached = 0;
  const started = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<SettledSubmissionRecord>();
  const submissionId = 1 as SubmissionId;
  const inputEntry = 1 as EntryId;
  let activeConversationId = 1 as ConversationId;
  let record: SubmissionRecord = {
    id: submissionId,
    conversationId: activeConversationId,
    type: "input",
    status: "placed",
    entry: inputEntry,
  };
  const publications: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  let final = assistant(3, "CANONICAL FINAL");
  let reportsCreated = 0;
  const view = (
    entries: readonly EntryRecord[] = [],
    text = "",
  ): ConversationView => ({
    conversation: { id: activeConversationId },
    entries,
    docs: {
      "pi.live": {
        run: { inputs: [submissionId] },
        generation: {
          message: {
            content: [
              { type: "thinking", text: "PRIVATE REASONING" },
              { type: "text", text },
            ],
          },
        },
      },
    },
  });
  const advance = (entries: readonly EntryRecord[] = [], text = "") => {
    if (!observer) throw new Error("Observer not attached");
    const published = Promise.withResolvers<void>();
    publications.push(published);
    observer.advance(
      { kind: "value", value: view(entries, text), ops: [], retired: false },
      BACKGROUND_CONTEXT,
    );
    return published.promise;
  };
  const harness = {
    async observeConversation(
      _id: ConversationId,
      attached: Observer<ConversationView>,
    ) {
      observer = attached;
      return {
        value: view(),
        detach() {
          detached++;
        },
      };
    },
    async conversation(id: ConversationId) {
      activeConversationId = id;
      return {
        async submit() {
          record = {
            id: submissionId,
            conversationId: id,
            type: "input",
            status: "placed",
            entry: inputEntry,
          };
          const submission: Submission = {
            id: submissionId,
            async status() {
              return record;
            },
            wait: () => answer.promise,
            async abort() {
              return record.status === "placed" ? "already_placed" : "settled";
            },
          };
          started.resolve();
          return submission;
        },
        async commit() {
          return final;
        },
        async abort() {
          record = {
            id: submissionId,
            conversationId: id,
            type: "input",
            status: "unanswered",
            entry: inputEntry,
            reason: "aborted",
          };
          answer.reject(new Error("Aborted"));
        },
      };
    },
    async createConversation() {
      reportsCreated++;
      return { id: 2 as ConversationId };
    },
    async close() {},
  };
  const backend: PiDurableBackend = Reflect.construct(PiDurableBackend, [
    harness,
    { model: "openai/test" },
    new Set(),
    {},
  ]);
  const settled = Promise.withResolvers<void>();
  const complete = state.complete.bind(state);
  state.complete = (...args) => {
    complete(...args);
    settled.resolve();
  };
  const uncertain = state.uncertain.bind(state);
  state.uncertain = (...args) => {
    uncertain(...args);
    settled.resolve();
  };
  let task: CrewTask | null | undefined;
  if (report) {
    const capture = state.reporting.start("captain", "request", "twiki");
    state.reporting.finish(capture);
    const queued = state.enqueue(
      peer,
      "captain",
      "Report input must stay private",
      capture.id,
    );
    task = state.promote(queued.id, null)?.task;
  } else task = state.reserveTask(peer, "captain", "Maintenance assignment");
  if (!task) throw new Error("Missing task");
  const workers = new PiCrewWorkers(
    state,
    directory,
    async () => backend,
    clock.schedule,
  );
  // The fake harness implements the provider boundary, including cancellation.
  const prompt = backend.prompt.bind(backend);
  backend.prompt = (...args) => {
    args[2].addEventListener(
      "abort",
      () => answer.reject(new Error("Aborted")),
      { once: true },
    );
    const onText = args[3];
    if (onText) {
      args[3] = (text) => {
        onText(text);
        publications.shift()?.resolve();
      };
    }
    return prompt(...args);
  };
  return {
    state,
    backend,
    workers,
    member,
    peer,
    task,
    clock,
    get detached() {
      return detached;
    },
    get reportsCreated() {
      return reportsCreated;
    },
    emit: (text: string) => advance([], text),
    intermediate: (text: string) =>
      advance([assistant(2, text, activeConversationId)]),
    started: started.promise,
    async start() {
      workers.start(member, directory, peer, task, "Assignment");
      await started.promise;
    },
    succeed(text = "CANONICAL FINAL") {
      final = assistant(3, text, activeConversationId);
      record = {
        id: submissionId,
        conversationId: activeConversationId,
        type: "input",
        status: "done",
        entry: inputEntry,
        answer: final.id,
      };
      answer.resolve(record);
    },
    fail() {
      record = {
        id: submissionId,
        conversationId: activeConversationId,
        type: "input",
        status: "unanswered",
        entry: inputEntry,
        reason: "model_error",
        detail: "Bearer private-provider-error",
      };
      answer.resolve(record);
    },
    settled: settled.promise,
    progress: () => state.activity.task(state.task(task.id) ?? task).progress,
    async close() {
      await workers.close();
      state.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const report of [false, true]) {
  test(`Pi ${report ? "reporter" : "maintenance"} retains canonical final after >64k visible intermediate text`, async () => {
    const f = await fixture(report);
    try {
      await f.start();
      await f.intermediate("INTERMEDIATE ".repeat(6000));
      expect(f.progress().length).toBeGreaterThan(0);
      f.succeed();
      await f.settled;
      expect(f.state.task(f.task.id)).toMatchObject({
        status: "completed",
        result: "CANONICAL FINAL",
      });
      expect(f.reportsCreated).toBe(report ? 1 : 0);
      expect(f.detached).toBe(1);
      expect(f.clock.timers.size).toBe(0);
    } finally {
      await f.close();
    }
  });
}

test("ordinary Pi Slack prompt retains cumulative visible return and live callbacks", async () => {
  const f = await fixture();
  try {
    const snapshots: string[] = [];
    const result = f.backend.prompt(
      "1",
      "Slack request",
      new AbortController().signal,
      (text) => snapshots.push(text),
    );
    await f.started;
    await f.intermediate("VISIBLE INTERMEDIATE");
    f.succeed("FINAL SLACK ANSWER");
    expect(await result).toBe("VISIBLE INTERMEDIATE\n\nFINAL SLACK ANSWER");
    expect(snapshots).toEqual(["VISIBLE INTERMEDIATE"]);
    expect(f.detached).toBe(1);
  } finally {
    await f.close();
  }
});

test("Pi progress flushes latest burst tail while still busy and redacts before storage", async () => {
  const f = await fixture();
  try {
    await f.start();
    await f.emit("First update");
    f.clock.advance(100);
    await f.emit("Second update");
    f.clock.advance(100);
    await f.emit("Latest update token=private-secret");
    expect(f.progress()).toBe("First update");
    f.clock.advance(800);
    expect(f.progress()).toBe("Latest update token=[REDACTED]");
    expect(f.state.task(f.task.id)?.status).toBe("running");
    f.clock.advance(1000);
    expect(f.clock.timers.size).toBe(0);
    f.succeed();
    await f.settled;
    expect(f.progress()).not.toContain("PRIVATE REASONING");
  } finally {
    await f.close();
  }
});

for (const outcome of ["success", "failure", "cancel", "close"] as const) {
  test(`Pi progress flushes pending tail on ${outcome}, clears timers and ignores late callbacks`, async () => {
    const f = await fixture();
    try {
      await f.start();
      await f.emit("First update");
      await f.emit("Latest pending update");
      const callbacks = [...f.clock.timers.values()].map(
        ({ callback }) => callback,
      );
      if (outcome === "success") f.succeed();
      else if (outcome === "failure") f.fail();
      else if (outcome === "cancel") await f.workers.interrupt(f.peer);
      else await f.workers.close();
      await f.settled;
      expect(f.progress()).toBe("Latest pending update");
      expect(f.clock.timers.size).toBe(0);
      expect(f.state.task(f.task.id)?.status).toBe(
        outcome === "success" ? "completed" : "uncertain",
      );
      const saved = f.state.activity.task(f.state.task(f.task.id) ?? f.task);
      f.emit("Late observer callback");
      for (const callback of callbacks) callback();
      f.clock.advance(10000);
      expect(f.state.activity.task(f.state.task(f.task.id) ?? f.task)).toEqual(
        saved,
      );
      expect(f.clock.timers.size).toBe(0);
    } finally {
      await f.close();
    }
  });
}

test("Pi progress storage failures do not stop work or escape timer callbacks", async () => {
  const f = await fixture();
  try {
    await f.start();
    const progress = f.state.activity.progress.bind(f.state.activity);
    let failing = true;
    f.state.activity.progress = (...args) => {
      if (failing) throw new Error("Private SQLite error");
      progress(...args);
    };
    await expect(f.emit("First")).resolves.toBeUndefined();
    await expect(f.emit("Latest update")).resolves.toBeUndefined();
    expect(() => f.clock.advance(1000)).not.toThrow();
    expect(f.state.task(f.task.id)?.status).toBe("running");
    failing = false;
    f.clock.advance(1000);
    expect(f.progress()).toBe("Latest update");
    f.succeed();
    await f.settled;
    expect(f.state.task(f.task.id)?.result).toBe("CANONICAL FINAL");
    expect(f.clock.timers.size).toBe(0);
  } finally {
    await f.close();
  }
});
