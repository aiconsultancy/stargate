import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import pino from "pino";
import type { AgentBackend } from "../src/backends/backend";
import { botSchema } from "../src/config";
import { CrewWaiting } from "../src/crew/controls/waiting";
import { Gateway } from "../src/gateway/gateway";
import type { TransportDelivery } from "../src/gateway/ports";
import type { MetaOptions } from "../src/meta-commands/meta-commands";
import type { MetaRecords } from "../src/meta-commands/store";
import { NotificationStore } from "../src/notifications/preferences/notification-store";
import { notificationKey } from "../src/notifications/preferences/notifications";
import { PeerDirectory } from "../src/gateway/peers";
import { handleSlackRequest } from "../src/transports/slack/slack";
import { openStore } from "../src/app/open-store";
import { resolveWaiting, waitingSettingsPath } from "../src/gateway/waiting";
import { bot, event, identity } from "./fixtures";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const now = Date.parse("2026-11-17T12:00:00Z");

async function fixture(options: MetaOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "stargate-meta-"));
  const config = bot();

  if (config.backend.type !== "opencode") throw new Error("Expected OpenCode");
  config.backend.directory = directory;
  config.backend.agent = "adama";
  config.backend.sessionID = "ses_existing_captain";
  const store = openStore(join(directory, "gateway.sqlite"));
  cleanups.push(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const calls: string[] = [];

  const backend: AgentBackend = {
    async createSession() {
      calls.push("createSession");
      throw new Error("Backend deliberately unavailable");
    },
    async prompt() {
      calls.push("prompt");
      throw new Error("Backend deliberately unavailable");
    },
    async close() {},
  };

  const delivered: { channel: string; thread: string; text: string }[] = [];

  const slack: TransportDelivery = {
    async post(channel, thread, text) {
      delivered.push({ channel, thread, text });
    },
  };

  const peers = new PeerDirectory(
    async (user) => ({
      ok: true,
      user: {
        id: user,
        team_id: "T123",
        is_bot: true,
        deleted: false,
        name: "other-captain",
        profile: { bot_id: "BPEER" },
      },
    }),
    identity.team,
  );

  const createGateway = (queue = store) =>
    new Gateway(
      config,
      identity,
      queue,
      backend,
      slack,
      pino({ enabled: false }),
      undefined,
      peers,
      undefined,
      undefined,
      { now: () => now, ...options },
    );

  const gateway = createGateway();

  const authority = {
    options: {
      captainDirectory: directory,
      team: { captain: { id: "adama" } },
    },
    async captain(caller: { agent: string }) {
      if (caller.agent !== "adama") throw new Error("Not captain");
    },
  };

  const waiting = new CrewWaiting(authority);

  const caller = {
    agent: "adama",
    sessionID: "ses_existing_captain",
    signal: new AbortController().signal,
  };

  return {
    config,
    directory,
    store,
    gateway,
    delivered,
    calls,
    waiting,
    caller,
    createGateway,
    slack,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function noCaptainWork(f: Fixture) {
  expect(f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 100)).toEqual(
    [],
  );
  expect(f.calls).toEqual([]);
}

function reply(f: Fixture) {
  expect(f.delivered).toHaveLength(1);

  return f.delivered[0]?.text ?? "";
}

test("addressed /help replies locally despite backend outage; Socket Mode ACK follows reply", async () => {
  const f = await fixture();
  const order: string[] = [];
  const post = f.delivered.push.bind(f.delivered);
  // Observe real delivery and ACK, not an invented command-handler API.
  f.delivered.push = (...messages) => {
    order.push("reply");

    return post(...messages);
  };

  await handleSlackRequest(
    {
      type: "events_api",
      body: event("<@UBOT> /help"),
      async ack() {
        order.push("ack");
      },
    },
    (body) => f.gateway.receive(body),
    pino({ enabled: false }),
  );
  noCaptainWork(f);
  expect(reply(f)).toContain("/help");
  expect(reply(f)).toContain("/config");
  expect(reply(f)).toContain("waiting");
  expect(reply(f)).toContain("mutes");
  expect(order).toEqual(["reply", "ack"]);
});

test("/config reads the current CrewWaiting override without a captain turn", async () => {
  const f = await fixture();
  await f.waiting.run({ seconds: 7 }, f.caller);
  await f.gateway.receive(event("<@UBOT> /config"));
  noCaptainWork(f);
  expect(reply(f)).toMatch(/waiting[^\n]*7/i);
  expect(reply(f)).toContain("mutes");
});

for (const type of ["message", "app_mention"] as const) {
  test(`${type} accepts whitespace and newlines after this bot's tag`, async () => {
    const f = await fixture();
    const request = event("  <@UBOT> \n\t /config\t waiting \n 3  ");
    await f.gateway.receive({
      ...request,
      event: { ...request.event, type },
    });
    expect((await resolveWaiting(f.config)).delayMs).toBe(3000);
    noCaptainWork(f);
    expect(reply(f)).toContain("U123");
  });
}

test("an explicitly addressed DM command uses message.im and replies in its own thread", async () => {
  const f = await fixture();
  const request = event("<@UBOT> /help");
  await f.gateway.receive({
    ...request,
    event: {
      ...request.event,
      type: "message",
      channel: "D123",
      channel_type: "im",
    },
  });
  noCaptainWork(f);
  expect(f.delivered[0]).toMatchObject({ channel: "D123", thread: "1.000" });
  expect(reply(f)).toContain("/help");
});

for (const seconds of [0, 3, 3600, "off"] as const) {
  test(`/config waiting ${seconds} shares CrewWaiting's exact persisted value`, async () => {
    const f = await fixture();
    await f.gateway.receive(event(`<@UBOT> /config waiting ${seconds}`));
    const delayMs = seconds === "off" ? null : seconds * 1000;
    expect((await resolveWaiting(f.config)).delayMs).toBe(delayMs);
    expect(
      await Bun.file(waitingSettingsPath(f.directory, "adama")).json(),
    ).toEqual({ delayMs });
    noCaptainWork(f);
    expect(reply(f)).toContain("U123");
    // A subsequent crew-tool write must be visible to the command reader too.
    await f.waiting.run({ seconds: 9 }, f.caller);
    f.delivered.length = 0;
    await f.gateway.receive(event("<@UBOT> /config", "2.000"));
    noCaptainWork(f);
    expect(reply(f)).toMatch(/waiting[^\n]*9/i);
  });
}

test("waiting change replies in the originating thread with old/new values and actor", async () => {
  const f = await fixture();
  const request = event("<@UBOT> /config waiting 3", "2.000");
  await f.gateway.receive({
    ...request,
    event: { ...request.event, thread_ts: "1.000" },
  });
  noCaptainWork(f);
  expect(f.delivered[0]).toMatchObject({ channel: "C123", thread: "1.000" });
  const text = reply(f);
  expect(text).toContain("U123");
  expect(text).toMatch(/5.*3/s);
});

test("event retry and overlapping message/app_mention cannot reapply waiting change", async () => {
  const f = await fixture();
  const request = event("<@UBOT> /config waiting 3");
  await f.gateway.receive(request);
  expect((await resolveWaiting(f.config)).delayMs).toBe(3000);
  await f.waiting.run({ seconds: 8 }, f.caller);
  await f.gateway.receive(request);
  await f.gateway.receive({
    ...request,
    event_id: "EvDifferentEnvelope",
    event: { ...request.event, type: "message" },
  });
  expect((await resolveWaiting(f.config)).delayMs).toBe(8000);
  expect(f.delivered).toHaveLength(1);
  noCaptainWork(f);
});

test("/config mutes is a local read, not a captain request or setting mutation", async () => {
  const f = await fixture();
  await f.gateway.receive(event("<@UBOT> /config mutes"));
  noCaptainWork(f);
  expect(reply(f)).toMatch(/mute/i);
  expect((await resolveWaiting(f.config)).delayMs).toBe(5000);
  expect(
    await Bun.file(waitingSettingsPath(f.directory, "adama")).exists(),
  ).toBe(false);
});

for (const section of [
  undefined,
  "host",
  "agents",
  "stargate",
  "opencode",
  "proxy",
  "services",
  "starfleet",
]) {
  test(`/health ${section ?? "summary"} reads locally without a captain turn`, async () => {
    const reads: (string | undefined)[] = [];

    const f = await fixture({
      health: async (requested) => {
        reads.push(requested);

        return `⚠ ${requested ?? "summary"}: unknown`;
      },
    });

    await f.gateway.receive(
      event(`<@UBOT> /health${section ? ` ${section}` : ""}`),
    );
    expect(reads).toEqual([section]);
    expect(reply(f)).toBe(`⚠ ${section ?? "summary"}: unknown`);
    noCaptainWork(f);
  });
}

test("/health source failure is unknown without raw errors or a captain turn", async () => {
  const f = await fixture({
    health: async () => {
      throw new Error("secret-health-source");
    },
  });

  await f.gateway.receive(event("<@UBOT> /health"));
  expect(reply(f)).toContain("unknown");
  expect(reply(f)).not.toContain("secret-health-source");
  noCaptainWork(f);
});

test("/health refuses peer bots before reading any health source", async () => {
  let reads = 0;

  const f = await fixture({
    health: async () => {
      reads++;

      return "unexpected";
    },
  });

  f.config.access.peerCaptains = true;
  await f.gateway.receive({
    ...event("<@UBOT> /health"),
    event: {
      ...event("<@UBOT> /health").event,
      bot_id: "BPEER",
      user: "UPEER",
    },
  });
  expect(reads).toBe(0);
  expect(f.delivered).toEqual([]);
  noCaptainWork(f);
});

for (const command of ["/config system1 on", "/config system1 off"]) {
  test(`${command} is reserved, not implemented or sent to a model`, async () => {
    const f = await fixture();
    await f.gateway.receive(event(`<@UBOT> ${command}`));
    noCaptainWork(f);
    expect(reply(f)).toBe("not available yet (NET-1709)");
    expect((await resolveWaiting(f.config)).delayMs).toBe(5000);
  });
}

for (const value of ["", "enable", "ON", "on extra"]) {
  test(`/config system1 ${value} lists valid values locally`, async () => {
    const f = await fixture();
    await f.gateway.receive(event(`<@UBOT> /config system1 ${value}`));
    noCaptainWork(f);
    expect(reply(f)).toBe("valid values: on, off");
    expect((await resolveWaiting(f.config)).delayMs).toBe(5000);
  });
}

for (const command of ["/help", "/config"]) {
  test(`${command} lists the short System One syntax without old aliases`, async () => {
    const f = await fixture();
    await f.gateway.receive(event(`<@UBOT> ${command}`));
    noCaptainWork(f);
    expect(reply(f)).toContain("/config system1 <on|off>");
    expect(reply(f)).not.toContain("system one message");
    expect(reply(f)).not.toContain("/config enable");
    expect(reply(f)).not.toContain("/config disable");
  });
}

for (const command of [
  "/config enable system one message filtering",
  "/config disable system one message filtering",
  "/config enable system one message routing",
  "/config disable system one message routing",
  "/unknown",
  "/settings",
  "/waiting 3",
  "/config delay 3",
  "/config waiting",
  "/config waiting -1",
  "/config waiting 3601",
  "/config waiting 1.5",
  "/config waiting 1e2",
  "/config waiting NaN",
  "/config waiting Infinity",
  "/config waiting OFF",
  "/config waiting 3s",
  "/config waiting 3 extra",
  "/config mutes clear_all",
  "/help extra",
  "/config enable anything",
  "/config permissions *",
  "/config model other",
]) {
  test(`${command} returns short valid-command guidance, never a model fallback`, async () => {
    const f = await fixture();
    await f.gateway.receive(event(`<@UBOT> ${command}`));
    noCaptainWork(f);
    expect(reply(f)).toContain("/help");
    expect(reply(f)).toContain("/config");
    expect(reply(f).length).toBeLessThan(1000);
    expect((await resolveWaiting(f.config)).delayMs).toBe(5000);
  });
}

for (const [name, changes] of [
  ["wrong user", { event: { user: "UOTHER" } }],
  ["wrong channel", { event: { channel: "COTHER" } }],
  ["wrong app", { api_app_id: "AOTHER" }],
  ["wrong team", { team_id: "TOTHER" }],
  ["bot sender", { event: { bot_id: "BPEER", user: "UPEER" } }],
] as const) {
  test(`${name} cannot use a gateway command`, async () => {
    const f = await fixture();
    const request = event("<@UBOT> /config waiting 3");
    await f.gateway.receive({
      ...request,
      ...changes,
      event: { ...request.event, ...("event" in changes ? changes.event : {}) },
    });
    noCaptainWork(f);
    expect(f.delivered).toEqual([]);
    expect((await resolveWaiting(f.config)).delayMs).toBe(5000);
  });
}

test("even a directory-verified allowed peer captain cannot issue human commands", async () => {
  const f = await fixture();
  f.config.access.peerCaptains = true;
  f.config.access.users.push("UPEER");
  const request = event("<@UBOT> /config waiting 3");
  await f.gateway.receive({
    ...request,
    event: { ...request.event, bot_id: "BPEER", user: "UPEER" },
  });
  noCaptainWork(f);
  expect((await resolveWaiting(f.config)).delayMs).toBe(5000);
});

for (const rule of ["deniedUsers", "deniedChannels"] as const) {
  test(`${rule} overrides wildcard command access`, async () => {
    const f = await fixture();
    f.config.access.users = ["*"];
    f.config.access.channels = ["*"];
    f.config.access[rule] = [rule === "deniedUsers" ? "U123" : "C123"];
    await f.gateway.receive(event("<@UBOT> /config waiting 3"));
    noCaptainWork(f);
    expect(f.delivered).toEqual([]);
    expect((await resolveWaiting(f.config)).delayMs).toBe(5000);
  });
}

for (const text of [
  "<@UOTHER> /config waiting 3",
  "<@UBOT> /config waiting 3 <@UOTHER>",
]) {
  test(`multiple/different bot addressing is refused: ${text}`, async () => {
    const f = await fixture();
    await f.gateway.receive(event(text));
    noCaptainWork(f);
    expect((await resolveWaiting(f.config)).delayMs).toBe(5000);
  });
}

for (const [name, metadata] of [
  [
    "forwarded preview",
    {
      attachments: [{ is_msg_unfurl: true, text: "<@UBOT> /config waiting 3" }],
    },
  ],
  [
    "quoted rich text",
    {
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_quote",
              elements: [{ type: "text", text: "<@UBOT> /config waiting 3" }],
            },
          ],
        },
      ],
    },
  ],
  [
    "preformatted rich text",
    {
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_preformatted",
              elements: [{ type: "text", text: "<@UBOT> /config waiting 3" }],
            },
          ],
        },
      ],
    },
  ],
] as const) {
  test(`${name} cannot turn fallback text into an authorised command`, async () => {
    const f = await fixture();
    const request = event("<@UBOT> /config waiting 3");
    await f.gateway.receive({
      ...request,
      event: { ...request.event, ...metadata },
    });
    expect(
      f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 10),
    ).toHaveLength(1);
    expect(
      f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 10)[0]?.text,
    ).toBe("/config waiting 3");
    expect(f.calls).toEqual([]);
    expect((await resolveWaiting(f.config)).delayMs).toBe(5000);
  });
}

