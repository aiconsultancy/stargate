import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CrewCaller } from "../src/crew/engine";
import { CrewQuestions } from "../src/crew/questions";
import { CrewError, CrewState } from "../src/crew/state";
import { defaultTeam } from "../src/crew/team";
import { saveQuestionSettings } from "../src/question-settings";
import type { NativeQuestion, QuestionAnswer } from "../src/questions";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const signal = new AbortController().signal;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "crew-questions-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let state = await CrewState.open(directory, "questions", "identity");
  cleanup.push(async () => state.close());
  const member = defaultTeam.crew[0];
  if (!member) throw new Error("Missing worker");
  const peer = state.reservePeer(member.id);
  state.readyPeer(peer.crewID);
  const task = state.reserveTask(peer, "ses_captain");
  if (!task) throw new Error("Missing task");
  state.running(task.id);
  const question: NativeQuestion = {
    id: "frm_question",
    sessionID: peer.sessionID,
    inputID: task.inputID,
    toolMessageID: "msg_tool",
    toolCallID: "call_question",
    fingerprint: "a".repeat(64),
    title: "Choose colour",
    fields: [
      {
        key: "q0",
        type: "string",
        options: [
          { label: "Blue", value: "blue" },
          { label: "Green", value: "green" },
        ],
      },
    ],
  };
  const notices: Array<{ input: unknown; caller: CrewCaller }> = [];
  const replies: Array<QuestionAnswer | null> = [];
  let enabled = true;
  let now = 1000;
  let pending = [question];
  let failWrite = false;
  let failNotice = false;
  let reads = 0;
  let onRead = () => {};
  const authority = {
    options: {
      captainDirectory: directory,
      team: {
        ...defaultTeam,
        captain: { ...defaultTeam.captain, agent: "native-captain" },
      },
    },
    get state() {
      return state;
    },
    async captain(caller: CrewCaller) {
      if (caller.agent !== defaultTeam.captain.id)
        throw new CrewError("Captain required");
    },
    async dm(input: unknown, caller: CrewCaller) {
      notices.push({ input, caller });
      return { stored: failNotice ? "uncertain" : true };
    },
  };
  const bridge = (persisted = false) =>
    new CrewQuestions(
      authority,
      async () => {
        reads++;
        return {
          async pendingQuestions() {
            onRead();
            return pending;
          },
          async questionBelongsToInput(
            _session: string,
            _form: string,
            input: string,
            fingerprint: string,
          ) {
            return pending.some(
              (q) => q.inputID === input && q.fingerprint === fingerprint,
            );
          },
          async replyQuestion(
            _question: NativeQuestion,
            answer: QuestionAnswer | null,
          ) {
            replies.push(answer);
            if (failWrite) throw new Error("private details");
          },
        };
      },
      {
        ...(persisted
          ? {}
          : {
              settings: async () => ({
                enabled,
                timeoutMs: 300_000,
                answer: "requester" as const,
              }),
            }),
        now: () => now,
      },
    );
  const caller: CrewCaller = {
    sessionID: "ses_captain",
    agent: defaultTeam.captain.id,
    signal,
  };
  return {
    directory,
    state: () => state,
    task,
    question,
    notices,
    replies,
    caller,
    bridge,
    enabled: (value: boolean) => {
      enabled = value;
    },
    advance: () => {
      now += 300_001;
    },
    pending: (value: NativeQuestion[]) => {
      pending = value;
    },
    failWrite: () => {
      failWrite = true;
    },
    failNotice: (value: boolean) => {
      failNotice = value;
    },
    reads: () => reads,
    onRead: (value: () => void) => {
      onRead = value;
    },
    async reopen() {
      state.close();
      state = await CrewState.open(directory, "questions", "identity");
    },
  };
}

test("routes one durable native offer to the originating captain, never Slack", async () => {
  const f = await fixture();
  const bridge = f.bridge();
  await bridge.poll(signal);
  await bridge.poll(signal);
  expect(f.notices).toHaveLength(1);
  const offer = f.state().crewQuestionOffers(f.task.id)[0];
  expect(offer).toBeDefined();
  expect(f.notices[0]?.input).toMatchObject({
    op: "send",
    to: "captain",
    taskID: f.task.id,
  });
  expect(f.notices[0]?.caller.sessionID).toBe(f.task.workerSessionID);
  expect(JSON.stringify(f.notices[0]?.input)).toContain("stargate_question");
  await f.reopen();
  await f.bridge().poll(signal);
  expect(f.notices).toHaveLength(1);
  const result = await f
    .bridge()
    .run({ op: "answer", token: offer?.token, answer: "2" }, f.caller);
  expect(result).toEqual({ outcome: "answered" });
  expect(f.replies).toEqual([{ q0: "green" }]);
});

test("disabled bridge does not connect, notify or answer", async () => {
  const f = await fixture();
  f.enabled(false);
  await f.bridge().poll(signal);
  expect(f.reads()).toBe(0);
  expect(f.notices).toHaveLength(0);
  await expect(
    f.bridge().run({ op: "cancel", token: "a".repeat(32) }, f.caller),
  ).rejects.toThrow();
});

