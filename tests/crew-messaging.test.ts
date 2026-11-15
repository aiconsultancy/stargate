import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type CrewCaller,
  CrewEngine,
  type CrewOptions,
  type CrewSessions,
} from "../src/crew/engine";
import type { MesijClient, MesijMessage } from "../src/crew/mesij";
import { teamSchema } from "../src/crew/team";

async function fixture() {
  const directory = await mkdtemp("/tmp/opencode/stargate-mail-receipt-");
  const team = teamSchema.parse({
    captain: { id: "captain" },
    crew: [{ id: "worker", role: "Builder", permissionProfile: "coding" }],
  });
  const options: CrewOptions = {
    namespace: "mail-recovery",
    stateDirectory: join(directory, "state"),
    projectDirectory: directory,
    captainDirectory: join(directory, "captain"),
    worktrees: { worker: join(directory, "worker") },
    team,
    mesijCommand: "/unused",
  };
  let wakes = 0;
  const sessions: CrewSessions = {
    async get({ sessionID }) {
      const captain = sessionID.startsWith("ses_captain");
      return {
        id: sessionID,
        agent: captain ? "captain" : "worker",
        location: {
          directory: captain
            ? options.captainDirectory
            : (options.worktrees["worker"] ?? ""),
        },
        metadata: captain
          ? {}
          : {
              stargateCrew: { namespace: options.namespace, crewID: "worker" },
            },
      };
    },
    async create() {
      throw new Error("Unexpected native creation");
    },
    async prompt() {
      throw new Error("Unexpected native admission");
    },
    async synthetic() {
      wakes++;
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
  const keys = new Map<string, MesijMessage>();
  let onSend: ((key: string) => Promise<void>) | undefined;
  let onStored:
    | ((event: MesijMessage, key: string) => Promise<void>)
    | undefined;
  let loseReceipt = true;
  const mailer: Pick<MesijClient, "register" | "send" | "inbox"> = {
    async register() {
      return { id: "0".repeat(32), sequence: 0 };
    },
    async send(input) {
      await onSend?.(input.key);
      let event = keys.get(input.key);
      if (!event) {
        event = {
          id: (events.length + 1).toString(16).padStart(32, "0"),
          sequence: events.length + 1,
          actor: input.actor,
          sessionID: input.sessionID,
          to: input.to,
          text: input.text,
          type: input.replyTo ? "message.replied" : "message.posted",
          ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        };
        keys.set(input.key, event);
        events.push(event);
      }
      await onStored?.(event, input.key);
      if (loseReceipt) {
        loseReceipt = false;
        throw new Error("Mesij stored the event; response was lost");
      }
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
  let engine = await CrewEngine.open(options, sessions, mailer);
  const peer = engine.state.reservePeer("worker");
  engine.state.readyPeer("worker");
  const caller = (sessionID: string, agent: string): CrewCaller => ({
    sessionID,
    agent,
    id: "host-call",
    signal: new AbortController().signal,
  });
  return {
    get engine() {
      return engine;
    },
    events,
    peer,
    captain: (id = "ses_captain_a") => caller(id, "captain"),
    worker: () => caller(peer.sessionID, "worker"),
    wakes: () => wakes,
    loseNextReceipt: () => {
      loseReceipt = true;
    },
    keepNextReceipt: () => {
      loseReceipt = false;
    },
    onSend: (callback: typeof onSend) => {
      onSend = callback;
    },
    onStored: (callback: typeof onStored) => {
      onStored = callback;
    },
    async reopen() {
      await engine.close();
      engine = await CrewEngine.open(options, sessions, mailer);
    },
    async close() {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("lost Mesij receipt survives reopen and cannot create an invisible acknowledged message", async () => {
  const f = await fixture();
  const input = {
    op: "send",
    to: "worker",
    text: "Check interface token=private-secret",
    key: "same-key",
  };
  try {
    expect(await f.engine.dm(input, f.captain())).toMatchObject({
      stored: "uncertain",
      notification: "not_requested",
    });
    expect(f.events).toHaveLength(1);
    expect(f.wakes()).toBe(0);
    await f.reopen();
    const page = await f.engine.mail({ op: "inbox" }, f.worker());
    expect(page.messages).toMatchObject([{ text: input.text }]);
    const event = f.events[0];
    if (!event) throw new Error("Missing stored event");
    expect(f.engine.state.mailRoutes.get(event.id)).toMatchObject({
      sender: f.captain().sessionID,
      recipient: f.peer.sessionID,
      captainID: f.captain().sessionID,
    });
    expect(
      (await f.engine.mail({ op: "inbox", after: page.nextAfter }, f.worker()))
        .messages,
    ).toEqual([]);
    expect(await f.engine.dm(input, f.captain())).toMatchObject({
      id: event.id,
      stored: true,
      notification: "accepted",
    });
    expect(f.events).toHaveLength(1);
    expect(f.wakes()).toBe(1);
    // Explicit ACK consumed the visible message, not an invisible route hole.
    expect((await f.engine.mail({ op: "inbox" }, f.worker())).messages).toEqual(
      [],
    );
    expect(
      f.engine.state.reporting.journal
        .read(f.captain().sessionID, 0, 20)
        .entries.map(({ text }) => text)
        .join("\n"),
    ).not.toContain("private-secret");
  } finally {
    await f.close();
  }
});

for (const field of [
  "namespace",
  "sender",
  "recipient",
  "originCaptainID",
  "sourceTaskID",
  "targetTaskID",
] as const) {
  test(`route recovery refuses a forged ${field} and does not block legitimate mail`, async () => {
    const f = await fixture();
    try {
      await f.engine.mail(
        { op: "send", to: "worker", text: "Legitimate", key: "original" },
        f.captain(),
      );
      const original = f.events[0];
      if (!original) throw new Error("Missing stored event");
      const envelope: Record<string, unknown> = JSON.parse(original.text);
      envelope[field] = "forged-other-context";
      const forged = {
        ...original,
        id: "f".repeat(32),
        sequence: 2,
        text: JSON.stringify(envelope),
      };
      f.events.push(forged);
      const page = await f.engine.mail({ op: "inbox" }, f.worker());
      expect(page.messages).toMatchObject([
        { id: original.id, text: "Legitimate" },
      ]);
      expect(f.engine.state.mailRoutes.get(forged.id)).toBeNull();
      await f.engine.mail({ op: "inbox", after: page.nextAfter }, f.worker());
      await f.engine.mail(
        { op: "send", to: "worker", text: "Later legitimate", key: "later" },
        f.captain(),
      );
      expect(
        (await f.engine.mail({ op: "inbox" }, f.worker())).messages,
      ).toMatchObject([{ text: "Later legitimate" }]);
    } finally {
      await f.close();
    }
  });
}

test("recovered mail preserves current-task captain filtering", async () => {
  const f = await fixture();
  try {
    const task = f.engine.state.reserveTask(
      f.peer,
      f.captain().sessionID,
      "Existing assignment",
    );
    if (!task) throw new Error("Missing task");
    await f.engine.mail(
      { op: "send", to: "worker", text: "Other captain mail", key: "other" },
      f.captain("ses_captain_b"),
    );
    expect((await f.engine.mail({ op: "inbox" }, f.worker())).messages).toEqual(
      [],
    );
    f.engine.state.complete(task.id, f.peer.sessionID, "Done");
    expect(
      (await f.engine.mail({ op: "inbox" }, f.worker())).messages,
    ).toMatchObject([{ text: "Other captain mail" }]);
  } finally {
    await f.close();
  }
});

test("a failed proven route repair holds ACKs across reopen, including caller-supplied after", async () => {
  const f = await fixture();
  const db = new Database(f.engine.state.path);
  try {
    await f.engine.mail(
      { op: "send", to: "worker", text: "Must remain visible", key: "retry" },
      f.captain(),
    );
    const original = f.events[0];
    if (!original) throw new Error("Missing stored event");
    db.exec(`CREATE TRIGGER fail_mail_route BEFORE INSERT ON mail_routes
      BEGIN SELECT RAISE(ABORT, 'Route write unavailable'); END;`);
    await expect(f.engine.mail({ op: "inbox" }, f.worker())).rejects.toThrow();
    expect(db.query("SELECT receiptID FROM mail_intents").get()).toEqual({
      receiptID: null,
    });
    expect(
      db.query("SELECT COUNT(*) AS count FROM mail_route_holes").get(),
    ).toEqual({ count: 1 });
    db.exec("DROP TRIGGER fail_mail_route");
    await f.reopen();
    const repaired = await f.engine.mail(
      { op: "inbox", after: original.sequence + 1000 },
      f.worker(),
    );
    expect(repaired.messages).toMatchObject([
      { id: original.id, text: "Must remain visible" },
    ]);
    expect(db.query("SELECT receiptID FROM mail_intents").get()).toEqual({
      receiptID: original.id,
    });
    expect(
      db.query("SELECT COUNT(*) AS count FROM mail_route_holes").get(),
    ).toEqual({ count: 0 });
    // Repair alone does not ACK a page. Only the next explicit ACK consumes it.
    expect(
      (await f.engine.mail({ op: "inbox" }, f.worker())).messages,
    ).toMatchObject([{ id: original.id }]);
    expect(
      (
        await f.engine.mail(
          { op: "inbox", after: repaired.nextAfter },
          f.worker(),
        )
      ).messages,
    ).toEqual([]);
  } finally {
    db.close();
    await f.close();
  }
});

for (const lost of [false, true]) {
  test(`an intent bound by ${lost ? "recovery" : "send"} rejects a copied new event ID`, async () => {
    const f = await fixture();
    try {
      if (!lost) f.keepNextReceipt();
      await f.engine.mail(
        { op: "send", to: "worker", text: "Authorized once", key: "original" },
        f.captain(),
      );
      const original = f.events[0];
      if (!original) throw new Error("Missing stored event");
      if (lost) await f.engine.mail({ op: "inbox" }, f.worker());
      const copy = { ...original, id: "c".repeat(32), sequence: 2 };
      f.events.push(copy);
      const page = await f.engine.mail({ op: "inbox" }, f.worker());
      expect(page.messages).toMatchObject([
        { id: original.id, text: "Authorized once" },
      ]);
      expect(f.engine.state.mailRoutes.get(copy.id)).toBeNull();
      expect(f.wakes()).toBe(0);
      await f.engine.mail({ op: "inbox", after: page.nextAfter }, f.worker());
      await f.engine.mail(
        { op: "send", to: "worker", text: "Later authorized", key: "later" },
        f.captain(),
      );
      expect(
        (await f.engine.mail({ op: "inbox" }, f.worker())).messages,
      ).toMatchObject([{ text: "Later authorized" }]);
    } finally {
      await f.close();
    }
  });
}

test.each([false, true])(
  "identical authorized keys bind separate receipts, lost=%s",
  async (lost) => {
    const f = await fixture();
    try {
      if (!lost) f.keepNextReceipt();
      const send = { op: "send", to: "worker", text: "Same content" };
      await f.engine.mail({ ...send, key: "first" }, f.captain());
      if (lost) f.loseNextReceipt();
      await f.engine.mail({ ...send, key: "second" }, f.captain());
      expect(f.events).toHaveLength(2);
      const original = f.events[0];
      if (!original) throw new Error("Missing stored event");
      const copy = { ...original, id: "b".repeat(32), sequence: 3 };
      f.events.push(copy);
      const page = await f.engine.mail({ op: "inbox" }, f.worker());
      expect(page.messages?.map(({ id }) => id)).toEqual(
        f.events.slice(0, 2).map(({ id }) => id),
      );
      expect(f.engine.state.mailRoutes.get(copy.id)).toBeNull();
      expect(f.wakes()).toBe(0);
    } finally {
      await f.close();
    }
  },
);

test("receipt binding refuses a different ID or captain context", async () => {
  const f = await fixture();
  const db = new Database(f.engine.state.path);
  try {
    f.keepNextReceipt();
    await f.engine.mail(
      { op: "send", to: "worker", text: "Authorized", key: "original" },
      f.captain(),
    );
    const intent = db
      .query<{ key: string; receiptID: string }, []>(
        "SELECT key,receiptID FROM mail_intents",
      )
      .get();
    if (!intent) throw new Error("Missing bound intent");
    const route = f.engine.state.mailRoutes.get(intent.receiptID);
    if (!route) throw new Error("Missing route");
    expect(() =>
      f.engine.state.mailRoutes.save(
        { ...route, id: "a".repeat(32) },
        intent.key,
      ),
    ).toThrow("authorized intent");
    expect(() =>
      f.engine.state.mailRoutes.save(
        { ...route, captainID: "ses_captain_b" },
        intent.key,
      ),
    ).toThrow("authorized intent");
    expect(db.query("SELECT receiptID FROM mail_intents").get()).toEqual({
      receiptID: intent.receiptID,
    });
    expect(f.engine.state.mailRoutes.get(route.id)).toEqual(route);
    expect(f.engine.state.mailRoutes.get("a".repeat(32))).toBeNull();
    expect(f.events).toHaveLength(1);
    expect(f.wakes()).toBe(0);
  } finally {
    db.close();
    await f.close();
  }
});

test("concurrent identical text correlates out-of-order receipts before local route saves", async () => {
  const f = await fixture();
  const db = new Database(f.engine.state.path);
  const firstEntered = Promise.withResolvers<void>();
  const emitFirst = Promise.withResolvers<void>();
  const secondStored = Promise.withResolvers<void>();
  const bothStored = Promise.withResolvers<void>();
  const firstReceipt = Promise.withResolvers<void>();
  const secondReceipt = Promise.withResolvers<void>();
  const receipts = new Map<string, string>();
  let calls = 0;
  f.keepNextReceipt();
  f.onSend(async () => {
    if (++calls === 1) {
      firstEntered.resolve();
      await emitFirst.promise;
    }
  });
  f.onStored(async (event, key) => {
    receipts.set(key, event.id);
    if (event.sequence === 1) secondStored.resolve();
    else bothStored.resolve();
    await (event.sequence === 1 ? secondReceipt.promise : firstReceipt.promise);
  });
  const input = { op: "send", to: "worker", text: "Identical human text" };
  const first = f.engine.mail({ ...input, key: "first" }, f.captain());
  let second: ReturnType<CrewEngine["mail"]> | undefined;
  try {
    await firstEntered.promise;
    second = f.engine.mail({ ...input, key: "second" }, f.captain());
    await secondStored.promise;
    emitFirst.resolve();
    await bothStored.promise;
    expect(
      db
        .query(
          "SELECT COUNT(*) AS count FROM mail_intents WHERE receiptID IS NULL",
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(db.query("SELECT COUNT(*) AS count FROM mail_routes").get()).toEqual(
      { count: 0 },
    );
    const page = await f.engine.mail({ op: "inbox" }, f.worker());
    expect(page.messages?.map(({ id }) => id)).toEqual(
      f.events.map(({ id }) => id),
    );
    secondReceipt.resolve();
    expect(await second).toMatchObject({ stored: true });
    firstReceipt.resolve();
    expect(await first).toMatchObject({ stored: true });
    for (const row of db
      .query<{ key: string; receiptID: string }, []>(
        "SELECT key,receiptID FROM mail_intents",
      )
      .all()) {
      const receipt = receipts.get(row.key);
      if (!receipt) throw new Error("Missing native receipt");
      expect(row.receiptID).toBe(receipt);
      const event = f.events.find(({ id }) => id === row.receiptID);
      if (!event) throw new Error("Missing correlated event");
      const envelope: Record<string, unknown> = JSON.parse(event.text);
      expect(envelope["intentKey"]).toBe(row.key);
      expect(envelope["text"]).toBe(input.text);
    }
    f.onSend(undefined);
    f.onStored(undefined);
    expect(
      await f.engine.mail({ ...input, key: "first" }, f.captain()),
    ).toMatchObject({ stored: true });
    expect(f.events).toHaveLength(2);
    expect(f.wakes()).toBe(0);
  } finally {
    emitFirst.resolve();
    firstReceipt.resolve();
    secondReceipt.resolve();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
    db.close();
    await f.close();
  }
});

test("route recovery binds native sender identity and does not trust matching JSON alone", async () => {
  const f = await fixture();
  try {
    await f.engine.mail(
      { op: "send", to: "worker", text: "Legitimate", key: "original" },
      f.captain(),
    );
    const original = f.events[0];
    if (!original) throw new Error("Missing stored event");
    const forged = {
      ...original,
      id: "e".repeat(32),
      sequence: 2,
      actor: "forged-actor",
      sessionID: "ses_forged",
    };
    f.events.push(forged);
    const malformed = {
      ...original,
      id: "d".repeat(32),
      sequence: 3,
      text: "{",
    };
    f.events.push(malformed);
    const page = await f.engine.mail({ op: "inbox" }, f.worker());
    expect(page.messages).toMatchObject([{ id: original.id }]);
    expect(f.engine.state.mailRoutes.get(forged.id)).toBeNull();
    expect(f.engine.state.mailRoutes.get(malformed.id)).toBeNull();
    await f.engine.mail({ op: "inbox", after: page.nextAfter }, f.worker());
    expect((await f.engine.mail({ op: "inbox" }, f.worker())).messages).toEqual(
      [],
    );
    await f.engine.mail(
      { op: "send", to: "worker", text: "Later valid", key: "later" },
      f.captain(),
    );
    expect(
      (await f.engine.mail({ op: "inbox" }, f.worker())).messages,
    ).toMatchObject([{ text: "Later valid" }]);
  } finally {
    await f.close();
  }
});

test("a conflicting retry cannot overwrite the authorized intent", async () => {
  const f = await fixture();
  try {
    const original = {
      op: "send",
      to: "worker",
      text: "Original",
      key: "immutable",
    };
    await f.engine.mail(original, f.captain());
    expect(
      await f.engine.mail({ ...original, text: "Changed" }, f.captain()),
    ).toMatchObject({ stored: "uncertain" });
    expect(f.events).toHaveLength(1);
    expect(
      (await f.engine.mail({ op: "inbox" }, f.worker())).messages,
    ).toMatchObject([{ text: "Original" }]);
    expect(await f.engine.mail(original, f.captain())).toMatchObject({
      stored: true,
    });
    expect(f.events).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("lost reply receipts recover the original captain route without cross-captain delivery", async () => {
  const f = await fixture();
  try {
    await f.engine.mail(
      { op: "send", to: "worker", text: "Question", key: "question" },
      f.captain(),
    );
    const question = (await f.engine.mail({ op: "inbox" }, f.worker()))
      .messages?.[0];
    if (!question) throw new Error("Missing validated question");
    f.loseNextReceipt();
    const reply = {
      op: "send",
      to: "captain",
      text: "Answer",
      key: "reply",
      replyTo: question.id,
    };
    expect(await f.engine.mail(reply, f.worker())).toMatchObject({
      stored: "uncertain",
    });
    expect(
      (await f.engine.mail({ op: "inbox" }, f.captain("ses_captain_b")))
        .messages,
    ).toEqual([]);
    expect(
      (await f.engine.mail({ op: "inbox" }, f.captain())).messages,
    ).toMatchObject([{ text: "Answer", replyTo: question.id }]);
    expect(await f.engine.mail(reply, f.worker())).toMatchObject({
      stored: true,
    });
    expect(f.events).toHaveLength(2);
    expect(f.wakes()).toBe(0);
  } finally {
    await f.close();
  }
});

test("crew mail refuses a crew agent session that is not the member's session", async () => {
  // A Stargate IRC session uses the crew agent but is a separate root session:
  // it cannot send Mesij mail as that member.
  const f = await fixture();
  try {
    const irc: CrewCaller = {
      sessionID: "ses_irc_worker",
      agent: "worker",
      id: "host-call",
      signal: new AbortController().signal,
    };
    await expect(
      f.engine.mail({ op: "send", to: "captain", text: "From IRC" }, irc),
    ).rejects.toThrow("Only the configured captain or assigned worker");
    await expect(
      f.engine.dm({ op: "send", to: "captain", text: "From IRC" }, irc),
    ).rejects.toThrow("Only the configured captain or assigned worker");
    expect(f.events).toHaveLength(0);
  } finally {
    await f.close();
  }
});
