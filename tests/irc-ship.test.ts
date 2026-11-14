import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Effect } from "effect";
import pino from "pino";
import type { AgentBackend, PromptSourceContext } from "../src/backend";
import { ircSchema } from "../src/config";
import { Gateway } from "../src/gateway";
import { utf8Bytes } from "../src/irc/protocol";
import { IrcShip } from "../src/irc/ship";
import { serve } from "../src/runtime";
import { Store } from "../src/store";
import { FakeIrcServer, lineOf, until } from "./irc-fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const passwords = {
  POGO_IRC_GALACTICA: "captain-pass",
  POGO_IRC_GALACTICA_CHIEF: "chief-pass",
  POGO_IRC_GALACTICA_TYROL: "tyrol-pass",
};
const backend = {
  type: "opencode",
  url: "http://localhost:4096",
  directory: "/workspace",
};

type Prompt = { text: string; context?: PromptSourceContext };

function fakeBackend(
  answer: (text: string) => string | Promise<string>,
  pinned?: string,
): AgentBackend & { prompts: Prompt[] } {
  const prompts: Prompt[] = [];
  return {
    prompts,
    ...(pinned ? { sessionID: pinned } : {}),
    async createSession() {
      return pinned ?? `ses_${prompts.length}`;
    },
    async prompt(_session, text, _signal, _onText, _onInput, _files, context) {
      prompts.push({ text, ...(context ? { context } : {}) });
      return answer(text);
    },
    async close() {},
  };
}

