import { afterEach, expect, test } from "bun:test";
import type { NativeQuestion, QuestionOffer } from "../src/questions/questions";
import { botKey, conversationKey } from "../src/gateway/routing";
import type { SlackPanelContent } from "../src/shared/slack-format";
import {
  buildQuestionBlocks,
  SlackQuestionControls,
} from "../src/questions/slack-questions";
import { Store } from "../src/gateway/store";
import { bot, event, identity } from "./fixtures";

const token = "a".repeat(32);
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
function question(): NativeQuestion {
  return {
    id: "frm_question",
    sessionID: "ses_question",
    inputID: "msg_input",
    toolMessageID: "msg_tool",
    toolCallID: "call_tool",
    fingerprint: "f".repeat(64),
    title: "Choose <@U123>",
    fields: [
      {
        key: "q0",
        type: "string",
        title: "Next step",
        custom: true,
        options: [
          { label: "Wait", value: "native_wait" },
          { label: "Continue", value: "native_go" },
        ],
      },
    ],
  };
}

function fixture(native = question(), expires = Date.now() + 60_000) {
  const config = bot();
  const key = botKey(config, identity);
  const store = new Store(":memory:");
  cleanups.push(() => store.close());
  store.enqueue({
    botKey: key,
    eventId: "C123:1.000",
    conversation: conversationKey(key, "C123", "1.000"),
    channel: "C123",
    thread: "1.000",
    user: "U123",
    text: "Investigate",
  });
  const queued = store.queuedJob(key, "C123:1.000");
  if (!queued) throw new Error("Missing fixture job");
  store.running(queued.id);
  store.saveInput(key, queued.id, native.inputID, native.sessionID);
  const job = store.jobByInput(key, native.inputID);
  if (!job) throw new Error("Missing fixture input");
  const offer: QuestionOffer = {
    token,
    botKey: key,
    formID: native.id,
    sessionID: native.sessionID,
    inputID: native.inputID,
    jobID: job.id,
    fingerprint: native.fingerprint,
    state: "offered",
    expires,
    notified: 0,
    recovering: 0,
  };
  store.offerQuestion(offer);
  const posts: SlackPanelContent[] = [];
  const updates: SlackPanelContent[] = [];
  const replies: string[] = [];
  const answers: { answer: string | null; user: string }[] = [];
  let enabled = true;
  let policy: "requester" | "allowed" = "requester";
  let human = true;
  let acked = false;
  let requireAck = false;
  let beforeHuman: (() => void) | undefined;
  let failUpdate = false;
  let failSubmit = false;
  const controls = () =>
    new SlackQuestionControls(
      store,
      {
        async post(_channel, _thread, _text, _stop, unit, content) {
          if (!unit?.allowed?.()) throw new Error("Denied publication");
          posts.push(content as SlackPanelContent);
          return "2.000";
        },
        async update(_channel, _ts, _text, _stop, content) {
          expect(
            store.questions.slackQuestion(token)?.revision,
          ).toBeGreaterThan(0);
          if (failUpdate) throw new Error("Slack unavailable");
          updates.push(content as SlackPanelContent);
          return true;
        },
        async ephemeral(_channel, _user, _thread, text) {
          replies.push(text);
        },
      },
      () => config,
      identity,
      async () => {
        if (requireAck) expect(acked).toBe(true);
        beforeHuman?.();
        return human;
      },
      async () => {
        if (requireAck) expect(acked).toBe(true);
        return { enabled, timeoutMs: 60_000, answer: policy };
      },
      async (_job, _token, answer, user) => {
        if (failSubmit)
          throw new Error("Submission interrupted before native claim");
        answers.push({ answer, user });
      },
    );
  let ui = controls();
  return {
    config,
    store,
    job,
    offer,
    posts,
    updates,
    answers,
    replies,
    publish: () => ui.publishQuestion(job, offer, native, () => true),
    restart() {
      ui = controls();
    },
    enabled(value: boolean) {
      enabled = value;
    },
    policy(value: "requester" | "allowed") {
      policy = value;
    },
    human(value: boolean) {
      human = value;
    },
    beforeHuman(callback: () => void) {
      beforeHuman = callback;
    },
    failUpdate(value: boolean) {
      failUpdate = value;
    },
    failSubmit(value: boolean) {
      failSubmit = value;
    },
    click: async (raw: unknown) => {
      acked = false;
      requireAck = true;
      return ui.interactive(
        raw,
        async () => {
          acked = true;
        },
        () => true,
      );
    },
    receive: (raw: unknown) => ui.receive(raw, () => true),
  };
}

