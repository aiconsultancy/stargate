import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
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
  let filtered = false;
  let unsupported = false;
  let publishFail = false;
  let noticeGate:
    | {
        entered: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  let abortReply: AbortController | undefined;
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
      return pending && !filtered
        ? [
            unsupported
              ? {
                  id: question().id,
                  sessionID: question().sessionID,
                  inputID: question().inputID,
                  toolMessageID: question().toolMessageID,
                  toolCallID: question().toolCallID,
                  fingerprint,
                  unsupported: true as const,
                }
              : { ...question(), fingerprint },
          ]
        : [];
    },
    async questionState() {
      return pending ? "pending" : "resolved";
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
      abortReply?.abort();
      if (fail || abortReply) throw new Error("Do not expose provider details");
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
          if (publishFail) throw new Error("IRC unavailable");
          if (
            noticeGate &&
            (text.includes("decision recorded") ||
              text.includes("outcome is uncertain"))
          ) {
            noticeGate.entered.resolve();
            await noticeGate.release.promise;
            if (!guard()) throw new Error("Denied after wait");
          }
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
    path,
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
    filter(value: boolean) {
      filtered = value;
    },
    unsupported() {
      unsupported = true;
    },
    pauseNotice() {
      noticeGate = {
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      return noticeGate;
    },
    failPublish(value: boolean) {
      publishFail = value;
    },
    abortReply(controller: AbortController) {
      abortReply = controller;
    },
    failReply() {
      fail = true;
    },
    mutate() {
      fingerprint = "b".repeat(64);
    },
    resolveForm() {
      pending = false;
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

test("a filtered native list never closes a still-live offer or loses its restored answer", async () => {
  const f = await fixture();
  await f.poll();
  const token = f.offer().token;
  f.filter(true);
  await f.poll();
  expect(f.store.questionByToken(original.botKey, token)?.state).toBe(
    "offered",
  );
  f.filter(false);
  await f.poll();
  await f.answer({}, { token });
  expect(f.decisions).toEqual([{ q0: "wait" }]);
});

test("unsupported owned forms give a content-free operator notice without an answer token", async () => {
  const f = await fixture();
  f.unsupported();
  await f.poll();
  await f.poll();
  expect(f.published).toHaveLength(1);
  expect(f.published[0]).toContain("native operator interface");
  expect(f.published[0]).not.toContain("Wait or continue");
  expect(f.published[0]).not.toContain(f.offer().token);
  await f.answer();
  expect(f.decisions).toEqual([]);
});

test("native success survives a failed confirmation and retries only its notice after restart", async () => {
  const f = await fixture();
  await f.poll();
  const token = f.offer().token;
  f.failPublish(true);
  await f.answer();
  expect(f.decisions).toHaveLength(1);
  expect(f.store.questionByToken(original.botKey, token)?.outcome).toBe(
    "answered",
  );
  f.restart();
  f.failPublish(false);
  await f.poll();
  await f.poll();
  expect(f.published).toHaveLength(2);
  expect(f.published[1]).toContain("decision recorded");
  expect(f.published.join("\n")).not.toContain("uncertain");
  expect(f.decisions).toHaveLength(1);
});

test("a timed-out native reply still notifies uncertainty once, without replay", async () => {
  const f = await fixture();
  await f.poll();
  const operation = new AbortController();
  f.abortReply(operation);
  await f.bridge.answer(
    { ...original, replyParent: "m1" },
    { target: "captain", token: f.offer().token, answer: "1" },
    operation.signal,
  );
  expect(operation.signal.aborted).toBe(true);
  expect(f.published.at(-1)).toContain("uncertain");
  await f.poll();
  expect(f.decisions).toHaveLength(1);
  expect(f.published.filter((s) => s.includes("uncertain"))).toHaveLength(1);
});

test("an unavailable first session cannot starve another native question", async () => {
  const f = await fixture();
  const earlier = {
    ...original,
    eventId: "#ship:earlier",
    conversation: "earlier",
    thread: "earlier",
  };
  f.store.enqueue(earlier);
  const job = f.store.queuedJob(original.botKey, earlier.eventId);
  if (!job) throw new Error("Missing earlier job");
  f.store.running(job.id);
  f.store.saveInput(original.botKey, job.id, "msg_earlier", "aaa_broken");
  f.store.saveSession(earlier.conversation, "aaa_broken");
  f.store.recordQuestionSource(earlier);
  const pending = f.backend.pendingQuestions;
  f.backend.pendingQuestions = async (session, signal) => {
    if (session === "aaa_broken") throw new Error("Native session unavailable");
    return (await pending?.(session, signal)) ?? [];
  };
  await expect(f.poll()).rejects.toThrow("session unavailable");
  expect(f.published).toHaveLength(1);
  await f.answer();
  expect(f.decisions).toHaveLength(1);
});

test("an unused configured pin is not polled without an admitted source/job", async () => {
  const f = await fixture(false);
  let checks = 0;
  f.backend.pendingQuestions = async () => {
    checks++;
    return [];
  };
  await f.poll();
  expect(checks).toBe(0);
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

test("expired offers renew only at their original human request after restart", async () => {
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
  f.restart();
  expect(await f.bridge.recover(AbortSignal.timeout(3000))).toEqual([
    "msg_original",
  ]);
  await f.poll();
  expect(f.offer().token).toBe("b".repeat(32));
  expect(f.published).toEqual([]);
  await f.answer(
    { user: "other-human" },
    { renew: true, token: "b".repeat(32) },
  );
  await f.answer(
    { replyParent: "foreign" },
    { renew: true, token: "b".repeat(32) },
  );
  expect(f.published).toEqual([]);
  await f.answer({}, { renew: true, token: "b".repeat(32) });
  const fresh = f.offer();
  expect(fresh.token).not.toBe("b".repeat(32));
  expect(f.published[0]).toContain("Previous clarification token expired");
  await f.answer({}, { token: "b".repeat(32) });
  expect(f.decisions).toEqual([]);
  await f.answer();
  expect(f.decisions).toEqual([{ q0: "wait" }]);
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

for (const postForm of [false, true]) {
  test(`actual gateway restart preserves ${postForm ? "post-form busy input" : "pending question"} without prompting, then catches up to its original IRC thread`, async () => {
    const f = await fixture();
    await f.poll();
    if (postForm) {
      f.restart();
      await f.bridge.recover(AbortSignal.timeout(3000));
      f.resolveForm();
    }
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
        () =>
          postForm
            ? f.store.questionOffers(original.botKey)[0]?.state === "closed"
            : f.store.questionOffers(original.botKey)[0]?.recovering === 1,
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
      if (postForm) expect(f.decisions).toEqual([]);
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
}

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
  expect(questionControl("other: answer malformed")).toBeUndefined();
  expect(questionControl(`other: ANSWER ${"A".repeat(32)} 1`)?.token).toBe(
    "a".repeat(32),
  );
  expect(questionControl("ordinary human request")).toBeUndefined();
});

test("retention removes settled historical proofs together but preserves active uncertain work and anchors", async () => {
  const f = await fixture();
  await f.poll();
  const token = f.offer().token;
  expect(
    f.store.ircPublished(
      original.botKey,
      "#ship",
      "published-question",
      "m1",
      "m1",
    ),
  ).toBe(true);
  f.failReply();
  await f.answer();
  const future = Date.now() + 31 * 86_400_000;
  f.store.pruneIrcHistory(original.botKey, future);
  expect(f.store.questionByToken(original.botKey, token)?.outcome).toBe(
    "uncertain",
  );
  expect(
    f.store.ircThreadRoot(original.botKey, "#ship", "published-question"),
  ).toBe("m1");
  f.store.respond(f.jobID, []);
  f.store.finish(f.jobID);
  f.store.pruneIrcHistory(original.botKey, future + 3_600_001);
  expect(f.store.questionByToken(original.botKey, token)).toBeUndefined();
  expect(
    f.store.ircThreadRoot(original.botKey, "#ship", "published-question"),
  ).toBeUndefined();
  expect(f.store.ircThreadParticipating(original.botKey, "#ship", "m1")).toBe(
    false,
  );
  const job = f.store.jobByInput(original.botKey, "msg_original");
  if (!job) throw new Error("Missing job");
  expect(f.store.ownsQuestionSource(job)).toBe(false);
  f.restart();
  await f.poll();
  expect(f.decisions).toHaveLength(1);
});

test("a session consuming the poll deadline rotates behind other sessions next time", async () => {
  const f = await fixture();
  const earlier = {
    ...original,
    eventId: "#ship:hang",
    conversation: "hang",
    thread: "hang",
  };
  f.store.enqueue(earlier);
  const job = f.store.queuedJob(original.botKey, earlier.eventId);
  if (!job) throw new Error("No hanging job");
  f.store.running(job.id);
  f.store.saveInput(original.botKey, job.id, "msg_hang", "aaa_hang");
  f.store.saveSession(earlier.conversation, "aaa_hang");
  f.store.recordQuestionSource(earlier);
  const pending = f.backend.pendingQuestions;
  f.backend.pendingQuestions = async (session, signal) => {
    if (session !== "aaa_hang") return (await pending?.(session, signal)) ?? [];
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
    return [];
  };
  await expect(f.bridge.poll(AbortSignal.timeout(100))).rejects.toThrow();
  expect(f.published).toEqual([]);
  await expect(f.bridge.poll(AbortSignal.timeout(100))).rejects.toThrow();
  expect(f.published).toHaveLength(1);
});

for (const outcome of ["success", "timeout"] as const) {
  test(`resolved form cannot close an in-flight native reply before its ${outcome} is recorded`, async () => {
    const f = await fixture();
    await f.poll();
    const token = f.offer().token;
    f.restart();
    expect(await f.bridge.recover(AbortSignal.timeout(3000))).toEqual([
      "msg_original",
    ]);
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<void>();
    const native = f.backend.replyQuestion;
    if (!native) throw new Error("No native question API");
    f.backend.replyQuestion = async (question, answer, signal) => {
      await native(question, answer, signal);
      entered.resolve();
      await response.promise;
      signal.throwIfAborted();
    };
    const operation = new AbortController();
    const answer = f.bridge.answer(
      { ...original, replyParent: "m1" },
      { target: "captain", token, answer: "1" },
      operation.signal,
    );
    await entered.promise;
    f.complete();
    await f.poll();
    const during = f.store.questionByToken(original.botKey, token);
    expect(during?.state).toBe("attempted");
    expect(during?.outcome).toBeNull();
    expect(f.store.jobStatus(original.botKey, f.jobID)).toBe("running");
    expect(f.published).toHaveLength(1);
    if (outcome === "timeout") operation.abort();
    response.resolve();
    await answer;
    const completed = f.store.questionByToken(original.botKey, token);
    expect(completed?.outcome).toBe(
      outcome === "success" ? "answered" : "uncertain",
    );
    expect(f.published[1]).toContain(
      outcome === "success" ? "decision recorded" : "uncertain",
    );
    await f.poll();
    await f.answer({}, { token });
    expect(f.store.jobStatus(original.botKey, f.jobID)).toBe("done");
    expect(f.decisions).toEqual([{ q0: "wait" }]);
    expect(f.published).toHaveLength(2);
  });
}

for (const failure of [false, true]) {
  test(`poll cannot duplicate a pending ${failure ? "uncertain" : "successful"} outcome notification`, async () => {
    const f = await fixture();
    await f.poll();
    if (failure) f.failReply();
    const gate = f.pauseNotice();
    const answer = f.answer();
    await gate.entered.promise;
    await f.poll();
    expect(f.published).toHaveLength(1);
    gate.release.resolve();
    await answer;
    await f.poll();
    expect(f.published).toHaveLength(2);
    expect(f.decisions).toHaveLength(1);
  });
}

test("cancelled-owner notices retire without native re-querying or lost attempt outcome", async () => {
  const f = await fixture();
  await f.poll();
  f.failReply();
  f.failPublish(true);
  await f.answer();
  const token = f.offer().token;
  f.store.cancelTurn(original.botKey, original.conversation, original.thread);
  let checks = 0;
  f.backend.pendingQuestions = async () => {
    checks++;
    return [];
  };
  await f.poll();
  await f.poll();
  expect(checks).toBe(0);
  expect(f.store.questionOffers(original.botKey)).toEqual([]);
  expect(f.store.questionByToken(original.botKey, token)?.outcome).toBe(
    "uncertain",
  );
  expect(f.decisions).toHaveLength(1);
});

test("deleted native sessions release only recovered holds as interrupted, never successful", async () => {
  const f = await fixture();
  await f.poll();
  f.restart();
  await f.bridge.recover(AbortSignal.timeout(3000));
  f.backend.pendingQuestions = async () => [];
  f.backend.questionState = async () => "missing-session";
  await f.poll();
  expect(f.store.jobStatus(original.botKey, f.jobID)).toBe("responding");
  expect(f.store.jobByInput(original.botKey, "msg_original")?.failure).toBe(
    "interrupted",
  );
  expect(f.settled).toEqual([]);
  expect(f.decisions).toEqual([]);
});

test("unavailable native sessions back off without starving healthy ones", async () => {
  const f = await fixture();
  let reads = 0;
  f.backend.pendingQuestions = async () => {
    reads++;
    throw new Error("private server error");
  };
  await expect(f.poll()).rejects.toThrow("session unavailable");
  await f.poll();
  await f.poll();
  expect(reads).toBe(1);
});

test("complete question-state capability is required before gateway activates questions", async () => {
  const f = await fixture();
  delete f.backend.questionState;
  const { slack: _slack, ...config } = bot();
  const gateway = new Gateway(
    config,
    identity,
    f.store,
    f.backend,
    { async post() {} },
    pino({ level: "silent" }),
    undefined,
    undefined,
    {
      name: "irc",
      key: original.botKey,
      allowed: () => true,
      source: (job) => ({
        transport: "irc",
        channel: job.channel,
        thread: job.thread,
        message: job.thread,
        user: job.user,
      }),
      note: () => undefined,
      questions: {
        account: "captain",
        human: () => true,
        async publish() {
          throw new Error("Incomplete capability activated");
        },
      },
    },
  );
  await gateway.pollQuestions(AbortSignal.timeout(3000));
  expect(f.store.questionOffers(original.botKey)).toEqual([]);
});

test("retention is indexed and batch-bounded, and never runs on human intake", async () => {
  const f = await fixture();
  const db = new Database(f.path);
  try {
    const old = Date.now() - 31 * 86_400_000;
    db.transaction(() => {
      for (let i = 0; i < 300; i++)
        db.query(
          "INSERT INTO irc_thread_messages(botKey,channel,msgid,root,recorded) VALUES(?,'#ship',?,?,?)",
        ).run(original.botKey, `old${i}`, `root${i}`, old);
    })();
    const count = () =>
      db
        .query<{ n: number }, [number]>(
          "SELECT count(*) AS n FROM irc_thread_messages WHERE recorded=?",
        )
        .get(old)?.n;
    f.store.enqueueIrcHuman(
      { ...original, eventId: "#ship:new", thread: "new" },
      true,
    );
    expect(count()).toBe(300);
    f.store.pruneIrcHistory(original.botKey, Date.now());
    expect(count()).toBe(44);
    f.store.pruneIrcHistory(original.botKey, Date.now());
    expect(count()).toBe(0);
    const plan = db
      .query<{ detail: string }, [string, string, string]>(
        "EXPLAIN QUERY PLAN SELECT 1 FROM jobs WHERE botKey=? AND channel=? AND CAST(COALESCE(replyParent,thread) AS TEXT)=? AND status NOT IN ('done','failed')",
      )
      .all(original.botKey, "#ship", "root");
    expect(plan.some((row) => row.detail.includes("jobs_irc_root"))).toBe(true);
  } finally {
    db.close();
  }
});

test("cancelled recovered waiter preserves unknown native work until real settlement", async () => {
  const f = await fixture();
  await f.poll();
  f.restart();
  await f.bridge.recover(AbortSignal.timeout(3000));
  const token = f.offer().token;
  f.store.cancelTurn(original.botKey, original.conversation, original.thread);
  await f.poll();
  expect(f.store.jobStatus(original.botKey, f.jobID)).toBe("running");
  expect(f.store.questionByToken(original.botKey, token)?.recovering).toBe(1);
  expect(f.decisions).toEqual([]);
  f.complete();
  await f.poll();
  expect(f.store.jobStatus(original.botKey, f.jobID)).toBe("responding");
  expect(f.store.jobByInput(original.botKey, "msg_original")?.failure).toBe(
    "cancelled",
  );
  expect(f.decisions).toEqual([]);
});

for (const mode of ["in-flight", "read-error"] as const) {
  test(`missing-session caching waits for every offer after ${mode} interleaving`, async () => {
    const f = await fixture();
    const first = question();
    const second = {
      ...question(),
      id: "frm_second",
      toolCallID: "call_second",
    };
    let missing = false;
    f.backend.pendingQuestions = async () => (missing ? [] : [first, second]);
    f.backend.questionBelongsToInput = async (_s, form, input, hash) =>
      !missing &&
      [first.id, second.id].includes(form) &&
      input === first.inputID &&
      hash === first.fingerprint;
    await f.poll();
    f.restart();
    await f.bridge.recover(AbortSignal.timeout(3000));
    const secondOffer = f.store
      .questionOffers(original.botKey)
      .find((o) => o.formID === second.id);
    if (!secondOffer) throw new Error("Missing second offer");
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<void>();
    let error = true;
    f.backend.questionState = async (_s, form) => {
      if (mode === "read-error" && form === second.id && error)
        throw new Error("Read unavailable");
      return "missing-session";
    };
    f.backend.replyQuestion = async (_q, answer) => {
      f.decisions.push(answer);
      entered.resolve();
      await response.promise;
    };
    const decision =
      mode === "in-flight"
        ? f.answer({}, { token: secondOffer.token })
        : undefined;
    if (decision !== undefined) await entered.promise;
    missing = true;
    if (mode === "read-error")
      await expect(f.poll()).rejects.toThrow("session unavailable");
    else await f.poll();
    expect(
      f.store.questionByToken(original.botKey, secondOffer.token)?.recovering,
    ).toBe(1);
    if (decision !== undefined) {
      response.resolve();
      await decision;
    }
    error = false;
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    try {
      await f.poll();
    } finally {
      clock.mockRestore();
    }
    expect(
      f.store.questionByToken(original.botKey, secondOffer.token)?.recovering,
    ).toBe(0);
    expect(f.store.questionOffers(original.botKey)).toEqual([]);
    expect(f.decisions).toHaveLength(mode === "in-flight" ? 1 : 0);
  });
}

test("established cancelled native waiter survives another actual gateway restart without granting replies or replaying Stop", async () => {
  const f = await fixture();
  await f.poll();
  f.restart();
  await f.bridge.recover(AbortSignal.timeout(3000));
  f.store.cancelTurn(original.botKey, original.conversation, original.thread);
  f.restart();
  let interrupts = 0;
  let prompts = 0;
  let polls = 0;
  const pending = f.backend.pendingQuestions;
  f.backend.pendingQuestions = async (...args) => {
    polls++;
    return (await pending?.(...args)) ?? [];
  };
  f.backend.createSession = async () => "ses_captain";
  f.backend.interruptInput = async () => {
    interrupts++;
  };
  f.backend.prompt = async () => {
    prompts++;
    throw new Error("No prompt replay");
  };
  const { slack: _slack, ...config } = bot();
  const posts: string[] = [];
  const gateway = new Gateway(
    config,
    identity,
    f.store,
    f.backend,
    {
      async post(_channel, _thread, text) {
        posts.push(text);
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
      () => polls > 0,
      3000,
      "restarted gateway recovered before poll",
    );
    expect(interrupts).toBe(0);
    expect(prompts).toBe(0);
    expect(f.store.jobStatus(original.botKey, f.jobID)).toBe("running");
    await gateway.answerQuestion(
      { ...original, replyParent: "m1" },
      { target: "captain", token: f.offer().token, answer: "1" },
    );
    expect(f.decisions).toEqual([]);
    expect(f.published).toHaveLength(1);
    f.complete();
    await until(
      () => f.store.jobStatus(original.botKey, f.jobID) === "done",
      4000,
      "cancelled waiter settled without native replay",
    );
    expect(f.store.jobByInput(original.botKey, "msg_original")?.failure).toBe(
      "cancelled",
    );
    expect(posts.join("\n")).toContain("stop request");
    expect(interrupts).toBe(0);
    expect(prompts).toBe(0);
    expect(f.decisions).toEqual([]);
  } finally {
    stop.abort();
    await worker;
  }
}, 10_000);

for (const mode of ["not-established", "changed-session"] as const) {
  test(`cancelled recovery exception rejects ${mode} waiter`, async () => {
    const f = await fixture();
    await f.poll();
    if (mode === "changed-session") {
      f.restart();
      await f.bridge.recover(AbortSignal.timeout(3000));
      Object.defineProperty(f.backend, "sessionID", { value: "ses_different" });
    }
    f.store.cancelTurn(original.botKey, original.conversation, original.thread);
    f.restart();
    expect(await f.bridge.recover(AbortSignal.timeout(3000))).toEqual([]);
    expect(f.decisions).toEqual([]);
  });
}

for (const cancelled of [false, true]) {
  for (const phase of [
    "resolved-before-poll",
    "closed-busy",
    "settlement-read-error",
  ] as const) {
    test(`established ${cancelled ? "cancelled" : "normal"} hold survives ${phase} restart until native input settles`, async () => {
      const f = await fixture();
      await f.poll();
      f.restart();
      await f.bridge.recover(AbortSignal.timeout(3000));
      if (cancelled)
        f.store.cancelTurn(
          original.botKey,
          original.conversation,
          original.thread,
        );
      f.resolveForm();
      const settled = f.backend.questionInputSettled;
      if (!settled) throw new Error("Missing native settlement API");
      if (phase === "settlement-read-error")
        f.backend.questionInputSettled = async () => {
          throw new Error("Native read unavailable");
        };
      if (phase !== "resolved-before-poll") {
        if (phase === "settlement-read-error")
          await expect(f.poll()).rejects.toThrow("session unavailable");
        else await f.poll();
        expect(f.store.questionOffers(original.botKey)[0]?.state).toBe(
          "closed",
        );
      }
      f.restart();
      const retained = await f.bridge.recover(AbortSignal.timeout(3000));
      expect(retained).toEqual(["msg_original"]);
      f.store.recover(original.botKey, retained);
      expect(f.store.jobStatus(original.botKey, f.jobID)).toBe("running");
      expect(f.published).toHaveLength(1);
      await f.answer();
      expect(f.decisions).toEqual([]);
      f.backend.questionInputSettled = settled;
      f.complete();
      await f.poll();
      expect(f.store.questionOffers(original.botKey)).toEqual([]);
      expect(f.store.jobStatus(original.botKey, f.jobID)).toBe(
        cancelled ? "responding" : "done",
      );
      expect(
        f.store.jobByInput(original.botKey, "msg_original")?.failure ?? null,
      ).toBe(cancelled ? "cancelled" : null);
      expect(f.decisions).toEqual([]);
    });
  }
}

for (const failure of ["read-error", "timeout"] as const) {
  test(`gateway startup never discards established holds after another offer's ${failure}`, async () => {
    const f = await fixture();
    await f.poll();
    f.restart();
    await f.bridge.recover(AbortSignal.timeout(3000));
    const established = f.offer();
    f.store.offerQuestion({
      ...established,
      token: "d".repeat(32),
      formID: "frm_unestablished",
      recovering: 0,
    });
    f.restart();
    let reads = 0;
    let interrupts = 0;
    let prompts = 0;
    f.backend.questionBelongsToInput = async (
      _session,
      form,
      _input,
      _fingerprint,
      signal,
    ) => {
      reads++;
      if (form !== "frm_unestablished")
        throw new Error(
          "Established hold must not depend on another pending-form read",
        );
      if (failure === "timeout") {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(25)]);
        await new Promise<void>((_resolve, reject) =>
          deadline.addEventListener("abort", () => reject(deadline.reason), {
            once: true,
          }),
        );
      }
      throw new Error("Native metadata unavailable");
    };
    f.backend.createSession = async () => "ses_captain";
    f.backend.interruptInput = async () => {
      interrupts++;
    };
    f.backend.interrupt = async () => {
      interrupts++;
    };
    f.backend.prompt = async () => {
      prompts++;
      throw new Error("No model prompt");
    };
    const { slack: _slack, ...config } = bot();
    const gateway = new Gateway(
      config,
      identity,
      f.store,
      f.backend,
      { async post() {} },
      pino({ level: "silent" }),
      undefined,
      undefined,
      {
        name: "irc",
        key: original.botKey,
        allowed: () => true,
        source: (job) => ({
          transport: "irc",
          channel: job.channel,
          thread: job.thread,
          message: job.thread,
          user: job.user,
        }),
        note: () => undefined,
        questions: {
          account: "captain",
          human: (user) => user === "jac",
          async publish() {
            throw new Error("No recovery notice or native reply");
          },
        },
      },
    );
    const stop = new AbortController();
    try {
      await expect(gateway.work(stop.signal)).rejects.toThrow(
        "Native clarification recovery unavailable",
      );
      expect(reads).toBe(1);
      expect(interrupts).toBe(0);
      expect(prompts).toBe(0);
      expect(f.store.jobStatus(original.botKey, f.jobID)).toBe("running");
      expect(
        f.store.questionByToken(original.botKey, established.token)?.recovering,
      ).toBe(1);
      expect(
        f.store.questionByToken(original.botKey, "d".repeat(32))?.recovering,
      ).toBe(0);
      expect(f.decisions).toEqual([]);
    } finally {
      stop.abort();
    }
  });
}
