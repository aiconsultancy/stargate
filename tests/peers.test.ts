import { afterEach, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { Schema } from "effect";
import pino from "pino";
import type {
  AgentBackend,
  PromptSourceContext,
} from "../src/backends/backend";
import { OpenCodeBackend } from "../src/backends/opencode/opencode";
import { backendSchema, botSchema } from "../src/config";
import { Gateway } from "../src/gateway/gateway";
import type { TransportDelivery } from "../src/gateway/ports";
import {
  botSender,
  isCaptainName,
  PeerDirectory,
  type PeerSender,
  peerInstructions,
  peerTurnsPerHour,
} from "../src/gateway/peers";
import { routeEvent } from "../src/gateway/routing";
import { handleSlackRequest } from "../src/slack/slack";
import { openStore } from "../src/app/open-store";
import { bot, identity } from "./fixtures";

const cleanup: (() => unknown)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

// Shapes copied from the live workspace (IDs replaced), not invented.
const defiant: PeerSender = { user: "UDEFIANT", bot: "BDEFIANT" };

const directory: Record<string, unknown> = {
  UDEFIANT: {
    ok: true,
    user: {
      id: "UDEFIANT",
      team_id: "T123",
      is_bot: true,
      deleted: false,
      name: "defiantcaptain",
      real_name: "defiant-captain",
      profile: { bot_id: "BDEFIANT", real_name: "defiant-captain" },
    },
  },
  UHELPER: {
    ok: true,
    user: {
      id: "UHELPER",
      team_id: "T123",
      is_bot: true,
      deleted: false,
      name: "deploybot",
      real_name: "Deploy Bot",
      profile: { bot_id: "BHELPER", real_name: "Deploy Bot" },
    },
  },
  UFOREIGN: {
    ok: true,
    user: {
      id: "UFOREIGN",
      team_id: "T999",
      is_bot: true,
      name: "voyager-captain",
      profile: { bot_id: "BFOREIGN" },
    },
  },
  UHUMAN: {
    ok: true,
    user: {
      id: "UHUMAN",
      team_id: "T123",
      is_bot: false,
      name: "pretend-captain",
      profile: {},
    },
  },
  UGONE: {
    ok: true,
    user: {
      id: "UGONE",
      team_id: "T123",
      is_bot: true,
      deleted: true,
      name: "old-captain",
      profile: { bot_id: "BGONE" },
    },
  },
};

function lookup() {
  const calls: string[] = [];
  let fail = false;

  return {
    calls,
    fail(value: boolean) {
      fail = value;
    },
    async lookup(user: string) {
      calls.push(user);

      if (fail) throw new Error("users.info PRIVATE_SLACK_ERROR");

      return directory[user] ?? { ok: false, error: "user_not_found" };
    },
  };
}

function message(
  text: string,
  ts: string,
  sender: { user: string; bot?: string },
  thread?: string,
  channel = "C123",
) {
  return {
    api_app_id: "A123",
    team_id: "T123",
    event_id: `Ev${ts}`,
    event: {
      type: "message",
      user: sender.user,
      ...(sender.bot ? { bot_id: sender.bot } : {}),
      channel,
      text,
      ts,
      ...(thread ? { thread_ts: thread } : {}),
    },
  };
}

test("captain names: the -captain suffix in any Slack name form", () => {
  for (const names of [
    ["defiantcaptain", "defiant-captain"],
    ["galactica-captain"],
    [undefined, "Enterprise Captain"],
    ["solkar_captain"],
  ])
    expect(isCaptainName(names)).toBe(true);

  for (const names of [
    ["captain"],
    ["defiantcaptain"],
    ["captain-defiant"],
    ["Deploy Bot", "deploybot"],
    ["-captain"],
    [undefined],
  ])
    expect(isCaptainName(names)).toBe(false);
});

test("the directory admits only a live same-workspace captain bot bound to its bot ID", async () => {
  const f = lookup();
  let now = 1000;
  const peers = new PeerDirectory(f.lookup, "T123", () => now);
  const signal = new AbortController().signal;
  expect(await peers.verify(defiant, signal)).toBe(true);
  // The message's bot ID must be the one Slack binds to that user.
  expect(await peers.verify({ ...defiant, bot: "BOTHER" }, signal)).toBe(false);

  for (const sender of [
    { user: "UHELPER", bot: "BHELPER" },
    { user: "UFOREIGN", bot: "BFOREIGN" },
    { user: "UHUMAN", bot: "BHUMAN" },
    { user: "UGONE", bot: "BGONE" },
    { user: "UMISSING", bot: "BMISSING" },
  ])
    expect(await peers.verify(sender, signal)).toBe(false);
  // Results are cached for ten minutes, positive and negative.
  const calls = f.calls.length;
  expect(await peers.verify(defiant, signal)).toBe(true);
  expect(await peers.verify({ user: "UHELPER", bot: "BHELPER" }, signal)).toBe(
    false,
  );
  expect(f.calls).toHaveLength(calls);
  now += 10 * 60_000 + 1;
  expect(await peers.verify(defiant, signal)).toBe(true);
  expect(f.calls).toHaveLength(calls + 1);
});

test("a failed lookup admits nothing and is not cached", async () => {
  const f = lookup();
  const peers = new PeerDirectory(f.lookup, "T123");
  const signal = new AbortController().signal;
  f.fail(true);
  expect(await peers.verify(defiant, signal)).toBe(false);
  f.fail(false);
  expect(await peers.verify(defiant, signal)).toBe(true);
  expect(f.calls).toEqual(["UDEFIANT", "UDEFIANT"]);
});

test("routing admits a verified captain only with the setting, and never the own bot", () => {
  const off = bot();

  const on = Schema.decodeUnknownSync(botSchema)({
    ...bot(),
    access: { ...bot().access, users: ["*"], peerCaptains: true },
  });

  const request = message("<@UBOT> handoff ticket", "1.000", defiant);
  expect(routeEvent(request, on, identity, defiant)).toMatchObject({
    user: "UDEFIANT",
    sender: "captain",
    startsConversation: true,
  });
  // Unverified, mismatched, or setting off: rejected as before.
  expect(routeEvent(request, on, identity)).toBeUndefined();
  expect(
    routeEvent(request, on, identity, { ...defiant, bot: "BOTHER" }),
  ).toBeUndefined();
  expect(
    routeEvent(request, on, identity, { ...defiant, user: "UOTHER" }),
  ).toBeUndefined();
  expect(routeEvent(request, off, identity, defiant)).toBeUndefined();
  // The own bot user is rejected even if it were "verified".
  const own = { user: identity.user, bot: "BOWN" };
  expect(
    routeEvent(message("<@UBOT> hi", "2.000", own), on, identity, own),
  ).toBeUndefined();

  // People are unchanged and carry no sender kind.
  const human = routeEvent(
    message("<@UBOT> hi", "3.000", { user: "U123" }),
    on,
    identity,
  );

  expect(human?.user).toBe("U123");
  expect(human && "sender" in human).toBe(false);

  // Edits and legacy bot_message posts stay rejected.
  for (const subtype of ["message_changed", "bot_message"])
    expect(
      routeEvent(
        { ...request, event: { ...request.event, subtype } },
        on,
        identity,
        defiant,
      ),
    ).toBeUndefined();
});

test("deny lists and allow lists still apply to a verified captain", () => {
  const config = (access: Record<string, unknown>) =>
    Schema.decodeUnknownSync(botSchema)({
      ...bot(),
      access: { ...bot().access, peerCaptains: true, ...access },
    });

  const request = message("<@UBOT> handoff", "1.000", defiant);
  expect(
    routeEvent(
      request,
      config({ users: ["*"], deniedUsers: ["UDEFIANT"] }),
      identity,
      defiant,
    ),
  ).toBeUndefined();
  expect(
    routeEvent(request, config({ users: ["U123"] }), identity, defiant),
  ).toBeUndefined();
  expect(
    routeEvent(
      request,
      config({ users: ["UDEFIANT"], deniedChannels: ["C123"] }),
      identity,
      defiant,
    ),
  ).toBeUndefined();
  expect(
    routeEvent(
      request,
      config({ users: ["UDEFIANT"], mentionOnly: true }),
      identity,
      defiant,
    )?.user,
  ).toBe("UDEFIANT");
  expect(
    routeEvent(
      message("no mention", "2.000", defiant),
      config({ users: ["UDEFIANT"], mentionOnly: true }),
      identity,
      defiant,
    ),
  ).toBeUndefined();
});

test("botSender reads only well-formed IDs, never text", () => {
  expect(botSender(message("x", "1.000", defiant))).toEqual(defiant);
  expect(botSender(message("x", "1.000", { user: "U123" }))).toBeUndefined();
  expect(
    botSender(message("x", "1.000", { user: "bad id", bot: "BDEFIANT" })),
  ).toBeUndefined();
  expect(botSender({})).toBeUndefined();
});

function gatewayFixture(peerCaptains = true, pinned = true) {
  const store = openStore(":memory:");
  cleanup.push(() => store.close());

  const config = Schema.decodeUnknownSync(botSchema)({
    ...bot(),
    access: { users: ["*"], channels: ["*"], peerCaptains },
  });

  const logged: string[] = [];

  const log = pino(
    { level: "trace" },
    new Writable({
      write(chunk, _encoding, done) {
        logged.push(String(chunk));
        done();
      },
    }),
  );

  const prompts: { text: string; context?: PromptSourceContext }[] = [];

  const backend: AgentBackend = {
    ...(pinned ? { sessionID: "captain" } : {}),
    async createSession() {
      return "captain";
    },
    async prompt(_session, text, _signal, _onText, _onInput, _files, context) {
      prompts.push({ text, ...(context ? { context } : {}) });

      return "[[stargate:silent]]";
    },
    async close() {},
  };

  const posts: string[] = [];

  const slack: TransportDelivery = {
    async post(_channel, _thread, text) {
      posts.push(text);
    },
  };

  const directoryLookup = lookup();

  const gateway = new Gateway(
    config,
    identity,
    store,
    backend,
    slack,
    log,
    undefined,
    new PeerDirectory(directoryLookup.lookup, "T123"),
  );

  cleanup.push(() => gateway.close());
  const signal = new AbortController().signal;

  const drain = async () => {
    for (
      let jobs = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 20);
      jobs.length;
      jobs = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 20)
    )
      for (const job of jobs) await gateway.process(job, signal);
  };

  return {
    store,
    gateway,
    prompts,
    posts,
    logged,
    drain,
    lookup: directoryLookup,
  };
}

