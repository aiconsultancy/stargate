import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, Schema } from "effect";
import pino from "pino";
import type { AgentBackend } from "../src/backends/backend";
import { ircSchema } from "../src/config";
import { Gateway } from "../src/gateway/gateway";
import { parseMessage } from "../src/irc/protocol";
import { routeIrcMessage } from "../src/irc/routing";
import { IrcShip } from "../src/irc/ship";
import {
  type NativeQuestion,
  nativeQuestionSchema,
  Questions,
  questionAnswer,
  questionControl,
  questionText,
} from "../src/questions/questions";
import { openStore } from "../src/app/open-store";
import { type Incoming } from "../src/gateway/store";
import { bot, identity } from "./fixtures";
import { FakeIrcServer, until } from "./irc-fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const question = (): NativeQuestion =>
  Schema.decodeUnknownSync(nativeQuestionSchema)({
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

async function fixture(
  source = true,
  settings?: {
    enabled: boolean;
    timeoutMs: number;
    answer: "requester" | "allowed";
  },
) {
  const dir = await mkdtemp(join(tmpdir(), "stargate-questions-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  let store = openStore(path);
  cleanup.push(() => store.close());
  store.enqueue(original);
  const job = store.queuedJob(original.botKey, original.eventId);
  if (!job) throw new Error("Missing job");
  store.running(job.id);
  store.started(job.id);
  store.captainCursor(original.botKey, "ses_captain");
  store.baselineCaptain(original.botKey, "ses_captain", "msg_baseline");
  store.saveInput(original.botKey, job.id, "msg_original", "ses_captain");
  if (source) store.questions.recordQuestionSource(original);
  const published: string[] = [];
  const publicationAttempts: string[] = [];
  const decisions: unknown[] = [];
  const settled: string[] = [];
  let pending = true;
  let allowed = true;
  let connected = true;
  let fail = false;
  let nativeSettled = false;
  let filtered = false;
  let unsupported = false;
  let publishFail = false;
  let offerGate:
    | {
        entered: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
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
        ...(settings
          ? {
              settings: async () => settings,
              answerAllowed: async (user: string) => user === "allowed",
            }
          : {}),
        authorized: () => allowed,
        ready: () => connected,
        human: (user) => user === "jac" || user === "allowed",
        async publish(_job, text, guard) {
          if (!guard()) throw new Error("Denied");
          publicationAttempts.push(text);
          if (publishFail) throw new Error("IRC unavailable");
          if (offerGate && text.includes("OpenCode needs clarification")) {
            offerGate.entered.resolve();
            await offerGate.release.promise;
            if (!guard()) throw new Error("Denied offer after wait");
          }
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
      () => allowed && connected,
      (s) => settled.push(s),
    );
  let bridge = make();
  return {
    backend,
    published,
    publicationAttempts,
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
      const offer = store.questions.questionOffers(original.botKey)[0];
      if (!offer) throw new Error("Missing offer");
      return offer;
    },
    async answer(
      changes: Partial<Incoming> = {},
      overrides: Partial<NonNullable<ReturnType<typeof questionControl>>> = {},
    ) {
      const token =
        store.questions.questionOffers(original.botKey)[0]?.token ??
        "0".repeat(32);
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
    disconnect() {
      connected = false;
    },
    reconnect() {
      connected = true;
    },
    filter(value: boolean) {
      filtered = value;
    },
    unsupported() {
      unsupported = true;
    },
    pauseOffer() {
      offerGate = {
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      return offerGate;
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
      store = openStore(path);
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
  expect(
    f.store.questions.questionByToken(original.botKey, f.offer().token)?.state,
  ).toBe("attempted");
});

test("a filtered native list never closes a still-live offer or loses its restored answer", async () => {
  const f = await fixture();
  await f.poll();
  const token = f.offer().token;
  f.filter(true);
  await f.poll();
  expect(f.store.questions.questionByToken(original.botKey, token)?.state).toBe(
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
  expect(
    f.store.questions.questionByToken(original.botKey, token)?.outcome,
  ).toBe("answered");
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
  f.store.questions.recordQuestionSource(earlier);
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
  expect(f.store.questions.questionByToken(original.botKey, token)?.state).toBe(
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
    notified: 1,
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

test("an unseen offer starts its reply window at first publication after a long disconnect and restart", async () => {
  const f = await fixture();
  f.disconnect();
  await f.poll();
  const unseen = f.offer();
  const clock = spyOn(Date, "now").mockReturnValue(unseen.expires + 60_000);
  try {
    f.restart();
    expect(await f.bridge.recover(AbortSignal.timeout(3000))).toEqual([
      "msg_original",
    ]);
    await f.poll();
    expect(f.published).toEqual([]);
    f.reconnect();
    await f.poll();
    const seen = f.offer();
    expect(seen.token).toBe(unseen.token);
    expect(seen.publicationStarted).toBe(Date.now());
    expect(seen.expires).toBe(Date.now() + 1_800_000);
    expect(f.published).toHaveLength(1);
    await f.answer();
    expect(f.decisions).toEqual([{ q0: "wait" }]);
  } finally {
    clock.mockRestore();
  }
});

test("a lost first-publication ACK cannot reset the seen token's expiry after restart", async () => {
  const f = await fixture();
  f.failPublish(true);
  await expect(f.poll()).rejects.toThrow("session unavailable");
  const attempted = f.offer();
  expect(attempted.publicationStarted).toBeGreaterThan(0);
  const clock = spyOn(Date, "now").mockReturnValue(attempted.expires + 1);
  try {
    f.restart();
    f.failPublish(false);
    await f.poll();
    expect(f.offer().expires).toBe(attempted.expires);
    expect(f.published).toEqual([]);
    await f.answer();
    expect(f.decisions).toEqual([]);
    await f.answer({}, { renew: true });
    expect(f.offer().token).not.toBe(attempted.token);
    expect(f.published).toHaveLength(1);
  } finally {
    clock.mockRestore();
  }
});

test("upgrading legacy offers preserves possibly-seen token expiry", async () => {
  const f = await fixture();
  f.failPublish(true);
  await expect(f.poll()).rejects.toThrow("session unavailable");
  const attempted = f.offer();
  const raw = new Database(f.path);
  try {
    raw.exec("ALTER TABLE native_questions DROP COLUMN publicationStarted");
  } finally {
    raw.close();
  }
  const clock = spyOn(Date, "now").mockReturnValue(attempted.expires + 1);
  try {
    f.restart();
    f.failPublish(false);
    await f.poll();
    expect(f.offer().publicationStarted).toBe(1);
    expect(f.offer().expires).toBe(attempted.expires);
    expect(f.published).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});

test("explicit renewal held by connection readiness cannot expire the new token unseen", async () => {
  const f = await fixture();
  await f.poll();
  const originalOffer = f.offer();
  const clock = spyOn(Date, "now").mockReturnValue(originalOffer.expires + 1);
  try {
    f.disconnect();
    await f.answer({}, { renew: true });
    const renewed = f.offer();
    expect(renewed.token).not.toBe(originalOffer.token);
    expect(renewed.publicationStarted).toBe(0);
    clock.mockReturnValue(renewed.expires + 1);
    f.restart();
    f.reconnect();
    await f.poll();
    expect(f.published).toHaveLength(2);
    expect(f.offer().expires).toBe(Date.now() + 1_800_000);
    await f.answer({}, { token: originalOffer.token });
    expect(f.decisions).toEqual([]);
    await f.answer();
    expect(f.decisions).toEqual([{ q0: "wait" }]);
  } finally {
    clock.mockRestore();
  }
});

test("lost outcome ACKs back off delivery without retrying the native answer", async () => {
  const f = await fixture();
  await f.poll();
  f.failPublish(true);
  await f.answer();
  expect(f.publicationAttempts).toHaveLength(2);
  for (let i = 0; i < 5; i++) await f.poll();
  expect(f.publicationAttempts).toHaveLength(2);
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 2001);
  try {
    await f.poll();
    expect(f.publicationAttempts).toHaveLength(3);
    clock.mockReturnValue(Date.now() + 2001);
    await f.poll();
    expect(f.publicationAttempts).toHaveLength(3);
    f.failPublish(false);
    clock.mockReturnValue(Date.now() + 2001);
    await f.poll();
    expect(f.publicationAttempts).toHaveLength(4);
    expect(f.published.at(-1)).toContain("decision recorded");
    expect(f.decisions).toHaveLength(1);
  } finally {
    clock.mockRestore();
  }
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
  expect(
    f.store.questions.questionByToken(original.botKey, offer.token)?.state,
  ).toBe("offered");
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
          human: (user) => user === "jac" || user === "allowed",
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
            ? f.store.questions.questionOffers(original.botKey)[0]?.state ===
              "closed"
            : f.store.questions.questionOffers(original.botKey)[0]
                ?.recovering === 1,
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
  const free = Schema.decodeUnknownSync(nativeQuestionSchema)({
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
  const many = Schema.decodeUnknownSync(nativeQuestionSchema)({
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
      Result.isSuccess(
        Schema.decodeUnknownResult(nativeQuestionSchema)({
          ...q,
          fields: [{ ...q.fields[0], ...extra }],
        }),
      ),
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
  expect(
    f.store.questions.questionByToken(original.botKey, token)?.outcome,
  ).toBe("uncertain");
  expect(
    f.store.ircThreadRoot(original.botKey, "#ship", "published-question"),
  ).toBe("m1");
  f.store.respond(f.jobID, []);
  f.store.finish(f.jobID);
  f.store.pruneIrcHistory(original.botKey, future + 3_600_001);
  expect(
    f.store.questions.questionByToken(original.botKey, token),
  ).toBeUndefined();
  expect(
    f.store.ircThreadRoot(original.botKey, "#ship", "published-question"),
  ).toBeUndefined();
  expect(f.store.ircThreadParticipating(original.botKey, "#ship", "m1")).toBe(
    false,
  );
  const job = f.store.jobByInput(original.botKey, "msg_original");
  if (!job) throw new Error("Missing job");
  expect(f.store.questions.ownsQuestionSource(job)).toBe(false);
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
  f.store.questions.recordQuestionSource(earlier);
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
    const during = f.store.questions.questionByToken(original.botKey, token);
    expect(during?.state).toBe("attempted");
    expect(during?.outcome).toBeNull();
    expect(f.store.jobStatus(original.botKey, f.jobID)).toBe("running");
    expect(f.published).toHaveLength(1);
    if (outcome === "timeout") operation.abort();
    response.resolve();
    await answer;
    const completed = f.store.questions.questionByToken(original.botKey, token);
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
  expect(f.store.questions.questionOffers(original.botKey)).toEqual([]);
  expect(
    f.store.questions.questionByToken(original.botKey, token)?.outcome,
  ).toBe("uncertain");
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
  expect(f.store.questions.questionOffers(original.botKey)).toEqual([]);
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
  expect(
    f.store.questions.questionByToken(original.botKey, token)?.recovering,
  ).toBe(1);
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
    const secondOffer = f.store.questions
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
      f.store.questions.questionByToken(original.botKey, secondOffer.token)
        ?.recovering,
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
      f.store.questions.questionByToken(original.botKey, secondOffer.token)
        ?.recovering,
    ).toBe(0);
    expect(f.store.questions.questionOffers(original.botKey)).toEqual([]);
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
        human: (user) => user === "jac" || user === "allowed",
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
        expect(
          f.store.questions.questionOffers(original.botKey)[0]?.state,
        ).toBe("closed");
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
      expect(f.store.questions.questionOffers(original.botKey)).toEqual([]);
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
          human: (user) => user === "jac" || user === "allowed",
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
        f.store.questions.questionByToken(original.botKey, established.token)
          ?.recovering,
      ).toBe(1);
      expect(
        f.store.questions.questionByToken(original.botKey, "d".repeat(32))
          ?.recovering,
      ).toBe(0);
      expect(f.decisions).toEqual([]);
    } finally {
      stop.abort();
    }
  });
}

test("explicit renewal and concurrent polls publish the fresh offer only once", async () => {
  const f = await fixture();
  f.store.offerQuestion({
    token: "e".repeat(32),
    botKey: original.botKey,
    formID: question().id,
    sessionID: question().sessionID,
    inputID: question().inputID,
    jobID: f.jobID,
    fingerprint: question().fingerprint,
    expires: Date.now() - 1,
    state: "offered",
    notified: 1,
    recovering: 0,
  });
  const gate = f.pauseOffer();
  const renewal = f.answer({}, { token: "e".repeat(32), renew: true });
  await gate.entered.promise;
  await f.poll();
  await f.poll();
  expect(f.published).toEqual([]);
  gate.release.resolve();
  await renewal;
  await f.poll();
  expect(f.published).toHaveLength(1);
  expect(f.published[0]).toContain("Previous clarification token expired");
  expect(f.offer().notified).toBe(1);
  expect(f.decisions).toEqual([]);
});

for (const cleanup of ["ttl", "empty-list"] as const) {
  test(`missing-session suppression recovers via ${cleanup} for new fixed-session work`, async () => {
    const f = await fixture();
    await f.poll();
    f.backend.pendingQuestions = async () => [];
    f.backend.questionState = async () => "missing-session";
    await f.poll();
    if (cleanup === "empty-list") {
      f.store.respond(f.jobID, []);
      f.store.finish(f.jobID);
      await f.poll();
    }
    const next = {
      ...original,
      eventId: "#ship:next",
      conversation: "next-conversation",
      thread: "next",
    };
    f.store.enqueue(next);
    const job = f.store.queuedJob(original.botKey, next.eventId);
    if (!job) throw new Error("Missing new job");
    f.store.running(job.id);
    f.store.saveInput(original.botKey, job.id, "msg_next", "ses_captain");
    f.store.questions.recordQuestionSource(next);
    const q = { ...question(), id: "frm_next", inputID: "msg_next" };
    f.backend.pendingQuestions = async () => [q];
    f.backend.questionBelongsToInput = async () => true;
    f.backend.questionState = async () => "pending";
    const clock =
      cleanup === "ttl"
        ? spyOn(Date, "now").mockReturnValue(Date.now() + 60_001)
        : undefined;
    try {
      await f.poll();
    } finally {
      clock?.mockRestore();
    }
    expect(
      f.store.questions
        .questionOffers(original.botKey)
        .some((o) => o.formID === "frm_next" && o.notified === 1),
    ).toBe(true);
    expect(f.published).toHaveLength(2);
  });
}

test("denied outcome notices retire without publication or repeated inactive native polling", async () => {
  const f = await fixture();
  await f.poll();
  const token = f.offer().token;
  f.failPublish(true);
  await f.answer();
  f.store.respond(f.jobID, []);
  f.store.finish(f.jobID);
  f.revoke();
  let reads = 0;
  f.backend.pendingQuestions = async () => {
    reads++;
    return [];
  };
  await f.poll();
  await f.poll();
  expect(reads).toBe(0);
  expect(f.published).toHaveLength(1);
  expect(f.store.questions.questionOffers(original.botKey)).toEqual([]);
  expect(
    f.store.questions.questionByToken(original.botKey, token)?.outcome,
  ).toBe("answered");
  expect(f.decisions).toHaveLength(1);
});

for (const activity of ["human", "publication"] as const) {
  test(`continuing ${activity} thread activity refreshes retention independently`, async () => {
    const f = await fixture();
    expect(
      f.store.ircPublished(
        original.botKey,
        "#ship",
        "old-bot-message",
        "m1",
        "m1",
      ),
    ).toBe(true);
    const db = new Database(f.path);
    try {
      const old = Date.now() - 31 * 86_400_000;
      db.query("UPDATE irc_thread_messages SET recorded=?").run(old);
      db.query("UPDATE irc_thread_memberships SET recorded=?").run(old);
      f.store.respond(f.jobID, []);
      f.store.finish(f.jobID);
      if (activity === "human") {
        const reply = {
          ...original,
          eventId: "#ship:recent",
          thread: "recent",
          replyParent: "m1",
        };
        f.store.enqueueIrcHuman(reply, false);
        const job = f.store.queuedJob(original.botKey, reply.eventId);
        if (!job) throw new Error("No reply job");
        f.store.finish(job.id, "failed");
      } else
        expect(
          f.store.ircPublished(
            original.botKey,
            "#ship",
            "old-bot-message",
            "m1",
            "m1",
          ),
        ).toBe(true);
      f.store.pruneIrcHistory(original.botKey, Date.now());
      expect(
        f.store.ircThreadParticipating(original.botKey, "#ship", "m1"),
      ).toBe(true);
      expect(
        f.store.ircThreadRoot(
          original.botKey,
          "#ship",
          activity === "human" ? "recent" : "old-bot-message",
        ),
      ).toBe("m1");
    } finally {
      db.close();
    }
  });
}

test("recent participation preserves an older reply parent through cleanup and restart in its exact namespace", async () => {
  const f = await fixture();
  const start = Date.now();
  expect(
    f.store.ircPublished(original.botKey, "#ship", "old-parent", "m1", "m1"),
  ).toBe(true);
  f.store.respond(f.jobID, []);
  f.store.finish(f.jobID);
  const db = new Database(f.path);
  db.query(
    "INSERT INTO irc_thread_messages(botKey,channel,msgid,root,recorded) VALUES(?,'#foreign','old-parent','m1',?)",
  ).run(original.botKey, start);
  db.query(
    "INSERT INTO irc_thread_messages(botKey,channel,msgid,root,recorded) VALUES('another-bot','#ship','old-parent','m1',?)",
  ).run(start);
  db.close();
  const config = Schema.decodeUnknownSync(ircSchema)({
    id: original.botKey,
    account: "captain",
    passwordEnv: "FIXTURE",
    channels: ["#ship"],
    server: { host: "localhost", port: 6697, tls: true },
    backend: {
      type: "opencode",
      url: "http://localhost:4096",
      directory: "/project",
    },
    access: {
      channelRequests: "nick-mention",
      humanWakeChannels: [{ channel: "#ship", replies: "participating" }],
    },
    fleetPolicy: {
      role: "captain",
      humanAccounts: ["jac"],
      agentAccounts: ["captain"],
      assignedCheckout: "/project",
      capabilities: ["read_code"],
    },
  });
  const route = (id: string) => {
    const message = parseMessage(
      `@account=jac;msgid=${id};+draft/reply=old-parent :jac!u@fixture PRIVMSG #ship :Continue this thread`,
    );
    if (!message) throw new Error("No fixture message");
    return routeIrcMessage(message, {
      config,
      member: {
        id: "captain",
        key: original.botKey,
        account: "captain",
        nick: "captain",
        role: "captain",
        channels: ["#ship"],
      },
      currentNick: "captain",
      joined: () => true,
      sent: () => false,
      fold: (value) => value.toLowerCase(),
      now: Date.now,
      threadRoot: (channel, id) =>
        f.store.ircThreadRoot(original.botKey, channel, id),
      participating: (channel, root) =>
        f.store.ircThreadParticipating(original.botKey, channel, root),
    });
  };
  const clock = spyOn(Date, "now").mockReturnValue(start + 29 * 86_400_000);
  try {
    const reply = route("recent");
    if (!reply) throw new Error("No admitted day29reply");
    expect(f.store.enqueueIrcHuman(reply, false)).toBe(true);
    const job = f.store.queuedJob(original.botKey, reply.eventId);
    if (!job) throw new Error("No reply job");
    f.store.finish(job.id, "failed");
    clock.mockReturnValue(start + 31 * 86_400_000);
    f.store.pruneIrcHistory(original.botKey, Date.now());
    f.restart();
    expect(f.store.ircThreadRoot(original.botKey, "#ship", "old-parent")).toBe(
      "m1",
    );
    expect(f.store.ircThreadParticipating(original.botKey, "#ship", "m1")).toBe(
      true,
    );
    expect(route("after-restart")?.replyParent).toBe("m1");
    expect(
      f.store.ircThreadRoot(original.botKey, "#foreign", "old-parent"),
    ).toBeUndefined();
    const metadata = new Database(f.path, { readonly: true });
    try {
      expect(
        metadata
          .query<{ recorded: number }, []>(
            "SELECT recorded FROM irc_thread_messages WHERE botKey='another-bot' AND msgid='old-parent'",
          )
          .get()?.recorded,
      ).toBe(start);
    } finally {
      metadata.close();
    }
  } finally {
    clock.mockRestore();
  }
});

test("connection readiness cannot discard a new pending recovery hold or permanently suppress an outcome", async () => {
  const f = await fixture();
  await f.poll();
  f.restart();
  f.disconnect();
  expect(await f.bridge.recover(AbortSignal.timeout(3000))).toEqual([
    "msg_original",
  ]);
  await f.answer();
  expect(f.decisions).toEqual([{ q0: "wait" }]);
  expect(f.published).toHaveLength(1);
  expect(
    f.store.questions.questionOffers(original.botKey)[0]?.outcomeNotified,
  ).toBe(0);
  f.reconnect();
  await f.poll();
  expect(f.published[1]).toContain("decision recorded");
  expect(f.decisions).toHaveLength(1);
});

for (const closed of [false, true]) {
  test(`first restart retains proven answered input while busy (${closed ? "closed offer" : "attempted offer"})`, async () => {
    const f = await fixture();
    await f.poll();
    await f.answer();
    const token = f.offer().token;
    if (closed) await f.poll();
    expect(
      f.store.questions.questionByToken(original.botKey, token)?.state,
    ).toBe(closed ? "closed" : "attempted");
    f.restart();
    const retained = await f.bridge.recover(AbortSignal.timeout(3000));
    expect(retained).toEqual(["msg_original"]);
    f.store.recover(original.botKey, retained);
    expect(f.store.jobStatus(original.botKey, f.jobID)).toBe("running");
    await f.poll();
    expect(f.store.jobStatus(original.botKey, f.jobID)).toBe("running");
    f.complete();
    await f.poll();
    expect(f.store.jobStatus(original.botKey, f.jobID)).toBe("done");
    expect(f.decisions).toEqual([{ q0: "wait" }]);
  });
}

for (const uncertain of [false, true]) {
  test(`fresh Stop interrupts only a recovered exact input once (${uncertain === true ? "uncertain response" : "success"})`, async () => {
    const f = await fixture();
    await f.poll();
    f.restart();
    await f.bridge.recover(AbortSignal.timeout(3000));
    const scoped: string[][] = [];
    let broad = 0;
    f.backend.interruptInput = async (session, input) => {
      scoped.push([session, input]);
      if (uncertain) throw new Error("Unknown native outcome");
      f.complete();
    };
    f.backend.interrupt = async () => {
      broad++;
    };
    f.store.cancelTurn(original.botKey, original.conversation, original.thread);
    if (uncertain)
      await expect(
        f.bridge.stop(f.jobID, AbortSignal.timeout(3000)),
      ).rejects.toThrow();
    else
      expect(await f.bridge.stop(f.jobID, AbortSignal.timeout(3000))).toBe(
        true,
      );
    expect(await f.bridge.stop(f.jobID, AbortSignal.timeout(3000))).toBe(false);
    f.restart();
    await f.bridge.recover(AbortSignal.timeout(3000));
    expect(scoped).toEqual([["ses_captain", "msg_original"]]);
    expect(broad).toBe(0);
    if (!uncertain) {
      await f.poll();
      expect(f.store.jobByInput(original.botKey, "msg_original")?.failure).toBe(
        "cancelled",
      );
    }
    expect(f.decisions).toEqual([]);
  });
}

test("durable Stop anchors retain the exact request rather than an older visible root", async () => {
  const f = await fixture();
  const later = {
    ...original,
    eventId: "#ship:later",
    thread: "later",
    replyParent: "m1",
  };
  f.store.enqueue(later);
  expect(
    f.store.ircPublished(
      original.botKey,
      "#ship",
      "question-echo",
      "later",
      "m1",
    ),
  ).toBe(true);
  // The same native request IDs cannot redirect another conversation/bot.
  expect(
    f.store.ircPublished(original.botKey, "#ship", "question-echo", "m1", "m1"),
  ).toBe(false);
  f.restart();
  expect(f.store.ircThreadRoot(original.botKey, "#ship", "question-echo")).toBe(
    "m1",
  );
  expect(
    f.store.ircRequestAnchor(original.botKey, "#ship", "question-echo"),
  ).toBe("later");
  expect(
    f.store.ircRequestAnchor(original.botKey, "#other", "question-echo"),
  ).toBeUndefined();
  expect(
    f.store.ircRequestAnchor("other-bot", "#ship", "question-echo"),
  ).toBeUndefined();
});

test("unproven recovered Stop binding cannot fall back to a whole-session interruption", async () => {
  const f = await fixture();
  await f.poll();
  f.restart();
  await f.bridge.recover(AbortSignal.timeout(3000));
  f.store.cancelTurn(original.botKey, original.conversation, original.thread);
  let calls = 0;
  f.backend.interruptInput = async () => {
    calls++;
  };
  f.backend.interrupt = async () => {
    calls++;
  };
  Object.defineProperty(f.backend, "sessionID", { value: "ses_other" });
  expect(await f.bridge.stop(f.jobID, AbortSignal.timeout(3000))).toBe(false);
  expect(calls).toBe(0);
});

for (const botReply of [false, true]) {
  test(`actual strict IRC transport Stop on ${botReply ? "durable question echo" : "original request"} reaches its recovered input after restart`, async () => {
    const f = await fixture(false);
    const server = new FakeIrcServer({
      accounts: { captain: "fixture" },
    }).start();
    cleanup.push(() => server.stop());
    const cfg = Schema.decodeUnknownSync(ircSchema)({
      id: "recovered",
      account: "captain",
      passwordEnv: "FIXTURE",
      channels: ["#ship"],
      server: { host: "127.0.0.1", port: server.port, tls: false },
      features: { questions: true },
      access: { channelRequests: "nick-mention", allowedAccounts: ["jac"] },
      fleetPolicy: {
        role: "captain",
        humanAccounts: ["jac"],
        agentAccounts: ["captain"],
        assignedCheckout: "/project",
        capabilities: ["read_code"],
      },
      backend: {
        type: "opencode",
        url: "http://localhost:4096",
        directory: "/project",
        sessionID: "ses_captain",
      },
    });
    const ship = await IrcShip.create(cfg, f.store, pino({ level: "silent" }), {
      env: { FIXTURE: "fixture" },
      timing: { intervalMs: 1, burst: 100 },
      readyMs: 2000,
    });
    const registration = ship.registrations[0];
    if (!registration) throw new Error("Missing IRC registration");
    const input = {
      ...original,
      botKey: registration.key,
      ...(botReply ? { replyParent: "older-root" } : {}),
      conversation: JSON.stringify([registration.key, "#ship"]),
    };
    f.store.enqueue(input);
    const job = f.store.queuedJob(registration.key, input.eventId);
    if (!job) throw new Error("Missing saved IRC work");
    f.store.running(job.id);
    f.store.started(job.id);
    f.store.saveInput(registration.key, job.id, "msg_original", "ses_captain");
    f.store.questions.recordQuestionSource(input);
    f.store.offerQuestion({
      token: "f".repeat(32),
      botKey: registration.key,
      formID: question().id,
      sessionID: question().sessionID,
      inputID: question().inputID,
      jobID: job.id,
      fingerprint: question().fingerprint,
      expires: Date.now() + 1_800_000,
      state: "offered",
      notified: 1,
      recovering: 0,
    });
    const stopTarget = botReply ? "question-echo" : "m1";
    if (botReply) {
      // Previous gateway's verified own echo, persisted with an exact request
      // distinct from its visible thread root. The new connection has no cache.
      expect(
        f.store.ircPublished(
          registration.key,
          "#ship",
          stopTarget,
          "m1",
          "older-root",
        ),
      ).toBe(true);
      expect(
        f.store.ircRequestAnchor(registration.key, "#ship", stopTarget),
      ).toBe("m1");
      expect(registration.client.requestAnchor(stopTarget)).toBeUndefined();
    }
    expect(registration.transport.allowed(input.user, input.channel)).toBe(
      false,
    );
    let interrupts = 0;
    const scoped: string[][] = [];
    f.backend.createSession = async () => "ses_captain";
    f.backend.interrupt = async () => {
      interrupts++;
    };
    f.backend.interruptInput = async (session, input) => {
      scoped.push([session, input]);
      f.complete();
    };
    const gateway = new Gateway(
      registration.settings,
      registration.identity,
      f.store,
      f.backend,
      registration.delivery,
      pino({ level: "silent" }),
      undefined,
      undefined,
      registration.transport,
    );
    registration.stopTurn = (conversation, thread) =>
      gateway.stopTurn(conversation, thread);
    const stop = new AbortController();
    const worker = gateway.work(stop.signal);
    try {
      await until(
        () =>
          f.store.questions.questionOffers(registration.key)[0]?.recovering ===
          1,
        3000,
        "unjoined real IRC transport retained native hold",
      );
      expect(scoped).toEqual([]);
      expect(interrupts).toBe(0);
      expect(f.store.jobStatus(registration.key, job.id)).toBe("running");
      ship.start(() => true);
      await until(
        () => registration.client.inChannel("#ship"),
        3000,
        "IRC rejoined",
      );
      server.sendTo(
        "captain",
        `@account=jac;bot=1;+draft/react=✋;+draft/reply=${stopTarget} :jac!u@fixture TAGMSG #ship`,
      );
      server.sendTo(
        "captain",
        `@account=stranger;+draft/react=✋;+draft/reply=${stopTarget} :stranger!u@fixture TAGMSG #ship`,
      );
      server.sendTo("captain", "PING :stop-spoofs");
      await until(
        () =>
          server
            .received("captain")
            .some(
              (line) => line.includes("PONG") && line.includes("stop-spoofs"),
            ),
        2000,
        "spoof Stop controls processed",
      );
      expect(scoped).toEqual([]);
      server.sendTo(
        "captain",
        `@account=jac;+draft/react=✋;+draft/reply=${stopTarget} :jac!u@fixture TAGMSG #ship`,
      );
      server.sendTo(
        "captain",
        `@account=jac;+draft/react=✋;+draft/reply=${stopTarget} :jac!u@fixture TAGMSG #ship`,
      );
      await until(
        () => f.store.jobStatus(registration.key, job.id) === "done",
        4000,
        "authenticated Stop released recovered queue",
      );
      expect(scoped).toEqual([["ses_captain", "msg_original"]]);
      expect(interrupts).toBe(0);
      expect(
        f.store.jobByInput(registration.key, "msg_original")?.failure,
      ).toBe("cancelled");
      expect(f.decisions).toEqual([]);
    } finally {
      stop.abort();
      await worker;
      await ship.close();
    }
  }, 10_000);
}

test("configurable question bridge stays off and admits only configured answer policy", async () => {
  const settings = {
    enabled: false,
    timeoutMs: 300_000,
    answer: "requester" as "requester" | "allowed",
  };
  const f = await fixture(true, settings);
  await f.poll();
  expect(f.published).toHaveLength(0);
  expect(f.store.questions.questionOffers(original.botKey)).toHaveLength(0);
  settings.enabled = true;
  await f.poll();
  expect(f.published).toHaveLength(1);
  await f.answer({ user: "allowed" });
  expect(f.decisions).toHaveLength(0);
  settings.answer = "allowed";
  await f.answer({ user: "allowed" });
  expect(f.decisions).toEqual([{ q0: "wait" }]);
});

test("configured expiry cancels native form once instead of blocking the waiter", async () => {
  const f = await fixture(true, {
    enabled: true,
    timeoutMs: 300_000,
    answer: "requester",
  });
  const clock = spyOn(Date, "now").mockReturnValue(1_000_000);
  try {
    await f.poll();
    expect(f.offer().expires).toBe(1_300_000);
    clock.mockReturnValue(1_300_001);
    await f.poll();
    await f.poll();
    expect(f.decisions).toEqual([null]);
    expect(f.published.join("\n")).toContain("timed out");
  } finally {
    clock.mockRestore();
  }
});

test("disabling question controls during native validation prevents the answer", async () => {
  const settings = {
    enabled: true,
    timeoutMs: 300_000,
    answer: "requester" as const,
  };
  const f = await fixture(true, settings);
  await f.poll();
  const validate = f.backend.questionBelongsToInput;
  f.backend.questionBelongsToInput = async (...args) => {
    settings.enabled = false;
    return (await validate?.(...args)) ?? false;
  };
  await f.answer();
  expect(f.decisions).toEqual([]);
  expect(f.offer().state).toBe("offered");
});

test("uncertain timeout cancellation is consumed, not replayed on another poll", async () => {
  const f = await fixture(true, {
    enabled: true,
    timeoutMs: 300_000,
    answer: "requester",
  });
  f.failReply();
  const clock = spyOn(Date, "now").mockReturnValue(1_000_000);
  try {
    await f.poll();
    const token = f.offer().token;
    clock.mockReturnValue(1_300_001);
    await f.poll();
    await f.poll();
    expect(f.decisions).toEqual([null]);
    expect(
      f.store.questions.questionByToken(original.botKey, token)?.outcome,
    ).toBe("uncertain");
    expect(f.published.join("\n")).toContain("outcome is uncertain");
  } finally {
    clock.mockRestore();
  }
});

test("disabled controls still release a recovered waiter when its native form settles", async () => {
  const settings = {
    enabled: true,
    timeoutMs: 300_000,
    answer: "requester" as const,
  };
  const f = await fixture(true, settings);
  await f.poll();
  f.restart();
  const retained = await f.bridge.recover(AbortSignal.timeout(3000));
  f.store.recover(original.botKey, retained);
  settings.enabled = false;
  f.complete();
  await f.poll();
  expect(f.store.jobStatus(original.botKey, f.jobID)).toBe("done");
  expect(f.store.questions.questionOffers(original.botKey)).toEqual([]);
  expect(f.decisions).toEqual([]);
  expect(f.settled).toEqual(["ses_captain"]);
});
