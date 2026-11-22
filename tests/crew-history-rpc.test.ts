import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { CrewHistoryRPC } from "../src/crew/history/history-rpc";
import { PiCrewWorkers, type PiWorkerFactory } from "../src/crew/pi-worker";
import { CrewError, CrewState, type Peer } from "../src/crew/state";
import { type CrewMember, teamSchema } from "../src/crew/team";
import {
  historySessionPageSchema,
  type SessionHistory,
} from "../src/shared/session-history";

const signal = () => new AbortController().signal;
const unavailable = "Pi history unavailable or cancelled.";
const diskIntegrationTimeoutMs = 30_000;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "stargate-crew-history-"));
  const state = await CrewState.open(directory, "history", "identity");
  const team = Schema.decodeUnknownSync(teamSchema)({
    captain: { id: "captain" },
    crew: [
      {
        id: "mario",
        name: "Mario",
        model: "openai/test",
        role: "Code",
        permissionProfile: "coding",
      },
      {
        id: "twiki",
        name: "Twiki",
        role: "Maintenance",
        permissionProfile: "coding",
        backend: { type: "pi-durable", model: "openai/test" },
      },
      {
        id: "r2d2",
        role: "Other Pi",
        permissionProfile: "coding",
        backend: { type: "pi-durable", model: "openai/test" },
      },
      { id: "pending", role: "Not ready", permissionProfile: "coding" },
      { id: "absent", role: "Not provisioned", permissionProfile: "coding" },
    ],
  });
  const peers = new Map<string, Peer>();
  for (const [id, native] of [
    ["mario", undefined],
    ["twiki", "17"],
    ["r2d2", "27"],
  ] as const) {
    const peer = state.reservePeer(id);
    state.readyPeer(id);
    if (native) {
      state.reservePiPeer(peer.sessionID);
      state.readyPiPeer(peer.sessionID, native);
    }
    peers.set(id, peer);
  }
  state.reservePeer("pending");
  const peer = (id: string) => {
    const value = peers.get(id);
    if (!value) throw new Error("Missing test peer");
    return value;
  };
  const task = (id: string, conversationID: string, report = false) => {
    const worker = peer(id);
    const task = state.reserveTask(worker, "captain", "private assignment");
    if (!task) throw new Error("Missing task");
    state.savePiTaskConversation(task.id, conversationID);
    if (report) state.reporting.markReport(task.id, "test-capture");
    state.complete(task.id, worker.sessionID, "private result");
    state.release(task.id);
  };
  task("twiki", "17");
  task("twiki", "18", true);
  task("twiki", "19");
  task("twiki", "19");
  task("r2d2", "28");
  const reads: { member: string; conversationID: string }[] = [];
  const history: SessionHistory = {
    async roots() {
      throw new Error("Must not read native roots");
    },
    async describe() {
      throw new Error("Must not read native metadata");
    },
    async children() {
      throw new Error("Must not scan native forks");
    },
    async entries(input, call) {
      call.throwIfAborted();
      reads.push({ member: activeMember, conversationID: input.sessionID });
      return {
        entries: [
          {
            id: "1",
            role: "user",
            parts: [{ type: "text", text: "retained" }],
          },
        ],
      };
    },
  };
  let activeMember = "";
  const workers: Pick<PiCrewWorkers, "readHistory"> = {
    async readHistory(member, _signal, read) {
      activeMember = member.id;
      return read(history, _signal);
    },
  };
  const rpc = new CrewHistoryRPC(team, state, workers);
  const root = (id: string) => `pi:${peer(id).sessionID}`;
  const db = new Database(state.path, { readonly: true });
  const snapshot = () =>
    [
      "peers",
      "pi_peers",
      "tasks",
      "pi_task_conversations",
      "pending_tasks",
      "activity_report_tasks",
    ].map((table) => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
  return {
    directory,
    state,
    team,
    peer,
    rpc,
    root,
    reads,
    snapshot,
    close: async () => {
      db.close();
      state.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("history RPC mixed roots are pure provisioned-state reads", async () => {
  const f = await fixture();
  try {
    const before = f.snapshot();
    const page = await f.rpc.historyRoots(signal());
    Schema.decodeUnknownSync(historySessionPageSchema)(page);
    expect(
      page.sessions.map(({ id, harness, kind, member }) => ({
        id,
        harness,
        kind,
        member,
      })),
    ).toEqual([
      {
        id: f.peer("mario").sessionID,
        harness: "opencode",
        kind: "crew",
        member: "mario",
      },
      {
        id: f.root("twiki"),
        harness: "pi-durable",
        kind: "crew",
        member: "twiki",
      },
      {
        id: f.root("r2d2"),
        harness: "pi-durable",
        kind: "crew",
        member: "r2d2",
      },
    ]);
    expect(page.sessions[1]).toMatchObject({
      title: "Twiki",
      model: "openai/test",
    });
    expect(f.reads).toEqual([]);
    expect(f.snapshot()).toEqual(before);
  } finally {
    await f.close();
  }
});

test("history RPC authorizes every describe, children and entry ID before reads", async () => {
  const f = await fixture();
  try {
    const before = f.snapshot();
    const root = f.root("twiki");
    const foreign = [
      "pi:17",
      "pi:foreign~18",
      f.peer("mario").sessionID,
      `pi:${f.peer("mario").sessionID}`,
      `${root}~999`,
      `${root}~28`,
      `${root}~018`,
      `${root}~18~19`,
    ];
    expect(
      await f.rpc.historyDescribe([...foreign, root, `${root}~18`], signal()),
    ).toMatchObject({
      sessions: [
        { id: root, kind: "crew" },
        { id: `${root}~18`, kind: "conversation", parentID: root },
      ],
    });
    for (const id of foreign) {
      await expect(
        f.rpc.historyChildren({ parentID: id, limit: 10 }, signal()),
      ).rejects.toBeInstanceOf(CrewError);
      await expect(
        f.rpc.historyEntries(
          { sessionID: id, limit: 10, order: "asc", detail: "full" },
          signal(),
        ),
      ).rejects.toThrow(unavailable);
    }
    expect(f.reads).toEqual([]);
    expect(f.snapshot()).toEqual(before);
  } finally {
    await f.close();
  }
});

test(
  "history RPC pages recorded task/report children, excludes main and duplicates",
  async () => {
    const f = await fixture();
    try {
      const before = f.snapshot();
      const root = f.root("twiki");
      const first = await f.rpc.historyChildren(
        { parentID: root, limit: 1 },
        signal(),
      );
      expect(first.sessions).toEqual([
        {
          id: `${root}~18`,
          parentID: root,
          harness: "pi-durable",
          kind: "conversation",
          title: "report",
        },
      ]);
      if (!first.cursor) throw new Error("Missing cursor");
      const second = await f.rpc.historyChildren(
        { parentID: root, limit: 1, cursor: first.cursor },
        signal(),
      );
      expect(second.sessions).toEqual([
        {
          id: `${root}~19`,
          parentID: root,
          harness: "pi-durable",
          kind: "conversation",
          title: "task",
        },
      ]);
      expect(second.cursor).toBeUndefined();
      const recent = await f.rpc.historyChildren(
        { parentID: root, limit: 1, updatedSince: 0 },
        signal(),
      );
      expect(recent.sessions).toMatchObject([
        { parentID: root, updatedAt: expect.any(Number) },
      ]);
      expect(recent.cursor).toBeUndefined();
      expect(
        await f.rpc.historyChildren(
          { parentID: root, limit: 1, updatedSince: Date.now() + 60_000 },
          signal(),
        ),
      ).toEqual({ sessions: [] });
      await expect(
        f.rpc.historyChildren(
          { parentID: f.root("r2d2"), limit: 1, cursor: first.cursor },
          signal(),
        ),
      ).rejects.toThrow(unavailable);
      expect(
        await f.rpc.historyChildren(
          { parentID: `${root}~18`, limit: 10 },
          signal(),
        ),
      ).toEqual({ sessions: [] });
      expect(f.reads).toEqual([]);
      expect(f.snapshot()).toEqual(before);
    } finally {
      await f.close();
    }
  },
  diskIntegrationTimeoutMs,
);

test("history RPC children cursors are exact string records", async () => {
  const f = await fixture();
  try {
    const root = f.root("twiki");
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const children = (cursor: string) =>
      f.rpc.historyChildren({ parentID: root, limit: 1, cursor }, signal());
    expect(
      (await children(encode({ parentID: root, after: "18" }))).sessions,
    ).toMatchObject([{ id: `${root}~19` }]);
    expect(
      (await children(encode({ parentID: root, after: "" }))).sessions,
    ).toMatchObject([{ id: `${root}~18` }]);
    for (const cursor of [
      encode({ parentID: root, after: "18", extra: true }),
      encode({ parentID: root, after: 18 }),
      encode({ parentID: root }),
      encode({ parentID: f.root("r2d2"), after: "18" }),
      encode([root, "18"]),
      encode(null),
      "not-json",
    ])
      await expect(children(cursor), cursor).rejects.toThrow(unavailable);
    expect(f.reads).toEqual([]);
  } finally {
    await f.close();
  }
});

test("history RPC reads only owned native conversations without state changes", async () => {
  const f = await fixture();
  try {
    const before = f.snapshot();
    for (const sessionID of [f.root("twiki"), `${f.root("twiki")}~18`]) {
      const page = await f.rpc.historyEntries(
        { sessionID, limit: 10, order: "desc", detail: "full" },
        signal(),
      );
      expect(page.entries[0]?.parts).toEqual([
        { type: "text", text: "retained" },
      ]);
    }
    expect(f.reads).toEqual([
      { member: "twiki", conversationID: "17" },
      { member: "twiki", conversationID: "18" },
    ]);
    expect(f.snapshot()).toEqual(before);
  } finally {
    await f.close();
  }
});

test("history RPC abort uses fixed errors and never reads state or transcripts", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort(new Error("private reason"));
  try {
    const before = f.snapshot();
    await expect(f.rpc.historyRoots(controller.signal)).rejects.toThrow(
      unavailable,
    );
    await expect(
      f.rpc.historyDescribe([f.root("twiki")], controller.signal),
    ).rejects.toThrow(unavailable);
    await expect(
      f.rpc.historyChildren(
        { parentID: f.root("twiki"), limit: 10 },
        controller.signal,
      ),
    ).rejects.toThrow(unavailable);
    await expect(
      f.rpc.historyEntries(
        { sessionID: f.root("twiki"), limit: 10, order: "asc", detail: "full" },
        controller.signal,
      ),
    ).rejects.toThrow(unavailable);
    expect(f.reads).toEqual([]);
    expect(f.snapshot()).toEqual(before);
  } finally {
    await f.close();
  }
});

test("Pi history reuses the shared live pool and never opens a second runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-live-history-"));
  const state = await CrewState.open(directory, "history-pool", "identity");
  const member: CrewMember = {
    id: "twiki",
    role: "Maintenance",
    permissionProfile: "coding",
    backend: {
      type: "pi-durable",
      model: "openai/test",
      tools: "none",
      systemPrompt: "",
    },
  };
  let opens = 0;
  let creates = 0;
  let prompts = 0;
  let closes = 0;
  const history: SessionHistory = {
    async roots() {
      return [];
    },
    async describe() {
      return [];
    },
    async children() {
      return { sessions: [] };
    },
    async entries() {
      return { entries: [] };
    },
  };
  const factory: PiWorkerFactory = async () => {
    opens++;
    return {
      history,
      async createSession() {
        creates++;
        return "17";
      },
      async prompt() {
        prompts++;
        throw new Error("History must never prompt");
      },
      async close() {
        closes++;
      },
    };
  };
  const owner = new PiCrewWorkers(state, directory, factory);
  const viewer = new PiCrewWorkers(state, directory, async () => {
    throw new Error("Must reuse live backend");
  });
  try {
    const peer = state.reservePeer(member.id);
    await owner.ensure(member, directory, peer, signal());
    expect(
      await viewer.readHistory(
        member,
        signal(),
        async (value) => value === history,
      ),
    ).toBe(true);
    expect(opens).toBe(1);
    expect(creates).toBe(1);
    expect(prompts).toBe(0);
    await owner.close();
    expect(closes).toBe(0);
    await viewer.close();
    expect(closes).toBe(1);
  } finally {
    await owner.close();
    await viewer.close();
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Pi history owner shutdown cancels active reads without interrupting work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-history-cancel-"));
  const state = await CrewState.open(directory, "history-cancel", "identity");
  const member = Schema.decodeUnknownSync(teamSchema)({
    captain: { id: "captain" },
    crew: [
      {
        id: "twiki",
        role: "Maintenance",
        permissionProfile: "coding",
        backend: { type: "pi-durable", model: "openai/test" },
      },
    ],
  }).crew[0];
  if (!member) throw new Error("Missing member");
  let interrupts = 0;
  const history: SessionHistory = {
    async roots() {
      return [];
    },
    async describe() {
      return [];
    },
    async children() {
      return { sessions: [] };
    },
    async entries() {
      return { entries: [] };
    },
  };
  const workers = new PiCrewWorkers(state, directory, async () => ({
    history,
    async createSession() {
      return "17";
    },
    async prompt() {
      throw new Error("Must not prompt");
    },
    async interrupt() {
      interrupts++;
    },
    async close() {},
  }));
  try {
    await workers.ensure(
      member,
      directory,
      state.reservePeer(member.id),
      signal(),
    );
    const entered = Promise.withResolvers<AbortSignal>();
    const reading = workers.readHistory(
      member,
      signal(),
      async (_history, call) => {
        entered.resolve(call);
        await new Promise<void>((_resolve, reject) => {
          call.addEventListener(
            "abort",
            () => reject(new Error("private cancellation")),
            { once: true },
          );
        });
      },
    );
    const outcome = reading.catch((error: unknown) => error);
    const call = await entered.promise;
    await workers.close();
    expect(await outcome).toBeInstanceOf(CrewError);
    expect(await outcome).toMatchObject({ message: unavailable });
    expect(call.aborted).toBe(true);
    expect(interrupts).toBe(0);
  } finally {
    await workers.close();
    state.close();
    await rm(directory, { recursive: true, force: true });
  }
});
