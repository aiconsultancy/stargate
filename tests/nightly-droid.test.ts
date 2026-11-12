import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { type Config, configSchema } from "../src/config";
import { CrewState } from "../src/crew/state";
import { maintenanceSchema } from "../src/nightly/config";
import {
  type DroidDependencies,
  droidDirectory,
  runDroid,
} from "../src/nightly/droid";
import type { DroidAgent, DroidTools } from "../src/nightly/droid-agent";
import { openPiDroid } from "../src/nightly/droid-agent";
import { digestReport } from "../src/nightly/droid-facts";
import type { CommandResult, CommandRunner } from "../src/nightly/exec";
import type { OpenCodeControl } from "../src/nightly/opencode";
import { type Report, writeAlert, writeReport } from "../src/nightly/report";
import { updateState } from "../src/nightly/state";
import { buildDroidUnits } from "../src/nightly/timer";
import { stableJitter } from "../src/nightly/window";

const base = await mkdtemp("/tmp/opencode/pogo-droid-");
afterAll(async () => {
  server.stop(true);
  await rm(base, { recursive: true, force: true });
});

// Fixture secrets: none may reach a prompt, a tool result, a post or the log.
const secrets = {
  clientKey: "fixture-client-key-4f1d9a",
  providerKey: "fixture-provider-key-8c2e7b",
  releaseToken: "fixture-release-token-1a6c3e",
  botToken: "xoxb-fixture-bot-token-77",
  appToken: "xapp-fixture-app-token-55",
};
const env = {
  POGO_DROID_TEST_KEY: secrets.providerKey,
  POGO_RELEASE_TOKEN: secrets.releaseToken,
  BOT_TOKEN: secrets.botToken,
  APP_TOKEN: secrets.appToken,
};
process.env["POGO_DROID_TEST_KEY"] = secrets.providerKey;

