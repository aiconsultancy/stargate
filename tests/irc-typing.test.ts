import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import pino from "pino";
import type { AgentBackend } from "../src/backend";
import { ircSchema } from "../src/config";
import { Gateway } from "../src/gateway";
import { IrcShip } from "../src/irc/ship";
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
  } = {},
) {
  const fake = new FakeIrcServer({
    accounts: { galactica: "captain-pass" },
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
      reconnectMinMs: 20,
      intervalMs: 5,
      burst: 50,
      typingMs: 100,
      ...(options.turnStatusMs ? { turnStatusMs: options.turnStatusMs } : {}),
    },
    readyMs: 2000,
  });
  let release = Promise.withResolvers<void>();
  let report: ((progress: TurnProgress) => void) | undefined;
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
  const worker = new Gateway(
    captain.settings,
    captain.identity,
    store,
    backend,
    captain.delivery,
    captain.log,
    undefined,
    undefined,
    captain.transport,
  ).work(controller.signal);
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
    finish: () => release.resolve(),
    progress: (progress: TurnProgress) => report?.(progress),
  };
}

const typing = (lines: readonly string[], target: string) =>
  lineOf(lines, "TAGMSG")
    .filter((m) => m.params[0] === target)
    .map((m) => m.tags.get("+typing"));

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
    await until(() => store.queueCounts(captain.key).done === 1, 3000, "done");
    expect(notices()).toHaveLength(3);
  });
}

test("irc fleet: a settled turn cancels its delayed progress notice", async () => {
  const { fake, store, captain, finish } = await setup({
    role: "captain",
    turnStatusMs: 500,
  });
  fake.say({ nick: "jack", account: "jack" }, "#galactica", "@galactica check");
  const notices = () => lineOf(fake.received("galactica"), "NOTICE");
  await until(() => notices().length === 1, 3000, "ack");
  finish();
  await until(() => store.queueCounts(captain.key).done === 1, 3000, "done");
  await Bun.sleep(550);
  expect(notices()).toHaveLength(1);
});

test("irc fleet: timeout reports the last confirmed stage", async () => {
  const { fake, store, captain, finish, progress } = await setup({
    role: "captain",
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
  expect(lineOf(fake.received("galactica"), "NOTICE")).toHaveLength(1);
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
    features: { liveProgress: true },
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
  expect(
    lineOf(fake.received("galactica"), "NOTICE").some((m) =>
      m.params[1]?.includes("Checking that now"),
    ),
  ).toBe(false);
  finish();
});
