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
import { FakeIrcServer, until } from "./irc-fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const hour = 60 * 60_000;

async function world() {
  const fake = new FakeIrcServer({
    accounts: { galactica: "captain-pass", jack: "jack-pass" },
  }).start();
  cleanup.push(() => fake.stop());
  const directory = await mkdtemp(join(tmpdir(), "stargate-irc-catchup-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, "stargate.sqlite"));
  cleanup.push(() => store.close());
  return { fake, store };
}

/** One Stargate lifetime: a ship and its gateway on a shared store. */
async function run(
  fake: FakeIrcServer,
  store: Store,
  extra: Record<string, unknown> = {},
) {
  const config = Schema.decodeUnknownSync(ircSchema)({
    id: "galactica-irc",
    server: { host: "127.0.0.1", port: fake.port, tls: false },
    account: "galactica",
    passwordEnv: "STARGATE_IRC_GALACTICA",
    channels: ["#galactica"],
    backend: {
      type: "opencode",
      url: "http://localhost:4096",
      directory: "/workspace",
      sessionID: "ses_captain",
    },
    ...extra,
  });
  const ship = await IrcShip.create(config, store, pino({ level: "silent" }), {
    env: { STARGATE_IRC_GALACTICA: "captain-pass" },
    timing: { reconnectMinMs: 20, intervalMs: 5, burst: 50 },
    readyMs: 2000,
  });
  const prompts: string[] = [];
  const backend: AgentBackend = {
    sessionID: "ses_captain",
    async createSession() {
      return "ses_captain";
    },
    async prompt(_s, text) {
      prompts.push(text);
      return "[[stargate:silent]]";
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
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    controller.abort();
    await worker;
    await ship.close();
  };
  cleanup.push(close);
  await until(() => captain.client.inChannel("#galactica"), 5000, "joined");
  return { captain, prompts, close };
}

test("irc catch-up: messages sent while Stargate was stopped are admitted once", async () => {
  const { fake, store } = await world();
  const first = await run(fake, store);
  fake.say({ nick: "jack", account: "jack" }, "#galactica", "just chatting");
  await until(
    () => store.ircCursor(first.captain.key, "#galactica") !== undefined,
    3000,
    "cursor",
  );
  await first.close();
  // CHATHISTORY AFTER excludes an event in the cursor's same millisecond.
  await until(
    () => {
      const cursor = store.ircCursor(first.captain.key, "#galactica");
      return cursor !== undefined && Date.now() > Date.parse(cursor);
    },
    3000,
    "offline events after cursor",
  );
  // Stargate is down: a mention and a direct message arrive.
  fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "galactica: missed mention",
  );
  fake.say(
    { nick: "jack", account: "jack" },
    "galactica",
    "missed direct message",
  );
  const second = await run(fake, store);
  await until(() => second.prompts.length === 2, 5000, "caught up");
  expect(second.prompts.sort()).toEqual([
    "missed direct message",
    "missed mention",
  ]);
  expect(fake.historyRequests.map((request) => request[0])).toEqual(
    expect.arrayContaining(["AFTER", "TARGETS"]),
  );
  // A third start replays the same history again: nothing is admitted twice.
  await second.close();
  const third = await run(fake, store);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(third.prompts).toEqual([]);
});

test("irc catch-up: each direct-message partner keeps its own cursor", async () => {
  const { fake, store } = await world();
  // First start: the direct-message baseline is set.
  const first = await run(fake, store);
  await first.close();
  await Bun.sleep(5);
  fake.say({ nick: "bob", account: "bob" }, "galactica", "from bob while away");
  await Bun.sleep(5);
  // Second start: history is not answered yet when alice writes live, and
  // Stargate stops before bob's messages are replayed.
  fake.holdHistory = true;
  const second = await run(fake, store);
  fake.say({ nick: "alice", account: "alice" }, "galactica", "live from alice");
  await until(() => second.prompts.length === 1, 5000, "alice admitted");
  await second.close();
  fake.holdHistory = false;
  const asked = fake.historyRequests.length;
  // Alice's newer message must not hide bob's older one.
  const third = await run(fake, store);
  await until(
    () => third.prompts.includes("from bob while away"),
    5000,
    "bob replayed",
  );
  await Bun.sleep(200);
  expect(third.prompts).toEqual(["from bob while away"]);
  // Alice has nothing newer than her cursor: no AFTER request for her.
  expect(
    fake.historyRequests
      .slice(asked)
      .filter((request) => request[0] === "AFTER")
      .map((request) => request[1]),
  ).toEqual(["#galactica", "bob"]);
});

test("irc catch-up: bounded age, no backlog on a first start, switch off", async () => {
  const { fake, store } = await world();
  const old = new Date(Date.now() - 30 * hour).toISOString();
  const recent = new Date(Date.now() - hour).toISOString();
  fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "galactica: before Stargate existed",
    {
      time: recent,
      msgid: "pre-1",
    },
  );
  // First start: no cursor, so existing history is a baseline, not a backlog.
  const first = await run(fake, store);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(first.prompts).toEqual([]);
  await first.close();
  // A cursor 2 days old: only the last 24 hours are replayed.
  store.saveIrcCursor(
    first.captain.key,
    "#galactica",
    new Date(Date.now() - 48 * hour).toISOString(),
    true,
  );
  fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "galactica: too old",
    {
      time: old,
      msgid: "old-1",
    },
  );
  fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "galactica: recent enough",
    {
      time: new Date(Date.now() - 2 * hour).toISOString(),
      msgid: "recent-1",
    },
  );
  const second = await run(fake, store);
  await until(() => second.prompts.length >= 2, 5000, "replayed");
  await new Promise((resolve) => setTimeout(resolve, 200));
  // The window is the last 24 hours, whatever the cursor says.
  expect(second.prompts.sort()).toEqual([
    "before Stargate existed",
    "recent enough",
  ]);
  await second.close();
  // features.catchUp off: no CHATHISTORY at all.
  const requests = fake.historyRequests.length;
  fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "galactica: while off",
  );
  const off = await run(fake, store, { features: { catchUp: false } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(off.prompts).toEqual([]);
  expect(fake.historyRequests.length).toBe(requests);
});

