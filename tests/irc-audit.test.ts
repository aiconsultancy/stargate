import {
  afterEach,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { Result, Schema } from "effect";
import pino from "pino";
import type { AgentBackend } from "../src/backends/backend";
import { configSchema, ircSchema } from "../src/config";
import { Gateway } from "../src/gateway/gateway";
import { auditLine } from "../src/transports/irc/audit";
import { IrcClient, type IrcTiming } from "../src/transports/irc/client";
import {
  type Casemapping,
  fold,
  parseMessage,
  utf8Bytes,
} from "../src/transports/irc/protocol";
import { IrcShip } from "../src/transports/irc/ship";
import { openStore } from "../src/app/open-store";
import { type Store } from "../src/gateway/store";
import { FakeIrcServer, lineOf, until as pollUntil } from "./irc-fixture";

const cleanup: (() => unknown)[] = [];

// Two fresh opens (10 s each), two joins (5 s each), four reply waits
// (5 s each), and close/scheduling (10 s). Predicate deadlines stay 5 s.
setDefaultTimeout(60_000);

let polling = new AbortController();

beforeEach(() => {
  polling = new AbortController();
});

function until(...args: Parameters<typeof pollUntil>) {
  return pollUntil(args[0], args[1], args[2], {
    ...args[3],
    signal: polling.signal,
  });
}

afterEach(async () => {
  polling.abort();

  for (const close of cleanup.splice(0).reverse()) await close();
});

const captainAccount = "galactica-captain";
const chiefAccount = "galactica-chief";
const jack = { nick: "jack", account: "jack" };

const backend = {
  type: "opencode",
  url: "http://localhost:4096",
  directory: "/workspace",
};

const baseCaps = [
  "sasl=PLAIN",
  "account-tag",
  "message-tags",
  "server-time",
  "batch",
  "echo-message",
  "labeled-response",
  "account-notify",
  "extended-join",
  "draft/chathistory",
];

const withheld = "[not mirrored: may contain credentials]";

function shipConfig(port: number, extra: Record<string, unknown> = {}) {
  return {
    id: "galactica-irc",
    displayName: "Galactica",
    server: { host: "127.0.0.1", port, tls: false },
    account: captainAccount,
    passwordEnv: "STARGATE_IRC_GALACTICA_CAPTAIN",
    channels: ["#ship-galactica"],
    crew: [
      {
        id: "chief",
        account: chiefAccount,
        passwordEnv: "STARGATE_IRC_GALACTICA_CHIEF",
        channels: ["#ship-galactica"],
        backend: { ...backend, agent: "galactica-crew-chief" },
      },
    ],
    audit: { channel: "#agent-dms" },
    backend: { ...backend, sessionID: "ses_captain" },
    ...extra,
  };
}

function capture() {
  const lines: string[] = [];

  const log = pino(
    { level: "info" },
    new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    }),
  );

  return { log, lines };
}