// ---- Local proxy fixture: health and a scripted chat model ---------------
type Chat = { headers: Headers; body: string };
const proxy = {
  down: false,
  chats: [] as Chat[],
  /** One response per chat request: tool calls or text; "fail" is a 401. */
  script: [] as (
    | { tools: { name: string; arguments: object }[] }
    | { text: string }
    | "fail"
  )[],
};
const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: "fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: "opencode-go/deepseek-v4.1-flash",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/v1/models") {
      if (
        proxy.down ||
        request.headers.get("authorization") !== `Bearer ${secrets.clientKey}`
      )
        return new Response("down", { status: 503 });
      return Response.json({ data: [{ id: "gpt-6.1-sol" }] });
    }
    const body = await request.text();
    proxy.chats.push({ headers: request.headers, body });
    const next = proxy.script.shift() ?? { text: "Nothing to add." };
    if (next === "fail")
      return Response.json(
        { error: { message: "denied", type: "authentication_error" } },
        { status: 401 },
      );
    const stream =
      "tools" in next
        ? chunk({
            role: "assistant",
            tool_calls: next.tools.map((call, index) => ({
              index,
              id: `call_${proxy.chats.length}_${index}`,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            })),
          }) + chunk({}, "tool_calls")
        : chunk({ role: "assistant", content: next.text }) + chunk({}, "stop");
    return new Response(`${stream}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  },
});
const url = `http://127.0.0.1:${server.port}`;

// ---- Host fixture: systemd units, gateway readiness, OpenCode ------------
const now = Date.parse("2026-11-12T12:00:00Z");
/** This install's planned start last night (00:00 Europe/London + jitter). */
const plannedStart = new Date(
  Date.parse("2026-11-12T00:00:00Z") +
    stableJitter("test-install", 15) * 60_000,
).toISOString();
const at = (iso: string) => `@${Math.floor(Date.parse(iso) / 1000)}`;
type Units = Record<string, Record<string, string>>;
const host = {
  dir: "",
  units: {} as Units,
  commands: [] as string[],
  busy: [] as string[],
  /** The fixture clock; sleeps advance it and readiness records use it. */
  time: 0,
  /** OpenCode `session.active` calls; `arrive` can make work appear later. */
  activeCalls: 0,
  arrive: undefined as ((call: number) => string[]) | undefined,
};

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const runner: CommandRunner = {
  async run(command) {
    const text = command.join(" ");
    host.commands.push(text);
    const [tool, scope, action, unit = ""] = command;
    if (tool !== "systemctl" || scope !== "--user")
      return { code: 127, stdout: "", stderr: "" };
    const values = host.units[unit] ?? {
      LoadState: "not-found",
      ActiveState: "inactive",
    };
    if (action === "show")
      return ok(
        Object.entries(values)
          .map(([key, value]) => `${key}=${value}`)
          .join("\n"),
      );
    if (action === "is-active") return ok(`${values["ActiveState"]}\n`);
    if (action === "restart" || action === "start") {
      host.units[unit] = { ...values, ActiveState: "active" };
      if (unit === "pogo.service") await ready();
      return ok();
    }
    return { code: 1, stdout: "", stderr: "" };
  },
};
const ready = () =>
  writeFile(
    join(host.dir, "data", "ready.json"),
    JSON.stringify({
      schema: "pogo.ready.v1",
      pid: process.pid,
      readyAt: host.time,
      version: "0.2.0",
    }),
  );
const opencode = {
  active: async () => {
    host.activeCalls++;
    return host.arrive?.(host.activeCalls) ?? host.busy;
  },
  pendingInput: async () => false,
} as unknown as OpenCodeControl;

let agentPrompts: string[] = [];
/** A model stand-in that calls the given tools, then answers. */
function scripted(
  run: (tools: DroidTools) => Promise<string>,
): DroidDependencies["openAgent"] {
  return async (): Promise<DroidAgent> => ({
    async ask({ prompt, tools }) {
      agentPrompts.push(prompt);
      return run(tools);
    },
    async close() {},
  });
}
let opened = 0;
const deps = (
  openAgent: DroidDependencies["openAgent"] = scripted(
    async () => "Everything looks fine.",
  ),
): DroidDependencies => ({
  runner,
  clock: {
    now: () => host.time,
    sleep: async (ms) => {
      host.time += ms;
    },
  },
  connect: async () => opencode,
  env,
  uuid: () => crypto.randomUUID(),
  openAgent: async (settings, directory) => {
    opened++;
    return openAgent(settings, directory);
  },
});

const healthyUnits = (): Units => ({
  "pogo-maintenance.timer": {
    LoadState: "loaded",
    ActiveState: "active",
    LastTriggerUSec: at(plannedStart),
    NextElapseUSecRealtime: at("2026-11-13T00:05:00Z"),
    Result: "success",
    ActiveEnterTimestamp: at("2026-11-01T00:00:00Z"),
  },
  "pogo-maintenance.service": { LoadState: "loaded", ActiveState: "inactive" },
  "pogo.service": { LoadState: "loaded", ActiveState: "active" },
  "opencode2.service": { LoadState: "loaded", ActiveState: "active" },
  "cpa.service": { LoadState: "loaded", ActiveState: "active" },
});

async function install(droid: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(base, "case-"));
  host.dir = dir;
  host.units = healthyUnits();
  host.commands = [];
  host.busy = [];
  host.activeCalls = 0;
  host.arrive = undefined;
  host.time = now;
  proxy.down = false;
  proxy.chats = [];
  proxy.script = [];
  agentPrompts = [];
  opened = 0;
  await mkdir(join(dir, "data", "maintenance"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(join(dir, "client.key"), `${secrets.clientKey}\n`, {
    mode: 0o600,
  });
  const raw = {
    dataDirectory: join(dir, "data"),
    bots: [
      {
        id: "helper",
        slack: {
          appId: "A123",
          appTokenEnv: "APP_TOKEN",
          botTokenEnv: "BOT_TOKEN",
        },
        access: { users: ["U123"], channels: ["C123"] },
        backend: {
          type: "opencode",
          url: "http://localhost:4096",
          directory: join(dir, "captain"),
        },
      },
    ],
    maintenance: {
      enabled: true,
      installID: "test-install",
      report: { bot: "helper", channel: "C123" },
      services: {
        gateway: "pogo.service",
        openCodeRestart: [
          "systemctl",
          "--user",
          "restart",
          "opencode2.service",
        ],
      },
      proxy: { url, clientKeyFile: join(dir, "client.key") },
      pogo: { root: join(dir, "pogo"), tokenEnv: "POGO_RELEASE_TOKEN" },
      cliproxyapi: {
        unit: "cpa.service",
        link: join(dir, "cpa-current"),
        binary: join(dir, "cpa", "{version}", "cliproxyapi"),
      },
      droid: {
        enabled: true,
        backend: {
          provider: {
            baseURL: `${url}/v1`,
            apiKeyEnv: "POGO_DROID_TEST_KEY",
          },
        },
        ...droid,
      },
    },
  };
  const config: Config = configSchema.parse(raw);
  await ready();
  return { config, path: join(dir, "pogo.json") };
}

function report(
  outcome: Report["outcome"],
  startedAt: string,
  extra: Partial<Report> = {},
): Report {
  return {
    schema: "pogo.maintenance.report.v1",
    runID: crypto.randomUUID(),
    installID: "test-install",
    mode: "run",
    outcome,
    window: {
      timeZone: "Europe/London",
      localStart: "00:00",
      localEnd: "01:00",
      opens: "2026-11-12T00:00:00.000Z",
      plannedStart: "2026-11-12T00:05:00.000Z",
      deadline: "2026-11-12T00:50:00.000Z",
      closes: "2026-11-12T01:00:00.000Z",
      jitterMinutes: 5,
    },
    startedAt,
    finishedAt: startedAt,
    components: [
      {
        id: "pogo",
        before: "0.2.0",
        after: outcome === "completed" ? "0.2.1" : "0.2.0",
        candidate: "0.2.1",
        status: outcome === "completed" ? "updated" : "deferred",
      },
    ],
    models: [],
    steps: [],
    rollbacks: [],
    restarts: [],
    ...extra,
  };
}

const journal = (config: Config, fields: object) =>
  writeFile(
    join(config.dataDirectory, "maintenance", "journal.json"),
    JSON.stringify({
      schema: "pogo.maintenance.journal.v2",
      runID: crypto.randomUUID(),
      ...fields,
    }),
    { mode: 0o600 },
  );

async function posts(config: Config) {
  const directory = join(config.dataDirectory, "maintenance", "outbox");
  const names = (await readdir(directory).catch(() => [] as string[])).filter(
    (name) => name.startsWith("droid-"),
  );
  return Promise.all(
    names.map(
      async (name) =>
        JSON.parse(await readFile(join(directory, name), "utf8")) as {
          channel: string;
          text: string;
        },
    ),
  );
}
async function auditLog(config: Config) {
  return (
    (await readFile(
      join(droidDirectory(config.dataDirectory), "audit.jsonl"),
      "utf8",
    ).catch(() => "")) as string
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
const check = (config: Config, path: string, d = deps()) =>
  runDroid(
    { config, configPath: path, signal: AbortSignal.timeout(30_000) },
    d,
  );

beforeEach(() => {
  host.busy = [];
});

describe("maintenance droid", () => {
  test("posts after a run with the model's explanation, then stays quiet", async () => {
    const { config, path } = await install();
    await writeReport(
      config.dataDirectory,
      report("completed", "2026-11-12T00:05:00.000Z"),
    );
    const first = await check(
      config,
      path,
      deps(
        scripted(
          async () => "Pogo moved to 0.2.1 overnight. Nothing needs you.",
        ),
      ),
    );
    expect(first).toMatchObject({
      trigger: "after-run",
      posted: true,
      model: true,
      findings: [],
    });
    const [post] = await posts(config);
    expect(post?.channel).toBe("C123");
    expect(post?.text).toContain("Pogo moved to 0.2.1 overnight.");
    expect(post?.text).toContain("Droid actions: none.");
    expect(post?.text).toContain("Checks: all clear.");
    expect(agentPrompts[0]).toContain("after the nightly run");
    expect(agentPrompts[0]).toContain("pogo updated 0.2.0 → 0.2.1");
    // The same report is explained once; a healthy noon check says nothing.
    const second = await check(config, path);
    expect(second).toMatchObject({ trigger: "health", posted: false });
    expect(opened).toBe(1);
    expect(await posts(config)).toHaveLength(1);
  });

  test("a healthy health check posts nothing and asks no model", async () => {
    const { config, path } = await install();
    const result = await check(config, path);
    expect(result).toMatchObject({
      trigger: "health",
      posted: false,
      findings: [],
    });
    expect(opened).toBe(0);
    expect(await posts(config)).toEqual([]);
    expect((await auditLog(config)).at(-1)).toMatchObject({
      kind: "post",
      status: "silent",
    });
  });

  test("each problem class raises its finding and a post", async () => {
    const cases: [string, (config: Config) => Promise<void>][] = [
      [
        "timer-inactive",
        async () => {
          host.units["pogo-maintenance.timer"] = {
            LoadState: "loaded",
            ActiveState: "inactive",
          };
        },
      ],
      [
        "timer-missed",
        async () => {
          const timer = host.units["pogo-maintenance.timer"] ?? {};
          timer["LastTriggerUSec"] = at("2026-11-11T00:05:00Z");
        },
      ],
      [
        "alert",
        async (config) => {
          await writeAlert(config.dataDirectory, {
            runID: crypto.randomUUID(),
            at: "2026-11-12T00:40:00.000Z",
            outcome: "failed",
            reason: "readiness-failed",
            report: null,
            journal: true,
          });
        },
      ],
      [
        "journal",
        (config) => journal(config, { gateway: { restartPending: true } }),
      ],
      [
        "journal-corrupt",
        async (config) => {
          await journal(config, { gateway: { restartPending: true } });
          await chmod(
            join(config.dataDirectory, "maintenance", "journal.json"),
            0o644,
          );
        },
      ],
      [
        "gateway-down",
        async () => {
          host.units["pogo.service"] = {
            LoadState: "loaded",
            ActiveState: "failed",
          };
        },
      ],
      [
        "opencode-down",
        async () => {
          host.units["opencode2.service"] = {
            LoadState: "loaded",
            ActiveState: "inactive",
          };
        },
      ],
      [
        "proxy-unhealthy",
        async () => {
          proxy.down = true;
        },
      ],
      [
        "runs-failing",
        async (config) => {
          for (const day of ["10", "11"])
            await writeReport(
              config.dataDirectory,
              report("deferred", `2026-11-${day}T00:05:00.000Z`, {
                reason: "busy-opencode",
              }),
            );
          // Already explained: this is the health check, not a post-run one.
          await mkdir(droidDirectory(config.dataDirectory), {
            recursive: true,
          });
          const names = await readdir(
            join(config.dataDirectory, "maintenance", "reports"),
          );
          await writeFile(
            join(droidDirectory(config.dataDirectory), "state.json"),
            JSON.stringify({
              schema: "pogo.maintenance.droid.v1",
              lastReport: names.sort().at(-1),
            }),
          );
        },
      ],
      [
        "known-bad",
        (config) =>
          updateState(config.dataDirectory, (state) => {
            state.failedReleases["0.3.0"] = {
              reason: "readiness-failed",
              at: "2026-11-11T00:30:00.000Z",
            };
          }),
      ],
    ];
    for (const [code, setup] of cases) {
      const { config, path } = await install();
      await setup(config);
      const result = await check(config, path);
      expect(result.findings).toEqual([code]);
      expect(result.posted).toBe(true);
      const [post] = await posts(config);
      expect(post?.text).toContain(`Checks: ${code}.`);
    }
  });

  test("a failed model call falls back to the deterministic summary", async () => {
    const { config, path } = await install();
    host.units["pogo.service"] = { LoadState: "loaded", ActiveState: "failed" };
    const failing = scripted(async () => {
      throw new Error(`upstream said ${secrets.providerKey}`);
    });
    const result = await check(config, path, deps(failing));
    expect(result).toMatchObject({ posted: true, model: false });
    const [post] = await posts(config);
    expect(post?.text).toContain("pogo.service is failed");
    expect(post?.text).toContain("deterministic summary");
    expect(post?.text).toContain("systemctl --user status pogo.service");
    expect(post?.text).not.toContain(secrets.providerKey);
    expect(await auditLog(config)).toContainEqual(
      expect.objectContaining({ kind: "model", status: "fallback" }),
    );
    // An agent that cannot even open (missing key, bad config) also falls back.
    const second = await install();
    host.units["pogo.service"] = { LoadState: "loaded", ActiveState: "failed" };
    const broken: DroidDependencies["openAgent"] = async () => {
      throw new Error("Missing environment variable");
    };
    expect(await check(second.config, second.path, deps(broken))).toMatchObject(
      {
        posted: true,
        model: false,
      },
    );
  });

  test("recover runs only when its preconditions hold", async () => {
    const recoverTwice = scripted(async (tools) => {
      const first = await tools.recover();
      const second = await tools.recover();
      return `${first}\n${second}`;
    });
    // No journal and a running gateway: nothing to recover.
    const quiet = await install();
    proxy.down = true;
    await check(quiet.config, quiet.path, deps(recoverTwice));
    expect(host.commands.filter((c) => c.includes(" restart "))).toEqual([]);
    let [post] = await posts(quiet.config);
    expect(post?.text).toContain(
      "recover refused (there is no leftover journal and the gateway is not stopped)",
    );

    // A stopped gateway without a journal: allowed, but recover has no
    // journal to finish; it never starts a gateway someone stopped.
    const stopped = await install();
    host.units["pogo.service"] = {
      LoadState: "loaded",
      ActiveState: "inactive",
    };
    await check(stopped.config, stopped.path, deps(recoverTwice));
    expect(host.commands.filter((c) => /restart|start /.test(c))).toEqual([]);
    [post] = await posts(stopped.config);
    expect(post?.text).toContain("recover found nothing to recover");
    expect(post?.text).toContain("Checks: gateway-down.");

    // A leftover journal on an idle host: recovered once, then refused.
    const left = await install();
    await journal(left.config, { gateway: { restartPending: true } });
    await check(left.config, left.path, deps(recoverTwice));
    expect(
      host.commands.filter(
        (c) => c === "systemctl --user restart pogo.service",
      ),
    ).toHaveLength(1);
    [post] = await posts(left.config);
    expect(post?.text).toContain("recover finished");
    expect(post?.text).toContain(
      "recover refused (already requested in this check)",
    );
    expect(
      await readFile(
        join(left.config.dataDirectory, "maintenance", "journal.json"),
      ).catch(() => null),
    ).toBeNull();

    // Busy host, active run, or a held run lock: refused or not run.
    for (const block of ["busy", "run", "lock"] as const) {
      const { config, path } = await install();
      await journal(config, { gateway: { restartPending: true } });
      // A fresh report makes this a post-run check, which always posts.
      await writeReport(
        config.dataDirectory,
        report("failed", "2026-11-12T00:05:00.000Z"),
      );
      let held: Database | undefined;
      if (block === "busy") host.busy = ["ses_operator"];
      if (block === "run")
        host.units["pogo-maintenance.service"] = {
          LoadState: "loaded",
          ActiveState: "active",
        };
      if (block === "lock") {
        held = new Database(
          join(config.dataDirectory, "maintenance", "run.sqlite"),
          { create: true },
        );
        held.exec("BEGIN EXCLUSIVE;");
      }
      try {
        await check(config, path, deps(recoverTwice));
      } finally {
        held?.close();
      }
      expect(host.commands.filter((c) => c.includes(" restart "))).toEqual([]);
      [post] = await posts(config);
      expect(post?.text).toContain(
        block === "busy"
          ? "recover deferred (the host is busy: busy-opencode)"
          : block === "run"
            ? "recover refused (a maintenance run is active)"
            : "recover did not finish",
      );
    }
  });

  test("recover is limited per day across checks", async () => {
    const { config, path } = await install({ maxRecoversPerDay: 2 });
    const recover = scripted(async (tools) => tools.recover());
    for (let i = 0; i < 3; i++) {
      await journal(config, { gateway: { restartPending: true } });
      await check(config, path, deps(recover));
    }
    expect(
      host.commands.filter(
        (c) => c === "systemctl --user restart pogo.service",
      ),
    ).toHaveLength(2);
    const log = await auditLog(config);
    expect(
      log.filter((e) => e["action"] === "recover" && e["status"] === "started"),
    ).toHaveLength(2);
    expect(log).toContainEqual(
      expect.objectContaining({
        action: "recover",
        status: "refused",
        detail: "the daily limit of 2 recover(s) is reached",
      }),
    );
  });

  test("plan runs once per check and returns its summary", async () => {
    const { config, path } = await install();
    host.units["opencode2.service"] = {
      LoadState: "loaded",
      ActiveState: "failed",
    };
    let seen = "";
    await check(
      config,
      path,
      deps(
        scripted(async (tools) => {
          seen = await tools.plan();
          return `${await tools.plan()}`;
        }),
      ),
    );
    expect(seen).toContain(
      "Nightly maintenance 00:00–01:00 Europe/London: planned.",
    );
    const [post] = await posts(config);
    expect(post?.text).toContain(
      "Droid actions: plan planned; plan refused (already requested in this check).",
    );
    const log = await auditLog(config);
    expect(
      log.filter((e) => e["action"] === "plan").map((e) => e["status"]),
    ).toEqual(["started", "ok", "refused"]);
    expect(
      await readFile(
        join(droidDirectory(config.dataDirectory), "audit.jsonl"),
        "utf8",
      ),
    ).not.toContain(secrets.clientKey);
    expect(
      (await stat(join(droidDirectory(config.dataDirectory), "audit.jsonl")))
        .mode & 0o777,
    ).toBe(0o600);
  });

  test("prompts, tool results and posts never carry secrets", async () => {
    const { config, path } = await install();
    await writeReport(
      config.dataDirectory,
      report("failed", "2026-11-12T00:05:00.000Z", { reason: "health-failed" }),
    );
    await journal(config, { gateway: { restartPending: true } });
    const seen: string[] = [];
    await check(
      config,
      path,
      deps(
        scripted(async (tools) => {
          seen.push(JSON.stringify(await tools.status()));
          seen.push(JSON.stringify(await tools.reports(5)));
          // A model that echoes a secret it guessed is redacted.
          return `Done. token=${secrets.releaseToken} ${secrets.botToken} ${secrets.providerKey}`;
        }),
      ),
    );
    const [post] = await posts(config);
    const everything = [...agentPrompts, ...seen, post?.text ?? ""].join("\n");
    for (const value of Object.values(secrets))
      expect(everything).not.toContain(value);
    expect(seen[0]).toContain('"entries":["gateway"]');
  });
});

describe("maintenance droid previews and timeouts", () => {
  test("--print shows the deterministic post and writes nothing", async () => {
    const { config, path } = await install();
    host.units["pogo.service"] = {
      LoadState: "loaded",
      ActiveState: "inactive",
    };
    const result = await runDroid(
      {
        config,
        configPath: path,
        signal: AbortSignal.timeout(30_000),
        preview: true,
      },
      deps(),
    );
    expect(result).toMatchObject({ posted: false, findings: ["gateway-down"] });
    expect(result.text).toContain("Checks: gateway-down.");
    expect(opened).toBe(0);
    expect(await posts(config)).toEqual([]);
    expect(
      await stat(droidDirectory(config.dataDirectory)).catch(() => null),
    ).toBeNull();
  });

  test("a model that times out does not cut off a running recover", async () => {
    const { config, path } = await install({ timeoutMinutes: 1 });
    await journal(config, { gateway: { restartPending: true } });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: CommandRunner = {
      async run(command, options) {
        if (command.join(" ") === "systemctl --user restart pogo.service")
          await gate;
        return runner.run(command, options);
      },
    };
    const d = deps(
      scripted(async (tools) => {
        // The model gives up while the recover still runs.
        void tools.recover();
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error("model timeout");
      }),
    );
    d.runner = slow;
    const done = check(config, path, d);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await posts(config)).toEqual([]);
    release();
    expect(await done).toMatchObject({ posted: true, model: false });
    const [post] = await posts(config);
    expect(post?.text).toContain("Droid actions: recover finished.");
  });
});

describe("maintenance droid on Pi Durable", () => {
  test("the model works only through the droid tools; payloads hold no secrets", async () => {
    const { config, path } = await install();
    await journal(config, { gateway: { restartPending: true } });
    proxy.script = [
      // A tool that does not exist is not a power the model has.
      { tools: [{ name: "bash", arguments: { command: "systemctl stop x" } }] },
      { tools: [{ name: "maintenance_status", arguments: {} }] },
      { tools: [{ name: "maintenance_recover", arguments: {} }] },
      { text: "Finished the leftover journal; the gateway is back." },
    ];
    const result = await check(
      config,
      path,
      deps((settings, directory) =>
        openPiDroid(settings.backend, directory, {
          harness: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 } },
        }),
      ),
    );
    expect(result).toMatchObject({ posted: true, model: true });
    expect(proxy.chats).toHaveLength(4);
    // Only Pogo's own commands ran: unit reads and the one gateway restart.
    expect(
      host.commands.filter(
        (c) => !/^systemctl --user (show|is-active) /.test(c),
      ),
    ).toEqual(["systemctl --user restart pogo.service"]);
    const [post] = await posts(config);
    expect(post?.text).toContain(
      "Finished the leftover journal; the gateway is back.",
    );
    expect(post?.text).toContain("Droid actions: recover finished.");
    const tools = JSON.parse(proxy.chats[0]?.body ?? "{}").tools as {
      function: { name: string };
    }[];
    expect(tools.map((t) => t.function.name).sort()).toEqual([
      "maintenance_plan",
      "maintenance_recover",
      "maintenance_reports",
      "maintenance_status",
    ]);
    for (const chat of proxy.chats) {
      expect(chat.headers.get("authorization")).toBe(
        `Bearer ${secrets.providerKey}`,
      );
      for (const value of Object.values(secrets))
        expect(chat.body).not.toContain(value);
    }
    // The status tool result reached the model.
    expect(proxy.chats[2]?.body).toContain("gateway");
  });

  test("a provider failure falls back to the deterministic summary", async () => {
    const { config, path } = await install();
    host.units["pogo.service"] = { LoadState: "loaded", ActiveState: "failed" };
    proxy.script = ["fail", "fail", "fail", "fail"];
    const result = await check(
      config,
      path,
      deps((settings, directory) =>
        openPiDroid(settings.backend, directory, {
          harness: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 } },
        }),
      ),
    );
    expect(result).toMatchObject({ posted: true, model: false });
    const [post] = await posts(config);
    expect(post?.text).toContain("deterministic summary");
    expect(post?.text).not.toContain("denied");
  });
});

