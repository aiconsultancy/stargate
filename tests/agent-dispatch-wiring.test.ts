import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Effect, Result, Schema } from "effect";
import type { AgentBackend } from "../src/backend";
import {
  agentDispatchSchema,
  configSchema,
  type IrcConfig,
  ircSchema,
} from "../src/config";
import {
  IrcDispatchMessenger,
  ircDispatchAnswer,
  ircDispatchOffer,
  isDispatchRequest,
  sendDispatchAnswer,
} from "../src/dispatch/irc";
import { DispatchLedger } from "../src/dispatch/ledger";
import { dispatchTag } from "../src/dispatch/protocol";
import { startAgentDispatch } from "../src/dispatch/start";
import { fleetRequest } from "../src/fleet/client";
import { FleetControl, type FleetControlOptions } from "../src/fleet/control";
import type { DispatchOffer } from "../src/fleet/protocol";
import { fleetPermissions } from "../src/fleet-policy";
import { IrcUnavailable } from "../src/irc/client";
import { formatMessage, parseMessage } from "../src/irc/protocol";
import { IrcShip } from "../src/irc/ship";
import { serve } from "../src/runtime";
import { decodeSettings } from "../src/settings-errors";
import { checkCredentials } from "../src/setup";
import { Store } from "../src/store";
import example from "../stargate.example.json";
import {
  ACCESS,
  CAPTAIN_A,
  Clock,
  capturedLog,
  FakeApi,
  FakeSubspaceHttp,
  removeDirectories,
  silent,
  TOKEN,
  tempDirectory,
} from "./agent-dispatch-fixture";
import { FakeIrcServer, lineOf, until } from "./irc-fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  await removeDirectories();
});

const OFFER = "offer-0123456789abcdef";
const backend = {
  type: "opencode",
  url: "http://localhost:4096",
  directory: "/workspace",
};
const policy = (role: "rear_admiral" | "captain", agents: string[]) => ({
  role,
  humanAccounts: ["example-human"],
  agentAccounts: agents,
  assignedCheckout: "/workspace",
  capabilities: ["read_code"],
});
const admiralIrc = (port = 6667) => ({
  id: "fleet-admiral",
  server: { host: "127.0.0.1", port, tls: false },
  account: "rear-admiral",
  passwordEnv: "STARGATE_IRC_REAR_ADMIRAL",
  channels: ["#fleet-command"],
  features: { questions: false },
  backend: { ...backend, sessionID: "ses_admiral" },
  fleetPolicy: policy("rear_admiral", ["example-captain-a"]),
});
const dispatchRaw = {
  enabled: true,
  fleet: "example-fleet",
  api: {
    baseUrl: "https://subspace.example.test",
    tokenEnv: "DISPATCH_TOKEN",
    headersEnv: { "X-Access-Id": "DISPATCH_ACCESS" },
  },
  messaging: { registration: "fleet-admiral", channel: "#fleet-command" },
  captainAccounts: { "captain-a": "example-captain-a" },
};

/** The shipped example (Slack only) plus the fields under test. */
function decodeConfig(raw: Record<string, unknown>) {
  return decodeSettings(configSchema, { ...example, ...raw });
}

function refusal(raw: Record<string, unknown>) {
  try {
    decodeConfig(raw);
  } catch (error) {
    return String(error);
  }
  return "accepted";
}

test("configuration: absent or minimal agentDispatch is off, with the agreed defaults", () => {
  expect(
    decodeConfig({ agentDispatch: undefined }).agentDispatch,
  ).toBeUndefined();
  // The shipped example documents the section, switched off.
  expect(decodeConfig({}).agentDispatch?.enabled).toBe(false);
  const { enabled: _enabled, ...withoutEnabled } = dispatchRaw;
  // Off by default, and a disabled section needs no rear admiral registration.
  expect(decodeConfig({ agentDispatch: withoutEnabled }).agentDispatch).toEqual(
    {
      enabled: false,
      fleet: "example-fleet",
      api: {
        baseUrl: "https://subspace.example.test",
        tokenEnv: "DISPATCH_TOKEN",
        headersEnv: { "X-Access-Id": "DISPATCH_ACCESS" },
      },
      messaging: {
        type: "irc",
        registration: "fleet-admiral",
        channel: "#fleet-command",
      },
      captainAccounts: { "captain-a": "example-captain-a" },
      pollIntervalSeconds: 120,
      answerTimeoutSeconds: 300,
      retryLadderSeconds: [3600, 10_800, 21_600, 43_200],
    },
  );
});

