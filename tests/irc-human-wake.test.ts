import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import type { AgentBackend, PromptSourceContext } from "../src/backend";
import { type IrcConfig, ircSchema } from "../src/config";
import { ircDashboardShip } from "../src/dashboard-source";
import { Gateway } from "../src/gateway";
import { fold, formatMessage, parseMessage } from "../src/irc/protocol";
import {
  type IrcMember,
  ircResultJobAllowed,
  routeIrcMessage,
} from "../src/irc/routing";
import { IrcShip } from "../src/irc/ship";
import { Store } from "../src/store";
import { FakeIrcServer, lineOf, until } from "./irc-fixture";

const close: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of close.splice(0).reverse()) await cleanup();
});
const captains = ["discovery", "phoenix", "prometheus", "protostar"];
const agents = ["vance", ...captains];
function config(account = "discovery", port = 6667): IrcConfig {
  const channels =
    account === "vance"
      ? ["#starbase", "#command"]
      : [`#${account}`, "#command"];
  return ircSchema.parse({
    id: account,
    server: { host: "127.0.0.1", port, tls: false },
    account,
    passwordEnv: "IRC_TEST_PASSWORD",
    channels,
    concurrency: 1,
    access: {
      allowedAccounts: ["jac", ...agents],
      channelRequests: "nick-mention",
      humanWakeChannels: channels
        .filter((channel) => account !== "vance" || channel === "#starbase")
        .map((channel) => ({
          channel,
          replies: account === "vance" ? "all" : "participating",
        })),
      allCallWords: [],
      peerCaptains: agents.filter((name) => name !== account),
    },
    fleetPolicy: {
      role: account === "vance" ? "rear_admiral" : "captain",
      humanAccounts: ["jac"],
      agentAccounts: agents,
      assignedCheckout: "/workspace",
      capabilities: ["read_code"],
    },
    fleetControl: {
      socketPath: "/tmp/irc-human-wake.sock",
      statePath: "/tmp/irc-human-wake.sqlite",
      results: true,
      targets: [
        {
          id: "other",
          account: account === "vance" ? "discovery" : "vance",
          channel: "#command",
          sessionID: "ses_other",
        },
      ],
    },
    backend: {
      type: "opencode",
      url: "http://localhost:4096",
      directory: "/workspace",
      sessionID: `ses_${account}`,
    },
    audit: { channel: "#audit" },
  });
}
function member(config: IrcConfig): IrcMember {
  return {
    id: config.id,
    key: config.id,
    account: config.account,
    nick: config.account,
    role: "captain",
    channels: config.channels,
  };
}
function wire(
  channel: string,
  text: string,
  tags: Record<string, string> = {},
) {
  const parsed = parseMessage(
    formatMessage("PRIVMSG", [channel, text], {
      account: "jac",
      msgid: "request",
      ...tags,
    }).replace(/^(@\S+ )/, "$1:jac!u@fixture "),
  );
  if (!parsed) throw new Error("Invalid fixture message");
  return parsed;
}
function route(
  config: IrcConfig,
  channel: string,
  text: string,
  tags: Record<string, string> = {},
  store?: Store,
) {
  return routeIrcMessage(wire(channel, text, tags), {
    config,
    member: member(config),
    currentNick: config.account,
    sent: () => false,
    joined: () => true,
    fold,
    now: () => 0,
    threadRoot: (channel, id) => store?.ircThreadRoot(config.id, channel, id),
    participating: (channel, root) =>
      store?.ircThreadParticipating(config.id, channel, root) ?? false,
  });
}