function press(id = "stargate_question_pick_0_1", value = `${token}:0:1`) {
  return {
    type: "block_actions",
    api_app_id: "A123",
    team: { id: "T123" },
    user: { id: "U123" },
    channel: { id: "C123" },
    container: { type: "message", channel_id: "C123", message_ts: "2.000" },
    message: { user: "UBOT", ts: "2.000", thread_ts: "1.000" },
    actions: [{ type: "button", action_id: id, value, action_ts: "3.000" }],
  };
}

test("renders literal single-choice buttons with trusted indexed values and native custom policy", () => {
  const native = question();
  const field = native.fields[0];
  if (!field) throw new Error("Missing fixture field");
  field.custom = false;
  const panel = buildQuestionBlocks(native, token);
  const json = JSON.stringify(panel);
  expect(json).toContain("plain_text");
  expect(json).not.toContain('"mrkdwn"');
  expect(json).toContain(`${token}:0:1`);
  expect(json).not.toContain("Type your own");
  expect(json).not.toContain('"value":"native_go"');
  for (const block of panel.blocks) {
    if (block.type !== "actions") continue;
    const ids = block.elements.map((element) => element.action_id);
    expect(new Set(ids).size).toBe(ids.length);
  }
});

test("binds actual publication and maps indices after controls restart, ACK before I/O", async () => {
  const f = fixture();
  await f.publish();
  expect(f.store.questions.slackQuestion(token)?.ts).toBe("2.000");
  f.restart();
  expect(await f.click(press())).toBe(true);
  expect(f.answers).toEqual([{ answer: '{"q0":"native_go"}', user: "U123" }]);
  expect(await f.click({ actions: [{ action_id: "other" }] })).toBe(false);
});

test("checkbox change never answers; Submit reads state and ignores labels", async () => {
  const native = question();
  native.fields = [
    {
      ...native.fields[0],
      key: "q0",
      type: "multiselect",
      options: native.fields[0]?.options ?? [],
      minItems: 1,
      maxItems: 2,
    },
  ];
  const f = fixture(native);
  await f.publish();
  expect(JSON.stringify(f.posts)).toContain("checkboxes");
  const selection = {
    ...press(),
    actions: [
      {
        type: "checkboxes",
        action_id: "stargate_question_select",
        block_id: `${token}:0`,
        selected_options: [{ value: `${token}:0:1` }],
        action_ts: "3.000",
      },
    ],
  };
  await f.click(selection);
  expect(f.answers).toEqual([]);
  const submit = {
    ...press("stargate_question_submit", token),
    state: {
      values: {
        [`${token}:0`]: {
          stargate_question_select: {
            type: "checkboxes",
            selected_options: [
              { value: `${token}:0:1`, text: { text: "Forged" } },
              { value: `${token}:0:0` },
            ],
          },
        },
      },
    },
  };
  const selected =
    submit.state.values[`${token}:0`]?.stargate_question_select
      .selected_options[0];
  if (!selected) throw new Error("Missing fixture selection");
  selected.value = `${token}:0:9`;
  await f.click(submit);
  expect(f.answers).toEqual([]);
  expect(f.store.questions.slackQuestion(token)?.revision).toBe(0);
  selected.value = `${token}:0:1`;
  await f.click(submit);
  expect(f.answers).toEqual([
    { answer: '{"q0":["native_go","native_wait"]}', user: "U123" },
  ]);
});

test("refuses forged routing, source message, bot user, stale and disabled offers", async () => {
  const f = fixture();
  await f.publish();
  const original = press();
  const variants = [
    { ...original, api_app_id: "AOTHER" },
    { ...original, team: { id: "TOTHER" } },
    { ...original, channel: { id: "COTHER" } },
    { ...original, message: { ...original.message, ts: "9.000" } },
    { ...original, message: { ...original.message, thread_ts: "9.000" } },
    { ...original, message: { ...original.message, user: "UOTHER" } },
    { ...original, container: { ...original.container, message_ts: "9.000" } },
    { ...original, user: { id: "U123", is_bot: true } },
    {
      ...original,
      actions: [{ ...original.actions[0], value: `${token}:1:0` }],
    },
  ];
  for (const raw of variants) expect(await f.click(raw)).toBe(true);
  f.human(false);
  await f.click(original);
  f.human(true);
  f.enabled(false);
  await f.click(original);
  f.enabled(true);
  f.config.access.deniedUsers.push("U123");
  await f.click(original);
  f.config.access.deniedUsers.pop();
  f.store.questions.closeQuestion(token);
  await f.click(original);
  expect(f.answers).toEqual([]);
});

