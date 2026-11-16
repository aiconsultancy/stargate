import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { AgentBackend } from "../src/backend";
import { Gateway } from "../src/gateway";
import {
  type NativeQuestion,
  nativeQuestionSchema,
  Questions,
  questionAnswer,
  questionControl,
  questionText,
} from "../src/questions";
import { type Incoming, Store } from "../src/store";
import { bot, identity } from "./fixtures";
import { until } from "./irc-fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const question = (): NativeQuestion =>
  nativeQuestionSchema.parse({
    id: "frm_question",
    sessionID: "ses_captain",
    inputID: "msg_original",
    toolMessageID: "msg_assistant",
    toolCallID: "call_question",
    fingerprint: "a".repeat(64),
    title: "What next?",
    fields: [
      {
        key: "q0",
        type: "string",
        title: "Choose",
        description: "Wait or continue?",
        options: [
          { value: "wait", label: "Wait" },
          { value: "continue", label: "Continue" },
        ],
      },
    ],
  });
const original: Incoming = {
  botKey: "irc-fixture",
  eventId: "#ship:m1",
  conversation: "irc-conversation",
  channel: "#ship",
  thread: "m1",
  user: "jac",
  text: "Please investigate",
};

async function fixture(source = true) {
  const dir = await mkdtemp(join(tmpdir(), "stargate-questions-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  let store = new Store(path);
  cleanup.push(() => store.close());
  store.enqueue(original);
  const job = store.queuedJob(original.botKey, original.eventId);
  if (!job) throw new Error("Missing job");
  store.running(job.id);
  store.started(job.id);
  store.captainCursor(original.botKey, "ses_captain");
  store.baselineCaptain(original.botKey, "ses_captain", "msg_baseline");
  store.saveInput(original.botKey, job.id, "msg_original", "ses_captain");
  if (source) store.recordQuestionSource(original);
  const published: string[] = [];
  const decisions: unknown[] = [];
  const settled: string[] = [];
  let pending = true;
  let allowed = true;
  let fail = false;
  let nativeSettled = false;
  let fingerprint = "a".repeat(64);
  const backend: AgentBackend = {
    sessionID: "ses_captain",
    async createSession() {
      throw new Error("No session creation");
    },
    async prompt() {
      throw new Error("No prompt replay");
    },
    async close() {},
    async pendingQuestions() {
      return pending ? [{ ...question(), fingerprint }] : [];
    },
    async questionBelongsToInput(s, f, i, hash) {
      return (
        pending &&
        s === "ses_captain" &&
        f === "frm_question" &&
        i === "msg_original" &&
        hash === fingerprint
      );
    },
    async replyQuestion(_q, answer) {
      decisions.push(answer);
      if (fail) throw new Error("Do not expose provider details");
      pending = false;
    },
    async questionInputSettled() {
      return nativeSettled;
    },
  };
  const make = () =>
    new Questions(
      original.botKey,
      store,
      backend,
      () => ({
        account: "captain",
        human: (user) => user === "jac",
        async publish(_job, text, guard) {
          if (!guard()) throw new Error("Denied");
          published.push(text);
        },
      }),
      () => allowed,
      (s) => settled.push(s),
    );
  let bridge = make();
  return {
    backend,
    published,
    decisions,
    settled,
    jobID: job.id,
    get store() {
      return store;
    },
    get bridge() {
      return bridge;
    },
    async poll() {
      await bridge.poll(AbortSignal.timeout(3000));
    },
    offer() {
      const offer = store.questionOffers(original.botKey)[0];
      if (!offer) throw new Error("Missing offer");
      return offer;
    },
    async answer(
      changes: Partial<Incoming> = {},
      overrides: Partial<NonNullable<ReturnType<typeof questionControl>>> = {},
    ) {
      const token =
        store.questionOffers(original.botKey)[0]?.token ?? "0".repeat(32);
      await bridge.answer(
        {
          ...original,
          eventId: "#ship:m2",
          thread: "m2",
          replyParent: "m1",
          ...changes,
        },
        { target: "captain", token, answer: "1", ...overrides },
        AbortSignal.timeout(3000),
      );
    },
    revoke() {
      allowed = false;
    },
    failReply() {
      fail = true;
    },
    mutate() {
      fingerprint = "b".repeat(64);
    },
    complete() {
      pending = false;
      nativeSettled = true;
    },
    restart() {
      store.close();
      store = new Store(path);
      bridge = make();
    },
  };
}

test("durable question publication and answer are source-bound and one-shot", async () => {
  const f = await fixture();
  await f.poll();
  await f.poll();
  expect(f.published).toHaveLength(1);
  expect(f.published[0]).toContain("1. Wait");
  expect(f.published[0]).toContain("not a permission approval");
  await Promise.all([f.answer(), f.answer()]);
  await f.answer();
  expect(f.decisions).toEqual([{ q0: "wait" }]);
  expect(f.published[1]).toContain("no tool permission");
  expect(f.store.questionByToken(original.botKey, f.offer().token)?.state).toBe(
    "attempted",
  );
});

for (const mode of [
  "actor",
  "peer",
  "fleet-result",
  "channel",
  "thread",
  "bot-key",
  "token",
  "target",
  "missing-source",
  "revoked",
  "mutated",
  "stopped",
  "invalid-choice",
] as const) {
  test(`question decision rejects ${mode} without native writes`, async () => {
    const f = await fixture(mode !== "missing-source");
    await f.poll();
    if (mode === "missing-source") {
      expect(f.published).toEqual([]);
      return;
    }
    switch (mode) {
      case "actor":
        await f.answer({ user: "another-human" });
        break;
      case "peer":
        await f.answer({ sender: "captain" });
        break;
      case "fleet-result":
        await f.answer({
          fleet: {
            kind: "result",
            originInputID: "msg_original",
            completion: {
              dispatchID: "d",
              sourceReference: "agent-context",
              actor: "peer",
              sessionID: "ses_peer",
              inputID: "msg_peer",
              channel: "#ship",
              outcome: "completed",
              text: "Agent context",
              makers: [],
              humanApproval: false,
            },
          },
        });
        break;
      case "channel":
        await f.answer({ channel: "#other" });
        break;
      case "thread":
        await f.answer({ replyParent: "m9" });
        break;
      case "bot-key":
        await f.answer({ botKey: "other" });
        break;
      case "token":
        await f.answer({}, { token: "0".repeat(32) });
        break;
      case "target":
        await f.answer({}, { target: "other-agent" });
        break;
      case "revoked":
        f.revoke();
        await f.answer();
        break;
      case "mutated":
        f.mutate();
        await f.answer();
        break;
      case "stopped":
        f.store.cancelTurn(
          original.botKey,
          original.conversation,
          original.thread,
        );
        await f.answer();
        break;
      case "invalid-choice":
        await f.answer({}, { answer: "99" });
        break;
    }
    expect(f.decisions).toEqual([]);
  });
}

test("unknown native reply outcome remains consumed across restart, never replayed", async () => {
  const f = await fixture();
  await f.poll();
  const token = f.offer().token;
  f.failReply();
  await f.answer();
  expect(f.decisions).toHaveLength(1);
  expect(f.published.at(-1)).toContain("uncertain");
  f.restart();
  await f.poll();
  await f.answer({}, { token });
  expect(f.decisions).toHaveLength(1);
  expect(f.store.questionByToken(original.botKey, token)?.state).toBe(
    "attempted",
  );
});

test("expired question tokens cannot be answered or silently renewed", async () => {
  const f = await fixture();
  f.store.offerQuestion({
    token: "b".repeat(32),
    botKey: original.botKey,
    formID: "frm_question",
    sessionID: "ses_captain",
    inputID: "msg_original",
    jobID: f.jobID,
    fingerprint: "a".repeat(64),
    expires: Date.now() - 1,
    state: "offered",
    notified: 0,
    recovering: 0,
  });
  await f.poll();
  await f.answer();
  expect(f.decisions).toEqual([]);
  expect(f.published).toEqual([]);
  expect(f.offer().token).toBe("b".repeat(32));
});

test("cancelled transport work cannot submit or consume a question answer", async () => {
  const f = await fixture();
  await f.poll();
  const offer = f.offer();
  await expect(
    f.bridge.answer(
      { ...original, thread: "m2", replyParent: "m1" },
      { target: "captain", token: offer.token, answer: "1" },
      AbortSignal.abort(),
    ),
  ).rejects.toThrow();
  expect(f.decisions).toEqual([]);
  expect(f.store.questionByToken(original.botKey, offer.token)?.state).toBe(
    "offered",
  );
});

test("restart retains only exact verified pending native input, blocks new prompts and releases for catch-up", async () => {
  const f = await fixture();
  await f.poll();
  const token = f.offer().token;
  f.restart();
  const retained = await f.bridge.recover(AbortSignal.timeout(3000));
  expect(retained).toEqual(["msg_original"]);
  f.store.recover(original.botKey, retained);
  expect(f.store.jobStatus(original.botKey, f.jobID)).toBe("running");
  f.store.enqueue({
    ...original,
    eventId: "#ship:m3",
    thread: "m3",
    text: "Intervening human request",
  });
  expect(f.store.ready(original.botKey, Date.now(), 10, true)).toEqual([]);
  await f.poll();
  expect(f.published).toHaveLength(1);
  await f.answer({}, { token });
  await f.poll();
  expect(f.store.jobStatus(original.botKey, f.jobID)).toBe("running");
  f.complete();
  await f.poll();
  expect(f.store.jobStatus(original.botKey, f.jobID)).toBe("done");
  expect(f.settled).toEqual(["ses_captain"]);
  expect(
    f.store.ready(original.botKey, Date.now(), 10, true).map((j) => j.eventId),
  ).toEqual(["#ship:m3"]);
});

test("unowned or changed native pending form never weakens ordinary recovery", async () => {
  const f = await fixture();
  await f.poll();
  f.mutate();
  f.restart();
  const retained = await f.bridge.recover(AbortSignal.timeout(3000));
  expect(retained).toEqual([]);
  f.store.recover(original.botKey, retained);
  expect(f.store.jobStatus(original.botKey, f.jobID)).toBe("responding");
});

test("actual gateway restart preserves a verified native question without prompting, then catches up to its original IRC thread", async () => {
  const f = await fixture();
  await f.poll();
  f.restart();
  let interrupts = 0;
  let prompts = 0;
  f.backend.createSession = async () => "ses_captain";
  f.backend.interruptInput = async () => {
    interrupts++;
  };
  f.backend.prompt = async () => {
    prompts++;
    throw new Error("No prompt replay");
  };
  f.store.baselineCaptain(original.botKey, "ses_captain", "msg_baseline");
  f.backend.transcript = async () => ({
    cursor: "msg_answer",
    input: "msg_original",
    entries: [
      {
        id: "msg_answer",
        input: "msg_original",
        text: "Native continuation",
        created: 100,
      },
    ],
  });
  const { slack: _slack, ...config } = bot();
  const posts: { channel: string; thread: string; text: string }[] = [];
  const gateway = new Gateway(
    config,
    identity,
    f.store,
    f.backend,
    {
      async post(channel, thread, text) {
        posts.push({ channel, thread, text });
      },
    },
    pino({ level: "silent" }),
    undefined,
    undefined,
    {
      name: "irc",
      key: original.botKey,
      allowed: () => true,
      source: (job) => ({
        transport: "irc",
        authority: "human",
        channel: job.channel,
        thread: job.thread,
        message: job.thread,
        user: job.user,
      }),
      note: () => undefined,
      questions: {
        account: "captain",
        human: (user) => user === "jac",
        async publish(_job, text, allowed) {
          if (allowed()) f.published.push(text);
        },
      },
    },
  );
  const stop = new AbortController();
  const worker = gateway.work(stop.signal);
  try {
    await until(
      () => f.store.questionOffers(original.botKey)[0]?.recovering === 1,
      2000,
      "persisted form recovery active",
    );
    expect(interrupts).toBe(0);
    expect(prompts).toBe(0);
    expect(f.store.jobStatus(original.botKey, f.jobID)).toBe("running");
    await gateway.answerQuestion(
      { ...original, eventId: "#ship:m2", thread: "m2", replyParent: "m1" },
      { target: "captain", token: f.offer().token, answer: "1" },
    );
    f.complete();
    await until(
      () => posts.some((p) => p.text.includes("Native continuation")),
      4000,
      "recovered native result caught up",
    );
    expect(
      posts.find((p) => p.text.includes("Native continuation")),
    ).toMatchObject({ channel: "#ship", thread: "m1" });
    expect(prompts).toBe(0);
    expect(interrupts).toBe(0);
  } finally {
    stop.abort();
    await worker;
  }
}, 10_000);

test("question parser and render never select defaults or accept hidden/auth/external forms", () => {
  const q = question();
  const free = nativeQuestionSchema.parse({
    ...q,
    fields: [{ key: "q0", type: "string", options: [], custom: true }],
  });
  expect(questionAnswer(free, "A genuine free-form answer")).toEqual({
    q0: "A genuine free-form answer",
  });
  expect(questionAnswer(q, "2")).toEqual({ q0: "continue" });
  expect(() => questionAnswer(q, "{}")).toThrow();
  expect(() =>
    questionAnswer(q, '{"q0":"wait","foreign":"continue"}'),
  ).toThrow();
  const many = nativeQuestionSchema.parse({
    ...q,
    fields: [{ ...q.fields[0], type: "multiselect", minItems: 1, maxItems: 2 }],
  });
  expect(questionAnswer(many, "1,2")).toEqual({ q0: ["wait", "continue"] });
  expect(() => questionAnswer(many, "1,1")).toThrow();
  for (const extra of [
    { hidden: true },
    { default: "continue" },
    { type: "external", url: "https://example.test/auth" },
    { when: [{ key: "q1", op: "eq", value: true }] },
  ])
    expect(
      nativeQuestionSchema.safeParse({
        ...q,
        fields: [{ ...q.fields[0], ...extra }],
      }).success,
    ).toBe(false);
  expect(questionText(q, "captain", "a".repeat(32))).not.toContain("default");
  expect(questionControl(`other: answer ${"a".repeat(32)} 1`)?.target).toBe(
    "other",
  );
  expect(questionControl("other: answer malformed")).toBeDefined();
  expect(questionControl("ordinary human request")).toBeUndefined();
});
