import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { CrewState } from "../src/coordination/crew/execution/state";
import { resumeMessageID } from "../src/coordination/crew/message-protocol";
import {
  crewTurnsInputSchema,
  crewTurnsSchema,
  maxTaskInputs,
  settledTasksPerMember,
} from "../src/coordination/crew/reporting/fleet-status";
import {
  crewTurnTaskWindow,
  crewTurns,
} from "../src/coordination/crew/reporting/member-activity";
import { MAX_CREW_CONTEXTS } from "../src/shared/session-history";
import { fixtureRoot } from "./fixture-root";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close();
  }
});

async function fixture(namespace: string) {
  const directory = await mkdtemp(join(fixtureRoot(), "stargate-crew-turns-"));
  const state = await CrewState.open(directory, namespace, "identity");
  const db = new Database(state.path, { strict: true });

  cleanup.push(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  const peer = (crewID: string) => {
    const reserved = state.reservePeer(crewID);
    state.readyPeer(crewID);

    return reserved.sessionID;
  };

  const task = (
    id: string,
    crewID: string,
    workerSessionID: string,
    status: string,
    inputID = `in-${id}`,
  ) => {
    db.query(
      `INSERT INTO tasks (id,crewID,workerSessionID,originCaptainID,inputID,status,released)
      VALUES (?,?,?,?,?,?,?)`,
    ).run(
      id,
      crewID,
      workerSessionID,
      "captain-session",
      inputID,
      status,
      ["completed", "abandoned", "cancelled"].includes(status) ? 1 : 0,
    );
  };

  const resume = (taskID: string, idleAt: number) => {
    db.query(
      `INSERT INTO task_resume_attempts (taskID,idleAt,requestedBy,requestedAt)
      VALUES (?,?,?,?)`,
    ).run(taskID, idleAt, "captain-session", idleAt);
  };

  return { state, peer, task, resume };
}

test("crew turns list peers, active and recent settled tasks with every input", async () => {
  const main = await fixture("turns");
  const other = await fixture("turns:project:web");
  const mario = main.peer("mario");
  const luigi = main.peer("luigi");
  const webMario = other.peer("mario");

  for (let index = 0; index < settledTasksPerMember + 2; index++) {
    main.task(`old-${index}`, "mario", mario, "completed");
  }

  main.task("resumed", "mario", mario, "uncertain");
  main.resume("resumed", 1000);
  main.resume("resumed", 2000);
  main.task("luigi-1", "luigi", luigi, "running");
  other.task("web-1", "mario", webMario, "cancelled");

  const contexts = [
    {
      project: null,
      namespace: "turns",
      members: new Set(["mario", "luigi"]),
      turns: main.state.turns,
    },
    {
      project: "web",
      namespace: "turns:project:web",
      members: new Set(["mario"]),
      turns: other.state.turns,
    },
  ];

  const all = Schema.decodeUnknownSync(crewTurnsSchema)(
    crewTurns(contexts, {}),
  );

  expect(all.peers).toEqual([
    {
      member: "luigi",
      project: null,
      workerSessionID: luigi,
      namespace: "turns",
    },
    {
      member: "mario",
      project: null,
      workerSessionID: mario,
      namespace: "turns",
    },
    {
      member: "mario",
      project: "web",
      workerSessionID: webMario,
      namespace: "turns:project:web",
    },
  ]);

  // The oldest settled tasks fall out; active tasks always stay.
  const ids = all.tasks.map((task) => task.taskID);
  expect(ids).not.toContain("old-0");
  expect(ids).not.toContain("old-1");
  expect(ids).toContain("old-2");
  expect(ids.filter((id) => id.startsWith("old-"))).toHaveLength(
    settledTasksPerMember,
  );
  expect(ids).toContain("luigi-1");
  expect(ids).toContain("web-1");

  const binding = {
    id: "resumed",
    inputID: "in-resumed",
    originCaptainID: "captain-session",
  };

  const resumed = all.tasks.find((task) => task.taskID === "resumed");
  expect(resumed).toEqual({
    taskID: "resumed",
    member: "mario",
    project: null,
    workerSessionID: mario,
    originCaptainID: "captain-session",
    status: "uncertain",
    inputIDs: [
      "in-resumed",
      resumeMessageID(binding, 1000),
      resumeMessageID(binding, 2000),
    ],
  });

  // A member filter narrows peers and tasks.
  const onlyLuigi = crewTurns(contexts, { member: "luigi" });
  expect(onlyLuigi.peers.map((peer) => peer.member)).toEqual(["luigi"]);
  expect(onlyLuigi.tasks.map((task) => task.taskID)).toEqual(["luigi-1"]);

  // An input lookup finds its task at any age, by a resume input too.
  expect(
    crewTurns(contexts, { inputID: "in-old-0" }).tasks.map(
      (task) => task.taskID,
    ),
  ).toEqual(["old-0"]);
  expect(
    crewTurns(contexts, {
      member: "mario",
      inputID: resumeMessageID(binding, 2000),
    }).tasks.map((task) => task.taskID),
  ).toEqual(["resumed"]);
  expect(
    crewTurns(contexts, { member: "luigi", inputID: "in-old-0" }).tasks,
  ).toEqual([]);
  expect(crewTurns(contexts, { inputID: "unknown" }).tasks).toEqual([]);
});

test("a task's inputs keep the assignment and the latest resumes", async () => {
  const { state, peer, task, resume } = await fixture("turns-bound");
  const mario = peer("mario");
  task("long", "mario", mario, "uncertain");

  for (let idleAt = 1; idleAt <= maxTaskInputs + 5; idleAt++) {
    resume("long", idleAt);
  }

  const [long] = crewTurns(
    [
      {
        project: null,
        namespace: "turns-bound",
        members: new Set(["mario"]),
        turns: state.turns,
      },
    ],
    {},
  ).tasks;

  const binding = {
    id: "long",
    inputID: "in-long",
    originCaptainID: "captain-session",
  };

  expect(long?.inputIDs).toHaveLength(maxTaskInputs);
  expect(long?.inputIDs[0]).toBe("in-long");
  expect(long?.inputIDs[1]).toBe(resumeMessageID(binding, 7));
  expect(long?.inputIDs.at(-1)).toBe(
    resumeMessageID(binding, maxTaskInputs + 5),
  );
});

test("crew turns input is exact", () => {
  const decode = Schema.decodeUnknownResult(crewTurnsInputSchema);
  expect(decode({ member: "mario", inputID: "msg_1" })._tag).toBe("Success");
  expect(decode({ member: "Mario" })._tag).toBe("Failure");
  expect(decode({ inputID: "" })._tag).toBe("Failure");
  expect(decode({ extra: true })._tag).toBe("Failure");
});

test("only ready peers of the configured OpenCode roster are listed", async () => {
  const { state, peer, task } = await fixture("turns-roster");
  const mario = peer("mario");
  // A member removed from the configuration keeps its persisted row.
  const removed = peer("removed");
  // A Pi worker is a peer row too, but not an OpenCode session.
  peer("pi-worker");
  // A reservation that never became ready.
  state.reservePeer("pending");
  task("removed-1", "removed", removed, "running");
  task("mario-1", "mario", mario, "running");

  const contexts = [
    {
      project: null,
      namespace: "turns-roster",
      members: new Set(["mario", "pending"]),
      known: new Set(["mario", "pending", "pi-worker"]),
      turns: state.turns,
    },
  ];

  const all = crewTurns(contexts, {});
  expect(all.peers.map((entry) => entry.member)).toEqual(["mario"]);
  expect(all.tasks.map((entry) => entry.taskID)).toEqual(["mario-1"]);
  // Every configured member exists; only OpenCode members are collected.
  expect(Schema.decodeUnknownSync(crewTurnsSchema)(all).members).toEqual([
    { member: "mario", collected: true },
    { member: "pending", collected: true },
    { member: "pi-worker", collected: false },
  ]);
  expect(crewTurns(contexts, { member: "removed" })).toEqual({
    members: [],
    peers: [],
    tasks: [],
  });
  expect(
    crewTurns(contexts, { member: "removed", inputID: "in-removed-1" }).tasks,
  ).toEqual([]);
});

test("an exact lookup finds a resume older than the latest inputs", async () => {
  const { state, peer, task, resume } = await fixture("turns-window");
  const mario = peer("mario");
  task("long", "mario", mario, "uncertain");

  for (let idleAt = 1; idleAt <= maxTaskInputs + 5; idleAt++) {
    resume("long", idleAt);
  }

  const contexts = [
    {
      project: null,
      namespace: "turns-window",
      members: new Set(["mario"]),
      turns: state.turns,
    },
  ];

  const binding = {
    id: "long",
    inputID: "in-long",
    originCaptainID: "captain-session",
  };

  // Just outside the window of the latest resumes.
  const outside = resumeMessageID(binding, 6);
  const [listed] = crewTurns(contexts, {}).tasks;
  expect(listed?.inputIDs).not.toContain(outside);

  const [found] = crewTurns(contexts, {
    member: "mario",
    inputID: outside,
  }).tasks;

  expect(found?.taskID).toBe("long");
  expect(found?.inputIDs).toContain(outside);
  expect(found?.inputIDs).toHaveLength(maxTaskInputs);
  expect(found?.inputIDs[0]).toBe("in-long");
  expect(found?.inputIDs[1]).toBe(outside);
  expect(found?.inputIDs.at(-1)).toBe(
    resumeMessageID(binding, maxTaskInputs + 5),
  );
  expect(() =>
    Schema.decodeUnknownSync(crewTurnsSchema)({
      peers: [],
      tasks: [found],
    }),
  ).not.toThrow();
});

test("crew turn reads are bounded per member and use the member index", async () => {
  const { state, peer, task, resume } = await fixture("turns-plan");
  const mario = peer("mario");

  for (let index = 0; index <= crewTurnTaskWindow; index++) {
    task(`t-${index}`, "mario", mario, "completed");
    resume(`t-${index}`, index + 1);
  }

  const contexts = [
    {
      project: null,
      namespace: "turns-plan",
      members: new Set(["mario"]),
      turns: state.turns,
    },
  ];

  const binding = (id: string) => ({
    id,
    inputID: `in-${id}`,
    originCaptainID: "captain-session",
  });

  // Resumes of the member's latest tasks are found; older ones are not.
  expect(
    crewTurns(contexts, {
      member: "mario",
      inputID: resumeMessageID(binding("t-1"), 2),
    }).tasks.map((entry) => entry.taskID),
  ).toEqual(["t-1"]);
  expect(
    crewTurns(contexts, {
      member: "mario",
      inputID: resumeMessageID(binding("t-0"), 1),
    }).tasks,
  ).toEqual([]);

  const db = new Database(state.path, { strict: true });

  try {
    const plan = db
      .query<{ detail: string }, [string, number]>(
        `EXPLAIN QUERY PLAN SELECT id FROM tasks
        WHERE crewID=? ORDER BY rowid DESC LIMIT ?`,
      )
      .all("mario", crewTurnTaskWindow)
      .map(({ detail }) => detail)
      .join("\n");

    expect(plan).toContain("USING INDEX member_task_history");
    expect(plan).not.toContain("TEMP B-TREE");
  } finally {
    db.close();
  }
});

/** A configuration with every member ready, and busy, in every context. */
async function full(crew: number, projects: number) {
  const members = Array.from({ length: crew }, (_, index) => `m${index}`);
  const contexts = [];

  for (let context = 0; context <= projects; context++) {
    const project = context === 0 ? null : `p${context}`;
    const namespace = project ? `full:project:${project}` : "full";
    const f = await fixture(namespace);

    for (const member of members) {
      const session = f.peer(member);
      f.task(`${namespace}-${member}-run`, member, session, "running");

      for (let index = 0; index < settledTasksPerMember; index++) {
        f.task(`${namespace}-${member}-${index}`, member, session, "completed");
      }
    }

    contexts.push({
      project,
      namespace,
      members: new Set(members),
      turns: f.state.turns,
    });
  }

  return crewTurns(contexts, {});
}

test("a configuration at the crew limits reads whole through crewTurns", async () => {
  // MAX_CREW_CONTEXTS member contexts: one project, or members × projects.
  for (const [crew, projects] of [
    [MAX_CREW_CONTEXTS, 0],
    [10, 4],
  ] as const) {
    const report = await full(crew, projects);

    const read = Schema.decodeUnknownSync(crewTurnsSchema)(
      Schema.encodeSync(crewTurnsSchema)(report),
    );

    expect(read.members).toHaveLength(crew);
    expect(read.peers).toHaveLength(MAX_CREW_CONTEXTS);
    expect(read.tasks).toHaveLength(
      MAX_CREW_CONTEXTS * (settledTasksPerMember + 1),
    );
  }
});

test("a report over the crew limits is refused at its boundary", () => {
  const members = Array.from({ length: MAX_CREW_CONTEXTS + 1 }, (_, index) => ({
    member: `m${index}`,
    collected: true,
  }));

  expect(() =>
    Schema.decodeUnknownSync(crewTurnsSchema)({
      members,
      peers: [],
      tasks: [],
    }),
  ).toThrow();
});
