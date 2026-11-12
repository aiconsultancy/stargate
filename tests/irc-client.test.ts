import { afterEach, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import pino from "pino";
import { IrcClient, type IrcClientOptions } from "../src/irc/client";
import { IrcDelivery } from "../src/irc/delivery";
import { type IrcMessage, utf8Bytes } from "../src/irc/protocol";
import { FakeIrcServer, lineOf, until } from "./irc-fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const password = "s3cret-password-value";

function logger() {
  const lines: string[] = [];
  const log = pino(
    { level: "trace" },
    new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    }),
  );
  return { log, lines };
}

function start(
  server: FakeIrcServer,
  options: Partial<IrcClientOptions> = {},
  received: IrcMessage[] = [],
  invites: string[] = [],
) {
  const { log, lines } = logger();
  const client = new IrcClient(
    {
      host: "127.0.0.1",
      port: server.port,
      tls: false,
      account: "galactica",
      password,
      nick: "galactica",
      channels: ["#galactica"],
      log,
      timing: {
        reconnectMinMs: 20,
        reconnectMaxMs: 50,
        refusedMs: 60_000,
        intervalMs: 20,
        burst: 2,
        confirmMs: 1000,
        reclaimMs: 100,
      },
      ...options,
    },
    {
      message: (message) => received.push(message),
      invite: (channel) => {
        invites.push(channel);
        client.join(channel);
      },
    },
  );
  const controller = new AbortController();
  const running = client.run(controller.signal);
  cleanup.push(async () => {
    controller.abort();
    await running;
  });
  return { client, controller, running, lines };
}

function server(options: ConstructorParameters<typeof FakeIrcServer>[0] = {}) {
  const fake = new FakeIrcServer({
    accounts: { galactica: password },
    ...options,
  }).start();
  cleanup.push(() => fake.stop());
  return fake;
}

test("irc client: CAP, SASL PLAIN, registration and allowed joins only", async () => {
  const fake = server();
  const received: IrcMessage[] = [];
  const { client, lines } = start(fake, {}, received);
  await client.waitReady(2000);
  await until(() => client.inChannel("#galactica"), 2000, "join");
  const sent = fake.received("galactica");
  expect(sent[0]).toBe("CAP LS 302");
  const requested = lineOf(sent, "CAP")
    .filter((m) => m.params[0] === "REQ")
    .map((m) => m.params[1]);
  expect(requested).toEqual(
    expect.arrayContaining([
      "sasl",
      "account-tag",
      "labeled-response",
      "draft/chathistory",
    ]),
  );
  expect(sent).toContain("AUTHENTICATE PLAIN");
  expect(lineOf(sent, "JOIN").map((m) => m.params[0])).toEqual(["#galactica"]);
  expect(client.hasCap("echo-message")).toBe(true);
  // ISUPPORT CASEMAPPING=ascii (Ergo's default) replaces the rfc1459 default.
  expect(client.fold("#Gal[A]")).toBe("#gal[a]");
  // Unlisted channels are refused; an invite elsewhere does not join.
  expect(client.join("#elsewhere")).toBe(false);
  fake.sendTo("galactica", ":jack!u@h INVITE galactica #elsewhere");
  await delay(50);
  expect(lineOf(fake.received("galactica"), "JOIN")).toHaveLength(1);
  // A server-forced join to an unlisted channel is left at once.
  fake.sendTo("galactica", ":galactica!u@pogo JOIN #forced");
  await until(
    () => fake.received("galactica").includes("PART #forced"),
    2000,
    "part forced channel",
  );
  expect(client.inChannel("#forced")).toBe(false);
  // Credentials never reach the log.
  expect(lines.join("")).not.toContain(password);
  expect(lines.join("")).not.toContain(
    Buffer.from(password).toString("base64"),
  );
  fake.say({ nick: "jack", account: "jack" }, "#galactica", "hello galactica");
  await until(() => received.length === 1, 2000, "message");
  expect(received[0]?.tags.get("account")).toBe("jack");
});