test("requester policy restricts responders; allowed still requires current allowlist", async () => {
  const f = fixture();
  f.config.access.users.push("U456");
  await f.publish();
  const raw = { ...press(), user: { id: "U456" } };
  await f.click(raw);
  expect(f.answers).toEqual([]);
  f.policy("allowed");
  await f.click(raw);
  expect(f.answers[0]?.user).toBe("U456");
  f.answers.length = 0;
  f.config.access.deniedUsers.push("U456");
  await f.click(raw);
  expect(f.answers).toEqual([]);
});

test("custom intake reserves only explicit bot answer tokens and original thread", async () => {
  const f = fixture();
  await f.publish();
  expect(f.receive(event("ordinary answer prose"))).toBe(false);
  expect(f.receive(event(`answer ${token} wait`))).toBe(false);
  const raw = {
    ...event(`<@UBOT> answer ${token} My own step`),
    event: {
      ...event().event,
      text: `<@UBOT> answer ${token} My own step`,
      thread_ts: "1.000",
      ts: "4.000",
    },
  };
  await f.receive({ ...raw, event: { ...raw.event, thread_ts: "9.000" } });
  expect(f.answers).toEqual([]);
  await f.receive(raw);
  expect(f.answers).toEqual([{ answer: '{"q0":"My own step"}', user: "U123" }]);
  const closed = question();
  const field = closed.fields[0];
  if (!field) throw new Error("Missing fixture field");
  field.custom = false;
  const g = fixture(closed);
  await g.publish();
  await g.receive(raw);
  expect(g.answers).toEqual([]);
});

test("disabled questions leave explicit-looking answer text to ordinary intake", async () => {
  const f = fixture();
  f.enabled(false);
  const raw = {
    ...event(`<@UBOT> answer ${token} ordinary chat`, "4.000"),
    event: {
      ...event().event,
      text: `<@UBOT> answer ${token} ordinary chat`,
      ts: "4.000",
      thread_ts: "1.000",
    },
  };
  expect(await f.receive(raw)).toBe(false);
  expect(f.answers).toEqual([]);
  expect(await f.click(press())).toBe(true);
});

test("sequential fields persist progress, survive restart and submit the complete form once", async () => {
  const native = question();
  native.fields.push({
    key: "q7",
    title: "Locations",
    type: "multiselect",
    options: [
      { label: "North", value: "native_north" },
      { label: "South", value: "native_south" },
    ],
  });
  const f = fixture(native);
  await f.publish();
  await f.click(press());
  expect(f.answers).toEqual([]);
  expect(
    JSON.parse(f.store.questions.slackQuestion(token)?.progress ?? "null"),
  ).toEqual({
    q0: "native_go",
  });
  expect(f.store.questions.slackQuestion(token)?.revision).toBe(1);
  expect(f.updates.at(-1)?.text).toContain("Locations");
  expect(JSON.stringify(f.updates)).toContain(`${token}:1:1`);
  f.restart();
  await f.click(press());
  expect(f.store.questions.slackQuestion(token)?.revision).toBe(1);
  expect(f.answers).toEqual([]);
  const submit = {
    ...press("stargate_question_submit", `${token}:1`),
    state: {
      values: {
        [`${token}:1`]: {
          stargate_question_select: {
            type: "checkboxes",
            selected_options: [{ value: `${token}:1:1` }],
          },
        },
      },
    },
  };
  await f.click(submit);
  expect(f.answers).toEqual([
    { answer: '{"q0":"native_go","q7":["native_south"]}', user: "U123" },
  ]);
  await f.click(submit);
  await f.click(press());
  expect(f.answers).toHaveLength(1);
});

