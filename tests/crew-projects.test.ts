import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin as EffectPlugin } from "@opencode/plugin/effect";
import { Agent, Session, SessionMessage } from "@opencode/schema";
import { Tool } from "@opencode/schema/tool";
import { Effect, Exit, Result, Schema, Scope } from "effect";
import { crewOpenCodeInput } from "../src/coordination/crew/input/crew-tool-input";
import {
  CrewEngine,
  type CrewOptions,
  type CrewSession,
  type CrewSessions,
} from "../src/coordination/crew/execution/engine";
import {
  crewGitSchema,
  fleetCrewStatusSchema,
} from "../src/coordination/crew/reporting/fleet-status";
import { createCrewGitReader } from "../src/coordination/crew/workspace/git-state";
import { liveFleetGit } from "../src/coordination/crew/workspace/git-status";
import { journalInputSchema } from "../src/coordination/crew/reporting/journal";
import type {
  MesijClient,
  MesijMessage,
} from "../src/coordination/crew/messaging/mesij";
import plugin from "../plugins/opencode/crew/plugin";
import {
  effectProjectKeySchema,
  effectProjectToolInput,
  projectsSchema,
} from "../src/coordination/crew/input/project-options";
import { CrewProjects } from "../src/coordination/crew/workspace/projects";
import { teamSchema } from "../src/coordination/crew/team";
import { crewStatusSchema } from "../src/shared/crew-status";
import { CronStore } from "../src/automation/cron/store";
import { dashboardSource } from "../src/observability/dashboard/dashboard-source";
import { openStore } from "../src/app/open-store";
import { bot, identity as dashboardIdentity } from "./fixtures";

const diskIntegrationTimeoutMs = 30_000;

