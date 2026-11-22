import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import pino from "pino";
import type { AgentBackend } from "../src/backend";
import { ircSchema } from "../src/config";
import { Gateway } from "../src/gateway/gateway";
import { IrcShip } from "../src/irc/ship";
import { Store } from "../src/gateway/store";
import { FakeIrcServer, lineOf, until } from "./irc-fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const caps = [
  "sasl=PLAIN",
  "account-tag",
  "message-tags",
  "server-time",
  "batch",
  "echo-message",
  "labeled-response",
  "draft/persistence",
  "draft/read-marker",
];

async function setup(features?: Record<string, boolean>) {
  const fake = new FakeIrcServer({
    accounts: { galactica: "captain-pass", "galactica-chief": "chief-pass" },
    caps,
    isupport: ["BOT=B"],
  }).start();
  cleanup.push(() => fake.stop());
  const directory = await mkdtemp(join(tmpdir(), "stargate-irc-presence-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, "stargate.sqlite"));
  cleanup.push(() => store.close());
  const config = Schema.decodeUnknownSync(ircSchema)({
    id: "galactica-irc",
    server: { host: "127.0.0.1", port: fake.port, tls: false },
    account: "galactica",
    passwordEnv: "STARGATE_IRC_GALACTICA",
    channels: ["#galactica"],
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
    ...(features ? { features } : {}),
    backend: {
      type: "opencode",
      url: "http://localhost:4096",
      directory: "/workspace",
      sessionID: "ses_captain",
    },
  });
  const ship = await IrcShip.create(config, store, pino({ level: "silent" }), {
    env: {
      STARGATE_IRC_GALACTICA: "captain-pass",
      STARGATE_IRC_GALACTICA_CHIEF: "chief-pass",
    },
    timing: { reconnectMinMs: 20, intervalMs: 5, burst: 50 },
    readyMs: 2000,
  });
  const backend: AgentBackend = {
    sessionID: "ses_captain",
    async createSession() {
      return "ses_captain";
    },
    async prompt() {
      return "[[stargate:silent]]";
    },
    async close() {},
  };
  const [captain, chief] = ship.registrations;
  if (!captain || !chief) throw new Error("missing registrations");
  const controller = new AbortController();
  const worker = new Gateway(
    captain.settings,
    captain.identity,
    store,
    backend,
    captain.delivery,
    captain.log,
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
    () =>
      captain.client.inChannel("#galactica") &&
      chief.client.inChannel("#galactica"),
    5000,
    "joined",
  );
  return { fake, store, captain };
}

test("irc presence: always-on and bot mode for captain and crew accounts", async () => {
  const { fake } = await setup();
  for (const account of ["galactica", "galactica-chief"]) {
    await until(
      () => fake.received(account).includes("PERSISTENCE SET ON"),
      3000,
      `${account} always-on`,
    );
    const nick = account;
    await until(
      () => fake.received(account).includes(`MODE ${nick} +B`),
      3000,
      `${account} bot mode`,
    );
  }
});

test("irc presence: MARKREAD only after a message is accepted", async () => {
  const { fake, store, captain } = await setup();
  fake.say({ nick: "jack", account: "jack" }, "#galactica", "just chatting", {
    time: "2026-11-12T10:00:00.000Z",
  });
  fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "galactica: status",
    {
      time: "2026-11-12T10:00:01.000Z",
    },
  );
  fake.say({ nick: "jackie", account: "jack" }, "galactica", "hello", {
    time: "2026-11-12T10:00:02.000Z",
  });
  await until(
    () => store.queueCounts(captain.key).done === 2,
    5000,
    "both turns",
  );
  await until(
    () => lineOf(fake.received("galactica"), "MARKREAD").length === 2,
    3000,
    "markread",
  );
  expect(
    lineOf(fake.received("galactica"), "MARKREAD").map((m) => m.params),
  ).toEqual([
    ["#galactica", "timestamp=2026-11-12T10:00:01.000Z"],
    ["jackie", "timestamp=2026-11-12T10:00:02.000Z"],
  ]);
});

test("irc presence: each switch turns its feature off", async () => {
  const { fake, store, captain } = await setup({
    alwaysOn: false,
    botMode: false,
    readMarker: false,
  });
  fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "galactica: status",
  );
  await until(() => store.queueCounts(captain.key).done === 1, 5000, "turn");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const sent = fake.received("galactica");
  expect(sent.some((line) => line.startsWith("PERSISTENCE"))).toBe(false);
  expect(sent.some((line) => line.startsWith("MODE"))).toBe(false);
  expect(sent.some((line) => line.startsWith("MARKREAD"))).toBe(false);
  expect(captain.client.hasCap("draft/persistence")).toBe(false);
  expect(captain.client.hasCap("draft/read-marker")).toBe(false);
});
