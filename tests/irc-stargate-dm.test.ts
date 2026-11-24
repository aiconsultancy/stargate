import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Result, Schema } from "effect";
import pino from "pino";
import type { AgentBackend } from "../src/backends/backend";
import { ircSchema } from "../src/config";
import type { OutboxPage } from "../src/coordination/crew/messaging/irc-rpc";
import { Gateway } from "../src/gateway/gateway";
import type { CrewLink } from "../src/transports/irc/crew-link";
import { copyText } from "../src/transports/irc/dm-copies";
import { IrcShip } from "../src/transports/irc/ship";
import { openStore } from "../src/app/open-store";
import { FakeIrcServer, lineOf, until } from "./irc-fixture";

const cleanup: (() => unknown)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const opencode = (directory: string, extra: Record<string, unknown> = {}) => ({
  type: "opencode",
  url: "http://127.0.0.1:1",
  directory,
  ...extra,
});

type Prompt = { session: string; text: string };

type Item = OutboxPage["items"][number];

/** A fake crew plugin link: records bindings and outbox reads. */
class FakeLink implements CrewLink {
  readonly binds: { sessionID: string; crewID: string }[] = [];
  readonly reads: (number | undefined)[] = [];
  readonly items: Item[] = [];
  fail = 0;
  async bind(sessionID: string, crewID: string) {
    if (this.fail > 0) {
      this.fail--;
      throw new Error("plugin unavailable");
    }

    this.binds.push({ sessionID, crewID });
  }
  async outbox(input: { after?: number; limit: number }) {
    this.reads.push(input.after);
    const latest = this.items.at(-1)?.sequence ?? 0;
    const after = input.after;

    return after === undefined
      ? { items: [], latest }
      : {
          items: this.items
            .filter((item) => item.sequence > after)
            .slice(0, input.limit),
          latest,
        };
  }
  push(item: Omit<Item, "sequence" | "created"> & { created?: number }) {
    this.items.push({
      sequence: this.items.length + 1,
      created: Date.now(),
      ...item,
    });
  }
}

const captainMember = { role: "captain" as const, id: "captain" };
const chiefMember = { role: "crew" as const, id: "chief" };
const id = (n: number) => n.toString(16).padStart(32, "0");

async function setup(
  options: {
    link?: FakeLink;
    crewMessaging?: Record<string, unknown>;
    chiefBackend?: Record<string, unknown>;
    extra?: Record<string, unknown>;
  } = {},
) {
  const fake = new FakeIrcServer({
    accounts: { "galactica-captain": "pass", "galactica-chief": "pass" },
  }).start();

  cleanup.push(() => fake.stop());
  const directory = await mkdtemp(join(tmpdir(), "stargate-irc-stargate-dm-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = openStore(join(directory, "stargate.sqlite"));
  cleanup.push(() => store.close());

  const config = Schema.decodeUnknownSync(ircSchema)({
    id: "galactica-irc",
    server: { host: "127.0.0.1", port: fake.port, tls: false },
    account: "galactica-captain",
    passwordEnv: "STARGATE_IRC_GALACTICA_CAPTAIN",
    channels: ["#ship-galactica"],
    access: { allCallStaggerMs: 0 },
    crewMessaging: options.crewMessaging ?? { sessions: true },
    crew: [
      {
        id: "chief",
        account: "galactica-chief",
        passwordEnv: "STARGATE_IRC_GALACTICA_CHIEF",
        channels: ["#ship-galactica"],
        backend: opencode("/srv/galactica/crew/chief", {
          agent: "galactica-crew-chief",
          ...options.chiefBackend,
        }),
      },
    ],
    backend: opencode("/srv/galactica/captain", { sessionID: "ses_captain" }),
    ...options.extra,
  });

  const log = pino({ level: "silent" });
  const link = options.link ?? new FakeLink();

  const ship = await IrcShip.create(config, store, log, {
    env: {
      STARGATE_IRC_GALACTICA_CAPTAIN: "pass",
      STARGATE_IRC_GALACTICA_CHIEF: "pass",
    },
    timing: { reconnectMinMs: 20, intervalMs: 5, burst: 20 },
    readyMs: 2000,
    crewLink: link,
    copyPollMs: 30,
  });

  const prompts: Record<string, Prompt[]> = { captain: [], chief: [] };

  const backends = ship.registrations.map((registration) => {
    const name = registration.role === "captain" ? "captain" : "chief";
    let sessions = 0;

    const agent: AgentBackend = {
      ...(name === "captain" ? { sessionID: "ses_captain" } : {}),
      async createSession() {
        return name === "captain" ? "ses_captain" : `ses_chief${++sessions}`;
      },
      async prompt(session, text) {
        prompts[name]?.push({
          session,
          text: `${link.binds.length}:${text}`,
        });

        return "[[stargate:silent]]";
      },
      async close() {},
    };

    return agent;
  });

  const controller = new AbortController();

  const workers = ship.registrations.map((registration, index) => {
    const selected = backends[index];

    if (!selected) {
      throw new Error("missing backend");
    }

    return new Gateway(
      registration.settings,
      registration.identity,
      store,
      selected,
      registration.delivery,
      log,
      undefined,
      undefined,
      registration.transport,
    ).work(controller.signal);
  });

  ship.start(() => true);
  cleanup.push(async () => {
    controller.abort();
    await Promise.all(workers);
    await ship.close();
  });
  await until(
    () =>
      ship.registrations.every((registration) =>
        registration.client.inChannel("#ship-galactica"),
      ),
    5000,
    "joined",
  );

  return { fake, store, ship, link, prompts };
}

const jack = { nick: "jack", account: "jack" };

test("irc crew link: a crew IRC session is bound to its member before its turn", async () => {
  const { fake, link, prompts } = await setup();
  fake.say(jack, "#ship-galactica", "galactica-chief: status?");
  await until(() => prompts["chief"]?.length === 1, 5000, "chief turn");
  // Bound before the prompt (the prompt saw one binding).
  expect(link.binds).toEqual([{ sessionID: "ses_chief1", crewID: "chief" }]);
  expect(prompts["chief"]?.[0]?.text.startsWith("1:")).toBe(true);
  // Once per session; the pinned captain is never bound.
  fake.say(jack, "#ship-galactica", "galactica-chief: and now?");
  fake.say(jack, "#ship-galactica", "galactica-captain: you?");
  await until(
    () => prompts["chief"]?.length === 2 && prompts["captain"]?.length === 1,
    5000,
    "second turns",
  );
  expect(link.binds).toHaveLength(1);
});

test("irc crew link: a failed binding never blocks the turn and is retried", async () => {
  const link = new FakeLink();
  link.fail = 1;
  const { fake, prompts } = await setup({ link });
  fake.say(jack, "#ship-galactica", "galactica-chief: status?");
  await until(() => prompts["chief"]?.length === 1, 5000, "chief turn");
  expect(link.binds).toHaveLength(0);
  fake.say(jack, "#ship-galactica", "galactica-chief: again?");
  await until(() => prompts["chief"]?.length === 2, 5000, "second turn");
  expect(link.binds).toEqual([{ sessionID: "ses_chief1", crewID: "chief" }]);
});

test("irc crew link: off by default, and only on the captain's OpenCode server", async () => {
  for (const options of [
    { crewMessaging: {} },
    { chiefBackend: { url: "http://127.0.0.1:2" } },
  ]) {
    const { fake, link, prompts } = await setup(options);
    fake.say(jack, "#ship-galactica", "galactica-chief: status?");
    await until(() => prompts["chief"]?.length === 1, 5000, "chief turn");
    await delay(50);
    expect(link.binds).toEqual([]);
  }

  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema.fields.crewMessaging)({
        sessions: true,
        x: 1,
      }),
    ),
  ).toBe(false);
});