async function git(directory: string, ...args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );

  const child = Bun.spawn(
    [
      "git",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      directory,
      ...args,
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );

  const [text, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (code) {
    throw new Error(`Local Git fixture failed: ${error}`);
  }

  return text.trim();
}

async function fixture(crewCount = 1) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "stargate-projects-")),
  );

  const captainDirectory = join(root, "captain");
  await mkdir(captainDirectory);

  const team = Schema.decodeUnknownSync(teamSchema)({
    captain: { id: "captain", agent: "build", model: "fixture/captain" },
    crew: Array.from({ length: crewCount }, (_, index) => ({
      id: index ? `worker${index + 1}` : "worker",
      agent: index ? `crew-worker${index + 1}` : "crew-worker",
      name: index ? `Worker${index + 1}` : "Worker",
      role: "Builder",
      permissionProfile: "coding",
      model: "fixture/worker",
    })),
  });

  const locations = new Map<
    string,
    { projectDirectory: string; worktrees: Record<string, string> }
  >();

  for (const project of ["default", "stargate"]) {
    const directory = join(root, project);
    await mkdir(directory);
    await git(directory, "init", "--initial-branch=main");
    await git(
      directory,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    );
    const worktrees: Record<string, string> = {};

    for (const member of team.crew) {
      const worker = join(root, `${member.id}-${project}`);
      await git(
        directory,
        "worktree",
        "add",
        "-b",
        `task/${project}/${member.id}`,
        worker,
        "main",
      );
      worktrees[member.id] = worker;
    }

    locations.set(project, {
      projectDirectory: directory,
      worktrees,
    });
  }

  const base: CrewOptions = {
    namespace: "project-test",
    stateDirectory: join(root, "state"),
    captainDirectory,
    projectDirectory: locations.get("default")?.projectDirectory ?? "",
    worktrees: locations.get("default")?.worktrees ?? {},
    captainSessionID: "ses_captain",
    team,
    mesijCommand: "/not-executed",
  };

  const extra = locations.get("stargate");

  if (!extra) {
    throw new Error("Missing project fixture");
  }

  const options: CrewOptions = { ...base, projects: { stargate: extra } };

  type Native = CrewSession & { model?: unknown; permissions?: unknown };

  const rootSession: Native = {
    id: "ses_captain",
    agent: "build",
    location: { directory: captainDirectory },
    metadata: {},
    model: { providerID: "fixture", id: "captain" },
    permissions: [{ action: "stargate_crew", resource: "*", effect: "allow" }],
  };

  const native = new Map<string, Native>([[rootSession.id, rootSession]]);
  const creations: Parameters<CrewSessions["create"]>[0][] = [];
  const prompts: Parameters<CrewSessions["prompt"]>[0][] = [];

  const client: CrewSessions = {
    async get({ sessionID }) {
      const value = native.get(sessionID);

      if (!value) {
        throw { _tag: "Session.NotFoundError" };
      }

      return value;
    },
    async create(input) {
      if (!input.id || !input.agent || !input.location || !input.metadata) {
        throw new Error("Exact native identity required");
      }

      creations.push(structuredClone(input));

      const value: Native = {
        id: input.id,
        agent: input.agent,
        location: input.location,
        metadata: input.metadata,
        ...(input.model ? { model: input.model } : {}),
        permissions: input.permissions,
      };

      native.set(value.id, value);

      return value;
    },
    async prompt(input) {
      prompts.push(input);

      return { id: input.id ?? "msg_fixture", sessionID: input.sessionID };
    },
    async wait() {},
    async interrupt() {},
    async synthetic() {},
    async compact() {},
  };

  const mail = new Map<string, MesijMessage[]>();

  const factory = async (config: CrewOptions) => {
    const messages = mail.get(config.namespace) ?? [];
    mail.set(config.namespace, messages);
    const keys = new Map<string, MesijMessage>();

    const mailer: Pick<MesijClient, "register" | "send" | "inbox"> = {
      async register() {
        return { id: "0".repeat(32), sequence: 0 };
      },
      async send(input) {
        let message = keys.get(input.key);

        if (!message) {
          message = {
            id: (messages.length + 1).toString(16).padStart(32, "0"),
            sequence: messages.length + 1,
            actor: input.actor,
            sessionID: input.sessionID,
            to: input.to,
            text: input.text,
            type: "message.posted",
          };
          messages.push(message);
          keys.set(input.key, message);
        }

        return { id: message.id, sequence: message.sequence };
      },
      async inbox(input) {
        return messages.filter(
          (message) =>
            message.to === input.sessionID &&
            message.sequence > (input.after ?? 0),
        );
      },
    };

    return CrewEngine.open(config, client, mailer, {
      async get() {
        return {
          data: {
            mode: "primary",
            model: { providerID: "fixture", id: "worker" },
          },
        };
      },
    });
  };

  let sequence = 0;

  const captain = () => ({
    sessionID: "ses_captain",
    agent: "build",
    signal: new AbortController().signal,
    id: `call-${++sequence}`,
  });

  return {
    root,
    base,
    options,
    native,
    rootSession,
    creations,
    prompts,
    factory,
    client,
    mail,
    captain,
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function identity(engine: CrewEngine) {
  const db = new Database(engine.state.path, { readonly: true });

  try {
    return db.query<{ value: string }, []>("SELECT value FROM identity").get()
      ?.value;
  } finally {
    db.close();
  }
}

test(
  "legacy context identity/native IDs stay unchanged while another project gets independent workers and state",
  async () => {
    const f = await fixture();
    let projects: CrewProjects | undefined;

    try {
      const legacy = await f.factory(f.base);

      const oldPeer = (
        await legacy.run({ op: "ensure", crew: "worker" }, f.captain())
      ).peers?.[0];

      const oldIdentity = identity(legacy);
      const rootBefore = structuredClone(f.rootSession);
      await legacy.close();
      projects = await CrewProjects.open(f.options, f.factory);
      expect(identity(projects.default)).toBe(oldIdentity);

      const existing = await projects.run(
        { op: "ensure", crew: "worker" },
        f.captain(),
      );

      const extra = await projects.run(
        { op: "ensure", crew: "worker", project: "stargate" },
        f.captain(),
      );

      expect(existing.peers?.[0]?.sessionID).toBe(oldPeer?.sessionID);
      expect(extra.peers?.[0]?.sessionID).not.toBe(oldPeer?.sessionID);
      expect(projects.get("stargate").options.captainDirectory).toBe(
        f.base.captainDirectory,
      );
      expect(projects.get("stargate").options.projectDirectory).not.toBe(
        f.base.projectDirectory,
      );
      expect(projects.get("stargate").state.path).not.toBe(
        projects.default.state.path,
      );
      expect(f.rootSession).toEqual(rootBefore);
      expect(f.creations).toHaveLength(2);
      expect(
        f.creations.every(
          (input) =>
            input.agent === "crew-worker" &&
            input.location?.directory !== f.base.captainDirectory,
        ),
      ).toBe(true);

      const ids = [...projects.contexts].map(([key, e]) => [
        key,
        e.state.peer("worker")?.sessionID,
      ]);

      await projects.close();
      projects = await CrewProjects.open(f.options, f.factory);
      expect(
        [...projects.contexts].map(([key, e]) => [
          key,
          e.state.peer("worker")?.sessionID,
        ]),
      ).toEqual(ids);
      expect(f.prompts).toHaveLength(0);
    } finally {
      await projects?.close();
      await f.close();
    }
  },
  diskIntegrationTimeoutMs,
);

test("dispatch selects only protected paths; worker omission binds native context and cannot spoof mail/DM/project", async () => {
  const f = await fixture();
  const projects = await CrewProjects.open(f.options, f.factory);

  try {
    const result = await projects.run(
      {
        op: "dispatch",
        crew: "worker",
        text: "Read the assigned repository",
        project: "stargate",
      },
      f.captain(),
    );

    const peer = projects.get("stargate").state.peer("worker");

    if (!peer || !result.task) {
      throw new Error("Missing native task");
    }

    const worker = {
      sessionID: peer.sessionID,
      agent: "crew-worker",
      signal: new AbortController().signal,
      id: "worker-call",
    };

    expect((await projects.select({}, worker)).project).toBe("stargate");
    expect(f.prompts[0]?.text).toContain(
      f.options.projects?.["stargate"]?.worktrees["worker"] ?? "missing",
    );
    expect(f.prompts[0]?.text).toContain("not human approval");
    expect(
      projects
        .status({ member: "worker" })
        .members.find((member) => member.project === "stargate")?.current
        ?.summary,
    ).toBe("Read the assigned repository");

    for (const mail of [false, true]) {
      await expect(
        projects.select({ project: "default" }, worker, mail),
      ).rejects.toThrow("another project");
    }

    const selected = await projects.select(
      { op: "send", to: "captain", text: "Actual worker result" },
      worker,
      true,
    );

    await selected.engine.mail(selected.input, worker);
    expect(
      f.mail
        .get(projects.get("stargate").options.namespace)
        ?.some((m) => m.text.includes("Actual worker result")),
    ).toBe(true);
    expect(f.mail.get(f.base.namespace)).toHaveLength(0);
    await projects.run(
      {
        op: "complete",
        taskID: result.task.id,
        result: "Read-only fixture complete",
      },
      worker,
    );
    expect(projects.get("stargate").state.task(result.task.id)?.status).toBe(
      "completed",
    );
    expect(projects.default.state.task(result.task.id)).toBeNull();
    const original = f.native.get(peer.sessionID);

    if (!original) {
      throw new Error("Missing peer");
    }

    f.native.set(peer.sessionID, {
      ...original,
      location: { directory: f.base.projectDirectory },
    });
    await expect(projects.select({}, worker)).rejects.toThrow(
      "identity changed",
    );
  } finally {
    await projects.close();
    await f.close();
  }
});

test("project validation rejects path/repository aliases and foreign worktrees before state/native admission", async () => {
  const f = await fixture();

  try {
    const invalid = [
      {
        ...f.options,
        projects: {
          stargate: f.options.projects?.["stargate"],
          alias: f.options.projects?.["stargate"],
        },
      },
      {
        ...f.options,
        projects: {
          stargate: {
            projectDirectory:
              f.options.projects?.["stargate"]?.projectDirectory,
            worktrees: f.base.worktrees,
          },
        },
      },
      {
        ...f.options,
        projects: {
          stargate: {
            ...f.options.projects?.["stargate"],
            captainDirectory: "/arbitrary",
            captainSessionID: "ses_other",
            model: "other/model",
            permissions: [{ action: "*", resource: "*", effect: "allow" }],
          },
        },
      },
    ];

    let opened = 0;

    for (const value of invalid) {
      await expect(
        CrewProjects.open(value, async (options) => {
          opened++;

          return f.factory(options);
        }),
      ).rejects.toThrow();
    }

    const link = join(f.root, "aliased-worker");
    await symlink(
      f.options.projects?.["stargate"]?.worktrees["worker"] ?? "",
      link,
    );
    await expect(
      CrewProjects.open(
        {
          ...f.options,
          projects: {
            stargate: {
              ...f.options.projects?.["stargate"],
              worktrees: { worker: link },
            },
          },
        },
        f.factory,
      ),
    ).rejects.toThrow();
    expect(opened).toBe(0);
    expect(f.creations).toHaveLength(0);
    await expect(
      CrewProjects.open(
        { ...f.options, captainSessionID: "ses_rebound" },
        f.factory,
      ).then(async (projects) => {
        try {
          await projects.run(
            { op: "ensure", project: "stargate" },
            f.captain(),
          );
        } finally {
          await projects.close();
        }
      }),
    ).rejects.toThrow("configured");
  } finally {
    await f.close();
  }
});

test("tool schema accepts keys only and original strict operation constraints remain enforced", async () => {
  const tool = crewOpenCodeInput()["~standard"];
  expect(
    await tool.validate({
      op: "dispatch",
      crew: "worker",
      text: "task",
      project: "stargate",
    }),
  ).toHaveProperty("value");

  for (const value of [
    { op: "dispatch", crew: "worker", text: "task", directory: "/tmp/other" },
    { op: "dispatch", crew: "worker", text: "task", project: "../other" },
    { op: "dispatch", project: "stargate" },
  ]) {
    expect(await tool.validate(value)).toHaveProperty("issues");
  }

  for (const key of [
    "default",
    "constructor",
    "prototype",
    "__proto__",
    "../escape",
  ]) {
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(projectsSchema)(
          JSON.parse(
            JSON.stringify({
              [key]: {
                projectDirectory: "/tmp/project",
                worktrees: { worker: "/tmp/worker" },
              },
            }),
          ),
        ),
      ),
    ).toBe(false);
  }
});