test("irc client: labeled sends confirm on echo and fail on errors", async () => {
  const fake = server();
  const received: IrcMessage[] = [];
  const { client } = start(fake, {}, received);
  await client.waitReady(2000);
  await until(() => client.inChannel("#galactica"), 2000, "join");
  await client.privmsg("#galactica", "first line", { "+draft/reply": "m9" });
  const echoed = lineOf(fake.received("galactica"), "PRIVMSG")[0];
  expect(echoed?.tags.get("+draft/reply")).toBe("m9");
  expect(echoed?.tags.get("label")).toMatch(/^pogo\d+$/);
  // The labeled echo is a confirmation, not new input, and marks our msgid.
  expect(received).toHaveLength(0);
  expect(client.sent("m1")).toBe(true);
  // A channel the server refuses: labeled 404 rejects the send.
  await expect(client.privmsg("#nowhere", "x")).rejects.toThrow("refused");
  await client.tagmsg("#galactica", {
    "+draft/react": "👀",
    "+draft/reply": "m1",
  });
  expect(lineOf(fake.received("galactica"), "TAGMSG")).toHaveLength(1);
});

test("irc client: unlabeled servers resolve on write; throttle spaces lines", async () => {
  const fake = server({
    caps: ["sasl=PLAIN", "account-tag", "message-tags", "server-time"],
  });
  const { client } = start(fake);
  await client.waitReady(2000);
  await until(() => client.inChannel("#galactica"), 2000, "join");
  const started = Date.now();
  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      client.privmsg("#galactica", `line ${i}`),
    ),
  );
  // Burst 2 (one token went to JOIN), then one line per 20 ms.
  expect(Date.now() - started).toBeGreaterThanOrEqual(60);
  await until(
    () => lineOf(fake.received("galactica"), "PRIVMSG").length === 6,
    2000,
    "all lines",
  );
  const lines = lineOf(fake.received("galactica"), "PRIVMSG");
  expect(lines.map((m) => m.params[1])).toEqual(
    Array.from({ length: 6 }, (_, i) => `line ${i}`),
  );
  expect(lines.every((m) => !m.tags.has("label"))).toBe(true);
});

test("irc client: refused SASL and missing account-tag never register", async () => {
  const wrong = server({ accounts: { galactica: "other" } });
  const first = start(wrong);
  await expect(first.client.waitReady(300)).rejects.toThrow("unavailable");
  await until(
    () => first.lines.join("").includes("IRC SASL authentication failed"),
    2000,
    "refusal log",
  );
  expect(first.lines.join("")).not.toContain(password);
  expect(lineOf(wrong.received("galactica"), "JOIN")).toHaveLength(0);

  const plain = server({ caps: ["sasl=PLAIN", "message-tags"] });
  const second = start(plain);
  await until(
    () => second.lines.join("").includes("lacks SASL PLAIN or account-tag"),
    2000,
    "capability refusal",
  );
  expect(plain.received("galactica")).not.toContain("AUTHENTICATE PLAIN");
});

test("irc client: reconnects with backoff, rejoins and reclaims its nick", async () => {
  const fake = server({ taken: ["galactica"] });
  const { client } = start(fake);
  await client.waitReady(2000);
  expect(client.nick).toBe("galactica_");
  // The configured nick becomes free: the reclaim timer takes it back.
  fake.taken.clear();
  await until(() => client.nick === "galactica", 3000, "nick reclaim");
  fake.drop("galactica");
  await until(() => !client.registered, 2000, "disconnect");
  await expect(client.privmsg("#galactica", "x")).rejects.toThrow(
    "unavailable",
  );
  await client.waitReady(3000);
  await until(() => client.inChannel("#galactica"), 3000, "rejoin");
  expect(
    fake.clients.filter((c) => c.account === "galactica").length,
  ).toBeGreaterThanOrEqual(2);
});