/** PRIVMSGs one connection sent to a nick. */
function sentTo(fake: FakeIrcServer, from: string, to: string) {
  return lineOf(fake.received(from), "PRIVMSG").filter(
    (m) => m.params[0] === to,
  );
}

const copies = { sessions: true, ircCopies: true };

test("irc stargate_dm copy: sent from the sender's account, once, never a second turn", async () => {
  const link = new FakeLink();

  const { fake, store, ship, prompts } = await setup({
    link,
    crewMessaging: copies,
    extra: { audit: { channel: "#agent-dms" } },
  });

  const [captain] = ship.registrations;

  if (!captain) {
    throw new Error("missing captain");
  }

  await until(() => captain.client.inChannel("#agent-dms"), 5000, "audit");
  await until(() => link.reads.includes(0), 5000, "baseline read");
  link.push({
    id: id(1),
    from: chiefMember,
    to: captainMember,
    text: "Build is green.",
  });
  await until(
    () => sentTo(fake, "galactica-chief", "galactica-captain").length === 1,
    5000,
    "IRC copy",
  );
  const [copy] = sentTo(fake, "galactica-chief", "galactica-captain");
  expect(copy?.params[1]).toBe("[stargate_dm] Build is green.");
  expect(copy?.tags.get("+stargate/dm")).toBe(id(1));

  // The captain got the DM natively already: the copy is not a turn, and
  // The audit mirror shows it once (as the sender's outgoing DM).
  const mirrored = (text: string) =>
    lineOf(fake.received("galactica-captain"), "PRIVMSG").filter(
      (m) => m.params[0] === "#agent-dms" && m.params[1]?.includes(text),
    ).length;

  await until(() => mirrored("Build is green.") === 1, 5000, "mirror");
  await delay(200);
  expect(prompts["captain"]).toEqual([]);
  expect(store.queueCounts(captain.key).done).toBe(0);
  expect(mirrored("Build is green.")).toBe(1);
  expect(
    lineOf(fake.received("galactica-captain"), "PRIVMSG").find((m) =>
      m.params[1]?.includes("Build is green."),
    )?.params[1],
  ).toBe(
    "[dm] galactica-chief → galactica-captain: [stargate_dm] Build is green.",
  );
  // A captain → crew copy goes from the captain's account.
  link.push({ id: id(2), from: captainMember, to: chiefMember, text: "Ack." });
  await until(
    () => sentTo(fake, "galactica-captain", "galactica-chief").length === 1,
    5000,
    "captain copy",
  );
  // A DM from a ship account without a known copy ID follows the ship rules.
  const [, chief] = ship.registrations;
  await chief?.client.privmsg("galactica-captain", "direct question", {
    "+stargate/dm": id(99),
  });
  await until(() => prompts["captain"]?.length === 1, 5000, "ship DM turn");
  expect(prompts["captain"]?.[0]?.text).toContain("direct question");
});