test("worker, other captain and malformed answers cannot consume an offer", async () => {
  const f = await fixture();
  await f.bridge().poll(signal);
  const offer = f.state().crewQuestionOffers(f.task.id)[0];
  for (const caller of [
    { ...f.caller, agent: "worker" },
    { ...f.caller, sessionID: "ses_other" },
  ])
    await expect(
      f
        .bridge()
        .run({ op: "answer", token: offer?.token, answer: "1" }, caller),
    ).rejects.toThrow();
  await expect(
    f
      .bridge()
      .run({ op: "answer", token: offer?.token, answer: "99" }, f.caller),
  ).rejects.toThrow();
  expect(f.replies).toHaveLength(0);
  expect(f.state().crewQuestionOffers(f.task.id)[0]?.state).toBe("offered");
});

test("stale fingerprints, unrelated inputs and replaced task ownership fail closed", async () => {
  const f = await fixture();
  f.pending([{ ...f.question, inputID: "another-input" }]);
  await f.bridge().poll(signal);
  expect(f.notices).toHaveLength(0);
  f.pending([f.question]);
  await f.bridge().poll(signal);
  const offer = f.state().crewQuestionOffers(f.task.id)[0];
  f.pending([{ ...f.question, fingerprint: "b".repeat(64) }]);
  await expect(
    f.bridge().run({ op: "cancel", token: offer?.token }, f.caller),
  ).rejects.toThrow();
  f.pending([f.question]);
  f.onRead(() => f.state().uncertain(f.task.id));
  await expect(
    f.bridge().run({ op: "cancel", token: offer?.token }, f.caller),
  ).rejects.toThrow();
  expect(f.replies).toHaveLength(0);
});

test("native write is claimed before I/O and unknown failures are never replayed", async () => {
  const f = await fixture();
  await f.bridge().poll(signal);
  const offer = f.state().crewQuestionOffers(f.task.id)[0];
  f.failWrite();
  const input = { op: "answer", token: offer?.token, answer: "1" };
  const results = await Promise.allSettled([
    f.bridge().run(input, f.caller),
    f.bridge().run(input, f.caller),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(f.replies).toHaveLength(1);
  expect(f.state().crewQuestionOffers(f.task.id)[0]?.outcome).toBe("uncertain");
  await f.reopen();
  await f.bridge().poll(signal);
  await expect(f.bridge().run(input, f.caller)).rejects.toThrow();
  expect(f.replies).toHaveLength(1);
});

test("expiry cancels the exact native form once, including across restart", async () => {
  const f = await fixture();
  await f.bridge().poll(signal);
  f.advance();
  await f.bridge().poll(signal);
  expect(f.replies).toEqual([null]);
  expect(f.state().crewQuestionOffers(f.task.id)[0]?.outcome).toBe("cancelled");
  await f.reopen();
  await f.bridge().poll(signal);
  expect(f.replies).toEqual([null]);
});

test("unconfirmed captain mail retries the same durable message key", async () => {
  const f = await fixture();
  f.failNotice(true);
  await f.bridge().poll(signal);
  expect(f.state().crewQuestionOffers(f.task.id)[0]?.notified).toBe(0);
  f.failNotice(false);
  await f.bridge().poll(signal);
  expect(f.notices).toHaveLength(2);
  expect(f.notices[1]?.input).toEqual(f.notices[0]?.input);
  expect(f.state().crewQuestionOffers(f.task.id)[0]?.notified).toBe(1);
});

test("cancel replies only to the bound native form, aborted calls do not write", async () => {
  const f = await fixture();
  await f.bridge().poll(signal);
  const offer = f.state().crewQuestionOffers(f.task.id)[0];
  const input = { op: "cancel", token: offer?.token };
  await expect(
    f.bridge().run(input, { ...f.caller, signal: AbortSignal.abort() }),
  ).rejects.toThrow();
  expect(f.replies).toEqual([]);
  expect(await f.bridge().run(input, f.caller)).toEqual({
    outcome: "cancelled",
  });
  expect(f.replies).toEqual([null]);
});

test("restart reconciles a claimed write even when the native form disappeared", async () => {
  const f = await fixture();
  await f.bridge().poll(signal);
  const offer = f.state().crewQuestionOffers(f.task.id)[0];
  if (!offer) throw new Error("Missing offer");
  expect(f.state().claimCrewQuestion(offer.token, 1000)).toBe(true);
  f.pending([]);
  await f.reopen();
  await f.bridge().poll(signal);
  expect(f.state().crewQuestion(offer.token)?.outcome).toBe("uncertain");
  expect(f.replies).toEqual([]);
});

test("persisted gate uses the native captain definition, not its logical crew ID", async () => {
  const f = await fixture();
  const settings = {
    enabled: true,
    timeoutMs: 300_000,
    answer: "requester" as const,
  };
  await saveQuestionSettings(
    f.directory,
    defaultTeam.captain.id,
    settings,
    signal,
  );
  await f.bridge(true).poll(signal);
  expect(f.reads()).toBe(0);
  await saveQuestionSettings(f.directory, "native-captain", settings, signal);
  await f.bridge(true).poll(signal);
  expect(f.notices).toHaveLength(1);
  const offer = f.state().crewQuestionOffers(f.task.id)[0];
  await saveQuestionSettings(
    f.directory,
    "native-captain",
    { ...settings, enabled: false },
    signal,
  );
  await expect(
    f.bridge(true).run({ op: "cancel", token: offer?.token }, f.caller),
  ).rejects.toThrow("disabled");
  expect(f.replies).toEqual([]);
});