test("irc client: answers PING, replays history after reconnect, QUITs on abort", async () => {
  const fake = server();
  const { client, controller, running } = start(fake);
  await client.waitReady(2000);
  await until(() => client.inChannel("#galactica"), 2000, "join");
  fake.sendTo("galactica", "PING :check");
  await until(
    () => fake.received("galactica").includes("PONG check"),
    2000,
    "pong",
  );
  fake.say({ nick: "jack", account: "jack" }, "#galactica", "seen");
  await delay(30);
  fake.drop("galactica");
  await until(
    () => lineOf(fake.received("galactica"), "CHATHISTORY").length === 1,
    3000,
    "chathistory replay",
  );
  const replay = lineOf(fake.received("galactica"), "CHATHISTORY")[0];
  expect(replay?.params.slice(0, 2)).toEqual(["AFTER", "#galactica"]);
  expect(replay?.params[2]).toMatch(/^timestamp=\d{4}-/);
  controller.abort();
  await running;
  await until(
    () => fake.received("galactica").at(-1) === "QUIT :Pogo shutting down",
    2000,
    "quit",
  );
});

test("irc client: silence past the timeout reconnects", async () => {
  const fake = server();
  const { client } = start(fake, {
    timing: {
      pingMs: 100,
      timeoutMs: 300,
      reconnectMinMs: 20,
      reconnectMaxMs: 50,
    },
  });
  await client.waitReady(2000);
  fake.mute("galactica");
  await until(
    () => fake.received("galactica").includes("PING :pogo"),
    3000,
    "keepalive ping",
  );
  // No answer to the keepalive: the connection closes and a new one registers.
  await until(
    () => fake.clients.filter((c) => c.registered).length === 2,
    3000,
    "reconnect after timeout",
  );
});

test("irc client: a stalled registration reconnects; abort ends the loop", async () => {
  let accepted = 0;
  const silentServer = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open() {
        accepted++;
      },
      data() {},
    },
  });
  cleanup.push(() => silentServer.stop(true));
  const { log } = logger();
  const client = new IrcClient({
    host: "127.0.0.1",
    port: silentServer.port,
    tls: false,
    account: "galactica",
    password,
    nick: "galactica",
    channels: [],
    log,
    timing: { registerMs: 100, reconnectMinMs: 10, reconnectMaxMs: 20 },
  });
  const controller = new AbortController();
  const running = client.run(controller.signal);
  await until(() => accepted >= 2, 3000, "second attempt");
  await expect(client.waitReady(50)).rejects.toThrow("unavailable");
  const stopped = Date.now();
  controller.abort();
  await running;
  expect(Date.now() - stopped).toBeLessThan(2500);
});

test("irc client: JOIN lines stay within 512 bytes for many long channels", async () => {
  // The schema maximum: 20 channels of 50 bytes each.
  const channels = Array.from(
    { length: 20 },
    (_, i) => `#${String(i).padStart(2, "0")}${"c".repeat(47)}`,
  );
  const fake = server();
  const { client } = start(fake, { channels });
  await client.waitReady(2000);
  await until(
    () => channels.every((channel) => client.inChannel(channel)),
    3000,
    "every channel joined",
  );
  const joins = fake
    .received("galactica")
    .filter((line) => line.startsWith("JOIN "));
  for (const line of joins)
    expect(utf8Bytes(line) + 2).toBeLessThanOrEqual(512);
  expect(joins.flatMap((line) => line.slice(5).split(",")).sort()).toEqual(
    [...channels].sort(),
  );
});

test("irc client: a configured network name must match ISUPPORT NETWORK", async () => {
  const fake = server();
  const matching = start(fake, { network: "fleet" });
  await matching.client.waitReady(2000);
  const other = server();
  const wrong = start(other, { network: "Other" });
  await until(
    () => wrong.lines.join("").includes("IRC network name differs"),
    2000,
    "network refusal",
  );
  await expect(wrong.client.waitReady(100)).rejects.toThrow("unavailable");
  // Nothing was joined on the wrong network.
  expect(lineOf(other.received("galactica"), "JOIN")).toHaveLength(0);
});

