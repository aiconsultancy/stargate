import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { AgentBackend } from "../src/backend";
import { Gateway } from "../src/gateway/gateway";
import type { TransportDelivery } from "../src/gateway/ports";
import { saveQuestionSettings } from "../src/questions/question-settings";
import type { NativeQuestion } from "../src/questions/questions";
import { Store } from "../src/gateway/store";
import { bot, event, identity } from "./fixtures";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test.each([false, true])(
  "Slack questions bypass held conversation without submitting another captain prompt (multi-field=%s)",
  async (multiple) => {
    const directory = await mkdtemp(join(tmpdir(), "slack-question-gateway-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const config = bot();
    if (config.backend.type !== "opencode") throw new Error("OpenCode fixture");
    config.backend.directory = directory;
    config.backend.agent = "adama";
    config.backend.sessionID = "ses_captain";
    const store = new Store(join(directory, "gateway.sqlite"));
    cleanup.push(() => store.close());
    let prompts = 0;
    let pending = true;
    const answers: unknown[] = [];
    const form: NativeQuestion = {
      id: "frm_q",
      sessionID: "ses_captain",
      inputID: "msg_original",
      toolMessageID: "msg_assistant",
      toolCallID: "call_q",
      fingerprint: "a".repeat(64),
      title: "Choose next step",
      fields: [
        {
          key: "q0",
          type: "string",
          custom: true,
          options: [
            { value: "wait", label: "Wait" },
            { value: "go", label: "Go" },
          ],
        },
      ],
    };
    if (multiple)
      form.fields.push({
        key: "q1",
        type: "string",
        title: "Explain why",
        custom: true,
      });
    const backend: AgentBackend = {
      sessionID: "ses_captain",
      async createSession() {
        return "ses_captain";
      },
      async prompt() {
        prompts++;
        return "unused";
      },
      async close() {},
      async pendingQuestions() {
        return pending ? [form] : [];
      },
      async questionState() {
        return pending ? "pending" : "resolved";
      },
      async questionBelongsToInput(s, f, i, hash) {
        return (
          pending &&
          s === form.sessionID &&
          f === form.id &&
          i === form.inputID &&
          hash === form.fingerprint
        );
      },
      async replyQuestion(_q, answer) {
        answers.push(answer);
        pending = false;
      },
      async questionInputSettled() {
        return !pending;
      },
    };
    const posts: { text: string; content: unknown }[] = [];
    const slack: TransportDelivery = {
      async post(_c, _t, text, _stop, _unit, content) {
        posts.push({ text, content });
        return "3.000";
      },
      async ephemeral() {},
      async update() {
        return true;
      },
    };
    const gateway = new Gateway(
      config,
      identity,
      store,
      backend,
      slack,
      pino({ enabled: false }),
      undefined,
      undefined,
      undefined,
      undefined,
      { isHuman: async (user) => user === "U123" },
    );
    expect(await gateway.receive(event())).toBe(true);
    const job = store.queuedJob(gateway.key, "C123:1.000");
    if (!job) throw new Error("Missing admitted job");
    store.running(job.id);
    store.started(job.id);
    store.captainCursor(gateway.key, "ses_captain");
    store.baselineCaptain(gateway.key, "ses_captain", "msg_baseline");
    store.saveInput(gateway.key, job.id, form.inputID, "ses_captain");
    await gateway.pollQuestions(AbortSignal.timeout(3000));
    expect(posts).toHaveLength(0);
    await saveQuestionSettings(
      directory,
      "adama",
      { enabled: true, timeoutMs: 300_000, answer: "requester" },
      AbortSignal.timeout(3000),
    );
    await gateway.pollQuestions(AbortSignal.timeout(3000));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.content).toBeDefined();
    const offer = store.questions.questionOffers(gateway.key)[0];
    if (!offer) throw new Error("Missing offered question");
    const answerEvent = event(
      `<@UBOT> answer ${offer.token}${multiple ? ":0" : ""} go`,
      "4.000",
    );
    Object.assign(answerEvent.event, { thread_ts: "1.000" });
    expect(await gateway.receive(answerEvent)).toBe(false);
    if (multiple) {
      expect(answers).toEqual([]);
      expect(store.questions.slackQuestion(offer.token)?.revision).toBe(1);
      const staleAnswer = event(
        `<@UBOT> answer ${offer.token}:0 stale`,
        "5.000",
      );
      Object.assign(staleAnswer.event, { thread_ts: "1.000" });
      await gateway.receive(staleAnswer);
      expect(answers).toEqual([]);
      const finalAnswer = event(
        `<@UBOT> answer ${offer.token}:1 Because`,
        "6.000",
      );
      Object.assign(finalAnswer.event, { thread_ts: "1.000" });
      expect(await gateway.receive(finalAnswer)).toBe(false);
      expect(answers).toEqual([{ q0: "go", q1: "Because" }]);
      await gateway.receive(finalAnswer);
      expect(answers).toHaveLength(1);
      expect(store.queuedJob(gateway.key, "C123:5.000")).toBeNull();
      expect(store.queuedJob(gateway.key, "C123:6.000")).toBeNull();
    } else expect(answers).toEqual([{ q0: "go" }]);
    expect(prompts).toBe(0);
    expect(store.queuedJob(gateway.key, "C123:4.000")).toBeNull();
  },
);