/** A fake server and a store for one test. */
async function world(
  options: { multiline?: boolean; captainInvited?: boolean } = {},
) {
  const fake = new FakeIrcServer({
    accounts: {
      [captainAccount]: "captain-pass",
      [chiefAccount]: "chief-pass",
    },
    caps: [
      ...baseCaps,
      ...(options.multiline
        ? ["draft/multiline=max-bytes=4096,max-lines=100"]
        : []),
    ],
    inviteOnly: ["#agent-dms"],
  }).start();

  cleanup.push(() => fake.stop());

  if (options.captainInvited !== false)
    fake.invited.add(`${captainAccount}:#agent-dms`);
  const directory = await mkdtemp(join(tmpdir(), "stargate-irc-audit-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = openStore(join(directory, "stargate.sqlite"));
  cleanup.push(() => store.close());

  return { fake, store };
}

/** One Stargate lifetime: a ship with captain and chief, and their gateways. */
async function setup(
  options: {
    answer?: (text: string) => string;
    multiline?: boolean;
    captainInvited?: boolean;
    auditQueue?: number;
    extra?: Record<string, unknown>;
    timing?: Partial<IrcTiming>;
    /** Reuse a server and store: a second lifetime (catch-up). */
    reuse?: { fake: FakeIrcServer; store: Store };
  } = {},
) {
  const { fake, store } = options.reuse ?? (await world(options));

  const config = Schema.decodeUnknownSync(ircSchema)(
    shipConfig(fake.port, options.extra),
  );

  const { log, lines: logs } = capture();

  const ship = await IrcShip.create(config, store, log, {
    env: {
      STARGATE_IRC_GALACTICA_CAPTAIN: "captain-pass",
      STARGATE_IRC_GALACTICA_CHIEF: "chief-pass",
    },
    timing: {
      reconnectMinMs: 20,
      reconnectMaxMs: 50,
      reclaimMs: 100,
      intervalMs: 5,
      burst: 20,
      confirmMs: 1000,
      ...options.timing,
    },
    readyMs: 2000,
    ...(options.auditQueue ? { auditQueue: options.auditQueue } : {}),
  });

  const prompts: string[] = [];

  const captainBackend: AgentBackend = {
    sessionID: "ses_captain",
    async createSession() {
      return "ses_captain";
    },
    async prompt(_session, text) {
      prompts.push(text);

      return options.answer?.(text) ?? "[[stargate:silent]]";
    },
    async close() {},
  };

  const crewPrompts: string[] = [];

  const crewBackend: AgentBackend = {
    async createSession() {
      return "ses_chief";
    },
    async prompt(_session, text) {
      crewPrompts.push(text);

      return "[[stargate:silent]]";
    },
    async close() {},
  };

  const controller = new AbortController();

  const workers = ship.registrations.map((registration, index) =>
    new Gateway(
      registration.settings,
      registration.identity,
      store,
      index === 0 ? captainBackend : crewBackend,
      registration.delivery,
      registration.log,
      undefined,
      undefined,
      registration.transport,
    ).work(controller.signal),
  );

  ship.start(() => true);
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    controller.abort();
    await Promise.all(workers);
    await ship.close();
  };

  cleanup.push(close);
  const [captain, chief] = ship.registrations;

  if (!captain || !chief) throw new Error("missing registration");

  const joined = () => ({
    captainShip: captain.client.inChannel("#ship-galactica"),
    chiefShip: chief.client.inChannel("#ship-galactica"),
    captainAudit:
      config.audit === undefined || options.captainInvited === false
        ? "not required"
        : captain.client.inChannel("#agent-dms"),
  });

  await until(
    () => {
      const state = joined();

      return (
        state.captainShip && state.chiefShip && state.captainAudit !== false
      );
    },
    5000,
    "connections joined",
    { state: joined },
  );

  return {
    fake,
    store,
    ship,
    captain,
    chief,
    prompts,
    crewPrompts,
    logs,
    close,
  };
}

/** Entries the captain connection sent to #agent-dms: lines or batches. */
function mirror(fake: FakeIrcServer) {
  const entries: string[] = [];
  const open = new Map<string, string[]>();

  for (const raw of fake.received(captainAccount)) {
    const message = parseMessage(raw);

    if (!message) continue;
    const [first = "", second = "", third = ""] = message.params;

    if (message.command === "BATCH") {
      if (first.startsWith("+") && third === "#agent-dms")
        open.set(first.slice(1), []);
      else if (first.startsWith("-") && open.has(first.slice(1))) {
        entries.push((open.get(first.slice(1)) ?? []).join(""));
        open.delete(first.slice(1));
      }

      continue;
    }

    if (message.command !== "PRIVMSG" || first !== "#agent-dms") continue;
    const batch = message.tags.get("batch");
    const lines = batch === undefined ? undefined : open.get(batch);

    if (lines)
      lines.push(
        lines.length && !message.tags.has("draft/multiline-concat")
          ? `\n${second}`
          : second,
      );
    else entries.push(second);
  }

  return entries;
}

async function mirrored(fake: FakeIrcServer, entry: string) {
  await until(() => mirror(fake).includes(entry), 5000, `mirror: ${entry}`, {
    state: () => ({ entries: mirror(fake).length }),
  });
}

test("irc audit: line format for incoming and outgoing DMs", () => {
  const base = { agent: captainAccount, command: "PRIVMSG" as const };
  expect(
    auditLine({
      ...base,
      direction: "in",
      peer: { nick: "jack", account: "jack" },
      text: "status?",
    }),
  ).toBe("[dm] jack → galactica-captain: status?");
  expect(
    auditLine({
      ...base,
      direction: "out",
      peer: { nick: "jackie", account: "jack" },
      text: "On track.",
    }),
  ).toBe("[dm] galactica-captain → jackie (jack): On track.");
  expect(
    auditLine({
      ...base,
      direction: "in",
      peer: { nick: "ghost", account: null },
      text: "\u0002hi\u0002\u000304 there",
    }),
  ).toBe("[dm] ghost (no account) → galactica-captain: hi there");
  // Replayed messages show the server time they were sent.
  expect(
    auditLine({
      ...base,
      direction: "in",
      peer: { nick: "jack", account: "jack" },
      text: "while you were away",
      replayed: "2026-11-14T10:42:13.000Z",
    }),
  ).toBe(
    "[dm 2026-11-14T10:42Z] jack → galactica-captain: while you were away",
  );

  // Services, ZNC-style modules and CTCP other than ACTION are skipped.
  for (const nick of ["NickServ", "chanserv", "HostServ", "*status"])
    expect(
      auditLine({
        ...base,
        direction: "in",
        peer: { nick },
        text: "This nickname is registered",
      }),
    ).toBeUndefined();
  expect(
    auditLine({
      ...base,
      direction: "in",
      peer: { nick: "jack", account: "jack" },
      text: "\u0001ACTION waves\u0001",
    }),
  ).toBe("[dm] * jack waves (→ galactica-captain)");

  for (const text of ["\u0001VERSION\u0001", "\u0001PING 123\u0001"])
    expect(
      auditLine({
        ...base,
        direction: "in",
        peer: { nick: "jack", account: "jack" },
        text,
      }),
    ).toBeUndefined();

  // Credential-like text is withheld, never partly redacted.
  for (const text of [
    "identify hunter2",
    "SET PASSWORD correct-horse",
    "token: synthetic-test-token",
    "password=hunter2",
  ])
    expect(
      auditLine({
        ...base,
        direction: "in",
        peer: { nick: "jack", account: "jack" },
        text,
      }),
    ).toBe(`[dm] jack → galactica-captain: ${withheld}`);
});

test("irc audit: any line of a multiline DM can withhold the whole entry", () => {
  const entry = (text: string) =>
    auditLine({
      direction: "in",
      agent: captainAccount,
      peer: { nick: "jack", account: "jack" },
      text,
    });

  for (const text of [
    "hello\nidentify hunter2",
    "status\n  /msg NickServ IDENTIFY galactica-captain pw",
    "ok\n/ns ghost galactica-captain pw",
    "ok\nnickserv identify pw",
    "fine\n/msg ChanServ op #ship-galactica",
    "a\n/cs register #agent-dms",
    "line one\nset password new-one",
    "first\nsecond\nthird password=x",
  ])
    expect(entry(text)).toBe(`[dm] jack → galactica-captain: ${withheld}`);
  // Outgoing batches use the same rule.
  expect(
    auditLine({
      direction: "out",
      agent: captainAccount,
      peer: { nick: "jack" },
      text: "Done.\nregister galactica-chief s3cret",
    }),
  ).toBe(`[dm] galactica-captain → jack: ${withheld}`);
  expect(entry("status?\nall good")).toBe(
    "[dm] jack → galactica-captain: status?\nall good",
  );
});

test("irc audit: DMs to and from captain and crew are mirrored; typing is not", async () => {
  const { fake, captain } = await setup({
    answer: (text) =>
      text === "hello" ? "Hello Jack." : "[[stargate:silent]]",
  });

  fake.say(jack, captainAccount, "hello");
  await mirrored(fake, "[dm] galactica-captain → jack: Hello Jack.");
  // The turn ran with typing on: typing (TAGMSG) is never mirrored.
  expect(
    lineOf(fake.received(captainAccount), "TAGMSG").some(
      (m) => m.params[0] === "jack",
    ),
  ).toBe(true);
  fake.say({ nick: "jackie", account: "jack" }, captainAccount, "it's me");
  await mirrored(fake, "[dm] jackie (jack) → galactica-captain: it's me");
  fake.say({ nick: "ghost" }, captainAccount, "anyone?");
  await mirrored(fake, "[dm] ghost (no account) → galactica-captain: anyone?");
  fake.say(jack, captainAccount, "fyi", {}, "NOTICE");
  await mirrored(fake, "[dm] jack → galactica-captain: fyi");
  // A crew connection's DM is mirrored by the captain connection.
  fake.say(jack, chiefAccount, "chief, a word");
  await mirrored(fake, "[dm] jack → galactica-chief: chief, a word");
  // The same message ID twice (for example a replay) is mirrored once.
  fake.say(jack, captainAccount, "once", { msgid: "dup-1" });
  fake.say(jack, captainAccount, "once", { msgid: "dup-1" });
  fake.say(jack, captainAccount, "marker");
  await mirrored(fake, "[dm] jack → galactica-captain: marker");
  expect(mirror(fake)).toEqual([
    "[dm] jack → galactica-captain: hello",
    "[dm] galactica-captain → jack: Hello Jack.",
    "[dm] jackie (jack) → galactica-captain: it's me",
    "[dm] ghost (no account) → galactica-captain: anyone?",
    "[dm] jack → galactica-captain: fyi",
    "[dm] jack → galactica-chief: chief, a word",
    "[dm] jack → galactica-captain: once",
    "[dm] jack → galactica-captain: marker",
  ]);
  expect(captain.client.inChannel("#agent-dms")).toBe(true);
});

test("irc audit: a DM that catch-up replays is mirrored once, with its time", async () => {
  const first = await setup();
  const { fake, store } = first;
  await first.close();
  await Bun.sleep(5);
  // Stargate is stopped; the server keeps the DM.
  const time = new Date().toISOString();
  fake.say(jack, captainAccount, "while you were away", {
    time,
    msgid: "away-1",
  });
  await setup({ reuse: { fake, store }, answer: () => "Back now." });
  const replayed = `[dm ${time.slice(0, 16)}Z] jack → galactica-captain: while you were away`;
  await mirrored(fake, "[dm] galactica-captain → jack: Back now.");
  expect(mirror(fake)).toEqual([
    replayed,
    "[dm] galactica-captain → jack: Back now.",
  ]);
  // The audit channel itself is never caught up, on any start.
  expect(
    fake.historyRequests.some((request) => request[1] === "#agent-dms"),
  ).toBe(false);
});

test("irc audit: services, credentials and CTCP other than ACTION are not mirrored", async () => {
  const { fake, captain } = await setup();
  fake.say(
    { nick: "NickServ" },
    captainAccount,
    "This nickname is registered",
    {},
    "NOTICE",
  );
  fake.say(
    { nick: "ChanServ" },
    captainAccount,
    "You are founder",
    {},
    "NOTICE",
  );
  await captain.client.privmsg("NickServ", "IDENTIFY galactica-captain s3cret");
  fake.say(jack, captainAccount, "identify hunter2");
  fake.say(jack, captainAccount, "use token xoxb-1234-abcdef please");
  fake.say(jack, captainAccount, "\u0001ACTION waves\u0001");
  fake.say(jack, captainAccount, "\u0001VERSION\u0001");
  fake.say(jack, captainAccount, "\u0001PING 12345\u0001");
  fake.say(jack, captainAccount, "\u0001VERSION Stargate\u0001", {}, "NOTICE");
  fake.say(jack, captainAccount, "marker");
  await mirrored(fake, "[dm] jack → galactica-captain: marker");
  await delay(100);
  expect(mirror(fake)).toEqual([
    `[dm] jack → galactica-captain: ${withheld}`,
    `[dm] jack → galactica-captain: ${withheld}`,
    "[dm] * jack waves (→ galactica-captain)",
    "[dm] jack → galactica-captain: marker",
  ]);

  const audit = fake
    .received(captainAccount)
    .filter((line) => line.includes("#agent-dms"))
    .join("\n");

  for (const secret of ["s3cret", "hunter2", "xoxb", "NickServ", "VERSION"])
    expect(audit).not.toContain(secret);
});

test("irc audit: the audit channel is never a conversation and never loops", async () => {
  const { fake, store, captain, chief, prompts, crewPrompts } = await setup({
    answer: () => "Ack.",
  });

  fake.say(jack, "#agent-dms", "galactica-captain: status?");
  fake.say(jack, "#agent-dms", "all hands, report");
  fake.say(jack, "#agent-dms", "[dm] jack → galactica-captain: hi");
  fake.say(jack, captainAccount, "marker");
  await mirrored(fake, "[dm] galactica-captain → jack: Ack.");
  await delay(300);
  // Only the DM reached a session; the captain's own audit lines and
  // Channel traffic in #agent-dms are never mirrored or admitted.
  expect(prompts).toEqual(["marker"]);
  expect(crewPrompts).toEqual([]);
  expect(store.queueCounts(captain.key).done).toBe(1);
  expect(store.queueCounts(chief.key).done).toBe(0);
  expect(mirror(fake)).toEqual([
    "[dm] jack → galactica-captain: marker",
    "[dm] galactica-captain → jack: Ack.",
  ]);
  // No catch-up for the audit channel either.
  expect(
    fake.historyRequests.some((request) => request[1] === "#agent-dms"),
  ).toBe(false);
});

test("irc audit: a multiline DM is one entry", async () => {
  const multi = await setup({
    multiline: true,
    answer: () => "Line one.\nLine two.",
  });

  multi.fake.sayLines(jack, captainAccount, [
    { text: "oops, wrong window" },
    { text: "identify galactica-captain hunter2" },
  ]);
  await until(() => mirror(multi.fake).length === 2, 5000, "first reply");
  multi.fake.sayLines(jack, captainAccount, [
    { text: "please check" },
    { text: "the reactor and the" },
    { text: " fuel lines", concat: true },
  ]);
  await until(() => mirror(multi.fake).length === 4, 5000, "second reply");
  expect(mirror(multi.fake)).toEqual([
    `[dm] jack → galactica-captain: ${withheld}`,
    "[dm] galactica-captain → jack: Line one.\nLine two.",
    "[dm] jack → galactica-captain: please check\nthe reactor and the fuel lines",
    "[dm] galactica-captain → jack: Line one.\nLine two.",
  ]);
  // Multi-line entries went as one batch each; the withheld one is a line.
  expect(
    multi.fake.batches.filter((batch) => batch.target === "#agent-dms"),
  ).toHaveLength(3);
  expect(
    multi.fake
      .received(captainAccount)
      .filter((line) => line.includes("#agent-dms"))
      .join("\n"),
  ).not.toContain("hunter2");
}, 30_000); // One fresh open (10 s), join (5 s), two replies (10 s), margin (5 s).

test("irc audit: long entries split into whole IRC lines without multiline", async () => {
  const plain = await setup();
  const long = `report ${"fuel nominal ".repeat(38)}end`;
  plain.fake.say(jack, captainAccount, long);
  await until(
    () => mirror(plain.fake).some((line) => line.endsWith(" end")),
    5000,
    "split entry",
  );
  const lines = mirror(plain.fake);
  expect(lines.length).toBeGreaterThan(1);
  expect(lines[0]?.startsWith("[dm] jack → galactica-captain: report")).toBe(
    true,
  );
  expect(lines.join(" ")).toBe(`[dm] jack → galactica-captain: ${long}`);

  for (const line of plain.fake.received(captainAccount))
    expect(utf8Bytes(line) + 2).toBeLessThanOrEqual(512);
}, 30_000); // One fresh open (10 s), join (5 s), reply (5 s), margin (10 s).

test("irc audit: a failed or full mirror never blocks the DM reply", async () => {
  const refused = await setup({
    answer: (text) => `Re: ${text}`,
  });

  refused.fake.refuse.add(`${captainAccount} #agent-dms`);
  refused.fake.say(jack, captainAccount, "secret plans");
  await until(
    () =>
      lineOf(refused.fake.received(captainAccount), "PRIVMSG").some(
        (m) => m.params[0] === "jack" && m.params[1] === "Re: secret plans",
      ),
    5000,
    "reply delivered",
  );
  await until(
    () =>
      refused.logs.some((line) =>
        line.includes("IRC DM audit line not posted"),
      ),
    5000,
    "failure logged",
  );
  expect(refused.logs.join("\n")).not.toContain("secret plans");
  // The mirror recovers for later entries.
  refused.fake.refuse.clear();
  refused.fake.say(jack, captainAccount, "later");
  await mirrored(refused.fake, "[dm] jack → galactica-captain: later");
  await refused.close();

  // The captain cannot join the audit channel: the queue fills and drops,
  // And every reply is still delivered.
  const full = await setup({
    captainInvited: false,
    auditQueue: 2,
    answer: (text) => `Re: ${text}`,
  });

  for (const text of ["one", "two", "three"])
    full.fake.say(jack, captainAccount, text);
  await until(
    () => full.store.queueCounts(full.captain.key).done === 3,
    5000,
    "three replies",
  );
  expect(
    lineOf(full.fake.received(captainAccount), "PRIVMSG")
      .filter((m) => m.params[0] === "jack")
      .map((m) => m.params[1]),
  ).toEqual(["Re: one", "Re: two", "Re: three"]);
  expect(mirror(full.fake)).toEqual([]);
  await full.close();

  // Three DMs and three replies: six entries, two kept, four dropped.
  const drops = full.logs.filter((line) =>
    line.includes("IRC DM audit lines dropped"),
  );

  expect(drops.length).toBeGreaterThan(0);
  expect(drops.at(-1)).toContain('"dropped":4');
  expect(
    full.logs.some((line) => line.includes("IRC DM audit lines not posted")),
  ).toBe(true);

  for (const text of ["Re: one", '"one"', "three"])
    expect(full.logs.join("\n")).not.toContain(text);
});

test("irc audit: crew never join the audit channel; config keeps it apart", async () => {
  const { fake, chief, captain, logs } = await setup();

  // A retry may send another JOIN before the server confirms the first one.
  const crewJoinTargets = () =>
    new Set(
      lineOf(fake.received(chiefAccount), "JOIN").flatMap((m) =>
        (m.params[0] ?? "").split(","),
      ),
    );

  expect(crewJoinTargets()).toEqual(new Set(["#ship-galactica"]));
  expect(
    lineOf(fake.received(captainAccount), "JOIN").flatMap((m) =>
      (m.params[0] ?? "").split(","),
    ),
  ).toEqual(expect.arrayContaining(["#ship-galactica", "#agent-dms"]));
  // An invite to the audit channel is ignored by crew.
  fake.sendTo(chiefAccount, `:jack!u@h INVITE ${chiefAccount} #agent-dms`);
  await until(
    () =>
      logs.some((line) =>
        line.includes("Ignored IRC invite to an unlisted channel"),
      ),
    1000,
    "crew rejected the audit channel invite",
  );
  expect(crewJoinTargets()).toEqual(new Set(["#ship-galactica"]));
  expect(chief.client.inChannel("#agent-dms")).toBe(false);
  expect(captain.client.inChannel("#agent-dms")).toBe(true);

  // The audit channel is never a captain or crew channel.
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema)(
        shipConfig(6667, { audit: { channel: "#Ship-Galactica" } }),
      ),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema)(
        shipConfig(6667, { audit: { channel: "#agent dms" } }),
      ),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema)(
        shipConfig(6667, { audit: { channel: "#agent-dms", x: 1 } }),
      ),
    ),
  ).toBe(false);

  // Nor a ship channel of another registration on the same server.
  const other = {
    ...shipConfig(6667),
    id: "pegasus-irc",
    account: "pegasus-captain",
    passwordEnv: "STARGATE_IRC_PEGASUS_CAPTAIN",
    channels: ["#ship-pegasus", "#agent-dms"],
    crew: [],
    audit: undefined,
    backend: { ...backend, sessionID: "ses_pegasus" },
  };

  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(configSchema)({
        irc: [shipConfig(6667), other],
      }),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(configSchema)({
        irc: [shipConfig(6667), { ...other, channels: ["#ship-pegasus"] }],
      }),
    ),
  ).toBe(true);

  // Defaults: no audit, DMs answered by the agent.
  const plain = Schema.decodeUnknownSync(ircSchema)({
    ...shipConfig(6667),
    audit: undefined,
  });

  expect(plain.audit).toBeUndefined();
  expect(plain.dmPolicy).toBe("agent");
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema)(
        shipConfig(6667, { dmPolicy: "ignore" }),
      ),
    ),
  ).toBe(false);
});