test("Effect project envelope separates selection from strict operation decoding", () => {
  const tool = effectProjectToolInput(journalInputSchema);
  const decode = Schema.decodeUnknownSync(tool);
  expect(decode({ op: "read" })).toEqual({ op: "read" });
  expect(
    decode({ op: "append", project: "stargate", text: "  note  " }),
  ).toEqual({
    op: "append",
    project: "stargate",
    text: "  note  ",
  });

  for (const input of [
    { op: "read", text: "wrong branch", project: "stargate" },
    { op: "append", project: "stargate" },
    { op: "read", extra: true },
    { op: "read", project: "../escape" },
    { op: "read", project: null },
  ]) {
    expect(() => decode(input)).toThrow();
  }

  for (const [key, accepted] of [
    ["default", true],
    ["a", true],
    ["a".repeat(48), true],
    ["a-b_2", true],
    ["a".repeat(49), false],
    ["A", false],
    ["__proto__", false],
    ["prototype", false],
    ["constructor", false],
    ["../escape", false],
    ["a\n", false],
    ["", false],
  ] as const) {
    expect(
      Result.isSuccess(Schema.decodeUnknownResult(effectProjectKeySchema)(key)),
    ).toBe(accepted);
  }

  const json = Schema.toJsonSchemaDocument(tool, {
    onExcessProperty: "error",
  }).schema;

  expect(json["type"]).toBe("object");
  expect(json["required"]).toEqual(["op"]);
  expect(json["properties"]).toHaveProperty("project", {
    type: "string",
    pattern: "^[a-z][a-z0-9_-]{0,47}$",
    description:
      "Configured repository key, never a path. Captain omission uses default; worker omission uses its persisted native context.",
  });
});

