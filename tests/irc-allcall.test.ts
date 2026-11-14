import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pino from "pino";
import type { AgentBackend } from "../src/backend";
import { ircSchema } from "../src/config";
import { Gateway } from "../src/gateway";
import { ircNote } from "../src/irc/routing";
import { IrcShip } from "../src/irc/ship";
import { Store } from "../src/store";
import { FakeIrcServer, until } from "./irc-fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const backend = {
  type: "opencode",
  url: "http://localhost:4096",
  directory: "/workspace",
};

function crew(id: string) {
  return {
    id,
    account: `galactica-${id}`,
    passwordEnv: `POGO_IRC_GALACTICA_${id.toUpperCase()}`,
    channels: ["#ship-galactica"],
    backend: { ...backend, agent: `galactica-crew-${id}` },
  };
}

type Prompt = { text: string; at: number };

async function setup(
  answers: Record<string, string>,
  access: Record<string, unknown> = {},
) {
  const fake = new FakeIrcServer({
    accounts: {
      "galactica-captain": "pass",
      "galactica-chief": "pass",
      "galactica-tyrol": "pass",
    },
  }).start();
  cleanup.push(() => fake.stop());
  const directory = await mkdtemp(join(tmpdir(), "pogo-irc-allcall-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, "pogo.sqlite"));
  cleanup.push(() => store.close());
  const config = ircSchema.parse({
    id: "galactica-irc",
    server: { host: "127.0.0.1", port: fake.port, tls: false },
    account: "galactica-captain",
    passwordEnv: "POGO_IRC_GALACTICA_CAPTAIN",
    channels: ["#ship-galactica"],
    access,
    crew: [crew("chief"), crew("tyrol")],
    backend: { ...backend, sessionID: "ses_captain" },
  });
  const log = pino({ level: "silent" });
  const ship = await IrcShip.create(config, store, log, {
    env: {
      POGO_IRC_GALACTICA_CAPTAIN: "pass",
      POGO_IRC_GALACTICA_CHIEF: "pass",
      POGO_IRC_GALACTICA_TYROL: "pass",
    },
    timing: { reconnectMinMs: 20, intervalMs: 5, burst: 20 },
    readyMs: 2000,
  });
  const prompts: Record<string, Prompt[]> = {};
  const backends = ship.registrations.map((registration) => {
    const name = registration.account;
    prompts[name] = [];
    const agent: AgentBackend = {
      ...(registration.role === "captain" ? { sessionID: "ses_captain" } : {}),
      async createSession() {
        return registration.role === "captain" ? "ses_captain" : `ses_${name}`;
      },
      async prompt(_session, text) {
        prompts[name]?.push({ text, at: Date.now() });
        return answers[name] ?? "[[pogo:silent]]";
      },
      async close() {},
    };
    return agent;
  });
  const controller = new AbortController();
  const workers = ship.registrations.map((registration, index) => {
    const selected = backends[index];
    if (!selected) throw new Error("missing backend");
    return new Gateway(
      registration.settings,
      registration.identity,
      store,
      selected,
      registration.delivery,
      log,
      undefined,
      undefined,
      registration.transport,
    ).work(controller.signal);
  });
  ship.start(() => true);
  cleanup.push(async () => {
    controller.abort();
    await Promise.all(workers);
    await ship.close();
  });
  await until(
    () =>
      ship.registrations.every((registration) =>
        registration.client.inChannel("#ship-galactica"),
      ),
    5000,
    "every member joined",
  );
  return { fake, prompts };
}

test("irc all-call: agents answer in turn and see what was said since", async () => {
  const { fake, prompts } = await setup(
    {
      "galactica-captain": "Fuel at 40%.",
      "galactica-chief": "Reactor nominal.",
    },
    { allCallStaggerMs: 400 },
  );
  const sent = Date.now();
  fake.say(
    { nick: "jack", account: "jack" },
    "#ship-galactica",
    "All hands, status?",
  );
  await until(
    () => (prompts["galactica-tyrol"]?.length ?? 0) === 1,
    5000,
    "last crew turn",
  );
  const [captain] = prompts["galactica-captain"] ?? [];
  const [chief] = prompts["galactica-chief"] ?? [];
  const [tyrol] = prompts["galactica-tyrol"] ?? [];
  if (!captain || !chief || !tyrol) throw new Error("missing prompt");
  // Captain first, then crew in configuration order, one step apart.
  expect(captain.at - sent).toBeLessThan(350);
  expect(chief.at - sent).toBeGreaterThanOrEqual(380);
  expect(tyrol.at - sent).toBeGreaterThanOrEqual(780);
  // Each turn lists the channel messages since the all-call.
  expect(chief.text).toContain("galactica-captain: Fuel at 40%.");
  expect(chief.text).not.toContain("Reactor nominal.");
  expect(tyrol.text).toContain("galactica-captain: Fuel at 40%.");
  expect(tyrol.text).toContain("galactica-chief: Reactor nominal.");
  expect(tyrol.text.indexOf("Fuel at 40%")).toBeLessThan(
    tyrol.text.indexOf("Reactor nominal"),
  );
  // A mention is not an all-call: no delay, no list.
  fake.say(
    { nick: "jack", account: "jack" },
    "#ship-galactica",
    "galactica-tyrol: and you?",
  );
  const asked = Date.now();
  await until(
    () => (prompts["galactica-tyrol"]?.length ?? 0) === 2,
    5000,
    "mention",
  );
  const mention = prompts["galactica-tyrol"]?.[1];
  expect((mention?.at ?? 0) - asked).toBeLessThan(350);
  expect(mention?.text).not.toContain("since the all-call");
});

test("irc all-call: allCallStaggerMs 0 answers at once; config bounds", async () => {
  const { fake, prompts } = await setup({}, { allCallStaggerMs: 0 });
  const sent = Date.now();
  fake.say(
    { nick: "jack", account: "jack" },
    "#ship-galactica",
    "everyone, ping",
  );
  await until(
    () => (prompts["galactica-tyrol"]?.length ?? 0) === 1,
    5000,
    "crew turn",
  );
  expect((prompts["galactica-tyrol"]?.[0]?.at ?? 0) - sent).toBeLessThan(350);
  await delay(50);
  const parse = (value: unknown) =>
    ircSchema.shape.access.safeParse({ allCallStaggerMs: value });
  expect(parse(undefined).data?.allCallStaggerMs).toBe(4000);
  expect(parse(-1).success).toBe(false);
  expect(parse(30_001).success).toBe(false);
  expect(parse(2.5).success).toBe(false);
});

test("irc all-call: the note tells agents to take turns and stay silent on repeats", () => {
  const note = ircNote(
    {
      channel: "#ship-galactica",
      user: "jack",
      sender: null,
      textMention: "all hands",
    },
    ["all hands"],
    ["galactica-captain: Fuel at 40%."],
  );
  expect(note).toContain("This is an all-call");
  expect(note).toContain("captain first");
  expect(note).toContain(
    "Said in #ship-galactica since the all-call, oldest first",
  );
  expect(note).toContain("galactica-captain: Fuel at 40%.");
  expect(note).toContain("[[pogo:silent]]");
});

test("irc all-call: a mention inside an all-call still staggers with context", async () => {
  const { fake, prompts } = await setup(
    { "galactica-captain": "Fuel at 40%." },
    { allCallStaggerMs: 400 },
  );
  const sent = Date.now();
  fake.say(
    { nick: "jack", account: "jack" },
    "#ship-galactica",
    "galactica-chief: all hands, status?",
  );
  await until(
    () => (prompts["galactica-tyrol"]?.length ?? 0) === 1,
    5000,
    "last crew turn",
  );
  const [chief] = prompts["galactica-chief"] ?? [];
  if (!chief) throw new Error("missing prompt");
  expect(chief.at - sent).toBeGreaterThanOrEqual(380);
  expect(chief.text).toContain("galactica-captain: Fuel at 40%.");
});
