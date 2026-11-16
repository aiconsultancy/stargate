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
  ircCrewInstructions,
  ircInstructions,
  ircNote,
  ircResultJobAllowed,
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
    passwordEnv: "STARGATE_IRC_GALACTICA",
    channels: ["#galactica"],
    access: {
      deniedAccounts: ["mallory"],
      textMentions: ["all captains"],
      peerCaptains: ["defiant"],
      shipTurnsPerAgentPerHour: 1,
    },
    crew: [
      {
        id: "chief",
        account: "galactica-chief",
        passwordEnv: "STARGATE_IRC_GALACTICA_CHIEF",
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

test("irc nick-mention access requires a live joined target, exact nick, and an allowlisted account with a msgid", () => {
  const restricted = shipConfig({
    access: {
      allowedAccounts: ["jack", "jac"],
      channelRequests: "nick-mention",
      textMentions: ["all captains"],
      deniedAccounts: ["jac"],
    },
  });
  const context = {
    config: restricted,
    member: captain,
    currentNick: "galactica-2",
    joined: (target: string) => target === "#galactica",
    sent: (id: string) => own.has(id),
    now: () => 0,
    fold: (value: string) => fold(value),
  };
  const admit = (m: ReturnType<typeof message>) => routeIrcMessage(m, context);
  expect(
    admit(message("#galactica", "Galactica-2: status?", { account: "JACK" })),
  ).toMatchObject({
    text: "status?",
    user: "jack",
    channel: "#galactica",
    thread: "abc123",
  });
  expect(
    admit(message("galactica-2", "status?", { account: "jack" })),
  ).toMatchObject({ channel: "jack", eventId: "jack:abc123" });
  for (const m of [
    message("#galactica", "galactica-2: status?", { account: "impostor" }),
    message("#galactica", "galactica-2: status?", { account: "jac" }),
    message("#galactica", "galactica-2: status?", { account: "jack", bot: "" }),
    message("#galactica", "galactica-2: status?", {
      account: "jack",
      msgid: "",
    }),
    message("#galactica", "galactica-2: status?"),
    message("#galactica", "galactica: status?", { account: "jack" }),
    message("#galactica", "galactica-22: status?", { account: "jack" }),
    message("#galactica", "all captains", { account: "jack" }),
    message("#galactica", "everyone", { account: "jack" }),
    message("#galactica", "reply only", {
      account: "jack",
      "+draft/reply": "own-1",
    }),
    message("#other", "galactica-2: status?", { account: "jack" }),
  ])
    expect(admit(m)).toBeUndefined();
  expect(
    routeIrcMessage(
      message("#galactica", "galactica-2: status?", { account: "jack" }),
      { ...context, joined: () => false },
    ),
  ).toBeUndefined();
});

test("irc config requires one credential and TLS for client PEM", () => {
  const certificate = {
    ...config,
    passwordEnv: undefined,
    clientPemFile: "/private/client.pem",
  };
  expect(ircSchema.safeParse(certificate).success).toBe(false);
  const secure = { ...certificate, server: { ...config.server, tls: true } };
  expect(ircSchema.safeParse(secure).success).toBe(true);
  expect(
    ircSchema.safeParse({ ...secure, passwordEnv: "IRC_PASSWORD" }).success,
  ).toBe(false);
  expect(
    ircSchema.safeParse({ ...secure, clientPemFile: undefined }).success,
  ).toBe(false);
  expect(
    ircSchema.safeParse({ ...secure, access: { allowedAccounts: ["*"] } })
      .success,
  ).toBe(false);
});

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
  expect(first?.thread).toMatch(/^stargate-[0-9a-f]{32}$/);
  expect(routeIrcMessage(parsed, context)?.eventId).toBe(first?.eventId);
});