test("IRC nick-mention mode drops reconnect and unsolicited history, and deduplicates live msgids", async () => {
  const { fake, store } = await world();
  const options = {
    access: { allowedAccounts: ["jack"], channelRequests: "nick-mention" },
  };
  const sender = { nick: "jack", account: "jack" };
  const first = await run(fake, store, options);
  fake.say(sender, "#galactica", "galactica: live one");
  await until(() => first.prompts.length === 1, 5000, "first live request");
  await first.close();
  fake.say(sender, "#galactica", "galactica: missed channel");
  fake.say(sender, "galactica", "missed DM");

  const second = await run(fake, store, options);
  await until(
    () => fake.historyRequests.some(([type]) => type === "AFTER"),
    5000,
    "history",
  );
  fake.sendTo("galactica", ":fake BATCH +autoplay chathistory #galactica");
  fake.sendTo(
    "galactica",
    "@batch=autoplay;account=jack;msgid=autoplay-1 :jack!u@h PRIVMSG #galactica :galactica: unsolicited replay",
  );
  fake.sendTo("galactica", ":fake BATCH -autoplay");
  fake.say({ nick: "jack", account: "impostor" }, "galactica", "untrusted DM");
  const id = fake.say(sender, "galactica", "live two");
  fake.say(sender, "galactica", "live two", { msgid: id });
  await until(() => second.prompts.length === 1, 5000, "second live request");
  await until(
    () => store.queueCounts(second.captain.key).done === 2,
    5000,
    "two requests completed",
  );
  expect(second.prompts).toEqual(["live two"]);
});
