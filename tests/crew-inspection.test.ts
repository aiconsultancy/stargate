import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type CrewCaller,
  CrewEngine,
  type CrewOptions,
  type CrewSession,
  type CrewSessions,
  crewInputSchema,
} from "../src/crew/engine";
import {
  InspectionDenied,
  inspectionGrantLifetimeMs,
} from "../src/crew/inspection-grants";
import type { PiCrewBinding } from "../src/crew/pi-extension";
import type { PiWorkerFactory } from "../src/crew/pi-worker";
import { CrewProjects } from "../src/crew/projects";
import type { CrewInspectionAPI } from "../src/crew/reconciliation";
import { protectedCrewTool } from "../src/crew/tool";

const epoch = Date.UTC(2026, 10, 17);
const pin = "ses_captain";

async function fixture(pi = false, issuerProof = true) {
  const root =
    process.env["TMPDIR"] ?? join(homedir(), ".cache", "tmp", "opencode");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "stargate-inspection-"));
  const options: CrewOptions = {
    namespace: "pegasus",
    captainSessionID: pin,
    stateDirectory: join(directory, "state"),
    captainDirectory: join(directory, "captain"),
    projectDirectory: directory,
    worktrees: {
      worker: join(directory, "worker"),
      helper: join(directory, "helper"),
    },
    mesijCommand: "/unused",
    team: {
      captain: { id: "captain", agent: "pegasus-captain" },
      crew: [
        {
          id: "worker",
          agent: "pegasus-worker",
          role: "Rear Admiral / Commodore",
          permissionProfile: "coding",
          ...(pi
            ? {
                backend: {
                  type: "pi-durable" as const,
                  model: "openai/fake",
                  tools: "coding" as const,
                  systemPrompt: "Fixture worker",
                },
              }
            : {}),
        },
        { id: "helper", role: "Reviewer", permissionProfile: "coding" },
      ],
    },
  };
  const sessions = new Map<string, CrewSession>([
    [
      pin,
      {
        id: pin,
        agent: "pegasus-captain",
        location: { directory: options.captainDirectory },
      },
    ],
    [
      "ses_foreign",
      {
        id: "ses_foreign",
        agent: "pegasus-captain",
        location: { directory: options.captainDirectory },
      },
    ],
  ]);
  const mutations: string[] = [];
  let now = epoch;
  let snapshot: () => Promise<void> = async () => {};
  let nativeReads = 0;
  let issuerAllowed = true;
  let piBinding: PiCrewBinding | undefined;
  const native: CrewSessions = {
    async get({ sessionID }) {
      const session = sessions.get(sessionID);
      if (!session) throw { _tag: "Session.NotFoundError" };
      return session;
    },
    async create(input) {
      if (!input.id || !input.agent || !input.location)
        throw new Error("Missing identity");
      const session = {
        id: input.id,
        agent: input.agent,
        location: input.location,
        metadata: input.metadata ?? {},
      };
      sessions.set(session.id, session);
      return session;
    },
    async prompt() {
      mutations.push("prompt");
      throw new Error("Unexpected prompt");
    },
    async synthetic() {
      mutations.push("synthetic");
    },
    async compact() {
      mutations.push("compact");
    },
    async interrupt() {
      mutations.push("interrupt");
    },
    async wait() {
      mutations.push("wait");
    },
  };
  const piFactory: PiWorkerFactory = async (_config, context) => {
    piBinding = context.crew;
    return {
      async createSession() {
        return "saved-conversation";
      },
      async prompt() {
        throw new Error("No Pi task scheduled by inspection");
      },
      async waitForIdle() {},
      async close() {},
    };
  };
  const api: CrewInspectionAPI = {
    session: {
      get: (input, request) => native.get(input, request),
      async active() {
        nativeReads++;
        await snapshot();
        return Object.fromEntries(
          [...sessions.keys()].map((id) => [id, { type: "busy" }]),
        );
      },
      inbox: { list: async () => [] },
      form: { list: async () => [] },
    },
    permission: { list: async () => [] },
    message: {
      async list() {
        throw new Error("Inspection must not read prompts/results");
      },
    },
  };
  let engine: CrewEngine;
  const open = async (override: Partial<CrewOptions> = {}) => {
    engine = await CrewEngine.open(
      { ...options, ...override },
      native,
      {
        async register() {
          mutations.push("mail-register");
          return { id: "0".repeat(32), sequence: 0 };
        },
        async send() {
          mutations.push("mail");
          return { id: "1".repeat(32), sequence: 1 };
        },
        async inbox() {
          mutations.push("inbox");
          return [];
        },
      },
      undefined,
      piFactory,
      async (anchor) => {
        expect(["helper", "pegasus-captain"]).toContain(anchor.agent ?? "");
        return api;
      },
      undefined,
      { inspectionNow: () => now },
      // Fake owner-only read-only evaluator. The real SDK has no equivalent;
      // production must fail closed rather than assert as a foreign captain.
      issuerProof
        ? async (issuer, signal) => {
            signal.throwIfAborted();
            expect(issuer).toBe(pin);
            if (!issuerAllowed) throw new InspectionDenied("native-denied");
          }
        : undefined,
    );
    return engine;
  };
  await open();
  const caller = (sessionID: string, agent: string): CrewCaller => ({
    sessionID,
    agent,
    signal: new AbortController().signal,
    inspectionPermission: async () => {},
  });
  const captain = caller(pin, "pegasus-captain");
  const makeTask = async (crew: string, issuer = pin) => {
    await engine.run({ op: "ensure", crew }, captain);
    const peer = engine.state.peer(crew);
    if (!peer) throw new Error("Missing peer");
    const task = engine.state.reserveTask(peer, issuer, "PRIVATE TASK PROMPT");
    if (!task) throw new Error("Missing task");
    engine.state.running(task.id);
    return engine.state.task(task.id) ?? task;
  };
  const workerTask = await makeTask("worker");
  const targetTask = await makeTask("helper");
  const worker = caller(workerTask.workerSessionID, "pegasus-worker");
  const request = () => ({
    op: "grant-inspect",
    crew: "worker",
    taskID: workerTask.id,
    resource: { crew: "helper", taskID: targetTask.id },
    expiresAt: new Date(now + 60_000).toISOString(),
    key: "grant-1",
  });
  const issue = async (input = request()) => {
    const result = await engine.run(input, captain);
    if (!result.grant) throw new Error("Missing grant");
    return result.grant;
  };
  const inspect = (grantID: string, actor = worker) =>
    engine.run(
      { op: "inspect", crew: "helper", taskID: targetTask.id, grantID },
      actor,
    );
  return {
    get engine() {
      return engine;
    },
    options,
    native,
    sessions,
    captain,
    worker,
    workerTask,
    targetTask,
    request,
    issue,
    inspect,
    makeTask,
    mutations,
    caller,
    get piBinding() {
      return piBinding;
    },
    get reads() {
      return nativeReads;
    },
    denyIssuer() {
      issuerAllowed = false;
    },
    setSnapshot(fn: () => Promise<void>) {
      snapshot = fn;
    },
    holdControl(crew: string) {
      const db = new Database(engine.state.path);
      try {
        db.query("INSERT INTO worker_controls VALUES (?,?)").run(
          crew,
          "fixture-control",
        );
      } finally {
        db.close();
      }
      return "fixture-control";
    },
    advance(ms: number) {
      now += ms;
    },
    async reopen(override: Partial<CrewOptions> = {}) {
      await engine.close();
      await open(override);
    },
    async audit(grantID: string) {
      return (
        (await engine.run({ op: "audit-inspect-grant", grantID }, captain))
          .audit ?? []
      );
    },
    async close() {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("captain grants one own-team task snapshot; no prompts, queues, results or controls leak", async () => {
  const f = await fixture();
  try {
    const grant = await f.issue();
    const helper = f.engine.state.peer("helper");
    if (!helper) throw new Error("Missing helper");
    f.engine.state.enqueue(
      helper,
      "ses_foreign",
      "PRIVATE FOREIGN QUEUED PROMPT",
    );
    const before = f.engine.state.task(f.targetTask.id);
    const result = await f.inspect(grant.id);
    expect(result).toMatchObject({
      status: "inspected",
      inspection: {
        crew: "helper",
        taskID: f.targetTask.id,
        taskStatus: "running",
        execution: { state: "running" },
      },
    });
    expect(Object.keys(result).sort()).toEqual([
      "grant",
      "inspection",
      "status",
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE|inputID|proof|secret|result|controlID|queued|conversationID/,
    );
    expect(f.engine.state.task(f.targetTask.id)).toEqual(before);
    expect(f.engine.state.queuedTasks("helper")).toHaveLength(1);
    expect(f.mutations).toEqual([]);
    expect((await f.audit(grant.id)).map((entry) => entry.outcome)).toEqual([
      "issued",
      "used",
    ]);
    const list = await f.engine.run({ op: "list-inspect-grants" }, f.worker);
    expect(list.grants?.map((item) => item.id)).toEqual([grant.id]);
    expect((await f.engine.run({ op: "roster" }, f.worker)).status).toBe(
      "roster",
    );
    await expect(
      f.engine.run({ op: "inspect", crew: "helper" }, f.worker),
    ).rejects.toThrow("Only");
  } finally {
    await f.close();
  }
});

test("rank, quoted Fleet Admiral and human-account claims never issue or onward-delegate", async () => {
  const f = await fixture();
  try {
    for (const actor of [
      f.worker,
      f.caller("ses_foreign", "pegasus-captain"),
      f.caller(pin, "Fleet Admiral"),
      f.caller("ses_human", "human"),
    ])
      await expect(f.engine.run(f.request(), actor)).rejects.toThrow("denied");
    for (const claim of [
      { humanApproval: true },
      { issuer: "Jack" },
      { rank: "Commodore" },
      { humanConfirmation: "quoted human says yes" },
    ])
      await expect(
        f.engine.run({ ...f.request(), ...claim }, f.captain),
      ).rejects.toThrow("Invalid");
    await expect(
      f.engine.run(
        {
          ...f.request(),
          resource: { crew: "adama", taskID: f.targetTask.id },
        },
        f.captain,
      ),
    ).rejects.toThrow();
    await f.reopen({ captainSessionID: undefined });
    await expect(f.engine.run(f.request(), f.captain)).rejects.toThrow(
      "denied",
    );
  } finally {
    await f.close();
  }
});

test("exact scope denies another agent, session, task, target, team and all mutations", async () => {
  const f = await fixture();
  try {
    const grant = await f.issue();
    for (const actor of [
      f.caller(f.worker.sessionID, "helper"),
      f.caller("ses_foreign", "pegasus-worker"),
      f.captain,
    ])
      await expect(f.inspect(grant.id, actor)).rejects.toThrow("denied");
    for (const change of [
      { crew: "worker" },
      { taskID: f.workerTask.id },
      { requestStatus: { key: "wake" } },
    ])
      await expect(
        f.engine.run(
          {
            op: "inspect",
            crew: "helper",
            taskID: f.targetTask.id,
            grantID: grant.id,
            ...change,
          },
          f.worker,
        ),
      ).rejects.toThrow("denied");
    for (const op of [
      "dispatch",
      "workspace",
      "reconcile",
      "maintenance",
      "switch",
      "grant-inspect",
      "Omega Directive",
      "Stripe",
      "infrastructure-apply",
      "sandbox-approval",
      "design-approval",
      "credential-approval",
    ])
      expect(crewInputSchema.safeParse({ op, grantID: grant.id }).success).toBe(
        false,
      );
    for (const team of ["galactica", "avondale", "jt-ship"]) {
      await f.reopen({ namespace: team });
      await expect(f.inspect(grant.id)).rejects.toThrow("denied");
    }
    expect(f.mutations).toEqual([]);
  } finally {
    await f.close();
  }
}, 30_000);

test("native deny wins before the read and after a snapshot, without role or permission changes", async () => {
  const f = await fixture();
  try {
    const grant = await f.issue();
    const actor = {
      ...f.worker,
      inspectionPermission: async () => {
        throw new Error("PRIVATE NATIVE DENY");
      },
    };
    await expect(f.inspect(grant.id, actor)).rejects.toThrow("native-denied");
    expect(f.reads).toBe(0);
    let denied = false;
    f.setSnapshot(async () => {
      denied = true;
    });
    await expect(
      f.inspect(grant.id, {
        ...f.worker,
        inspectionPermission: async () => {
          if (denied) throw new Error("deny");
        },
      }),
    ).rejects.toThrow("native-denied");
    expect(f.reads).toBe(1);
    expect(f.mutations).toEqual([]);
    expect(
      (await f.audit(grant.id)).filter((entry) => entry.outcome === "used"),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

test("normal protected crew tool retains native deny and emits a scoped denial audit", async () => {
  const f = await fixture();
  try {
    const grant = await f.issue();
    const projects = await CrewProjects.open(f.options, async () => f.engine);
    const input = {
      op: "inspect",
      crew: "helper",
      taskID: f.targetTask.id,
      grantID: grant.id,
    };
    await expect(
      protectedCrewTool(projects, input, f.worker, async () => {
        throw new Error("Native deny");
      }),
    ).rejects.toThrow("Native deny");
    expect(f.reads).toBe(0);
    expect((await f.audit(grant.id)).at(-1)).toMatchObject({
      outcome: "denied",
      operation: "inspect",
      reason: "native-denied",
      recipient: f.worker.sessionID,
    });
    const result = await protectedCrewTool(
      projects,
      input,
      f.worker,
      async () => {},
    );
    expect(JSON.parse(result.content)).toMatchObject({ status: "inspected" });
    let deny = false;
    f.setSnapshot(async () => {
      deny = true;
    });
    await expect(
      protectedCrewTool(projects, input, f.worker, async () => {
        if (deny) throw new Error("Native deny");
      }),
    ).rejects.toThrow("native-denied");
    const native = f.sessions.get(f.worker.sessionID);
    if (!native) throw new Error("Missing worker identity");
    native.agent = "foreign-agent";
    await expect(
      protectedCrewTool(projects, input, f.worker, async () => {}),
    ).rejects.toThrow("identity changed");
    native.agent = "pegasus-worker";
    expect((await f.audit(grant.id)).at(-1)).toMatchObject({
      reason: "identity",
      outcome: "denied",
    });
    expect(f.mutations).toEqual([]);
  } finally {
    await f.close();
  }
});

test("explicit expiry has a conservative ceiling and never renews a replay", async () => {
  const f = await fixture();
  try {
    for (const delta of [0, -1, inspectionGrantLifetimeMs + 1])
      await expect(
        f.issue({
          ...f.request(),
          expiresAt: new Date(epoch + delta).toISOString(),
        }),
      ).rejects.toThrow("lifetime");
    const input = {
      ...f.request(),
      expiresAt: new Date(epoch + inspectionGrantLifetimeMs).toISOString(),
    };
    const grant = await f.issue(input);
    f.advance(inspectionGrantLifetimeMs);
    await expect(f.inspect(grant.id)).rejects.toThrow("expired");
    expect(await f.issue(input)).toEqual(grant);
    await expect(
      f.issue({
        ...input,
        expiresAt: new Date(
          epoch + inspectionGrantLifetimeMs + 1,
        ).toISOString(),
      }),
    ).rejects.toThrow("replay");
    expect((await f.audit(grant.id)).at(-1)?.outcome).toBe("expired");
  } finally {
    await f.close();
  }
});

test("revocation persists across reopen; idempotent lifecycle arguments cannot select another grant", async () => {
  const f = await fixture();
  try {
    const input = f.request();
    const grant = await f.issue(input);
    expect(await f.issue(input)).toEqual(grant);
    await expect(
      f.issue({
        ...input,
        resource: { crew: "worker", taskID: f.workerTask.id },
      }),
    ).rejects.toThrow("replay");
    const other = await f.issue({ ...input, key: "grant-2" });
    const revoke = { op: "revoke-inspect", grantID: grant.id, key: "revoke-1" };
    await expect(f.engine.run(revoke, f.worker)).rejects.toThrow("denied");
    const revoked = await f.engine.run(revoke, f.captain);
    f.advance(1);
    expect(await f.engine.run(revoke, f.captain)).toEqual(revoked);
    await expect(
      f.engine.run({ ...revoke, grantID: other.id }, f.captain),
    ).rejects.toThrow("replay");
    await f.reopen();
    await expect(f.inspect(grant.id)).rejects.toThrow("revoked");
    expect((await f.issue(input)).revokedAt).not.toBeNull();
    await expect(f.inspect(other.id)).resolves.toMatchObject({
      status: "inspected",
    });
    expect(
      (await f.audit(grant.id)).filter((event) => event.outcome === "issued"),
    ).toHaveLength(1);
    const db = new Database(f.engine.state.path);
    try {
      db.query("UPDATE inspection_grants SET revokedAt=NULL WHERE id=?").run(
        grant.id,
      );
      expect(() => f.engine.state.inspectionGrants.get(grant.id)).toThrow(
        "proof",
      );
      await expect(f.inspect(grant.id)).rejects.toThrow("identity");
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test("HMAC rejects changed scope, expiry, handle and stale proofs; key/proof never enter public audits", async () => {
  const f = await fixture();
  try {
    const grant = await f.issue();
    const db = new Database(f.engine.state.path);
    try {
      const saved = db
        .query<{ payload: string; proof: string }, [string]>(
          "SELECT payload,proof FROM inspection_grants WHERE id=?",
        )
        .get(grant.id);
      if (!saved) throw new Error("Missing grant");
      for (const payload of [
        saved.payload.replace("helper", "worker"),
        saved.payload.replace(String(epoch + 60_000), String(epoch + 120_000)),
      ]) {
        db.query("UPDATE inspection_grants SET payload=? WHERE id=?").run(
          payload,
          grant.id,
        );
        expect(() => f.engine.state.inspectionGrants.get(grant.id)).toThrow(
          "proof",
        );
        await expect(f.inspect(grant.id)).rejects.toThrow("identity");
      }
      db.query("UPDATE inspection_grants SET payload=?,proof=? WHERE id=?").run(
        saved.payload,
        "0".repeat(64),
        grant.id,
      );
      expect(() => f.engine.state.inspectionGrants.get(grant.id)).toThrow(
        "proof",
      );
      await expect(f.inspect(grant.id)).rejects.toThrow("identity");
      db.query("UPDATE inspection_grants SET proof=? WHERE id=?").run(
        saved.proof,
        grant.id,
      );
      const other = await f.issue({ ...f.request(), key: "other-proof" });
      const stale = db
        .query<{ proof: string }, [string]>(
          "SELECT proof FROM inspection_grants WHERE id=?",
        )
        .get(other.id);
      if (!stale) throw new Error("Missing second proof");
      db.query("UPDATE inspection_grants SET proof=? WHERE id=?").run(
        stale.proof,
        grant.id,
      );
      expect(() => f.engine.state.inspectionGrants.get(grant.id)).toThrow(
        "proof",
      );
      await expect(f.inspect(grant.id)).rejects.toThrow("identity");
      db.query("UPDATE inspection_grants SET proof=? WHERE id=?").run(
        saved.proof,
        grant.id,
      );
      await expect(f.inspect(`inspect_${"f".repeat(32)}`)).rejects.toThrow(
        "identity",
      );
      const text = JSON.stringify(await f.audit(grant.id));
      const secret = db
        .query<{ secret: string }, []>(
          "SELECT secret FROM inspection_authority",
        )
        .get()?.secret;
      expect(text).not.toContain(saved.proof);
      expect(text).not.toContain(secret ?? "MISSING SECRET");
      expect(text).not.toMatch(/PRIVATE|PROMPT|payload|proof|secret/);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test("recipient and target task ends, reassignment, foreign ownership and controllers invalidate use", async () => {
  for (const side of ["worker", "helper"]) {
    const f = await fixture();
    try {
      const grant = await f.issue();
      const token = f.holdControl(side);
      await expect(f.inspect(grant.id)).rejects.toThrow("controller");
      expect(f.engine.state.controlled(side)).toBe(true);
      f.engine.state.releaseControl(side, token);
      const task = side === "worker" ? f.workerTask : f.targetTask;
      f.engine.state.complete(task.id, task.workerSessionID, "PRIVATE RESULT");
      await expect(f.inspect(grant.id)).rejects.toThrow("task");
      const db = new Database(f.engine.state.path);
      db.query("UPDATE tasks SET released=1 WHERE id=?").run(task.id);
      db.close();
      await f.makeTask(side);
      await expect(f.inspect(grant.id)).rejects.toThrow("task");
      expect(f.mutations).toEqual([]);
    } finally {
      await f.close();
    }
  }
  const f = await fixture();
  try {
    const grant = await f.issue();
    const db = new Database(f.engine.state.path);
    db.query("UPDATE tasks SET originCaptainID='ses_foreign' WHERE id=?").run(
      f.targetTask.id,
    );
    db.close();
    await expect(f.inspect(grant.id)).rejects.toThrow("task");
    await expect(f.issue({ ...f.request(), key: "foreign" })).rejects.toThrow(
      "task",
    );
  } finally {
    await f.close();
  }
}, 30_000);

test("changed captain pin and lost persisted proof custody fail closed without reissue", async () => {
  const f = await fixture();
  try {
    const grant = await f.issue();
    await f.reopen({ captainSessionID: "ses_foreign" });
    await expect(f.inspect(grant.id)).rejects.toThrow("identity");
    const db = new Database(f.engine.state.path);
    try {
      db.exec("DELETE FROM inspection_authority");
    } finally {
      db.close();
    }
    await f.reopen();
    await expect(f.inspect(grant.id)).rejects.toThrow("proof");
    expect(f.mutations).toEqual([]);
  } finally {
    await f.close();
  }
});

test("revocation, expiry, issuer/recipient identity and controller changes during awaited snapshot release no data", async () => {
  for (const change of [
    "revoke",
    "expiry",
    "issuer",
    "recipient",
    "controller",
    "task",
  ] as const) {
    const f = await fixture();
    try {
      const grant = await f.issue();
      f.setSnapshot(async () => {
        if (change === "revoke")
          await f.engine.run(
            { op: "revoke-inspect", grantID: grant.id, key: "during-read" },
            f.captain,
          );
        if (change === "expiry") f.advance(60_000);
        if (change === "controller") f.holdControl("helper");
        if (change === "task")
          f.engine.state.complete(
            f.workerTask.id,
            f.workerTask.workerSessionID,
            "PRIVATE END",
          );
        if (change === "issuer" || change === "recipient") {
          const native = f.sessions.get(
            change === "issuer" ? pin : f.worker.sessionID,
          );
          if (!native) throw new Error("Missing session");
          native.agent = "foreign-agent";
        }
      });
      await expect(f.inspect(grant.id)).rejects.toThrow("denied");
      expect(f.reads).toBe(1);
      // Restoring the issuer here permits only the scoped audit, never the read.
      const captain = f.sessions.get(pin);
      if (captain) captain.agent = "pegasus-captain";
      expect(
        (await f.audit(grant.id)).some((event) => event.outcome === "used"),
      ).toBe(false);
      expect(f.mutations).toEqual([]);
    } finally {
      await f.close();
    }
  }
}, 30_000);

test("audit/list pages are scoped, bounded and contain no queued prompt or private result", async () => {
  const f = await fixture();
  try {
    const grant = await f.issue();
    await f.inspect(grant.id);
    await f.inspect(grant.id);
    const first = await f.engine.run(
      { op: "audit-inspect-grant", grantID: grant.id, limit: 1 },
      f.worker,
    );
    const second = await f.engine.run(
      {
        op: "audit-inspect-grant",
        grantID: grant.id,
        after: first.nextAfter,
        limit: 1,
      },
      f.worker,
    );
    expect(first.audit).toHaveLength(1);
    expect(second.audit).toHaveLength(1);
    expect(second.audit?.[0]?.id).toBeGreaterThan(first.audit?.[0]?.id ?? 0);
    const helper = f.caller(f.targetTask.workerSessionID, "helper");
    await expect(
      f.engine.run({ op: "audit-inspect-grant", grantID: grant.id }, helper),
    ).rejects.toThrow("denied");
    expect(
      (await f.engine.run({ op: "list-inspect-grants" }, helper)).grants,
    ).toEqual([]);
    expect(
      crewInputSchema.safeParse({
        op: "audit-inspect-grant",
        grantID: grant.id,
        limit: 51,
      }).success,
    ).toBe(false);
    expect(f.mutations).toEqual([]);
  } finally {
    await f.close();
  }
});

test("coding-enabled Pi uses saved host conversation identity, never OpenCode or captain impersonation", async () => {
  const f = await fixture(true);
  try {
    const grant = await f.issue();
    await expect(f.inspect(grant.id)).rejects.toThrow("denied");
    const binding = f.piBinding;
    if (!binding) throw new Error("Missing native binding");
    const input = {
      op: "inspect",
      crew: "helper",
      taskID: f.targetTask.id,
      grantID: grant.id,
    };
    expect(
      await binding.run(
        "stargate_crew",
        input,
        "saved-conversation",
        "pi-call",
        new AbortController().signal,
      ),
    ).toMatchObject({ status: "inspected" });
    await expect(
      binding.run(
        "stargate_crew",
        input,
        "foreign-conversation",
        "pi-call",
        new AbortController().signal,
      ),
    ).rejects.toThrow("saved conversation");
    expect(f.mutations).toEqual([]);
  } finally {
    await f.close();
  }
});

test("supported CrewState expansion retains old/new grants, audits and revocation without extending old scope", async () => {
  const f = await fixture();
  try {
    const old = await f.issue();
    await f.inspect(old.id);
    const team = f.options.team;
    if (!team) throw new Error("Missing team");
    const expanded = {
      allowCrewExpansion: true,
      team: {
        ...team,
        crew: [
          ...team.crew,
          {
            id: "newcomer",
            role: "Builder",
            permissionProfile: "coding" as const,
          },
        ],
      },
      worktrees: {
        ...f.options.worktrees,
        newcomer: join(f.options.projectDirectory, "newcomer"),
      },
    };
    await f.reopen(expanded);
    expect(
      (
        await f.engine.run({ op: "list-inspect-grants" }, f.captain)
      ).grants?.map((grant) => grant.id),
    ).toEqual([old.id]);
    expect((await f.audit(old.id)).map((event) => event.outcome)).toEqual([
      "issued",
      "used",
    ]);
    await expect(f.inspect(old.id)).resolves.toMatchObject({
      status: "inspected",
    });
    const task = await f.makeTask("newcomer");
    const issued = await f.issue({
      ...f.request(),
      crew: "newcomer",
      taskID: task.id,
      key: "after-expansion",
    });
    await expect(
      f.engine.run(
        { op: "inspect", crew: "newcomer", taskID: task.id, grantID: old.id },
        f.worker,
      ),
    ).rejects.toThrow("scope");
    await expect(f.inspect(issued.id, f.worker)).rejects.toThrow("identity");
    await expect(
      f.inspect(issued.id, f.caller(task.workerSessionID, "newcomer")),
    ).resolves.toMatchObject({ status: "inspected" });
    await f.reopen({ ...expanded, allowCrewExpansion: false });
    expect(
      (
        await f.engine.run({ op: "list-inspect-grants" }, f.captain)
      ).grants?.map((grant) => grant.id),
    ).toEqual([old.id, issued.id]);
    expect((await f.audit(issued.id)).map((event) => event.outcome)).toEqual([
      "issued",
      "denied",
      "used",
    ]);
    for (const grant of [old, issued]) {
      await f.engine.run(
        { op: "revoke-inspect", grantID: grant.id, key: `revoke-${grant.id}` },
        f.captain,
      );
      expect((await f.audit(grant.id)).at(-1)?.outcome).toBe("revoked");
    }
    await expect(f.inspect(old.id)).rejects.toThrow("revoked");
    expect(f.engine.state.task(f.workerTask.id)?.workerSessionID).toBe(
      f.worker.sessionID,
    );
  } finally {
    await f.close();
  }
}, 30_000);

test("issuance intersects current caller grant-inspect and inspect permissions before creating authority", async () => {
  const f = await fixture();
  try {
    const projects = await CrewProjects.open(f.options, async () => f.engine);
    const checked: string[] = [];
    await expect(
      protectedCrewTool(projects, f.request(), f.captain, async (resource) => {
        checked.push(resource);
        if (resource === "inspect") throw new Error("Denied inspect");
      }),
    ).rejects.toThrow("native-denied");
    expect(checked).toEqual(["grant-inspect", "grant-inspect", "inspect"]);
    expect(
      (await f.engine.run({ op: "list-inspect-grants" }, f.captain)).grants,
    ).toEqual([]);
    expect(f.reads).toBe(0);
    const initial: string[] = [];
    await expect(
      protectedCrewTool(projects, f.request(), f.captain, async (resource) => {
        initial.push(resource);
        throw new Error("Deny initial resource");
      }),
    ).rejects.toThrow("Deny initial");
    expect(initial).toEqual(["grant-inspect"]);
  } finally {
    await f.close();
  }
});

test("unverifiable issuer authority fails closed; trusted read-only proof removal during snapshot denies release", async () => {
  const unsupported = await fixture(false, false);
  try {
    const grant = await unsupported.issue();
    await expect(unsupported.inspect(grant.id)).rejects.toThrow("unavailable");
    expect(unsupported.reads).toBe(0);
    expect((await unsupported.audit(grant.id)).at(-1)?.reason).toBe(
      "unavailable",
    );
  } finally {
    await unsupported.close();
  }
  const f = await fixture();
  try {
    const grant = await f.issue();
    f.setSnapshot(async () => {
      f.denyIssuer();
    });
    await expect(f.inspect(grant.id)).rejects.toThrow("native-denied");
    expect(f.reads).toBe(1);
    expect(
      (await f.audit(grant.id)).some((event) => event.outcome === "used"),
    ).toBe(false);
    await expect(f.inspect(grant.id)).rejects.toThrow("native-denied");
    expect(f.reads).toBe(1);
  } finally {
    await f.close();
  }
});

test("missing or malformed custody disables delegation alone and preserves ordinary recovery reads and audit rows", async () => {
  for (const malformed of [false, true]) {
    const f = await fixture();
    try {
      const grant = await f.issue();
      await f.inspect(grant.id);
      const before = await f.audit(grant.id);
      const db = new Database(f.engine.state.path);
      try {
        if (malformed)
          db.exec("UPDATE inspection_authority SET secret='invalid-key'");
        else db.exec("DELETE FROM inspection_authority");
      } finally {
        db.close();
      }
      await f.reopen();
      expect((await f.engine.run({ op: "roster" }, f.captain)).status).toBe(
        "roster",
      );
      expect(
        (
          await f.engine.run(
            { op: "status", taskID: f.workerTask.id },
            f.worker,
          )
        ).status,
      ).toBe("running");
      expect(
        await f.engine.run({ op: "inspect", crew: "helper" }, f.captain),
      ).toMatchObject({ status: "inspected", execution: { state: "running" } });
      for (const input of [
        f.request(),
        { op: "list-inspect-grants" },
        { op: "audit-inspect-grant", grantID: grant.id },
        { op: "revoke-inspect", grantID: grant.id, key: "unavailable-key" },
      ])
        await expect(f.engine.run(input, f.captain)).rejects.toThrow("proof");
      await expect(f.inspect(grant.id)).rejects.toThrow("proof");
      const retained = new Database(f.engine.state.path);
      try {
        expect(
          retained
            .query("SELECT * FROM inspection_audit WHERE grantID=? ORDER BY id")
            .all(grant.id),
        ).toEqual(before);
        expect(
          retained.query("SELECT id FROM inspection_grants").all(),
        ).toEqual([{ id: grant.id }]);
        expect(
          retained
            .query<{ secret: string }, []>(
              "SELECT secret FROM inspection_authority",
            )
            .get()?.secret ?? null,
        ).toBe(malformed ? "invalid-key" : null);
      } finally {
        retained.close();
      }
    } finally {
      await f.close();
    }
  }
}, 30_000);

test("OpenCode delegation needs host-native permission callback; verified coding Pi retains callback-free path", async () => {
  const f = await fixture();
  try {
    const grant = await f.issue();
    for (const actor of [f.worker, f.captain]) {
      const raw = {
        sessionID: actor.sessionID,
        agent: actor.agent,
        signal: actor.signal,
      };
      await expect(
        f.engine.run({ op: "list-inspect-grants" }, raw),
      ).rejects.toThrow("native-denied");
    }
    await expect(
      f.inspect(grant.id, {
        sessionID: f.worker.sessionID,
        agent: f.worker.agent,
        signal: f.worker.signal,
      }),
    ).rejects.toThrow("native-denied");
    expect(f.reads).toBe(0);
  } finally {
    await f.close();
  }
  // The existing Pi regression invokes the real host binding without a callback.
});

test("wrong recipient cannot distinguish known revoked, expired or out-of-scope handles from unknown", async () => {
  const f = await fixture();
  try {
    const grant = await f.issue();
    const foreign = f.caller(f.targetTask.workerSessionID, "helper");
    const read = (id: string) =>
      f.engine.run(
        {
          op: "inspect",
          crew: "worker",
          grantID: id,
          requestStatus: { key: "forbidden" },
        },
        foreign,
      );
    for (const state of ["live", "expired", "revoked"]) {
      if (state === "expired") f.advance(60_000);
      if (state === "revoked")
        await f.engine.run(
          { op: "revoke-inspect", grantID: grant.id, key: "opaque" },
          f.captain,
        );
      await expect(read(grant.id)).rejects.toThrow("(identity)");
      await expect(read(`inspect_${"f".repeat(32)}`)).rejects.toThrow(
        "(identity)",
      );
    }
    expect(f.reads).toBe(0);
  } finally {
    await f.close();
  }
});

test("unexpected and cancelled reads retain distinct bounded audit reasons, not false identity failures", async () => {
  const f = await fixture();
  try {
    const grant = await f.issue();
    const signal = new AbortController();
    f.setSnapshot(async () => {
      signal.abort(new Error("PRIVATE CANCEL"));
    });
    await expect(
      f.inspect(grant.id, { ...f.worker, signal: signal.signal }),
    ).rejects.toThrow("cancelled");
    expect((await f.audit(grant.id)).at(-1)?.reason).toBe("cancelled");
    const original = f.native.get;
    f.native.get = async () => {
      throw new Error("PRIVATE OUTAGE");
    };
    await expect(f.inspect(grant.id)).rejects.toThrow("unavailable");
    f.native.get = original;
    const audit = await f.audit(grant.id);
    expect(audit.at(-1)?.reason).toBe("unavailable");
    expect(JSON.stringify(audit)).not.toMatch(/PRIVATE CANCEL|PRIVATE OUTAGE/);
  } finally {
    await f.close();
  }
});