test("irc audit: the audit channel is no ship channel anywhere, under any folding", () => {
  const other = (
    channels: string[],
    server: Record<string, unknown> = {
      host: "127.0.0.1",
      port: 6667,
      tls: false,
    },
  ) => ({
    ...shipConfig(6667),
    id: "pegasus-irc",
    server,
    account: "pegasus-captain",
    passwordEnv: "STARGATE_IRC_PEGASUS_CAPTAIN",
    channels,
    crew: [],
    audit: undefined,
    backend: { ...backend, sessionID: "ses_pegasus" },
  });

  const accepted = (...irc: Record<string, unknown>[]) =>
    Result.isSuccess(Schema.decodeUnknownResult(configSchema)({ irc }));

  const elsewhere = { host: "irc.example", port: 6697, tls: true };
  // Another host name or port is no proof of another server.
  expect(
    accepted(
      shipConfig(6667),
      other(["#ship-pegasus", "#agent-dms"], elsewhere),
    ),
  ).toBe(false);
  expect(
    accepted(shipConfig(6667), other(["#ship-pegasus", "#AGENT-DMS"])),
  ).toBe(false);
  // Unicode letter case and compatibility forms fold too.
  expect(
    accepted(
      shipConfig(6667, { audit: { channel: "#Ärger-dms" } }),
      other(["#ärger-dms"], elsewhere),
    ),
  ).toBe(false);
  expect(
    accepted(
      shipConfig(6667, { audit: { channel: "#STRASSE" } }),
      other(["#straße"]),
    ),
  ).toBe(false);
  expect(accepted(shipConfig(6667), other(["#\uff41gent-dms"]))).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema)(
        shipConfig(6667, {
          channels: ["#ship-galactica", "#ärger"],
          audit: { channel: "#ÄRGER" },
        }),
      ),
    ),
  ).toBe(false);
  expect(accepted(shipConfig(6667), other(["#ship-pegasus"], elsewhere))).toBe(
    true,
  );
});

