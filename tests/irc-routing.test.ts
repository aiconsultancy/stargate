import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { sourceLine } from "../src/backend";
import { configSchema, type IrcConfig, ircSchema } from "../src/config";
import {
  casemapping,
  fold,
  formatMessage,
  parseMessage,
} from "../src/irc/protocol";
import {
  type IrcMember,
  ircAllowed,
  ircInstructions,
  ircNote,
  routeIrcMessage,
  withinLimits,
} from "../src/irc/routing";
import { IrcShip, ircKey } from "../src/irc/ship";
import { checkCredentials } from "../src/setup";
import { Store } from "../src/store";
import { bot } from "./fixtures";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const backend = {
  type: "opencode",
  url: "http://localhost:4096",
  directory: "/workspace",
};

function shipConfig(overrides: Record<string, unknown> = {}): IrcConfig {
  return ircSchema.parse({
    id: "galactica-irc",
    server: { host: "127.0.0.1", port: 6667, tls: false },
    account: "galactica",
    passwordEnv: "POGO_IRC_GALACTICA",
    channels: ["#galactica"],
    access: {
      deniedAccounts: ["mallory"],
      textMentions: ["all captains"],
      peerCaptains: ["defiant"],
      crewTurnsPerHour: 2,
    },
    crew: [
      {
        id: "chief",
        account: "galactica-chief",
        passwordEnv: "POGO_IRC_GALACTICA_CHIEF",
        channels: ["#galactica"],
        backend: { ...backend, agent: "galactica-crew-chief" },
      },
    ],
    backend: { ...backend, sessionID: "ses_captain" },
    ...overrides,
  });
}

const config = shipConfig();
const captain: IrcMember = {
  id: "galactica-irc",
  role: "captain",
  account: "galactica",
  nick: "galactica",
  channels: ["#galactica"],
  key: "captain-key",
};
const chief: IrcMember = {
  id: "galactica-irc-chief",
  role: "crew",
  account: "galactica-chief",
  nick: "galactica-chief",
  channels: ["#galactica"],
  key: "chief-key",
};
const own = new Set(["own-1"]);

function message(
  target: string,
  text: string,
  tags: Record<string, string> = {},
  command = "PRIVMSG",
) {
  const parsed = parseMessage(
    `${formatMessage(command, [target, text], {
      time: "2026-11-12T10:00:00.000Z",
      msgid: "abc123",
      ...tags,
    })}`.replace(/^(@\S+ )/, "$1:someone!u@h "),
  );
  if (!parsed) throw new Error("bad fixture");
  return parsed;
}

function route(
  target: string,
  text: string,
  tags: Record<string, string> = { account: "jack" },
  member = captain,
  command = "PRIVMSG",
) {
  return routeIrcMessage(message(target, text, tags, command), {
    config,
    member,
    currentNick: member.nick,
    sent: (msgid) => own.has(msgid),
    now: () => 0,
    fold: (value) => fold(value),
  });
}

test("irc routing: account tag is identity; own and denied accounts never admit", () => {
  expect(route("#galactica", "galactica: hi", {})).toBeUndefined();
  expect(
    route("#galactica", "galactica: hi", { account: "*" }),
  ).toBeUndefined();
  expect(
    route("#galactica", "galactica: hi", { account: "galactica" }),
  ).toBeUndefined();
  expect(
    route("#galactica", "galactica: hi", { account: "GALACTICA" }),
  ).toBeUndefined();
  expect(
    route("#galactica", "galactica: hi", { account: "Mallory" }),
  ).toBeUndefined();
  const admitted = route("#Galactica", "galactica: status?", {
    account: "Jack",
  });
  expect(admitted).toEqual({
    eventId: "#galactica:abc123",
    botKey: "captain-key",
    conversation: JSON.stringify(["captain-key", "#galactica"]),
    channel: "#galactica",
    thread: "abc123",
    user: "jack",
    text: "status?",
    received: Date.parse("2026-11-12T10:00:00.000Z"),
  });
});