test("configuration: enabled dispatch needs the rear admiral's own IRC registration and channel", () => {
  expect(refusal({ agentDispatch: dispatchRaw })).toContain(
    "must name an IRC registration",
  );
  const captain = {
    ...admiralIrc(),
    fleetPolicy: policy("captain", ["rear-admiral"]),
  };
  expect(refusal({ irc: [captain], agentDispatch: dispatchRaw })).toContain(
    "runs only on a rear admiral",
  );
  expect(
    refusal({
      irc: [admiralIrc()],
      agentDispatch: {
        ...dispatchRaw,
        messaging: { registration: "fleet-admiral", channel: "#elsewhere" },
      },
    }),
  ).toContain("must be one of the rear admiral registration's channels");
  expect(refusal({ irc: [admiralIrc()], agentDispatch: dispatchRaw })).toBe(
    "accepted",
  );
});

test("configuration: Stargate's own headers cannot be set from headersEnv, and ranges are bounded", () => {
  const decode = (patch: Record<string, unknown>) =>
    Result.isSuccess(
      Schema.decodeUnknownResult(agentDispatchSchema)({
        ...dispatchRaw,
        ...patch,
      }),
    );
  for (const name of [
    "Authorization",
    "authorization",
    "Host",
    "Content-Type",
    "Accept",
    "Content-Length",
    "Connection",
    "Transfer-Encoding",
  ])
    expect(
      decode({ api: { ...dispatchRaw.api, headersEnv: { [name]: "VALUE" } } }),
    ).toBe(false);
  expect(
    decode({
      api: { ...dispatchRaw.api, headersEnv: { "CF-Access-Client-Id": "ID" } },
    }),
  ).toBe(true);
  // A header value is an environment variable name, never the secret itself.
  expect(
    decode({
      api: { ...dispatchRaw.api, headersEnv: { "X-Access-Id": "not a name" } },
    }),
  ).toBe(false);
  expect(decode({ pollIntervalSeconds: 29 })).toBe(false);
  expect(decode({ answerTimeoutSeconds: 59 })).toBe(false);
  expect(decode({ retryLadderSeconds: Array(11).fill(3600) })).toBe(false);
  expect(decode({ messaging: { type: "slack", registration: "x" } })).toBe(
    false,
  );
});

test("credential check: enabled dispatch needs its token and header variables; disabled needs none", async () => {
  const directory = await tempDirectory();
  const config = decodeConfig({
    irc: [admiralIrc()],
    agentDispatch: dispatchRaw,
  });
  const dispatch = config.agentDispatch;
  if (!dispatch) throw new Error("missing dispatch");
  const check = (env: NodeJS.ProcessEnv, enabled = true) =>
    checkCredentials(
      join(directory, "stargate.json"),
      [],
      { STARGATE_IRC_REAR_ADMIRAL: "synthetic", ...env },
      config.irc,
      undefined,
      directory,
      { ...dispatch, enabled },
    );
  await expect(check({ DISPATCH_ACCESS: ACCESS })).rejects.toThrow(
    "Missing agent dispatch API environment reference",
  );
  await expect(check({ DISPATCH_TOKEN: TOKEN })).rejects.toThrow(
    "Missing agent dispatch API environment reference",
  );
  const error = await check({}).catch((caught: unknown) => String(caught));
  expect(error).not.toContain("DISPATCH_TOKEN=");
  await check({ DISPATCH_TOKEN: TOKEN, DISPATCH_ACCESS: ACCESS });
  await check({}, false);
});

