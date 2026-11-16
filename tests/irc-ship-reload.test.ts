import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pino from "pino";
import { ircSchema } from "../src/config";
import { type IrcRegistration, IrcShip } from "../src/irc/ship";
import { Store } from "../src/store";
import { FakeIrcServer, lineOf, until } from "./irc-fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const env = {
  STARGATE_IRC_GALACTICA: "captain-pass",
  STARGATE_IRC_GALACTICA_CHIEF: "chief-pass",
  STARGATE_IRC_GALACTICA_TYROL: "tyrol-pass",
};
const backend = {
  type: "opencode",
  url: "http://localhost:4096",
  directory: "/workspace",
};
const crew = {
  chief: {
    id: "chief",
    account: "galactica-chief",
    passwordEnv: "STARGATE_IRC_GALACTICA_CHIEF",
    channels: ["#galactica"],
    backend: { ...backend, agent: "galactica-crew-chief" },
  },
  tyrol: {
    id: "tyrol",
    account: "galactica-tyrol",
    passwordEnv: "STARGATE_IRC_GALACTICA_TYROL",
    channels: ["#galactica"],
    backend: { ...backend, agent: "galactica-crew-tyrol" },
  },
};
type CrewName = keyof typeof crew;
const transcription = {
  provider: {
    type: "azure-openai",
    endpoint: "https://speech.example.com/",
    deployment: "whisper",
    apiVersion: "2024-06-01",
    auth: "managedIdentity",
  },
};

function shipConfig(
  port: number,
  members: CrewName[],
  access: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return ircSchema.parse({
    id: "galactica-irc",
    displayName: "Galactica",
    server: { host: "127.0.0.1", port, tls: false },
    account: "galactica",
    passwordEnv: "STARGATE_IRC_GALACTICA",
    channels: ["#galactica"],
    // One ship message per agent an hour: two agents give #galactica 2.
    access: { shipTurnsPerAgentPerHour: 1, ...access },
    crew: members.map((name) => crew[name]),
    backend: { ...backend, sessionID: "ses_captain" },
    ...extra,
  });
}

