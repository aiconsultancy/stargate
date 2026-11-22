import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import pino from "pino";
import type { AgentBackend } from "../src/backends/backend";
import { ircSchema } from "../src/config";
import { Gateway } from "../src/gateway/gateway";
import { fold, parseMessage } from "../src/irc/protocol";
import { routeIrcStop } from "../src/irc/routing";
import { IrcShip } from "../src/irc/ship";
import { openStore } from "../src/app/open-store";
import { FakeIrcServer, lineOf, until } from "./irc-fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function config(port: number, extra: Record<string, unknown> = {}) {
  return Schema.decodeUnknownSync(ircSchema)({
    id: "galactica-irc",
    server: { host: "127.0.0.1", port, tls: false },
    account: "galactica",
    passwordEnv: "STARGATE_IRC_GALACTICA",
    channels: ["#galactica"],
    access: { deniedAccounts: ["mallory"], peerCaptains: ["defiant"] },
    crew: [
      {
        id: "chief",
        account: "galactica-chief",
        passwordEnv: "STARGATE_IRC_GALACTICA_CHIEF",
        channels: ["#galactica"],
        backend: {
          type: "opencode",
          url: "http://localhost:4096",
          directory: "/workspace",
        },
      },
    ],
    backend: {
      type: "opencode",
      url: "http://localhost:4096",
      directory: "/workspace",
      sessionID: "ses_captain",
    },
    ...extra,
  });
}

async function setup(extra: Record<string, unknown> = {}, answer = "Done.") {
  const fake = new FakeIrcServer({
    accounts: { galactica: "captain-pass", "galactica-chief": "chief-pass" },
  }).start();
  cleanup.push(() => fake.stop());
  const directory = await mkdtemp(join(tmpdir(), "stargate-irc-stop-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = openStore(join(directory, "stargate.sqlite"));
  cleanup.push(() => store.close());
  const ship = await IrcShip.create(
    config(fake.port, extra),
    store,
    pino({ level: "silent" }),
    {
      env: {
        STARGATE_IRC_GALACTICA: "captain-pass",
        STARGATE_IRC_GALACTICA_CHIEF: "chief-pass",
      },
      timing: { reconnectMinMs: 20, intervalMs: 5, burst: 50 },
      readyMs: 2000,
    },
  );
  const aborted: string[] = [];
  let release = Promise.withResolvers<void>();
  const backend: AgentBackend = {
    sessionID: "ses_captain",
    async createSession() {
      return "ses_captain";
    },
    async prompt(_s, text, signal) {
      const abort = Promise.withResolvers<void>();
      signal.addEventListener("abort", () => abort.resolve(), { once: true });
      await Promise.race([release.promise, abort.promise]);
      if (signal.aborted) {
        aborted.push(text);
        throw new Error("aborted");
      }
      return answer;
    },
    async close() {},
  };
  const [captain] = ship.registrations;
  if (!captain) throw new Error("missing captain");
  const controller = new AbortController();
  const gateway = new Gateway(
    captain.settings,
    captain.identity,
    store,
    backend,
    captain.delivery,
    captain.log,
    undefined,
    undefined,
    captain.transport,
  );
  captain.stopTurn = (conversation, thread) =>
    gateway.stopTurn(conversation, thread);
  const worker = gateway.work(controller.signal);
  ship.start(() => true);
  cleanup.push(async () => {
    release.resolve();
    controller.abort();
    await worker;
    await ship.close();
  });
  await until(() => captain.client.inChannel("#galactica"), 5000, "joined");
  return {
    fake,
    store,
    captain,
    aborted,
    finish: () => {
      release.resolve();
      release = Promise.withResolvers<void>();
    },
  };
}

function react(
  fake: FakeIrcServer,
  from: { nick: string; account?: string },
  target: string,
  msgid: string,
  emoji: string,
  key = "+draft/react",
) {
  const line = `@${from.account ? `account=${from.account};` : ""}${key}=${emoji};+draft/reply=${msgid} :${from.nick}!u@outside TAGMSG ${target}`;
  for (const client of fake.clients)
    if (client.registered) client.socket.write(`${line}\r\n`);
}

test("irc stop: a ✋ reaction on the request cancels the running turn", async () => {
  const { fake, store, captain, aborted } = await setup();
  const request = fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "galactica: long job",
  );
  await until(
    () => store.queueCounts(captain.key).running === 1,
    5000,
    "running",
  );
  react(fake, { nick: "jack", account: "jack" }, "#galactica", request, "✋");
  await until(() => aborted.length === 1, 5000, "backend aborted");
  await until(() => store.queueCounts(captain.key).done === 1, 5000, "settled");
  const replies = lineOf(fake.received("galactica"), "PRIVMSG").map(
    (m) => m.params[1],
  );
  expect(replies.some((text) => /stop/i.test(text ?? ""))).toBe(true);
  expect(replies).not.toContain("Done.");
});

test("irc stop: emoji variants count; other reactions, ship, peer, denied and unreact do not", async () => {
  const { fake, store, captain, aborted, finish } = await setup();
  const request = fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "galactica: long job",
  );
  await until(
    () => store.queueCounts(captain.key).running === 1,
    5000,
    "running",
  );
  react(fake, { nick: "jack", account: "jack" }, "#galactica", request, "👍");
  react(
    fake,
    { nick: "galactica-chief", account: "galactica-chief" },
    "#galactica",
    request,
    "✋",
  );
  react(
    fake,
    { nick: "defiant", account: "defiant" },
    "#galactica",
    request,
    "✋",
  );
  react(
    fake,
    { nick: "mallory", account: "mallory" },
    "#galactica",
    request,
    "✋",
  );
  react(fake, { nick: "ghost" }, "#galactica", request, "✋");
  react(
    fake,
    { nick: "jack", account: "jack" },
    "#galactica",
    request,
    "✋",
    "+draft/unreact",
  );
  react(
    fake,
    { nick: "jack", account: "jack" },
    "#galactica",
    "unrelated",
    "✋",
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(aborted).toHaveLength(0);
  // Skin tone and variation selector forms of the configured emoji work.
  react(fake, { nick: "jack", account: "jack" }, "#galactica", request, "✋🏽");
  await until(() => aborted.length === 1, 5000, "aborted");
  finish();
  const second = fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "galactica: another",
  );
  await until(
    () => store.queueCounts(captain.key).running === 1,
    5000,
    "running again",
  );
  react(
    fake,
    { nick: "jack", account: "jack" },
    "#galactica",
    second,
    "🛑\ufe0f",
  );
  await until(() => aborted.length === 2, 5000, "aborted again");
});