test("startAgentDispatch: absent or disabled opens, listens to and contacts nothing", async () => {
  const directory = await tempDirectory();
  const http = new FakeSubspaceHttp(new FakeApi(new Clock()));
  const config = decodeConfig({
    irc: [admiralIrc()],
    agentDispatch: { ...dispatchRaw, enabled: false },
  });
  let shipLookups = 0;
  for (const dispatch of [undefined, config.agentDispatch]) {
    const started = startAgentDispatch({
      config: dispatch,
      irc: config.irc,
      ship: () => {
        shipLookups++;
        return undefined;
      },
      dataDirectory: directory,
      allowed: () => true,
      log: silent,
      fetch: http.fetch,
      env: { DISPATCH_TOKEN: TOKEN, DISPATCH_ACCESS: ACCESS },
    });
    expect(started).toBeUndefined();
  }
  expect(shipLookups).toBe(0);
  expect(http.requests).toEqual([]);
  expect(existsSync(join(directory, "agent-dispatch.sqlite"))).toBe(false);
});

function fakeBackend(pinned: string): AgentBackend {
  return {
    sessionID: pinned,
    async createSession() {
      return pinned;
    },
    async prompt() {
      return "[[stargate:silent]]";
    },
    async close() {},
  };
}

/** The rear admiral's gateway, served for real against fake IRC and API. */
async function serveAdmiral(
  agentDispatch: Record<string, unknown> | undefined,
  prepare: (api: FakeApi, fake: FakeIrcServer) => void = () => {},
) {
  const fake = new FakeIrcServer({
    accounts: { "rear-admiral": "admiral-pass" },
  }).start();
  cleanup.push(() => fake.stop());
  const dataDirectory = await tempDirectory();
  const clock = new Clock(Date.now());
  const api = new FakeApi(clock);
  const http = new FakeSubspaceHttp(api);
  prepare(api, fake);
  const irc: IrcConfig = Schema.decodeUnknownSync(ircSchema)(
    admiralIrc(fake.port),
  );
  const { log, lines } = capturedLog();
  const controller = new AbortController();
  const running = Effect.runPromise(
    serve(
      {
        dataDirectory,
        bots: [],
        irc: [irc],
        ...(agentDispatch
          ? {
              agentDispatch:
                Schema.decodeUnknownSync(agentDispatchSchema)(agentDispatch),
            }
          : {}),
      },
      log,
      controller.signal,
      {
        slack: () => {
          throw new Error("Slack is not configured");
        },
        backend: async () => fakeBackend("ses_admiral"),
        irc: (config, store, ircLog) =>
          IrcShip.create(config, store, ircLog, {
            env: { STARGATE_IRC_REAR_ADMIRAL: "admiral-pass" },
            timing: { reconnectMinMs: 20, intervalMs: 5, burst: 10 },
          }),
        agentDispatch: {
          fetch: http.fetch,
          env: { DISPATCH_TOKEN: TOKEN, DISPATCH_ACCESS: ACCESS },
        },
      },
    ),
  );
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    await running;
  };
  cleanup.push(stop);
  await until(
    () =>
      lineOf(fake.received("rear-admiral"), "JOIN").some(
        (message) => message.params[0] === "#fleet-command",
      ),
    5000,
    "join",
  );
  return { fake, api, http, dataDirectory, lines, stop };
}

for (const variant of ["absent", "enabled: false"] as const)
  test(`runtime: agentDispatch ${variant} starts no dispatcher and makes no API call`, async () => {
    const admiral = await serveAdmiral(
      variant === "absent" ? undefined : { ...dispatchRaw, enabled: false },
    );
    await delay(300);
    expect(admiral.http.requests).toEqual([]);
    expect(
      existsSync(join(admiral.dataDirectory, "agent-dispatch.sqlite")),
    ).toBe(false);
    expect(
      admiral.lines.some((line) => line.includes("Agent dispatch enabled")),
    ).toBe(false);
    await admiral.stop();
  });