async function setup(members: CrewName[], { start = true } = {}) {
  const fake = new FakeIrcServer({
    accounts: {
      galactica: "captain-pass",
      "galactica-chief": "chief-pass",
      "galactica-tyrol": "tyrol-pass",
    },
    inviteOnly: ["#galactica"],
  }).start();
  cleanup.push(() => fake.stop());
  // The founder is never refused: grant the captain up front.
  fake.invited.add("galactica:#galactica");
  const directory = await mkdtemp(join(tmpdir(), "stargate-irc-reload-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, "stargate.sqlite"));
  cleanup.push(() => store.close());
  const ship = await IrcShip.create(
    shipConfig(fake.port, members),
    store,
    pino({ level: "silent" }),
    {
      env,
      timing: {
        reconnectMinMs: 20,
        reconnectMaxMs: 50,
        reclaimMs: 100,
        intervalMs: 5,
        burst: 10,
        confirmMs: 1000,
      },
      readyMs: 2000,
    },
  );
  cleanup.push(() => ship.close());
  if (start) {
    ship.start(() => true);
    await joined(ship);
  }
  const [captain] = ship.registrations;
  if (!captain) throw new Error("missing captain");
  return {
    fake,
    store,
    ship,
    captain,
    config: (
      roster: CrewName[],
      access: Record<string, unknown> = {},
      extra: Record<string, unknown> = {},
    ) => shipConfig(fake.port, roster, access, extra),
    /** The runtime's check: nothing queued, running or awaiting delivery. */
    idle: (key: string) => {
      const counts = store.queueCounts(key);
      return counts.queued + counts.running + counts.responding === 0;
    },
    /** True once `registration` stored the channel message `msgid`. */
    admitted: (registration: IrcRegistration, msgid: string) =>
      Boolean(store.queuedJob(registration.key, `#galactica:${msgid}`)),
    say: (account: string, text: string) =>
      fake.say({ nick: account, account }, "#galactica", text),
  };
}

function joined(ship: IrcShip) {
  return until(
    () =>
      ship.registrations.every((registration) =>
        registration.client.inChannel("#galactica"),
      ),
    5000,
    "every member in the ship channel",
  );
}

function member(ship: IrcShip, index: number) {
  const registration = ship.registrations[index];
  if (!registration) throw new Error(`missing registration ${index}`);
  return registration;
}

const quit = "QUIT :Stargate shutting down";

/** The connection loop has ended; the server reads the QUIT a moment later. */
async function quitted(fake: FakeIrcServer, registration: IrcRegistration) {
  expect(registration.client.registered).toBe(false);
  await until(
    () => fake.received(registration.account).includes(quit),
    2000,
    `${registration.account} QUIT`,
  );
}

test("irc reload: denies and text mentions apply to intake at once; earlier transports keep their rules", async () => {
  const { ship, captain, config, idle, admitted, say } = await setup(["chief"]);
  const chief = member(ship, 1);
  const early = say("jack", "all captains: report");
  const kara = say("kara", "galactica: hello");
  await until(() => admitted(captain, kara), 5000, "kara admitted");
  expect(admitted(captain, early)).toBe(false);

  const transport = captain.transport;
  const settings = captain.settings;
  const reload = await ship.prepareReload(
    config(
      ["chief"],
      { textMentions: ["all captains"], deniedAccounts: ["kara"] },
      { transcription },
    ),
    env,
  );
  expect(reload.added).toEqual([]);
  expect(reload.removed).toEqual([]);
  // Staged only: nothing changes before the commit.
  expect(captain.transport).toBe(transport);
  reload.commit(idle);

  expect(member(ship, 0)).toBe(captain);
  expect(member(ship, 1)).toBe(chief);
  expect(captain.transport).not.toBe(transport);
  expect(transport.allowed("kara", "#galactica")).toBe(true);
  expect(captain.transport.allowed("kara", "#galactica")).toBe(false);
  expect(chief.transport.allowed("kara", "#galactica")).toBe(false);
  expect(captain.transport.allowed("jack", "#galactica")).toBe(true);
  expect(settings.transcription).toBeUndefined();
  expect(captain.settings.transcription?.provider.deployment).toBe("whisper");
  expect(chief.settings.transcription?.provider.deployment).toBe("whisper");

  const denied = say("kara", "galactica: hello again");
  const named = say("jack", "all captains: report");
  await until(() => admitted(captain, named), 5000, "text mention admitted");
  expect(admitted(captain, denied)).toBe(false);
  await reload.retire();
});

test("irc reload: a new per-agent ship limit applies to the next message", async () => {
  const { ship, captain, config, idle, admitted, say } = await setup(["chief"]);
  const ship1 = say("galactica-chief", "galactica: one");
  const ship2 = say("galactica-chief", "galactica: two");
  const ship3 = say("galactica-chief", "galactica: three");
  const person = say("jack", "galactica: in order");
  await until(() => admitted(captain, person), 5000, "person admitted");
  expect([ship1, ship2, ship3].map((id) => admitted(captain, id))).toEqual([
    true,
    true,
    false,
  ]);

  (
    await ship.prepareReload(
      config(["chief"], { shipTurnsPerAgentPerHour: 2 }),
      env,
    )
  ).commit(idle);
  const ship4 = say("galactica-chief", "galactica: four");
  await until(() => admitted(captain, ship4), 5000, "raised limit");
});

test("irc reload: added crew connect at commit, join on the captain's invite and count toward the ship cap", async () => {
  const { fake, ship, captain, config, idle, admitted, say } = await setup([
    "chief",
  ]);
  const chief = member(ship, 1);
  const reload = await ship.prepareReload(config(["chief", "tyrol"]), env);
  expect(reload.removed).toEqual([]);
  const [tyrol] = reload.added;
  if (!tyrol) throw new Error("missing added crew");
  expect(tyrol.id).toBe("galactica-irc-tyrol");
  // Prepare connects nothing and changes nothing.
  await delay(100);
  expect(fake.received("galactica-tyrol")).toEqual([]);
  expect(ship.registrations).toHaveLength(2);

  reload.commit(idle);
  expect([...ship.registrations]).toEqual([captain, chief, tyrol]);
  expect(member(ship, 0)).toBe(captain);
  expect(ship.keys).toEqual([captain.key, chief.key, tyrol.key]);
  await until(() => tyrol.client.inChannel("#galactica"), 5000, "tyrol join");
  expect(
    lineOf(fake.received("galactica"), "INVITE").map((m) => m.params),
  ).toContainEqual(["galactica-tyrol", "#galactica"]);

  // One per agent × three agents. Tyrol's own ship turn counts, so the
  // third ship message to the captain exceeds the cap.
  const toTyrol = say("galactica-chief", "galactica-tyrol: check the flake");
  await until(() => admitted(tyrol, toTyrol), 5000, "tyrol admitted");
  const ship1 = say("galactica-chief", "galactica: one");
  const ship2 = say("galactica-chief", "galactica: two");
  const ship3 = say("galactica-chief", "galactica: three");
  const person = say("jack", "galactica: in order");
  await until(() => admitted(captain, person), 5000, "person admitted");
  expect([ship1, ship2, ship3].map((id) => admitted(captain, id))).toEqual([
    true,
    true,
    false,
  ]);
  await reload.retire();
});

test("irc reload: a missing added credential or a changed connection throws and changes nothing", async () => {
  const { fake, ship, captain, config, admitted, say } = await setup(["chief"]);
  const roster = [...ship.registrations];
  const transport = captain.transport;
  const { STARGATE_IRC_GALACTICA_TYROL: _, ...partial } = env;
  await expect(
    ship.prepareReload(
      config(["chief", "tyrol"], { deniedAccounts: ["jack"] }),
      partial,
    ),
  ).rejects.toThrow(
    "Missing environment variable: STARGATE_IRC_GALACTICA_TYROL",
  );
  await expect(
    ship.prepareReload(config(["chief"], {}, { concurrency: 8 }), env),
  ).rejects.toThrow("IRC connection settings of galactica-irc changed");
  await expect(
    ship.prepareReload(config(["chief"], {}, { id: "pegasus-irc" }), env),
  ).rejects.toThrow("IRC registration ID changed; restart required");

  expect([...ship.registrations]).toEqual(roster);
  expect(captain.transport).toBe(transport);
  const still = say("jack", "galactica: still there?");
  await until(() => admitted(captain, still), 5000, "jack admitted");
  expect(fake.received("galactica-tyrol")).toEqual([]);
});

test("irc reload: removing an idle crew member QUITs only that connection", async () => {
  const { fake, ship, captain, config, idle, admitted, say } = await setup([
    "chief",
    "tyrol",
  ]);
  const chief = member(ship, 1);
  const tyrol = member(ship, 2);
  const reload = await ship.prepareReload(config(["chief"]), env);
  expect(reload.added).toEqual([]);
  expect(reload.removed).toEqual([tyrol]);

  reload.commit(idle);
  reload.commit(idle);
  expect([...ship.registrations]).toEqual([captain, chief]);
  expect(ship.keys).toEqual([captain.key, chief.key]);
  await reload.retire();
  await reload.retire();
  await quitted(fake, tyrol);
  expect(fake.received("galactica")).not.toContain(quit);
  expect(fake.received("galactica-chief")).not.toContain(quit);
  expect(chief.client.inChannel("#galactica")).toBe(true);

  const toTyrol = say("jack", "galactica-tyrol: are you there?");
  const toCaptain = say("jack", "galactica: status?");
  await until(() => admitted(captain, toCaptain), 5000, "captain admitted");
  expect(admitted(tyrol, toTyrol)).toBe(false);
});

test("irc reload: removing a busy crew member is refused before any change", async () => {
  const { fake, store, ship, captain, config, idle, admitted, say } =
    await setup(["chief", "tyrol"]);
  const chief = member(ship, 1);
  const tyrol = member(ship, 2);
  const work = say("jack", "galactica-tyrol: run the checks");
  await until(() => admitted(tyrol, work), 5000, "tyrol work queued");

  const transport = captain.transport;
  const reload = await ship.prepareReload(
    config(["chief"], { deniedAccounts: ["jack"] }),
    env,
  );
  expect(() => reload.commit(idle)).toThrow(
    "IRC crew busy: galactica-irc-tyrol; reload not applied",
  );
  expect([...ship.registrations]).toEqual([captain, chief, tyrol]);
  expect(ship.keys).toEqual([captain.key, chief.key, tyrol.key]);
  expect(captain.transport).toBe(transport);
  await reload.retire();

  // The captain is unaffected: the deny did not apply and Tyrol stays.
  const ping = say("jack", "galactica: ping");
  await until(() => admitted(captain, ping), 5000, "captain admitted");
  expect(fake.received("galactica-tyrol")).not.toContain(quit);
  expect(tyrol.client.inChannel("#galactica")).toBe(true);

  // Once the work has finished, the same plan commits.
  const job = store.queuedJob(tyrol.key, `#galactica:${work}`);
  if (!job) throw new Error("missing job");
  store.running(job.id);
  store.respond(job.id, []);
  store.finish(job.id);
  reload.commit(idle);
  await reload.retire();
  await quitted(fake, tyrol);
  expect(captain.transport.allowed("jack", "#galactica")).toBe(false);
});

test("irc reload: before start nothing connects; stale plans and a closed ship are refused", async () => {
  const { fake, ship, config, idle } = await setup(["chief"], {
    start: false,
  });
  const first = await ship.prepareReload(config(["chief", "tyrol"]), env);
  const second = await ship.prepareReload(
    config(["chief"], { deniedAccounts: ["kara"] }),
    env,
  );
  first.commit(idle);
  expect(() => second.commit(idle)).toThrow(
    "IRC reload plan is stale; prepare it again",
  );
  expect(ship.registrations).toHaveLength(3);
  await delay(100);
  expect(fake.received("galactica-tyrol")).toEqual([]);

  ship.start(() => true);
  await joined(ship);
  await ship.close();
  await ship.close();
  await quitted(fake, member(ship, 2));
  const late = await ship.prepareReload(config(["chief"]), env);
  expect(() => late.commit(idle)).toThrow(
    "IRC ship closed; reload not applied",
  );
  expect(ship.registrations).toHaveLength(3);
});