test("irc stop: configurable reactions; features.reactions off disables Stop", async () => {
  const custom = await setup({ stopReactions: ["❌"] });
  const request = custom.fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "galactica: job",
  );
  await until(
    () => custom.store.queueCounts(custom.captain.key).running === 1,
    5000,
    "running",
  );
  react(
    custom.fake,
    { nick: "jack", account: "jack" },
    "#galactica",
    request,
    "✋",
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(custom.aborted).toHaveLength(0);
  react(
    custom.fake,
    { nick: "jack", account: "jack" },
    "#galactica",
    request,
    "❌",
  );
  await until(() => custom.aborted.length === 1, 5000, "aborted");

  const off = await setup({ features: { reactions: false } });
  const job = off.fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "galactica: job",
  );
  await until(
    () => off.store.queueCounts(off.captain.key).running === 1,
    5000,
    "running",
  );
  react(off.fake, { nick: "jack", account: "jack" }, "#galactica", job, "✋");
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(off.aborted).toHaveLength(0);
  expect(off.captain.delivery.react).toBeUndefined();
});

test("irc stop: a reaction on a bot message stops the turn that message answers", () => {
  const parsed = parseMessage(
    "@account=jack;+draft/react=🛑;+draft/reply=bot-1 :jack!u@h TAGMSG #galactica",
  );
  if (!parsed) throw new Error("fixture");
  const stop = routeIrcStop(parsed, {
    config: config(6667),
    member: {
      id: "galactica-irc",
      role: "captain",
      account: "galactica",
      nick: "galactica",
      channels: ["#galactica"],
      key: "k",
    },
    currentNick: "galactica",
    fold: (value) => fold(value),
    anchor: (msgid) => (msgid === "bot-1" ? "request-1" : undefined),
  });
  expect(stop).toEqual({
    conversation: JSON.stringify(["k", "#galactica"]),
    thread: "request-1",
  });
});