test("runtime end to end: an offer in the command channel, an answer reply from the asked account, one assignment", async () => {
  const admiral = await serveAdmiral(
    { ...dispatchRaw, pollIntervalSeconds: 30, answerTimeoutSeconds: 60 },
    (api, fake) => {
      // Only the first captain maps to an enrolled chat account; it is online.
      fake.setUser("example-captain-a", "example-captain-a");
      api.add({ id: "i1", identifier: "PRJ-1", readyForAgents: true });
    },
  );
  const { fake, api, http } = admiral;
  const offers = () =>
    lineOf(fake.received("rear-admiral"), "PRIVMSG").filter((message) =>
      message.tags.get(dispatchTag)?.startsWith("offer,"),
    );
  await until(() => offers().length === 1, 10_000, "offer");
  const offerLine = offers()[0];
  expect(offerLine?.params[0]).toBe("#fleet-command");
  expect(offerLine?.params[1]).toStartWith("@example-captain-a: PRJ-1 ");
  expect(offerLine?.params[1]).toContain("fleet_answer_offer");
  const offerID = offerLine?.tags.get(dispatchTag)?.slice("offer,".length);
  expect(offerID).toMatch(/^offer-[a-f0-9]{16}$/);
  const ledger = new DispatchLedger(
    join(admiral.dataDirectory, "agent-dispatch.sqlite"),
  );
  const messageID = ledger.tracked("i1")?.offer?.messageID;
  ledger.close();
  expect(messageID).toBeDefined();
  const reply = {
    "+draft/reply": messageID ?? "",
    [dispatchTag]: `accept,${offerID}`,
  };
  // An answer from any other account is not counted.
  fake.say(
    { nick: "example-captain-b", account: "example-captain-b" },
    "#fleet-command",
    `Accepting offer ${offerID}.`,
    reply,
    "NOTICE",
  );
  await delay(200);
  expect(api.edits).toEqual([]);
  fake.say(
    { nick: "example-captain-a", account: "example-captain-a" },
    "#fleet-command",
    `Accepting offer ${offerID}.`,
    reply,
    "NOTICE",
  );
  await until(
    () => api.issues.get("i1")?.assigneeId === CAPTAIN_A,
    5000,
    "assignment",
  );
  await until(
    () =>
      lineOf(fake.received("rear-admiral"), "NOTICE").some(
        (message) => message.tags.get(dispatchTag) === `accepted,${offerID}`,
      ),
    5000,
    "accepted notice",
  );
  const accepted = lineOf(fake.received("rear-admiral"), "NOTICE").find(
    (message) => message.tags.get(dispatchTag) === `accepted,${offerID}`,
  );
  expect(accepted?.tags.get("+draft/reply")).toBe(messageID);
  expect(api.edits).toHaveLength(1);
  for (const request of http.requests)
    expect(request.headers.get("x-access-id")).toBe(ACCESS);
  expect(admiral.lines.join("\n")).not.toContain(TOKEN);
  expect(admiral.lines.join("\n")).not.toContain(ACCESS);
  await admiral.stop();
}, 30_000);