test("status and history identify all project contexts while legacy output stays unchanged", async () => {
  const f = await fixture();
  const projects = await CrewProjects.open(f.options, f.factory);

  try {
    for (const project of ["default", "stargate"]) {
      await projects.run(
        { op: "ensure", crew: "worker", project },
        f.captain(),
      );
    }

    const status = projects.status();
    expect(status.total).toBe(2);
    expect(status.truncated).toBe(false);
    expect(status.members.map((member) => member.project)).toEqual([
      "default",
      "stargate",
    ]);

    const fleet = Schema.decodeUnknownSync(fleetCrewStatusSchema)(
      projects.fleetStatus({ member: "worker" }),
    );

    expect(fleet.status).toEqual(status);
    expect(fleet.metadata).toEqual({
      projectDirectory: f.base.projectDirectory,
      contexts: [
        {
          member: "worker",
          project: null,
          directory: join(f.root, "worker-default"),
          role: "Builder",
          model: "fixture/worker",
        },
        {
          member: "worker",
          project: "stargate",
          directory: join(f.root, "worker-stargate"),
          role: "Builder",
          model: "fixture/worker",
        },
      ],
    });
    expect(JSON.stringify(status)).not.toContain(f.base.projectDirectory);
    const roots = await projects.historyRoots(new AbortController().signal);
    expect(roots.sessions).toHaveLength(2);
    expect(new Set(roots.sessions.map((s) => s.id)).size).toBe(2);
    expect(roots.sessions.some((s) => s.title?.includes("[stargate]"))).toBe(
      true,
    );
    expect(await readFile(join(f.root, "default/.git/HEAD"), "utf8")).toContain(
      "main",
    );
  } finally {
    await projects.close();
    await f.close();
  }
});

test("crew Git state covers every configured worktree, read as the captain", async () => {
  const f = await fixture(2);
  const projects = await CrewProjects.open(f.options, f.factory);
  const read = createCrewGitReader(liveFleetGit, () => 7);

  try {
    // Not provisioned: the worktree exists but no worker session does.
    const all = Schema.decodeUnknownSync(crewGitSchema)(
      await projects.crewGit({}, read, new AbortController().signal),
    );

    expect(all.project).toMatchObject({
      directory: f.base.projectDirectory,
      git: { branch: "main", changedFiles: 0, checkedAt: 7 },
    });
    expect(
      all.contexts.map(({ member, project, directory, git }) => [
        member,
        project,
        directory,
        git?.branch,
        git?.commit?.length,
      ]),
    ).toEqual([
      [
        "worker",
        null,
        join(f.root, "worker-default"),
        "task/default/worker",
        40,
      ],
      [
        "worker2",
        null,
        join(f.root, "worker2-default"),
        "task/default/worker2",
        40,
      ],
      [
        "worker",
        "stargate",
        join(f.root, "worker-stargate"),
        "task/stargate/worker",
        40,
      ],
      [
        "worker2",
        "stargate",
        join(f.root, "worker2-stargate"),
        "task/stargate/worker2",
        40,
      ],
    ]);

    const one = await projects.crewGit(
      { member: "worker2" },
      read,
      new AbortController().signal,
    );

    expect(one.contexts.map(({ member }) => member)).toEqual([
      "worker2",
      "worker2",
    ]);
    expect(
      (
        await projects.crewGit(
          { crew: false },
          read,
          new AbortController().signal,
        )
      ).contexts,
    ).toEqual([]);
  } finally {
    await projects.close();
    await f.close();
  }
});