test("irc routing: channel triggers are mentions, text mentions and replies", () => {
  expect(route("#galactica", "just chatting")).toBeUndefined();
  expect(route("#other", "galactica: hi")).toBeUndefined();
  expect(route("#galactica", "ask galactica-chief instead")).toBeUndefined();
  expect(route("#galactica", "what does Galactica think?")?.text).toBe(
    "what does Galactica think?",
  );
  expect(route("#galactica", "@galactica, ping")?.text).toBe(
    "@galactica, ping",
  );
  const named = route("#galactica", "All Captains: report in");
  expect(named?.textMention).toBe("all captains");
  // Text mentions address the captain, not crew.
  expect(
    route("#galactica", "all captains: report", undefined, chief),
  ).toBeUndefined();
  expect(
    route("#galactica", "yes please", {
      account: "jack",
      "+draft/reply": "own-1",
    })?.text,
  ).toBe("yes please");
  expect(
    route("#galactica", "yes please", {
      account: "jack",
      "+draft/reply": "other",
    }),
  ).toBeUndefined();
  expect(
    route(
      "#galactica",
      "galactica: hi",
      { account: "jack" },
      captain,
      "NOTICE",
    ),
  ).toBeUndefined();
  expect(route("#galactica", "\u0001ACTION galactica\u0001")).toBeUndefined();
  expect(route("#galactica", "galactica:")).toBeUndefined();
});

test("irc routing: direct messages are per account and captain-only", () => {
  const direct = route("galactica", "hello there");
  expect(direct?.channel).toBe("jack");
  expect(direct?.conversation).toBe(JSON.stringify(["captain-key", "jack"]));
  expect(direct?.eventId).toBe("jack:abc123");
  expect(route("someone-else", "hello")).toBeUndefined();
  expect(route("galactica-chief", "hello", undefined, chief)).toBeUndefined();
  const closed = shipConfig({
    access: { deniedChannels: ["*"] },
  });
  expect(
    routeIrcMessage(message("galactica", "hi", { account: "jack" }), {
      config: closed,
      member: captain,
      currentNick: "galactica",
      sent: () => false,
      now: () => 0,
      fold: (value) => fold(value),
    }),
  ).toBeUndefined();
  // A missing msgid gets a stable synthetic ID for deduplication.
  const parsed = parseMessage("@account=jack :jack!u@h PRIVMSG galactica :hi");
  if (!parsed) throw new Error("bad fixture");
  const context = {
    config,
    member: captain,
    currentNick: "galactica",
    sent: () => false,
    now: () => 5,
    fold: (value: string) => fold(value),
  };
  const first = routeIrcMessage(parsed, context);
  expect(first?.thread).toMatch(/^pogo-[0-9a-f]{32}$/);
  expect(routeIrcMessage(parsed, context)?.eventId).toBe(first?.eventId);
});

test("irc routing: ship and peer senders are marked; access rechecks", () => {
  expect(
    route("#galactica", "galactica: done", { account: "galactica-chief" })
      ?.sender,
  ).toBe("crew");
  expect(
    route(
      "#galactica",
      "galactica-chief: check CI",
      { account: "galactica" },
      chief,
    )?.sender,
  ).toBe("crew");
  expect(
    route("#galactica", "galactica: hello", { account: "Defiant" })?.sender,
  ).toBe("captain");
  expect(ircAllowed(config, captain, "jack", "#galactica")).toBe(true);
  expect(ircAllowed(config, captain, "jack", "#other")).toBe(false);
  expect(ircAllowed(config, captain, "mallory", "#galactica")).toBe(false);
  expect(ircAllowed(config, captain, "jack", "jack")).toBe(true);
  expect(ircAllowed(config, chief, "jack", "jack")).toBe(false);
  expect(
    ircNote({ channel: "#galactica", user: "galactica", sender: "crew" }),
  ).toContain("[[pogo:silent]]");
  expect(ircNote({ channel: "jack", user: "jack", sender: null })).toBe(
    "[IRC a direct message, from account jack. IRC shows plain text only.]",
  );
  expect(
    sourceLine({
      source: {
        transport: "irc",
        channel: "#galactica",
        thread: "m1",
        message: "m1",
        user: "jack",
        sender: "crew",
      },
    }),
  ).toBe("s=irc;c=%23galactica;t=m1;m=m1;u=jack;k=crew");
});