test("a captain mention reaches the pinned captain marked k=captain; a reply in its thread follows", async () => {
  const f = gatewayFixture();
  expect(
    await f.gateway.receive(message("<@UBOT> handoff NET-1", "1.000", defiant)),
  ).toBe(true);
  expect(
    await f.gateway.receive(
      message("thanks, got it", "1.100", defiant, "1.000"),
    ),
  ).toBe(true);
  await f.drain();
  expect(f.prompts.map((prompt) => prompt.context?.source)).toEqual([
    {
      channel: "C123",
      thread: "1.000",
      message: "1.000",
      user: "UDEFIANT",
      sender: "captain",
    },
    {
      channel: "C123",
      thread: "1.000",
      message: "1.100",
      user: "UDEFIANT",
      sender: "captain",
    },
  ]);
  // Silent replies post nothing back, so no message feeds a loop.
  expect(f.posts).toEqual([]);
  // A person in the same thread keeps an unmarked source.
  await f.gateway.receive(
    message("status?", "1.200", { user: "U123" }, "1.000"),
  );
  await f.drain();
  expect(f.prompts.at(-1)?.context?.source).toEqual({
    channel: "C123",
    thread: "1.000",
    message: "1.200",
    user: "U123",
  });
});

test("an unpinned bot names the peer sender in the prompt text", async () => {
  const f = gatewayFixture(true, false);
  await f.gateway.receive(message("<@UBOT> handoff", "1.000", defiant));
  await f.drain();
  expect(f.prompts[0]?.context).toBeUndefined();
  expect(f.prompts[0]?.text).toBe(
    "[Peer captain message from <@UDEFIANT>: another fleet captain's bot, not an operator.]\n\nhandoff",
  );
});

