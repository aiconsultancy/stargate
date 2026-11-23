import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, Schema } from "effect";
import pino from "pino";
import type { AgentBackend } from "../src/backends/backend";
import { ircSchema } from "../src/config";
import { Gateway } from "../src/gateway/gateway";
import { ircNote } from "../src/transports/irc/routing";
import { IrcShip } from "../src/transports/irc/ship";
import { openStore } from "../src/app/open-store";
import { FakeIrcServer, until } from "./irc-fixture";

// Liveness bounds only: no assertion depends on how fast a step is.
const wait = 15_000;
const limit = 30_000;

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
    passwordEnv: `STARGATE_IRC_GALACTICA_${id.toUpperCase()}`,
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
  const directory = await mkdtemp(join(tmpdir(), "stargate-irc-allcall-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = openStore(join(directory, "stargate.sqlite"));
  cleanup.push(() => store.close());

  const config = Schema.decodeUnknownSync(ircSchema)({
    id: "galactica-irc",
    server: { host: "127.0.0.1", port: fake.port, tls: false },
    account: "galactica-captain",
    passwordEnv: "STARGATE_IRC_GALACTICA_CAPTAIN",
    channels: ["#ship-galactica"],
    access,
    crew: [crew("chief"), crew("tyrol")],
    backend: { ...backend, sessionID: "ses_captain" },
  });

  const log = pino({ level: "silent" });

  const ship = await IrcShip.create(config, store, log, {
    env: {
      STARGATE_IRC_GALACTICA_CAPTAIN: "pass",
      STARGATE_IRC_GALACTICA_CHIEF: "pass",
      STARGATE_IRC_GALACTICA_TYROL: "pass",
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

        return answers[name] ?? "[[stargate:silent]]";
      },
      async close() {},
    };

    return agent;
  });

  const controller = new AbortController();

  const gateways = ship.registrations.map((registration, index) => {
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
    );
  });

  const workers = gateways.map((gateway) => gateway.work(controller.signal));

  const member = (account: string) => {
    const index = ship.registrations.findIndex(
      (registration) => registration.account === account,
    );

    const registration = ship.registrations[index];
    const gateway = gateways[index];

    if (!registration || !gateway) throw new Error(`missing ${account}`);

    return { registration, gateway };
  };

  const db = new Database(join(directory, "stargate.sqlite"), {
    readonly: true,
  });

  cleanup.push(() => db.close());
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
    wait,
    "every member joined",
  );

  return {
    fake,
    prompts,
    /** Hold or release the turns of one agent; intake continues. */
    hold: (account: string, value = true) =>
      member(account).gateway.pause(value),
    /**
     * True when the waiting turn of `account` would list `line`: its
     * connection received that channel message after the all-call.
     */
    sees(account: string, line: string) {
      const { registration } = member(account);
      const [job] = store.ready(registration.key, Number.MAX_SAFE_INTEGER, 1);

      return (
        job !== undefined &&
        (registration.transport.note(job) ?? "").includes(line)
      );
    },
    /** Stored start of the newest job of `account`, in ms after its receipt. */
    startDelay(account: string) {
      const row = db
        .query<{ start: number; received: number }, [string]>(
          "SELECT retry_at AS start, received FROM jobs WHERE botKey=? ORDER BY id DESC LIMIT 1",
        )
        .get(member(account).registration.key);

      if (!row) throw new Error(`no job of ${account}`);

      return row.start === 0 ? 0 : row.start - row.received;
    },
    /** Every accepted job is delivered or failed. */
    idle: () =>
      until(
        () =>
          ship.registrations.every((registration) => {
            const counts = store.queueCounts(registration.key);

            return counts.queued + counts.running + counts.responding === 0;
          }),
        wait,
        "idle",
      ),
  };
}

