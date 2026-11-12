import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { AgentBackend } from "../src/backend";
import { ircSchema } from "../src/config";
import { Gateway } from "../src/gateway";
import { IrcShip } from "../src/irc/ship";
import { Store } from "../src/store";
import { FakeIrcServer, lineOf, until } from "./irc-fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(
  options: { caps?: string[]; features?: Record<string, boolean> } = {},
) {
  const fake = new FakeIrcServer({
    accounts: { galactica: "captain-pass" },
    ...(options.caps ? { caps: options.caps } : {}),
  }).start();
  cleanup.push(() => fake.stop());
  const directory = await mkdtemp(join(tmpdir(), "pogo-irc-typing-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, "pogo.sqlite"));
  cleanup.push(() => store.close());
  const config = ircSchema.parse({
    id: "galactica-irc",
    server: { host: "127.0.0.1", port: fake.port, tls: false },
    account: "galactica",
    passwordEnv: "POGO_IRC_GALACTICA",
    channels: ["#galactica"],
    ...(options.features ? { features: options.features } : {}),
    backend: {
      type: "opencode",
      url: "http://localhost:4096",
      directory: "/workspace",
      sessionID: "ses_captain",
    },
  });
  const ship = await IrcShip.create(config, store, pino({ level: "silent" }), {
    env: { POGO_IRC_GALACTICA: "captain-pass" },
    timing: { reconnectMinMs: 20, intervalMs: 5, burst: 50, typingMs: 100 },
    readyMs: 2000,
  });
  let release = Promise.withResolvers<void>();
  const backend: AgentBackend = {
    sessionID: "ses_captain",
    async createSession() {
      return "ses_captain";
    },
    async prompt() {
      await release.promise;
      release = Promise.withResolvers<void>();
      return "Done.";
    },
    async close() {},
  };
  const [captain] = ship.registrations;
  if (!captain) throw new Error("missing captain");
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
    release.resolve();
    controller.abort();
    await worker;
    await ship.close();
  });
  await until(() => captain.client.inChannel("#galactica"), 5000, "joined");
  return { fake, store, captain, finish: () => release.resolve() };
}

const typing = (lines: readonly string[], target: string) =>
  lineOf(lines, "TAGMSG")
    .filter((m) => m.params[0] === target)
    .map((m) => m.tags.get("+typing"));

test("irc typing: active while a turn runs, refreshed, then done before the reply", async () => {
  const { fake, store, captain, finish } = await setup();
  fake.say({ nick: "jack", account: "jack" }, "#galactica", "galactica: think");
  await until(
    () => typing(fake.received("galactica"), "#galactica").length >= 3,
    3000,
    "refresh",
  );
  finish();
  await until(() => store.queueCounts(captain.key).done === 1, 5000, "done");
  const sent = fake
    .received("galactica")
    .map((line) => line.replace(/^@\S+ /, ""))
    .filter(
      (line) =>
        line.startsWith("TAGMSG #galactica") ||
        line.startsWith("PRIVMSG #galactica"),
    );
  const states = typing(fake.received("galactica"), "#galactica");
  expect(states.slice(0, -1).every((state) => state === "active")).toBe(true);
  expect(states.at(-1)).toBe("done");
  // done is sent before the reply text.
  expect(sent.at(-1)).toBe("PRIVMSG #galactica Done.");
  expect(sent.at(-2)).toBe("TAGMSG #galactica");
});

test("irc typing: direct messages type to the requester's verified nick", async () => {
  const { fake, store, captain, finish } = await setup();
  fake.say({ nick: "jackie", account: "jack" }, "galactica", "think");
  await until(
    () => typing(fake.received("galactica"), "jackie").length >= 1,
    3000,
    "typing",
  );
  finish();
  await until(() => store.queueCounts(captain.key).done === 1, 5000, "done");
  expect(typing(fake.received("galactica"), "jackie").at(-1)).toBe("done");
});

test("irc typing: stops when the direct nick changes hands", async () => {
  const { fake, store, captain, finish } = await setup();
  fake.say({ nick: "jackie", account: "jack" }, "galactica", "think");
  await until(
    () => typing(fake.received("galactica"), "jackie").length >= 2,
    3000,
    "typing",
  );
  // jackie quits; another account takes the nick.
  fake.sendTo("galactica", ":jackie!u@outside QUIT :bye");
  fake.sendTo("galactica", ":carol!u@h JOIN #galactica carol :Carol");
  fake.sendTo("galactica", ":carol!u@h NICK jackie");
  await until(
    () => captain.client.boundNick("carol") === "jackie",
    2000,
    "nick taken",
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const before = typing(fake.received("galactica"), "jackie").length;
  await new Promise((resolve) => setTimeout(resolve, 500));
  finish();
  await until(() => store.queueCounts(captain.key).running === 0, 5000, "end");
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Neither active nor done follows the nick to carol.
  expect(typing(fake.received("galactica"), "jackie")).toHaveLength(before);
});

test("irc typing: off without message-tags or with features.typing false", async () => {
  for (const options of [
    {
      caps: [
        "sasl=PLAIN",
        "account-tag",
        "server-time",
        "batch",
        "labeled-response",
      ],
    },
    { features: { typing: false } },
  ]) {
    const { fake, store, captain, finish } = await setup(options);
    fake.say(
      { nick: "jack", account: "jack" },
      "#galactica",
      "galactica: think",
    );
    await until(
      () => store.queueCounts(captain.key).running === 1,
      3000,
      "running",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    finish();
    await until(() => store.queueCounts(captain.key).done === 1, 5000, "done");
    expect(lineOf(fake.received("galactica"), "TAGMSG")).toHaveLength(0);
  }
});
