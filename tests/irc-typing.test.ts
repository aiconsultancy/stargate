import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import pino from "pino";
import type { AgentBackend } from "../src/backend";
import { ircSchema } from "../src/config";
import { Gateway } from "../src/gateway";
import { IrcClient } from "../src/irc/client";
import { type IrcMessage, parseMessage } from "../src/irc/protocol";
import { IrcShip } from "../src/irc/ship";
import { BackendFailure } from "../src/request-failure";
import { Store } from "../src/store";
import type { TurnProgress } from "../src/turn-progress";
import { FakeIrcServer, lineOf, until } from "./irc-fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(
  options: {
    caps?: string[];
    features?: Record<string, boolean>;
    role?: "captain" | "rear_admiral" | "crew";
    turnStatusMs?: number;
    turnTimeoutMs?: number;
    deferWorker?: boolean;
    reconnectMinMs?: number;
  } = {},
) {
  const fake = new FakeIrcServer({
    accounts: { galactica: "captain-pass", observer: "observer-pass" },
    botAccounts: ["galactica"],
    ...(options.caps ? { caps: options.caps } : {}),
  }).start();
  cleanup.push(() => fake.stop());
  const directory = await mkdtemp(join(tmpdir(), "stargate-irc-typing-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, "stargate.sqlite"));
  cleanup.push(() => store.close());
  const config = Schema.decodeUnknownSync(ircSchema)({
    id: "galactica-irc",
    server: { host: "127.0.0.1", port: fake.port, tls: false },
    account: "galactica",
    passwordEnv: "STARGATE_IRC_GALACTICA",
    channels: ["#galactica"],
    ...(options.features ? { features: options.features } : {}),
    ...(options.turnTimeoutMs === undefined
      ? {}
      : { turnTimeoutMs: options.turnTimeoutMs }),
    ...(options.role
      ? {
          access: { allowedAccounts: ["jack", "visitor"] },
          fleetPolicy: {
            role: options.role,
            humanAccounts: ["jack"],
            agentAccounts: ["visitor"],
            assignedCheckout: "/workspace",
            capabilities: ["read_code"],
          },
        }
      : {}),
    backend: {
      type: "opencode",
      url: "http://localhost:4096",
      directory: "/workspace",
      sessionID: "ses_captain",
    },
  });
  const ship = await IrcShip.create(config, store, pino({ level: "silent" }), {
    env: { STARGATE_IRC_GALACTICA: "captain-pass" },
    timing: {
      reconnectMinMs: options.reconnectMinMs ?? 20,
      intervalMs: 5,
      burst: 50,
      typingMs: 100,
      confirmMs: 250,
      ...(options.turnStatusMs ? { turnStatusMs: options.turnStatusMs } : {}),
    },
    readyMs: 2000,
  });
  let release = Promise.withResolvers<void>();
  let report: ((progress: TurnProgress) => void) | undefined;
  let prompts = 0;
  const backend: AgentBackend = {
    sessionID: "ses_captain",
    async createSession() {
      return "ses_captain";
    },
    async prompt(
      _session,
      _text,
      _signal,
      _onText,
      _onInput,
      _files,
      _context,
      onProgress,
    ) {
      prompts++;
      report = onProgress;
      await release.promise;
      release = Promise.withResolvers<void>();
      return "Done.";
    },
    async close() {},
  };
  const [captain] = ship.registrations;
  if (!captain) throw new Error("missing captain");
  const controller = new AbortController();
  const gateway = new Gateway(
    captain.settings,
    captain.identity,
    store,
    backend,
    captain.delivery,
    captain.log,
    undefined,
    undefined,
    captain.transport,
  );
  let worker: Promise<void> | undefined;
  const startWorker = () => {
    worker ??= gateway.work(controller.signal);
  };
  if (!options.deferWorker) startWorker();
  ship.start(() => true);
  cleanup.push(async () => {
    release.resolve();
    controller.abort();
    await worker;
    await ship.close();
  });
  await until(() => captain.client.inChannel("#galactica"), 5000, "joined");
  return {
    fake,
    store,
    captain,
    startWorker,
    prompts: () => prompts,
    finish: () => release.resolve(),
    fail: (error: Error) => release.reject(error),
    progress: (progress: TurnProgress) => report?.(progress),
  };
}

const typing = (lines: readonly string[], target: string) =>
  lineOf(lines, "TAGMSG")
    .filter((m) => m.params[0] === target)
    .map((m) => m.tags.get("+typing"));

function progressNotices(fake: FakeIrcServer) {
  return lineOf(fake.received("galactica"), "NOTICE").filter((notice) =>
    notice.tags.has("+stargate/progress"),
  );
}

async function observe(fake: FakeIrcServer) {
  const received: IrcMessage[] = [];
  const observer = new IrcClient(
    {
      host: "127.0.0.1",
      port: fake.port,
      tls: false,
      account: "observer",
      nick: "observer",
      password: "observer-pass",
      channels: ["#galactica"],
      log: pino({ level: "silent" }),
    },
    { message: (message) => received.push(message) },
  );
  const controller = new AbortController();
  const running = observer.run(controller.signal);
  cleanup.push(async () => {
    controller.abort();
    await running;
  });
  await until(() => observer.inChannel("#galactica"), 5000, "observer joined");
  return received;
}

test("IRC fleet typing accompanies the thread notice and clears before the reply", async () => {
  const { fake, store, captain, finish } = await setup({
    role: "rear_admiral",
    features: { liveProgress: false },
  });
  fake.say({ nick: "jack", account: "jack" }, "#galactica", "@galactica check");
  const states = () => typing(fake.received("galactica"), "#galactica");
  await until(
    () =>
      states().includes("active") &&
      lineOf(fake.received("galactica"), "NOTICE").length === 1,
    3000,
    "typing and acknowledgement",
  );
  finish();
  await until(() => store.queueCounts(captain.key).done === 1, 3000, "reply");
  expect(states().at(-1)).toBe("done");
});

test("irc typing: active while a turn runs, refreshed, then done before the reply", async () => {
  const { fake, store, captain, finish } = await setup();
  fake.say({ nick: "jack", account: "jack" }, "#galactica", "galactica: think");
  await until(
    () => typing(fake.received("galactica"), "#galactica").length >= 3,
    3000,
    "refresh",
  );
  finish();
  await until(() => store.queueCounts(captain.key).done === 1, 5000, "done");
  const sent = fake
    .received("galactica")
    .map((line) => line.replace(/^@\S+ /, ""))
    .filter(
      (line) =>
        line.startsWith("TAGMSG #galactica") ||
        line.startsWith("PRIVMSG #galactica"),
    );
  const states = typing(fake.received("galactica"), "#galactica");
  expect(states.slice(0, -1).every((state) => state === "active")).toBe(true);
  expect(states.at(-1)).toBe("done");
  // done is sent before the reply text.
  expect(sent.at(-1)).toBe("PRIVMSG #galactica Done.");
  expect(sent.at(-2)).toBe("TAGMSG #galactica");
});

test("irc typing: direct messages type to the requester's verified nick", async () => {
  const { fake, store, captain, finish } = await setup();
  fake.say({ nick: "jackie", account: "jack" }, "galactica", "think");
  await until(
    () => typing(fake.received("galactica"), "jackie").length >= 1,
    3000,
    "typing",
  );
  finish();
  await until(() => store.queueCounts(captain.key).done === 1, 5000, "done");
  expect(typing(fake.received("galactica"), "jackie").at(-1)).toBe("done");
});

test("irc typing: stops when the direct nick changes hands", async () => {
  const { fake, store, captain, finish } = await setup();
  fake.say({ nick: "jackie", account: "jack" }, "galactica", "think");
  await until(
    () => typing(fake.received("galactica"), "jackie").length >= 2,
    3000,
    "typing",
  );
  // jackie quits; another account takes the nick.
  fake.sendTo("galactica", ":jackie!u@outside QUIT :bye");
  fake.sendTo("galactica", ":carol!u@h JOIN #galactica carol :Carol");
  fake.sendTo("galactica", ":carol!u@h NICK jackie");
  await until(
    () => captain.client.boundNick("carol") === "jackie",
    2000,
    "nick taken",
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const before = typing(fake.received("galactica"), "jackie").length;
  await new Promise((resolve) => setTimeout(resolve, 500));
  finish();
  await until(() => store.queueCounts(captain.key).running === 0, 5000, "end");
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Neither active nor done follows the nick to carol.
  expect(typing(fake.received("galactica"), "jackie")).toHaveLength(before);
});

test("irc typing: off without message-tags or with features.typing false", async () => {
  for (const options of [
    {
      caps: [
        "sasl=PLAIN",
        "account-tag",
        "server-time",
        "batch",
        "labeled-response",
      ],
    },
    { features: { typing: false } },
  ]) {
    const { fake, store, captain, finish } = await setup(options);
    fake.say(
      { nick: "jack", account: "jack" },
      "#galactica",
      "galactica: think",
    );
    await until(
      () => store.queueCounts(captain.key).running === 1,
      3000,
      "running",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    finish();
    await until(() => store.queueCounts(captain.key).done === 1, 5000, "done");
    expect(lineOf(fake.received("galactica"), "TAGMSG")).toHaveLength(0);
  }
});

for (const role of ["captain", "rear_admiral"] as const) {
  test(`irc fleet ${role}: reports confirmed progress without repeating it`, async () => {
    const { fake, store, captain, finish, progress } = await setup({
      role,
      features: { liveProgress: false, fleetTyping: false },
      turnStatusMs: 30,
    });
    expect(captain.settings.turnTimeoutMs).toBe(3_600_000);
    fake.say(
      { nick: "jack", account: "jack" },
      "#galactica",
      "@galactica check",
    );
    const notices = () => lineOf(fake.received("galactica"), "NOTICE");
    await until(() => notices().length === 2, 3000, "request status");
    const [ack, unconfirmed] = notices();
    expect(ack?.params).toEqual(["#galactica", "Checking that now…"]);
    expect(unconfirmed?.params).toEqual([
      "#galactica",
      "Stargate has no confirmed backend activity for this request.",
    ]);
    progress({ stage: "reasoning", observedAt: Date.UTC(2026, 10, 20, 2, 23) });
    await until(() => notices().length === 3, 3000, "reasoning status");
    const latest = notices().at(-1);
    expect(latest?.params).toEqual([
      "#galactica",
      "OpenCode reported model reasoning. Observed at 02:23 UTC.",
    ]);
    expect(ack?.tags.get("+draft/reply")).toBeTruthy();
    expect(latest?.tags.get("+draft/reply")).toBe(
      ack?.tags.get("+draft/reply"),
    );
    expect(typing(fake.received("galactica"), "#galactica")).toEqual([]);
    await Bun.sleep(90);
    expect(notices()).toHaveLength(3);
    finish();
    await until(() => notices().length === 4, 3000, "terminal notice");
    expect(store.queueCounts(captain.key).done).toBe(1);
    expect(notices().at(-1)?.tags.get("+stargate/progress")).toBe("completed");
  });
}

test("irc fleet: a settled turn cancels its delayed progress notice", async () => {
  const { fake, store, captain, finish } = await setup({
    role: "captain",
    features: { liveProgress: false },
    turnStatusMs: 500,
  });
  fake.say({ nick: "jack", account: "jack" }, "#galactica", "@galactica check");
  const notices = () => lineOf(fake.received("galactica"), "NOTICE");
  await until(() => notices().length === 1, 3000, "ack");
  finish();
  await until(() => notices().length === 2, 3000, "terminal notice");
  expect(store.queueCounts(captain.key).done).toBe(1);
  await Bun.sleep(550);
  expect(notices().map((m) => m.tags.get("+stargate/progress"))).toEqual([
    "received",
    "completed",
  ]);
});

test("irc fleet: timeout reports the last confirmed stage", async () => {
  const { fake, store, captain, finish, progress } = await setup({
    role: "captain",
    features: { liveProgress: false },
    turnStatusMs: 2000,
    turnTimeoutMs: 1000,
  });
  fake.say({ nick: "jack", account: "jack" }, "#galactica", "@galactica check");
  await until(
    () => store.queueCounts(captain.key).running === 1,
    3000,
    "running",
  );
  progress({ stage: "queued", observedAt: Date.UTC(2026, 10, 20, 2, 20) });
  await Bun.sleep(1050);
  finish();
  await until(() => store.queueCounts(captain.key).done === 1, 3000, "done");
  const replies = lineOf(fake.received("galactica"), "PRIVMSG");
  expect(replies.map((line) => line.params[1]).join(" ")).toContain(
    "OpenCode queued the request. Delivery to the model is unconfirmed. Observed at 02:20 UTC.",
  );
  await until(() => progressNotices(fake).length === 2, 3000, "failed notice");
  expect(
    progressNotices(fake).map((m) => m.tags.get("+stargate/progress")),
  ).toEqual(["received", "failed"]);
});

test("irc fleet: a configuration with crew rank keeps its typing behaviour", async () => {
  const { fake, store, captain, finish } = await setup({ role: "crew" });
  fake.say({ nick: "jack", account: "jack" }, "#galactica", "@galactica check");
  await until(
    () => typing(fake.received("galactica"), "#galactica").includes("active"),
    3000,
    "original typing",
  );
  expect(lineOf(fake.received("galactica"), "NOTICE")).toEqual([]);
  finish();
  await until(() => store.queueCounts(captain.key).done === 1, 3000, "done");
});

test("live IRC status reads the request observation while its model turn is still open", async () => {
  const { fake, store, captain, progress, finish } = await setup({
    role: "captain",
    turnStatusMs: 40,
  });
  const user = { nick: "jack", account: "jack" };
  const root = fake.say(user, "#galactica", "@galactica check");
  await until(
    () => store.queueCounts(captain.key).running === 1,
    3000,
    "open request",
  );
  const update = { stage: "reasoning" as const, observedAt: Date.now() };
  await until(
    () => {
      progress(update);
      return store.requestProgress(captain.key).length === 1;
    },
    3000,
    "observation",
  );
  await until(
    () =>
      lineOf(fake.received("galactica"), "NOTICE").some((x) =>
        x.params[1]?.includes("reported model reasoning"),
      ),
    3000,
    "first confirmed notice",
  );
  const job = store.jobByEvent(captain.key, `#galactica:${root}`);
  if (!job) throw new Error("Missing request");
  expect(
    store.requestProgress(captain.key, job.id, update.observedAt + 60_001)[0],
  ).toMatchObject({ request: job.id, stale: true, disconnected: false });
  expect(store.requestProgress(captain.key, job.id + 1)).toEqual([]);
  expect(store.requestProgress("other", job.id)).toEqual([]);
  fake.say(
    { nick: "visitor", account: "visitor" },
    "#galactica",
    "galactica: status",
    { "+draft/reply": root },
  );
  fake.say(user, "#galactica", "galactica: status", { "+draft/reply": root });
  await until(
    () =>
      lineOf(fake.received("galactica"), "PRIVMSG").some((m) =>
        m.params[1]?.includes("reported model reasoning"),
      ),
    3000,
    "read-only status",
  );
  expect(store.queueCounts(captain.key).queued).toBe(0);
  expect(typing(fake.received("galactica"), "#galactica")).toContain("active");
  expect(
    lineOf(fake.received("galactica"), "NOTICE").some((m) =>
      m.params[1]?.includes("Checking that now"),
    ),
  ).toBe(false);
  finish();
  await until(() => store.queueCounts(captain.key).done === 1, 3000, "reply");
  expect(typing(fake.received("galactica"), "#galactica").at(-1)).toBe("done");
});

test("IRC progress relays authenticated notices for two requests in the same thread", async () => {
  const { fake, finish, progress, prompts } = await setup({
    role: "captain",
    features: { liveProgress: true, fleetTyping: false, reactions: false },
    turnStatusMs: 30,
  });
  const wire = await observe(fake);
  const user = { nick: "jack", account: "jack" };
  const root = fake.say(user, "#galactica", "Fuel report", { msgid: "root-1" });
  const ask = (id: string, question: string) =>
    fake.say(user, "#galactica", `@galactica ${question}`, {
      msgid: id,
      "+draft/reply": root,
    });
  const first = ask("req-1", "Check the main tank");
  const firstReceived = () =>
    progressNotices(fake).some(
      (m) =>
        m.tags.get("+draft/reply") === first &&
        m.tags.get("+stargate/progress") === "received",
    );
  await until(() => prompts() === 1 && firstReceived(), 3000, "first turn");
  const second = ask("req-2", "Check the spare tank");
  fake.say(user, "#galactica", "Ordinary notice.", {}, "NOTICE");
  const observedAt = Date.UTC(2026, 10, 20, 2, 23);
  progress({ stage: "reasoning", observedAt, disconnected: true });
  await until(
    () =>
      progressNotices(fake).some(
        (m) => m.tags.get("+stargate/progress") === "reasoning,disconnected",
      ),
    3000,
    "observed disconnection",
  );
  progress({ stage: "completed", observedAt });
  await Bun.sleep(90);
  expect(
    progressNotices(fake).some(
      (m) => m.tags.get("+stargate/progress") === "completed",
    ),
  ).toBe(false);
  finish();

  await until(
    () =>
      prompts() === 2 &&
      progressNotices(fake).some(
        (m) =>
          m.tags.get("+draft/reply") === second &&
          m.tags.get("+stargate/progress") === "received",
      ),
    3000,
    "second turn",
  );
  finish();
  await until(
    () =>
      wire.filter((m) => m.tags.get("+stargate/progress") === "completed")
        .length === 2,
    3000,
    "two terminal notices",
  );

  // Timestamps and server-generated output msgids vary with the loopback run.
  const describe = (message: IrcMessage) => [
    message.command,
    message.source,
    message.tags.get("account"),
    message.tags.has("bot"),
    message.tags.get("+draft/reply"),
    message.tags.get("+stargate/progress"),
    ...message.params,
  ];
  const fixture = await Bun.file(
    new URL("./fixtures/irc-progress.irc", import.meta.url),
  ).text();
  const expected = fixture
    .trim()
    .split("\n")
    .map((line) => {
      const message = parseMessage(line);
      if (!message) throw new Error("Invalid IRC transcript line");
      return describe(message);
    });
  expect(wire.map(describe)).toEqual(expected);
});

test("IRC progress waits for a lost reply receipt to be retried without rerunning the model", async () => {
  const { fake, finish, prompts, store, captain } = await setup({
    role: "captain",
    features: { liveProgress: false },
  });
  const user = { nick: "jack", account: "jack" };
  const request = fake.say(user, "#galactica", "@galactica check");
  await until(() => prompts() === 1, 3000, "active prompt");
  fake.holdMessageConfirmation.add("galactica #galactica");
  finish();
  await until(
    () =>
      store.jobByEvent(captain.key, `#galactica:${request}`)?.attempts === 1,
    3000,
    "unconfirmed reply",
  );
  expect(
    progressNotices(fake).map((m) => m.tags.get("+stargate/progress")),
  ).toEqual(["received"]);
  fake.drop("galactica");
  fake.holdMessageConfirmation.clear();
  await until(
    () =>
      progressNotices(fake).some(
        (m) => m.tags.get("+stargate/progress") === "completed",
      ),
    5000,
    "retried reply and terminal notice",
  );
  expect(prompts()).toBe(1);
  expect(progressNotices(fake).at(-1)?.tags.get("+draft/reply")).toBe(request);
});

test("IRC progress reports a confirmed model failure even if its error reply is unconfirmed", async () => {
  const { fake, fail, prompts, store, captain } = await setup({
    role: "captain",
    features: { liveProgress: false },
  });
  const user = { nick: "jack", account: "jack" };
  const request = fake.say(user, "#galactica", "@galactica check");
  await until(() => prompts() === 1, 3000, "active prompt");
  fake.holdMessageConfirmation.add("galactica #galactica");
  fail(new BackendFailure("auth", { status: 401, ran: false }));
  await until(
    () =>
      store.jobByEvent(captain.key, `#galactica:${request}`)?.attempts === 1,
    3000,
    "unconfirmed error reply",
  );
  await until(() => progressNotices(fake).length === 2, 3000, "failed notice");
  expect(
    progressNotices(fake).map((m) => m.tags.get("+stargate/progress")),
  ).toEqual(["received", "failed"]);
  expect(progressNotices(fake).at(-1)?.tags.get("+draft/reply")).toBe(request);
});

test("IRC progress reports a known failure stored while the IRC connection was offline", async () => {
  const { fake, fail, prompts, store, captain } = await setup({
    role: "captain",
    features: { liveProgress: false },
    reconnectMinMs: 500,
  });
  const request = fake.say(
    { nick: "jack", account: "jack" },
    "#galactica",
    "@galactica check",
  );
  const job = () => store.jobByEvent(captain.key, `#galactica:${request}`);
  await until(
    () => prompts() === 1 && progressNotices(fake).length === 1,
    3000,
    "active prompt and acknowledgement",
  );
  const connection = fake.clients.find(
    ({ account }) => account === "galactica",
  );
  if (!connection) throw new Error("Missing ship connection");
  connection.socket.end();
  await until(() => !captain.client.registered, 3000, "disconnected");
  fail(new BackendFailure("auth", { status: 401, ran: false }));
  await until(
    () => job()?.status === "responding" && !captain.client.registered,
    3000,
    "model failure stored before reconnect",
  );
  await until(
    () => job()?.status === "done",
    3000,
    "error reply after reconnect",
  );
  await until(
    () =>
      progressNotices(fake).at(-1)?.tags.get("+stargate/progress") === "failed",
    2000,
    "terminal notice after reconnect",
  );
  expect(job()?.attempts).toBe(0);
  expect(prompts()).toBe(1);
  expect(progressNotices(fake).at(-1)?.tags.get("+draft/reply")).toBe(request);
});

test("IRC progress confirms recovered stored replies and leaves interrupted native outcomes open", async () => {
  const { fake, store, captain, startWorker, prompts } = await setup({
    role: "captain",
    deferWorker: true,
  });
  const user = { nick: "jack", account: "jack" };
  const succeeded = fake.say(user, "#galactica", "@galactica check main tank");
  const unknown = fake.say(user, "#galactica", "@galactica check spare tank");
  await until(
    () => store.queueCounts(captain.key).queued === 2,
    3000,
    "persisted requests",
  );
  for (const request of [succeeded, unknown]) {
    const job = store.jobByEvent(captain.key, `#galactica:${request}`);
    if (!job) throw new Error("Missing request");
    expect(store.running(job.id, job.text)).toBe(true);
    if (request === succeeded) store.respond(job.id, ["Stored reply."]);
  }
  startWorker();
  await until(
    () => store.queueCounts(captain.key).done === 2,
    3000,
    "recovery",
  );
  expect(prompts()).toBe(0);
  expect(store.jobByEvent(captain.key, `#galactica:${unknown}`)?.failure).toBe(
    "interrupted",
  );
  expect(
    progressNotices(fake).map((m) => [
      m.tags.get("+draft/reply"),
      m.tags.get("+stargate/progress"),
    ]),
  ).toEqual([[succeeded, "completed"]]);
});

for (const missing of ["message tags", "the request msgid"] as const) {
  test(`IRC progress keeps legacy notices without ${missing}`, async () => {
    const { fake, finish, prompts, store, captain } = await setup({
      role: "captain",
      features: { liveProgress: false },
      ...(missing === "message tags"
        ? {
            caps: [
              "sasl=PLAIN",
              "account-tag",
              "labeled-response",
              "echo-message",
            ],
          }
        : {}),
    });
    fake.say(
      { nick: "jack", account: "jack" },
      "#galactica",
      "@galactica check",
      missing === "the request msgid" ? { msgid: "" } : {},
    );
    await until(() => prompts() === 1, 3000, "active prompt");
    finish();
    await until(() => store.queueCounts(captain.key).done === 1, 3000, "reply");
    expect(progressNotices(fake)).toEqual([]);
    const notices = lineOf(fake.received("galactica"), "NOTICE");
    expect(notices.map((m) => m.params[1])).toEqual(["Checking that now…"]);
    expect(notices[0]?.tags.has("+draft/reply")).toBe(false);
  });
}
