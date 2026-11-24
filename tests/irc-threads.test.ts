import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import pino from "pino";
import {
  type AgentBackend,
  type PromptSourceContext,
  sourceLine,
} from "../src/backends/backend";
import { ircSchema } from "../src/config";
import { Gateway } from "../src/gateway/gateway";
import { IrcShip } from "../src/transports/irc/ship";
import { openStore } from "../src/app/open-store";
import { FakeIrcServer, lineOf, until } from "./irc-fixture";

const cleanup: (() => unknown)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const caps = [
  "sasl=PLAIN",
  "account-tag",
  "message-tags",
  "server-time",
  "batch",
  "echo-message",
  "labeled-response",
];

async function setup(
  offered = caps,
  answer = "First line\nSecond line\nThird line",
) {
  const fake = new FakeIrcServer({
    accounts: { galactica: "fixture-password" },
    caps: offered,
  }).start();

  cleanup.push(() => fake.stop());
  const directory = await mkdtemp(join(tmpdir(), "stargate-irc-threads-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = openStore(join(directory, "stargate.sqlite"));
  cleanup.push(() => store.close());

  const config = Schema.decodeUnknownSync(ircSchema)({
    id: "galactica-irc",
    server: { host: "127.0.0.1", port: fake.port, tls: false },
    account: "galactica",
    passwordEnv: "STARGATE_IRC_PASSWORD",
    channels: ["#galactica"],
    // Isolate framing from the separately recorded pinned-delivery race.
    concurrency: 1,
    access: { deniedAccounts: ["mallory"] },
    backend: {
      type: "opencode",
      url: "http://localhost:4096",
      directory: "/workspace",
      sessionID: "ses_captain",
    },
  });

  const log = pino({ level: "silent" });

  const ship = await IrcShip.create(config, store, log, {
    env: { STARGATE_IRC_PASSWORD: "fixture-password" },
    timing: { reconnectMinMs: 20, intervalMs: 5, burst: 50 },
    readyMs: 2000,
  });

  const prompts: { text: string; context?: PromptSourceContext }[] = [];

  const backend: AgentBackend = {
    sessionID: "ses_captain",
    async createSession() {
      return "ses_captain";
    },
    async prompt(_s, text, _signal, _onText, _onInput, _files, context) {
      prompts.push({ text, ...(context ? { context } : {}) });

      return answer;
    },
    async close() {},
  };

  const captain = ship.registrations[0];

  if (!captain) {
    throw new Error("captain missing");
  }

  const controller = new AbortController();

  const worker = new Gateway(
    captain.settings,
    captain.identity,
    store,
    backend,
    captain.delivery,
    log,
    undefined,
    undefined,
    captain.transport,
  ).work(controller.signal);

  ship.start(() => true);
  cleanup.push(async () => {
    controller.abort();
    await worker;
    await ship.close();
  });
  await until(
    () => captain.client.inChannel("#galactica"),
    5000,
    "thread fixture joined",
  );

  const delivered = (count = 1) =>
    until(
      () =>
        store.queueCounts(captain.key).done === count &&
        // A completed socket write can precede the server's TCP read.
        lineOf(fake.received("galactica"), "PRIVMSG").length ===
          count * answer.split("\n").length,
      5000,
      "thread reply delivered",
    );

  return { fake, captain, prompts, delivered };
}

test("IRC thread: escaped parent reaches source and every fallback line", async () => {
  const { fake, prompts, delivered } = await setup();
  const root = "root;with\\slash=equals";

  const request = fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "galactica: thread status",
    { "+draft/reply": root },
  );

  await delivered();
  const context = prompts[0]?.context;

  if (!context) {
    throw new Error("missing source");
  }

  expect(context.source.message).toBe(request);
  expect(context.source.thread).toBe(request);
  expect(sourceLine(context)).toContain(`;r=${encodeURIComponent(root)}`);
  const lines = lineOf(fake.received("galactica"), "PRIVMSG");
  expect(lines).toHaveLength(3);
  expect(
    lines.every((message) => message.tags.get("+draft/reply") === root),
  ).toBe(true);
  expect(
    fake
      .received("galactica")
      .some((line) =>
        line.includes("+draft/reply=root\\:with\\\\slash=equals"),
      ),
  ).toBe(true);
});

test("IRC thread: every multiline BATCH opener carries the same root", async () => {
  const { fake, delivered } = await setup(
    [...caps, "draft/multiline=max-bytes=4096,max-lines=2"],
    "One\nTwo\nThree\nFour\nFive",
  );

  fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "galactica: threaded",
    { "+draft/reply": "root-batch" },
  );
  await delivered();
  expect(fake.batches).toHaveLength(3);
  expect(
    fake.batches.every(
      (batch) => batch.tags.get("+draft/reply") === "root-batch",
    ),
  ).toBe(true);
  expect(
    lineOf(fake.received("galactica"), "BATCH")
      .filter((message) => message.params[0]?.startsWith("+"))
      .every((message) => message.tags.get("+draft/reply") === "root-batch"),
  ).toBe(true);
});