describe("droid configuration and units", () => {
  test("the droid needs a report destination and a coherent model", () => {
    const base = { report: { bot: "helper", channel: "C123" } };
    expect(
      maintenanceSchema.parse({
        ...base,
        droid: {
          backend: {
            provider: { baseURL: "http://127.0.0.1:8317/v1", apiKeyEnv: "K" },
          },
        },
      }).droid,
    ).toMatchObject({
      enabled: false,
      backend: { model: "openai/opencode-go/deepseek-v4.1-flash" },
      healthCheck: "12:00",
      maxRecoversPerDay: 2,
    });
    for (const droid of [
      // The default model goes through the proxy: a provider is required.
      { enabled: true },
      // The proxy provider serves only the named DeepSeek and Haiku models.
      {
        backend: {
          model: "openai/gpt-5",
          provider: { baseURL: "http://127.0.0.1:8317/v1", apiKeyEnv: "K" },
        },
      },
      {
        backend: {
          model: "anthropic/claude-opus-5-5",
          provider: { baseURL: "http://127.0.0.1:8317/v1", apiKeyEnv: "K" },
        },
      },
      // Never a key value, only an environment reference.
      {
        backend: {
          provider: { baseURL: "http://127.0.0.1:8317/v1", apiKey: "raw" },
        },
      },
    ])
      expect(() => maintenanceSchema.parse({ ...base, droid })).toThrow();
    expect(
      maintenanceSchema.parse({
        ...base,
        droid: {
          backend: {
            model: "anthropic/claude-haiku-5-5",
            provider: { baseURL: "http://127.0.0.1:8317/v1", apiKeyEnv: "K" },
          },
        },
      }).droid?.backend.model,
    ).toBe("anthropic/claude-haiku-5-5");
    expect(() =>
      maintenanceSchema.parse({
        droid: {
          enabled: true,
          backend: { model: "anthropic/claude-sonnet-5" },
        },
      }),
    ).toThrow("report");
  });

  test("the droid timer checks after the window and at the health time", () => {
    const units = buildDroidUnits({
      name: "pogo-maintenance-droid",
      configPath: "/home/me/.config/pogo/pogo.json",
      executable: "/usr/bin/bun",
      entrypoint: "/home/me/.local/share/pogo/current/src/main.ts",
      path: "/usr/bin:/bin",
      spec: {
        start: "00:00",
        end: "01:00",
        timeZone: "Europe/London",
        jitterMinutes: 15,
        reserveMinutes: 10,
      },
      afterRunMinutes: 15,
      healthCheck: "12:00",
      timeoutMinutes: 40,
    });
    expect(units.timer).toContain("OnCalendar=*-*-* 01:15:00 Europe/London");
    expect(units.timer).toContain("OnCalendar=*-*-* 12:00:00 Europe/London");
    expect(units.timer).toContain("Persistent=false");
    expect(units.timer).toContain("Unit=pogo-maintenance-droid.service");
    expect(units.service).toContain(
      'ExecStart="/usr/bin/bun" "/home/me/.local/share/pogo/current/src/main.ts" maintenance droid --config "/home/me/.config/pogo/pogo.json"',
    );
    expect(units.service).toContain("UMask=0077");
    expect(units.service).toContain("TimeoutStartSec=40min");
    expect(units.service).not.toContain("ExecStopPost");
  });
});