test("irc reply context preserves request identity and ignores invalid parents", () => {
  const root = "root;with\\slash=equals";
  for (const tag of ["+draft/reply", "+reply"]) {
    const admission = route("#galactica", "galactica: check", {
      account: "jack",
      [tag]: root,
    });
    expect(admission).toMatchObject({ thread: "abc123", replyParent: root });
    expect(admission?.eventId).toBe("#galactica:abc123");
    expect(admission?.conversation).toBe(
      JSON.stringify(["captain-key", "#galactica"]),
    );
  }
  for (const parent of ["", "has space", "bad\nline", "a".repeat(129)]) {
    expect(
      route("#galactica", "galactica: check", {
        account: "jack",
        "+draft/reply": parent,
      })?.replyParent,
    ).toBeUndefined();
  }
  const source = {
    transport: "irc" as const,
    channel: "#galactica",
    thread: "request",
    message: "request",
    user: "jack",
    replyParent: root,
  };
  expect(sourceLine({ source })).toBe(
    `s=irc;c=%23galactica;t=request;m=request;u=jack;r=${encodeURIComponent(root)}`,
  );
  expect(
    sourceLine({ source: { ...source, replyParent: "bad\nline" } }),
  ).not.toContain(";r=");
  const { transport: _transport, ...slackSource } = source;
  expect(sourceLine({ source: slackSource })).not.toContain(";r=");
});