test("aggregate activity includes busy workers after the twenty-row project page", async () => {
  const f = await fixture(18);
  const projects = await CrewProjects.open(f.options, f.factory);

  try {
    await projects.run(
      {
        op: "dispatch",
        crew: "worker18",
        project: "stargate",
        text: "Work after the status page",
      },
      f.captain(),
    );

    const status = Schema.decodeUnknownSync(crewStatusSchema)(
      projects.status(),
    );

    expect(status.total).toBe(36);
    expect(status.members).toHaveLength(20);
    expect(status.truncated).toBe(true);
    expect(status.members.filter((member) => member.current)).toHaveLength(0);
    expect(status.busy).toBe(1);
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(crewStatusSchema)({ ...status, busy: 37 }),
      ),
    ).toBe(false);
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(crewStatusSchema)({ ...status, busy: 51 }),
      ),
    ).toBe(false);
  } finally {
    await projects.close();
    await f.close();
  }
});

test("engine aggregate counts member twenty-one before its own page limit and reaches the real dashboard source", async () => {
  const f = await fixture(21);
  const projects = await CrewProjects.open(f.options, f.factory);
  const store = openStore(":memory:");
  const cron = new CronStore(":memory:");

  try {
    await projects.run(
      {
        op: "dispatch",
        crew: "worker21",
        text: "Only member twenty-one is busy",
      },
      f.captain(),
    );
    const legacy = projects.default.status();
    expect(legacy.members).toHaveLength(20);
    expect(legacy.total).toBe(21);
    expect(legacy.truncated).toBe(true);
    expect(legacy).not.toHaveProperty("busy");
    expect(legacy.members.every((member) => member.current === null)).toBe(
      true,
    );
    expect(projects.default.status({}, { aggregate: true }).busy).toBe(1);

    const status = Schema.decodeUnknownSync(crewStatusSchema)(
      projects.status(),
    );

    expect(status.total).toBe(42);
    expect(status.members).toHaveLength(20);
    expect(status.members.every((member) => member.current === null)).toBe(
      true,
    );
    expect(status.busy).toBe(1);
    expect(projects.status({ member: "worker21" }).busy).toBe(1);
    const calls = f.creations.length;

    const source = dashboardSource(
      [
        {
          bot: bot(),
          identity: dashboardIdentity,
          key: "projects",
          backend: {
            async crewStatus() {
              return projects.status();
            },
            async createSession() {
              throw new Error("Dashboard must not create sessions");
            },
            async prompt() {
              throw new Error("Dashboard must not invoke a model");
            },
            async close() {},
          },
        },
      ],
      store,
      cron,
    );

    const fleet = await source.fleet(new AbortController().signal);
    expect(fleet.ships[0]?.crew).toEqual({
      total: 42,
      busy: 1,
      people: { total: 20, busy: 0, partial: true },
    });
    expect(f.creations).toHaveLength(calls);
  } finally {
    store.close();
    cron.close();
    await projects.close();
    await f.close();
  }
});

test("changing a registered worktree cannot rebind persisted project workers or replay tasks", async () => {
  const f = await fixture();
  let projects: CrewProjects | undefined;

  try {
    projects = await CrewProjects.open(f.options, f.factory);
    await projects.run(
      { op: "ensure", crew: "worker", project: "stargate" },
      f.captain(),
    );
    const peer = projects.get("stargate").state.peer("worker");
    const stateIdentity = identity(projects.get("stargate"));
    await projects.close();
    projects = undefined;
    const directory = f.options.projects?.["stargate"]?.projectDirectory;

    if (!directory) {
      throw new Error("Missing project");
    }

    const moved = join(f.root, "new-worker-location");
    await git(directory, "worktree", "add", "-b", "task/moved", moved, "main");
    await expect(
      CrewProjects.open(
        {
          ...f.options,
          projects: {
            stargate: {
              projectDirectory: directory,
              worktrees: { worker: moved },
            },
          },
        },
        f.factory,
      ),
    ).rejects.toThrow("use a new namespace");
    projects = await CrewProjects.open(f.options, f.factory);
    expect(projects.get("stargate").state.peer("worker")?.sessionID).toBe(
      peer?.sessionID,
    );
    expect(identity(projects.get("stargate"))).toBe(stateIdentity);
    expect(f.creations).toHaveLength(1);
    expect(f.prompts).toHaveLength(0);
  } finally {
    await projects?.close();
    await f.close();
  }
});