test("opt-in channel policy wakes all captains for human top-level messages, even another fleet addressee", () => {
  for (const account of captains) {
    const cfg = config(account);
    for (const text of [
      "rollcall please",
      "vance: arrange a rollcall",
      "phoenix: status",
    ]) {
      const input = route(cfg, "#command", text);
      expect(input).toBeDefined();
      expect(input?.threadInvitation).toBe(
        text.startsWith(`${account}:`) ? true : undefined,
      );
      expect(ircResultJobAllowed(cfg, member(cfg), account, "jac", input)).toBe(
        true,
      );
    }
    expect(route(cfg, `#${account}`, "own-channel work")).toBeDefined();
    expect(
      route(cfg, "#command", "peer chatter", { account: "vance", bot: "" }),
    ).toBeUndefined();
    expect(
      route(cfg, "#command", "stranger", { account: "stranger" }),
    ).toBeUndefined();
    expect(
      route(cfg, "#command", "no account", { account: "*" }),
    ).toBeUndefined();
    expect(route(cfg, "#command", "bot human", { bot: "" })).toBeUndefined();
  }
  const vance = config("vance");
  expect(route(vance, "#command", "rollcall please")).toBeUndefined();
  expect(route(vance, "#command", "vance: rollcall please")).toBeDefined();
  expect(route(vance, "#starbase", "rollcall please")).toBeDefined();
  expect(route(vance, "#audit", "vance: no conversation")).toBeUndefined();
  const cfg = config();
  const crew = {
    ...member(cfg),
    role: "crew" as const,
    account: "worker",
    nick: "worker",
  };
  expect(
    routeIrcMessage(wire("#command", "ordinary human broadcast"), {
      config: cfg,
      member: crew,
      currentNick: "worker",
      sent: () => false,
      joined: () => true,
      fold,
      now: () => 0,
    }),
  ).toBeUndefined();
});

test("only explicit invitations or confirmed own replies create durable thread participation", async () => {
  const directory = await mkdtemp("/tmp/opencode/irc-human-store-");
  close.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.sqlite");
  let store = new Store(path);
  const cfg = config();
  const broad = route(cfg, "#command", "top-level", { msgid: "root" }, store);
  if (!broad) throw new Error("Missing broad input");
  expect(store.enqueueIrcHuman(broad, false)).toBe(true);
  expect(store.ircThreadParticipating(cfg.id, "#command", "root")).toBe(false);
  expect(
    route(
      cfg,
      "#command",
      "unrelated follow-up",
      { "+draft/reply": "root" },
      store,
    ),
  ).toBeUndefined();
  expect(
    route(cfg, "#command", "unknown", { "+reply": "unknown" }, store),
  ).toBeUndefined();
  const invited = route(
    cfg,
    "#command",
    "discovery: please join",
    { msgid: "invite", "+draft/reply": "unknown" },
    store,
  );
  if (!invited) throw new Error("Missing invited input");
  expect(invited.threadInvitation).toBe(true);
  expect(
    route(
      cfg,
      "#command",
      "vance: discovery, please join",
      { msgid: "peer-addressed-invite", "+draft/reply": "unknown" },
      store,
    )?.threadInvitation,
  ).toBe(true);
  expect(store.enqueueIrcHuman(invited, true)).toBe(true);
  expect(
    route(cfg, "#command", "follow-up", { "+reply": "invite" }, store)
      ?.replyParent,
  ).toBe("unknown");
  expect(store.enqueueIrcHuman(broad, true)).toBe(false);
  expect(store.ircThreadParticipating(cfg.id, "#command", "root")).toBe(false);
  expect(store.ircPublished(cfg.id, "#command", "own-answer", "absent")).toBe(
    false,
  );
  expect(
    store.ircPublished(cfg.id, "#command", "own-answer", "root", "wrong-root"),
  ).toBe(false);
  expect(store.ircPublished(cfg.id, "#command", "own-answer", "root")).toBe(
    true,
  );
  expect(store.ircPublished(cfg.id, "#command", "own-answer", "root")).toBe(
    true,
  );
  store.close();
  store = new Store(path);
  try {
    expect(
      route(
        cfg,
        "#command",
        "after restart",
        { "+draft/reply": "own-answer" },
        store,
      )?.replyParent,
    ).toBe("root");
    expect(
      route(cfg, "#command", "direct root", { "+reply": "root" }, store)
        ?.replyParent,
    ).toBe("root");
    expect(
      route(cfg, "#command", "invited root", { "+reply": "unknown" }, store)
        ?.replyParent,
    ).toBe("unknown");
    expect(store.ircThreadParticipating("other", "#command", "root")).toBe(
      false,
    );
    expect(store.ircThreadParticipating(cfg.id, "#other", "root")).toBe(false);
    for (const tags of [
      { "+draft/reply": "" },
      { "+reply": "bad\nroot" },
      { "+draft/reply": "root", "+reply": "different" },
    ])
      for (const text of ["unaddressed", "discovery: explicitly addressed"])
        expect(route(cfg, "#command", text, tags, store)).toBeUndefined();
  } finally {
    store.close();
  }
});