test("irc audit: names any runtime casemapping joins are refused by config", () => {
  const pegasus = (channel: string) => ({
    ...shipConfig(6667),
    id: "pegasus-irc",
    account: "pegasus-captain",
    passwordEnv: "STARGATE_IRC_PEGASUS_CAPTAIN",
    channels: [channel],
    crew: [],
    audit: undefined,
    backend: { ...backend, sessionID: "ses_pegasus" },
  });

  const accepted = (audit: string, ship: string) =>
    Result.isSuccess(
      Schema.decodeUnknownResult(configSchema)({
        irc: [shipConfig(6667, { audit: { channel: audit } }), pegasus(ship)],
      }),
    );

  // Regression: the server folds both to "#straße".
  expect(fold("#STRAẞE", "unicode")).toBe(fold("#straße", "unicode"));
  expect(accepted("#STRAẞE", "#straße")).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema)(
        shipConfig(6667, {
          channels: ["#ship-galactica", "#straße"],
          audit: { channel: "#STRAẞE" },
        }),
      ),
    ),
  ).toBe(false);

  // Property: equal under any runtime CASEMAPPING ⇒ refused by config.
  const tricky = [
    "#STRAẞE",
    "#straße",
    "#STRASSE",
    "#strasse",
    "#Straße",
    "#ﬀ-ops",
    "#ff-ops",
    "#FF-OPS",
    "#ﬁle",
    "#file",
    "#İstanbul",
    "#istanbul",
    "#ıstanbul",
    "#ISTANBUL",
    "#i\u0307stanbul",
    "#\u212Aelvin",
    "#kelvin",
    "#KELVIN",
    "#\u2126hm",
    "#ωhm",
    "#Ωhm",
    "#ａｇｅｎｔ-dms",
    "#agent-dms",
    "#AGENT-DMS",
    "#Ａgent-DMS",
    "#Å",
    "#A\u030A",
    "#å",
    "#a\u030A",
    "#\u212B",
    "#[ship]",
    "#{ship}",
    "#~ship",
    "#^ship",
    "#\\ship",
    "#|ship",
    "#ǅ",
    "#ǆ",
    "#Ǆ",
    "#σς",
    "#ΣΣ",
    "#σσ",
    "#ſhip",
    "#ship",
  ];

  const names = [
    ...new Set(
      tricky.flatMap((name) => [name, name.toUpperCase(), name.toLowerCase()]),
    ),
  ].filter((name) =>
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema.fields.channels)([name]),
    ),
  );

  const mappings: Casemapping[] = [
    "ascii",
    "rfc1459",
    "strict-rfc1459",
    "unicode",
  ];

  const leaks: string[] = [];
  let equalPairs = 0;

  for (const audit of names)
    for (const ship of names) {
      if (audit === ship) continue;

      if (!mappings.some((m) => fold(audit, m) === fold(ship, m))) continue;
      equalPairs++;

      if (accepted(audit, ship)) leaks.push(`${audit} / ${ship}`);
    }

  expect(equalPairs).toBeGreaterThan(100);
  expect(leaks).toEqual([]);
});