test("captain intake: a rear admiral's dispatch request passes an exhausted peer limit; other peer messages do not", async () => {
  const fake = new FakeIrcServer({
    accounts: { "example-captain-a": "captain-pass" },
  }).start();
  cleanup.push(() => fake.stop());
  const directory = await tempDirectory();
  const store = new Store(join(directory, "stargate.sqlite"));
  cleanup.push(() => store.close());
  const config = Schema.decodeUnknownSync(ircSchema)({
    id: "captain-ship",
    server: { host: "127.0.0.1", port: fake.port, tls: false },
    account: "example-captain-a",
    passwordEnv: "STARGATE_IRC_CAPTAIN",
    channels: ["#fleet-command"],
    features: { questions: false },
    access: {
      peerCaptains: ["rear-admiral", "example-captain-b"],
      peerTurnsPerHour: 0,
    },
    backend: { ...backend, sessionID: "ses_captain" },
    fleetPolicy: policy("captain", ["rear-admiral"]),
  });
  const ship = await IrcShip.create(config, store, silent, {
    env: { STARGATE_IRC_CAPTAIN: "captain-pass" },
    timing: { reconnectMinMs: 20, intervalMs: 5, burst: 10 },
  });
  const recorded: Omit<DispatchOffer, "account">[] = [];
  ship.offerRecorder = (offer) => recorded.push(offer);
  let open = true;
  ship.start(() => open);
  cleanup.push(async () => {
    open = false;
    await ship.close();
  });
  const [captain] = ship.registrations;
  if (!captain) throw new Error("missing registration");
  await until(
    () => captain.client.inChannel("#fleet-command"),
    5000,
    "captain joined",
  );
  const admiral = { nick: "rear-admiral", account: "rear-admiral" };
  const queued = () => store.queueCounts(captain.key).queued;
  // Refused by peerTurnsPerHour 0: an ordinary peer request, and a dispatch
  // marker from a peer captain that is not an enrolled fleet agent.
  fake.say(admiral, "#fleet-command", "@example-captain-a: please look");
  fake.say(
    { nick: "example-captain-b", account: "example-captain-b" },
    "#fleet-command",
    "@example-captain-a: PRJ-9 is ready for agents.",
    { [dispatchTag]: "offer,offer-ffffffffffffffff" },
  );
  const offerID = fake.say(
    admiral,
    "#fleet-command",
    "@example-captain-a: PRJ-1 is ready for agents. Can you take it?",
    { [dispatchTag]: `offer,${OFFER}` },
  );
  fake.say(
    admiral,
    "#fleet-command",
    "@example-captain-a: PRJ-2 is assigned to you.",
    { [dispatchTag]: "assigned,PRJ-2" },
  );
  await until(() => queued() === 2, 5000, "dispatch requests admitted");
  await delay(200);
  expect(queued()).toBe(2);
  expect(recorded).toEqual([
    {
      offerID: OFFER,
      messageID: offerID,
      sender: "rear-admiral",
      channel: "#fleet-command",
      receivedAt: expect.any(String),
    },
  ]);
});

async function controlFixture(
  answer: NonNullable<FleetControlOptions["answer"]>,
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "stargate-offer-")),
  );
  await chmod(directory, 0o700);
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "fleet.sock");
  const control = await FleetControl.open({
    config: {
      socketPath,
      statePath: join(directory, "evidence.sqlite"),
      targets: [
        {
          id: "rear-admiral",
          account: "rear-admiral",
          channel: "#fleet-command",
          sessionID: "ses_admiral",
        },
      ],
    },
    sessionID: "ses_captain",
    account: "example-captain-a",
    allowDispatch: false,
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
    async authorize(caller) {
      if (caller.messageID !== "msg_native")
        throw new Error("Unverified native input");
    },
    async send() {},
    answer,
    ownership: {
      lockCommand: (path) => ({
        command: "python3",
        args: [
          "-u",
          "-c",
          "import fcntl,sys; f=open(sys.argv[1]); fcntl.flock(f,fcntl.LOCK_EX); print('R',flush=True); sys.stdin.read()",
          path,
        ],
      }),
    },
  });
  cleanup.push(() => control.close());
  const request = (offerID: string, choice: "accept" | "decline") =>
    fleetRequest(
      socketPath,
      {
        operation: "answer",
        caller: {
          sessionID: "ses_captain",
          agent: "captain",
          messageID: "msg_native",
          id: "call",
        },
        input: { offerID, answer: choice, reason: "Free now" },
      },
      new AbortController().signal,
    );
  return { control, request };
}