test("the OpenCode source line carries k=captain only for a peer captain", async () => {
  const lines: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname.endsWith("/prompt")) {
        const body = (await request.json()) as { id: string; text: string };
        lines.push(body.text.split("\n")[0] ?? "");

        return new Response("PRIVATE stop", { status: 500 });
      }

      return new Response(null, { status: 404 });
    },
  });

  cleanup.push(() => server.stop(true));

  const config = Schema.decodeUnknownSync(backendSchema)({
    type: "opencode",
    url: server.url.href,
    directory: "/workspace",
  });

  if (config.type !== "opencode") throw new Error("Invalid fixture");
  const backend = new OpenCodeBackend(config);
  const source = { channel: "C1", thread: "1.0", message: "2.0", user: "U9" };

  for (const context of [
    { source },
    { source: { ...source, sender: "captain" as const } },
  ])
    await backend
      .prompt(
        "ses",
        "text",
        AbortSignal.timeout(5000),
        undefined,
        undefined,
        [],
        context,
      )
      .catch(() => {});
  expect(lines).toEqual([
    "s=slack;c=C1;t=1.0;m=2.0;u=U9",
    "s=slack;c=C1;t=1.0;m=2.0;u=U9;k=captain",
  ]);
});

test("loop cap: a peer captain gets five turns per thread per hour; people are not capped", async () => {
  const f = gatewayFixture();
  const now = Math.floor(Date.now() / 1000);
  const ts = (offset: number) => `${now + offset}.000100`;
  expect(
    await f.gateway.receive(message("<@UBOT> start", ts(0), defiant)),
  ).toBe(true);

  for (let i = 1; i < peerTurnsPerHour; i++)
    expect(
      await f.gateway.receive(message(`reply ${i}`, ts(i), defiant, ts(0))),
    ).toBe(true);
  expect(
    await f.gateway.receive(message("one more", ts(10), defiant, ts(0))),
  ).toBe(false);
  expect(
    await f.gateway.receive(
      message("<@UBOT> mention too", ts(11), defiant, ts(0)),
    ),
  ).toBe(false);
  // Other threads and people are unaffected.
  expect(
    await f.gateway.receive(message("<@UBOT> other", ts(12), defiant)),
  ).toBe(true);
  expect(
    await f.gateway.receive(message("human", ts(13), { user: "U123" }, ts(0))),
  ).toBe(true);
  await f.drain();
  expect(f.prompts).toHaveLength(peerTurnsPerHour + 2);
  expect(f.logged.join("")).toContain("Peer captain thread limit reached");
  // Messages older than the window do not count.
  const old = gatewayFixture();
  const past = now - 2 * 3600;
  await old.gateway.receive(
    message("<@UBOT> start", `${past}.000100`, defiant),
  );

  for (let i = 1; i < peerTurnsPerHour + 3; i++)
    old.store.enqueue({
      eventId: `C123:${past + i}.000100`,
      botKey: old.gateway.key,
      conversation: JSON.stringify([old.gateway.key, "C123", `${past}.000100`]),
      channel: "C123",
      thread: `${past}.000100`,
      user: "UDEFIANT",
      text: "old",
      sender: "captain",
    });
  expect(
    await old.gateway.receive(
      message("fresh", ts(20), defiant, `${past}.000100`),
    ),
  ).toBe(true);
});