test("irc client: direct messages go only to a nick proven to hold the account", async () => {
  const fake = server();
  const received: IrcMessage[] = [];
  const { client } = start(fake, {}, received);
  await client.waitReady(2000);
  await until(() => client.inChannel("#galactica"), 2000, "join");
  // alice writes from the nick "ally": a binding alice ↔ ally is learned.
  fake.say({ nick: "ally", account: "alice" }, "galactica", "hi");
  await until(() => received.length === 1, 2000, "direct message");
  expect(await client.verifiedNick("alice")).toBe("ally");
  // No QUIT or NICK reaches us (no shared channel); mallory now holds "ally".
  fake.setUser("ally", "mallory");
  await expect(client.verifiedNick("alice")).rejects.toThrow("recipient");
  // A nick without a logged-in account is never a recipient either.
  fake.setUser("alice", null);
  await expect(client.verifiedNick("alice")).rejects.toThrow("recipient");
  fake.setUser("alice", "alice");
  expect(await client.verifiedNick("alice")).toBe("alice");
  // Events drop both directions of a binding: after the holder quits and
  // another account takes the nick, the old account has no binding left.
  fake.say({ nick: "bobby", account: "bob" }, "#galactica", "hello");
  await until(() => received.length === 2, 2000, "channel message");
  expect(client.boundNick("bob")).toBe("bobby");
  fake.sendTo("galactica", ":bobby!u@h QUIT :bye");
  await until(() => client.boundNick("bob") === undefined, 2000, "unbind");
  fake.sendTo("galactica", ":carol!u@h JOIN #galactica carol :Carol");
  fake.sendTo("galactica", ":carol!u@h NICK bobby");
  await until(() => client.boundNick("carol") === "bobby", 2000, "rebind");
  expect(client.boundNick("bob")).toBeUndefined();
  fake.sendTo("galactica", ":bobby!u@h ACCOUNT *");
  await until(() => client.boundNick("carol") === undefined, 2000, "logout");
});

test("irc delivery: a queued direct line is dropped if its recipient quits first", async () => {
  const fake = server();
  const received: IrcMessage[] = [];
  const { client } = start(
    fake,
    {
      timing: {
        burst: 1,
        intervalMs: 600,
        reconnectMinMs: 20,
        reconnectMaxMs: 50,
        confirmMs: 3000,
      },
    },
    received,
  );
  await client.waitReady(2000);
  await until(() => client.inChannel("#galactica"), 2000, "join");
  fake.say({ nick: "jackie", account: "jack" }, "galactica", "status?");
  await until(() => received.length === 1, 2000, "direct message");
  // Let the token bucket refill: WHOIS takes the only token, so the
  // reply line waits in the send queue for the next interval.
  await delay(700);
  const delivery = new IrcDelivery(client, 2000);
  const posting = delivery.post("jack", "m1", "Private answer.");
  const outcome = posting.then(
    () => "sent",
    (error: unknown) => String(error),
  );
  await until(
    () => fake.received("galactica").includes("WHOIS jackie"),
    2000,
    "whois",
  );
  await until(() => client.boundNick("jack") === "jackie", 2000, "verified");
  // jack quits while the line is queued; mallory takes the nick at once.
  fake.sendTo("galactica", ":jackie!u@h QUIT :gone");
  fake.setUser("jackie", "mallory");
  expect(await outcome).toContain("recipient");
  await delay(700);
  expect(
    lineOf(fake.received("galactica"), "PRIVMSG").filter(
      (m) => m.params[0] === "jackie",
    ),
  ).toHaveLength(0);
});

test("irc client: crew join only channels the captain also has, per CASEMAPPING", async () => {
  // The fake server announces CASEMAPPING=ascii: #ship{1} is not #ship[1].
  const fake = server();
  const invites: string[] = [];
  const { client } = start(
    fake,
    {
      channels: ["#ship{1}", "#galactica"],
      captainChannels: ["#ship[1]", "#Galactica"],
    },
    [],
    invites,
  );
  await client.waitReady(2000);
  await until(() => client.inChannel("#galactica"), 2000, "ship channel");
  expect(client.channel("#ship{1}")).toBeUndefined();
  fake.sendTo("galactica", ":jack!u@h INVITE galactica #ship{1}");
  fake.sendTo("galactica", ":galactica!u@pogo JOIN #ship{1}");
  await until(
    () => fake.received("galactica").includes("PART #ship{1}"),
    2000,
    "part",
  );
  expect(
    lineOf(fake.received("galactica"), "JOIN").flatMap((m) =>
      (m.params[0] ?? "").split(","),
    ),
  ).toEqual(["#galactica"]);
  expect(client.inChannel("#ship{1}")).toBe(false);
});
