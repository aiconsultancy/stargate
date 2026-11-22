import { expect, test } from "bun:test";
import type { CrewCaller } from "../src/crew/engine";
import {
  CrewModels,
  type ModelAuthority,
  type ModelSessions,
} from "../src/crew/controls/models";
import { crewPermissions } from "../src/crew/policy";
import { CrewError } from "../src/crew/state";
import { defaultTeam } from "../src/crew/team";

function fixture() {
  const calls: string[] = [];
  const reads: string[] = [];
  const controls: ({ requireReady?: boolean } | undefined)[] = [];
  let current = { providerID: "openai-proxy", id: "old" };
  const authority: ModelAuthority = {
    options: {
      captainDirectory: "/captain",
      worktrees: { mario: "/crew/mario" },
      team: defaultTeam,
    },
    async captain(caller) {
      if (caller.agent !== "bowser") throw new Error("not captain");
    },
    async authorize(caller) {
      if (caller.agent === "bowser" && caller.sessionID === "ses_captain")
        return;
      if (caller.agent === "mario" && caller.sessionID === "ses_mario") return;
      throw new Error("not configured caller");
    },
    async inspectWorkerModel(crew, caller) {
      await this.captain(caller);
      if (crew !== "mario")
        throw new CrewError("Unknown configured crew member.");
      return {
        crewID: crew,
        sessionID: "ses_mario",
        status: "ready",
        ...(await sessions.get({ sessionID: "ses_mario" })),
      };
    },
    async withWorkerControl(crew, caller, operation, options) {
      await this.captain(caller);
      if (crew !== "mario")
        throw new CrewError("Unknown configured crew member.");
      controls.push(options);
      calls.push("lock");
      try {
        return await operation({
          crewID: crew,
          sessionID: "ses_mario",
          status: "ready",
          ...(await sessions.get({ sessionID: "ses_mario" })),
        });
      } finally {
        calls.push("unlock");
      }
    },
  };
  const sessions: ModelSessions = {
    async switchModel(input) {
      calls.push(`switch:${input.sessionID}`);
      current = input.model;
    },
    async get({ sessionID }) {
      reads.push(sessionID);
      return { model: current };
    },
    async compact(input) {
      calls.push(`compact:${input.sessionID}`);
    },
    async interrupt(input) {
      calls.push(`interrupt:${input.sessionID}`);
    },
  };
  const models = {
    async list() {
      return {
        data: [
          {
            providerID: "openai-proxy",
            id: "sol",
            enabled: true,
            variants: [{ id: "high" }],
          },
          { providerID: "paid", id: "other", enabled: true, variants: [] },
          {
            providerID: "openai-proxy",
            id: "disabled",
            enabled: false,
            variants: [],
          },
        ],
      };
    },
  };
  const caller: CrewCaller = {
    sessionID: "ses_captain",
    agent: "bowser",
    signal: new AbortController().signal,
  };
  const tool = new CrewModels(authority, sessions, models, async () => {
    calls.push("compacted");
  });
  return { tool, calls, reads, controls, caller, sessions, models };
}

test("captain switches its session model without replacing the session", async () => {
  const f = fixture();
  const result = await f.tool.run(
    {
      op: "switch",
      target: "captain",
      providerID: "openai-proxy",
      id: "sol",
      variant: "high",
    },
    f.caller,
  );
  expect(result).toMatchObject({
    status: "switched",
    sessionID: "ses_captain",
    effect: "subsequent-provider-turns",
  });
  expect(f.calls).toEqual(["switch:ses_captain"]);
});

test("get reads the caller session and reports its stored variant without mutations", async () => {
  const f = fixture();
  f.models.list = async () => {
    throw new Error("Catalog must not be queried");
  };
  f.sessions.get = async (input, request) => {
    expect(input).toEqual({ sessionID: f.caller.sessionID });
    expect(request?.signal).toBe(f.caller.signal);
    return {
      model: { providerID: "outside-catalog", id: "stored", variant: "high" },
    };
  };
  expect(await f.tool.run({ op: "get" }, f.caller)).toEqual({
    sessionID: "ses_captain",
    model: { providerID: "outside-catalog", id: "stored", variant: "high" },
  });
  expect(f.calls).toEqual([]);
});