test("irc send queue: a send that times out before its write is never written", async () => {
  const fake = new FakeIrcServer({
    accounts: { [captainAccount]: "captain-pass" },
    caps: baseCaps,
  }).start();

  cleanup.push(() => fake.stop());

  const client = new IrcClient({
    host: "127.0.0.1",
    port: fake.port,
    tls: false,
    account: captainAccount,
    password: "captain-pass",
    nick: captainAccount,
    channels: ["#ship-galactica"],
    log: capture().log,
    timing: { burst: 1, intervalMs: 300, confirmMs: 150, reconnectMinMs: 20 },
  });

  const controller = new AbortController();
  const loop = client.run(controller.signal);
  cleanup.push(async () => {
    controller.abort();
    await loop;
  });
  await until(() => client.inChannel("#ship-galactica"), 5000, "joined");
  await delay(400);

  // Unlabeled JOINs hold the throttle; the labeled sends behind them
  // Time out while still queued.
  for (let i = 0; i < 4; i++) client.join("#ship-galactica");

  const outcomes = await Promise.allSettled([
    client.privmsg("jack", "normal lane"),
    client.privmsg("#ship-galactica", "low lane", {}, undefined, "low"),
  ]);

  expect(outcomes.map((outcome) => outcome.status)).toEqual([
    "rejected",
    "rejected",
  ]);

  for (const outcome of outcomes)
    if (outcome.status === "rejected")
      expect(String(outcome.reason)).toContain("expired");
  await delay(1600);
  const sent = fake.received(captainAccount).join("\n");
  expect(sent).not.toContain("normal lane");
  expect(sent).not.toContain("low lane");
});