test("closed intake cannot change settings or reply", async () => {
  const f = await fixture();
  await f.gateway.receive(event("<@UBOT> /config waiting 3"), () => false);
  noCaptainWork(f);
  expect(f.delivered).toEqual([]);
  expect((await resolveWaiting(f.config)).delayMs).toBe(5000);
});

test("ordinary addressed chat containing a later slash retains existing queue behaviour", async () => {
  const f = await fixture();
  expect(
    await f.gateway.receive(event("<@UBOT> Explain /config waiting 3")),
  ).toBe(true);
  const queued = f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 10);
  expect(queued).toHaveLength(1);
  expect(queued[0]?.text).toBe("Explain /config waiting 3");
  expect(f.delivered).toEqual([]);
  expect(f.calls).toEqual([]);
});

test("!config is ordinary chat, not an unauthorised command alias", async () => {
  const f = await fixture();
  expect(await f.gateway.receive(event("<@UBOT> !config waiting 3"))).toBe(
    true,
  );
  const queued = f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 10);
  expect(queued).toHaveLength(1);
  expect(queued[0]?.text).toBe("!config waiting 3");
  expect((await resolveWaiting(f.config)).delayMs).toBe(5000);
  expect(f.delivered).toEqual([]);
});

for (const text of [
  "<@UBOT> > /config waiting 3",
  "> <@UBOT> /config waiting 3",
  "<@UBOT> `/config waiting 3`",
  "<@UBOT> ```\n/config waiting 3\n```",
  "```<@UBOT> /config waiting 3```",
]) {
  test(`literal quoted/code discussion stays ordinary chat: ${text}`, async () => {
    const f = await fixture();
    await f.gateway.receive(event(text));
    const queued = f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 10);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.text).toBe(text.replace("<@UBOT>", "").trim());
    expect(f.calls).toEqual([]);
    expect(f.delivered).toEqual([]);
    expect((await resolveWaiting(f.config)).delayMs).toBe(5000);
  });
}