test("get reports absent variant as default/unspecified, not a guessed level", async () => {
  const f = fixture();
  expect(await f.tool.run({ op: "get", target: "captain" }, f.caller)).toEqual({
    sessionID: "ses_captain",
    model: {
      providerID: "openai-proxy",
      id: "old",
      variant: "default/unspecified",
    },
  });
  expect(f.calls).toEqual([]);
});

test("worker reads its own selected model without control locks or catalog calls", async () => {
  const f = fixture();
  f.models.list = async () => {
    throw new Error("No catalog read required");
  };
  const worker = { ...f.caller, sessionID: "ses_mario", agent: "mario" };
  f.sessions.get = async ({ sessionID }) => {
    expect(sessionID).toBe(worker.sessionID);
    return {
      model: {
        providerID: "openai-proxy",
        id: "worker-model",
        variant: "high",
      },
    };
  };
  expect(await f.tool.run({ op: "get", target: "self" }, worker)).toMatchObject(
    {
      sessionID: "ses_mario",
      model: { id: "worker-model", variant: "high" },
    },
  );
  await expect(
    f.tool.run({ op: "get", target: "captain" }, worker),
  ).rejects.toThrow();
  expect(f.calls).toEqual([]);
});

test("get fails closed on missing model, unauthorized caller, abort and API failure", async () => {
  const f = fixture();
  await expect(
    f.tool.run({ op: "get" }, { ...f.caller, agent: "mario" }),
  ).rejects.toThrow("Model operation unavailable");
  await expect(
    f.tool.run({ op: "get" }, { ...f.caller, signal: AbortSignal.abort() }),
  ).rejects.toThrow("cancelled");
  await expect(
    f.tool.run({ op: "get", target: "mario" }, f.caller),
  ).rejects.toThrow("Invalid stargate_model");
  f.sessions.get = async () => ({});
  await expect(f.tool.run({ op: "get" }, f.caller)).rejects.toThrow(
    "Session has no selected model",
  );
  f.sessions.get = async () => {
    throw new Error("PRIVATE_CREDENTIAL");
  };
  await expect(f.tool.run({ op: "get" }, f.caller)).rejects.toThrow(
    "Raw details withheld",
  );
  expect(f.calls).toEqual([]);
});

test("self compact-first is two-phase and never waits on its own running turn", async () => {
  const f = fixture();
  expect(
    await f.tool.run(
      {
        op: "switch",
        target: "captain",
        providerID: "openai-proxy",
        id: "sol",
        compactFirst: true,
      },
      f.caller,
    ),
  ).toMatchObject({ status: "compaction-admitted", modelChanged: false });
  expect(f.calls).toEqual(["compact:ses_captain"]);
});

test("worker compact-first holds control until compaction and model selection finish", async () => {
  const f = fixture();
  await f.tool.run(
    {
      op: "switch",
      target: "mario",
      providerID: "openai-proxy",
      id: "sol",
      compactFirst: true,
    },
    f.caller,
  );
  expect(f.calls).toEqual(["lock", "compacted", "switch:ses_mario", "unlock"]);
});

test("model operations reject missing variants, disabled or unapproved routes", async () => {
  const f = fixture();
  for (const model of [
    { providerID: "paid", id: "other" },
    { providerID: "openai-proxy", id: "disabled" },
    { providerID: "openai-proxy", id: "missing" },
    { providerID: "openai-proxy", id: "sol", variant: "invented" },
  ])
    await expect(
      f.tool.run({ op: "switch", target: "captain", ...model }, f.caller),
    ).rejects.toThrow();
  expect(f.calls).toEqual([]);
  expect(await f.tool.run({ op: "list" }, f.caller)).toMatchObject({
    models: [{ providerID: "openai-proxy", id: "sol", variants: ["high"] }],
  });
});