test("irc audit: an entry that expires in the send queue counts as dropped", async () => {
  const { fake, captain, logs } = await setup({
    // One throttle interval fits the deadline; five JOINs ahead do not.
    timing: { burst: 1, intervalMs: 300, confirmMs: 400 },
  });

  await delay(400);

  // Rejoining the audit channel queues a line and nothing else.
  for (let i = 0; i < 6; i++) captain.client.join("#agent-dms");
  fake.say(jack, captainAccount, "during the backlog");
  await until(
    () => logs.some((line) => line.includes("IRC DM audit lines dropped")),
    5000,
    "expiry counted",
  );
  await delay(2000);
  expect(mirror(fake)).toEqual([]);
  fake.say(jack, captainAccount, "after the backlog");
  await mirrored(fake, "[dm] jack → galactica-captain: after the backlog");
  expect(logs.join("\n")).not.toContain("during the backlog");
}, 35_000); // Open (10 s), join/drop/mirror (3 * 5 s), delay (2 s), margin (8 s).

test("irc audit: dmPolicy redirect points every DM to the ship channel", async () => {
  const { fake, store, captain, chief, prompts } = await setup({
    extra: { dmPolicy: "redirect" },
    answer: () => "On it.",
  });

  const notices = (account: string) =>
    lineOf(fake.received(account), "NOTICE")
      .filter((m) => m.params[0] === "jack")
      .map((m) => m.params[1]);

  fake.say(jack, captainAccount, "deploy now");
  await mirrored(
    fake,
    "[dm] galactica-captain → jack: Please ask in #ship-galactica",
  );
  expect(notices(captainAccount)).toEqual(["Please ask in #ship-galactica"]);
  // Repeats within the cooldown are recorded, not answered again.
  fake.say(jack, captainAccount, "deploy now!!");
  // A NOTICE is never answered (no auto-reply loops between bots).
  fake.say({ nick: "bob", account: "bob" }, captainAccount, "hi", {}, "NOTICE");
  fake.say(jack, chiefAccount, "hi chief");
  await mirrored(
    fake,
    "[dm] galactica-chief → jack: Please ask in #ship-galactica",
  );
  await mirrored(fake, "[dm] bob → galactica-captain: hi");

  // Without an account there is no answer: rotating nicks cannot flood.
  for (const nick of ["ghost1", "ghost2", "ghost3"])
    fake.say({ nick }, captainAccount, "hi?");
  await mirrored(fake, "[dm] ghost3 (no account) → galactica-captain: hi?");
  await delay(200);
  expect(
    lineOf(fake.received(captainAccount), "NOTICE").filter((m) =>
      m.params[0]?.startsWith("ghost"),
    ),
  ).toHaveLength(0);
  expect(notices(captainAccount)).toEqual(["Please ask in #ship-galactica"]);
  expect(notices(chiefAccount)).toEqual(["Please ask in #ship-galactica"]);
  expect(
    lineOf(fake.received("bob"), "NOTICE").length +
      lineOf(fake.received(captainAccount), "NOTICE").filter(
        (m) => m.params[0] === "bob",
      ).length,
  ).toBe(0);
  expect(mirror(fake)).toEqual(
    expect.arrayContaining([
      "[dm] jack → galactica-captain: deploy now",
      "[dm] jack → galactica-captain: deploy now!!",
      "[dm] jack → galactica-chief: hi chief",
    ]),
  );
  // No DM ever became a turn; channel mentions still do.
  expect(prompts).toEqual([]);
  expect(store.queueCounts(chief.key).done).toBe(0);
  fake.say(jack, "#ship-galactica", "galactica-captain: status?");
  await until(() => prompts.length === 1, 5000, "channel turn");
  expect(prompts).toEqual(["status?"]);
  await until(() => store.queueCounts(captain.key).done === 1, 5000, "done");

  // Redirect also works without an audit channel.
  const bare = await setup({
    extra: { dmPolicy: "redirect", audit: undefined },
  });

  bare.fake.say(jack, captainAccount, "hello?");
  await until(
    () =>
      lineOf(bare.fake.received(captainAccount), "NOTICE").some(
        (m) => m.params[0] === "jack",
      ),
    5000,
    "redirect without audit",
  );
  expect(bare.prompts).toEqual([]);
  expect(bare.captain.client.inChannel("#agent-dms")).toBe(false);
});