async function nativeHost(
  f: Awaited<ReturnType<typeof fixture>>,
  options: CrewOptions = f.options,
  permit: (request: unknown) => boolean = () => true,
) {
  const scope = Effect.runSync(Scope.make());

  type Registered = {
    name: string;
    input: Tool.ValueSchema;
    execute: (
      input: unknown,
      context: Tool.Context,
    ) => Effect.Effect<Tool.Result<undefined>, Tool.Error>;
  };

  const tools = new Map<string, Registered>();
  const assertions: unknown[] = [];
  const unexpected: string[] = [];
  let deny = false;

  const registration = {
    dispose: Effect.void,
    events: { emit: () => Effect.void },
  };

  const methods = new Map<string, unknown>([
    ["location", { directory: options.captainDirectory }],
    ["options", options],
    ["rpc.register", () => Effect.succeed(registration)],
    ["session.hook", () => Effect.succeed(registration)],
    [
      "permission.assert",
      (request: unknown) => {
        assertions.push(request);

        return deny || !permit(request)
          ? Effect.fail(new Tool.Error({ message: "Denied" }))
          : Effect.void;
      },
    ],
    [
      "session.get",
      ({ sessionID }: { sessionID: string }) =>
        Effect.promise(() => f.client.get({ sessionID })).pipe(
          Effect.flatMap((session) =>
            Schema.decodeUnknownEffect(Session.Info)({
              ...session,
              projectID: "project_fixture",
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              time: { created: 1, updated: 1 },
            }),
          ),
        ),
    ],
    [
      "tool.transform",
      (transform: (editor: object) => void) =>
        Effect.sync(() => transform(stub("editor"))).pipe(
          Effect.as(registration),
        ),
    ],
    [
      "editor.add",
      (tool: Registered) => {
        tools.set(tool.name, tool);
      },
    ],
  ]);

  function stub(path: string): object {
    return new Proxy(() => {}, {
      get(_target, key) {
        const next = path ? `${path}.${String(key)}` : String(key);

        return methods.get(next) ?? stub(next);
      },
      apply() {
        unexpected.push(path);
        throw new Error(`Unexpected native host call: ${path}`);
      },
    });
  }

  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));

  try {
    await Effect.runPromise(
      plugin
        .effect(stub("") as EffectPlugin.Context)
        .pipe(Scope.provide(scope)),
    );

    return {
      tools,
      assertions,
      unexpected,
      close,
      deny: () => {
        deny = true;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

test("actual OpenCode V2 plugin routes the configured project and retains native permission/source checks", async () => {
  const f = await fixture();
  const host = await nativeHost(f);
  const { tools, assertions, unexpected } = host;

  try {
    const tool = tools.get("stargate_crew");

    if (!tool) {
      throw new Error("Missing registered native tool");
    }

    const context: Tool.Context = {
      sessionID: Session.ID.make("ses_captain"),
      agent: Agent.ID.make("build"),
      messageID: SessionMessage.ID.make("msg_project"),
      id: Tool.CallID.make("call_project"),
      progress: () => Effect.void,
    };

    const result = await Effect.runPromise(
      tool.execute({ op: "roster", project: "stargate" }, context),
    );

    expect(typeof result.content).toBe("string");
    expect(JSON.parse(String(result.content))).toMatchObject({
      status: "roster",
      project: "stargate",
    });
    expect(assertions.at(-1)).toMatchObject({
      sessionID: "ses_captain",
      agent: "build",
      action: "stargate_crew",
      resources: ["roster"],
      source: { type: "tool", messageID: "msg_project", id: "call_project" },
    });
    const journal = tools.get("stargate_journal");

    if (!journal || !Schema.isSchema(journal.input)) {
      throw new Error("Journal requires a native Effect input codec");
    }

    const parseJournal = Schema.decodeUnknownSync(journal.input);

    const note = {
      op: "append",
      project: "stargate",
      text: "  Project note  ",
    };

    expect(parseJournal(note)).toEqual(note);

    const appended = await Effect.runPromise(
      journal.execute(parseJournal(note), context),
    );

    expect(JSON.parse(String(appended.content))).toMatchObject({
      entry: { text: "Project note", member: "captain" },
    });

    const page = await Effect.runPromise(
      journal.execute(
        parseJournal({ op: "read", project: "stargate" }),
        context,
      ),
    );

    expect(JSON.parse(String(page.content))).toMatchObject({
      entries: [{ text: "Project note" }],
    });
    expect(() => parseJournal({ op: "read", text: "wrong branch" })).toThrow();
    host.deny();
    await expect(
      Effect.runPromise(
        tool.execute({ op: "roster", project: "stargate" }, context),
      ),
    ).rejects.toThrow();
    expect(f.creations).toHaveLength(0);
    expect(f.prompts).toHaveLength(0);
    expect(unexpected).toEqual([]);
  } finally {
    await host.close();
    await f.close();
  }
});

function feedbackContext(
  sessionID: string,
  agent: string,
  id = "call_fixture",
  message = "msg_feedback",
): Tool.Context {
  return {
    sessionID: Session.ID.make(sessionID),
    agent: Agent.ID.make(agent),
    messageID: SessionMessage.ID.make(message),
    id: Tool.CallID.make(id),
    progress: () => Effect.void,
  };
}

const feedback = {
  title: "Fixture issue",
  expected: "One row",
  observed: "Two rows",
  evidence: "HTTP status 409",
};

function feedbackTools(host: Awaited<ReturnType<typeof nativeHost>>) {
  const submit = host.tools.get("stargate_feedback");
  const review = host.tools.get("stargate_feedback_review");

  if (!submit || !review) {
    throw new Error("Feedback tools not registered");
  }

  return {
    submit: async (input: unknown, context: Tool.Context) =>
      JSON.parse(
        String(
          (await Effect.runPromise(submit.execute(input, context))).content,
        ),
      ),
    review: async (input: unknown, context: Tool.Context) =>
      JSON.parse(
        String(
          (await Effect.runPromise(review.execute(input, context))).content,
        ),
      ),
  };
}

test("feedback tools default on for pinned ships and still require native permission", async () => {
  const f = await fixture();

  try {
    for (const options of [
      { ...f.options, feedbackEnabled: false },
      { ...f.options, captainSessionID: undefined },
    ]) {
      const host = await nativeHost(f, options);

      try {
        expect(host.tools.has("stargate_feedback")).toBe(false);
        expect(host.tools.has("stargate_feedback_review")).toBe(false);
      } finally {
        await host.close();
      }
    }

    const host = await nativeHost(f, f.options, () => false);

    try {
      const { submit, review } = feedbackTools(host);
      const captain = feedbackContext("ses_captain", "build");
      await expect(submit(feedback, captain)).rejects.toThrow("Denied");
      await expect(review({}, captain)).rejects.toThrow("Denied");
      expect(host.assertions).toMatchObject([
        {
          action: "stargate_feedback",
          resources: ["submit"],
          source: {
            type: "tool",
            messageID: "msg_feedback",
            id: "call_fixture",
          },
        },
        { action: "stargate_feedback_review", resources: ["review"] },
      ]);
    } finally {
      await host.close();
    }
  } finally {
    await f.close();
  }
});

test("feedback persists redacted original and binds review to the ship across projects and reopen", async () => {
  const f = await fixture();
  const options = { ...f.options, feedbackEnabled: true };
  let host: Awaited<ReturnType<typeof nativeHost>> | undefined;

  try {
    const projects = await CrewProjects.open(f.options, f.factory);
    let peer;

    try {
      peer = (
        await projects
          .get("stargate")
          .run({ op: "ensure", crew: "worker" }, f.captain())
      ).peers?.[0];
    } finally {
      await projects.close();
    }

    if (!peer) {
      throw new Error("Missing worker fixture");
    }

    const worker = feedbackContext(peer.sessionID, "crew-worker");
    const captain = feedbackContext("ses_captain", "build");
    host = await nativeHost(f, options);
    const { submit, review } = feedbackTools(host);

    for (const invalid of [
      { ...feedback, namespace: "another-ship" },
      { ...feedback, project: "default" },
      { ...feedback, evidence: "x".repeat(601) },
      { ...feedback, title: " " },
    ]) {
      await expect(submit(invalid, worker)).rejects.toThrow(
        "Invalid feedback input",
      );
    }

    await expect(
      submit(feedback, { ...worker, id: Tool.CallID.make("") }),
    ).rejects.toThrow();
    const withoutMessage = { ...worker };
    Reflect.deleteProperty(withoutMessage, "messageID");
    await expect(submit(feedback, withoutMessage)).rejects.toThrow();
    await expect(
      submit(feedback, feedbackContext("ses_foreign", "crew-worker")),
    ).rejects.toThrow();
    await expect(review({}, worker)).rejects.toThrow("captain");
    await expect(
      review({}, { ...captain, id: Tool.CallID.make("") }),
    ).rejects.toThrow("full host tool-call identity");
    await expect(
      review({}, feedbackContext("ses_foreign", "build")),
    ).rejects.toThrow("configured");
    await expect(review({ ship: "another-ship" }, captain)).rejects.toThrow(
      "Invalid feedback review input",
    );
    await expect(review({ limit: 21 }, captain)).rejects.toThrow(
      "Invalid feedback review input",
    );
    expect(await review({}, captain)).toEqual({
      entries: [],
      nextAfter: 0,
      truncated: false,
    });

    const path = join(
      f.base.stateDirectory,
      `crew-${new Bun.CryptoHasher("sha256").update(f.base.namespace).digest("hex")}.sqlite`,
    );

    const empty = new Database(path, { readonly: true });

    try {
      expect(
        empty
          .query("SELECT 1 FROM sqlite_schema WHERE name='feedback_inbox'")
          .get(),
      ).toBeNull();
    } finally {
      empty.close();
    }

    const since = Date.now();

    const receipt = await submit(
      {
        title: "Fixture issue xoxb-fixture-token",
        expected: "Token: 'expected-secret'",
        observed: "Bearer observed-secret",
        evidence:
          "URL https://user:fixture-password@fixture-tail@example.test/api",
      },
      worker,
    );

    expect(receipt).toEqual({ status: "stored", id: 1 });
    expect(await submit(feedback, captain)).toEqual({
      status: "stored",
      id: 2,
    });
    await host.close();
    host = undefined;
    host = await nativeHost(f, options);
    const reopened = feedbackTools(host);
    expect(
      await reopened.submit(
        { ...feedback, title: "Must not overwrite" },
        worker,
      ),
    ).toEqual(receipt);
    expect(
      await reopened.submit(feedback, {
        ...worker,
        messageID: SessionMessage.ID.make("msg_another"),
      }),
    ).toEqual({ status: "stored", id: 3 });
    const first: unknown = await reopened.review({ limit: 1 }, captain);
    expect(first).toMatchObject({
      entries: [
        {
          id: 1,
          created: expect.any(Number),
          member: "worker",
          project: "stargate",
          title: "Fixture issue [REDACTED]",
          expected: "Token: [REDACTED]",
          observed: "[REDACTED AUTHORIZATION]",
          evidence: "URL https://[REDACTED]@example.test/api",
        },
      ],
      nextAfter: 1,
      truncated: true,
    });
    expect(JSON.stringify(first)).not.toContain("Must not overwrite");
    expect(await reopened.review({ after: 1 }, captain)).toMatchObject({
      entries: [
        { id: 2, member: "captain", project: "default" },
        { id: 3, member: "worker", project: "stargate" },
      ],
      nextAfter: 3,
      truncated: false,
    });

    const db = new Database(path, { readonly: true });

    try {
      const row = db
        .query<
          {
            created: number;
            title: string;
            expected: string;
            observed: string;
            evidence: string;
          },
          []
        >(
          "SELECT created,title,expected,observed,evidence FROM feedback_inbox WHERE id=1",
        )
        .get();

      expect(row?.created ?? 0).toBeGreaterThanOrEqual(since);

      for (const secret of [
        "xoxb-fixture-token",
        "expected-secret",
        "observed-secret",
        "fixture-password",
        "fixture-tail",
      ]) {
        expect(JSON.stringify(row)).not.toContain(secret);
      }
    } finally {
      db.close();
    }

    // Fill through the same local database in one transaction, then check
    // The boundary for new admission and replay at capacity.
    const seed = new Database(path);

    try {
      seed.run(`WITH RECURSIVE slots(n) AS (SELECT 4 UNION ALL SELECT n+1 FROM slots WHERE n<1000)
        INSERT INTO feedback_inbox (created,member,project,callKey,title,expected,observed)
        SELECT 1,'worker','stargate','fixture:' || n,'Fixture','Before','After' FROM slots`);
    } finally {
      seed.close();
    }

    await expect(
      reopened.submit(feedback, {
        ...worker,
        id: Tool.CallID.make("call_at_cap"),
      }),
    ).rejects.toThrow("inbox is full");
    expect(await reopened.submit(feedback, worker)).toEqual(receipt);
    expect(await reopened.review({ after: 999 }, captain)).toMatchObject({
      entries: [{ id: 1000 }],
      nextAfter: 1000,
      truncated: false,
    });
    expect(f.prompts).toEqual([]);
    expect(host.unexpected).toEqual([]);

    const otherDirectory = join(f.root, "other-captain");
    await mkdir(otherDirectory);

    const other = {
      ...f.rootSession,
      id: "ses_other",
      location: { directory: otherDirectory },
    };

    f.native.set(other.id, other);

    const foreign = await nativeHost(f, {
      ...options,
      namespace: "other-ship",
      captainDirectory: otherDirectory,
      captainSessionID: other.id,
    });

    try {
      const otherReview = feedbackTools(foreign).review;
      await expect(otherReview({}, captain)).rejects.toThrow("configured");
      expect(await otherReview({}, feedbackContext(other.id, "build"))).toEqual(
        { entries: [], nextAfter: 0, truncated: false },
      );
    } finally {
      await foreign.close();
    }
  } finally {
    await host?.close();
    await f.close();
  }
});
