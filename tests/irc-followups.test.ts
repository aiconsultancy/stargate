import { afterEach, expect, test } from "bun:test";
import { Schema } from "effect";
import pino from "pino";
import type { AgentBackend, SteerInput } from "../src/backends/backend";
import { ircSchema } from "../src/config";
import { Gateway } from "../src/gateway/gateway";
import { IrcShip } from "../src/irc/ship";
import { Store } from "../src/gateway/store";
import { FakeIrcServer, lineOf, until } from "./irc-fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("IRC same-root follow-up steers despite its unique msgid; other roots queue and final stays on original root", async () => {
  const fake = new FakeIrcServer({ accounts: { captain: "fixture" } }).start();
  cleanup.push(() => fake.stop());
  const store = new Store(":memory:");
  cleanup.push(() => store.close());
  const config = Schema.decodeUnknownSync(ircSchema)({
    id: "ship",
    server: { host: "127.0.0.1", port: fake.port, tls: false },
    account: "captain",
    passwordEnv: "IRC_PASSWORD",
    channels: ["#ship"],
    features: { steerThreadFollowUps: true },
    access: { deniedAccounts: ["mallory"] },
    backend: {
      type: "opencode",
      url: "http://127.0.0.1:1",
      directory: "/workspace",
      sessionID: "ses_captain",
    },
  });
  const log = pino({ enabled: false });
  const ship = await IrcShip.create(config, store, log, {
    env: { IRC_PASSWORD: "fixture" },
    timing: { intervalMs: 5, burst: 50, reconnectMinMs: 20 },
    readyMs: 2000,
  });
  const captain = ship.registrations[0];
  if (!captain) throw new Error("Missing captain");
  const finish = Promise.withResolvers<string>();
  const prompts: string[] = [];
  let latestAnswer = "";
  const steers: SteerInput[] = [];
  const backend: AgentBackend = {
    sessionID: "ses_captain",
    createSession: async () => "ses_captain",
    async prompt(_s, text, _signal, _text, onInput) {
      prompts.push(text);
      onInput?.(`msg_input_${prompts.length}`);
      latestAnswer = await (prompts.length === 1
        ? finish.promise
        : "Other request done");
      return latestAnswer;
    },
    async transcript(_s, after) {
      if (after === undefined) return { cursor: "", entries: [] };
      const input = `msg_input_${prompts.length}`;
      return {
        cursor: `msg_answer_${prompts.length}`,
        input,
        entries: [
          {
            id: `msg_answer_${prompts.length}`,
            input,
            text: latestAnswer,
            created: prompts.length,
          },
        ],
      };
    },
    async steer(input) {
      expect(input.allowed()).toBe(true);
      steers.push(input);
      return { status: "accepted" };
    },
    async close() {},
  };
  const controller = new AbortController();
  const gateway = new Gateway(
    captain.settings,
    captain.identity,
    store,
    backend,
    captain.delivery,
    log,
    undefined,
    undefined,
    captain.transport,
  );
  const worker = gateway.work(controller.signal);
  ship.start(() => true);
  cleanup.push(async () => {
    finish.resolve("Stopped");
    controller.abort();
    await worker;
    await ship.close();
  });
  await until(() => captain.client.inChannel("#ship"), 5000, "joined");
  const root = fake.say(
    { nick: "jack", account: "jack" },
    "#ship",
    "captain: original",
  );
  await until(() => prompts.length === 1, 5000, "original running");
  const followup = fake.say(
    { nick: "jack", account: "jack" },
    "#ship",
    "captain: revised scope",
    { "+draft/reply": root },
  );
  await until(() => steers.length === 1, 5000, "follow-up steered");
  expect(steers[0]?.context.source).toMatchObject({
    thread: followup,
    replyParent: root,
    message: followup,
  });
  expect(store.queueCounts(captain.key).queued).toBe(0);
  fake.say(
    { nick: "mallory", account: "mallory" },
    "#ship",
    "captain: forbidden",
    { "+draft/reply": root },
  );
  fake.say(
    { nick: "jack", account: "jack" },
    "#ship",
    "captain: another request",
    { "+draft/reply": "different-root" },
  );
  await until(
    () => store.queueCounts(captain.key).queued === 1,
    5000,
    "other root queued",
  );
  await until(
    () =>
      lineOf(fake.received("captain"), "PRIVMSG").some((message) =>
        message.params[1]?.includes("Queued behind another request."),
      ),
    5000,
    "queue notice",
  );
  const notice = lineOf(fake.received("captain"), "PRIVMSG").find((message) =>
    message.params[1]?.includes("Queued behind another request."),
  );
  expect(notice?.tags.get("+draft/reply")).toBe("different-root");
  finish.resolve("Original request done");
  await until(
    () => store.queueCounts(captain.key).done === 2,
    5000,
    "both requests completed",
  );
  expect(
    lineOf(fake.received("captain"), "PRIVMSG").map(
      (message) => message.params,
    ),
  ).toEqual(
    expect.arrayContaining([["#ship", expect.stringContaining(followup)]]),
  );
  expect(steers).toHaveLength(1);
  expect(prompts).toHaveLength(2);
  const answer = lineOf(fake.received("captain"), "PRIVMSG").filter(
    (message) =>
      message.params[1]?.includes("Original request done") ||
      message.params[1]?.includes(followup),
  );
  expect(answer.length).toBeGreaterThan(0);
  expect(
    answer.every((message) => message.tags.get("+draft/reply") === root),
  ).toBe(true);
}, 15_000);
