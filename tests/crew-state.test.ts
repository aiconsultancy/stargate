import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fixtureRoot } from "./fixture-root";
import { join } from "node:path";
import {
  CrewState,
  pendingTaskLimit,
} from "../src/coordination/crew/execution/state";

const diskIntegrationTimeoutMs = 30_000;

test("worker locations observe a gateway poll only for the same daemon and pinned captain", async () => {
  const directory = await mkdtemp(join(fixtureRoot(), "stargate-crew-state-"));

  const options = [
    directory,
    "custom",
    "identity-v2",
    undefined,
    false,
  ] as const;

  const captain = await CrewState.open(...options, "ses_captain");
  const worker = await CrewState.open(...options, "ses_captain");
  const anotherPin = await CrewState.open(...options, "ses_other");

  try {
    expect(worker.hasCrewQuestionConsumer(5000, 1000)).toBe(false);
    captain.noteCrewQuestionConsumer(5000);
    expect(worker.hasCrewQuestionConsumer(4999, 1000)).toBe(false);
    expect(worker.hasCrewQuestionConsumer(5999, 1000)).toBe(true);
    expect(worker.hasCrewQuestionConsumer(6000, 1000)).toBe(false);
    expect(anotherPin.hasCrewQuestionConsumer(5000, 1000)).toBe(false);
    const previousDaemon = new Database(captain.path);

    try {
      previousDaemon.exec("UPDATE crew_question_consumer SET daemonPID=0");
    } finally {
      previousDaemon.close();
    }

    expect(worker.hasCrewQuestionConsumer(5000, 1000)).toBe(false);
  } finally {
    anotherPin.close();
    worker.close();
    captain.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy state upgrades identity without replacing peers, results or cursors", async () => {
  const directory = await mkdtemp(join(fixtureRoot(), "stargate-crew-state-"));
  const namespace = "legacy";

  const path = join(
    directory,
    `crew-${createHash("sha256").update(namespace).digest("hex")}.sqlite`,
  );

  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE identity (value TEXT PRIMARY KEY);
    INSERT INTO identity VALUES ('old-fingerprint');
    CREATE TABLE peers (
      crewID TEXT PRIMARY KEY CHECK(crewID IN ('mario','luigi','daisy','toad')),
      sessionID TEXT NOT NULL UNIQUE, status TEXT NOT NULL
    );
    INSERT INTO peers VALUES ('mario','ses_legacy','ready');
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,crewID TEXT NOT NULL REFERENCES peers(crewID),
      workerSessionID TEXT NOT NULL,originCaptainID TEXT NOT NULL,
      inputID TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN
        ('dispatching','running','completed','cancelling','uncertain')),
      result TEXT,released INTEGER NOT NULL DEFAULT 0,
      notifying INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO tasks VALUES ('task_legacy','mario','ses_legacy','ses_bowser','msg_legacy','completed','saved result',0,0);
    CREATE TABLE mail_cursors (
      sessionID TEXT NOT NULL,taskID TEXT NOT NULL REFERENCES tasks(id),
      sequence INTEGER NOT NULL,PRIMARY KEY(sessionID,taskID)
    );
    INSERT INTO mail_cursors VALUES ('ses_bowser','task_legacy',42);
  `);
  legacy.close();

  try {
    await expect(
      CrewState.open(directory, namespace, "new-fingerprint"),
    ).rejects.toThrow("configuration changed");

    const state = await CrewState.open(
      directory,
      namespace,
      "new-fingerprint",
      "old-fingerprint",
    );

    try {
      expect(state.peer("mario")?.sessionID).toBe("ses_legacy");
      expect(state.task("task_legacy")?.result).toBe("saved result");
      expect(state.mailCursor("ses_bowser", "task_legacy")).toBe(42);
    } finally {
      state.close();
    }

    const inspect = new Database(path);
    expect(
      inspect.query<{ value: string }, []>("SELECT value FROM identity").get()
        ?.value,
    ).toBe("new-fingerprint");
    inspect.close();
    await expect(
      CrewState.open(directory, namespace, "other-roster", "old-fingerprint"),
    ).rejects.toThrow("new namespace");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["reserve", "enqueue"] as const)(
  "crew %s keeps the native preamble out of stored activity",
  async (admission) => {
    const directory = await mkdtemp(
      join(fixtureRoot(), "stargate-crew-state-"),
    );

    const state = await CrewState.open(directory, "custom", "identity-v2");

    try {
      const peer = state.reservePeer("builder");
      const preamble = "Generated native instructions 😀\n\n";
      const assignment = `${preamble}Keep these words in the assignment`;
      const parts = { preamble, assignment };

      const task =
        admission === "reserve"
          ? state.reserveTask(peer, "captain", parts)
          : state.enqueue(peer, "captain", parts);

      if (!task) {
        throw new Error("Missing task");
      }

      expect(state.activity.task(task, "full").summary).toBe(assignment);

      if (admission === "enqueue") {
        const promoted = state.promote(task.id, null);
        expect(promoted?.text).toBe(preamble + assignment);
        expect(state.activity.task(task, "full").summary).toBe(assignment);
      }
    } finally {
      state.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("a queued assignment written by the old offset path reopens and promotes unchanged", async () => {
  const directory = await mkdtemp(join(fixtureRoot(), "stargate-crew-state-"));
  let state = await CrewState.open(directory, "legacy-prompt", "identity-v2");

  try {
    const peer = state.reservePeer("builder");
    const preamble = "Generated native instructions 😀\n\n";
    const assignment = "Read the retained task text";
    const prompt = preamble + assignment;
    const db = new Database(state.path);

    // The offset was never a column. The queue stored the combined prompt.
    // The activity row stored the already-sliced summary.
    try {
      db.run(
        `INSERT INTO pending_tasks
          (id,crewID,workerSessionID,originCaptainID,inputID,text)
          VALUES ('task_previous',?,?,'captain','msg_previous',?)`,
        [peer.crewID, peer.sessionID, prompt],
      );
      db.run(
        `INSERT INTO member_activity (taskID,crewID,kind,summary,phase)
          VALUES ('task_previous',?,'assignment',?,'queued')`,
        [peer.crewID, prompt.slice(preamble.length)],
      );
    } finally {
      db.close();
    }

    state.close();
    state = await CrewState.open(directory, "legacy-prompt", "identity-v2");
    expect(state.activity.read(peer.crewID, "full").queued).toEqual([
      expect.objectContaining({ id: "task_previous", summary: assignment }),
    ]);
    const promoted = state.promote("task_previous", null);
    expect(promoted?.text).toBe(prompt);
    expect(promoted?.task).toMatchObject({
      inputID: "msg_previous",
      status: "dispatching",
    });
    expect(
      state.activity.task(
        { id: "task_previous", status: "dispatching" },
        "full",
      ).summary,
    ).toBe(assignment);
  } finally {
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "queue ceiling and durable controls remain hard guards; queued order is captain policy",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "stargate-crew-state-"));
    const state = await CrewState.open(directory, "custom", "identity-v2");
    const second = await CrewState.open(directory, "custom", "identity-v2");

    try {
      const peer = state.reservePeer("builder");
      const token = state.reserveControl(peer.crewID);
      expect(second.reserveTask(peer, "captain")).toBeNull();
      const queued = state.enqueue(peer, "captain", "first");
      expect(second.promote(queued.id, null)).toBeNull();
      expect(() => second.reserveControl(peer.crewID)).toThrow("reconcile");
      state.releaseControl(peer.crewID, "wrong-token");
      expect(second.reserveTask(peer, "captain")).toBeNull();
      state.releaseControl(peer.crewID, token);

      for (let index = 1; index < pendingTaskLimit; index++) {
        state.enqueue(peer, "captain", String(index));
      }

      expect(() => second.enqueue(peer, "captain", "overflow")).toThrow("100");
      const immediate = second.reserveTask(peer, "captain", "Priority read");
      expect(immediate).not.toBeNull();

      if (!immediate) {
        throw new Error("Missing priority task");
      }

      expect(state.task(queued.id)?.status).toBe("queued");
      state.complete(immediate.id, peer.sessionID, "Read complete");
      state.release(immediate.id);
      const promoted = second.promote(queued.id, null);
      expect(promoted?.text).toBe("first");
      expect(promoted?.task.inputID).toBe(queued.inputID);
      state.uncertain(queued.id);
      expect(second.promote(queued.id, null)).toBeNull();
      expect(second.reserveTask(peer, "captain")).toBeNull();
      expect(state.task(queued.id)?.status).toBe("uncertain");
    } finally {
      second.close();
      state.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  diskIntegrationTimeoutMs,
);
