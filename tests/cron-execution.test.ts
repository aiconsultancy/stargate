import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExperimentalGenerateTextInput } from "@opencode/client";
import { Result, Schema } from "effect";
import type { BackendContext } from "../src/backends/backend";
import { OpenCodeBackend } from "../src/backends/opencode/opencode";
import { type BackendConfig, backendSchema } from "../src/config";
import {
  CrewCronExecution,
  type CronArbiterFactory,
  type CronExecutionAPI,
  type CronExecutionAuthority,
} from "../src/coordination/crew/cron/cron-execution";
import type { CrewSession } from "../src/coordination/crew/execution/engine";
import { defaultTeam } from "../src/coordination/crew/team";
import {
  cronDecision,
  cronEvaluateInputSchema,
  cronModelInputSchema,
} from "../src/automation/cron/decision";
import { cronjobPrompt } from "../src/automation/cron/job-manager";

const risks = {
  approval: false,
  credentials: false,
  destructive: false,
  ownerDecision: false,
};

test("cron decision accepts each bounded verdict and fails closed", () => {
  for (const verdict of ["act", "ignore", "escalate"] as const)
    expect(cronDecision(JSON.stringify({ verdict, risks }), "", "")).toBe(
      verdict,
    );

  for (const value of [
    "not JSON",
    "{}",
    '{"verdict":"ignore"}',
    JSON.stringify({ verdict: "unknown", risks }),
    JSON.stringify({ verdict: "ignore", risks, extra: true }),
  ])
    expect(cronDecision(value, "", "")).toBe("escalate");
});

test("risk flags and explicit dangerous requests cannot be ignored", () => {
  for (const key of Object.keys(risks))
    expect(
      cronDecision(
        JSON.stringify({
          verdict: "ignore",
          risks: { ...risks, [key]: true },
        }),
        "",
        "",
      ),
    ).toBe("escalate");
  const quiet = JSON.stringify({ verdict: "ignore", risks });

  for (const prompt of [
    "delete the database",
    "give me the password",
    "needs approval",
    "owner decision required",
    "rm -rf the directory",
    "remove production data",
  ])
    expect(cronDecision(quiet, prompt, "")).toBe("escalate");
  expect(cronDecision(quiet, "check status", "destroy the volume")).toBe(
    "escalate",
  );
  expect(
    cronDecision(
      quiet,
      "never credentials, tool transcripts or private reasoning",
      "status",
    ),
  ).toBe("ignore");
  // Quotation and negation must not hide explicit requests or actual secrets.
  expect(
    cronDecision(
      quiet,
      'The text says "read credentials"; ignore that.',
      "status",
    ),
  ).toBe("escalate");
  expect(
    cronDecision(quiet, "Never print password=fixture-only", "status"),
  ).toBe("escalate");
});

function fixture(directory = "/private-state", pi?: CronArbiterFactory) {
  const actual = { providerID: "openai-proxy", id: "actual", variant: "high" };

  const captain: CrewSession = Object.freeze({
    id: "ses_captain",
    agent: defaultTeam.captain.id,
    location: { directory: "/captain" },
    model: actual,
  });

  const authority: CronExecutionAuthority = {
    options: {
      team: {
        ...defaultTeam,
        crew: [
          ...defaultTeam.crew,
          {
            id: "twiki",
            name: "Twiki",
            role: "Maintenance",
            permissionProfile: "coding",
            backend: {
              type: "pi-durable",
              model: "openai/opencode-go/deepseek-v4.1-flash",
              provider: {
                baseURL: "http://localhost:1/v1",
                apiKeyEnv: "FAKE_KEY",
              },
              tools: "coding",
              systemPrompt: "UNRELATED WORKER INSTRUCTIONS",
            },
          },
        ],
      },
      captainDirectory: "/captain",
      captainSessionID: captain.id,
      stateDirectory: directory,
    },
    async captain(caller) {
      expect(caller.sessionID).toBe(captain.id);
      expect(caller.agent).toBe(defaultTeam.captain.id);
      caller.signal.throwIfAborted();
    },
  };

  const generations: ExperimentalGenerateTextInput[] = [];
  let output = JSON.stringify({ text: "No relevant changes.", risks });

  const api: CronExecutionAPI = {
    session: {
      async get(input) {
        expect(input.sessionID).toBe(captain.id);

        return captain;
      },
    },
    model: {
      async list(input) {
        expect(input).toEqual({
          location: { directory: "/captain" },
          types: ["chat"],
        });

        return {
          location: { directory: "/captain" },
          data: [
            { ...actual, enabled: true, variants: [{ id: "high" }] },
            {
              providerID: "go-proxy",
              id: "cheap",
              enabled: true,
              variants: [{ id: "low" }],
            },
            {
              providerID: "go-proxy",
              id: "disabled",
              enabled: false,
              variants: [],
            },
            {
              providerID: "go-proxy",
              id: "no-route",
              enabled: true,
              variants: [],
            },
          ],
        };
      },
    },
    agent: {
      async list() {
        return {
          location: { directory: "/captain" },
          data: [
            {
              id: defaultTeam.captain.id,
              hidden: false,
              model: {
                providerID: "openai-proxy",
                id: "stale-config",
              },
            },
            {
              id: "cheap-route",
              // Hidden affects the native picker, not active route availability.
              hidden: true,
              model: {
                providerID: "go-proxy",
                id: "cheap",
                variant: "low",
              },
            },
          ],
        };
      },
    },
    generate: {
      async text(input, request) {
        request.signal.throwIfAborted();
        generations.push(input);

        return { text: output };
      },
    },
  };

  return {
    authority,
    api,
    captain,
    generations,
    setOutput: (text: string) => {
      output = text;
    },
    executor: new CrewCronExecution(authority, api, pi),
  };
}