test("worker cannot use model controls; abort and SDK failures do not expose details", async () => {
  const f = fixture();
  await expect(
    f.tool.run({ op: "list" }, { ...f.caller, agent: "mario" }),
  ).rejects.toThrow("Model operation unavailable");
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.tool.run({ op: "list" }, { ...f.caller, signal: controller.signal }),
  ).rejects.toThrow("cancelled");
  f.sessions.switchModel = async () => {
    throw new Error("PRIVATE_CREDENTIAL");
  };
  await expect(
    f.tool.run(
      {
        op: "switch",
        target: "captain",
        providerID: "openai-proxy",
        id: "sol",
      },
      f.caller,
    ),
  ).rejects.toThrow("Model operation unavailable");
});

test("effort preserves the current provider/model/session and validates actual variants", async () => {
  const f = fixture();
  await f.sessions.switchModel({
    sessionID: "ses_mario",
    model: { providerID: "openai-proxy", id: "sol", variant: "low" },
  });
  f.calls.length = 0;
  expect(
    await f.tool.run(
      { op: "effort", target: "mario", variant: "high" },
      f.caller,
    ),
  ).toMatchObject({
    sessionID: "ses_mario",
    model: { providerID: "openai-proxy", id: "sol", variant: "high" },
  });
  expect(f.calls).toEqual(["lock", "switch:ses_mario", "unlock"]);
  f.calls.length = 0;
  expect(
    await f.tool.run(
      { op: "effort", target: "mario", variant: "high" },
      f.caller,
    ),
  ).toMatchObject({ status: "unchanged" });
  expect(f.calls).toEqual(["lock", "unlock"]);
  await expect(
    f.tool.run({ op: "effort", target: "mario", variant: "xhigh" }, f.caller),
  ).rejects.toThrow("unavailable for the current model");
  await expect(
    f.tool.run(
      { op: "effort", target: "mario", variant: "high", id: "different" },
      f.caller,
    ),
  ).rejects.toThrow("Invalid stargate_model");
});

test("inspect is read-only and effort refuses unknown targets and foreign callers", async () => {
  const f = fixture();
  expect(
    await f.tool.run({ op: "inspect", target: "mario" }, f.caller),
  ).toMatchObject({ sessionID: "ses_mario", model: { id: "old" } });
  expect(f.calls).toEqual([]);
  for (const target of ["captain", "foreign"])
    await expect(
      f.tool.run({ op: "effort", target, variant: "high" }, f.caller),
    ).rejects.toThrow("Unknown configured crew member");
  await expect(
    f.tool.run(
      { op: "effort", target: "mario", variant: "high" },
      { ...f.caller, agent: "foreign" },
    ),
  ).rejects.toThrow();
  expect(f.calls).toEqual([]);
});

test("inspect reports the one authority-validated model snapshot without a second unvalidated read", async () => {
  const f = fixture();
  expect(
    await f.tool.run({ op: "inspect", target: "mario" }, f.caller),
  ).toMatchObject({ model: { id: "old", variant: "default/unspecified" } });
  expect(f.reads).toEqual(["ses_mario"]);
  expect(f.calls).toEqual([]);
});

test("effort requires ready-only control and reports missing model or outside provider without catalogue calls", async () => {
  for (const current of [
    undefined,
    { providerID: "paid", id: "other", variant: "low" },
  ]) {
    const f = fixture();
    f.sessions.get = async () => (current ? { model: current } : {});
    f.models.list = async () => {
      throw new Error("Catalogue must not be queried");
    };
    await expect(
      f.tool.run({ op: "effort", target: "mario", variant: "high" }, f.caller),
    ).rejects.toThrow(
      current
        ? "outside this team's allowed model providers"
        : "Worker has no selected model",
    );
    expect(f.controls).toEqual([{ requireReady: true }]);
    expect(f.calls).toEqual(["lock", "unlock"]);
  }
});

test("generic trusted captain wildcard policy continues to authorise model operations", () => {
  expect(crewPermissions("captain")).toContainEqual({
    action: "stargate_model",
    resource: "*",
    effect: "allow",
  });
  expect(crewPermissions("coding")).toContainEqual({
    action: "stargate_model",
    resource: "get",
    effect: "allow",
  });
});
