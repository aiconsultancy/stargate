import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import {
  type CrewCaller,
  CrewEngine,
  type CrewOptions,
  type CrewSessions,
} from "../src/coordination/crew/execution/engine";
import type {
  MesijClient,
  MesijMessage,
} from "../src/coordination/crew/messaging/mesij";
import { runRecoveryOperator } from "../src/coordination/crew/execution/recovery-rpc";
import { teamSchema } from "../src/coordination/crew/team";
import { fixtureRoot } from "./fixture-root";

const canonical = "ses_rootCanonical";
const legacy = "ses_rootLegacy";

/** Fake native roots, workers and Mesij; no OpenCode, provider or Slack. */
async function fixture() {
  const directory = await mkdtemp(
    join(fixtureRoot(), "stargate-captain-crew-"),
  );

  const team = Schema.decodeUnknownSync(teamSchema)({
    captain: { id: "captain" },
    crew: [
      { id: "worker", role: "Builder", permissionProfile: "coding" },
      { id: "helper", role: "Reviewer", permissionProfile: "coding" },
    ],
  });

  const options: CrewOptions = {
    namespace: "captain-singleton",
    stateDirectory: join(directory, "state"),
    projectDirectory: directory,
    captainDirectory: join(directory, "captain"),
    worktrees: {
      worker: join(directory, "worker"),
      helper: join(directory, "helper"),
    },
    team,
    mesijCommand: "/unused",
  };

  const synthetic: { sessionID: string; metadata?: unknown }[] = [];
  const prompts: { sessionID: string; metadata?: unknown }[] = [];
  let engine: CrewEngine | undefined;

  const sessions: CrewSessions = {
    async get({ sessionID }) {
      const peer = engine?.state.peerBySession(sessionID);

      if (peer) {
        return {
          id: sessionID,
          agent: peer.crewID,
          location: { directory: options.worktrees[peer.crewID] ?? "" },
          metadata: {
            stargateCrew: { namespace: options.namespace, crewID: peer.crewID },
          },
        };
      }

      // Every ses_root* session is a real native captain root.
      if (!sessionID.startsWith("ses_root")) {
        throw new Error("Unknown session");
      }

      return {
        id: sessionID,
        agent: "captain",
        location: { directory: options.captainDirectory },
      };
    },
    async create() {
      throw new Error("Unexpected native creation");
    },
    async prompt(input) {
      prompts.push(input);

      return { id: input.id ?? "", sessionID: input.sessionID };
    },
    async synthetic(input) {
      synthetic.push(input);
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

  const mailer: Pick<MesijClient, "register" | "send" | "inbox"> = {
    async register() {
      return { id: "0".repeat(32), sequence: 0 };
    },
    async send(input) {
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

      return { id: event.id, sequence: event.sequence };
    },
    async inbox(input) {
      return events
        .filter(
          (event) =>
            event.sequence > (input.after ?? 0) && event.to === input.sessionID,
        )
        .slice(0, input.limit ?? 100);
    },
  };

  const open = async (captainSessionID?: string) => {
    await engine?.close();
    engine = await CrewEngine.open(
      captainSessionID ? { ...options, captainSessionID } : options,
      sessions,
      mailer,
    );

    return engine;
  };

  const current = await open();
  const peer = current.state.reservePeer("worker");
  current.state.readyPeer("worker");
  const helper = current.state.reservePeer("helper");
  current.state.readyPeer("helper");

  const caller = (sessionID: string, agent: string, id = "call") =>
    ({
      sessionID,
      agent,
      id,
      signal: new AbortController().signal,
    }) satisfies CrewCaller;

  return {
    get engine() {
      if (!engine) {
        throw new Error("Engine closed");
      }

      return engine;
    },
    open,
    events,
    synthetic,
    prompts,
    peer,
    helper,
    captain: (sessionID: string, id?: string) =>
      caller(sessionID, "captain", id),
    worker: (id?: string) => caller(peer.sessionID, "worker", id),
    async close() {
      await engine?.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("a pinned team keeps one captain: earlier roots are history, not authority or wake targets", async () => {
  const f = await fixture();

  try {
    // Before the pin: an earlier root mailed the worker and owns a task.
    await f.engine.mail(
      { op: "send", to: "worker", text: "Question", key: "question" },
      f.captain(legacy),
    );
    const task = f.engine.state.reserveTask(f.peer, legacy, "Legacy work");

    if (!task) {
      throw new Error("Missing legacy task");
    }

    f.engine.state.running(task.id);

    await f.open(canonical);

    // Every captain tool, including recovery and history, authenticates the pin.
    for (const attempt of [
      () => f.engine.run({ op: "roster" }, f.captain(legacy)),
      () => f.engine.authorize(f.captain(legacy)),
      () => f.engine.quota({}, f.captain(legacy)),
      () => f.engine.journal({ op: "read" }, f.captain(legacy)),
      () =>
        runRecoveryOperator(
          f.engine,
          { sessionID: legacy, request: { op: "inspect", crew: "worker" } },
          AbortSignal.timeout(5000),
        ),
    ]) {
      await expect(attempt()).rejects.toThrow("earlier captain sessions");
    }

    await expect(
      f.engine.authorize(f.captain(canonical)),
    ).resolves.toBeUndefined();

    // A captain-alias reply to the earlier root's mail wakes the pin only.
    const question = (await f.engine.mail({ op: "inbox" }, f.worker()))
      .messages?.[0];

    if (!question) {
      throw new Error("Missing legacy question");
    }

    expect(
      await f.engine.dm(
        {
          op: "send",
          to: "captain",
          text: "Answer",
          replyTo: question.id,
          key: "answer",
        },
        f.worker("reply"),
      ),
    ).toMatchObject({ stored: true, notification: "accepted" });
    // A task-context DM on the earlier root's task also wakes the pin.
    expect(
      await f.engine.dm(
        { op: "send", to: "captain", text: "Decision needed", key: "dm" },
        f.worker("dm"),
      ),
    ).toMatchObject({ stored: true, notification: "accepted" });
    expect(f.synthetic.map(({ sessionID }) => sessionID)).toEqual([
      canonical,
      canonical,
    ]);
    expect(f.events.slice(1).map(({ to }) => to)).toEqual([
      canonical,
      canonical,
    ]);
    expect(
      (await f.engine.mail({ op: "inbox" }, f.captain(canonical))).messages,
    ).toMatchObject([
      { text: "Answer", replyTo: question.id },
      { text: "Decision needed", sourceTaskID: task.id },
    ]);
    // Task notices for the legacy task reach the canonical captain's wait.
    expect(f.engine.state.notices(task.id, 0)).toHaveLength(2);

    // The pin collects the earlier root's result; the raw origin is kept.
    f.engine.state.complete(task.id, f.peer.sessionID, "Legacy result");
    expect(
      await f.engine.run(
        { op: "status", taskID: task.id },
        f.captain(canonical),
      ),
    ).toMatchObject({
      status: "completed",
      task: { originCaptainID: legacy, result: "Legacy result" },
    });
    expect(f.engine.state.task(task.id)?.originCaptainID).toBe(legacy);
  } finally {
    await f.close();
  }
});

test("quota tool authorizes captain/assigned worker, accepts no controls and starts no work", async () => {
  const f = await fixture();

  try {
    await f.open(canonical);
    const task = f.engine.state.reserveTask(f.peer, canonical, "Existing work");

    if (!task) {
      throw new Error("Missing task");
    }

    f.engine.state.running(task.id);
    expect(await f.engine.quota({}, f.captain(canonical))).toMatchObject({
      status: "not-configured",
      accounts: [],
    });
    expect(await f.engine.quota({}, f.worker())).toMatchObject({
      status: "not-configured",
      accounts: [],
    });
    await expect(
      f.engine.quota({ url: "https://example.com", reset: true }, f.worker()),
    ).rejects.toThrow("no URL");
    await expect(
      f.engine.quota({}, { ...f.worker(), sessionID: "ses_foreign" }),
    ).rejects.toThrow("configured captain or assigned worker");
    expect(f.engine.state.task(task.id)?.status).toBe("running");
    expect(f.prompts).toEqual([]);
    expect(f.synthetic).toEqual([]);
    expect(f.events).toEqual([]);
  } finally {
    await f.close();
  }
});

test("the pin keeps queued FIFO work, cancels it, and admits it with its raw origin", async () => {
  const f = await fixture();

  try {
    const first = f.engine.state.enqueue(f.peer, legacy, "First queued");
    const second = f.engine.state.enqueue(f.peer, legacy, "Second queued");
    await f.open(canonical);
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      f.engine.run(
        { op: "wait", taskID: first.id },
        { ...f.captain(canonical), signal: aborted.signal },
      ),
    ).rejects.toThrow("queued task cancelled without interrupting");
    expect(f.engine.state.task(first.id)).toMatchObject({
      status: "cancelled",
      originCaptainID: legacy,
    });
    expect(
      await f.engine.run(
        { op: "status", taskID: second.id },
        f.captain(canonical),
      ),
    ).toMatchObject({
      status: "running",
      task: { id: second.id, originCaptainID: legacy },
    });
    // Native evidence carries the stored origin, not the pin.
    expect(f.prompts).toMatchObject([
      {
        sessionID: f.peer.sessionID,
        metadata: {
          pogoCrew: { taskID: second.id, originCaptainID: legacy },
        },
      },
    ]);
  } finally {
    await f.close();
  }
});

test("reconciliation and abandonment keep the raw stored captain identity", async () => {
  const f = await fixture();

  try {
    const task = f.engine.state.reserveTask(f.peer, legacy, "Legacy work");

    if (!task) {
      throw new Error("Missing legacy task");
    }

    f.engine.state.uncertain(task.id);
    await f.open(canonical);

    const reconcile = (originCaptainID: string) =>
      f.engine.run(
        {
          op: "reconcile",
          taskID: task.id,
          expected: {
            status: "uncertain",
            workerSessionID: task.workerSessionID,
            originCaptainID,
            inputID: task.inputID,
          },
          resultMessageID: "msg_result",
          resultSha256: "a".repeat(64),
          reason: "Verified retained answer",
        },
        f.captain(canonical),
      );

    await expect(reconcile(canonical)).rejects.toThrow(
      "Expected ownership is stale",
    );
    // The raw identity passes the ownership check and reaches evidence reads.
    await expect(reconcile(legacy)).rejects.toThrow(
      "Authenticated inspection API unavailable",
    );
    await expect(
      f.engine.run(
        {
          op: "abandon",
          taskID: task.id,
          expected: {
            status: "uncertain",
            workerSessionID: task.workerSessionID,
            originCaptainID: canonical,
            inputID: task.inputID,
          },
          reason: "Blocked",
          key: "abandon-1",
          acknowledgeUnconfirmedStop: true,
        },
        f.captain(canonical),
      ),
    ).rejects.toThrow("Expected ownership is stale");
    expect(f.engine.state.task(task.id)).toMatchObject({
      status: "uncertain",
      originCaptainID: legacy,
    });
  } finally {
    await f.close();
  }
});

test("lineage needs stored captain evidence; workers and unknown sessions are never aliased", async () => {
  const f = await fixture();

  try {
    const forged = f.engine.state.reserveTask(
      f.helper,
      f.peer.sessionID,
      "Worker-origin row",
    );

    if (!forged) {
      throw new Error("Missing forged task");
    }

    await f.open(canonical);
    const { state } = f.engine;
    expect(state.captainLineage(canonical)).toBe(true);
    expect(state.captainLineage(f.peer.sessionID)).toBe(false);
    expect(state.captainLineage("ses_rootUnknown")).toBe(false);
    expect(state.captainLineage("")).toBe(false);
    expect(state.captainRoute("ses_rootUnknown")).toBe("ses_rootUnknown");
    await expect(
      f.engine.run({ op: "status", taskID: forged.id }, f.captain(canonical)),
    ).rejects.toThrow("does not own the requested task");
  } finally {
    await f.close();
  }
});

test("pinned journals write new lineage facts under the pin and read earlier roots", async () => {
  const f = await fixture();

  try {
    const task = f.engine.state.reserveTask(f.peer, legacy, "Legacy work");

    if (!task) {
      throw new Error("Missing legacy task");
    }

    await f.open(canonical);
    f.engine.state.running(task.id);
    const page = await f.engine.journal({ op: "read" }, f.captain(canonical));
    expect(
      page.entries.map(({ captainID, text }) => [captainID, text]),
    ).toEqual([
      [legacy, "Legacy work"],
      [canonical, "Running"],
    ]);
  } finally {
    await f.close();
  }
});

test("unpinned teams keep per-root ownership and wake the originating root", async () => {
  const f = await fixture();

  try {
    const task = f.engine.state.reserveTask(f.peer, legacy, "Root work");

    if (!task) {
      throw new Error("Missing task");
    }

    f.engine.state.running(task.id);
    expect(f.engine.state.captainLineage(legacy)).toBe(false);
    await expect(
      f.engine.run({ op: "status", taskID: task.id }, f.captain(canonical)),
    ).rejects.toThrow("does not own the requested task");
    await f.engine.dm(
      { op: "send", to: "captain", text: "Decision needed", key: "dm" },
      f.worker(),
    );
    expect(f.synthetic.map(({ sessionID }) => sessionID)).toEqual([legacy]);
  } finally {
    await f.close();
  }
});