test("failed repaint retains accepted progress and stale event retry only refreshes", async () => {
  const native = question();
  native.fields.push({
    key: "q1",
    title: "Explain",
    type: "string",
    custom: true,
  });
  const f = fixture(native);
  await f.publish();
  f.failUpdate(true);
  await f.click(press());
  expect(f.store.questions.slackQuestion(token)?.revision).toBe(1);
  expect(f.answers).toEqual([]);
  f.failUpdate(false);
  f.restart();
  await f.click(press());
  expect(f.updates.at(-1)?.text).toContain("Explain");
  const reply = (suffix: string) => ({
    ...event(`<@UBOT> answer ${token}${suffix} reason`, "4.000"),
    event: {
      ...event().event,
      text: `<@UBOT> answer ${token}${suffix} reason`,
      ts: "4.000",
      thread_ts: "1.000",
    },
  });
  await f.receive(reply(""));
  await f.receive(reply(":0"));
  expect(f.answers).toEqual([]);
  await f.receive(reply(":1"));
  expect(f.answers).toEqual([
    { answer: '{"q0":"native_go","q1":"reason"}', user: "U123" },
  ]);
});

test("interrupted final submission needs an explicit saved-answer submission, never stale replay", async () => {
  const f = fixture();
  await f.publish();
  f.failSubmit(true);
  await f.click(press());
  expect(f.store.questions.slackQuestion(token)?.revision).toBe(1);
  expect(f.answers).toEqual([]);
  f.failSubmit(false);
  f.restart();
  await f.click(press());
  expect(f.answers).toEqual([]);
  expect(f.updates.at(-1)?.text).toContain("explicitly submit");
  await f.click(press("stargate_question_finish", `${token}:1`));
  expect(f.answers).toEqual([{ answer: '{"q0":"native_go"}', user: "U123" }]);
});

test("all eight native fields advance under one offer and preserve their field keys", async () => {
  const native = question();
  native.fields = Array.from({ length: 8 }, (_, i) => ({
    key: `q${i}`,
    type: "string",
    options: [{ label: `Choice ${i}`, value: `native_${i}` }],
  }));
  const f = fixture(native);
  await f.publish();
  for (let revision = 0; revision < 8; revision++) {
    await f.click(
      press(`stargate_question_pick_${revision}_0`, `${token}:${revision}:0`),
    );
    expect(f.store.questions.slackQuestion(token)?.revision).toBe(revision + 1);
    expect(f.answers).toHaveLength(revision === 7 ? 1 : 0);
  }
  expect(JSON.parse(f.answers[0]?.answer ?? "null")).toEqual({
    q0: "native_0",
    q1: "native_1",
    q2: "native_2",
    q3: "native_3",
    q4: "native_4",
    q5: "native_5",
    q6: "native_6",
    q7: "native_7",
  });
});

test("expired offers and policy lost during directory I/O cannot submit", async () => {
  const native = question();
  const expired = fixture(native, Date.now() - 1);
  expired.store.questions.saveSlackQuestion(token, "2.000", native);
  await expired.click(press());
  expect(expired.answers).toEqual([]);
  const f = fixture();
  await f.publish();
  f.beforeHuman(() => f.enabled(false));
  await f.click(press());
  expect(f.answers).toEqual([]);
});

test("twenty choices fit Slack checkbox limits and submit across all groups", async () => {
  const native = question();
  native.fields = [
    {
      key: "q0",
      type: "multiselect",
      options: Array.from({ length: 20 }, (_, i) => ({
        label: `Choice ${i}`,
        value: `native_${i}`,
      })),
    },
  ];
  const f = fixture(native);
  await f.publish();
  const checkboxGroups = f.posts.flatMap((panel) =>
    panel.blocks.flatMap((block) =>
      block.type === "actions"
        ? block.elements.filter((element) => element.type === "checkboxes")
        : [],
    ),
  );
  expect(checkboxGroups).toHaveLength(2);
  for (const group of checkboxGroups)
    expect(group.options.length).toBeLessThanOrEqual(10);
  const raw = {
    ...press("stargate_question_submit", token),
    state: {
      values: {
        [`${token}:0`]: {
          stargate_question_select: {
            type: "checkboxes",
            selected_options: [{ value: `${token}:0:3` }],
          },
        },
        [`${token}:0:1`]: {
          stargate_question_select: {
            type: "checkboxes",
            selected_options: [{ value: `${token}:0:15` }],
          },
        },
      },
    },
  };
  await f.click(raw);
  expect(f.answers).toEqual([
    { answer: '{"q0":["native_3","native_15"]}', user: "U123" },
  ]);
});
