import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import {
  type CrewCaller,
  CrewEngine,
  type CrewOptions,
  type CrewSessions,
} from "../src/crew/execution/engine";
import { IrcSessions } from "../src/crew/messaging/irc";
import type { MesijClient, MesijMessage } from "../src/crew/messaging/mesij";
import { teamSchema } from "../src/crew/team";
import { outboxFixture, outboxNow } from "./fixtures/irc-outbox";
import { fixtureRoot } from "./fixture-root";

const pin = "ses_captainpin";

async function fixture(options: { pinned?: boolean } = {}) {
  const directory = await mkdtemp(join(fixtureRoot(), "stargate-crew-irc-"));

  const team = Schema.decodeUnknownSync(teamSchema)({
    captain: { id: "captain" },
    crew: [
      { id: "worker", role: "Builder", permissionProfile: "coding" },
      { id: "builder", role: "Second builder", permissionProfile: "coding" },
    ],
  });

  const crewOptions: CrewOptions = {
    namespace: "crew-irc",
    stateDirectory: join(directory, "state"),
    projectDirectory: directory,
    captainDirectory: join(directory, "captain"),
    worktrees: {
      worker: join(directory, "worker"),
      builder: join(directory, "builder"),
    },
    team,
    mesijCommand: "/unused",
    ...(options.pinned === false ? {} : { captainSessionID: pin }),
  };

  const worktree = (id: string) => crewOptions.worktrees[id] ?? "";

  /** IRC sessions Stargate created: agent, directory and an optional parent. */
  const irc = new Map<
    string,
    { agent: string; directory: string; parentID?: string }
  >([
    ["ses_ircworker", { agent: "worker", directory: worktree("worker") }],
    ["ses_ircbuilder", { agent: "builder", directory: worktree("builder") }],
    [
      "ses_ircchild",
      { agent: "worker", directory: worktree("worker"), parentID: "ses_x" },
    ],
    [
      "ses_ircelsewhere",
      { agent: "worker", directory: crewOptions.captainDirectory },
    ],
  ]);

  const wakes: { sessionID: string; text: string }[] = [];
  let engine: CrewEngine;

  const sessions: CrewSessions = {
    async get({ sessionID }) {
      const bound = irc.get(sessionID);

      if (bound)
        return {
          id: sessionID,
          agent: bound.agent,
          location: { directory: bound.directory },
          ...(bound.parentID ? { parentID: bound.parentID } : {}),
        };

      if (sessionID.startsWith("ses_captain"))
        return {
          id: sessionID,
          agent: "captain",
          location: { directory: crewOptions.captainDirectory },
        };
      const peer = engine.state.peerBySession(sessionID);

      if (!peer) throw new Error("not found");

      return {
        id: sessionID,
        agent: peer.crewID,
        location: { directory: worktree(peer.crewID) },
        metadata: {
          stargateCrew: {
            namespace: crewOptions.namespace,
            crewID: peer.crewID,
          },
        },
        time: { updated: 1, idle: 2 },
      };
    },
    async create() {
      throw new Error("Unexpected native creation");
    },
    async prompt() {
      throw new Error("Unexpected native admission");
    },
    async synthetic(input) {
      wakes.push({ sessionID: input.sessionID, text: input.text });
    },
    async compact() {
      throw new Error("Unexpected native compaction");
    },
    async wait() {},
    async interrupt() {
      throw new Error("Unexpected native interruption");
    },
  };

  const events: MesijMessage[] = [];

  const mailer: Pick<MesijClient, "register" | "send" | "inbox"> = {
    async register() {
      return { id: "0".repeat(32), sequence: 0 };
    },
    async send(input) {
      const event: MesijMessage = {
        id: (events.length + 1).toString(16).padStart(32, "0"),
        sequence: events.length + 1,
        actor: input.actor,
        sessionID: input.sessionID,
        to: input.to,
        text: input.text,
        type: input.replyTo ? "message.replied" : "message.posted",
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      };

      events.push(event);

      return { id: event.id, sequence: event.sequence };
    },
    async inbox(input) {
      return events
        .filter(
          (event) =>
            event.sequence > (input.after ?? 0) &&
            (event.to === input.sessionID ||
              event.sessionID === input.sessionID),
        )
        .slice(0, input.limit ?? 100);
    },
  };

  engine = await CrewEngine.open(crewOptions, sessions, mailer);

  const peers = Object.fromEntries(
    ["worker", "builder"].map((id) => {
      const peer = engine.state.reservePeer(id);
      engine.state.readyPeer(id);

      return [id, peer.sessionID];
    }),
  );

  let call = 0;

  const caller = (sessionID: string, agent: string): CrewCaller => ({
    sessionID,
    agent,
    id: `host-call-${++call}`,
    signal: new AbortController().signal,
  });

  return {
    engine,
    events,
    wakes,
    peers,
    caller,
    signal: new AbortController().signal,
    async close() {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("crew irc: only a matching root crew session can be bound, once", async () => {
  const f = await fixture();

  try {
    const bind = (sessionID: string, crewID: string) =>
      f.engine.bindIrcSession({ sessionID, crewID }, f.signal);

    await expect(bind("ses_ircworker", "nobody")).rejects.toThrow(
      "Unknown configured crew member",
    );
    await expect(bind(pin, "captain")).rejects.toThrow("captain");
    await expect(bind("ses_ircchild", "worker")).rejects.toThrow(
      "root session",
    );
    await expect(bind("ses_ircelsewhere", "worker")).rejects.toThrow(
      "root session",
    );
    // A builder session cannot be bound as the worker.
    await expect(bind("ses_ircbuilder", "worker")).rejects.toThrow(
      "root session",
    );
    // The member's task session is not an IRC session.
    await expect(bind(f.peers["worker"] ?? "", "worker")).rejects.toThrow(
      "task session",
    );
    expect(await bind("ses_ircworker", "worker")).toEqual({ bound: true });
    expect(await bind("ses_ircworker", "worker")).toEqual({ bound: true });
    await expect(bind("ses_ircworker", "builder")).rejects.toThrow(
      "root session",
    );
  } finally {
    await f.close();
  }

  const unpinned = await fixture({ pinned: false });

  try {
    await expect(
      unpinned.engine.bindIrcSession(
        { sessionID: "ses_ircworker", crewID: "worker" },
        unpinned.signal,
      ),
    ).rejects.toThrow("pinned captain");
  } finally {
    await unpinned.close();
  }
});

test("crew irc: a bound session sends stargate_dm only as its member", async () => {
  const f = await fixture();

  try {
    const worker = () => f.caller("ses_ircworker", "worker");
    // Unbound: refused as before.
    await expect(
      f.engine.dm({ op: "send", to: "captain", text: "hi" }, worker()),
    ).rejects.toThrow("Only the configured captain or assigned worker");
    await f.engine.bindIrcSession(
      { sessionID: "ses_ircworker", crewID: "worker" },
      f.signal,
    );
    // The host's agent must be the bound member; no model-supplied identity.
    await expect(
      f.engine.dm(
        { op: "send", to: "captain", text: "hi" },
        f.caller("ses_ircworker", "builder"),
      ),
    ).rejects.toThrow("another crew member");

    const sent = await f.engine.dm(
      { op: "send", to: "captain", text: "Build is green." },
      worker(),
    );

    expect(sent).toMatchObject({ status: "sent", to: "captain", stored: true });
    expect(sent).toMatchObject({ notification: "accepted" });
    // The captain is woken with the member's name; the task session is not.
    expect(f.wakes).toEqual([expect.objectContaining({ sessionID: pin })]);
    expect(f.wakes[0]?.text).toContain("from worker");
    const [event] = f.events;
    expect(event?.sessionID).toBe("ses_ircworker");
    expect(event?.to).toBe(pin);
    const envelope = JSON.parse(event?.text ?? "{}");
    expect(envelope.originCaptainID).toBe(pin);
    expect(envelope.sourceTaskID).toBeUndefined();

    // The captain's inbox names the member, not the captain.
    const inbox = await f.engine.mail(
      { op: "inbox" },
      f.caller(pin, "captain"),
    );

    expect(inbox).toMatchObject({
      messages: [{ from: "worker", text: "Build is green." }],
    });
    // No task context, no self-send, and no other crew tools.
    await expect(
      f.engine.dm(
        { op: "send", to: "captain", text: "x", taskID: "task_1" },
        worker(),
      ),
    ).rejects.toThrow("no task context");
    await expect(
      f.engine.dm({ op: "send", to: "worker", text: "x" }, worker()),
    ).rejects.toThrow("self-send");
    await expect(f.engine.authorize(worker())).rejects.toThrow(
      "Only the configured captain or assigned worker",
    );
  } finally {
    await f.close();
  }
});

test("crew irc: replies go to the IRC session's inbox and never wake it", async () => {
  const f = await fixture();

  try {
    await f.engine.bindIrcSession(
      { sessionID: "ses_ircworker", crewID: "worker" },
      f.signal,
    );

    const asked = await f.engine.dm(
      { op: "send", to: "captain", text: "Deploy now?" },
      f.caller("ses_ircworker", "worker"),
    );

    const id = "id" in asked ? asked.id : undefined;

    const reply = await f.engine.dm(
      { op: "send", to: "worker", text: "Not yet.", replyTo: id },
      f.caller(pin, "captain"),
    );

    expect(reply).toMatchObject({ stored: true, notification: "inbox" });
    // Neither the IRC session nor the worker's task session was prompted.
    expect(f.wakes.map((wake) => wake.sessionID)).toEqual([pin]);
    expect(f.events.at(-1)?.to).toBe("ses_ircworker");

    const inbox = await f.engine.mail(
      { op: "inbox" },
      f.caller("ses_ircworker", "worker"),
    );

    expect(inbox).toMatchObject({
      messages: [{ from: "captain", text: "Not yet.", replyTo: id }],
    });

    // The worker's task session never sees the IRC session's mail.
    const task = await f.engine.mail(
      { op: "inbox" },
      f.caller(f.peers["worker"] ?? "", "worker"),
    );

    expect(task).toMatchObject({ messages: [] });
  } finally {
    await f.close();
  }
});

test("crew irc: a DM to another crew member uses the existing wake rules", async () => {
  const f = await fixture();

  try {
    await f.engine.bindIrcSession(
      { sessionID: "ses_ircworker", crewID: "worker" },
      f.signal,
    );

    const sent = await f.engine.dm(
      { op: "send", to: "builder", text: "Your branch is ready." },
      f.caller("ses_ircworker", "worker"),
    );

    expect(sent).toMatchObject({ stored: true, to: "builder" });
    expect(f.events.at(-1)?.to).toBe(f.peers["builder"]);

    const task = await f.engine.mail(
      { op: "inbox" },
      f.caller(f.peers["builder"] ?? "", "builder"),
    );

    expect(task).toMatchObject({
      messages: [{ from: "worker", text: "Your branch is ready." }],
    });
  } finally {
    await f.close();
  }
});

test("crew irc outbox: every stored stargate_dm is listed once, in order; mail is not", async () => {
  const f = await fixture();

  try {
    // A first read is a baseline: nothing older is replayed.
    expect(f.engine.ircOutbox({ limit: 10 })).toEqual({
      items: [],
      latest: 0,
    });
    await f.engine.bindIrcSession(
      { sessionID: "ses_ircworker", crewID: "worker" },
      f.signal,
    );
    await f.engine.dm(
      { op: "send", to: "captain", text: "Build is green." },
      f.caller("ses_ircworker", "worker"),
    );
    await f.engine.mail(
      { op: "send", to: "worker", text: "Mail only, no copy." },
      f.caller(pin, "captain"),
    );
    await f.engine.dm(
      { op: "send", to: "builder", text: "Rebase please." },
      f.caller(pin, "captain"),
    );
    const page = f.engine.ircOutbox({ after: 0, limit: 10 });
    const [first, , third] = f.events;

    if (!first || !third) throw new Error("missing receipts");
    expect(page.items).toEqual([
      {
        sequence: 1,
        id: first.id,
        from: { role: "crew", id: "worker" },
        to: { role: "captain", id: "captain" },
        text: "Build is green.",
        created: expect.any(Number),
      },
      {
        sequence: 2,
        id: third.id,
        from: { role: "captain", id: "captain" },
        to: { role: "crew", id: "builder" },
        text: "Rebase please.",
        created: expect.any(Number),
      },
    ]);
    expect(page.latest).toBe(2);
    expect(f.engine.ircOutbox({ after: 1, limit: 10 }).items).toHaveLength(1);
    expect(f.engine.ircOutbox({ after: 2, limit: 10 }).items).toEqual([]);
    expect(f.engine.ircOutbox({ limit: 10 }).latest).toBe(2);
  } finally {
    await f.close();
  }
});

test("crew irc outbox: bounded by count and age", async () => {
  const directory = await mkdtemp(join(fixtureRoot(), "stargate-outbox-"));
  await copyFile(outboxFixture, join(directory, "outbox.sqlite"));

  const db = new Database(join(directory, "outbox.sqlite"), {
    create: true,
    strict: true,
  });

  try {
    const outbox = new IrcSessions(db);

    const item = (n: number) => ({
      id: n.toString(16).padStart(32, "0"),
      from: { role: "captain" as const, id: "captain" },
      to: { role: "crew" as const, id: "worker" },
      text: `message ${n}`,
    });

    // Saved rows cover setup; remaining writes still exercise count/age pruning.
    db.transaction(() => {
      for (let n = 1001; n <= 1003; n++) outbox.enqueue(item(n), outboxNow);
    }).immediate();
    const all = outbox.outbox({ after: 0, limit: 2000 }, outboxNow);
    expect(all.latest).toBe(1003);
    expect(all.items).toHaveLength(1000);
    expect(all.items[0]?.text).toBe("message 4");
    // The same receipt is listed once.
    outbox.enqueue(item(1003), outboxNow);
    expect(
      outbox.outbox({ after: 1002, limit: 10 }, outboxNow).items,
    ).toHaveLength(1);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("crew irc outbox: entries older than 24 hours are never listed", async () => {
  const f = await fixture();

  try {
    const outbox = f.engine.state.ircSessions;
    const hour = 60 * 60_000;
    const now = Date.now();

    const item = (n: number) => ({
      id: n.toString(16).padStart(32, "0"),
      from: { role: "captain" as const, id: "captain" },
      to: { role: "crew" as const, id: "worker" },
      text: `message ${n}`,
    });

    // Stored while fresh; Stargate then stays down for more than a day.
    outbox.enqueue(item(1), now - 25 * hour);
    outbox.enqueue(item(2), now - 23 * hour);
    const page = outbox.outbox({ after: 0, limit: 10 }, now);
    expect(page.items.map((entry) => entry.text)).toEqual(["message 2"]);
    expect(page.items[0]?.created).toBe(now - 23 * hour);
    expect(page.latest).toBe(2);
    expect(
      outbox.outbox({ after: 0, limit: 10 }, now + 2 * hour).items,
    ).toEqual([]);
  } finally {
    await f.close();
  }
});