async function setup(
  answers: {
    captain?: (text: string) => string | Promise<string>;
    chief?: (text: string) => string;
    tyrol?: (text: string) => string;
  } = {},
  access: Record<string, unknown> = {},
) {
  const fake = new FakeIrcServer({
    accounts: {
      galactica: "captain-pass",
      "galactica-chief": "chief-pass",
      "galactica-tyrol": "tyrol-pass",
    },
    inviteOnly: ["#galactica"],
  }).start();
  cleanup.push(() => fake.stop());
  // The founder is never refused: grant the captain up front.
  fake.invited.add("galactica:#galactica");
  const directory = await mkdtemp(join(tmpdir(), "pogo-irc-ship-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, "pogo.sqlite"));
  cleanup.push(() => store.close());
  const config = ircSchema.parse({
    id: "galactica-irc",
    displayName: "Galactica",
    server: { host: "127.0.0.1", port: fake.port, tls: false },
    account: "galactica",
    passwordEnv: "POGO_IRC_GALACTICA",
    channels: ["#galactica"],
    access: { shipTurnsPerAgentPerHour: 1, ...access },
    crew: [
      {
        id: "chief",
        account: "galactica-chief",
        passwordEnv: "POGO_IRC_GALACTICA_CHIEF",
        channels: ["#galactica"],
        backend: { ...backend, agent: "galactica-crew-chief" },
      },
      {
        id: "tyrol",
        account: "galactica-tyrol",
        passwordEnv: "POGO_IRC_GALACTICA_TYROL",
        channels: ["#galactica"],
        backend: { ...backend, agent: "galactica-crew-tyrol" },
      },
    ],
    backend: { ...backend, sessionID: "ses_captain" },
  });
  const log = pino({ level: "silent" });
  const ship = await IrcShip.create(config, store, log, {
    env: passwords,
    timing: {
      reconnectMinMs: 20,
      reconnectMaxMs: 50,
      reclaimMs: 100,
      intervalMs: 5,
      burst: 10,
      confirmMs: 1000,
    },
    readyMs: 2000,
  });
  const backends = {
    captain: fakeBackend(
      answers.captain ?? (() => "[[pogo:silent]]"),
      "ses_captain",
    ),
    chief: fakeBackend(answers.chief ?? (() => "[[pogo:silent]]")),
    tyrol: fakeBackend(answers.tyrol ?? (() => "[[pogo:silent]]")),
  };
  const controller = new AbortController();
  const workers = ship.registrations.map((registration, index) => {
    const selected = [backends.captain, backends.chief, backends.tyrol][index];
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
  let open = true;
  ship.start(() => open);
  cleanup.push(async () => {
    open = false;
    controller.abort();
    await Promise.all(workers);
    await ship.close();
  });
  const [captain, chief, tyrol] = ship.registrations;
  if (!captain || !chief || !tyrol) throw new Error("missing registration");
  await until(
    () =>
      captain.client.inChannel("#galactica") &&
      chief.client.inChannel("#galactica") &&
      tyrol.client.inChannel("#galactica"),
    5000,
    "every member in the ship channel",
  );
  return { fake, store, ship, backends, captain, chief, tyrol };
}

test("irc ship: captain invites crew into the invite-only ship channel only", async () => {
  const { fake, chief } = await setup();
  const chiefLines = fake.received("galactica-chief");
  expect(
    lineOf(chiefLines, "JOIN").every((m) => m.params[0] === "#galactica"),
  ).toBe(true);
  expect(
    lineOf(fake.received("galactica"), "INVITE").map((m) => m.params),
  ).toEqual(expect.arrayContaining([["galactica-chief", "#galactica"]]));
  // An invite elsewhere is ignored: crew never join unlisted channels.
  fake.sendTo("galactica-chief", ":jack!u@h INVITE galactica-chief #breakout");
  await delay(100);
  expect(
    lineOf(fake.received("galactica-chief"), "JOIN").some(
      (m) => m.params[0] === "#breakout",
    ),
  ).toBe(false);
  expect(chief.client.inChannel("#breakout")).toBe(false);
});

test("irc ship: a mention reaches the pinned captain and replies as plain IRC lines", async () => {
  const long = `**Status**: ${"all systems nominal ".repeat(60)}`;
  const { fake, backends } = await setup({
    captain: () => `# Report\n\n${long}`,
  });
  const msgid = fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "galactica: status?",
  );
  await until(
    () => lineOf(fake.received("galactica"), "PRIVMSG").length >= 3,
    5000,
    "captain reply lines",
  );
  const prompt = backends.captain.prompts[0];
  expect(prompt?.text).toBe("status?");
  expect(prompt?.context?.source).toEqual({
    transport: "irc",
    channel: "#galactica",
    thread: msgid,
    message: msgid,
    user: "jack",
  });
  const lines = lineOf(fake.received("galactica"), "PRIVMSG");
  expect(lines[0]?.params).toEqual(["#galactica", "Report"]);
  expect(lines[0]?.tags.get("+draft/reply")).toBe(msgid);
  expect(lines[1]?.tags.has("+draft/reply")).toBe(false);
  expect(lines[1]?.params[1]?.startsWith("Status: all systems")).toBe(true);
  for (const line of fake.received("galactica"))
    expect(utf8Bytes(line) + 2).toBeLessThanOrEqual(512);
  // Messages without an account tag never reach the agent.
  fake.say({ nick: "ghost" }, "#galactica", "galactica: hello?");
  await delay(200);
  expect(backends.captain.prompts).toHaveLength(1);
});

test("irc ship: silent replies post nothing; DMs are per account", async () => {
  const { fake, backends, store, captain } = await setup({
    captain: (text) => (text === "quiet" ? "[[pogo:silent]]" : "Hello Jack."),
  });
  fake.say({ nick: "jack", account: "jack" }, "#galactica", "galactica: quiet");
  fake.say({ nick: "jack", account: "jack" }, "galactica", "hi there");
  await until(
    () => lineOf(fake.received("galactica"), "PRIVMSG").length === 1,
    5000,
    "direct reply",
  );
  await delay(100);
  const lines = lineOf(fake.received("galactica"), "PRIVMSG");
  expect(lines.map((m) => m.params)).toEqual([["jack", "Hello Jack."]]);
  expect(
    backends.captain.prompts.map((p) => p.context?.source.channel),
  ).toEqual(["#galactica", "jack"]);
  expect(store.queueCounts(captain.key).done).toBe(2);
});

test("irc ship: crew hear each other by nick, with a per-channel ship limit", async () => {
  const { fake, backends, store, ship } = await setup({
    captain: (text) =>
      text === "is CI green?"
        ? "galactica-chief: please check the CI run."
        : "[[pogo:silent]]",
    chief: () => "galactica-tyrol: can you look at the flaky test?",
    tyrol: () => "galactica: done, the flake is fixed.",
  });
  fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "galactica: is CI green?",
  );
  // jack → captain; captain → chief (1); chief → tyrol by mention (2) and
  // → captain by reply (3); tyrol → captain would be the 4th ship message in
  // this hour and exceeds 1 per agent × 3 agents.
  await until(() => backends.tyrol.prompts.length === 1, 5000, "tyrol prompt");
  await until(
    () => backends.captain.prompts.length === 2,
    5000,
    "captain hears chief",
  );
  await until(
    () => lineOf(fake.received("galactica-tyrol"), "PRIVMSG").length === 1,
    5000,
    "tyrol answer",
  );
  await delay(300);
  expect(backends.chief.prompts).toHaveLength(1);
  expect(backends.chief.prompts[0]?.text).toBe(
    "[IRC #galactica, from account galactica, an account of this ship (captain or crew). Reply only if you are tagged and can add something useful, to correct an error, or once to an all-call; otherwise answer [[pogo:silent]]. No acknowledgements or thanks. Plain text only.]\n\nplease check the CI run.",
  );
  expect(backends.tyrol.prompts[0]?.text).toContain(
    "can you look at the flaky test?",
  );
  // The pinned captain gets a source line instead of the note.
  expect(backends.captain.prompts[1]?.context?.source.sender).toBe("crew");
  expect(backends.captain.prompts[1]?.text).toBe(
    "galactica-tyrol: can you look at the flaky test?",
  );
  expect(backends.captain.prompts).toHaveLength(2);
  const keys = ship.registrations.map((registration) => registration.key);
  expect(
    store.turnsSince({
      botKeys: keys,
      sender: "crew",
      since: 0,
      scope: { channel: "#galactica" },
    }),
  ).toBe(3);
});

test("irc ship: a failed delivery retries without rerunning the agent", async () => {
  const { fake, backends, store, captain } = await setup({
    captain: () => "Retry-safe answer.",
  });
  fake.refuse.add("galactica #galactica");
  fake.say({ nick: "jack", account: "jack" }, "#galactica", "galactica: hello");
  await until(() => backends.captain.prompts.length === 1, 5000, "prompt");
  await until(
    () => lineOf(fake.received("galactica"), "PRIVMSG").length === 1,
    5000,
    "refused attempt",
  );
  expect(store.queueCounts(captain.key).responding).toBe(1);
  fake.refuse.clear();
  await until(() => store.queueCounts(captain.key).done === 1, 5000, "retry");
  expect(backends.captain.prompts).toHaveLength(1);
  const sent = lineOf(fake.received("galactica"), "PRIVMSG");
  expect(sent.map((m) => m.params[1])).toEqual([
    "Retry-safe answer.",
    "Retry-safe answer.",
  ]);
});

test("irc runtime: an IRC-only config serves, answers and QUITs on shutdown", async () => {
  const fake = new FakeIrcServer({
    accounts: { galactica: "captain-pass" },
  }).start();
  cleanup.push(() => fake.stop());
  const dataDirectory = await mkdtemp(join(tmpdir(), "pogo-irc-runtime-"));
  cleanup.push(() => rm(dataDirectory, { recursive: true, force: true }));
  const config = ircSchema.parse({
    id: "galactica-irc",
    server: { host: "127.0.0.1", port: fake.port, tls: false },
    account: "galactica",
    passwordEnv: "POGO_IRC_GALACTICA",
    channels: ["#galactica"],
    backend: { ...backend, sessionID: "ses_captain" },
  });
  const captain = fakeBackend(() => "Aye.", "ses_captain");
  const controller = new AbortController();
  const log = pino({ level: "silent" });
  const running = Effect.runPromise(
    serve({ dataDirectory, bots: [], irc: [config] }, log, controller.signal, {
      slack: () => {
        throw new Error("Slack is not configured");
      },
      backend: async () => captain,
      irc: (irc, store, ircLog) =>
        IrcShip.create(irc, store, ircLog, {
          env: passwords,
          timing: { reconnectMinMs: 20, intervalMs: 5, burst: 10 },
        }),
    }),
  );
  await until(
    () => lineOf(fake.received("galactica"), "JOIN").length === 1,
    5000,
    "join",
  );
  await delay(50);
  fake.say({ nick: "jack", account: "jack" }, "#galactica", "galactica: ping");
  await until(
    () => lineOf(fake.received("galactica"), "PRIVMSG").length === 1,
    5000,
    "reply",
  );
  expect(lineOf(fake.received("galactica"), "PRIVMSG")[0]?.params).toEqual([
    "#galactica",
    "Aye.",
  ]);
  controller.abort();
  await running;
  await until(
    () => fake.received("galactica").includes("QUIT :Pogo shutting down"),
    2000,
    "quit",
  );
});

test("irc ship: a DM reply never goes to a nick another account now holds", async () => {
  const gate = Promise.withResolvers<void>();
  const { fake, store, captain } = await setup({
    captain: async () => {
      await gate.promise;
      return "Private answer for jack.";
    },
  });
  fake.say({ nick: "jackie", account: "jack" }, "galactica", "status?");
  await until(() => store.queueCounts(captain.key).running === 1, 5000, "turn");
  // jack disconnects unseen; mallory takes the nick before the reply.
  fake.setUser("jackie", "mallory");
  gate.resolve();
  await until(
    () => {
      const counts = store.queueCounts(captain.key);
      return counts.responding + counts.done === 1;
    },
    5000,
    "reply stored",
  );
  await delay(300);
  const direct = () =>
    lineOf(fake.received("galactica"), "PRIVMSG").filter(
      (m) => !m.params[0]?.startsWith("#"),
    );
  expect(direct()).toHaveLength(0);
  // jack is back under his account name: the stored reply reaches him.
  fake.setUser("jack", "jack");
  await until(() => store.queueCounts(captain.key).done === 1, 5000, "retry");
  expect(direct().map((m) => m.params)).toEqual([
    ["jack", "Private answer for jack."],
  ]);
}, 15_000);

test("irc ship: an all-call reaches the captain and every crew member", async () => {
  // Turn order and timing are covered in irc-allcall.test.ts.
  const { fake, backends } = await setup({}, { allCallStaggerMs: 0 });
  fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "Everyone, report status",
  );
  await until(
    () =>
      backends.captain.prompts.length === 1 &&
      backends.chief.prompts.length === 1 &&
      backends.tyrol.prompts.length === 1,
    5000,
    "all-call fan-out",
  );
  expect(backends.captain.prompts[0]?.text).toBe(
    "[Admitted by text mention: everyone]\n\nEveryone, report status",
  );
  for (const crew of [backends.chief, backends.tyrol])
    expect(crew.prompts[0]?.text).toContain("This is an all-call");
  // Untagged traffic that is not an all-call reaches nobody.
  fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "the build is green",
  );
  fake.say({ nick: "jack", account: "jack" }, "#galactica", "everyones build");
  await delay(300);
  expect(
    [backends.captain, backends.chief, backends.tyrol].map(
      (b) => b.prompts.length,
    ),
  ).toEqual([1, 1, 1]);
});
