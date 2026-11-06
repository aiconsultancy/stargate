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
  return { tool, calls, caller, sessions };
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