test("all-replies mode admits unknown opaque parents from verified humans; other channels and captains stay restricted", () => {
  const store = new Store(":memory:");
  try {
    const cfg = config("vance");
    const broad = route(cfg, "#starbase", "root", { msgid: "root" }, store);
    if (!broad) throw new Error("Missing root");
    store.enqueueIrcHuman(broad, false);
    expect(
      route(
        cfg,
        "#starbase",
        "reply before own output",
        { "+draft/reply": "root" },
        store,
      ),
    ).toBeDefined();
    const unknown = route(
      cfg,
      "#starbase",
      "unknown reply",
      { "+draft/reply": "unknown" },
      store,
    );
    expect(unknown).toMatchObject({
      user: "jac",
      thread: "request",
      replyParent: "unknown",
      text: "unknown reply",
    });
    expect(unknown?.threadInvitation).toBeUndefined();
    expect(store.ircThreadRoot(cfg.id, "#starbase", "unknown")).toBeUndefined();
    expect(
      route(
        config(),
        "#command",
        "unknown reply",
        { "+draft/reply": "unknown" },
        store,
      ),
    ).toBeUndefined();
    expect(
      route(
        cfg,
        "#starbase",
        "vance: invited unknown",
        { "+draft/reply": "unknown" },
        store,
      )?.threadInvitation,
    ).toBe(true);
    expect(
      route(
        cfg,
        "#command",
        "ordinary reply",
        { "+draft/reply": "root" },
        store,
      ),
    ).toBeUndefined();
    const legacy = {
      ...cfg,
      access: { ...cfg.access, humanWakeChannels: undefined },
    };
    expect(route(legacy, "#starbase", "unaddressed")).toBeUndefined();
    expect(
      ircSchema.safeParse({ ...cfg, fleetPolicy: undefined }).success,
    ).toBe(false);
    expect(
      ircSchema.safeParse({
        ...cfg,
        access: {
          ...cfg.access,
          humanWakeChannels: [{ channel: "#not-joined", replies: "all" }],
        },
      }).success,
    ).toBe(false);
    expect(
      ircSchema.safeParse({
        ...cfg,
        access: {
          ...cfg.access,
          humanWakeChannels: [
            { channel: "#starbase", replies: "all" },
            { channel: "#STARBASE", replies: "participating" },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      ircSchema.safeParse({
        ...cfg,
        channels: [...cfg.channels, "#audit"],
        access: {
          ...cfg.access,
          humanWakeChannels: [{ channel: "#audit", replies: "all" }],
        },
      }).success,
    ).toBe(false);
  } finally {
    store.close();
  }
});

async function liveFixture() {
  const fake = new FakeIrcServer({
    accounts: Object.fromEntries(
      agents.map((account) => [account, "fixture-password"]),
    ),
  }).start();
  close.push(() => fake.stop());
  const directory = await mkdtemp("/tmp/opencode/irc-human-live-");
  close.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.sqlite");
  let store = new Store(path);
  const prompts: {
    account: string;
    sessionID: string;
    text: string;
    context?: PromptSourceContext;
  }[] = [];
  let ships: IrcShip[] = [];
  let controllers: AbortController[] = [];
  let workers: Promise<void>[] = [];
  const log = pino({ level: "silent" });
  const start = async () => {
    for (const account of agents) {
      const cfg = config(account, fake.port);
      const ship = await IrcShip.create(cfg, store, log, {
        env: { IRC_TEST_PASSWORD: "fixture-password" },
        timing: { reconnectMinMs: 20, intervalMs: 1, burst: 100 },
        readyMs: 2000,
      });
      const primary = ship.registrations[0];
      if (!primary) throw new Error("Missing captain");
      const backend: AgentBackend = {
        sessionID: `ses_${account}`,
        async createSession() {
          return `ses_${account}`;
        },
        async prompt(
          sessionID,
          text,
          _signal,
          _onText,
          _onInput,
          _files,
          context,
        ) {
          prompts.push({
            account,
            sessionID,
            text,
            ...(context ? { context } : {}),
          });
          return text.includes("remain silent")
            ? "[[stargate:silent]]"
            : `${account} reply`;
        },
        async close() {},
      };
      const detail = ircDashboardShip(primary, cfg, backend);
      if (detail.transport?.kind !== "irc")
        throw new Error("Missing IRC dashboard transport");
      expect(detail.transport.access.humanWakeChannels).toEqual(
        cfg.access.humanWakeChannels,
      );
      const controller = new AbortController();
      controllers.push(controller);
      workers.push(
        new Gateway(
          primary.settings,
          primary.identity,
          store,
          backend,
          primary.delivery,
          log,
          undefined,
          undefined,
          primary.transport,
        ).work(controller.signal),
      );
      ships.push(ship);
      ship.start(() => true);
    }
    await until(
      () =>
        ships.every((ship) =>
          ship.registrations[0]?.client.inChannel("#command"),
        ),
      5000,
      "all human wake agents joined",
    );
  };
  const stop = async () => {
    for (const controller of controllers) controller.abort();
    await Promise.all(workers);
    await Promise.all(ships.map((ship) => ship.close()));
    ships = [];
    controllers = [];
    workers = [];
  };
  close.push(async () => {
    await stop();
    store.close();
  });
  await start();
  const settled = () =>
    until(
      () =>
        ships.every((ship) => {
          const key = ship.registrations[0]?.key;
          if (!key) return false;
          const q = store.queueCounts(key);
          return q.queued + q.running + q.responding === 0;
        }),
      5000,
      "human wake requests settled",
    );
  return {
    fake,
    prompts,
    settled,
    get store() {
      return store;
    },
    get ships() {
      return ships;
    },
    async restart(between?: () => void) {
      await stop();
      store.close();
      store = new Store(path);
      between?.();
      await start();
    },
  };
}

test("real IRC intake keeps silent broad listeners out of threads, confirms publication, and survives restart/replay", async () => {
  const f = await liveFixture();
  const root = f.fake.say(
    { nick: "jac", account: "jac" },
    "#command",
    "vance: remain silent",
  );
  await until(
    () => f.prompts.length === 5,
    5000,
    "all captains and tagged Vance saw top-level input",
  );
  await f.settled();
  for (const ship of f.ships) {
    const primary = ship.registrations[0];
    if (!primary) throw new Error("Missing captain");
    expect(f.store.ircThreadParticipating(primary.key, "#command", root)).toBe(
      false,
    );
  }
  f.fake.say({ nick: "jac", account: "jac" }, "#command", "uninvited reply", {
    "+draft/reply": root,
  });
  // A later marker proves each socket processed earlier refused traffic.
  f.fake.say(
    { nick: "jac", account: "jac" },
    "#command",
    "discovery: please join",
    { "+draft/reply": root },
  );
  await until(
    () => f.prompts.length === 6,
    5000,
    "one captain explicitly invited",
  );
  await f.settled();
  const discovery = f.ships.find(
    (ship) => ship.registrations[0]?.account === "discovery",
  )?.registrations[0];
  if (!discovery) throw new Error("Missing discovery");
  const publication = () =>
    lineOf(f.fake.received("discovery"), "PRIVMSG").find(
      (line) =>
        line.params[0] === "#command" && line.params[1] === "discovery reply",
    );
  // The explicit invitation already records participation; wait for the real
  // wire response rather than treating that earlier state as delivery proof.
  await until(
    () => publication() !== undefined,
    5000,
    "own publication observed",
  );
  const own = publication();
  if (own?.tags.get("+draft/reply") !== root) {
    // Only synthetic fixture metadata: no full prompts or provider traffic.
    const calls = f.prompts
      .filter((prompt) => prompt.account === "discovery")
      .slice(-4)
      .map((prompt) => {
        const source = prompt.context?.source;
        const job = source
          ? f.store.jobByEvent(
              discovery.key,
              `${source.channel}:${source.message}`,
            )
          : undefined;
        return {
          sessionID: prompt.sessionID,
          expectedSilent: prompt.text.includes("remain silent"),
          source,
          job: job
            ? {
                id: job.id,
                eventId: job.eventId,
                thread: job.thread,
                replyParent: job.replyParent,
                status: job.status,
              }
            : null,
          storedParent: source
            ? f.store.ircReplyParent(discovery.key, source.thread)
            : undefined,
        };
      });
    console.error(
      "IRC_HUMAN_WAKE_REPLY_DIAGNOSTIC",
      JSON.stringify({
        root,
        selected: own ? { tags: [...own.tags], params: own.params } : null,
        hasMessageTags: discovery.client.hasCap("message-tags"),
        hasEchoMessage: discovery.client.hasCap("echo-message"),
        hasLabeledResponse: discovery.client.hasCap("labeled-response"),
        calls,
        queue: f.store.queueCounts(discovery.key),
        wire: f.fake
          .received("discovery")
          .filter((line) => {
            const command = parseMessage(line)?.command;
            return command === "PRIVMSG" || command === "BATCH";
          })
          .slice(-8),
      }),
    );
  }
  expect(own?.tags.get("+draft/reply")).toBe(root);
  await f.restart();
  const before = f.prompts.length;
  f.fake.say({ nick: "jac", account: "jac" }, "#command", "after restart", {
    "+draft/reply": root,
  });
  await until(
    () => f.prompts.length === before + 1,
    5000,
    "only participating discovery resumed",
  );
  await f.settled();
  expect(f.prompts.at(-1)?.account).toBe("discovery");
  const final = f.prompts.length;
  f.fake.say(
    { nick: "vance", account: "vance" },
    "#command",
    "ordinary peer chatter",
    { bot: "" },
  );
  f.fake.say(
    { nick: "jac", account: "jac" },
    "#audit",
    "discovery: audit must never wake",
  );
  f.fake.say(
    { nick: "jac", account: "jac" },
    "#command",
    "duplicate original",
    { msgid: root },
  );
  f.fake.say(
    { nick: "jac", account: "jac" },
    "#starbase",
    "final human marker",
  );
  await until(
    () => f.prompts.length === final + 1,
    5000,
    "starbase human marker",
  );
  await f.settled();
  expect(f.prompts.at(-1)?.account).toBe("vance");
  expect(f.prompts).toHaveLength(final + 1);
  const opaque = f.fake.say(
    { nick: "jac", account: "jac" },
    "#starbase",
    "human reply to unseen context",
    { "+draft/reply": "unseen-parent" },
  );
  await until(
    () => f.prompts.length === final + 2,
    5000,
    "Vance sees every valid human starbase reply",
  );
  await f.settled();
  expect(f.prompts.at(-1)?.account).toBe("vance");
  expect(f.prompts.at(-1)?.context?.source).toMatchObject({
    user: "jac",
    authority: "human",
    message: opaque,
    thread: opaque,
    replyParent: "unseen-parent",
  });
});

test("only matched actual own publication joins a broad-wake thread; forged own echoes cannot create membership", async () => {
  const f = await liveFixture();
  const root = f.fake.say(
    { nick: "jac", account: "jac" },
    "#command",
    "plain top-level request",
  );
  await until(() => f.prompts.length === 4, 5000, "four broad captain turns");
  await f.settled();
  for (const ship of f.ships) {
    const primary = ship.registrations[0];
    if (!primary) throw new Error("Missing captain");
    if (primary.account === "vance") continue;
    await until(
      () => f.store.ircThreadParticipating(primary.key, "#command", root),
      5000,
      "actual broad response confirmed",
    );
    f.fake.sendTo(
      primary.account,
      `@account=${primary.account};msgid=forged-own;+draft/reply=forged-root :${primary.account}!u@fixture PRIVMSG #command :Unmatched own echo`,
    );
    f.fake.sendTo(
      primary.account,
      `@account=jac;msgid=wrong-account-own;+draft/reply=wrong-root :${primary.account}!u@fixture PRIVMSG #command :Wrong SASL identity`,
    );
  }
  f.fake.say({ nick: "jac", account: "jac" }, "#command", "thread follow-up", {
    "+draft/reply": root,
  });
  await until(
    () => f.prompts.length === 8,
    5000,
    "actual publishers rejoin thread",
  );
  await f.settled();
  for (const ship of f.ships) {
    const primary = ship.registrations[0];
    if (!primary) throw new Error("Missing captain");
    expect(
      f.store.ircThreadParticipating(primary.key, "#command", "forged-root"),
    ).toBe(false);
    expect(
      f.store.ircThreadRoot(primary.key, "#command", "forged-own"),
    ).toBeUndefined();
    expect(
      f.store.ircThreadParticipating(primary.key, "#command", "wrong-root"),
    ).toBe(false);
  }
  let missed = "";
  await f.restart(() => {
    missed = f.fake.say(
      { nick: "jac", account: "jac" },
      "#command",
      "remain silent during catch-up",
    );
  });
  await until(
    () => f.prompts.length === 12,
    5000,
    "missed human root admitted once through history",
  );
  await f.settled();
  for (const ship of f.ships) {
    const primary = ship.registrations[0];
    if (!primary) throw new Error("Missing captain");
    expect(
      f.store.ircThreadParticipating(primary.key, "#command", missed),
    ).toBe(false);
  }
});