describe("droid recover safety", () => {
  test("recover takes the run lock before it checks idle", async () => {
    const { config, path } = await install();
    await journal(config, { gateway: { restartPending: true } });
    await writeReport(
      config.dataDirectory,
      report("failed", "2026-11-12T00:05:00.000Z"),
    );
    const held = new Database(
      join(config.dataDirectory, "maintenance", "run.sqlite"),
      { create: true },
    );
    held.exec("BEGIN EXCLUSIVE;");
    try {
      await check(
        config,
        path,
        deps(scripted(async (tools) => tools.recover())),
      );
    } finally {
      held.close();
    }
    // No idle check, no undo: the lock decides first.
    expect(host.activeCalls).toBe(0);
    expect(host.commands.filter((c) => c.includes(" restart "))).toEqual([]);
    const [post] = await posts(config);
    expect(post?.text).toContain("recover did not finish");
  });

  test("work that arrives during the undo stops it before a restart", async () => {
    const { config, path } = await install();
    await journal(config, {
      gateway: { restartPending: true },
      openCode: { restarted: true, restartPending: true },
    });
    await writeReport(
      config.dataDirectory,
      report("failed", "2026-11-12T00:05:00.000Z"),
    );
    // Idle at the first check; a session starts before the OpenCode restart.
    host.arrive = (call) => (call >= 2 ? ["ses_new"] : []);
    await check(config, path, deps(scripted(async (tools) => tools.recover())));
    expect(host.commands.filter((c) => c.includes(" restart "))).toEqual([]);
    const left = JSON.parse(
      await readFile(
        join(config.dataDirectory, "maintenance", "journal.json"),
        "utf8",
      ),
    );
    expect(left.openCode).toEqual({ restarted: true, restartPending: true });
    expect(left.gateway).toEqual({ restartPending: true });
    const [post] = await posts(config);
    expect(post?.text).toContain(
      "recover deferred (the host is busy: busy-opencode)",
    );
  });

  test("the daily recover count survives audit log rotation", async () => {
    const { config, path } = await install({ maxRecoversPerDay: 2 });
    const recover = scripted(async (tools) => tools.recover());
    for (let i = 0; i < 2; i++) {
      await journal(config, { gateway: { restartPending: true } });
      await check(config, path, deps(recover));
    }
    // A flood of refused requests rotates today's recover entries out.
    const flood = JSON.stringify({
      at: new Date(now).toISOString(),
      checkID: crypto.randomUUID(),
      trigger: "health",
      kind: "action",
      action: "recover",
      status: "refused",
      detail: "x".repeat(400),
    });
    await writeFile(
      join(droidDirectory(config.dataDirectory), "audit.jsonl"),
      `${Array.from({ length: 2000 }, () => flood).join("\n")}\n`,
      { flag: "a" },
    );
    await journal(config, { gateway: { restartPending: true } });
    await check(config, path, deps(recover));
    expect(
      host.commands.filter(
        (c) => c === "systemctl --user restart pogo.service",
      ),
    ).toHaveLength(2);
    expect(
      (await posts(config)).filter((post) =>
        post.text.includes(
          "recover refused (the daily limit of 2 recover(s) is reached)",
        ),
      ),
    ).toHaveLength(1);
    const state = JSON.parse(
      await readFile(
        join(droidDirectory(config.dataDirectory), "state.json"),
        "utf8",
      ),
    );
    expect(state.recovers).toEqual({ "2026-11-12": 2 });
  });

  test("an unreadable droid state refuses recover and keeps today spent", async () => {
    const { config, path } = await install({ maxRecoversPerDay: 2 });
    await mkdir(droidDirectory(config.dataDirectory), { recursive: true });
    await writeFile(
      join(droidDirectory(config.dataDirectory), "state.json"),
      "{ damaged",
    );
    await journal(config, { gateway: { restartPending: true } });
    await writeReport(
      config.dataDirectory,
      report("failed", "2026-11-12T00:05:00.000Z"),
    );
    await check(config, path, deps(scripted(async (tools) => tools.recover())));
    expect(host.commands.filter((c) => c.includes(" restart "))).toEqual([]);
    const [post] = await posts(config);
    expect(post?.text).toContain(
      "recover refused (the droid state is unreadable)",
    );
    const state = JSON.parse(
      await readFile(
        join(droidDirectory(config.dataDirectory), "state.json"),
        "utf8",
      ),
    );
    expect(state.recovers).toEqual({ "2026-11-12": 2 });
  });

  test("secrets in reports and ALERT.json never reach the model", async () => {
    const { config, path } = await install();
    await writeReport(
      config.dataDirectory,
      report("failed", "2026-11-12T00:05:00.000Z", {
        reason: "health-failed",
        components: [
          {
            id: `npm:${secrets.providerKey}`,
            before: secrets.botToken,
            after: `token=${secrets.appToken}`,
            candidate: null,
            status: "failed",
          },
        ],
        steps: [
          {
            name: secrets.releaseToken,
            status: "failed",
            at: "2026-11-12T00:06:00.000Z",
          },
        ],
        rollbacks: [
          {
            component: `Bearer ${secrets.clientKey}`,
            from: "a",
            to: "b",
            status: "failed",
          },
        ],
      }),
    );
    await writeFile(
      join(config.dataDirectory, "maintenance", "ALERT.json"),
      JSON.stringify({
        schema: "pogo.maintenance.alert.v1",
        runID: secrets.releaseToken,
        at: "2026-11-12T00:40:00.000Z",
        outcome: secrets.providerKey,
        reason: secrets.appToken,
        report: `Bearer ${secrets.clientKey}`,
        journal: false,
      }),
      { mode: 0o600 },
    );
    await updateState(config.dataDirectory, (state) => {
      state.failedReleases["9.9.9"] = {
        reason: secrets.botToken,
        at: "2026-11-11T00:30:00.000Z",
      };
    });
    const seen: string[] = [];
    await check(
      config,
      path,
      deps(
        scripted(async (tools) => {
          seen.push(JSON.stringify(await tools.status()));
          seen.push(JSON.stringify(await tools.reports(7)));
          return "Summary.";
        }),
      ),
    );
    const [post] = await posts(config);
    expect(seen[1]).toContain("[REDACTED");
    const everything = [...agentPrompts, ...seen, post?.text ?? ""].join("\n");
    for (const value of Object.values(secrets))
      expect(everything).not.toContain(value);
  });
});