test("irc reply context flattens only known own answers, without changing admission", () => {
  const context = {
    config,
    member: captain,
    currentNick: captain.nick,
    sent: (id: string) => id === "own-1",
    now: () => 0,
    fold: (value: string) => fold(value),
    anchor: (id: string) => (id === "own-1" ? "root" : undefined),
  };
  const incoming = message("#galactica", "continue", {
    account: "jack",
    "+draft/reply": "own-1",
  });
  expect(routeIrcMessage(incoming, context)).toMatchObject({
    thread: "abc123",
    replyParent: "root",
    text: "continue",
  });
  expect(
    routeIrcMessage(
      { ...incoming, tags: new Map([["+draft/reply", "own-1"]]) },
      context,
    ),
  ).toBeUndefined();
  expect(
    routeIrcMessage(
      message("#galactica", "continue", {
        account: "jack",
        "+draft/reply": "someone-else",
      }),
      context,
    ),
  ).toBeUndefined();
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
  ).toContain("[[stargate:silent]]");
  expect(ircNote({ channel: "jack", user: "jack", sender: null })).toBe(
    "[IRC a direct message, from account jack. Reply only if you are tagged and can add something useful, asked directly, or once to an all-call; otherwise answer [[stargate:silent]]. No acknowledgements or thanks. Plain text only.]",
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
  const directory = await mkdtemp(join(tmpdir(), "stargate-irc-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, "stargate.sqlite"));
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
  // Ship messages: 1 per agent × 2 agents per channel per hour.
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
    parse({ server: { host: "10.23.45.67", port: 6667, tls: false } }),
  ).toBe(false);
  expect(parse({ server: { host: "::1", port: 6667, tls: false } })).toBe(true);
  expect(
    parse({
      server: { host: "127.0.0.1", port: 6667, tls: false, caFile: "/ca.pem" },
    }),
  ).toBe(false);
  expect(
    parse({
      server: { host: "10.23.45.67", port: 6697, tls: true, caFile: "/ca.pem" },
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
    parse({ crew: [{ ...crew, passwordEnv: "STARGATE_IRC_GALACTICA" }] }),
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
  const directory = await mkdtemp(join(tmpdir(), "stargate-irc-check-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "stargate.json");
  const irc = shipConfig();
  const env = {
    STARGATE_IRC_GALACTICA: "captain-secret",
    STARGATE_IRC_GALACTICA_CHIEF: "chief-secret",
  };
  await checkCredentials(path, [], env, [irc]);
  const missing = await checkCredentials(
    path,
    [],
    { STARGATE_IRC_GALACTICA: "captain-secret" },
    [irc],
  ).catch((error: unknown) => error);
  expect(String(missing)).toContain("Missing IRC password");
  expect(String(missing)).not.toContain("captain-secret");
  const withCa = shipConfig({
    server: {
      host: "10.23.45.67",
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
  const directory = await mkdtemp(join(tmpdir(), "stargate-irc-fold-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, "stargate.sqlite"));
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
  // 1 per agent × 2 agents: 2 for the whole ship channel, whatever its spelling.
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
          STARGATE_IRC_GALACTICA: "x",
          STARGATE_IRC_GALACTICA_CHIEF: "y",
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

test("irc ship cap: per agent, times the ship agents configured in the channel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-irc-cap-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, "stargate.sqlite"));
  cleanup.push(() => store.close());
  const [chiefConfig] = shipConfig().crew;
  if (!chiefConfig) throw new Error("missing crew fixture");
  // Captain in #galactica and #bridge; chief (spelled #Galactica) and
  // tyrol in #galactica only. Default: 60 ship messages per agent an hour.
  const ship = shipConfig({
    channels: ["#galactica", "#bridge"],
    access: {},
    crew: [
      { ...chiefConfig, channels: ["#Galactica"] },
      {
        ...chiefConfig,
        id: "tyrol",
        account: "galactica-tyrol",
        passwordEnv: "STARGATE_IRC_GALACTICA_TYROL",
      },
    ],
  });
  expect(ship.access.shipTurnsPerAgentPerHour).toBe(60);
  const two = shipConfig({ access: {} });
  const limits = {
    shipKeys: [captain.key, chief.key],
    count: (input: Parameters<Store["turnsSince"]>[0]) =>
      store.turnsSince(input),
  };
  let id = 0;
  const admitted = (config: IrcConfig, target: string, attempts: number) => {
    let count = 0;
    for (let i = 0; i < attempts; i++) {
      const admission = routeIrcMessage(
        message(target, "galactica: status", {
          account: "galactica-chief",
          msgid: `cap${++id}`,
          time: "2026-11-12T10:00:00.000Z",
        }),
        {
          config,
          member: { ...captain, channels: config.channels },
          currentNick: "galactica",
          sent: () => false,
          now: () => 0,
          fold: (value) => fold(value, "ascii"),
        },
      );
      if (!admission) throw new Error("not routed");
      if (withinLimits(admission, config, limits, (v) => fold(v, "ascii")))
        count += store.enqueue(admission) ? 1 : 0;
    }
    return count;
  };
  // Two agents (captain + chief) in #galactica: 120 admitted, the 121st dropped.
  expect(admitted(two, "#galactica", 121)).toBe(120);
  // Three agents in #galactica (crew spelling folded): 180 in total.
  expect(admitted(ship, "#GALACTICA", 61)).toBe(60);
  expect(admitted(ship, "#galactica", 1)).toBe(0);
  // #bridge has only the captain: 60.
  expect(admitted(ship, "#bridge", 61)).toBe(60);
  // 0 turns ship messages off.
  const off = shipConfig({
    channels: ["#galactica", "#quiet"],
    access: { shipTurnsPerAgentPerHour: 0 },
  });
  expect(admitted(off, "#quiet", 1)).toBe(0);
  expect(
    ircSchema.safeParse({ ...shipConfig(), access: { crewTurnsPerHour: 10 } })
      .success,
  ).toBe(false);
  expect(
    ircSchema.safeParse({
      ...shipConfig(),
      access: { shipTurnsPerAgentPerHour: 601 },
    }).success,
  ).toBe(false);
});

test("irc ship cap: a crew → captain DM is capped at per agent × 2", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-irc-dm-cap-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, "stargate.sqlite"));
  cleanup.push(() => store.close());
  const limits = {
    shipKeys: [captain.key, chief.key],
    count: (input: Parameters<Store["turnsSince"]>[0]) =>
      store.turnsSince(input),
  };
  const dm = (config: IrcConfig, msgid: string) => {
    const admission = routeIrcMessage(
      message("galactica", "status of the build?", {
        account: "galactica-chief",
        msgid,
        time: "2026-11-12T10:00:00.000Z",
      }),
      {
        config,
        member: captain,
        currentNick: "galactica",
        sent: () => false,
        now: () => 0,
        fold: (value) => fold(value, "ascii"),
      },
    );
    if (!admission) throw new Error("not routed");
    expect(admission.sender).toBe("crew");
    expect(admission.channel).toBe("galactica-chief");
    return (
      withinLimits(admission, config, limits, (v) => fold(v, "ascii")) &&
      store.enqueue(admission)
    );
  };
  // Default 60 per agent, two participants: 120 admitted, the 121st dropped.
  const ship = shipConfig({ access: {} });
  let admitted = 0;
  for (let i = 0; i < 121; i++) if (dm(ship, `dm${i}`)) admitted++;
  expect(admitted).toBe(120);
  // 0 still turns ship messages off, in direct messages too.
  const off = shipConfig({ access: { shipTurnsPerAgentPerHour: 0 } });
  const fresh = new Store(join(directory, "off.sqlite"));
  cleanup.push(() => fresh.close());
  const offLimits = {
    shipKeys: [captain.key],
    count: (input: Parameters<Store["turnsSince"]>[0]) =>
      fresh.turnsSince(input),
  };
  const admission = routeIrcMessage(
    message("galactica", "hello", { account: "galactica-chief", msgid: "x" }),
    {
      config: off,
      member: captain,
      currentNick: "galactica",
      sent: () => false,
      now: () => 0,
      fold: (value) => fold(value),
    },
  );
  if (!admission) throw new Error("not routed");
  expect(withinLimits(admission, off, offLimits)).toBe(false);
});

test("irc all-call: reaches every ship agent in the channel, word-bounded", async () => {
  const [chiefConfig] = shipConfig().crew;
  if (!chiefConfig) throw new Error("missing crew fixture");
  const ship = shipConfig({
    channels: ["#galactica", "#bridge"],
    access: {},
    crew: [
      chiefConfig,
      {
        ...chiefConfig,
        id: "tyrol",
        account: "galactica-tyrol",
        passwordEnv: "STARGATE_IRC_GALACTICA_TYROL",
        channels: ["#bridge"],
      },
    ],
  });
  expect(ship.access.allCallWords).toEqual([
    "all hands",
    "all crew",
    "everyone",
  ]);
  const tyrol: IrcMember = {
    ...chief,
    id: "galactica-irc-tyrol",
    account: "galactica-tyrol",
    nick: "galactica-tyrol",
    channels: ["#bridge"],
    key: "tyrol-key",
  };
  const members = {
    captain: { ...captain, channels: ship.channels },
    chief,
    tyrol,
  };
  const reach = (
    text: string,
    target = "#galactica",
    config = ship,
    account = "jack",
  ) =>
    Object.entries(members)
      .filter(
        ([, member]) =>
          routeIrcMessage(message(target, text, { account }), {
            config,
            member,
            currentNick: member.nick,
            sent: () => false,
            now: () => 0,
            fold: (value) => fold(value, "ascii"),
          }) !== undefined,
      )
      .map(([name]) => name);
  // Everyone in #galactica (captain, chief); tyrol is only in #bridge.
  expect(reach("Everyone, report fuel levels")).toEqual(["captain", "chief"]);
  expect(reach("ALL HANDS to stations")).toEqual(["captain", "chief"]);
  expect(reach("status, all crew?")).toEqual(["captain", "chief"]);
  expect(reach("everyone: muster", "#bridge")).toEqual(["captain", "tyrol"]);
  // Word boundaries: no partial words.
  expect(reach("everyones favourite build is green")).toEqual([]);
  expect(reach("allcrew")).toEqual([]);
  // Untagged traffic that is not an all-call reaches no crew.
  expect(reach("the build is green")).toEqual([]);
  // Tags still work and reach only the tagged agent.
  expect(reach("galactica-chief: check CI")).toEqual(["chief"]);
  // The admission records the all-call word for the session note.
  expect(
    routeIrcMessage(
      message("#galactica", "Everyone, report", { account: "jack" }),
      {
        config: ship,
        member: chief,
        currentNick: chief.nick,
        sent: () => false,
        now: () => 0,
        fold: (value) => fold(value),
      },
    )?.textMention,
  ).toBe("everyone");
  // The list is configurable per registration; [] turns all-calls off.
  const muster = shipConfig({ access: { allCallWords: ["muster"] } });
  expect(reach("muster on deck", "#galactica", muster)).toEqual([
    "captain",
    "chief",
  ]);
  expect(reach("everyone, report", "#galactica", muster)).toEqual([]);
  const none = shipConfig({ access: { allCallWords: [] } });
  expect(reach("everyone, report", "#galactica", none)).toEqual([]);
  expect(
    ircSchema.safeParse({ ...shipConfig(), access: { allCallWords: ["a,b"] } })
      .success,
  ).toBe(false);
});

test("irc all-call: ship senders count against the channel cap, people do not", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-irc-allcall-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, "stargate.sqlite"));
  cleanup.push(() => store.close());
  // 1 per agent × 2 agents (captain + chief) = 2 ship messages an hour.
  const config = shipConfig({ access: { shipTurnsPerAgentPerHour: 1 } });
  const limits = {
    shipKeys: [captain.key, chief.key],
    count: (input: Parameters<Store["turnsSince"]>[0]) =>
      store.turnsSince(input),
  };
  let id = 0;
  const call = (member: IrcMember, account: string) => {
    const admission = routeIrcMessage(
      message("#galactica", "everyone: report", {
        account,
        msgid: `all${++id}`,
        time: "2026-11-12T10:00:00.000Z",
      }),
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
    return withinLimits(admission, config, limits) && store.enqueue(admission);
  };
  // People are never capped by the ship limit.
  for (let i = 0; i < 5; i++) expect(call(chief, "jack")).toBe(true);
  // Ship all-calls fan out and count: the captain's reaches chief (1),
  // chief's reaches the captain (2), the next one is dropped.
  expect(call(chief, "galactica")).toBe(true);
  expect(call(captain, "galactica-chief")).toBe(true);
  expect(call(chief, "galactica")).toBe(false);
});

test("irc instructions: response policy, all-calls and crew routing via the captain", async () => {
  for (const text of [ircInstructions, ircCrewInstructions]) {
    expect(text).toContain("[[stargate:silent]]");
    expect(text).toContain("tagged");
    expect(text).toContain("asked directly");
    expect(text).toContain("all-call");
    expect(text).toContain("answer once");
    expect(text).toContain("acknowledgements");
    expect(text).toContain("one message");
  }
  // Crew speak to the captain. Crew-to-crew uses stargate_dm (reply needed now)
  // or stargate_mail (otherwise); those refuse an IRC session, so there the
  // crew member asks the captain to relay.
  expect(ircCrewInstructions).toContain("Speak to the captain");
  expect(ircCrewInstructions).toContain("stargate_dm");
  expect(ircCrewInstructions).toContain("stargate_mail");
  expect(ircCrewInstructions).toContain("ask the captain");
  expect(ircCrewInstructions).not.toContain("Mesij");
  expect(ircInstructions).toContain("You coordinate the crew");
  expect(ircInstructions).toContain("stargate_dm");
  // Crew definitions carry the paragraph; every unpinned IRC turn a reminder.
  expect(
    await Bun.file(
      new URL("../templates/agents/crew.md", import.meta.url),
    ).text(),
  ).toContain("{{ircCrewInstructions}}");
  const note = ircNote({ channel: "#galactica", user: "jack", sender: null });
  expect(note).toContain("[[stargate:silent]]");
  expect(note).toContain("all-call");
  expect(
    ircNote({
      channel: "#galactica",
      user: "jack",
      sender: null,
      textMention: "everyone",
    }),
  ).toContain("This is an all-call");
});

test("irc all-call: a mention or a reply does not hide the all-call", () => {
  // The all-call word is recorded even when a nick or a reply also admits.
  expect(
    route("#galactica", "galactica: all hands, status?")?.textMention,
  ).toBe("all hands");
  expect(
    route("#galactica", "everyone, confirm", {
      account: "jack",
      "+draft/reply": "own-1",
    })?.textMention,
  ).toBe("everyone");
  expect(
    route(
      "#galactica",
      "galactica-chief: all hands",
      { account: "jack" },
      chief,
    )?.textMention,
  ).toBe("all hands");
  // Without an all-call word, a mention records nothing, as before.
  expect(
    route("#galactica", "galactica: status?")?.textMention,
  ).toBeUndefined();
});

test("strict fleet peer context requires BOTH enrolled agent and explicit peer; source stays non-human", async () => {
  const fleet = {
    role: "rear_admiral",
    humanAccounts: ["jack"],
    agentAccounts: ["defiant", "phoenix"],
    assignedCheckout: "/workspace",
    capabilities: ["read_code", "dispatch"],
  };
  const access = {
    channelRequests: "nick-mention",
    allowedAccounts: ["jack", "defiant", "phoenix", "stranger"],
    peerCaptains: ["defiant", "stranger"],
    peerTurnsPerHour: 1,
  };
  const restricted = shipConfig({ fleetPolicy: fleet, access });
  const context = {
    config: restricted,
    member: captain,
    currentNick: "galactica",
    joined: (channel: string) => channel === "#galactica",
    sent: () => false,
    now: () => 0,
    fold: (value: string) => fold(value),
  };
  for (const target of ["#galactica", "galactica"]) {
    const admitted = routeIrcMessage(
      message(target, "Galactica: verified peer context", {
        account: "DEFIANT",
        bot: "",
      }),
      context,
    );
    expect(admitted).toMatchObject({ user: "defiant", sender: "captain" });
    if (!admitted) throw new Error("Expected enrolled peer");
    expect(
      withinLimits(admitted, restricted, {
        shipKeys: [captain.key],
        count: () => 1,
      }),
    ).toBe(false);
  }
  for (const candidate of [
    message("#galactica", "galactica: spoof", { account: "stranger", bot: "" }),
    message("#galactica", "galactica: not an explicit peer", {
      account: "phoenix",
      bot: "",
    }),
    message("#galactica", "galactica: nick is not identity", {
      account: "*",
      bot: "",
    }),
    message("#galactica", "galactica: no msgid", {
      account: "defiant",
      bot: "",
      msgid: "",
    }),
    message("#galactica", "no current nick mention", {
      account: "defiant",
      bot: "",
    }),
    message("#unjoined", "galactica: elsewhere", {
      account: "defiant",
      bot: "",
    }),
    message("galactica-old", "direct to old nick", {
      account: "defiant",
      bot: "",
    }),
    message("#galactica", "galactica: human bot-tag is not a peer", {
      account: "jack",
      bot: "",
    }),
  ])
    expect(routeIrcMessage(candidate, context)).toBeUndefined();
  const denied = shipConfig({
    fleetPolicy: fleet,
    access: { ...access, deniedAccounts: ["defiant"] },
  });
  expect(
    routeIrcMessage(
      message("#galactica", "galactica: denied", {
        account: "defiant",
        bot: "",
      }),
      { ...context, config: denied },
    ),
  ).toBeUndefined();
  const generic = shipConfig({ access });
  expect(
    routeIrcMessage(
      message("#galactica", "galactica: defaults unchanged", {
        account: "defiant",
        bot: "",
      }),
      { ...context, config: generic },
    ),
  ).toBeUndefined();
  const store = new Store(":memory:");
  cleanup.push(() => store.close());
  const ship = await IrcShip.create(
    restricted,
    store,
    pino({ enabled: false }),
    {
      env: {
        STARGATE_IRC_GALACTICA: "fixture-password",
        STARGATE_IRC_GALACTICA_CHIEF: "fixture-password",
      },
    },
  );
  cleanup.push(() => ship.close());
  const primary = ship.registrations[0];
  if (!primary) throw new Error("Missing primary");
  const admitted = routeIrcMessage(
    message("#galactica", "galactica: context", {
      account: "defiant",
      bot: "",
    }),
    context,
  );
  if (!admitted) throw new Error("Expected peer context");
  expect(
    primary.transport.source({
      ...admitted,
      id: 1,
      status: "queued",
      response: null,
      sent: 0,
      attempts: 0,
    }),
  ).toMatchObject({ authority: "agent", user: "defiant", sender: "captain" });
});

test("results mode: an explicit other fleet recipient overrides later mentions, replies and own-channel wake", () => {
  const restricted = shipConfig({
    fleetPolicy: {
      role: "captain",
      humanAccounts: ["jack"],
      agentAccounts: ["vance", "defiant"],
      assignedCheckout: "/workspace",
      capabilities: ["read_code", "dispatch"],
    },
    fleetControl: {
      socketPath: "/tmp/irc-routing.sock",
      statePath: "/tmp/irc-routing.sqlite",
      results: true,
      targets: [
        {
          id: "admiral",
          account: "vance",
          channel: "#command",
          sessionID: "ses_vance",
        },
      ],
    },
    access: {
      allowedAccounts: ["jack", "vance", "defiant"],
      peerCaptains: ["vance", "defiant"],
      wakeChannels: ["#galactica"],
    },
  });
  const context = {
    config: restricted,
    member: captain,
    currentNick: "galactica_",
    sent: () => true,
    joined: () => true,
    now: () => 0,
    fold: (value: string) => fold(value),
  };
  for (const text of [
    "vance: ask galactica to report",
    " VANCE, ask galactica to report ",
    "vance:galactica status",
    "admiral: ask galactica to report",
    "defiant: ask galactica to report",
    "vance: only you should wake",
  ])
    expect(
      routeIrcMessage(
        message("#galactica", text, {
          account: "jack",
          "+draft/reply": "own-1",
        }),
        context,
      ),
    ).toBeUndefined();
  for (const text of [
    "galactica_: ask vance to report",
    "galactica: ask vance to report",
    "vance-extra: galactica status",
    "Please ask vance: galactica status",
    "Ordinary human own-channel instruction",
    "galactica: vance: this is still addressed to galactica",
  ])
    expect(
      routeIrcMessage(
        message("#galactica", text, { account: "jack" }),
        context,
      ),
    ).toBeDefined();
  const fleetControl = restricted.fleetControl;
  if (!fleetControl) throw new Error("Missing fleet control fixture");
  const legacy = {
    ...restricted,
    fleetControl: { ...fleetControl, results: false },
  };
  expect(
    routeIrcMessage(
      message("#galactica", "vance: ask galactica to report", {
        account: "jack",
      }),
      { ...context, config: legacy },
    ),
  ).toBeDefined();
  const strict = shipConfig({
    ...restricted,
    access: {
      ...restricted.access,
      wakeChannels: undefined,
      channelRequests: "nick-mention",
    },
  });
  expect(
    routeIrcMessage(
      message("#galactica", "vance: ask galactica_ to report", {
        account: "jack",
      }),
      { ...context, config: strict },
    ),
  ).toBeUndefined();
  // Matching the current recipient must not override the ordinary ACL.
  expect(
    routeIrcMessage(
      message("#galactica", "galactica_: run", {
        account: "stranger",
      }),
      context,
    ),
  ).toBeUndefined();
  expect(ircResultJobAllowed(restricted, "vance", undefined)).toBe(false);
  expect(ircResultJobAllowed(restricted, "jack", undefined)).toBe(true);
  expect(ircResultJobAllowed(legacy, "vance", undefined)).toBe(true);
});