test("direct synchronous accept cannot bypass the command boundary", async () => {
  const f = await fixture();
  expect(f.gateway.accept(event("<@UBOT> /config waiting 3"))).toBe(false);
  noCaptainWork(f);
  expect(f.delivered).toEqual([]);
});

for (const changes of [
  { user: "UBOT" },
  { hidden: true },
  { subtype: "file_share" },
  {
    blocks: [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              {
                type: "text",
                text: "/config waiting 3",
                style: { code: true },
              },
            ],
          },
        ],
      },
    ],
  },
] as const) {
  test(`event security and quoted-content routing: ${JSON.stringify(changes)}`, async () => {
    const f = await fixture();
    const request = event("<@UBOT> /config waiting 3");
    await f.gateway.receive({
      ...request,
      event: { ...request.event, ...changes },
    });

    if ("blocks" in changes) {
      const queued = f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 10);
      expect(queued).toHaveLength(1);
      expect(queued[0]?.text).toBe("/config waiting 3");
    } else noCaptainWork(f);
    expect(f.delivered).toEqual([]);
    expect((await resolveWaiting(f.config)).delayMs).toBe(5000);
  });
}

test("audit persists exact actor, clock, source and old/new settings, not raw messages", async () => {
  const f = await fixture();
  await f.gateway.receive(event("<@UBOT> /config waiting 3"));
  expect(
    f.store.meta.metaReceipt(notificationKey(f.config, identity), "C123:1.000"),
  ).toEqual({
    registration: notificationKey(f.config, identity),
    message: "C123:1.000",
    channel: "C123",
    thread: "1.000",
    user: "U123",
    at: now,
    command: "/config waiting <0..3600|off>",
    state: "applied",
    oldDelayMs: 5000,
    newDelayMs: 3000,
    reply: reply(f),
    delivered: 1,
  });
  const reopened = openStore(join(f.directory, "gateway.sqlite"));
  cleanups.push(async () => reopened.close());
  await f.waiting.run({ seconds: 8 }, f.caller);
  await f.createGateway(reopened).receive(event("<@UBOT> /config waiting 3"));
  expect((await resolveWaiting(f.config)).delayMs).toBe(8000);
  expect(f.delivered).toHaveLength(1);
  expect(
    reopened.meta.metaReceipt(notificationKey(f.config, identity), "C123:1.000")
      ?.oldDelayMs,
  ).toBe(5000);
});