test("irc limits: peers per conversation, ship messages per channel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pogo-irc-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, "pogo.sqlite"));
  cleanup.push(() => store.close());
  const limits = {
    shipKeys: ["captain-key", "chief-key"],
    count: (input: Parameters<Store["turnsSince"]>[0]) =>
      store.turnsSince(input),
  };
  const admit = (
    member: IrcMember,
    account: string,
    msgid: string,
    time: string,
    target = "#galactica",
    text = `${member.nick}: hi`,
  ) => {
    const admission = routeIrcMessage(
      message(target, text, { account, msgid, time }),
      {
        config,
        member,
        currentNick: member.nick,
        sent: () => false,
        now: () => 0,
        fold: (value) => fold(value),
      },
    );
    if (!admission) throw new Error("not routed");
    if (!withinLimits(admission, config, limits)) return false;
    return store.enqueue(admission);
  };
  const at = (minute: number) =>
    new Date(Date.UTC(2026, 10, 12, 10, minute)).toISOString();
  // Ship messages: 2 per channel per hour across captain and crew.
  expect(admit(captain, "galactica-chief", "s1", at(0))).toBe(true);
  expect(admit(chief, "galactica", "s2", at(1))).toBe(true);
  expect(admit(captain, "galactica-chief", "s3", at(2))).toBe(false);
  expect(admit(captain, "galactica-chief", "s4", at(61))).toBe(true);
  // People are never limited.
  for (let i = 0; i < 6; i++)
    expect(admit(captain, "jack", `h${i}`, at(5))).toBe(true);
  // Peer captains: 5 per conversation per hour; another conversation is separate.
  for (let i = 0; i < 5; i++)
    expect(admit(captain, "defiant", `p${i}`, at(10 + i))).toBe(true);
  expect(admit(captain, "defiant", "p5", at(20))).toBe(false);
  expect(admit(captain, "defiant", "d0", at(20), "galactica", "hello")).toBe(
    true,
  );
  expect(admit(captain, "defiant", "p6", at(75))).toBe(true);
  // Duplicate delivery (chathistory replay) is deduplicated by event ID.
  expect(admit(captain, "jack", "h0", at(5))).toBe(false);
});

test("irc config: strict server, crew and pin rules", () => {
  const parse = (overrides: Record<string, unknown>) =>
    ircSchema.safeParse({ ...shipConfig(), ...overrides }).success;
  expect(parse({})).toBe(true);
  expect(
    parse({ server: { host: "10.23.45.1", port: 6667, tls: false } }),
  ).toBe(false);
  expect(parse({ server: { host: "::1", port: 6667, tls: false } })).toBe(true);
  expect(
    parse({
      server: { host: "127.0.0.1", port: 6667, tls: false, caFile: "/ca.pem" },
    }),
  ).toBe(false);
  expect(
    parse({
      server: { host: "10.23.45.1", port: 6697, tls: true, caFile: "/ca.pem" },
    }),
  ).toBe(true);
  expect(
    parse({ server: { host: "h", port: 6697, tls: true, caFile: "ca.pem" } }),
  ).toBe(false);
  expect(parse({ channels: ["galactica"] })).toBe(false);
  expect(parse({ channels: ["#a b"] })).toBe(false);
  expect(parse({ channels: ["#a\u0007"] })).toBe(false);
  // Channel names are bounded in bytes, so a JOIN line always fits.
  expect(parse({ channels: [`#${"c".repeat(49)}`], crew: [] })).toBe(true);
  expect(parse({ channels: [`#${"é".repeat(30)}`], crew: [] })).toBe(false);
  const crew = shipConfig().crew[0];
  expect(parse({ crew: [{ ...crew, channels: ["#elsewhere"] }] })).toBe(false);
  expect(
    parse({ crew: [{ ...crew, channels: ["#galactica", "#galactica"] }] }),
  ).toBe(false);
  expect(
    parse({
      crew: [{ ...crew, backend: { ...backend, sessionID: "ses_crew" } }],
    }),
  ).toBe(false);
  expect(parse({ crew: [{ ...crew, account: "Galactica" }] })).toBe(false);
  expect(
    parse({ crew: [{ ...crew, passwordEnv: "POGO_IRC_GALACTICA" }] }),
  ).toBe(false);
  expect(parse({ access: { peerCaptains: ["galactica-chief"] } })).toBe(false);
  expect(parse({ unknown: true })).toBe(false);
  // Configuration compares names under rfc1459: [ ] equal { }.
  expect(parse({ channels: ["#ship[1]", "#SHIP{1}"], crew: [] })).toBe(false);
  // Crew channels must be captain channels exactly, up to ASCII case: a
  // name that differs under the ascii mapping (Ergo's default) is refused.
  expect(
    parse({
      channels: ["#ship[1]"],
      crew: [{ ...crew, channels: ["#ship{1}"] }],
    }),
  ).toBe(false);
  expect(
    parse({
      channels: ["#ship[1]"],
      crew: [{ ...crew, channels: ["#SHIP[1]"] }],
    }),
  ).toBe(true);
  expect(
    parse({
      channels: ["#galactica"],
      crew: [{ ...crew, channels: ["#Galactica"] }],
    }),
  ).toBe(true);
  expect(
    parse({ account: "ship[1]", crew: [{ ...crew, account: "SHIP{1}" }] }),
  ).toBe(false);
});