describe("droid scrubbing and dates", () => {
  // A configured secret without any credential-looking pattern.
  const long = `fixture-long-release-${"7c3f9a1e".repeat(6)}-end`.slice(0, 64);
  const longEnv = { ...env, POGO_RELEASE_TOKEN: long };
  const capture = async (config: Config, path: string) => {
    const seen: string[] = [];
    const d = deps(
      scripted(async (tools) => {
        seen.push(JSON.stringify(await tools.status()));
        seen.push(JSON.stringify(await tools.reports(7)));
        return "Summary.";
      }),
    );
    await check(config, path, { ...d, env: longEnv });
    const [post] = await posts(config);
    return [...agentPrompts, ...seen, post?.text ?? ""].join("\n");
  };

  test("a long secret is scrubbed before a fact field cuts it short", async () => {
    expect(long).toHaveLength(64);
    const { config, path } = await install();
    await writeReport(
      config.dataDirectory,
      report("failed", "2026-11-12T00:05:00.000Z", {
        components: [
          {
            id: "pogo",
            // Digests keep 40 characters of a version: the first 40 of the key.
            before: long,
            after: null,
            candidate: null,
            status: "failed",
          },
        ],
      }),
    );
    const everything = await capture(config, path);
    expect(everything).not.toContain(long.slice(0, 40));
    expect(everything).not.toContain(long.slice(0, 12));
    // The order itself, without the cut-boundary defence: scrub, then cut.
    const digest = digestReport(
      "r.json",
      report("failed", "2026-11-12T00:05:00.000Z", {
        components: [
          {
            id: "pogo",
            before: long,
            after: null,
            candidate: null,
            status: "failed",
          },
        ],
      }),
      (text) => text.replaceAll(long, "[REDACTED]"),
    );
    expect(digest.changed[0]?.before).toBe("[REDACTED]");
  });

  test("a secret already cut short where it was written is redacted at the cut", async () => {
    const { config, path } = await install();
    await writeReport(
      config.dataDirectory,
      report("failed", "2026-11-12T00:05:00.000Z", {
        // The report writer marks its own cuts with "…"; a field can also
        // simply end inside a secret.
        components: [
          {
            id: `npm:${long.slice(0, 30)}…`,
            before: null,
            after: null,
            candidate: null,
            status: "failed",
          },
        ],
        steps: [
          {
            name: `step ${long.slice(0, 20)}`,
            status: "failed",
            at: "2026-11-12T00:06:00.000Z",
          },
        ],
      }),
    );
    const everything = await capture(config, path);
    expect(everything).not.toContain(long.slice(0, 20));
    expect(everything).not.toContain(long.slice(0, 12));
    // Ordinary text that only shares a short prefix stays.
    expect(everything).toContain("npm:[REDACTED]");
  });

  test("a recover admitted after midnight counts against the new day", async () => {
    const { config, path } = await install({ maxRecoversPerDay: 1 });
    await journal(config, { gateway: { restartPending: true } });
    // Yesterday's recover is spent; the check starts a few seconds before
    // midnight (Europe/London is UTC in November).
    await mkdir(droidDirectory(config.dataDirectory), { recursive: true });
    await writeFile(
      join(droidDirectory(config.dataDirectory), "state.json"),
      JSON.stringify({
        schema: "pogo.maintenance.droid.v1",
        lastReport: null,
        recovers: { "2026-11-12": 1 },
      }),
      { mode: 0o600 },
    );
    host.time = Date.parse("2026-11-12T23:59:50Z");
    await check(
      config,
      path,
      deps(
        scripted(async (tools) => {
          host.time = Date.parse("2026-11-13T00:00:10Z");
          return tools.recover();
        }),
      ),
    );
    expect(
      host.commands.filter(
        (c) => c === "systemctl --user restart pogo.service",
      ),
    ).toHaveLength(1);
    const state = JSON.parse(
      await readFile(
        join(droidDirectory(config.dataDirectory), "state.json"),
        "utf8",
      ),
    );
    expect(state.recovers).toEqual({ "2026-11-12": 1, "2026-11-13": 1 });
  });
});