test("answer tool: only a recorded offer for this captain is answered, once, as a reply to the offer", async () => {
  const sent: [DispatchOffer, string, string | undefined][] = [];
  const { control, request } = await controlFixture(
    async (offer, choice, reason) => {
      sent.push([offer, choice, reason]);
    },
  );
  await expect(request(OFFER, "accept")).rejects.toThrow(
    "No current offer with this ID",
  );
  control.recordOffer({
    offerID: OFFER,
    sender: "rear-admiral",
    channel: "#fleet-command",
    messageID: "m42",
    receivedAt: new Date().toISOString(),
  });
  expect(await request(OFFER, "accept")).toMatchObject({
    offerID: OFFER,
    answer: "accept",
    humanApproval: false,
  });
  // The same answer again is not resent; a different one is refused.
  expect(await request(OFFER, "accept")).toMatchObject({ repeated: true });
  await expect(request(OFFER, "decline")).rejects.toThrow(
    "already has a different answer",
  );
  expect(sent).toEqual([
    [
      {
        offerID: OFFER,
        account: "example-captain-a",
        sender: "rear-admiral",
        channel: "#fleet-command",
        messageID: "m42",
        receivedAt: expect.any(String),
      },
      "accept",
      "Free now",
    ],
  ]);
});

test("answer tool: an unconfirmed send can be answered again after checking the channel", async () => {
  let fail = true;
  const sent: string[] = [];
  const { control, request } = await controlFixture(async (_offer, choice) => {
    if (fail) throw new Error("IRC unavailable");
    sent.push(choice);
  });
  control.recordOffer({
    offerID: OFFER,
    sender: "rear-admiral",
    channel: "#fleet-command",
    messageID: "m42",
    receivedAt: new Date().toISOString(),
  });
  await expect(request(OFFER, "decline")).rejects.toThrow("unconfirmed");
  fail = false;
  await request(OFFER, "decline");
  expect(sent).toEqual(["decline"]);
});

test("the answer tool is a captain's permission only", () => {
  const allowed = (role: "rear_admiral" | "captain" | "crew") =>
    fleetPermissions({
      role,
      humanAccounts: ["example-human"],
      agentAccounts: [],
      assignedCheckout: "/workspace",
      capabilities: ["read_code"],
    }).some(
      (rule) => rule.action === "fleet_answer_offer" && rule.effect === "allow",
    );
  expect(allowed("captain")).toBe(true);
  expect(allowed("rear_admiral")).toBe(false);
  expect(allowed("crew")).toBe(false);
});

test("IRC answer: a NOTICE replying to the offer with the marker, a plain line for people", async () => {
  const lines: string[] = [];
  await sendDispatchAnswer(
    {
      async waitReady() {},
      hasCap: (cap) => cap === "message-tags",
      budget: () => 400,
      async send(command, params, tags) {
        lines.push(formatMessage(command, params, tags));
      },
    },
    { offerID: OFFER, channel: "#fleet-command", messageID: "m42" },
    "accept",
    "Free\u0007 now",
    () => true,
    new AbortController().signal,
  );
  const message = parseMessage(lines[0] ?? "");
  expect(message?.command).toBe("NOTICE");
  expect(message?.params).toEqual([
    "#fleet-command",
    `Accepting offer ${OFFER}: Free now`,
  ]);
  expect(message?.tags.get("+draft/reply")).toBe("m42");
  expect(message?.tags.get(dispatchTag)).toBe(`accept,${OFFER}`);
  await expect(
    sendDispatchAnswer(
      {
        async waitReady() {},
        hasCap: () => false,
        budget: () => 400,
        async send() {},
      },
      { offerID: OFFER, channel: "#fleet-command", messageID: "m42" },
      "decline",
      undefined,
      () => true,
      new AbortController().signal,
    ),
  ).rejects.toThrow("message tags unavailable");
});