test("irc config: IRC-only configs, shared Slack pins and unique IDs", () => {
  const irc = shipConfig();
  const slack = {
    ...bot("galactica"),
    backend: { ...backend, sessionID: "ses_captain" },
  };
  expect(configSchema.safeParse({ irc: [irc] }).success).toBe(true);
  expect(configSchema.safeParse({}).success).toBe(false);
  // One Slack bot and one IRC captain may share a pinned captain session.
  expect(configSchema.safeParse({ bots: [slack], irc: [irc] }).success).toBe(
    true,
  );
  expect(
    configSchema.safeParse({
      irc: [
        irc,
        { ...irc, id: "other", account: "x", passwordEnv: "X", crew: [] },
      ],
    }).success,
  ).toBe(false);
  expect(
    configSchema.safeParse({ bots: [bot("galactica-irc")], irc: [irc] })
      .success,
  ).toBe(false);
  expect(
    configSchema.safeParse({ bots: [bot("galactica-irc-chief")], irc: [irc] })
      .success,
  ).toBe(false);
  // Namespaces: transport, registration, server, account and backend settings.
  const server = irc.server;
  const key = ircKey("galactica-irc", server, "Galactica", irc.backend);
  expect(key).toBe(ircKey("galactica-irc", server, "galactica", irc.backend));
  expect(key).not.toBe(
    ircKey("galactica-irc", server, "galactica", {
      ...backend,
      type: "opencode",
      directory: "/other",
      headersEnv: {},
      permissions: [],
    }),
  );
  expect(key).not.toBe(ircKey("other", server, "galactica", irc.backend));
});

test("irc config check: password references and caFile, values never printed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pogo-irc-check-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "pogo.json");
  const irc = shipConfig();
  const env = {
    POGO_IRC_GALACTICA: "captain-secret",
    POGO_IRC_GALACTICA_CHIEF: "chief-secret",
  };
  await checkCredentials(path, [], env, [irc]);
  const missing = await checkCredentials(
    path,
    [],
    { POGO_IRC_GALACTICA: "captain-secret" },
    [irc],
  ).catch((error: unknown) => error);
  expect(String(missing)).toContain("Missing IRC password");
  expect(String(missing)).not.toContain("captain-secret");
  const withCa = shipConfig({
    server: {
      host: "10.23.45.1",
      port: 6697,
      tls: true,
      caFile: join(directory, "missing-ca.pem"),
    },
  });
  await expect(checkCredentials(path, [], env, [withCa])).rejects.toThrow(
    "caFile",
  );
  await writeFile(join(directory, "missing-ca.pem"), "not checked here");
  await checkCredentials(path, [], env, [withCa]);
  // Generated captain definitions explain IRC source lines.
  expect(
    await Bun.file(
      new URL("../templates/agents/captain.md", import.meta.url),
    ).text(),
  ).toContain("{{ircInstructions}}");
  expect(ircInstructions).toContain("s=irc");
});

test("irc casemapping: rfc1459 by default, ascii and strict per ISUPPORT", () => {
  expect(fold("#Ga[L]\\~")).toBe("#ga{l}|^");
  expect(fold("#Ga[L]\\~", "rfc1459")).toBe("#ga{l}|^");
  expect(fold("#Ga[L]\\~", "strict-rfc1459")).toBe("#ga{l}|~");
  expect(fold("#Ga[L]\\~É", "ascii")).toBe("#ga[l]\\~É");
  expect(fold("#ÉCOLE", "unicode")).toBe("#école");
  expect(casemapping("ascii")).toBe("ascii");
  expect(casemapping("RFC1459")).toBe("rfc1459");
  expect(casemapping("rfc1459-strict")).toBe("strict-rfc1459");
  expect(casemapping(undefined)).toBe("rfc1459");
  expect(casemapping("rfc8265")).toBe("unicode");
});