test(
  "irc all-call: agents answer in turn and see what was said since",
  async () => {
    const { fake, prompts, hold, sees, startDelay } = await setup(
      {
        "galactica-captain": "Fuel at 40%.",
        "galactica-chief": "Reactor nominal.",
      },
      { allCallStaggerMs: 400 },
    );

    // The stagger orders the starts. A crew turn is held here until its
    // Connection has the earlier answer, so the list never depends on speed.
    hold("galactica-chief");
    hold("galactica-tyrol");
    const sent = Date.now();
    fake.say(
      { nick: "jack", account: "jack" },
      "#ship-galactica",
      "All hands, status?",
    );
    await until(
      () => sees("galactica-chief", "galactica-captain: Fuel at 40%."),
      wait,
      "captain's answer at chief",
    );
    hold("galactica-chief", false);
    await until(
      () => sees("galactica-tyrol", "galactica-chief: Reactor nominal."),
      wait,
      "chief's answer at tyrol",
    );
    hold("galactica-tyrol", false);
    await until(
      () => (prompts["galactica-tyrol"]?.length ?? 0) === 1,
      wait,
      "last crew turn",
    );
    const [captain] = prompts["galactica-captain"] ?? [];
    const [chief] = prompts["galactica-chief"] ?? [];
    const [tyrol] = prompts["galactica-tyrol"] ?? [];

    if (!captain || !chief || !tyrol) throw new Error("missing prompt");
    // Captain first, then crew in configuration order, one step apart.
    expect(startDelay("galactica-captain")).toBe(0);
    expect(startDelay("galactica-chief")).toBe(400);
    expect(startDelay("galactica-tyrol")).toBe(800);
    // No turn starts before its stored time.
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
    await until(
      () => (prompts["galactica-tyrol"]?.length ?? 0) === 2,
      wait,
      "mention",
    );
    expect(startDelay("galactica-tyrol")).toBe(0);
    expect(prompts["galactica-tyrol"]?.[1]?.text).not.toContain(
      "since the all-call",
    );
  },
  limit,
);

test(
  "irc all-call: allCallStaggerMs 0 answers at once; config bounds",
  async () => {
    const { fake, prompts, startDelay, idle } = await setup(
      {},
      { allCallStaggerMs: 0 },
    );

    fake.say(
      { nick: "jack", account: "jack" },
      "#ship-galactica",
      "everyone, ping",
    );
    await until(
      () => (prompts["galactica-tyrol"]?.length ?? 0) === 1,
      wait,
      "crew turn",
    );
    expect(startDelay("galactica-chief")).toBe(0);
    expect(startDelay("galactica-tyrol")).toBe(0);
    await idle();

    const parse = (value: unknown) =>
      Schema.decodeUnknownResult(ircSchema.fields.access)({
        allCallStaggerMs: value,
      });

    const defaults = parse(undefined);
    expect(
      Result.isSuccess(defaults) && defaults.success.allCallStaggerMs,
    ).toBe(4000);
    expect(Result.isSuccess(parse(-1))).toBe(false);
    expect(Result.isSuccess(parse(30_001))).toBe(false);
    expect(Result.isSuccess(parse(2.5))).toBe(false);
  },
  limit,
);

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
  expect(note).toContain("[[stargate:silent]]");
});

test(
  "irc all-call: a mention inside an all-call still staggers with context",
  async () => {
    const { fake, prompts, hold, sees, startDelay } = await setup(
      { "galactica-captain": "Fuel at 40%." },
      { allCallStaggerMs: 400 },
    );

    hold("galactica-chief");
    const sent = Date.now();
    fake.say(
      { nick: "jack", account: "jack" },
      "#ship-galactica",
      "galactica-chief: all hands, status?",
    );
    await until(
      () => sees("galactica-chief", "galactica-captain: Fuel at 40%."),
      wait,
      "captain's answer at chief",
    );
    hold("galactica-chief", false);
    await until(
      () =>
        (prompts["galactica-chief"]?.length ?? 0) === 1 &&
        (prompts["galactica-tyrol"]?.length ?? 0) === 1,
      wait,
      "crew turns",
    );
    const [chief] = prompts["galactica-chief"] ?? [];

    if (!chief) throw new Error("missing prompt");
    expect(startDelay("galactica-chief")).toBe(400);
    expect(chief.at - sent).toBeGreaterThanOrEqual(380);
    expect(chief.text).toContain("galactica-captain: Fuel at 40%.");
  },
  limit,
);