test("Slack delivery failure retries the stored reply, never the applied write", async () => {
  const f = await fixture();
  const post = f.slack.post;
  f.slack.post = async () => {
    throw new Error("Slack down");
  };

  const request = event("<@UBOT> /config waiting 3");
  await expect(f.gateway.receive(request)).rejects.toThrow("Slack down");
  expect((await resolveWaiting(f.config)).delayMs).toBe(3000);
  expect(
    f.store.meta.metaReceipt(notificationKey(f.config, identity), "C123:1.000")
      ?.delivered,
  ).toBe(0);
  await f.waiting.run({ seconds: 8 }, f.caller);
  f.slack.post = post;
  await f.gateway.receive(request);
  noCaptainWork(f);
  expect((await resolveWaiting(f.config)).delayMs).toBe(8000);
  expect(reply(f)).toMatch(/5.*3/s);
  expect(reply(f)).not.toContain("8 seconds");
});

test("retained pending claim reports uncertainty after reopen, never reapplies", async () => {
  const f = await fixture();
  const registration = notificationKey(f.config, identity);
  expect(
    f.store.meta.claimMeta({
      registration,
      message: "C123:1.000",
      channel: "C123",
      thread: "1.000",
      user: "U123",
      at: now,
      command: "/config waiting <0..3600|off>",
    }),
  ).toBe(true);
  await f.waiting.run({ seconds: 8 }, f.caller);
  const reopened = openStore(join(f.directory, "gateway.sqlite"));
  cleanups.push(async () => reopened.close());
  await f.createGateway(reopened).receive(event("<@UBOT> /config waiting 3"));
  expect((await resolveWaiting(f.config)).delayMs).toBe(8000);
  expect(reply(f)).toContain("unconfirmed");
  expect(reply(f)).toContain("/config");
  expect(reopened.meta.metaReceipt(registration, "C123:1.000")?.state).toBe(
    "pending",
  );
  noCaptainWork(f);
});