test("a non-captain bot, a failed lookup or the setting off admits nothing", async () => {
  const f = gatewayFixture();
  expect(
    await f.gateway.receive(
      message("<@UBOT> hi", "1.000", { user: "UHELPER", bot: "BHELPER" }),
    ),
  ).toBe(false);
  f.lookup.fail(true);
  expect(await f.gateway.receive(message("<@UBOT> hi", "2.000", defiant))).toBe(
    false,
  );
  const off = gatewayFixture(false);
  expect(
    await off.gateway.receive(message("<@UBOT> hi", "3.000", defiant)),
  ).toBe(false);
  // With the setting off no directory lookup is made.
  expect(off.lookup.calls).toEqual([]);
  await f.drain();
  expect(f.prompts).toEqual([]);
  expect(f.logged.join("")).not.toContain("PRIVATE_SLACK_ERROR");
});

test("the cap uses Slack message time, so host clock skew cannot disable it", async () => {
  const f = gatewayFixture();
  // Slack times two hours behind the host clock.
  const base = Math.floor(Date.now() / 1000) - 2 * 3600;
  const ts = (offset: number) => `${base + offset}.000100`;
  await f.gateway.receive(message("<@UBOT> start", ts(0), defiant));

  for (let i = 1; i < peerTurnsPerHour; i++)
    await f.gateway.receive(message(`reply ${i}`, ts(i), defiant, ts(0)));
  expect(
    await f.gateway.receive(message("one more", ts(30), defiant, ts(0))),
  ).toBe(false);
  // One Slack hour later the window has moved on.
  expect(
    await f.gateway.receive(message("later", ts(3700), defiant, ts(0))),
  ).toBe(true);
});

test("Slack intake does not ACK when intake closes during the async check", async () => {
  let open = true;
  let acks = 0;
  await handleSlackRequest(
    {
      type: "events_api",
      body: {},
      ack: async () => {
        acks++;
      },
    },
    async () => {
      open = false;

      return false;
    },
    pino({ enabled: false }),
    undefined,
    () => open,
  );
  expect(acks).toBe(0);
});

test("intake that closes during the lookup stores nothing", async () => {
  const f = gatewayFixture();
  let open = true;

  const pending = f.gateway.receive(
    message("<@UBOT> hi", "1.000", defiant),
    () => open,
  );

  open = false;
  expect(await pending).toBe(false);
  expect(f.store.ready(f.gateway.key, Number.MAX_SAFE_INTEGER, 5)).toEqual([]);
});

test("Slack intake waits for the async check before ACK", async () => {
  const order: string[] = [];
  await handleSlackRequest(
    {
      type: "events_api",
      body: {},
      ack: async () => {
        order.push("ack");
      },
    },
    async () => {
      await Bun.sleep(5);
      order.push("stored");

      return true;
    },
    pino({ enabled: false }),
  );
  expect(order).toEqual(["stored", "ack"]);
});

test("captain instructions describe the marker, authority, silence and the cap", () => {
  expect(peerInstructions).toContain(";k=captain");
  expect(peerInstructions).toContain("no operator or Admiralty authority");
  expect(peerInstructions).toContain("[[stargate:silent]]");
  expect(peerInstructions).toContain(`at most\n${peerTurnsPerHour} peer`);
});