test("irc stargate_dm copy: baseline, members without IRC, credentials and length", async () => {
  const link = new FakeLink();
  link.push({ id: id(1), from: chiefMember, to: captainMember, text: "old" });
  const { fake } = await setup({ link, crewMessaging: copies });
  await until(() => link.reads.includes(1), 5000, "baseline read");
  link.push({
    id: id(2),
    from: chiefMember,
    to: { role: "crew", id: "starbuck" },
    text: "not on IRC",
  });
  link.push({
    id: id(3),
    from: chiefMember,
    to: captainMember,
    text: "token: synthetic-test-token",
  });
  link.push({
    id: id(4),
    from: chiefMember,
    to: captainMember,
    text: `long ${"report ".repeat(400)}end`,
  });
  await until(() => link.reads.includes(4), 5000, "all read");
  await until(
    () => sentTo(fake, "galactica-chief", "galactica-captain").length >= 2,
    5000,
    "copies",
  );
  await delay(200);

  const lines = sentTo(fake, "galactica-chief", "galactica-captain").map(
    (m) => m.params[1] ?? "",
  );

  // The baseline item and the item for a member without IRC were skipped.
  expect(lines.some((line) => line.includes("old"))).toBe(false);
  expect(lines.some((line) => line.includes("not on IRC"))).toBe(false);
  expect(lines[0]).toBe(
    `[stargate_dm ${id(3)}: not copied to IRC, it may contain credentials. Read it with stargate_mail.]`,
  );
  const long = lines.slice(1).join(" ");
  expect(long.startsWith("[stargate_dm] long report")).toBe(true);
  expect(long.endsWith("(truncated; full text in stargate_mail)")).toBe(true);
  expect(Buffer.byteLength(long)).toBeLessThan(2200);

  for (const raw of fake.received("galactica-chief")) {
    expect(Buffer.byteLength(raw) + 2).toBeLessThanOrEqual(512);
  }

  expect(fake.received("galactica-chief").join("\n")).not.toContain("xoxb");
});

test("irc stargate_dm copy: never answered by a redirect, and off by default", async () => {
  const link = new FakeLink();

  const { fake } = await setup({
    link,
    crewMessaging: copies,
    extra: { dmPolicy: "redirect" },
  });

  await until(() => link.reads.includes(0), 5000, "baseline read");
  link.push({ id: id(1), from: chiefMember, to: captainMember, text: "Hi." });
  await until(
    () => sentTo(fake, "galactica-chief", "galactica-captain").length === 1,
    5000,
    "copy",
  );
  await delay(300);
  expect(
    lineOf(fake.received("galactica-captain"), "NOTICE").filter(
      (m) => m.params[0] === "galactica-chief",
    ),
  ).toHaveLength(0);
  const off = new FakeLink();
  await setup({ link: off, crewMessaging: { sessions: true } });
  await delay(200);
  expect(off.reads).toEqual([]);
});

test("irc stargate_dm copy: CTCP wrappers never hide a credential", () => {
  for (const text of [
    "\u0001ACTION identify secret\u0001",
    "status\n\u0001ACTION set password hunter2\u0001",
    "ok \u0001VERSION identify secret\u0001",
    "\u0001PING /msg NickServ identify secret",
  ]) {
    const copied = copyText({ id: id(7), text });
    expect(copied).toBe(
      `[stargate_dm ${id(7)}: not copied to IRC, it may contain credentials. Read it with stargate_mail.]`,
    );
    expect(copied).not.toContain("secret");
  }

  expect(copyText({ id: id(8), text: "\u0001ACTION waves\u0001" })).toBe(
    "[stargate_dm] ACTION waves",
  );
});

test("irc stargate_dm copy: an entry older than 24 hours is never sent", async () => {
  const link = new FakeLink();
  const { fake } = await setup({ link, crewMessaging: copies });
  await until(() => link.reads.includes(0), 5000, "baseline read");
  link.push({
    id: id(1),
    from: chiefMember,
    to: captainMember,
    text: "stale",
    created: Date.now() - 25 * 60 * 60_000,
  });
  link.push({ id: id(2), from: chiefMember, to: captainMember, text: "fresh" });
  await until(
    () => sentTo(fake, "galactica-chief", "galactica-captain").length === 1,
    5000,
    "fresh copy",
  );
  await delay(150);
  expect(
    sentTo(fake, "galactica-chief", "galactica-captain").map(
      (m) => m.params[1],
    ),
  ).toEqual(["[stargate_dm] fresh"]);
});