test("failed waiting write remains pending and cannot later overwrite a tool change", async () => {
  const f = await fixture();

  if (f.config.backend.type !== "opencode")
    throw new Error("Expected OpenCode");
  const blocker = join(f.directory, "not-a-directory");
  await Bun.write(blocker, "fixture");
  f.config.backend.directory = blocker;
  await f.gateway.receive(event("<@UBOT> /config waiting 3"));
  expect(reply(f)).toContain("unconfirmed");
  expect(reply(f)).not.toContain(blocker);
  expect(
    f.store.meta.metaReceipt(notificationKey(f.config, identity), "C123:1.000")
      ?.state,
  ).toBe("pending");
  f.config.backend.directory = f.directory;
  await f.waiting.run({ seconds: 8 }, f.caller);
  f.delivered.length = 0;
  await f.gateway.receive(event("<@UBOT> /config waiting 3"));
  expect((await resolveWaiting(f.config)).delayMs).toBe(8000);
  expect(f.delivered).toEqual([]);
  noCaptainWork(f);
});

test("simultaneous commands serialise old/new values outside the model queue", async () => {
  const f = await fixture();
  await Promise.all([
    f.gateway.receive(event("<@UBOT> /config waiting 3")),
    f.gateway.receive(event("<@UBOT> /config waiting 8", "2.000")),
  ]);
  expect((await resolveWaiting(f.config)).delayMs).toBe(8000);
  expect(
    f.store.meta.metaReceipt(notificationKey(f.config, identity), "C123:2.000"),
  ).toMatchObject({ oldDelayMs: 3000, newDelayMs: 8000 });
  noCaptainWork(f);
});