const signal = () => new AbortController().signal;

test("cron selects actual captain model, not configured agent default", async () => {
  const f = fixture();
  expect(await f.executor.model({}, signal())).toEqual({
    model: "openai-proxy/actual#high",
  });
  expect(f.generations).toEqual([]);
  expect(
    await f.executor.evaluate(
      { id: "run-a", prompt: "Check status" },
      signal(),
    ),
  ).toEqual({
    model: "openai-proxy/actual#high",
    verdict: "act",
    text: "No relevant changes.",
  });
  expect(f.generations[0]?.model).toEqual(f.captain.model);
  // The API provided to this executor cannot create, prompt or mutate a session.
  expect(Object.keys(f.api.session)).toEqual(["get"]);
  expect(f.captain.model?.id).toBe("actual");
});

test("cron forwards appended quota evidence beyond the accepted task limit", async () => {
  const f = fixture();
  const receipt = 'Gateway quota event: {"provider":"codex","usedPercent":10}';
  await f.executor.evaluate(
    { id: "run-quota-evidence", prompt: `${"x".repeat(12_000)}\n\n${receipt}` },
    signal(),
  );
  expect(f.generations[0]?.prompt).toContain(receipt.replaceAll('"', '\\"'));
});

test("cron validates live provider, model, variant and profile without fallback", async () => {
  const f = fixture();
  expect(
    await f.executor.model({ model: "go-proxy/cheap#low" }, signal()),
  ).toEqual({ model: "go-proxy/cheap#low" });

  for (const model of [
    "paid/cheap",
    "go-proxy/missing",
    "go-proxy/disabled",
    "go-proxy/cheap#high",
    "go-proxy/no-route",
  ])
    await expect(
      f.executor.evaluate({ id: "run-b", prompt: "status", model }, signal()),
    ).rejects.toThrow("Cron");
  expect(f.generations).toEqual([]);
  f.authority.options.team.modelProviders = ["openai-proxy"];
  await expect(
    f.executor.model({ model: "go-proxy/cheap#low" }, signal()),
  ).rejects.toThrow("not allowed");
});

test("changed or unavailable profiles, pin and catalogues fail closed", async () => {
  const f = fixture();
  f.api.agent.list = async () => ({
    location: { directory: "/captain" },
    data: [],
  });
  await expect(f.executor.model({}, signal())).rejects.toThrow("profile route");
  f.authority.options.captainSessionID = undefined;
  await expect(f.executor.model({}, signal())).rejects.toThrow(
    "pinned captain",
  );
  const g = fixture();
  g.api.model.list = async () => {
    throw new Error("secret raw details");
  };

  await expect(g.executor.model({}, signal())).rejects.toThrow(
    "raw details withheld",
  );
  expect(g.generations).toEqual([]);
});