test("irc audit: CTCP wrappers never hide a credential or services command", () => {
  const entry = (text: string) =>
    auditLine({
      direction: "in",
      agent: captainAccount,
      peer: { nick: "jack", account: "jack" },
      text,
    });

  const hidden = `[dm] jack → galactica-captain: ${withheld}`;
  expect(entry("\u0001ACTION identify secret\u0001")).toBe(
    `[dm] * jack ${withheld} (→ galactica-captain)`,
  );

  for (const text of [
    "hello\n\u0001ACTION identify secret\u0001",
    "ok \u0001ACTION set password hunter2\u0001 thanks",
    "fine\n\u0001VERSION identify secret",
    "note\n\u0001PING /msg NickServ identify secret\u0001",
    "a\n\u0001\u0001ACTION ghost galactica-captain pw\u0001",
  ])
    expect(entry(text)).toBe(hidden);
  // A harmless ACTION stays visible; "identify" in prose is not a command.
  expect(entry("\u0001ACTION waves\u0001")).toBe(
    "[dm] * jack waves (→ galactica-captain)",
  );
  expect(entry("please identify the failing test")).toBe(
    "[dm] jack → galactica-captain: please identify the failing test",
  );
});

test("strict human-wake catch-up never redirects historical DMs before the replay guard", async () => {
  const extra = {
    dmPolicy: "redirect",
    access: {
      channelRequests: "nick-mention",
      humanWakeChannels: [{ channel: "#ship-galactica", replies: "all" }],
    },
    fleetPolicy: {
      role: "captain",
      humanAccounts: ["jack"],
      agentAccounts: [captainAccount, chiefAccount],
      assignedCheckout: "/workspace",
      capabilities: ["read_code"],
    },
  };

  const first = await setup({ extra });
  await first.close();
  const time = new Date().toISOString();
  first.fake.say(jack, captainAccount, "historical DM", {
    time,
    msgid: "old-redirect",
  });

  const resumed = await setup({
    extra,
    reuse: { fake: first.fake, store: first.store },
  });

  await mirrored(
    first.fake,
    `[dm ${time.slice(0, 16)}Z] jack → galactica-captain: historical DM`,
  );
  first.fake.sendTo(captainAccount, "PING :replayed-redirect-barrier");
  await until(
    () =>
      lineOf(first.fake.received(captainAccount), "PONG").some(
        (m) => m.params[0] === "replayed-redirect-barrier",
      ),
    3000,
    "replayed DM processed",
  );
  expect(
    lineOf(first.fake.received(captainAccount), "NOTICE").filter(
      (m) => m.params[0] === "jack",
    ),
  ).toEqual([]);
  first.fake.say(jack, captainAccount, "fresh DM");
  await until(
    () =>
      lineOf(first.fake.received(captainAccount), "NOTICE").some(
        (m) => m.params[0] === "jack",
      ),
    3000,
    "only live DM redirected",
  );
  expect(resumed.prompts).toEqual([]);
}, 10_000);