for (const backend of [
  {
    type: "opencode",
    url: "http://localhost:4096",
    directory: "/workspace",
    headersEnv: {},
    permissions: [],
  },
  { type: "module", module: "/workspace/fake.ts", options: {} },
] as const) {
  test(`${backend.type} without workspace agent reports local waiting unavailability`, async () => {
    const f = await fixture();

    // Parse through the repository boundary, rather than weakening config types.
    const config = Schema.decodeUnknownSync(botSchema)({
      ...f.config,
      backend,
    });

    // A backend identity change needs a new gateway, not live reconfiguration.
    const local = new Gateway(
      config,
      identity,
      f.store,
      {
        async createSession() {
          throw new Error("No backend request");
        },
        async prompt() {
          throw new Error("No backend request");
        },
        async close() {},
      },
      f.slack,
      pino({ enabled: false }),
    );

    await local.receive(event("<@UBOT> /config waiting 3"));
    expect(reply(f)).toContain("unavailable");
    expect(f.store.ready(local.key, Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
  });
}

test("mute listing is bounded, current-registration-only, and does not mutate preferences", async () => {
  const preferences = new NotificationStore(":memory:");
  const readTime = now + 2000;
  cleanups.push(async () => preferences.close());
  let registration = "";

  const f = await fixture({
    listMutes: () => {
      const result = preferences.operate(
        registration,
        { op: "list" },
        { id: "list", caller: "gateway", now: readTime },
      );

      if (result.op !== "list") throw new Error("Expected list");

      return result;
    },
  });

  registration = notificationKey(f.config, identity);

  for (let index = 0; index < 51; index++) {
    preferences.operate(
      registration,
      {
        op: "mute",
        scope: "thread",
        channel: "C123",
        thread_ts: `${index + 1}.000`,
        reason: "<@UOTHER> secret reason",
        ...(index === 0
          ? { mute_until: new Date(now + 1000).toISOString() }
          : {}),
      },
      { id: `mute-${index}`, caller: "captain", now },
    );
  }

  preferences.operate(
    "other-registration",
    { op: "mute", scope: "channel", channel: "CSECRET" },
    { id: "other", caller: "other", now },
  );

  const before = preferences.operate(
    registration,
    { op: "list" },
    { id: "list", caller: "gateway", now: readTime },
  );

  await f.gateway.receive(event("<@UBOT> /config mutes"));
  noCaptainWork(f);
  const text = reply(f);
  expect(text).toContain("51 threads");
  expect(text).toContain("C123 thread");
  expect(text).toContain("active");
  expect(text).toContain("expired");
  expect(text).toContain(new Date(now + 1000).toISOString());
  expect(text).toContain("expiry none");
  expect(text).toContain("Truncated");
  expect(text.length).toBeLessThan(2800);
  expect(text).not.toContain("CSECRET");
  expect(text).not.toContain("secret reason");
  expect(
    preferences.operate(
      registration,
      { op: "list" },
      { id: "list", caller: "gateway", now: readTime },
    ),
  ).toEqual(before);
});

test("unavailable mute storage gives a fixed local error", async () => {
  const f = await fixture({
    listMutes: () => {
      throw new Error("private path");
    },
  });

  await f.gateway.receive(event("<@UBOT> /config mutes"));
  noCaptainWork(f);
  expect(reply(f)).toBe("Mute preferences unavailable for this registration.");
});

for (const text of [
  "`/api/health` returns 500, <@UBOT> can you check?",
  "/var/log is full <@UBOT> please check",
  "<@UBOT> please run /config later",
  "<@OTHER> <@UBOT> /config",
  "<@UBOT> /api/health is down",
  "<@UBOT> /tmp/foo",
  "<@UOTHER> /config waiting 3 <@UBOT>",
]) {
  test(`text outside the strict command grammar stays ordinary chat: ${text}`, async () => {
    const f = await fixture();
    expect(await f.gateway.receive(event(text))).toBe(true);
    const queued = f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 10);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.text).toBe(text.replace("<@UBOT>", "").trim());
    expect(f.delivered).toEqual([]);
  });
}

