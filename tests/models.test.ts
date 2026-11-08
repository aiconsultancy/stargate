import { expect, test } from "bun:test";
import type { CrewCaller } from "../src/crew/engine";
import {
  CrewModels,
  type ModelAuthority,
  type ModelSessions,
} from "../src/crew/models";
import { defaultTeam } from "../src/crew/team";

function fixture() {
  const calls: string[] = [];
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
    async withWorkerControl(crew, caller, operation) {
      await this.captain(caller);
      if (crew !== "mario") throw new Error("not configured");
      calls.push("lock");
      try {
        return await operation({
          crewID: crew,
          sessionID: "ses_mario",
          status: "ready",
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
    async get() {
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
  return { tool, calls, caller, sessions, models };
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
  ).rejects.toThrow("Invalid pogo_model");
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