test("private operator controls stay out of the model and audit, including replay and a wrong account", async () => {
  const { fake, store, captain, prompts } = await setup({
    extra: {
      features: { questions: true },
      questionOperator: "operator",
      access: { allowedAccounts: ["operator", "other"] },
      fleetPolicy: {
        role: "captain",
        humanAccounts: ["operator", "other"],
        agentAccounts: [captainAccount, chiefAccount],
        assignedCheckout: "/workspace",
        capabilities: ["read_code"],
      },
    },
  });

  const q = store.backgroundCases.remember(captain.key, "operator", {
    id: "form_1",
    sessionID: "ses_captain",
    inputID: "msg_orphan",
    toolMessageID: "msg_tool",
    toolCallID: "call_1",
    fingerprint: "a".repeat(64),
    title: "Private",
    fields: [{ key: "q0", type: "string" }],
  });

  if (!q) throw new Error("Missing case");
  const token = store.backgroundCases.show(q.reference);

  if (!token) throw new Error("Missing token");
  const route = captain.transport.questions?.operator;

  if (!route) throw new Error("Missing configured route");
  fake.setUser("operator", "operator");
  await route.send("private outgoing form", () => true);
  await until(
    () =>
      fake
        .received(captainAccount)
        .some((l) => l.includes("PRIVMSG operator :private outgoing form")),
    3000,
    "bound DM",
  );
  const seen: string[] = [];
  captain.operatorQuestion = async (actor, text, connected) => {
    if (connected()) seen.push(actor + " " + text);
  };

  const op = { nick: "operator", account: "operator" };
  fake.sendTo(captainAccount, ":fixture BATCH +old chathistory operator");
  fake.say(op, captainAccount, "show " + q.reference, { batch: "old" });
  fake.sendTo(captainAccount, ":fixture BATCH -old");
  fake.say(
    { nick: "other", account: "other" },
    captainAccount,
    "answer " + token + " forbidden",
  );
  fake.say(op, captainAccount, "show " + q.reference);
  fake.say(op, captainAccount, "answer " + token + " private-choice");
  await until(() => seen.length >= 2, 3000, "live operator controls");
  expect(seen).toEqual([
    "operator show " + q.reference,
    "operator answer " + token + " private-choice",
  ]);
  expect(prompts).toEqual([]);
  expect(store.queueCounts(captain.key).queued).toBe(0);
  expect(mirror(fake).join(" ")).not.toMatch(
    /private-choice|private outgoing form|forbidden|show Q/,
  );
});

test("private clarification configuration requires an admitted human and a pinned OpenCode captain", () => {
  const policy = {
    role: "captain",
    humanAccounts: ["operator"],
    agentAccounts: [captainAccount],
    assignedCheckout: "/workspace",
    capabilities: ["read_code"],
  };

  const config = shipConfig(6667, {
    features: { questions: true },
    questionOperator: "operator",
    fleetPolicy: policy,
  });

  const decode = Schema.decodeUnknownResult(ircSchema);
  expect(Result.isSuccess(decode(config))).toBe(true);

  for (const change of [
    { features: { questions: false } },
    { questionOperator: "visitor" },
    { access: { allowedAccounts: ["other"] } },
    { access: { deniedAccounts: ["operator"] } },
    { access: { deniedChannels: ["*"] } },
    { backend: { ...backend, sessionID: undefined } },
  ])
    expect(Result.isFailure(decode({ ...config, ...change }))).toBe(true);
});