test("IRC thread: a reply to our threaded answer flattens to its known root", async () => {
  const { fake, captain, prompts, delivered } = await setup();
  fake.sendTo(
    "galactica",
    "@account=galactica;msgid=own-thread-answer;+draft/reply=thread-root :galactica!u@fixture PRIVMSG #galactica :Earlier answer",
  );
  await until(
    () => captain.client.sent("own-thread-answer"),
    2000,
    "own message known",
  );
  fake.say({ nick: "jack", account: "jack" }, "#galactica", "Continue please", {
    "+draft/reply": "own-thread-answer",
  });
  await delivered();
  expect(prompts[0]?.text).toBe("Continue please");
  const context = prompts[0]?.context;

  if (!context) {
    throw new Error("missing source");
  }

  expect(sourceLine(context)).toContain(";r=thread-root");
  expect(
    lineOf(fake.received("galactica"), "PRIVMSG").every(
      (message) => message.tags.get("+draft/reply") === "thread-root",
    ),
  ).toBe(true);
});

test("IRC thread: a mid-message mention starts a thread and tags grant no identity", async () => {
  const { fake, prompts, delivered } = await setup();
  fake.say(
    { nick: "mallory", account: "mallory" },
    "#galactica",
    "galactica: denied",
    { "+draft/reply": "forged-root" },
  );
  fake.say({ nick: "ghost" }, "#galactica", "galactica: unauthenticated", {
    "+draft/reply": "forged-root",
  });

  const request = fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "Could you check the room status, @galactica?",
  );

  await delivered();
  expect(prompts).toHaveLength(1);
  expect(
    lineOf(fake.received("galactica"), "PRIVMSG").map((message) =>
      message.tags.get("+draft/reply"),
    ),
  ).toEqual([request, request, request]);
});

test("IRC thread: no message-tags capability keeps plain authenticated replies", async () => {
  const { fake, prompts, delivered } = await setup([
    "sasl=PLAIN",
    "account-tag",
    "server-time",
  ]);

  fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "galactica: status",
    { "+draft/reply": "retained-thread-root" },
  );
  await delivered();
  expect(prompts).toHaveLength(1);
  // Queue completion records the client write, before the peer receives it.
  await until(
    () => lineOf(fake.received("galactica"), "PRIVMSG").length >= 3,
    5000,
    "plain replies received by the server",
  );
  const lines = lineOf(fake.received("galactica"), "PRIVMSG");
  expect(lines).toHaveLength(3);
  expect(lines.every((message) => !message.tags.has("+draft/reply"))).toBe(
    true,
  );
});

test("IRC thread: threaded DMs stay flat while ordinary DMs keep request tags", async () => {
  const { fake, delivered } = await setup();
  fake.say({ nick: "jack", account: "jack" }, "galactica", "private thread", {
    "+draft/reply": "dm-root",
  });
  await delivered();

  const request = fake.say(
    { nick: "jack", account: "jack" },
    "galactica",
    "ordinary private message",
  );

  await delivered(2);
  const lines = lineOf(fake.received("galactica"), "PRIVMSG");
  expect(lines).toHaveLength(6);
  expect(lines.every((message) => message.params[0] === "jack")).toBe(true);
  expect(
    lines.slice(0, 3).map((message) => message.tags.get("+draft/reply")),
  ).toEqual(["dm-root", "dm-root", "dm-root"]);
  expect(
    lines.slice(3).map((message) => message.tags.get("+draft/reply")),
  ).toEqual([request, request, request]);
});
