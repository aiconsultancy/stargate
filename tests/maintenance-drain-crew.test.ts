import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import {
  CrewEngine,
  type CrewOptions,
  type CrewSession,
  type CrewSessions,
} from "../src/crew/engine";
import type { MesijInbox, MesijMessage, MesijSend } from "../src/crew/mesij";
import { defaultTeam, type Team, teamSchema } from "../src/crew/team";
import type { MaintenanceDrain } from "../src/maintenance/maintenance-drain";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const piTeam = (): Team =>
  Schema.decodeUnknownSync(teamSchema)({
    ...defaultTeam,
    crew: [
      ...defaultTeam.crew,
      {
        id: "twiki",
        name: "Twiki",
        role: "Cleanup",
        permissionProfile: "coding",
        backend: {
          type: "pi-durable",
          model: "openai/opencode-go/deepseek-v4.1-flash",
          tools: "coding",
        },
      },
    ],
  });
const record = (extra: Partial<MaintenanceDrain> = {}): MaintenanceDrain => ({
  schema: "stargate.maintenance.drain.v1",
  runID: "run-1",
  pid: process.pid,
  job: "nightly",
  services: ["gateway"],
  startedAt: 1,
  deadlineAt: 2,
  phase: "draining",
  ...extra,
});

async function fixture(team: Team = defaultTeam, pin = false) {
  const directory = await mkdtemp(join(tmpdir(), "stargate-drain-crew-"));
  const options: CrewOptions = {
    namespace: "bowser-one",
    stateDirectory: directory,
    captainDirectory: join(directory, "captain"),
    projectDirectory: directory,
    worktrees: Object.fromEntries(
      team.crew.map(({ id }) => [id, join(directory, id)]),
    ),
    mesijCommand: "/usr/bin/mesij",
    ...(pin ? { captainSessionID: "ses_captaina" } : {}),
    team,
  };
  const sessions = new Map<string, CrewSession>(
    ["ses_captaina", "ses_captainb"].map((id) => [
      id,
      {
        id,
        agent: "bowser",
        location: { directory: options.captainDirectory },
      },
    ]),
  );
  const prompts: { sessionID: string; id?: string; text: string }[] = [];
  const busy = new Set<string>();
  let beforeIdle: (() => void) | undefined;
  const client: CrewSessions = {
    async list(input) {
      const data = [...sessions.values()];
      return input?.cursor
        ? { data: data.slice(1), cursor: {} }
        : { data: data.slice(0, 1), cursor: { next: "page-2" } };
    },
    async get({ sessionID }) {
      const session = sessions.get(sessionID);
      if (!session) throw { _tag: "Session.NotFoundError" };
      return session;
    },
    async create(input) {
      if (!input.id || !input.agent || !input.location)
        throw new Error("Invalid fixture create");
      const session = {
        id: input.id,
        agent: input.agent,
        location: input.location,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
      sessions.set(input.id, session);
      return session;
    },
    async prompt(input) {
      prompts.push({
        sessionID: input.sessionID,
        text: input.text,
        ...(input.id ? { id: input.id } : {}),
      });
      busy.add(input.sessionID);
      return { id: input.id ?? "msg", sessionID: input.sessionID };
    },
    async wait({ sessionID }, request) {
      beforeIdle?.();
      if (!busy.has(sessionID)) return;
      await new Promise<void>((_, reject) => {
        const signal = request?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    async interrupt() {},
    async compact() {},
    async synthetic(input) {
      return { id: input.id, sessionID: input.sessionID };
    },
  };
  const mail: MesijMessage[] = [];
  const keys = new Map<string, { id: string; sequence: number }>();
  const mailer = {
    async register() {
      return { id: "0".repeat(32), sequence: 0 };
    },
    async send(input: MesijSend) {
      const known = keys.get(input.key);
      if (known) return known;
      const sequence = mail.length + 1;
      const receipt = { id: String(sequence).padStart(32, "0"), sequence };
      mail.push({
        ...receipt,
        actor: input.actor,
        sessionID: input.sessionID,
        to: input.to,
        text: input.text,
        type: "message",
      });
      keys.set(input.key, receipt);
      return receipt;
    },
    async inbox(input: MesijInbox) {
      return mail.filter((m) => m.sequence > (input.after ?? 0));
    },
  };
  let drain: MaintenanceDrain | null = null;
  const engine = await CrewEngine.open(
    options,
    client,
    mailer,
    undefined,
    undefined,
    undefined,
    undefined,
    { drain: () => drain },
  );
  cleanup.push(async () => {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  });
  const captain = (sessionID = "ses_captaina") => ({
    sessionID,
    agent: "bowser",
    signal: new AbortController().signal,
    id: "captain-call",
  });
  return {
    engine,
    prompts,
    busy,
    mail,
    captain,
    sessions,
    setDrain(value: MaintenanceDrain | null) {
      drain = value;
    },
    setBeforeIdle(callback: () => void) {
      beforeIdle = callback;
    },
  };
}

test("a drain beginning during the native idle observation still queues the dispatch", async () => {
  const f = await fixture();
  await f.engine.run({ op: "ensure", crew: "mario" }, f.captain());
  f.setBeforeIdle(() => f.setDrain(record()));
  const result = await f.engine.run(
    { op: "dispatch", crew: "mario", text: "held during idle" },
    f.captain(),
  );
  expect(result.status).toBe("queued");
  expect(f.prompts).toHaveLength(0);
});

test("a drain queues dispatches regardless of the queue flag; resume starts only drain-queued tasks under their captain", async () => {
  const f = await fixture();
  const first = (
    await f.engine.run(
      { op: "dispatch", crew: "mario", text: "A" },
      f.captain(),
    )
  ).task;
  if (!first) throw new Error("Missing running task");
  const ordinary = (
    await f.engine.run(
      { op: "dispatch", crew: "mario", text: "B ordinary", queue: true },
      f.captain(),
    )
  ).task;
  expect(ordinary?.status).toBe("queued");
  expect(f.prompts).toHaveLength(1);

  f.setDrain(record());
  const held = await f.engine.run(
    { op: "dispatch", crew: "luigi", text: "C during drain" },
    f.captain("ses_captainb"),
  );
  expect(held.status).toBe("queued");
  expect(held.task?.status).toBe("queued");
  const heldBusy = await f.engine.run(
    { op: "dispatch", crew: "mario", text: "D during drain" },
    f.captain(),
  );
  expect(heldBusy.status).toBe("queued");
  // Nothing was reserved or prompted; status/wait cannot promote either.
  expect(f.prompts).toHaveLength(1);
  expect(f.engine.state.activeTask("luigi")).toBeNull();
  const status = await f.engine.run(
    { op: "status", taskID: held.task?.id ?? "" },
    f.captain("ses_captainb"),
  );
  expect(status.status).toBe("queued");
  expect(f.prompts).toHaveLength(1);
  // Resume refuses while the drain holds; nothing starts.
  expect(
    await f.engine.resumeMaintenance(new AbortController().signal),
  ).toEqual({ resumed: 0, remaining: 2 });

  f.setDrain(null);
  // Mario is still occupied by A: its drain task waits; luigi's starts.
  const resumed = await f.engine.resumeMaintenance(
    new AbortController().signal,
  );
  expect(resumed).toEqual({ resumed: 1, remaining: 1 });
  const started = f.engine.state.task(held.task?.id ?? "");
  expect(started).toMatchObject({
    status: "running",
    originCaptainID: "ses_captainb",
  });
  expect(f.prompts.map((p) => p.text.includes("C during drain"))).toEqual([
    false,
    true,
  ]);
  // The ordinary queued task is never advanced by the pump.
  expect(f.engine.state.task(ordinary?.id ?? "")?.status).toBe("queued");
  // An uncertain/active worker is not replayed or displaced.
  f.engine.state.uncertain(first.id);
  expect(
    await f.engine.resumeMaintenance(new AbortController().signal),
  ).toMatchObject({ resumed: 0, remaining: 1 });
  expect(f.prompts).toHaveLength(2);
});

test("idle direct messages are deferred during a drain, never waking a session", async () => {
  const f = await fixture();
  await f.engine.run({ op: "ensure", crew: "toad" }, f.captain());
  const before = f.prompts.length;
  f.setDrain(record());
  const receipt = await f.engine.dm(
    {
      op: "send",
      to: "toad",
      text: "ping",
      delivery: "steer",
    },
    f.captain(),
  );
  expect(receipt).toMatchObject({ stored: true, notification: "deferred" });
  expect(f.prompts).toHaveLength(before);
});

test("resumption leaves work queued when its original captain is no longer authorised", async () => {
  const f = await fixture();
  f.setDrain(record());
  const held = await f.engine.run(
    { op: "dispatch", crew: "mario", text: "retained assignment" },
    f.captain(),
  );
  f.setDrain(null);
  Object.assign(f.engine.options, { captainSessionID: "ses_captainb" });
  expect(
    await f.engine.resumeMaintenance(new AbortController().signal),
  ).toEqual({
    resumed: 0,
    remaining: 1,
  });
  expect(f.engine.state.task(held.task?.id ?? "")?.status).toBe("queued");
  expect(f.prompts).toHaveLength(0);
});

test("unpinned native captains receive passive context across every discovery page", async () => {
  const f = await fixture();
  f.sessions.set("ses_wrong", {
    id: "ses_wrong",
    agent: "bowser",
    location: { directory: "/elsewhere" },
  });
  f.sessions.set("ses_child", {
    id: "ses_child",
    parentID: "ses_captaina",
    agent: "bowser",
    location: f.sessions.get("ses_captaina")?.location ?? { directory: "" },
  });
  const receipts = await f.engine.maintenanceNotice(
    record(),
    new AbortController().signal,
  );
  expect(receipts.map((receipt) => receipt.sessionID)).toEqual([
    "ses_captaina",
    "ses_captainb",
  ]);
  for (const id of ["ses_captaina", "ses_captainb"]) {
    const system: { type: "text"; text: string }[] = [];
    f.engine.updateNoticeContext(id, "bowser", system);
    expect(system[0]?.text).toContain("draining");
  }
  expect(f.prompts).toHaveLength(0);
});

test("maintenance notices queue once per session and phase, supersede unread ones, and mail Pi crew", async () => {
  const f = await fixture(piTeam(), true);
  await f.engine.run({ op: "ensure", crew: "mario" }, f.captain());
  const signal = new AbortController().signal;
  const peer = f.engine.state.peer("mario");
  if (!peer) throw new Error("Missing peer");
  // Pi crew need a ready reservation only; no native session is created.
  f.engine.state.reservePeer("twiki");
  f.engine.state.readyPeer("twiki");
  const twiki = f.engine.state.peer("twiki");
  if (!twiki) throw new Error("Missing Pi peer");

  const first = await f.engine.maintenanceNotice(record(), signal);
  expect(first).toEqual(
    expect.arrayContaining([
      { sessionID: "ses_captaina", status: "queued" },
      { sessionID: peer.sessionID, status: "queued" },
      { sessionID: twiki.sessionID, status: "mail" },
    ]),
  );
  expect(f.mail).toHaveLength(1);
  expect(f.mail[0]?.text).toContain("run-1");
  // The restarting phase is the same notice; a second producer adds nothing.
  const repeat = await f.engine.maintenanceNotice(
    record({ phase: "restarting" }),
    signal,
  );
  expect(repeat.filter((r) => r.status === "queued")).toEqual([]);
  expect(f.mail).toHaveLength(1);

  const system: { type: "text"; text: string }[] = [];
  f.engine.updateNoticeContext(peer.sessionID, "mario", system);
  expect(system).toHaveLength(1);
  expect(system[0]?.text).toContain("draining");

  // Completion supersedes an unread draining notice for the pin.
  await f.engine.maintenanceNotice(record({ phase: "completed" }), signal);
  const pin: { type: "text"; text: string }[] = [];
  f.engine.updateNoticeContext("ses_captaina", "bowser", pin);
  expect(pin).toHaveLength(1);
  expect(pin[0]?.text).toContain("Restart complete");
  // The consumed notice is never re-queued by a repeat.
  await f.engine.maintenanceNotice(record({ phase: "completed" }), signal);
  f.engine.updateNoticeContext("ses_captaina", "bowser", pin);
  expect(pin).toHaveLength(1);
  // No notice prompted or provisioned anything.
  expect(f.prompts).toHaveLength(0);
});

test("bound OpenCode IRC crew sessions receive and consume passive drain context", async () => {
  const f = await fixture(defaultTeam, true);
  f.engine.state.ircSessions.bind("ses_irc_mario", "mario");
  const receipts = await f.engine.maintenanceNotice(
    record(),
    new AbortController().signal,
  );
  expect(receipts).toContainEqual({
    sessionID: "ses_irc_mario",
    status: "queued",
  });
  const system: { type: "text"; text: string }[] = [];
  f.engine.updateNoticeContext("ses_irc_mario", "mario", system);
  expect(system).toHaveLength(1);
});
