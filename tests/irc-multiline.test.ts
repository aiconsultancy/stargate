import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import pino from "pino";
import type { AgentBackend } from "../src/backends/backend";
import { ircSchema } from "../src/config";
import { Gateway } from "../src/gateway/gateway";
import { utf8Bytes } from "../src/transports/irc/protocol";
import { IrcShip } from "../src/transports/irc/ship";
import { openStore } from "../src/app/open-store";
import { FakeIrcServer, lineOf, until } from "./irc-fixture";

const cleanup: (() => unknown)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const base = [
  "sasl=PLAIN",
  "account-tag",
  "message-tags",
  "server-time",
  "batch",
  "echo-message",
  "labeled-response",
];

async function setup(
  options: {
    maxLines?: number;
    maxBytes?: number;
    multiline?: boolean;
    features?: Record<string, boolean>;
    answer?: (text: string) => string;
  } = {},
) {
  const fake = new FakeIrcServer({
    accounts: { galactica: "captain-pass", jack: "jack-pass" },
    caps: [
      ...base,
      ...(options.multiline === false
        ? []
        : [
            `draft/multiline=max-bytes=${options.maxBytes ?? 4096},max-lines=${options.maxLines ?? 100}`,
          ]),
    ],
  }).start();

  cleanup.push(() => fake.stop());
  const directory = await mkdtemp(join(tmpdir(), "stargate-irc-multiline-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = openStore(join(directory, "stargate.sqlite"));
  cleanup.push(() => store.close());

  // Failed delivery attempts so far: a test waits for an attempt to end
  // Before it changes what the server accepts.
  const db = new Database(join(directory, "stargate.sqlite"), {
    readonly: true,
  });

  cleanup.push(() => db.close());

  const attempts = () =>
    db
      .query<{ n: number }, []>(
        "SELECT COALESCE(MAX(attempts), 0) AS n FROM jobs",
      )
      .get()?.n ?? 0;

  const config = Schema.decodeUnknownSync(ircSchema)({
    id: "galactica-irc",
    server: { host: "127.0.0.1", port: fake.port, tls: false },
    account: "galactica",
    passwordEnv: "STARGATE_IRC_GALACTICA",
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

      return options.answer?.(text) ?? "[[stargate:silent]]";
    },
    async close() {},
  };

  const [captain] = ship.registrations;

  if (!captain) {
    throw new Error("missing captain");
  }

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
  await until(() => captain.client.inChannel("#galactica"), 5000, "joined");

  return { fake, store, captain, prompts, attempts };
}

/** What a multiline-aware client shows for one batch. */
function shown(lines: { text: string; concat: boolean }[]) {
  return lines
    .map((line, index) =>
      index && !line.concat ? `\n${line.text}` : line.text,
    )
    .join("");
}

test("irc multiline: one reply chunk is one batch, long lines concatenated", async () => {
  const long = `Fuel ${"and reactor margins nominal ".repeat(30)}end.`;

  const { fake, store, captain } = await setup({
    answer: () => `# Status\n\n${long}\n\n- tanks: 40%`,
  });

  fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "galactica: status",
  );
  await until(
    () => store.queueCounts(captain.key).done === 1,
    5000,
    "delivered",
  );
  expect(fake.batches).toHaveLength(1);
  const [batch] = fake.batches;
  expect(batch?.target).toBe("#galactica");
  expect(batch?.tags.has("+draft/reply")).toBe(false);
  expect(batch?.tags.get("label")).toMatch(/^stargate\d+$/);
  expect(batch?.lines.filter((line) => line.concat).length).toBeGreaterThan(0);
  expect(shown(batch?.lines ?? [])).toBe(`Status\n${long}\n- tanks: 40%`);

  for (const line of fake.received("galactica")) {
    expect(utf8Bytes(line) + 2).toBeLessThanOrEqual(512);
  }

  // No plain PRIVMSG lines: the whole chunk went in the batch.
  expect(
    lineOf(fake.received("galactica"), "PRIVMSG").filter(
      (m) => !m.tags.has("batch"),
    ),
  ).toHaveLength(0);
});

test("irc multiline: max-lines splits a chunk; a retry resends only undelivered batches", async () => {
  const { fake, store, captain, attempts } = await setup({
    maxLines: 2,
    answer: () => ["one", "two", "three", "four", "five"].join("\n"),
  });

  let accepted = 0;
  fake.onMessage = () => {
    // The first batch arrives; the server refuses everything after it.
    if (++accepted === 1) {
      fake.refuse.add("galactica #galactica");
    }
  };

  fake.say({ nick: "jack", account: "jack" }, "#galactica", "galactica: count");
  await until(
    () => store.queueCounts(captain.key).responding === 1,
    5000,
    "retry pending",
  );
  await until(() => accepted === 1, 5000, "first batch");
  await until(() => attempts() === 1, 5000, "attempt failed");
  fake.refuse.clear();
  await until(() => store.queueCounts(captain.key).done === 1, 8000, "retried");
  expect(fake.batches.map((batch) => shown(batch.lines))).toEqual([
    "one\ntwo",
    "three\nfour",
    "five",
  ]);
}, 15_000);

test("irc multiline: fragments and batches stay within max-bytes at the boundary", async () => {
  const fits = `${"a".repeat(31)}\n${"b".repeat(32)}`;

  const answers: Record<string, string> = {
    t1: fits,
    t2: `${"a".repeat(31)}\n${"b".repeat(33)}`,
    t3: "c".repeat(64),
    t4: "d".repeat(65),
  };

  const { fake, store, captain } = await setup({
    maxBytes: 64,
    answer: (text) => answers[text] ?? "?",
  });

  let turns = 0;

  for (const turn of Object.keys(answers)) {
    fake.say(
      { nick: "jack", account: "jack" },
      "#galactica",
      `galactica: ${turn}`,
    );
    turns++;
    await until(
      () => store.queueCounts(captain.key).done === turns,
      5000,
      `delivered ${turn}`,
    );
  }

  // 31 + line break + 32 = 64 bytes fits one batch; one byte more does not.
  expect(fake.batches.map((batch) => shown(batch.lines))).toEqual([
    fits,
    "a".repeat(31),
    "b".repeat(33),
    "c".repeat(64),
    "d".repeat(64),
    "d",
  ]);
  expect(store.queueCounts(captain.key).failed ?? 0).toBe(0);
}, 20_000);

test("irc multiline: a max-bytes below 64 is not used", async () => {
  const { fake, store, captain } = await setup({
    maxBytes: 63,
    answer: () => "one\ntwo",
  });

  fake.say({ nick: "jack", account: "jack" }, "#galactica", "galactica: count");
  await until(() => store.queueCounts(captain.key).done === 1, 5000, "done");
  expect(captain.client.hasCap("draft/multiline")).toBe(false);
  expect(fake.batches).toHaveLength(0);
});

test("irc multiline lost before a retry: plain-line progress is kept too", async () => {
  const { fake, store, captain, attempts } = await setup({
    answer: () => ["one", "two", "three", "four"].join("\n"),
  });

  // Attempt 1: the server refuses the batch; the batched plan is stored.
  fake.refuse.add("galactica #galactica");
  fake.say({ nick: "jack", account: "jack" }, "#galactica", "galactica: count");
  await until(() => attempts() === 1, 5000, "batch refused");
  // Attempt 2 (plain lines): two lines pass, then the server refuses.
  let accepted = 0;
  fake.onMessage = () => {
    if (++accepted === 2) {
      fake.refuse.add("galactica #galactica");
    }
  };

  fake.refuse.clear();
  // The server stops offering draft/multiline; Stargate reconnects.
  fake.caps.splice(
    fake.caps.findIndex((cap) => cap.startsWith("draft/multiline")),
    1,
  );
  fake.drop("galactica");
  await until(
    () =>
      !captain.client.hasCap("draft/multiline") &&
      captain.client.inChannel("#galactica"),
    5000,
    "reconnected without multiline",
  );
  await until(() => attempts() === 2, 8000, "third line refused");
  expect(accepted).toBe(2);
  fake.refuse.clear();
  await until(() => store.queueCounts(captain.key).done === 1, 10_000, "done");

  const sent = lineOf(fake.received("galactica"), "PRIVMSG")
    .filter((m) => m.params[0] === "#galactica" && !m.tags.has("batch"))
    .map((m) => m.params[1]);

  // "three" was refused once; confirmed lines never repeat.
  expect(sent).toEqual(["one", "two", "three", "three", "four"]);
}, 30_000);

test("irc multiline limits shrink before a retry: the rest goes as lines", async () => {
  const { fake, store, captain, attempts } = await setup({
    answer: () => ["one", "two", "three"].join("\n"),
  });

  fake.refuse.add("galactica #galactica");
  fake.say({ nick: "jack", account: "jack" }, "#galactica", "galactica: count");
  await until(() => attempts() === 1, 5000, "batch refused");
  fake.refuse.clear();
  const index = fake.caps.findIndex((cap) => cap.startsWith("draft/multiline"));
  fake.caps[index] = "draft/multiline=max-bytes=4096,max-lines=2";
  fake.drop("galactica");
  await until(
    () =>
      captain.client.multiline?.maxLines === 2 &&
      captain.client.inChannel("#galactica"),
    5000,
    "reconnected",
  );
  await until(() => store.queueCounts(captain.key).done === 1, 10_000, "done");
  // The stored three-line batch no longer fits: sent as plain lines.
  expect(fake.batches).toHaveLength(0);
  expect(
    lineOf(fake.received("galactica"), "PRIVMSG")
      .filter((m) => m.params[0] === "#galactica" && !m.tags.has("batch"))
      .map((m) => m.params[1]),
  ).toEqual(["one", "two", "three"]);
}, 20_000);

test("irc delivery without multiline: a retry resends only undelivered lines", async () => {
  const { fake, store, captain, attempts } = await setup({
    multiline: false,
    answer: () => ["one", "two", "three", "four"].join("\n"),
  });

  let accepted = 0;
  fake.onMessage = () => {
    if (++accepted === 2) {
      fake.refuse.add("galactica #galactica");
    }
  };

  fake.say({ nick: "jack", account: "jack" }, "#galactica", "galactica: count");
  await until(
    () => store.queueCounts(captain.key).responding === 1,
    5000,
    "retry pending",
  );
  await until(() => accepted === 2, 5000, "two lines");
  await until(() => attempts() === 1, 5000, "third line refused");
  fake.refuse.clear();
  await until(() => store.queueCounts(captain.key).done === 1, 8000, "retried");

  const sent = lineOf(fake.received("galactica"), "PRIVMSG")
    .filter((m) => m.params[0] === "#galactica")
    .map((m) => m.params[1]);

  // "three" was refused once and then sent; nothing else repeats.
  expect(sent).toEqual(["one", "two", "three", "three", "four"]);
  expect(fake.batches).toHaveLength(0);
}, 15_000);

test("irc multiline: features.multiline off sends plain lines", async () => {
  const { fake, store, captain } = await setup({
    features: { multiline: false },
    answer: () => "one\ntwo",
  });

  fake.say({ nick: "jack", account: "jack" }, "#galactica", "galactica: count");
  await until(
    () => store.queueCounts(captain.key).done === 1,
    5000,
    "delivered",
  );
  expect(fake.batches).toHaveLength(0);
  expect(captain.client.hasCap("draft/multiline")).toBe(false);
});

test("irc multiline: an incoming batch is one message with its line breaks", async () => {
  const { fake, prompts } = await setup();
  fake.sayLines({ nick: "jack", account: "jack" }, "#galactica", [
    { text: "galactica: please check" },
    { text: "the reactor and the" },
    { text: " fuel lines", concat: true },
  ]);
  await until(() => prompts.length === 1, 5000, "prompt");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(prompts).toEqual(["please check\nthe reactor and the fuel lines"]);
});