for (const text of [
  "&gt; <@UBOT> /config waiting 3",
  "<@UBOT> &gt; /config waiting 3",
]) {
  test(`Slack-escaped blockquote stays ordinary chat: ${text}`, async () => {
    const f = await fixture();
    await f.gateway.receive(event(text));
    const queued = f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 10);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.text).toBe(text.replace("<@UBOT>", "").trim());
    expect(f.calls).toEqual([]);
    expect(f.delivered).toEqual([]);
    expect((await resolveWaiting(f.config)).delayMs).toBe(5000);
  });
}

test("binding change before queued admission withholds ACK and permits fresh-binding retry", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  const f = await fixture({
    listMutes: async () => {
      entered.resolve();
      await release.promise;

      return { settings: [], cursor: null, counts: { channel: 0, thread: 0 } };
    },
  });

  let acks = 0;
  const failures: unknown[] = [];

  const deliver = (body: unknown) =>
    handleSlackRequest(
      {
        type: "events_api",
        body,
        async ack() {
          acks++;
        },
      },
      async (raw) => {
        try {
          return await f.gateway.receive(raw);
        } catch (error) {
          failures.push(error);
          throw error;
        }
      },
      pino({ enabled: false }),
    );

  const first = deliver(event("<@UBOT> /config"));
  await entered.promise;
  const waiting = deliver(event("<@UBOT> /config waiting 3", "2.000"));
  f.gateway.reconfigure({ ...f.config });
  release.resolve();
  await Promise.all([first, waiting]);
  expect(failures).toHaveLength(2);
  expect(acks).toBe(0);
  expect(
    f.store.meta.metaReceipt(notificationKey(f.config, identity), "C123:2.000"),
  ).toBeNull();
  expect((await resolveWaiting(f.config)).delayMs).toBe(5000);
  expect(f.delivered).toEqual([]);
  await deliver(event("<@UBOT> /config waiting 3", "2.000"));
  expect(acks).toBe(1);
  expect((await resolveWaiting(f.config)).delayMs).toBe(3000);
  noCaptainWork(f);
});