describe("droid crew queue notes", () => {
  test("the droid names queued crew tasks with the command to resolve them", async () => {
    const { config, path } = await install();
    const captain = join(host.dir, "captain");
    const stateDirectory = join(captain, ".local", "pogo-crew");
    await mkdir(join(captain, ".opencode"), { recursive: true });
    await writeFile(
      join(captain, ".opencode", "opencode.json"),
      `${JSON.stringify({
        plugins: [
          {
            package: join(host.dir, "plugin"),
            options: {
              namespace: "ship",
              stateDirectory,
              captainDirectory: captain,
              worktrees: {},
              team: { crew: [] },
            },
          },
        ],
      })}\n`,
    );
    const state = await CrewState.open(stateDirectory, "ship", "fingerprint");
    let id = "";
    try {
      const chief = state.reservePeer("chief");
      id = state.enqueue(chief, "ses_e49d787old", "private task text").id;
    } finally {
      state.close();
    }
    await writeReport(
      config.dataDirectory,
      report("deferred", "2026-11-12T00:05:00.000Z", { reason: "busy-crew" }),
    );
    let status = "";
    await check(
      config,
      path,
      deps(
        scripted(async (tools) => {
          status = JSON.stringify(await tools.status());
          return "The run deferred on a queued crew task.";
        }),
      ),
    );
    expect(status).toContain(`"taskID":"${id}"`);
    expect(status).toContain('"originIsPin":false');
    const [post] = await posts(config);
    expect(post?.text).toContain(
      `Queued crew task ${id} (chief, from an earlier captain session): ask the captain to run pogo_crew status ${id}`,
    );
    const everything = [...agentPrompts, status, post?.text ?? ""].join("\n");
    expect(everything).not.toContain("private task text");
  });
});