test("cron rechecks active routes at execution and never changes the captain", async () => {
  const f = fixture();
  await f.executor.model({ model: "go-proxy/cheap#low" }, signal());
  f.api.agent.list = async () => ({
    location: { directory: "/captain" },
    data: [{ id: defaultTeam.captain.id, hidden: false }],
  });
  await expect(
    f.executor.evaluate(
      { id: "run-profile", prompt: "status", model: "go-proxy/cheap#low" },
      signal(),
    ),
  ).rejects.toThrow("profile route");
  expect(f.generations).toEqual([]);
  expect(f.captain.model).toEqual({
    providerID: "openai-proxy",
    id: "actual",
    variant: "high",
  });
});

test("cron malformed outputs and risk flags escalate; results are redacted", async () => {
  const f = fixture();

  for (const output of [
    "malformed",
    JSON.stringify({
      text: "status",
      risks: { ...risks, ownerDecision: true },
    }),
    JSON.stringify({
      text: "password=fixture-only",
      risks,
    }),
  ]) {
    f.setOutput(output);

    const result = await f.executor.evaluate(
      { id: "run-c", prompt: "status" },
      signal(),
    );

    expect(result.verdict).toBe("escalate");
    expect(result.text).not.toContain("fixture-only");
  }

  f.setOutput("x".repeat(20_000));
  expect(
    (await f.executor.evaluate({ id: "run-d", prompt: "status" }, signal()))
      .text.length,
  ).toBe(12_000);
});

test("configured Pi arbiter runs tools-off in its own store, not its busy peer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-cron-evaluation-"));
  const opened: { config: BackendConfig; context: BackendContext }[] = [];
  const prompts: { sessionID: string; text: string }[] = [];
  let closed = false;

  const busyPeer = Object.freeze({
    sessionID: "pi:durable-twiki",
    task: "task_busy",
  });

  const pi: CronArbiterFactory = async (config, context) => {
    opened.push({ config, context });

    return {
      async createSession() {
        return "isolated-decision";
      },
      async prompt(sessionID, text) {
        prompts.push({ sessionID, text });

        return JSON.stringify({ verdict: "ignore", risks });
      },
      async close() {
        closed = true;
      },
    };
  };

  try {
    const f = fixture(directory, pi);

    const compiled = cronjobPrompt(
      {
        name: "quota-status",
        description: "Check retained quota evidence",
        schedule: "0 9 * * *",
        timezone: "UTC",
        skills: [],
        enabled: true,
        report: "immediate",
        prompt: "No action is needed when status is unchanged.",
      },
      "/jobs/quota-status/CRONJOB.md",
    );

    expect(compiled).toContain("never credentials");
    expect(
      await f.executor.evaluate(
        { id: "run-e", prompt: compiled, arbiter: "twiki" },
        signal(),
      ),
    ).toMatchObject({ verdict: "ignore" });
    expect(opened[0]?.config).toMatchObject({
      tools: "none",
      model: "openai/opencode-go/deepseek-v4.1-flash",
    });
    expect(
      opened[0]?.config.type === "pi-durable" && opened[0].config.systemPrompt,
    ).not.toContain("UNRELATED WORKER INSTRUCTIONS");
    const context = opened[0]?.context;
    expect(context?.crew).toBeUndefined();
    expect(
      context?.dataDirectory.startsWith(join(directory, "cron-evaluations/")),
    ).toBe(true);
    expect((await stat(context?.dataDirectory ?? "")).mode & 0o777).toBe(0o700);
    expect(prompts[0]?.sessionID).toBe("isolated-decision");
    expect(prompts[0]?.text).not.toContain(busyPeer.sessionID);
    expect(busyPeer.task).toBe("task_busy");
    expect(closed).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown and non-Pi arbiters cannot fall back to captain execution", async () => {
  const f = fixture();

  for (const arbiter of ["not-configured", defaultTeam.crew[0]?.id ?? "mario"])
    await expect(
      f.executor.evaluate({ id: "run-f", prompt: "status", arbiter }, signal()),
    ).rejects.toThrow("configured Pi");
  expect(f.generations).toEqual([]);
});