test("IRC answer intake: only an authenticated reply with an answer marker in the dispatch channel counts", () => {
  const line = (
    tags: Record<string, string>,
    command = "NOTICE",
    target = "#fleet-command",
  ) =>
    parseMessage(
      `${formatMessage(command, [target, "Accepting."], {
        time: "2026-11-21T09:01:00.000Z",
        ...tags,
      })}`.replace(/^(@\S+ )/, "$1:example-captain-a!u@h "),
    );
  const good = {
    account: "example-captain-a",
    "+draft/reply": "m42",
    [dispatchTag]: `accept,${OFFER}`,
  };
  const parse = (message: ReturnType<typeof line>) =>
    message ? ircDispatchAnswer(message, "#Fleet-Command", 0) : undefined;
  expect(parse(line(good))).toEqual({
    account: "example-captain-a",
    offerID: OFFER,
    answer: "accept",
    replyTo: "m42",
    at: Date.parse("2026-11-21T09:01:00.000Z"),
  });
  const { account: _account, ...anonymous } = good;
  expect(parse(line(anonymous))).toBeUndefined();
  expect(parse(line({ ...good, account: "*" }))).toBeUndefined();
  const { "+draft/reply": _reply, ...unthreaded } = good;
  expect(parse(line(unthreaded))).toBeUndefined();
  expect(
    parse(line({ ...good, [dispatchTag]: `offer,${OFFER}` })),
  ).toBeUndefined();
  expect(
    parse(line({ ...good, [dispatchTag]: "accept,offer-1" })),
  ).toBeUndefined();
  expect(parse(line(good, "NOTICE", "#elsewhere"))).toBeUndefined();
  // Offers and notices are the only requests that wake a captain.
  const offer = line(
    { msgid: "m7", [dispatchTag]: `offer,${OFFER}` },
    "PRIVMSG",
  );
  if (!offer) throw new Error("unparsed");
  expect(isDispatchRequest(offer)).toBe(true);
  expect(ircDispatchOffer(offer)).toEqual({ offerID: OFFER, messageID: "m7" });
  const status = line({ [dispatchTag]: `timeout,${OFFER}` }, "NOTICE");
  if (!status) throw new Error("unparsed");
  expect(isDispatchRequest(status)).toBe(false);
});

test("IRC messenger: an offline captain is skipped; a missing capability or our own outage holds the offer", async () => {
  const { log, lines } = capturedLog();
  let caps = new Set(["message-tags", "echo-message"]);
  let lookup: () => Promise<string> = async () => "example-captain";
  const published: string[] = [];
  const messenger = new IrcDispatchMessenger(
    {
      async waitReady() {},
      verifiedNick: () => lookup(),
      hasCap: (cap) => caps.has(cap),
      budget: () => 400,
      async publish(_target, text) {
        published.push(text);
        return "m1";
      },
      async privmsg() {},
      async send() {},
      inChannel: () => true,
      registered: true,
    },
    "#fleet-command",
    () => true,
    log,
  );
  const captain = {
    userId: CAPTAIN_A,
    name: "captain-a",
    account: "example-captain",
  };
  const offer = {
    id: OFFER,
    issue: { identifier: "PRJ-1", title: "Title" },
    timeoutSeconds: 300,
  };
  const abort = new AbortController().signal;
  expect(await messenger.offer(captain, offer, abort)).toEqual({
    messageID: "m1",
  });
  expect(published[0]).toStartWith("@example-captain: PRJ-1 “Title”");
  lookup = async () => {
    throw new Error("IRC recipient is not online under that account");
  };
  expect(await messenger.offer(captain, offer, abort)).toBeUndefined();
  lookup = async () => {
    throw new IrcUnavailable();
  };
  await expect(messenger.offer(captain, offer, abort)).rejects.toThrow();
  caps = new Set(["message-tags"]);
  await expect(messenger.offer(captain, offer, abort)).rejects.toThrow(
    "echo-message",
  );
  await expect(messenger.offer(captain, offer, abort)).rejects.toThrow();
  expect(lines.filter((line) => line.includes("offers are held"))).toHaveLength(
    1,
  );
  expect(published).toHaveLength(1);
});