test("binding invalidation during waiting read releases only the proven-unwritten claim", async () => {
  let invalidate = () => {};
  let invalidated = false;

  const f = await fixture({
    now: () => {
      if (!invalidated)
        queueMicrotask(() => {
          invalidated = true;
          invalidate();
        });

      return now;
    },
  });

  invalidate = () => f.gateway.reconfigure({ ...f.config });
  const request = event("<@UBOT> /config waiting 3");
  await expect(f.gateway.receive(request)).rejects.toThrow();
  expect((await resolveWaiting(f.config)).delayMs).toBe(5000);
  expect(
    f.store.meta.metaReceipt(notificationKey(f.config, identity), "C123:1.000"),
  ).toBeNull();
  expect(f.delivered).toEqual([]);
  await f.gateway.receive(request);
  expect((await resolveWaiting(f.config)).delayMs).toBe(3000);
  expect(reply(f)).toMatch(/5.*3/s);
  noCaptainWork(f);
});

test("binding invalidation after apply retains the receipt and retries only its reply", async () => {
  const f = await fixture();
  const apply = f.store.meta.applyMeta.bind(f.store.meta);
  let changed = false;
  f.store.meta.applyMeta = (...args: Parameters<MetaRecords["applyMeta"]>) => {
    apply(...args);

    if (!changed) {
      changed = true;
      f.gateway.reconfigure({ ...f.config });
    }
  };

  const request = event("<@UBOT> /config waiting 3");
  await expect(f.gateway.receive(request)).rejects.toThrow();
  expect((await resolveWaiting(f.config)).delayMs).toBe(3000);
  expect(f.delivered).toEqual([]);
  expect(
    f.store.meta.metaReceipt(notificationKey(f.config, identity), "C123:1.000"),
  ).toMatchObject({ state: "applied", delivered: 0 });
  await f.waiting.run({ seconds: 8 }, f.caller);
  await f.gateway.receive(request);
  expect((await resolveWaiting(f.config)).delayMs).toBe(8000);
  expect(reply(f)).toMatch(/5.*3/s);
  noCaptainWork(f);
});

test("confirmed uncertainty reply is delivered once while the receipt stays pending", async () => {
  const f = await fixture();
  const registration = notificationKey(f.config, identity);
  f.store.meta.claimMeta({
    registration,
    message: "C123:1.000",
    channel: "C123",
    thread: "1.000",
    user: "U123",
    at: now,
    command: "/config waiting <0..3600|off>",
  });
  const request = event("<@UBOT> /config waiting 3");
  await f.gateway.receive(request);
  await f.gateway.receive({
    ...request,
    event_id: "EvRetry",
    event: { ...request.event, type: "message" },
  });
  expect(f.delivered).toHaveLength(1);
  expect(reply(f)).toContain("unconfirmed");
  expect(f.store.meta.metaReceipt(registration, "C123:1.000")).toMatchObject({
    state: "pending",
    delivered: 1,
  });
  expect((await resolveWaiting(f.config)).delayMs).toBe(5000);
  noCaptainWork(f);
});

test("failed uncertainty delivery retries the reply once, never the pending mutation", async () => {
  const f = await fixture();
  const registration = notificationKey(f.config, identity);
  f.store.meta.claimMeta({
    registration,
    message: "C123:1.000",
    channel: "C123",
    thread: "1.000",
    user: "U123",
    at: now,
    command: "/config waiting <0..3600|off>",
  });
  const post = f.slack.post;
  f.slack.post = async () => {
    throw new Error("Slack unavailable");
  };

  const request = event("<@UBOT> /config waiting 3");
  await expect(f.gateway.receive(request)).rejects.toThrow("Slack unavailable");
  expect(f.store.meta.metaReceipt(registration, "C123:1.000")).toMatchObject({
    state: "pending",
    delivered: 0,
  });
  await f.waiting.run({ seconds: 8 }, f.caller);
  f.slack.post = post;
  await f.gateway.receive(request);
  await f.gateway.receive(request);
  expect(f.delivered).toHaveLength(1);
  expect(reply(f)).toContain("unconfirmed");
  expect((await resolveWaiting(f.config)).delayMs).toBe(8000);
  noCaptainWork(f);
});