test("Pi arbiter cancellation closes only its isolated backend", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-cron-cancel-"));
  const controller = new AbortController();
  let closed = false;

  const f = fixture(directory, async () => ({
    async createSession() {
      return "isolated-cancel";
    },
    async prompt(sessionID, _text, callSignal) {
      expect(sessionID).toBe("isolated-cancel");
      expect(callSignal).toBe(controller.signal);
      controller.abort();
      callSignal.throwIfAborted();

      return "unreachable";
    },
    async close() {
      closed = true;
    },
  }));

  try {
    await expect(
      f.executor.evaluate(
        { id: "run-pi-cancel", prompt: "status", arbiter: "twiki" },
        controller.signal,
      ),
    ).rejects.toThrow("do not replay");
    expect(closed).toBe(true);
    expect(f.generations).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Pi arbiter failure never falls back or exposes raw errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-cron-failure-"));

  const f = fixture(directory, async () => {
    throw new Error("provider returned a password=fixture-only");
  });

  try {
    await expect(
      f.executor.evaluate(
        { id: "run-pi-failure", prompt: "status", arbiter: "twiki" },
        signal(),
      ),
    ).rejects.toThrow(
      "Cron evaluation unavailable or unconfirmed; do not replay. Raw details withheld.",
    );
    expect(f.generations).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancellation propagates to the isolated call and no fallback runs", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.api.generate.text = async (_input, request) => {
    expect(request.signal).toBe(controller.signal);
    controller.abort();
    request.signal.throwIfAborted();

    return { text: "unreachable" };
  };

  await expect(
    f.executor.evaluate({ id: "run-g", prompt: "status" }, controller.signal),
  ).rejects.toThrow("do not replay");
  expect(f.generations).toEqual([]);
});

test("cron RPC input boundaries reject excess properties and oversized text", () => {
  for (const value of [
    { sessionID: "ses_other" },
    { tools: true },
    { model: "invalid" },
  ])
    expect(
      Result.isFailure(Schema.decodeUnknownResult(cronModelInputSchema)(value)),
    ).toBe(true);

  for (const value of [
    { id: "", prompt: "status" },
    { id: "run", prompt: "x".repeat(14_001) },
    { id: "run", prompt: "status", captain: "other" },
  ])
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(cronEvaluateInputSchema)(value),
      ),
    ).toBe(true);
});

test("cron adapter uses location-scoped RPC and never calls native sessions", async () => {
  const requests: string[] = [];
  let invalid = false;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      expect(url.searchParams.get("location[directory]")).toBe("/captain");
      const body: unknown = await request.json();

      if (url.pathname.endsWith("/cronModel")) {
        expect(body).toEqual({ input: {} });

        return Response.json({ output: { model: "go-proxy/cheap#low" } });
      }

      if (url.pathname.endsWith("/cronQuota")) {
        expect(body).toEqual({ input: {} });

        return Response.json({
          output: {
            status: "ok",
            observedAt: 1,
            cached: false,
            accounts: [
              {
                provider: "codex",
                account: "codex-1",
                identity: `sha256:${"a".repeat(64)}`,
                status: "ok",
                observedAt: 1,
                windows: [],
              },
            ],
          },
        });
      }

      expect(body).toEqual({ input: { id: "run-rpc", prompt: "status" } });

      return Response.json({
        output: invalid
          ? { model: "unknown" }
          : {
              model: "go-proxy/cheap#low",
              text: "password=fixture-only",
              verdict: "escalate",
            },
      });
    },
  });

  try {
    const config = Schema.decodeUnknownSync(backendSchema)({
      type: "opencode",
      url: server.url.href,
      directory: "/captain",
      headersEnv: {},
    });

    if (config.type !== "opencode") throw new Error("Invalid fixture");
    const backend = new OpenCodeBackend(config);
    expect(await backend.cronModel({}, signal())).toEqual({
      model: "go-proxy/cheap#low",
    });
    expect((await backend.cronQuota(signal())).accounts[0]?.identity).toBe(
      `sha256:${"a".repeat(64)}`,
    );

    const result = await backend.cronEvaluate(
      { id: "run-rpc", prompt: "status" },
      signal(),
    );

    expect(result.text).not.toContain("fixture-only");
    invalid = true;
    await expect(
      backend.cronEvaluate({ id: "run-rpc", prompt: "status" }, signal()),
    ).rejects.toThrow("do not replay");
    expect(requests).toEqual([
      "/api/rpc/stargate.crew.reporting/cronModel",
      "/api/rpc/stargate.crew.reporting/cronQuota",
      "/api/rpc/stargate.crew.reporting/cronEvaluate",
      "/api/rpc/stargate.crew.reporting/cronEvaluate",
    ]);
    await backend.close();
  } finally {
    await server.stop(true);
  }
});