test("irc casemapping: one folded channel key for caps, routing and denies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pogo-irc-fold-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, "pogo.sqlite"));
  cleanup.push(() => store.close());
  // The crew spells the ship channel differently from the captain.
  const mixed = shipConfig({
    channels: ["#galactica", "#ship[1]"],
    crew: [{ ...shipConfig().crew[0], channels: ["#Galactica"] }],
  });
  const crewMember: IrcMember = { ...chief, channels: ["#Galactica"] };
  const captainMember: IrcMember = { ...captain, channels: mixed.channels };
  const rfc = (value: string) => fold(value, "rfc1459");
  const routeAs = (
    member: IrcMember,
    target: string,
    account: string,
    msgid: string,
    config = mixed,
    caseFold = rfc,
  ) =>
    routeIrcMessage(
      message(target, `${member.nick}: hi`, {
        account,
        msgid,
        time: "2026-11-12T10:00:00.000Z",
      }),
      {
        config,
        member,
        currentNick: member.nick,
        sent: () => false,
        now: () => 0,
        fold: caseFold,
      },
    );
  const limits = {
    shipKeys: [captainMember.key, crewMember.key],
    count: (input: Parameters<Store["turnsSince"]>[0]) =>
      store.turnsSince(input),
  };
  const admit = (admission: ReturnType<typeof routeAs>) => {
    if (!admission) throw new Error("not routed");
    return withinLimits(admission, mixed, limits) && store.enqueue(admission);
  };
  // crewTurnsPerHour is 2 for the whole ship channel, whatever its spelling.
  expect(
    admit(routeAs(captainMember, "#galactica", "galactica-chief", "a")),
  ).toBe(true);
  expect(admit(routeAs(crewMember, "#GALACTICA", "galactica", "b"))).toBe(true);
  const third = routeAs(crewMember, "#Galactica", "galactica", "c");
  expect(third?.channel).toBe("#galactica");
  expect(third?.conversation).toBe(
    JSON.stringify([crewMember.key, "#galactica"]),
  );
  expect(admit(third)).toBe(false);
  // rfc1459 treats [ ] as { }; ascii does not.
  expect(routeAs(captainMember, "#SHIP{1}", "jack", "d")?.channel).toBe(
    "#ship{1}",
  );
  expect(
    routeAs(captainMember, "#SHIP{1}", "jack", "e", mixed, (v) =>
      fold(v, "ascii"),
    ),
  ).toBeUndefined();
  const denied = shipConfig({
    channels: ["#ship[1]"],
    crew: [],
    access: { deniedChannels: ["#Ship{1}"], deniedAccounts: ["JACK[1]"] },
  });
  expect(
    routeAs(captainMember, "#ship[1]", "bob", "f", denied),
  ).toBeUndefined();
  expect(ircAllowed(denied, captainMember, "bob", "#SHIP[1]", rfc)).toBe(false);
  expect(ircAllowed(denied, captainMember, "jack{1}", "jack{1}", rfc)).toBe(
    false,
  );
  expect(
    ircAllowed(denied, captainMember, "jack{1}", "jack{1}", (v) =>
      fold(v, "ascii"),
    ),
  ).toBe(true);
});

test("irc namespace: host, port and network name select a new namespace", async () => {
  const keys = async (server: Record<string, unknown>) => {
    const ship = await IrcShip.create(
      shipConfig({ server }),
      new Store(":memory:"),
      pino({ level: "silent" }),
      {
        env: {
          POGO_IRC_GALACTICA: "x",
          POGO_IRC_GALACTICA_CHIEF: "y",
        },
      },
    );
    return ship.registrations.map((registration) => registration.key);
  };
  const local = { host: "127.0.0.1", port: 6667, tls: false };
  const base = await keys(local);
  expect(await keys({ ...local })).toEqual(base);
  const changed = [
    await keys({ ...local, port: 6668 }),
    await keys({ host: "::1", port: 6667, tls: false }),
    await keys({ ...local, network: "Fleet" }),
    await keys({ ...local, network: "Other" }),
  ];
  for (const other of changed)
    for (const [index, key] of other.entries())
      expect(key).not.toBe(base[index]);
  // The network name compares without case; TLS alone is not identity.
  expect(await keys({ ...local, network: "fleet" })).toEqual(
    await keys({ ...local, network: "FLEET" }),
  );
});

test("irc crew confinement: runtime checks use the negotiated CASEMAPPING", () => {
  // A config that bypassed the schema: crew #ship{1}, captain #ship[1].
  const base = shipConfig({ channels: ["#ship[1]"], crew: [] });
  const [crewConfig] = shipConfig().crew;
  if (!crewConfig) throw new Error("missing crew fixture");
  const loose: IrcConfig = {
    ...base,
    crew: [{ ...crewConfig, channels: ["#ship{1}"] }],
  };
  const member: IrcMember = { ...chief, channels: ["#ship{1}"] };
  const ascii = (value: string) => fold(value, "ascii");
  const rfc = (value: string) => fold(value, "rfc1459");
  // Under ascii these are two channels: the crew may not use #ship{1}.
  expect(ircAllowed(loose, member, "jack", "#ship{1}", ascii)).toBe(false);
  expect(ircAllowed(loose, member, "jack", "#ship{1}", rfc)).toBe(true);
  expect(
    routeIrcMessage(
      message("#ship{1}", "galactica-chief: hi", { account: "jack" }),
      {
        config: loose,
        member,
        currentNick: member.nick,
        sent: () => false,
        now: () => 0,
        fold: ascii,
      },
    ),
  ).toBeUndefined();
});
