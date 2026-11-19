import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Config, configSchema } from "../src/config";
import { CrewState } from "../src/crew/state";
import { CronStore } from "../src/cron-store";
import {
  type CommandResult,
  type CommandRunner,
  processRunner,
} from "../src/nightly/exec";
import { probeModel } from "../src/nightly/host";
import {
  backupDirectory,
  FileChanges,
  Journal,
  readJournalFile,
} from "../src/nightly/journal";
import { applyLiveModels } from "../src/nightly/model-step";
import type { OpenCodeControl } from "../src/nightly/opencode";
import { writePluginDigest } from "../src/nightly/plugin-digest";
import { adoptRelease, linkedRelease } from "../src/nightly/release";
import { reportSchema } from "../src/nightly/report";
import {
  acceptCurrent,
  applyBudgetMs,
  type Dependencies,
  recoverInterruptedRun,
  runMaintenance,
  UpdateRefused,
} from "../src/nightly/run";
import { readState, updateState } from "../src/nightly/state";
import {
  maintenanceUpdate,
  type UpdateOptions,
  updateUnit,
} from "../src/nightly/update";
import type { ModelRef } from "../src/nightly/versions";
import { botKey } from "../src/routing";
import { Store } from "../src/store";
import { tarball } from "./tar";

const base = await mkdtemp("/tmp/opencode/stargate-run-");
afterAll(async () => {
  api.stop(true);
  await rm(base, { recursive: true, force: true });
});

// ---- Release archive built from a tiny repository ----------------------
const repo = join(base, "repo");
// The release has a crew plugin, so staging records its digest.
const releaseFiles = {
  "package.json":
    '{ "name": "stargate", "exports": { ".": "./src/crew/plugin.ts" } }\n',
  "src/main.ts": "export {};\n",
  "src/crew/plugin.ts": "export const plugin = 2;\n",
};
for (const [path, text] of Object.entries(releaseFiles)) {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), text);
}
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
execFileSync("git", ["init", "-q", "-b", "main", repo]);
git("add", ".");
git("commit", "-q", "-m", "feat: release");
const commit = git("rev-parse", "HEAD");
git(
  "archive",
  "--format=tar.gz",
  "--prefix=stargate-v0.2.0/",
  "-o",
  join(base, "a.tgz"),
  "HEAD",
);
const archive = new Uint8Array(await readFile(join(base, "a.tgz")));
const sha = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const checksum = `${sha(archive)}  stargate-v0.2.0.tar.gz\n`;
const proxyAsset = tarball([
  { path: "cli-proxy-api", data: "proxy-8.0.60", mode: 0o755 },
]);

const now = Date.parse("2026-11-12T00:05:00Z");
const hoursAgo = (hours: number) =>
  new Date(now - hours * 3_600_000).toISOString();
let apiPort = 0;
const api = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    const root = `http://127.0.0.1:${apiPort}`;
    const stargate = "/repos/aiconsultancy/stargate";
    const asset = (id: number, name: string, size: number, extra = {}) => ({
      id,
      name,
      size,
      url: `${root}${stargate}/releases/assets/${id}`,
      created_at: hoursAgo(1),
      updated_at: hoursAgo(1),
      uploader: { login: "github-actions[bot]" },
      ...extra,
    });
    const stargateRelease = () => ({
      id: 1,
      tag_name: "v0.2.0",
      draft: false,
      prerelease: false,
      published_at: hoursAgo(1),
      author: { login: "github-actions[bot]" },
      assets: [
        asset(1, "stargate-v0.2.0.tar.gz", archive.length),
        asset(2, "stargate-v0.2.0.tar.gz.sha256", checksum.length),
      ],
    });
    switch (url.pathname) {
      case `${stargate}/releases`:
        return Response.json([stargateRelease()]);
      // One release by its tag; any other tag is 404 below.
      case `${stargate}/releases/tags/v0.2.0`:
        return Response.json(stargateRelease());
      case `${stargate}/releases/assets/1`:
        return new Response(archive);
      case `${stargate}/releases/assets/2`:
        return new Response(checksum);
      case `${stargate}/git/ref/tags/v0.2.0`:
        return Response.json({ object: { type: "commit", sha: commit } });
      case `${stargate}/compare/${commit}...main`:
        return Response.json({ status: "identical" });
      case "/repos/router-for-me/CLIProxyAPI/releases":
        return Response.json([
          {
            id: 2,
            tag_name: "v8.0.60",
            draft: false,
            prerelease: false,
            published_at: hoursAgo(48),
            author: { login: "github-actions[bot]" },
            assets: [
              {
                id: 9,
                name: "CLIProxyAPI_8.0.60_linux_amd64.tar.gz",
                size: proxyAsset.length,
                url: `${root}/cpa/asset`,
                browser_download_url: `${root}/cpa/download`,
                created_at: hoursAgo(48),
                updated_at: hoursAgo(48),
                digest: `sha256:${sha(proxyAsset)}`,
              },
            ],
          },
        ]);
      case "/cpa/download":
        return new Response(proxyAsset);
      case "/@opencode%2Fcli":
        return Response.json({
          "dist-tags": { latest: "2.2.9" },
          time: { "2.2.7": "2026-10-01T00:00:00.000Z", "2.2.9": hoursAgo(30) },
          versions: { "2.2.7": {}, "2.2.9": {} },
        });
      case "/v1/models":
        if (request.headers.get("authorization") !== "Bearer proxy-key")
          return new Response("no", { status: 401 });
        return fixture.proxyDown(fixture)
          ? new Response("down", { status: 503 })
          : Response.json({
              data: fixture.proxyModelIDs().map((id) => ({ id })),
            });
      case "/v1/responses": {
        const body = (await request.json()) as { model: string };
        fixture.probes.push(`responses:${body.model}`);
        return fixture.probeOK(body.model)
          ? Response.json({ status: "incomplete", output: [] })
          : new Response("no", { status: 500 });
      }
      case "/v1/messages": {
        const body = (await request.json()) as { model: string };
        fixture.probes.push(`messages:${body.model}`);
        return request.headers.get("anthropic-version")
          ? Response.json({ content: [{ type: "text", text: "OK" }] })
          : new Response("bad", { status: 400 });
      }
    }
    return new Response("missing", { status: 404 });
  },
});
apiPort = api.port ?? 0;
const url = `http://127.0.0.1:${apiPort}`;

// ---- Per-test installation ---------------------------------------------
type Fixture = {
  dir: string;
  time: number;
  commands: string[][];
  sessions: Map<string, ModelRef>;
  active: string[];
  readyVersions: Set<string | null>;
  updateNotices: { sessionID: string; status: "queued" | "mail" }[];
  proxyDown: (f: Fixture) => boolean;
  probeOK: (model: string) => boolean;
  probes: string[];
  proxyModelIDs: () => string[];
  gateway: string;
  stopFails: boolean;
  badCliVersion: string | null;
  openCodeRestarts: number;
  pluginsOK: (f: Fixture) => Promise<boolean>;
  agents: { id: string; mode: string; model: ModelRef | null }[];
  controller: AbortController;
  abortWhen: (command: string) => boolean;
  onCommand: (command: string) => Promise<void>;
};
const fixture: Fixture = {
  dir: "",
  time: now,
  commands: [],
  sessions: new Map(),
  active: [],
  readyVersions: new Set(),
  updateNotices: [],
  proxyDown: () => false,
  probeOK: () => true,
  probes: [],
  proxyModelIDs: () => ["gpt-6.1-sol", "gpt-6.2-sol", "claude-opus-5-5"],
  gateway: "active",
  stopFails: false,
  badCliVersion: null,
  openCodeRestarts: 0,
  pluginsOK: async () => true,
  agents: [],
  controller: new AbortController(),
  abortWhen: () => false,
  onCommand: async () => {},
};

async function writeNpm(prefix: string, name: string, version: string) {
  const path = join(prefix, "lib", "node_modules", name);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "package.json"),
    JSON.stringify({ name, version }),
  );
}

async function install(
  overrides: Record<string, unknown> = {},
): Promise<{ config: Config; path: string }> {
  const dir = await mkdtemp(join(base, "case-"));
  fixture.dir = dir;
  // Each installation starts from the same live state.
  fixture.sessions = new Map([
    [
      "ses_captain",
      { providerID: "openai-proxy", id: "gpt-6.1-sol", variant: "high" },
    ],
  ]);
  fixture.commands = [];
  fixture.gateway = "active";
  fixture.time = now;
  fixture.openCodeRestarts = 0;
  const root = join(dir, "stargate");
  const old = join(root, "releases", "old");
  await mkdir(join(old, "src"), { recursive: true });
  await writeFile(join(old, "package.json"), '{ "name": "stargate" }\n');
  await writeFile(join(old, "src", "main.ts"), "");
  await adoptRelease(root, old, "0.1.0");
  const captain = join(dir, "captain");
  await mkdir(join(captain, ".opencode"), { recursive: true });
  const profile = {
    model: "openai-proxy/gpt-6.1-sol",
    plugins: [
      {
        package: join(root, "deployment-plugin"),
        options: {
          namespace: "ship",
          stateDirectory: join(captain, ".local", "stargate-crew"),
          captainDirectory: captain,
          worktrees: {},
          team: {
            captain: { id: "adama", model: "openai-proxy/gpt-6.1-sol" },
            crew: [],
          },
        },
      },
    ],
  };
  await writeFile(
    join(captain, ".opencode", "opencode.json"),
    `${JSON.stringify(profile, null, 2)}\n`,
  );
  const team = {
    captain: { id: "adama", model: "openai-proxy/gpt-6.1-sol#high" },
    crew: [{ id: "chief", role: "r", permissionProfile: "coding" }],
  };
  // A dotfiles-style symlinked team file: the link must survive (L2).
  await mkdir(join(dir, "dotfiles"));
  await writeFile(
    join(dir, "dotfiles", "team.json"),
    `${JSON.stringify(team, null, 2)}\n`,
  );
  await symlink(join(dir, "dotfiles", "team.json"), join(dir, "team.json"));
  await writeFile(join(dir, "client.key"), "proxy-key\n", { mode: 0o600 });
  const cpa = join(dir, "cpa");
  await mkdir(join(cpa, "8.0.54"), { recursive: true });
  await writeFile(join(cpa, "8.0.54", "cliproxyapi"), "proxy-8.0.54", {
    mode: 0o700,
  });
  await symlink(join(cpa, "8.0.54", "cliproxyapi"), join(dir, "cpa-current"));
  const prefix = join(dir, "prefix");
  await writeNpm(prefix, "@opencode/cli", "2.2.7");
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
          directory: captain,
          // The pinned captain session follows model upgrades.
          sessionID: "ses_captain",
          model: { providerID: "openai-proxy", id: "gpt-6.1-sol" },
        },
      },
    ],
    maintenance: {
      enabled: true,
      installID: "test-install",
      report: { bot: "helper", channel: "C123" },
      services: { gateway: "stargate.service" },
      components: {
        stargate: true,
        cliproxyapi: true,
        agentClis: true,
        models: true,
      },
      proxy: { url, clientKeyFile: join(dir, "client.key") },
      // Tree comparison is covered by the release tests; this fixture opts out.
      stargate: {
        root,
        apiURL: url,
        tokenEnv: "STARGATE_RELEASE_TOKEN",
        requireTreeCheck: false,
      },
      cliproxyapi: {
        unit: "cpa.service",
        link: join(dir, "cpa-current"),
        binary: join(cpa, "{version}", "cliproxyapi"),
        apiURL: url,
      },
      agentClis: {
        prefix,
        registry: url,
        packages: [{ name: "@opencode/cli", command: "opencode2" }],
      },
      models: { teamFiles: [join(dir, "team.json")] },
      ...overrides,
    },
  };
  const path = join(dir, "stargate.json");
  await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
  const config = configSchema.parse(raw);
  await mkdir(config.dataDirectory, { recursive: true });
  const store = new Store(join(config.dataDirectory, "stargate.sqlite"));
  store.saveSession('["k","C123","1.0"]', "ses_captain");
  store.close();
  return { config, path };
}

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const runner: CommandRunner = {
  async run(command, options) {
    fixture.commands.push([...command]);
    const text = command.join(" ");
    await fixture.onCommand(text);
    if (fixture.abortWhen(text)) fixture.controller.abort();
    const [first, ...rest] = command;
    if (first === "tar" || first === "git")
      return processRunner.run(command, options);
    if (first === "bun") return ok();
    if (first === "npm") {
      const prefix = rest[rest.indexOf("--prefix") + 1] ?? "";
      for (const spec of rest.filter((arg) => /^@?[^-].*@\d/.test(arg))) {
        const at = spec.lastIndexOf("@");
        await writeNpm(prefix, spec.slice(0, at), spec.slice(at + 1));
      }
      return ok();
    }
    if (first?.endsWith("/bin/opencode2")) {
      const manifest = JSON.parse(
        await readFile(
          join(
            fixture.dir,
            "prefix/lib/node_modules/@opencode/cli/package.json",
          ),
          "utf8",
        ),
      );
      return ok(
        manifest.version === fixture.badCliVersion
          ? "crashed\n"
          : `opencode v${manifest.version}\n`,
      );
    }
    if (first === "systemctl") {
      const [, action, unit] = rest;
      if (unit === "opencode2.service" && action === "restart")
        fixture.openCodeRestarts++;
      if (unit !== "stargate.service") return ok();
      if (action === "is-active") return ok(`${fixture.gateway}\n`);
      if (action === "stop") {
        if (fixture.stopFails) return { code: 1, stdout: "", stderr: "" };
        fixture.gateway = "inactive";
      }
      if (action === "restart" || action === "start") {
        fixture.gateway = "active";
        const current = await linkedRelease(
          join(fixture.dir, "stargate"),
          "current",
        );
        const version = current?.metadata.version ?? null;
        if (fixture.readyVersions.has(version))
          await writeFile(
            join(fixture.dir, "data", "ready.json"),
            JSON.stringify({
              schema: "stargate.ready.v1",
              pid: process.pid,
              readyAt: fixture.time,
              version,
              ...(fixture.updateNotices.length
                ? { updateNotices: fixture.updateNotices }
                : {}),
            }),
          );
      }
      return ok();
    }
    return { code: 127, stdout: "", stderr: "" };
  },
};

const opencode: OpenCodeControl = {
  active: async () => fixture.active,
  pendingInput: async () => [],
  parent: async () => undefined,
  sessionModel: async (id) => {
    return fixture.sessions.get(id) ?? null;
  },
  switchModel: async (id, model) => {
    fixture.sessions.set(id, model);
    if (fixture.abortWhen("switchModel")) fixture.controller.abort();
  },
  catalog: async () => [
    { providerID: "openai-proxy", id: "gpt-6.1-sol", variants: ["high"] },
    {
      providerID: "openai-proxy",
      id: "gpt-6.2-sol",
      variants: ["high", "xhigh"],
    },
  ],
  plugins: async () => [
    {
      path: join(fixture.dir, "stargate", "deployment-plugin"),
      active: await fixture.pluginsOK(fixture),
    },
  ],
  agents: async () => fixture.agents,
  reload: async () => {},
};

/** One systemd invocation: the run and its ExecStopPost share the ID. */
const invocation = {
  STARGATE_RELEASE_TOKEN: "release-token",
  INVOCATION_ID: "0123456789abcdef0123456789abcdef",
};
const deps = (extra: Partial<Dependencies> = {}): Dependencies => ({
  runner,
  clock: {
    now: () => fixture.time,
    sleep: async (ms, signal) => {
      signal.throwIfAborted();
      fixture.time += ms;
    },
  },
  connect: async () => opencode,
  env: { STARGATE_RELEASE_TOKEN: "release-token" },
  uuid: () => crypto.randomUUID(),
  ...extra,
});

beforeEach(() => {
  Object.assign(fixture, {
    time: now,
    commands: [],
    sessions: new Map([
      [
        "ses_captain",
        { providerID: "openai-proxy", id: "gpt-6.1-sol", variant: "high" },
      ],
    ]),
    active: [],
    readyVersions: new Set(["0.1.0", "0.2.0"]),
    updateNotices: [],
    proxyDown: () => false,
    probeOK: () => true,
    probes: [],
    proxyModelIDs: () => ["gpt-6.1-sol", "gpt-6.2-sol", "claude-opus-5-5"],
    gateway: "active",
    stopFails: false,
    badCliVersion: null,
    openCodeRestarts: 0,
    pluginsOK: async () => true,
    agents: [],
    controller: new AbortController(),
    abortWhen: () => false,
    onCommand: async () => {},
  } satisfies Partial<Fixture>);
});

const run = (
  config: Config,
  path: string,
  mode: "plan" | "run" = "run",
  extra: Partial<Dependencies> = {},
) =>
  runMaintenance(
    { config, configPath: path, mode, signal: fixture.controller.signal },
    deps(extra),
  );
const commands = (prefix: string) =>
  fixture.commands.filter((command) => command.join(" ").startsWith(prefix));

test("cleanup-only maintenance records results without stopping services", async () => {
  const { config, path } = await install();
  if (!config.maintenance) throw new Error("fixture maintenance missing");
  config.maintenance.components = {
    stargate: false,
    cliproxyapi: false,
    agentClis: false,
    models: false,
  };
  config.maintenance.cleanup = {
    enabled: true,
    olderThanDays: 5,
    scratchRoots: [],
    repositories: [],
    protectedPaths: [],
  };
  const result = await run(config, path);
  expect(result.report.cleanup).toEqual({
    items: [],
    freedBytes: 0,
    plannedBytes: 0,
  });
  expect(
    result.report.components.find((item) => item.id === "cleanup")?.status,
  ).toBe("unchanged");
  expect(
    fixture.commands.some(
      (command) => command.includes("stop") || command.includes("restart"),
    ),
  ).toBe(false);
});

test("cleanup fails closed when the shared OpenCode server has activity", async () => {
  const { config, path } = await install();
  if (!config.maintenance) throw new Error("fixture maintenance missing");
  config.maintenance.components = {
    stargate: false,
    cliproxyapi: false,
    agentClis: false,
    models: false,
  };
  config.maintenance.cleanup = {
    enabled: true,
    olderThanDays: 5,
    scratchRoots: [],
    repositories: [],
    protectedPaths: [],
  };
  fixture.active = ["ses_captain"];
  const result = await run(config, path);
  expect(result.report.cleanup).toBeUndefined();
  expect(
    result.report.components.find((item) => item.id === "cleanup")?.status,
  ).toBe("deferred");
});

test("cleanup checkpoints intent and result privately before one final notice", async () => {
  const { config, path } = await install();
  if (!config.maintenance) throw new Error("fixture maintenance missing");
  config.maintenance.components = {
    stargate: false,
    cliproxyapi: false,
    agentClis: false,
    models: false,
  };
  config.maintenance.cleanup = {
    enabled: true,
    olderThanDays: 5,
    scratchRoots: [],
    repositories: [],
    protectedPaths: [],
  };
  const result = await run(config, path, "run", {
    cleanup: async (input) => {
      const item = {
        kind: "scratch" as const,
        path: join(base, "fixture-only-intent"),
        status: "planned" as const,
        size: 42,
        newestMtime: now - 864_000_000,
        reason: "stale" as const,
      };
      await input.beforeItem?.(item);
      await input.record?.(item);
      const directory = join(config.dataDirectory, "maintenance", "reports");
      const files = await readdir(directory);
      const checkpoint = reportSchema.parse(
        JSON.parse(
          await readFile(join(directory, files[0] ?? "missing"), "utf8"),
        ),
      );
      expect(checkpoint.cleanup?.items).toEqual([item]);
      expect(
        await readdir(
          join(config.dataDirectory, "maintenance", "outbox"),
        ).catch(() => []),
      ).toEqual([]);
      const removed = { ...item, status: "removed" as const };
      await input.record?.(removed);
      return { items: [removed], freedBytes: 42, plannedBytes: 0 };
    },
  });
  expect(result.report.cleanup?.freedBytes).toBe(42);
  expect(result.report.outcome).toBe("completed");
  expect(
    await readdir(join(config.dataDirectory, "maintenance", "outbox")),
  ).toHaveLength(1);
  expect(result.report.restarts).toEqual([]);
});
const live = async () => ({
  release: await readlink(join(fixture.dir, "stargate", "current")),
  proxy: await readlink(join(fixture.dir, "cpa-current")),
  cli: JSON.parse(
    await readFile(
      join(fixture.dir, "prefix/lib/node_modules/@opencode/cli/package.json"),
      "utf8",
    ),
  ).version as string,
  team: JSON.parse(await readFile(join(fixture.dir, "team.json"), "utf8"))
    .captain.model as string,
  session: fixture.sessions.get("ses_captain")?.id,
  gateway: fixture.gateway,
  journal: await readJournalFile(join(fixture.dir, "data")),
});
const statusOf = (
  report: { components: { id: string; status: string }[] },
  id: string,
) => report.components.find((c) => c.id === id)?.status;

/** Live state matches the report: only "updated" components changed. */
async function expectConsistent(report: {
  components: { id: string; status: string }[];
}) {
  const state = await live();
  expect(state.journal).toBeNull();
  expect(state.gateway).toBe("active");
  expect(state.release).toBe(
    statusOf(report, "stargate") === "updated"
      ? "releases/0.2.0"
      : "releases/old",
  );
  expect(state.proxy).toContain(
    statusOf(report, "cliproxyapi") === "updated" ? "8.0.60" : "8.0.54",
  );
  expect(state.cli).toBe(
    statusOf(report, "npm:@opencode/cli") === "updated" ? "2.2.9" : "2.2.7",
  );
  const upgraded = statusOf(report, "models") === "updated";
  expect(state.team).toBe(
    upgraded
      ? "openai-proxy/gpt-6.2-sol#high"
      : "openai-proxy/gpt-6.1-sol#high",
  );
  expect(state.session).toBe(upgraded ? "gpt-6.2-sol" : "gpt-6.1-sol");
}

describe("nightly maintenance run", () => {
  test("plan is read-only and lists every planned change", async () => {
    const { config, path } = await install();
    const before = await readFile(join(fixture.dir, "team.json"), "utf8");
    const { report, reportPath } = await run(config, path, "plan");
    expect(reportPath).toBeUndefined();
    expect(report.outcome).toBe("planned");
    expect(
      Object.fromEntries(report.components.map((c) => [c.id, c.status])),
    ).toEqual({
      stargate: "planned",
      cliproxyapi: "planned",
      "npm:@opencode/cli": "planned",
      models: "planned",
    });
    expect(fixture.probes).toEqual([]);
    expect(commands("systemctl")).toEqual([]);
    expect(commands("npm")).toEqual([]);
    expect(await readFile(join(fixture.dir, "team.json"), "utf8")).toBe(before);
  });

  test("a queued crew assignment does not defer the run; the report names it", async () => {
    const { config, path } = await install();
    const state = await CrewState.open(
      join(fixture.dir, "captain", ".local", "stargate-crew"),
      "ship",
      "fingerprint",
    );
    let id = "";
    try {
      const chief = state.reservePeer("chief");
      // Galactica: four cancelled rows and one queued by an earlier captain.
      const rows = Array.from({ length: 5 }, (_, i) =>
        state.enqueue(chief, "ses_e49d787old", `private task text ${i}`),
      );
      for (const row of rows.slice(0, 4))
        state.cancelQueued(row.id, "ses_e49d787old");
      id = rows[4]?.id ?? "";
    } finally {
      state.close();
    }
    const note = {
      kind: "queued-crew-task" as const,
      taskID: id,
      crew: "chief",
      originCaptain: "ses_e49d787old",
      originIsPin: false,
      report: false,
      action: `Ask the captain to run stargate_crew status ${id}`,
    };
    const planned = await run(config, path, "plan");
    expect(planned.report.notes).toEqual([note]);
    const { report, reportPath } = await run(config, path);
    expect(report.outcome).toBe("completed");
    expect(report.notes).toEqual([note]);
    const text = await readFile(reportPath ?? "", "utf8");
    expect(text).not.toContain("private task text");
    expect(reportSchema.parse(JSON.parse(text)).notes).toEqual([note]);
    const [notice] = await readdir(
      join(fixture.dir, "data/maintenance/outbox"),
    );
    const summary = JSON.parse(
      await readFile(
        join(fixture.dir, "data/maintenance/outbox", notice ?? ""),
        "utf8",
      ),
    ).text as string;
    expect(summary).toContain(
      `crew task ${id} for chief is queued (from an earlier captain session): ask the captain to run stargate_crew status ${id}`,
    );
    await expectConsistent(report);
  });

  test("another user's session on the shared OpenCode server does not defer", async () => {
    const { config, path } = await install();
    // The operator's own session: not pinned, not mapped, not a crew peer.
    fixture.active = ["ses_operator"];
    const { report } = await run(config, path);
    expect(report.outcome).toBe("completed");
    expect(
      report.steps.find((step) => step.name === "idle-gate"),
    ).toMatchObject({ status: "ok" });
  });

  test("busy work defers everything to the next window", async () => {
    const { config, path } = await install();
    fixture.active = ["ses_captain"];
    const { report, reportPath } = await run(config, path);
    expect(report.outcome).toBe("deferred");
    expect(report.reason).toBe("busy-opencode");
    expect(report.components.every((c) => c.status === "deferred")).toBe(true);
    expect(fixture.time).toBeLessThanOrEqual(
      Date.parse("2026-11-12T00:50:00Z"),
    );
    expect(commands("systemctl --user stop")).toEqual([]);
    expect(commands("npm")).toEqual([]);
    expect(
      reportSchema.parse(JSON.parse(await readFile(reportPath ?? "", "utf8")))
        .outcome,
    ).toBe("deferred");
    expect(
      await readdir(join(fixture.dir, "data/maintenance/outbox")),
    ).toHaveLength(1);
    await expectConsistent(report);
  });

  test("updates every component at one idle boundary with one OpenCode restart", async () => {
    const { config, path } = await install();
    const bot = config.bots[0];
    if (!bot) throw new Error("bot");
    const identity = { team: "T1", user: "U1" };
    const key = botKey(bot, identity);
    const { report, reportPath, attention } = await run(config, path);
    expect(attention).toBe(false);
    expect(report.outcome).toBe("completed");
    expect(
      Object.fromEntries(
        report.components.map((c) => [c.id, [c.before, c.after, c.status]]),
      ),
    ).toEqual({
      stargate: ["0.1.0", "0.2.0", "updated"],
      cliproxyapi: ["8.0.54", "8.0.60", "updated"],
      "npm:@opencode/cli": ["2.2.7", "2.2.9", "updated"],
      models: ["gpt-6.1-sol", "gpt-6.2-sol", "updated"],
    });
    await expectConsistent(report);
    expect(await readlink(join(fixture.dir, "stargate", "previous"))).toBe(
      "releases/old",
    );
    // L2: the dotfiles symlink stays a link; its target got the change.
    expect((await lstat(join(fixture.dir, "team.json"))).isSymbolicLink()).toBe(
      true,
    );
    expect(
      await readFile(join(fixture.dir, "dotfiles", "team.json"), "utf8"),
    ).toContain("gpt-6.2-sol#high");
    // H4: stargate.json is not rewritten, so the bot key and Slack mappings stay.
    const after = configSchema.parse(JSON.parse(await readFile(path, "utf8")))
      .bots[0];
    if (!after) throw new Error("bot");
    expect(botKey(after, identity)).toBe(key);
    expect(fixture.probes).toEqual([
      "responses:gpt-6.2-sol",
      "responses:gpt-6.2-sol",
    ]);
    // Cool-off for dependencies; scripts only for listed packages.
    const npm = commands("npm")[0] ?? [];
    expect(npm).toContain("@opencode/cli@2.2.9");
    expect(npm).toContain(
      `--before=${new Date(now - 86_400_000).toISOString()}`,
    );
    expect(npm).toContain("--strict-allow-scripts");
    // The cutoff and the proxy digest are recorded for later rollbacks.
    const state = await readState(config.dataDirectory);
    expect(state.npm["@opencode/cli"]).toEqual({
      version: "2.2.9",
      before: new Date(now - 86_400_000).toISOString(),
    });
    expect(state.cliproxyapi["8.0.60"]?.asset).toBe(sha(proxyAsset));
    expect(report.components.find((c) => c.id === "cliproxyapi")?.digest).toBe(
      sha(proxyAsset),
    );
    expect(report.restarts.map((r) => [r.service, r.status])).toEqual([
      ["cliproxyapi", "ok"],
      ["opencode", "ok"],
      ["gateway", "ok"],
    ]);
    const text = await readFile(reportPath ?? "", "utf8");
    expect(text).not.toContain("release-token");
    expect(text).not.toContain("proxy-key");
    const outbox = await readdir(join(fixture.dir, "data/maintenance/outbox"));
    const notice = JSON.parse(
      await readFile(
        join(fixture.dir, "data/maintenance/outbox", outbox[0] ?? ""),
        "utf8",
      ),
    );
    expect(notice.text).toContain("stargate: updated 0.1.0 → 0.2.0");
  });

  test("readiness failure rolls the release back and marks it known-bad", async () => {
    const { config, path } = await install();
    fixture.readyVersions = new Set(["0.1.0"]);
    const { report } = await run(config, path);
    expect(report.components.find((c) => c.id === "stargate")).toMatchObject({
      status: "rolled-back",
      reason: "readiness-failed",
      after: "0.1.0",
    });
    expect(report.outcome).toBe("partial");
    await expectConsistent(report);
    expect(
      (await readState(config.dataDirectory)).failedReleases["0.2.0"]?.reason,
    ).toBe("readiness-failed");
    // The next night skips that release until a newer one exists.
    fixture.time = now + 86_400_000;
    fixture.readyVersions = new Set(["0.1.0", "0.2.0"]);
    const next = await run(config, path);
    expect(
      next.report.components.find((c) => c.id === "stargate"),
    ).toMatchObject({
      status: "skipped",
      reason: "known-bad",
    });
  });

  test("a readiness rollback does not restart while a cron run that started on return is active", async () => {
    const { config, path } = await install();
    // 0.2.0 never becomes ready; the previous release would.
    fixture.readyVersions = new Set(["0.1.0"]);
    const cron = join(config.dataDirectory, "cron.sqlite");
    new CronStore(cron).close();
    const sql = (text: string) => {
      const db = new Database(cron);
      db.exec(text);
      db.close();
    };
    sql(
      `INSERT INTO cron_schedules (id,botKey,channel,user,name,expression,timezone,prompt,nextAt,createdAt)
       VALUES ('s1','k','C1','U1','n','15 * * * *','UTC','p',${now + 86_400_000},0)`,
    );
    // A schedule that came due while the gateway was stopped starts as soon
    // as the gateway is back, before readiness is decided.
    let started = false;
    fixture.onCommand = async (command) => {
      if (command === "systemctl --user restart stargate.service" && !started) {
        started = true;
        sql(
          `INSERT INTO cron_runs (id,scheduleId,dueAt) VALUES ('r1','s1',${now})`,
        );
      }
    };
    const gatewayRestarts = () =>
      commands("systemctl --user restart stargate.service").length;
    const { report, attention } = await run(config, path, "run", {
      env: invocation,
    });
    expect(report.reason).toBe("readiness-failed");
    expect(attention).toBe(true);
    // Only the forward start: no rollback restart of OpenCode or the gateway.
    expect(gatewayRestarts()).toBe(1);
    expect(fixture.openCodeRestarts).toBe(1);
    expect(report.steps).toContainEqual(
      expect.objectContaining({
        name: "recover-before-opencode",
        status: "skipped",
        reason: "busy-cron",
      }),
    );
    const kept = JSON.parse(
      (await readJournalFile(config.dataDirectory)) ?? "{}",
    );
    expect(kept.gateway).toEqual({ restartPending: true });
    expect(kept.openCode).toEqual({ restarted: true, restartPending: true });
    // The timer's ExecStopPost finishes its own journal, but ingress is open.
    const after = await recoverInterruptedRun(
      config,
      deps({ env: invocation }),
      { afterRun: true },
    );
    expect(after.ok).toBe(false);
    expect(gatewayRestarts()).toBe(1);
    expect(fixture.openCodeRestarts).toBe(1);
    // The cron run finishes; recovery then completes.
    sql("UPDATE cron_runs SET status='done' WHERE id='r1'");
    expect((await recoverInterruptedRun(config, deps())).ok).toBe(true);
    expect(fixture.openCodeRestarts).toBe(2);
    expect(gatewayRestarts()).toBe(2);
    const state = await live();
    expect(state).toMatchObject({
      release: "releases/old",
      gateway: "active",
      journal: null,
    });
  });

  test("a gateway that never becomes ready keeps the journal and alerts", async () => {
    const { config, path } = await install();
    fixture.readyVersions = new Set();
    const { report, attention } = await run(config, path);
    expect(attention).toBe(true);
    expect(report.reason).toBe("readiness-failed");
    expect(await readJournalFile(config.dataDirectory)).toContain('"gateway"');
    const alert = JSON.parse(
      await readFile(
        join(config.dataDirectory, "maintenance", "ALERT.json"),
        "utf8",
      ),
    );
    expect(alert).toMatchObject({
      schema: "stargate.maintenance.alert.v1",
      journal: true,
    });
    // Recovery keeps failing loudly until the gateway is ready.
    expect((await recoverInterruptedRun(config, deps())).ok).toBe(false);
    fixture.readyVersions = new Set(["0.1.0"]);
    expect((await recoverInterruptedRun(config, deps())).ok).toBe(true);
    expect(await readJournalFile(config.dataDirectory)).toBeNull();
  });

  test("an unhealthy proxy returns to the previous binary; a broken rollback stops the run", async () => {
    const { config, path } = await install();
    fixture.proxyDown = (f) =>
      f.commands.some(
        (c) => c.join(" ") === "systemctl --user restart cpa.service",
      );
    let result = await run(config, path);
    // Neither the new nor the old proxy answers: no release or model change.
    expect(statusOf(result.report, "cliproxyapi")).toBe("failed");
    expect(statusOf(result.report, "stargate")).not.toBe("updated");
    expect(statusOf(result.report, "models")).not.toBe("updated");
    expect(result.attention).toBe(true);
    expect(await readlink(join(fixture.dir, "cpa-current"))).toContain(
      "8.0.54",
    );

    const second = await install();
    let restarts = 0;
    fixture.proxyDown = (f) => {
      restarts = f.commands.filter(
        (c) => c.join(" ") === "systemctl --user restart cpa.service",
      ).length;
      return restarts === 1;
    };
    result = await run(second.config, second.path);
    expect(
      result.report.components.find((c) => c.id === "cliproxyapi"),
    ).toMatchObject({
      status: "rolled-back",
      reason: "health-failed",
    });
    // The old proxy answers again, so the other components continue.
    expect(statusOf(result.report, "stargate")).toBe("updated");
    await expectConsistent(result.report);
  });

  test("models chosen through the old proxy are probed again after its update", async () => {
    const { config, path } = await install();
    fixture.probeOK = (model) =>
      !(
        model === "gpt-6.2-sol" &&
        fixture.commands.some(
          (c) => c.join(" ") === "systemctl --user restart cpa.service",
        )
      );
    const { report } = await run(config, path);
    expect(statusOf(report, "cliproxyapi")).toBe("updated");
    expect(report.models).toContainEqual(
      expect.objectContaining({
        target: "proxy-probe-after-update",
        reason: "probe-failed",
      }),
    );
    expect(statusOf(report, "models")).not.toBe("updated");
    await expectConsistent(report);
  });

  test("abort at any live phase leaves nothing half-applied", async () => {
    for (const trigger of [
      "npm install",
      "systemctl --user stop stargate.service",
      "systemctl --user restart cpa.service",
      "systemctl --user restart opencode2.service",
      "switchModel",
    ]) {
      const { config, path } = await install();
      fixture.controller = new AbortController();
      fixture.commands = [];
      fixture.gateway = "active";
      fixture.time = now;
      fixture.sessions.set("ses_captain", {
        providerID: "openai-proxy",
        id: "gpt-6.1-sol",
        variant: "high",
      });
      fixture.abortWhen = (command) => command.startsWith(trigger);
      const { report, attention } = await run(config, path);
      expect(report.reason).toBe("aborted");
      expect(attention).toBe(true);
      await expectConsistent(report);
    }
  });

  test("a hard kill is finished by recover from the journal", async () => {
    const { config, path } = await install();
    fixture.abortWhen = (command) =>
      command.startsWith("systemctl --user restart opencode2.service");
    await run(config, path, "run", { undoOnExit: false, env: invocation });
    const journal = await readJournalFile(config.dataDirectory);
    for (const entry of [
      '"gateway"',
      '"release"',
      '"files"',
      '"clis"',
      '"openCode"',
    ])
      expect(journal).toContain(entry);
    // The undo runs with Slack ingress still stopped; the gateway comes last.
    const during: string[] = [];
    fixture.onCommand = async (command) => {
      if (command.startsWith("npm")) during.push(fixture.gateway);
    };
    fixture.commands = [];
    // The timer's ExecStopPost finishes the journal of the run that ended.
    const recovered = await recoverInterruptedRun(
      config,
      deps({ env: invocation }),
      { afterRun: true },
    );
    expect(recovered.ok).toBe(true);
    expect(during).toEqual(["inactive"]);
    expect(commands("systemctl --user start stargate.service")).toEqual([]);
    expect(commands("systemctl --user restart stargate.service")).toHaveLength(
      1,
    );
    const state = await live();
    expect(state).toMatchObject({
      release: "releases/old",
      cli: "2.2.7",
      team: "openai-proxy/gpt-6.1-sol#high",
      gateway: "active",
      journal: null,
    });
    // The proxy update was verified and committed before the kill.
    expect(state.proxy).toContain("8.0.60");
    // The CLI rollback used the previous version's own publication time.
    expect(commands("npm").at(-1)).toContain(
      "--before=2026-10-01T00:00:00.000Z",
    );
  });

  test("a run with a leftover journal recovers first; an unreadable one refuses", async () => {
    const { config, path } = await install();
    await mkdir(join(config.dataDirectory, "maintenance"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      join(config.dataDirectory, "maintenance", "gateway-stopped.json"),
      JSON.stringify({
        unit: "stargate.service",
        stargateRoot: null,
        previousRelease: null,
      }),
      { mode: 0o600 },
    );
    fixture.gateway = "inactive";
    const first = await run(config, path);
    // The stopped gateway is started before the idle gate.
    expect(first.report.steps[0]).toMatchObject({
      name: "start-stopped-gateway",
      status: "ok",
    });
    expect(first.report.steps[1]).toMatchObject({
      name: "recover-previous-run",
      status: "ok",
    });
    expect(first.report.outcome).toBe("completed");

    const second = await install();
    await mkdir(join(second.config.dataDirectory, "maintenance"), {
      recursive: true,
      mode: 0o700,
    });
    const journalPath = join(
      second.config.dataDirectory,
      "maintenance",
      "journal.json",
    );
    await writeFile(journalPath, "{ truncated", { mode: 0o600 });
    fixture.commands = [];
    const result = await run(second.config, second.path);
    expect(result.report).toMatchObject({
      outcome: "failed",
      reason: "recovery-required",
    });
    expect(result.attention).toBe(true);
    expect(await readFile(journalPath, "utf8")).toBe("{ truncated");
    expect(commands("systemctl --user start stargate.service")).toHaveLength(1);
    expect(commands("npm")).toEqual([]);
  });

  test("OpenCode restart failures undo suspects one at a time", async () => {
    const { config, path } = await install();
    // The new release's plugin never loads; everything else is fine.
    fixture.pluginsOK = async (f) =>
      (await readlink(join(f.dir, "stargate", "current"))) !== "releases/0.2.0";
    const { report } = await run(config, path);
    expect(report.components.find((c) => c.id === "stargate")).toMatchObject({
      status: "rolled-back",
      reason: "plugins-failed",
    });
    expect(statusOf(report, "models")).toBe("updated");
    expect(statusOf(report, "npm:@opencode/cli")).toBe("updated");
    expect(fixture.openCodeRestarts).toBe(2);
    expect(
      (await readState(config.dataDirectory)).failedReleases["0.2.0"]?.reason,
    ).toBe("plugins-failed");
    await expectConsistent(report);

    const worse = await install();
    fixture.openCodeRestarts = 0;
    fixture.pluginsOK = async () => false;
    const all = await run(worse.config, worse.path);
    expect(all.report.reason).toBe("plugins-failed");
    expect(fixture.openCodeRestarts).toBeGreaterThanOrEqual(4);
    await expectConsistent(all.report);
  });

  test("a session switch that fails read-back is reverted with the config", async () => {
    const { config, path } = await install();
    const original = opencode.sessionModel;
    let reads = 0;
    opencode.sessionModel = async (id, signal) => {
      reads++;
      const model = await original(id, signal);
      // After the switch, read-back reports the old model once.
      if (
        fixture.commands.some((c) =>
          c.join(" ").includes("opencode2.service"),
        ) &&
        reads === 3
      )
        return {
          providerID: "openai-proxy",
          id: "gpt-6.1-sol",
          variant: "high",
        };
      return model;
    };
    try {
      const { report } = await run(config, path);
      expect(report.components.find((c) => c.id === "models")).toMatchObject({
        status: "rolled-back",
        reason: "session-switch-failed",
      });
      expect(report.rollbacks).toContainEqual(
        expect.objectContaining({
          component: "session:ses_captain",
          status: "ok",
        }),
      );
      await expectConsistent(report);
    } finally {
      opencode.sessionModel = original;
    }
  });

  test("maintenance report includes current ready update notices, not receipts from an earlier run", async () => {
    const { config, path } = await install({
      components: {
        stargate: true,
        cliproxyapi: false,
        agentClis: false,
        models: false,
      },
    });
    fixture.updateNotices = [
      { sessionID: "ses_captain", status: "queued" },
      { sessionID: "ses_pi", status: "mail" },
    ];
    const first = await run(config, path);
    expect(first.report.updateNotices).toEqual(fixture.updateNotices);
    fixture.time += 1000;
    const repeated = await run(config, path);
    expect(repeated.report.updateNotices).toBeUndefined();
  });

  test("global catalog opt-in plans additions without probing or writing, and default stays off", async () => {
    const globalConfigFile = join(base, `catalog-${crypto.randomUUID()}.json`);
    const { config, path } = await install({
      components: {
        stargate: false,
        cliproxyapi: false,
        agentClis: false,
        models: true,
      },
      models: { updateGlobalCatalog: true, globalConfigFile, teamFiles: [] },
    });
    const original = `${JSON.stringify({ providers: { "openai-proxy": { models: { "gpt-6.1-sol": { variants: [{ id: "high" }], limit: { context: 1234 } } } } } }, null, 2)}\n`;
    await writeFile(globalConfigFile, original);
    const planned = await run(config, path, "plan");
    expect(planned.report.models).toContainEqual(
      expect.objectContaining({
        scope: "catalog",
        to: "openai-proxy/gpt-6.2-sol",
        status: "planned",
      }),
    );
    expect(await readFile(globalConfigFile, "utf8")).toBe(original);
    expect(fixture.probes).toEqual([]);
    if (!config.maintenance?.models) throw new Error("Missing models");
    config.maintenance.models.updateGlobalCatalog = false;
    const disabled = await run(config, path, "plan");
    expect(
      disabled.report.models.some(
        (change) => change.scope === "catalog" && change.status === "planned",
      ),
    ).toBe(false);
    expect(await readFile(globalConfigFile, "utf8")).toBe(original);
    expect(
      configSchema.parse({
        dataDirectory: config.dataDirectory,
        bots: config.bots,
        maintenance: { ...config.maintenance, models: {} },
      }).maintenance?.models?.updateGlobalCatalog,
    ).toBe(false);
    expect(config.maintenance.models.families).toContain("gpt-astra");
  });

  test("global catalog symlink target is added before restart and session upgrade; failed live verification restores it", async () => {
    for (const succeeds of [true, false]) {
      const globalConfigFile = join(base, `global-${crypto.randomUUID()}.json`);
      const target = `${globalConfigFile}.target`;
      const original = `${JSON.stringify({ providers: { "openai-proxy": { models: { "gpt-6.1-sol": { variants: [{ id: "high" }], limit: { context: 1234 } } } } } }, null, 2)}\n`;
      await writeFile(target, original);
      await symlink(target, globalConfigFile);
      const { config, path } = await install({
        components: {
          stargate: false,
          cliproxyapi: false,
          agentClis: false,
          models: true,
        },
        models: { updateGlobalCatalog: true, globalConfigFile, teamFiles: [] },
      });
      const beforeCatalog = opencode.catalog;
      const beforeSwitch = opencode.switchModel;
      let sawAdditionAtRestart = false;
      opencode.catalog = async () => {
        const added = JSON.parse(await readFile(target, "utf8")).providers[
          "openai-proxy"
        ].models["gpt-6.2-sol"];
        return [
          { providerID: "openai-proxy", id: "gpt-6.1-sol", variants: ["high"] },
          ...(succeeds && added && fixture.openCodeRestarts
            ? [
                {
                  providerID: "openai-proxy",
                  id: "gpt-6.2-sol",
                  variants: ["high"],
                },
              ]
            : []),
        ];
      };
      fixture.onCommand = async (command) => {
        if (command.includes("restart opencode2.service"))
          sawAdditionAtRestart ||= (await readFile(target, "utf8")).includes(
            "gpt-6.2-sol",
          );
      };
      opencode.switchModel = async (id, model, signal) => {
        if (model.id === "gpt-6.2-sol") expect(succeeds).toBe(true);
        await beforeSwitch(id, model, signal);
      };
      try {
        const { report } = await run(config, path);
        expect(sawAdditionAtRestart).toBe(true);
        expect(await readlink(globalConfigFile)).toBe(target);
        expect(fixture.probes).toContain("responses:gpt-6.2-sol");
        expect(statusOf(report, "models")).toBe(
          succeeds ? "updated" : "rolled-back",
        );
        const after = await readFile(target, "utf8");
        if (succeeds) {
          const models = JSON.parse(after).providers["openai-proxy"].models;
          expect(models["gpt-6.2-sol"]).toEqual(models["gpt-6.1-sol"]);
          expect(report.models).toContainEqual(
            expect.objectContaining({
              scope: "catalog",
              to: "openai-proxy/gpt-6.2-sol",
              status: "applied",
            }),
          );
          expect(fixture.sessions.get("ses_captain")?.id).toBe("gpt-6.2-sol");
        } else {
          expect(after).toBe(original);
          expect(fixture.sessions.get("ses_captain")?.id).toBe("gpt-6.1-sol");
        }
      } finally {
        opencode.catalog = beforeCatalog;
        opencode.switchModel = beforeSwitch;
      }
    }
  });

  test("global catalog changed after planning is preserved instead of overwritten", async () => {
    const globalConfigFile = join(
      base,
      `edited-catalog-${crypto.randomUUID()}.json`,
    );
    const original = `${JSON.stringify({ providers: { "openai-proxy": { models: { "gpt-6.1-sol": { variants: [{ id: "high" }] } } } } }, null, 2)}\n`;
    await writeFile(globalConfigFile, original);
    const { config, path } = await install({
      components: {
        stargate: false,
        cliproxyapi: false,
        agentClis: false,
        models: true,
      },
      models: { updateGlobalCatalog: true, globalConfigFile, teamFiles: [] },
    });
    const edited = original.replace(
      '"id": "high"',
      '"id": "high", "settings": { "reasoningEffort": "high" }',
    );
    fixture.onCommand = async (command) => {
      if (command.includes("stop stargate.service"))
        await writeFile(globalConfigFile, edited);
    };
    const { report } = await run(config, path);
    expect(await readFile(globalConfigFile, "utf8")).toBe(edited);
    expect(
      report.components.find((component) => component.id === "models"),
    ).toMatchObject({ status: "rolled-back", reason: "external-change" });
    expect(fixture.sessions.get("ses_captain")?.id).toBe("gpt-6.1-sol");
  });

  test("global catalog discovers newly served models after proxy update in the same run", async () => {
    const globalConfigFile = join(
      base,
      `proxy-catalog-${crypto.randomUUID()}.json`,
    );
    await writeFile(
      globalConfigFile,
      `${JSON.stringify({ providers: { "openai-proxy": { models: { "gpt-6.1-sol": { variants: [{ id: "high" }] } } } } }, null, 2)}\n`,
    );
    const { config, path } = await install({
      components: {
        stargate: false,
        cliproxyapi: true,
        agentClis: false,
        models: true,
      },
      models: { updateGlobalCatalog: true, globalConfigFile, teamFiles: [] },
    });
    fixture.proxyModelIDs = () =>
      fixture.commands.some((command) =>
        command.join(" ").includes("restart cpa.service"),
      )
        ? ["gpt-6.1-sol", "gpt-6.2-sol"]
        : ["gpt-6.1-sol"];
    const { report } = await run(config, path);
    expect(statusOf(report, "cliproxyapi")).toBe("updated");
    expect(statusOf(report, "models")).toBe("updated");
    expect(await readFile(globalConfigFile, "utf8")).toContain("gpt-6.2-sol");
    expect(fixture.sessions.get("ses_captain")?.id).toBe("gpt-6.2-sol");
  });

  test("global catalog failed probe and unknown families never write; suffixed products are reported only", async () => {
    const globalConfigFile = join(
      base,
      `failed-catalog-${crypto.randomUUID()}.json`,
    );
    const original = `${JSON.stringify({ providers: { "openai-proxy": { models: { "gpt-6.1-sol": { variants: [{ id: "high" }] }, "gpt-6-mystery": {} } } } }, null, 2)}\n`;
    await writeFile(globalConfigFile, original);
    const { config, path } = await install({
      components: {
        stargate: false,
        cliproxyapi: false,
        agentClis: false,
        models: true,
      },
      models: { updateGlobalCatalog: true, globalConfigFile, teamFiles: [] },
    });
    fixture.proxyModelIDs = () => [
      "gpt-6.2-sol",
      "gpt-7-mystery",
      "gpt-6.2-sol-fast",
      "gpt-6.2-sol-ultrafast",
    ];
    fixture.probeOK = () => false;
    const { report } = await run(config, path);
    expect(await readFile(globalConfigFile, "utf8")).toBe(original);
    expect(fixture.probes).toEqual(["responses:gpt-6.2-sol"]);
    expect(
      report.models
        .filter((change) => change.reason === "new-product")
        .map((change) => change.to),
    ).toEqual(["gpt-6.2-sol-fast", "gpt-6.2-sol-ultrafast"]);
    expect(report.models.some((change) => change.to.includes("mystery"))).toBe(
      false,
    );
  });

  test("new child agents must load from the selected profile", async () => {
    const profiles = join(base, `profiles-${crypto.randomUUID()}`);
    const agent = (model: string, disabled = false) =>
      `---\ndescription: Work (${model})\nmode: subagent\nmodel: ${model}\n${disabled ? "disabled: true\n" : ""}---\n\nTask.\n`;
    const routes = (name: string, model: string) =>
      `${JSON.stringify({ version: 1, profile: "x", routes: [1, 2, 3, 4, 5].map(() => ({ name, model })) }, null, 2)}\n`;
    for (const folder of ["01-blended", "02-codex"]) {
      await mkdir(join(profiles, folder), { recursive: true });
      await writeFile(join(profiles, folder, "PROFILE"), "Profile\n");
      await writeFile(
        join(profiles, folder, "availability.json"),
        '{"missing":[]}\n',
      );
    }
    await writeFile(
      join(profiles, "01-blended", "routes.json"),
      routes("sol-6-1-high-subagent", "openai-proxy/gpt-6.1-sol#high"),
    );
    await writeFile(
      join(profiles, "01-blended", "sol-6-1-high-subagent.md"),
      agent("openai-proxy/gpt-6.1-sol#high"),
    );
    await writeFile(
      join(profiles, "02-codex", "routes.json"),
      routes("other-subagent", "go-proxy/kimi-k3#max"),
    );
    await writeFile(
      join(profiles, "02-codex", "other-subagent.md"),
      agent("go-proxy/kimi-k3#max"),
    );
    await writeFile(
      join(profiles, "02-codex", "sol-6-1-high-subagent.md"),
      agent("openai-proxy/gpt-6.1-sol#high", true),
    );
    await symlink("01-blended", join(profiles, "current"));
    await mkdir(join(base, "agents"), { recursive: true });
    // A third profile routes the same agent but is not selected.
    await mkdir(join(profiles, "03-other"), { recursive: true });
    await writeFile(join(profiles, "03-other", "PROFILE"), "Profile\n");
    await writeFile(
      join(profiles, "03-other", "routes.json"),
      routes("sol-6-1-xhigh-subagent", "openai-proxy/gpt-6.1-sol#xhigh"),
    );
    await writeFile(
      join(profiles, "03-other", "sol-6-1-xhigh-subagent.md"),
      agent("openai-proxy/gpt-6.1-sol#xhigh"),
    );
    const globalConfigFile = join(profiles, "global.json");
    await writeFile(
      globalConfigFile,
      `${JSON.stringify({ providers: { "openai-proxy": { models: { "gpt-6.1-sol": { variants: [{ id: "high" }, { id: "xhigh" }] } } } } }, null, 2)}\n`,
    );
    const { config, path } = await install({
      components: {
        stargate: false,
        cliproxyapi: false,
        agentClis: false,
        models: true,
      },
      models: {
        agentProfiles: profiles,
        updateGlobalCatalog: true,
        globalConfigFile,
        teamFiles: [],
      },
    });
    // Only the selected profile's route must load. The unselected profile's
    // renamed agent (sol-6-2-xhigh) is not in the live catalog and is not
    // required.
    fixture.agents = [
      {
        id: "sol-6-2-high-subagent",
        mode: "subagent",
        model: {
          providerID: "openai-proxy",
          id: "gpt-6.2-sol",
          variant: "high",
        },
      },
    ];
    const good = await run(config, path);
    expect(good.report.outcome).toBe("completed");
    expect(good.report.models).toContainEqual(
      expect.objectContaining({
        scope: "catalog",
        status: "applied",
        to: "openai-proxy/gpt-6.2-sol",
      }),
    );
    expect(good.report.models).toContainEqual(
      expect.objectContaining({
        scope: "agent-profile",
        status: "applied",
        to: "openai-proxy/gpt-6.2-sol#high",
      }),
    );
    expect(
      await readFile(
        join(profiles, "01-blended", "sol-6-2-high-subagent.md"),
        "utf8",
      ),
    ).not.toContain("disabled");
    expect(
      await readFile(
        join(profiles, "02-codex", "sol-6-2-high-subagent.md"),
        "utf8",
      ),
    ).toContain("disabled: true");
    await rm(join(base, "agents"), { recursive: true, force: true });
  });

  test("an agent missing after reload rolls the profiles back", async () => {
    const profiles = join(base, `profiles-${crypto.randomUUID()}`);
    await mkdir(join(profiles, "01-blended"), { recursive: true });
    const model = "openai-proxy/gpt-6.1-sol#high";
    const routesText = `${JSON.stringify({ version: 1, profile: "01-blended", routes: [1, 2, 3, 4, 5].map(() => ({ name: "sol-6-1-high-subagent", model })) }, null, 2)}\n`;
    await writeFile(join(profiles, "01-blended", "routes.json"), routesText);
    await writeFile(join(profiles, "01-blended", "PROFILE"), "Profile\n");
    await writeFile(
      join(profiles, "01-blended", "sol-6-1-high-subagent.md"),
      `---\ndescription: (${model})\nmode: subagent\nmodel: ${model}\n---\n\nTask.\n`,
    );
    await symlink("01-blended", join(profiles, "current"));
    const { config, path } = await install({
      components: {
        stargate: false,
        cliproxyapi: false,
        agentClis: false,
        models: true,
      },
      models: { agentProfiles: profiles, teamFiles: [] },
    });
    fixture.agents = [];
    const { report } = await run(config, path);
    expect(report.components.find((c) => c.id === "models")).toMatchObject({
      status: "rolled-back",
    });
    expect(
      await readFile(join(profiles, "01-blended", "routes.json"), "utf8"),
    ).toBe(routesText);
    expect(await readdir(join(profiles, "01-blended"))).not.toContain(
      "sol-6-2-high-subagent.md",
    );
    expect(fixture.sessions.get("ses_captain")?.id).toBe("gpt-6.1-sol");
  });

  test("a failed gateway stop changes nothing else and restores the CLIs", async () => {
    const { config, path } = await install();
    fixture.stopFails = true;
    const { report, attention } = await run(config, path);
    expect(report.reason).toBe("restart-failed");
    expect(attention).toBe(false);
    expect(commands("systemctl --user restart cpa.service")).toEqual([]);
    expect(commands("systemctl --user restart opencode2.service")).toEqual([]);
    expect(statusOf(report, "npm:@opencode/cli")).toBe("rolled-back");
    expect(statusOf(report, "stargate")).toBe("deferred");
    await expectConsistent(report);
  });

  test("a failed CLI update reinstalls the previous version with its recorded cutoff", async () => {
    const { config, path } = await install({
      components: {
        stargate: false,
        cliproxyapi: false,
        agentClis: true,
        models: false,
      },
    });
    await mkdir(join(config.dataDirectory, "maintenance"), { recursive: true });
    await writeFile(
      join(config.dataDirectory, "maintenance", "state.json"),
      JSON.stringify({
        npm: {
          "@opencode/cli": {
            version: "2.2.7",
            before: "2026-10-05T00:00:00.000Z",
          },
        },
      }),
    );
    fixture.badCliVersion = "2.2.9";
    const { report } = await run(config, path);
    expect(report.components[0]).toMatchObject({
      status: "rolled-back",
      reason: "health-failed",
      after: "2.2.7",
    });
    const installs = commands("npm");
    expect(installs).toHaveLength(2);
    expect(installs[1]).toContain("@opencode/cli@2.2.7");
    expect(installs[1]).toContain("--before=2026-10-05T00:00:00.000Z");
    expect(installs[1]).toContain("--strict-allow-scripts");
    await expectConsistent(report);
  });

  test("work that starts between the gate and the stop defers and undoes", async () => {
    const { config, path } = await install();
    fixture.onCommand = async (command) => {
      if (!command.startsWith("npm install")) return;
      const store = new Store(join(config.dataDirectory, "stargate.sqlite"));
      store.enqueue({
        eventId: "E1",
        botKey: "k",
        conversation: '["k","C123","2.0"]',
        channel: "C123",
        thread: "2.0",
        user: "U123",
        text: "hello",
      });
      store.close();
    };
    const { report } = await run(config, path);
    expect(report).toMatchObject({
      outcome: "deferred",
      reason: "busy-gateway",
    });
    expect(commands("systemctl --user stop")).toEqual([]);
    expect(statusOf(report, "npm:@opencode/cli")).toBe("deferred");
    await expectConsistent(report);
  });

  test("too little time before the window end defers before any stop", async () => {
    const { config, path } = await install();
    fixture.time = Date.parse("2026-11-12T00:45:00Z");
    const { report } = await run(config, path);
    expect(report).toMatchObject({ outcome: "deferred", reason: "deadline" });
    expect(commands("systemctl --user stop")).toEqual([]);
    expect(
      applyBudgetMs({
        proxy: true,
        restart: true,
        release: true,
        live: true,
      }),
    ).toBeGreaterThan(15 * 60_000);
    await expectConsistent(report);
  });

  test("hundreds of Slack-thread sessions neither block nor get switched", async () => {
    const { config, path } = await install();
    const store = new Store(join(config.dataDirectory, "stargate.sqlite"));
    for (let i = 0; i < 200; i++) {
      store.saveSession(`["k","C123","t${i}.0"]`, `ses_thread${i}`);
      fixture.sessions.set(`ses_thread${i}`, {
        providerID: "openai-proxy",
        id: "gpt-6.1-sol",
        variant: "high",
      });
    }
    store.close();
    const { report } = await run(config, path);
    expect(report.outcome).toBe("completed");
    expect(fixture.sessions.get("ses_captain")?.id).toBe("gpt-6.2-sol");
    expect(fixture.sessions.get("ses_thread0")?.id).toBe("gpt-6.1-sol");
    expect(
      report.models.filter((m) => m.scope === "captain-session"),
    ).toHaveLength(1);
  });

  test("catalog verification stops within the reserved live phase before switching sessions", async () => {
    let time = 0;
    let calls = 0;
    const control = {
      ...opencode,
      catalog: async () => {
        calls++;
        time += 10_000;
        return [
          { providerID: "openai-proxy", id: "gpt-6.2-sol", variants: [] },
        ];
      },
      switchModel: async () => {
        throw new Error("Must not switch after catalog timeout");
      },
    } satisfies OpenCodeControl;
    const data = await mkdtemp(join(base, "catalog-cap-"));
    const journal = Journal.create(data, crypto.randomUUID());
    const result = await applyLiveModels(
      {
        upgrades: new Map(),
        files: [],
        profileLinks: [],
        agents: [],
        changes: [],
        sessions: [
          {
            session: { id: "ses_captain", scope: "captain-session" },
            from: { providerID: "openai-proxy", id: "gpt-6.1-sol" },
            to: { providerID: "openai-proxy", id: "gpt-6.2-sol" },
          },
        ],
        catalogChecks: {
          directories: Array.from({ length: 31 }, (_, i) => `/crew/${i}`),
          refs: [{ providerID: "openai-proxy", id: "gpt-6.2-sol" }],
        },
      },
      control,
      journal,
      AbortSignal.timeout(5000),
      { now: () => time, until: 300_000 },
    );
    expect(result.ok).toBe(false);
    expect(time).toBeLessThanOrEqual(300_000);
    expect(calls).toBeLessThanOrEqual(30);
    expect(journal.empty).toBe(true);
  });

  test("the session phase stops at its cap; the rest stay valid and are reported", async () => {
    const sessions = Array.from({ length: 10 }, (_, i) => ({
      session: { id: `ses_crew${i}`, scope: "crew-session" as const },
      from: { providerID: "openai-proxy", id: "gpt-6.1-sol" },
      to: { providerID: "openai-proxy", id: "gpt-6.2-sol" },
    }));
    const models = new Map(sessions.map((s) => [s.session.id, s.from]));
    let time = 0;
    const control = {
      ...opencode,
      sessionModel: async (id: string) => models.get(id) ?? null,
      switchModel: async (id: string, model: ModelRef) => {
        time += 60_000;
        models.set(id, model);
      },
    } satisfies OpenCodeControl;
    const data = await mkdtemp(join(base, "cap-"));
    const journal = Journal.create(data, crypto.randomUUID());
    const result = await applyLiveModels(
      {
        upgrades: new Map(),
        files: [],
        profileLinks: [],
        agents: [],
        sessions,
        changes: [],
      },
      control,
      journal,
      AbortSignal.timeout(5000),
      { now: () => time, until: 5 * 60_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.skipped.map((s) => s.id)).toEqual(
      sessions.slice(5).map((s) => s.session.id),
    );
    expect(journal.get("sessions")).toHaveLength(5);
    expect(models.get("ses_crew9")?.id).toBe("gpt-6.1-sol");
  });

  test("unknown crew state defers (fail closed)", async () => {
    const { config, path } = await install();
    await writeFile(
      join(fixture.dir, "captain", ".opencode", "opencode.json"),
      "{ broken",
    );
    const { report } = await run(config, path);
    expect(report).toMatchObject({
      outcome: "deferred",
      reason: "idle-unknown",
    });
    expect(commands("npm")).toEqual([]);
  });

  test("a starting (auto-restart) gateway is stopped like an active one", async () => {
    const { config, path } = await install({
      components: {
        stargate: false,
        cliproxyapi: false,
        agentClis: true,
        models: false,
      },
    });
    fixture.gateway = "activating";
    await run(config, path);
    expect(commands("systemctl --user stop stargate.service")).toHaveLength(1);
  });

  test("a report that cannot be written does not hide the outcome", async () => {
    const { config, path } = await install({
      components: {
        stargate: false,
        cliproxyapi: false,
        agentClis: true,
        models: false,
      },
    });
    await mkdir(join(config.dataDirectory, "maintenance"), { recursive: true });
    await writeFile(
      join(config.dataDirectory, "maintenance", "reports"),
      "not a directory",
    );
    const result = await run(config, path);
    expect(result.reportPath).toBeUndefined();
    expect(result.attention).toBe(true);
    expect(result.report.outcome).toBe("completed");
    expect(
      await readFile(
        join(config.dataDirectory, "maintenance", "ALERT.json"),
        "utf8",
      ),
    ).toContain('"report": null');
  });

  test("model probes use each provider's protocol and fail closed", async () => {
    const { config } = await install();
    const proxy = config.maintenance?.proxy;
    if (!proxy) throw new Error("proxy");
    const signal = AbortSignal.timeout(5000);
    expect(await probeModel(proxy, "claude-opus-5-6", signal)).toBe(true);
    expect(await probeModel(proxy, "gpt-6.2-sol", signal)).toBe(true);
    expect(fixture.probes).toEqual([
      "messages:claude-opus-5-6",
      "responses:gpt-6.2-sol",
    ]);
    expect(
      await probeModel(
        { ...proxy, url: "http://127.0.0.1:9" },
        "gpt-6.2-sol",
        signal,
      ),
    ).toBe(false);
    expect(
      await probeModel(
        { ...proxy, clientKeyFile: join(fixture.dir, "missing.key") },
        "gpt-6.2-sol",
        signal,
      ),
    ).toBe(false);
  });

  test("refuses to run outside the window or when disabled", async () => {
    const { config, path } = await install();
    fixture.time = Date.parse("2026-11-12T12:00:00Z");
    await expect(run(config, path)).rejects.toThrow(
      "Outside the maintenance window",
    );
    if (config.maintenance) config.maintenance.enabled = false;
    await expect(run(config, path)).rejects.toThrow("disabled");
  });
});

// ---- Journal recovery ---------------------------------------------------
const writeJournal = async (config: Config, journal: unknown) => {
  const directory = join(config.dataDirectory, "maintenance");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "journal.json");
  await writeFile(path, JSON.stringify(journal), { mode: 0o600 });
  return path;
};
const v2 = (fields: Record<string, unknown>) => ({
  schema: "stargate.maintenance.journal.v2",
  runID: crypto.randomUUID(),
  ...fields,
});
const teamPath = () => join(fixture.dir, "team.json");

/** Only a Stargate release is due. */
async function stargateOnly(overrides: Record<string, unknown> = {}) {
  const installed = await install(overrides);
  if (!installed.config.maintenance) throw new Error("no maintenance");
  installed.config.maintenance.components = {
    stargate: true,
    cliproxyapi: false,
    agentClis: false,
    models: false,
  };
  return installed;
}
/** The running release records a crew plugin: the release's, or another. */
async function runningPlugin(plugin = releaseFiles["src/crew/plugin.ts"]) {
  const old = join(fixture.dir, "stargate", "releases", "old");
  for (const [path, text] of Object.entries({
    ...releaseFiles,
    "src/crew/plugin.ts": plugin,
  })) {
    await mkdir(dirname(join(old, path)), { recursive: true });
    await writeFile(join(old, path), text);
  }
  expect(await writePluginDigest(old)).toMatch(/^v1:/);
}
const queueJob = (config: Config) => {
  const store = new Store(join(config.dataDirectory, "stargate.sqlite"));
  store.enqueue({
    eventId: "E-busy",
    botKey: "k",
    conversation: '["k","C123","1.0"]',
    channel: "C123",
    thread: "1.0",
    user: "U123",
    text: "work",
  });
  store.close();
};
const stepNames = (report: { steps: { name: string }[] }) =>
  report.steps.map((step) => step.name);

describe("gateway-only update", () => {
  test("an unchanged crew plugin restarts the gateway only, also while the crew works", async () => {
    const { config, path } = await stargateOnly();
    await runningPlugin();
    // Stargate's own captain session runs, and OpenCode cannot be asked.
    fixture.active = ["ses_captain"];
    const { report, attention } = await run(config, path, "run", {
      connect: async () => {
        throw new Error("OpenCode must not be consulted");
      },
    });
    expect(attention).toBe(false);
    expect(report.outcome).toBe("completed");
    expect(statusOf(report, "stargate")).toBe("updated");
    expect(stepNames(report)).toEqual([
      "stargate-stage",
      "crew-plugin-unchanged",
      "idle-gate",
      "idle-before-stop",
      "gateway-stop",
      "idle-after-stop",
      "stargate-switch",
      "gateway-ready",
    ]);
    expect(report.restarts.map((restart) => restart.service)).toEqual([
      "gateway",
    ]);
    expect(fixture.openCodeRestarts).toBe(0);
    expect(await live()).toMatchObject({
      release: "releases/0.2.0",
      gateway: "active",
      journal: null,
    });
    // OpenCode still runs the plugin from the earlier release directory.
    expect((await readState(config.dataDirectory)).openCodeRelease).toBe("old");
  });

  test("a gateway job defers it; nothing is stopped", async () => {
    const { config, path } = await stargateOnly();
    await runningPlugin();
    queueJob(config);
    const { report } = await run(config, path);
    expect(report).toMatchObject({
      outcome: "deferred",
      reason: "busy-gateway",
    });
    expect(commands("systemctl --user stop")).toEqual([]);
    expect((await live()).release).toBe("releases/old");
  });

  test("a changed or unknown crew plugin takes the full path", async () => {
    for (const plugin of ["export const plugin = 1;\n", undefined]) {
      const { config, path } = await stargateOnly();
      // Undefined: the running release has no recorded digest.
      if (plugin) await runningPlugin(plugin);
      await updateState(config.dataDirectory, (state) => {
        state.openCodeRelease = "old";
      });
      // The full path waits for Stargate's sessions.
      fixture.active = ["ses_captain"];
      expect((await run(config, path)).report).toMatchObject({
        outcome: "deferred",
        reason: "busy-opencode",
      });
      fixture.active = [];
      fixture.time = now;
      const { report } = await run(config, path);
      expect(statusOf(report, "stargate")).toBe("updated");
      expect(stepNames(report)).not.toContain("crew-plugin-unchanged");
      expect(stepNames(report)).toContain("opencode-restart");
      expect(fixture.openCodeRestarts).toBe(1);
      // OpenCode runs the plugin of `current` again.
      expect(
        (await readState(config.dataDirectory)).openCodeRelease,
      ).toBeNull();
    }
  });

  test("other updates in the same run take the full path", async () => {
    const { config, path } = await install();
    await runningPlugin();
    const { report } = await run(config, path);
    expect(statusOf(report, "stargate")).toBe("updated");
    expect(stepNames(report)).not.toContain("crew-plugin-unchanged");
    expect(fixture.openCodeRestarts).toBe(1);
    await expectConsistent(report);
  });

  test("a gateway that is not ready goes back to the previous release without an OpenCode restart", async () => {
    const { config, path } = await stargateOnly();
    await runningPlugin();
    fixture.readyVersions = new Set(["0.1.0"]);
    const { report } = await run(config, path);
    expect(statusOf(report, "stargate")).toBe("rolled-back");
    expect(report.reason).toBeUndefined();
    expect(fixture.openCodeRestarts).toBe(0);
    expect(await live()).toMatchObject({
      release: "releases/old",
      gateway: "active",
      journal: null,
    });
    const state = await readState(config.dataDirectory);
    expect(state.failedReleases["0.2.0"]?.reason).toBe("readiness-failed");
    expect(state.openCodeRelease).toBeNull();
  });

  test("an interrupted gateway-only update is undone while the crew works", async () => {
    const { config, path } = await stargateOnly();
    await runningPlugin();
    expect(statusOf((await run(config, path)).report, "stargate")).toBe(
      "updated",
    );
    // As a kill leaves it after the switch: the release is not committed
    // and the gateway is stopped. No OpenCode entry exists.
    await writeJournal(
      config,
      v2({
        gateway: { restartPending: false },
        release: { previous: "old", version: "0.2.0" },
      }),
    );
    fixture.gateway = "inactive";
    fixture.time = now;
    fixture.commands = [];
    // The next run undoes it with the gateway idle only.
    fixture.active = ["ses_captain"];
    const next = await run(config, path);
    expect(next.report.steps.slice(0, 2)).toMatchObject([
      { name: "start-stopped-gateway", status: "ok" },
      { name: "recover-previous-run", status: "ok" },
    ]);
    expect(next.report.rollbacks).toMatchObject([
      { component: "stargate", to: "old", status: "ok" },
    ]);
    expect(fixture.openCodeRestarts).toBe(0);
    // The same run then installs the release again, gateway only.
    expect(statusOf(next.report, "stargate")).toBe("updated");
    expect(await live()).toMatchObject({
      release: "releases/0.2.0",
      gateway: "active",
      journal: null,
    });
  });

  test("the release that OpenCode still runs is not removed", async () => {
    const { config, path } = await stargateOnly();
    await runningPlugin();
    // OpenCode loaded its plugin two gateway-only updates ago.
    const root = join(fixture.dir, "stargate");
    for (const [name, version] of [
      ["loaded", "0.0.1"],
      ["unused", "0.0.2"],
    ] as const) {
      const directory = join(root, "releases", name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "package.json"), "{}\n");
      await writeFile(
        join(directory, ".stargate-release.json"),
        (
          await readFile(
            join(root, "releases", "old", ".stargate-release.json"),
            "utf8",
          )
        ).replace('"0.1.0"', `"${version}"`),
      );
    }
    await updateState(config.dataDirectory, (state) => {
      state.openCodeRelease = "loaded";
    });
    if (config.maintenance?.stargate) config.maintenance.stargate.keep = 2;
    const { report } = await run(config, path);
    expect(statusOf(report, "stargate")).toBe("updated");
    const left = (await readdir(join(root, "releases"))).sort();
    expect(left).toEqual(["0.2.0", "loaded", "old"]);
    expect((await readState(config.dataDirectory)).openCodeRelease).toBe(
      "loaded",
    );
  });
});

describe("operator update", () => {
  const noon = Date.parse("2026-11-12T12:00:00Z");
  const update = (
    config: Config,
    path: string,
    version: string,
    options: { mode?: "plan" | "run"; retryFailed?: boolean } = {},
    extra: Partial<Dependencies> = {},
  ) =>
    runMaintenance(
      {
        config,
        configPath: path,
        mode: options.mode ?? "run",
        update: {
          version,
          ...(options.retryFailed ? { retryFailed: true } : {}),
        },
        signal: fixture.controller.signal,
      },
      deps(extra),
    );
  const reports = (config: Config) =>
    readdir(join(config.dataDirectory, "maintenance", "reports")).catch(
      () => [],
    );

  test("updates the Stargate release now: no window, no idle gate, no cool-off, nothing else", async () => {
    // Every component is configured; tonight's run would update them all.
    const { config, path } = await install();
    if (!config.maintenance?.stargate) throw new Error("no maintenance");
    config.maintenance.enabled = false;
    config.maintenance.stargate.coolOffHours = 24;
    // Outside the window, with a running captain turn and a queued request.
    fixture.time = noon;
    fixture.active = ["ses_captain"];
    queueJob(config);
    const { report, attention } = await update(config, path, "0.2.0");
    expect(attention).toBe(false);
    expect(report.outcome).toBe("completed");
    expect(report.components).toMatchObject([
      { id: "stargate", before: "0.1.0", after: "0.2.0", status: "updated" },
    ]);
    expect(report.models).toEqual([]);
    expect(stepNames(report)).toEqual([
      "operator-update",
      "stargate-stage",
      "gateway-stop",
      "stargate-switch",
      "opencode-restart",
      "gateway-ready",
    ]);
    // The running release has no plugin digest: OpenCode restarts.
    expect(report.restarts.map((restart) => restart.service)).toEqual([
      "opencode",
      "gateway",
    ]);
    expect(await live()).toMatchObject({
      release: "releases/0.2.0",
      proxy: expect.stringContaining("8.0.54"),
      cli: "2.2.7",
      team: "openai-proxy/gpt-6.1-sol#high",
      gateway: "active",
      journal: null,
    });
    expect(commands("npm")).toEqual([]);
  });

  test("an unchanged crew plugin restarts the gateway only", async () => {
    const { config, path } = await install();
    await runningPlugin();
    fixture.time = noon;
    const { report } = await update(config, path, "0.2.0");
    expect(statusOf(report, "stargate")).toBe("updated");
    expect(stepNames(report)).toContain("crew-plugin-unchanged");
    expect(report.restarts.map((restart) => restart.service)).toEqual([
      "gateway",
    ]);
    expect(fixture.openCodeRestarts).toBe(0);
    expect((await readState(config.dataDirectory)).openCodeRelease).toBe("old");
  });

  test("--plan changes nothing", async () => {
    const { config, path } = await install();
    fixture.time = noon;
    const { report, reportPath } = await update(config, path, "0.2.0", {
      mode: "plan",
    });
    expect(reportPath).toBeUndefined();
    expect(report.components).toMatchObject([
      { id: "stargate", candidate: "0.2.0", status: "planned" },
    ]);
    expect(fixture.commands).toEqual([]);
    expect(await reports(config)).toEqual([]);
    expect(await readdir(join(fixture.dir, "stargate", "releases"))).toEqual([
      "old",
    ]);
    expect(await live()).toMatchObject({
      release: "releases/old",
      journal: null,
    });
  });

  test("refuses a downgrade, the current version and an unknown version", async () => {
    const { config, path } = await install();
    fixture.time = noon;
    for (const [version, expected] of [
      ["0.0.9", { status: "skipped", reason: "version-mismatch" }],
      ["0.1.0", { status: "unchanged" }],
      ["0.3.0", { status: "failed", reason: "not-found" }],
    ] as const) {
      const { report } = await update(config, path, version);
      expect(report.components).toMatchObject([
        { id: "stargate", ...expected },
      ]);
    }
    await expect(update(config, path, "v0.2")).rejects.toThrow(UpdateRefused);
    expect(commands("systemctl")).toEqual([]);
    expect((await live()).release).toBe("releases/old");
  });

  test("a release that cannot be verified is not installed", async () => {
    const { config, path } = await install();
    if (!config.maintenance?.stargate) throw new Error("no maintenance");
    // The tree comparison is required but no checkout is configured.
    config.maintenance.stargate.requireTreeCheck = true;
    fixture.time = noon;
    const { report } = await update(config, path, "0.2.0");
    expect(report.components).toMatchObject([
      { id: "stargate", status: "failed", reason: "not-configured" },
    ]);
    expect(commands("systemctl")).toEqual([]);
    expect((await live()).release).toBe("releases/old");
  });

  test("a release that failed here needs --retry-failed", async () => {
    const { config, path } = await install();
    fixture.time = noon;
    await updateState(config.dataDirectory, (state) => {
      state.failedReleases["0.2.0"] = {
        reason: "readiness-failed",
        at: new Date(noon).toISOString(),
      };
    });
    const refused = await update(config, path, "0.2.0");
    expect(refused.report.components).toMatchObject([
      { id: "stargate", status: "skipped", reason: "known-bad" },
    ]);
    expect(commands("systemctl")).toEqual([]);
    const retried = await update(config, path, "0.2.0", { retryFailed: true });
    expect(statusOf(retried.report, "stargate")).toBe("updated");
    expect(
      (await readState(config.dataDirectory)).failedReleases["0.2.0"],
    ).toBeUndefined();
  });

  test("a leftover journal is refused; recover is the operator's step", async () => {
    const { config, path } = await install();
    fixture.time = noon;
    const journalPath = await writeJournal(
      config,
      v2({ gateway: { restartPending: true } }),
    );
    const before = await readFile(journalPath, "utf8");
    for (const mode of ["plan", "run"] as const)
      await expect(update(config, path, "0.2.0", { mode })).rejects.toThrow(
        "stargate maintenance recover",
      );
    expect(await readFile(journalPath, "utf8")).toBe(before);
    expect(fixture.commands).toEqual([]);
    expect(await reports(config)).toEqual([]);
  });

  test("a gateway that is not ready goes back at once, also on a busy host", async () => {
    const { config, path } = await install();
    fixture.time = noon;
    fixture.readyVersions = new Set(["0.1.0"]);
    fixture.active = ["ses_captain"];
    queueJob(config);
    const { report } = await update(config, path, "0.2.0");
    expect(statusOf(report, "stargate")).toBe("rolled-back");
    expect(report.steps.map((step) => step.status)).not.toContain("skipped");
    expect(await live()).toMatchObject({
      release: "releases/old",
      gateway: "active",
      journal: null,
    });
    expect(
      (await readState(config.dataDirectory)).failedReleases["0.2.0"]?.reason,
    ).toBe("readiness-failed");
  });

  test("a killed update is undone by its ExecStopPost, also on a busy host; a killed nightly run is not", async () => {
    for (const operator of [true, false]) {
      const { config, path } = await install();
      if (!config.maintenance) throw new Error("no maintenance");
      config.maintenance.components = {
        stargate: true,
        cliproxyapi: false,
        agentClis: false,
        models: false,
      };
      fixture.active = [];
      if (operator) await update(config, path, "0.2.0");
      else await run(config, path);
      // As a kill leaves it right after the gateway started on the new
      // release: the switch is not committed.
      const runID = crypto.randomUUID();
      await writeJournal(config, {
        ...v2({
          gateway: { restartPending: false },
          release: { previous: "old", version: "0.2.0" },
        }),
        runID,
      });
      await writeFile(
        join(config.dataDirectory, "maintenance", "last-run.json"),
        JSON.stringify({
          runID,
          invocationID: invocation.INVOCATION_ID,
          ...(operator ? { operator: true } : {}),
        }),
      );
      const alert = join(config.dataDirectory, "maintenance", "ALERT.json");
      expect(await live()).toMatchObject({
        release: "releases/0.2.0",
        gateway: "active",
      });
      // A hard kill writes no alert, and work has arrived meanwhile.
      await rm(alert, { force: true });
      fixture.active = ["ses_captain"];
      queueJob(config);
      const after = await recoverInterruptedRun(
        config,
        deps({ env: invocation }),
        { afterRun: true },
      );
      if (operator) {
        // The operator accepted the interruption: no idle check.
        expect(after.ok).toBe(true);
        expect(await live()).toMatchObject({
          release: "releases/old",
          gateway: "active",
          journal: null,
        });
        expect(await readFile(alert, "utf8").catch(() => null)).toBeNull();
      } else {
        // The nightly undo waits for an idle host, and says so.
        // The gateway restart that the undo owes waits for an idle host.
        expect(after.ok).toBe(false);
        expect(
          JSON.parse((await readJournalFile(config.dataDirectory)) ?? "{}"),
        ).toMatchObject({ gateway: { restartPending: true } });
        expect(JSON.parse(await readFile(alert, "utf8"))).toMatchObject({
          schema: "stargate.maintenance.alert.v1",
          runID,
          outcome: "failed",
          reason: "recovery-required",
          journal: true,
        });
        // The alert of this journal is written once, not replaced.
        const first = await readFile(alert, "utf8");
        fixture.time += 60_000;
        await recoverInterruptedRun(config, deps({ env: invocation }), {
          afterRun: true,
        });
        expect(await readFile(alert, "utf8")).toBe(first);
      }
    }
  });

  describe("command", () => {
    const unit = {
      executable: "/opt/bun",
      path: "/opt:/usr/local/bin:/usr/bin:/bin",
    };
    /** The installed Stargate that runs the command: a verified release. */
    const installed = async (config: Config, name = "caller") => {
      const root = config.maintenance?.stargate?.root;
      if (!root) throw new Error("no release root");
      const directory = join(root, "releases", name);
      await mkdir(join(directory, "src"), { recursive: true });
      await writeFile(join(directory, "src", "main.ts"), "");
      await writeFile(
        join(directory, ".stargate-release.json"),
        JSON.stringify({
          ...JSON.parse(
            await readFile(
              join(root, "releases", "old", ".stargate-release.json"),
              "utf8",
            ),
          ),
          verification: "verified",
          tree: "equal",
        }),
      );
      return join(directory, "src", "main.ts");
    };
    const command = async (
      config: Config,
      path: string,
      options: Omit<UpdateOptions, "configPath">,
      overrides: { entrypoint?: string } = {},
    ) => {
      const launched: string[][] = [];
      const printed: string[] = [];
      const entrypoint = overrides.entrypoint ?? (await installed(config));
      const code = await maintenanceUpdate(
        config,
        { configPath: path, ...options },
        {
          unit: { ...unit, entrypoint },
          launcher: {
            async run(argv) {
              launched.push([...argv]);
              return { code: 0, stdout: "", stderr: "" };
            },
          },
          run: deps(),
          print: (text) => printed.push(text),
          now: () => noon,
          signal: fixture.controller.signal,
        },
      );
      return { code, launched, text: printed.join("\n"), entrypoint };
    };

    test("--now starts a transient unit after the read-only checks and returns", async () => {
      const { config, path } = await install();
      fixture.time = noon;
      const { code, launched, text, entrypoint } = await command(config, path, {
        version: "0.2.0",
        now: true,
      });
      expect(code).toBe(0);
      const name = `stargate-update-0-2-0-${noon / 1000}`;
      expect(launched).toEqual([
        [
          "systemd-run",
          "--user",
          "--service-type=exec",
          "--collect",
          `--unit=${name}`,
          "--description=Stargate operator update to 0.2.0",
          `--working-directory=${dirname(path)}`,
          `--property=EnvironmentFile=-${path}.env`,
          "--property=UMask=0077",
          "--property=RuntimeMaxSec=100min",
          expect.stringMatching(/^--property=TimeoutStopSec=\d+min$/),
          `--property=ExecStopPost="/opt/bun" "${entrypoint}" maintenance recover --after-run --config "${path}"`,
          "--setenv=PATH=/opt:/usr/local/bin:/usr/bin:/bin",
          "--",
          "/opt/bun",
          entrypoint,
          "maintenance",
          "update",
          "--version",
          "0.2.0",
          "--now",
          "--foreground",
          "--config",
          path,
        ],
      ]);
      expect(text).toContain(
        `Started ${name}.service: Stargate 0.1.0 → 0.2.0.`,
      );
      expect(text).toContain(join(config.dataDirectory, "maintenance/reports"));
      expect(text).toContain("ready.json");
      // The command itself changed nothing.
      expect(fixture.commands).toEqual([]);
      expect((await live()).release).toBe("releases/old");
    });

    test("the unit runs this release with a fixed PATH", () => {
      const own = updateUnit();
      expect(own.entrypoint).toBe(
        join(import.meta.dir, "..", "src", "main.ts"),
      );
      expect(own.executable).toBe(process.execPath);
      // Never the caller's PATH.
      expect(own.path).toBe(
        `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      );
    });

    test("only an installed, verified release makes the update; a checkout is refused", async () => {
      const { config, path } = await install();
      const root = config.maintenance?.stargate?.root;
      if (!root) throw new Error("no release root");
      fixture.time = noon;
      await runningPlugin();
      const outside = join(fixture.dir, "checkout", "src", "main.ts");
      await mkdir(dirname(outside), { recursive: true });
      await writeFile(outside, "");
      // Verified metadata does not make a directory elsewhere a release.
      await writeFile(
        join(fixture.dir, "checkout", ".stargate-release.json"),
        await readFile(
          join(
            dirname(dirname(await installed(config))),
            ".stargate-release.json",
          ),
          "utf8",
        ),
      );
      // A link into the releases directory is the checkout, not a release.
      await symlink(
        join(fixture.dir, "checkout"),
        join(root, "releases", "linked"),
      );
      await mkdir(join(root, "releases", "bare", "src"), { recursive: true });
      for (const entrypoint of [
        // This checkout: the tests' own code.
        join(import.meta.dir, "..", "src", "main.ts"),
        outside,
        join(root, "releases", "linked", "src", "main.ts"),
        // A managed release that maintenance did not verify, or no release.
        join(root, "releases", "old", "src", "main.ts"),
        join(root, "releases", "bare", "src", "main.ts"),
        join(root, "releases", "missing", "src", "main.ts"),
      ])
        for (const foreground of [false, true]) {
          const attempt = command(
            config,
            path,
            {
              version: "0.2.0",
              now: true,
              ...(foreground ? { foreground } : {}),
            },
            { entrypoint },
          );
          await expect(attempt).rejects.toThrow(UpdateRefused);
          await expect(attempt).rejects.toThrow("Run the installed stargate");
        }
      // Nothing ran: no unit, no stage, no switch.
      expect(fixture.commands).toEqual([]);
      expect((await live()).release).toBe("releases/old");
      // The plan is read-only and works from anywhere.
      const plan = await command(
        config,
        path,
        { version: "0.2.0", plan: true },
        { entrypoint: outside },
      );
      expect(plan.code).toBe(0);
      expect(plan.launched).toEqual([]);
    });

    test("a unit that systemd could not start is reported; nothing changed", async () => {
      const { config, path } = await install();
      fixture.time = noon;
      await expect(
        maintenanceUpdate(
          config,
          { configPath: path, version: "0.2.0", now: true },
          {
            unit: { ...unit, entrypoint: await installed(config) },
            launcher: {
              async run() {
                return { code: 1, stdout: "", stderr: "exec failed: secret" };
              },
            },
            run: deps(),
            print: () => {},
            now: () => noon,
            signal: fixture.controller.signal,
          },
        ),
      ).rejects.toThrow("could not start the update unit");
      expect((await live()).release).toBe("releases/old");
    });

    test("a refused update starts no unit", async () => {
      const { config, path } = await install();
      fixture.time = noon;
      for (const [version, message] of [
        ["0.0.9", "older than the current release 0.1.0"],
        ["0.3.0", "no published release 0.3.0"],
      ] as const) {
        const { code, launched, text } = await command(config, path, {
          version,
          now: true,
        });
        expect([code, launched]).toEqual([1, []]);
        expect(text).toContain(message);
      }
      await updateState(config.dataDirectory, (state) => {
        state.failedReleases["0.2.0"] = {
          reason: "readiness-failed",
          at: new Date(noon).toISOString(),
        };
      });
      const bad = await command(config, path, { version: "0.2.0", now: true });
      expect([bad.code, bad.launched]).toEqual([1, []]);
      expect(bad.text).toContain("--retry-failed");
      const retry = await command(config, path, {
        version: "0.2.0",
        now: true,
        retryFailed: true,
      });
      expect(retry.code).toBe(0);
      expect(retry.launched[0]?.at(-1)).toBe("--retry-failed");
      for (const options of [
        { version: "0.2.0" },
        { version: "0.2.0", plan: true, now: true },
        { version: "0.2", now: true },
        { now: true },
        { version: "0.2.0", plan: true, foreground: true },
      ])
        await expect(command(config, path, options)).rejects.toThrow(
          UpdateRefused,
        );
    });

    test("--plan says what would happen and which services restart", async () => {
      const { config, path } = await install();
      fixture.time = noon;
      const first = await command(config, path, {
        version: "0.2.0",
        plan: true,
      });
      expect([first.code, first.launched]).toEqual([0, []]);
      expect(first.text).toContain("Stargate 0.1.0 → 0.2.0");
      expect(first.text).toContain("Restart: decided after staging.");
      expect(first.text).toContain("Nothing was changed.");
      expect(fixture.commands).toEqual([]);
    });

    test("--plan names the restart once the release is staged", async () => {
      for (const same of [true, false]) {
        const { config, path } = await install();
        if (same) await runningPlugin();
        fixture.time = noon;
        // Staged and verified, then rolled back: not the current release.
        fixture.readyVersions = new Set(["0.1.0"]);
        const failed = await update(config, path, "0.2.0");
        expect(statusOf(failed.report, "stargate")).toBe("rolled-back");
        fixture.commands = [];
        const { code, text } = await command(config, path, {
          version: "0.2.0",
          plan: true,
          retryFailed: true,
        });
        expect(code).toBe(0);
        expect(text).toContain(
          same
            ? "Restart: the gateway only (the crew plugin is unchanged)."
            : "Restart: OpenCode and the gateway (the crew plugin changed or is unknown).",
        );
        expect(fixture.commands).toEqual([]);
      }
    });

    test("--foreground runs the update and reports its result", async () => {
      const { config, path } = await install();
      await runningPlugin();
      fixture.time = noon;
      const { code, launched, text } = await command(config, path, {
        version: "0.2.0",
        now: true,
        foreground: true,
      });
      expect([code, launched]).toEqual([0, []]);
      expect(text).toContain(
        "Operator update of Stargate, outside the window and without the idle gate: completed.",
      );
      expect(text).toContain("stargate: updated 0.1.0 → 0.2.0");
      expect((await live()).release).toBe("releases/0.2.0");
      // Staged now: the plan knows which services a switch restarts.
      const again = await command(config, path, {
        version: "0.2.0",
        plan: true,
      });
      expect(again.text).toContain("is the current release");
    });

    test("pruning keeps the older updater until its recovery journal is cleared", async () => {
      const { config, path } = await install();
      await runningPlugin();
      fixture.time = noon;
      const root = config.maintenance?.stargate?.root;
      if (!root) throw new Error("no release root");
      const entrypoint = await installed(config, "0.0.1");
      for (const version of ["0.0.1", "0.0.2", "0.0.3", "0.0.4"]) {
        const main = await installed(config, version);
        const metadata = join(dirname(dirname(main)), ".stargate-release.json");
        await writeFile(
          metadata,
          JSON.stringify({
            ...JSON.parse(await readFile(metadata, "utf8")),
            version,
          }),
        );
      }
      let atKill: { releases: string[]; journal: string | null } | undefined;
      const clear = Journal.prototype.clear;
      const stop = spyOn(Journal.prototype, "clear").mockImplementation(
        async function (this: Journal, key) {
          if (key === "gateway") {
            atKill = {
              releases: await readdir(join(root, "releases")),
              journal: await readJournalFile(config.dataDirectory),
            };
            throw new Error("simulated kill after pruning");
          }
          return clear.call(this, key);
        },
      );
      try {
        await maintenanceUpdate(
          config,
          { configPath: path, version: "0.2.0", now: true, foreground: true },
          {
            unit: { ...unit, entrypoint },
            launcher: runner,
            run: deps({ undoOnExit: false, env: invocation }),
            print: () => {},
            now: () => noon,
            signal: fixture.controller.signal,
          },
        );
      } finally {
        stop.mockRestore();
      }
      expect(atKill?.releases).toContain("0.0.1");
      expect(atKill?.releases).toContain("old");
      expect(atKill?.releases).toContain("0.2.0");
      expect(atKill?.releases).not.toContain("0.0.2");
      expect(atKill?.releases).not.toContain("0.0.3");
      expect(atKill?.releases).not.toContain("0.0.4");
      expect(JSON.parse(atKill?.journal ?? "{}")).toMatchObject({
        gateway: { restartPending: false },
      });
      // ExecStopPost still has code to run, and can finish this journal.
      expect(await readFile(entrypoint, "utf8")).toBe("");
      const recovered = await recoverInterruptedRun(
        config,
        deps({ env: invocation }),
        { afterRun: true },
      );
      expect(recovered.ok).toBe(true);
      expect(await readJournalFile(config.dataDirectory)).toBeNull();
    });
  });
});

describe("journal recovery", () => {
  test("a journal that names anything outside the configuration is refused", async () => {
    const cutoff = "2026-10-01T00:00:00.000Z";
    const v1 = {
      schema: "stargate.maintenance.journal.v1",
      runID: crypto.randomUUID(),
    };
    for (const journal of [
      v2({ gateway: { restartPending: true }, exec: ["touch", "/x"] }),
      v2({
        clis: { packages: [{ name: "evil", before: "1.0.0", cutoff }] },
      }),
      v2({
        openCode: {
          restarted: true,
          restartPending: true,
          restart: ["touch", "/x"],
        },
      }),
      v2({ release: { previous: "../../etc", version: "0.1.0" } }),
      v2({
        sessions: [
          { id: "ses_x", from: { providerID: "evil-proxy", id: "m" } },
        ],
      }),
      { ...v1, gateway: { unit: "evil.service" } },
      {
        ...v1,
        openCode: { restart: ["touch", "/x"], restarted: true },
      },
      {
        ...v1,
        clis: {
          npm: ["touch"],
          prefix: "/x",
          registry: url,
          allowScripts: [],
          packages: [
            {
              name: "@opencode/cli",
              command: "opencode2",
              before: "2.2.7",
              cutoff,
            },
          ],
        },
      },
    ]) {
      const { config } = await install();
      const path = await writeJournal(config, journal);
      fixture.commands = [];
      const result = await recoverInterruptedRun(config, deps());
      expect(result.ok).toBe(false);
      expect(result.message).toContain("outside the configuration");
      // Only the configured gateway is started; nothing else runs.
      expect(fixture.commands).toEqual([
        ["systemctl", "--user", "start", "stargate.service"],
      ]);
      expect(await readFile(path, "utf8")).toBe(JSON.stringify(journal));
    }
  });

  test("a journal or directory open to others is refused", async () => {
    const valid = v2({ gateway: { restartPending: true } });
    const { config } = await install();
    const path = await writeJournal(config, valid);
    await chmod(path, 0o644);
    expect((await recoverInterruptedRun(config, deps())).ok).toBe(false);
    await chmod(path, 0o600);
    await chmod(join(config.dataDirectory, "maintenance"), 0o755);
    expect((await recoverInterruptedRun(config, deps())).ok).toBe(false);
    await chmod(join(config.dataDirectory, "maintenance"), 0o700);
    fixture.commands = [];
    expect((await recoverInterruptedRun(config, deps())).ok).toBe(true);
    expect(commands("systemctl --user restart stargate.service")).toHaveLength(
      1,
    );
  });

  test("a first-round (v1) journal recovers with the configured commands", async () => {
    const { config } = await install();
    await writeJournal(config, {
      schema: "stargate.maintenance.journal.v1",
      runID: crypto.randomUUID(),
      gateway: { unit: "stargate.service" },
      openCode: {
        restart: ["systemctl", "--user", "restart", "opencode2.service"],
        restarted: true,
      },
    });
    fixture.gateway = "inactive";
    expect((await recoverInterruptedRun(config, deps())).ok).toBe(true);
    expect(fixture.gateway).toBe("active");
    expect(await readJournalFile(config.dataDirectory)).toBeNull();
  });

  test("a file changed after maintenance wrote it is kept and alerts", async () => {
    const { config } = await install();
    const runID = crypto.randomUUID();
    const journal = Journal.create(config.dataDirectory, runID);
    await journal.set("files", {});
    const changes = new FileChanges(
      backupDirectory(config.dataDirectory, runID),
    );
    const before = await readFile(teamPath(), "utf8");
    await changes.write(teamPath(), "maintenance\n");
    // The operator edits the file after maintenance wrote it.
    await writeFile(teamPath(), "operator\n");
    const result = await recoverInterruptedRun(config, deps());
    expect(result.ok).toBe(false);
    expect(result.message).toContain(
      "models → previous failed (external-change)",
    );
    expect(await readFile(teamPath(), "utf8")).toBe("operator\n");
    expect(await readJournalFile(config.dataDirectory)).toContain('"files"');
    // Unchanged since maintenance wrote it: restored.
    await writeFile(teamPath(), "maintenance\n");
    expect((await recoverInterruptedRun(config, deps())).ok).toBe(true);
    expect(await readFile(teamPath(), "utf8")).toBe(before);
  });

  test("a backup entry for an unmanaged path is refused", async () => {
    const { config } = await install();
    const runID = crypto.randomUUID();
    const journal = Journal.create(config.dataDirectory, runID);
    await journal.set("files", {});
    const other = join(fixture.dir, "other.json");
    await writeFile(other, "original\n");
    await new FileChanges(backupDirectory(config.dataDirectory, runID)).write(
      other,
      "maintenance\n",
    );
    expect((await recoverInterruptedRun(config, deps())).ok).toBe(false);
    expect(await readFile(other, "utf8")).toBe("maintenance\n");
  });

  test("an agent link is removed only while it points where maintenance put it", async () => {
    const home = await mkdtemp(join(base, "home-"));
    const profiles = join(home, "agent-profiles");
    await mkdir(join(profiles, "01-blended"), { recursive: true });
    await mkdir(join(home, "agents"));
    const { config } = await install({
      models: { agentProfiles: profiles, teamFiles: [] },
    });
    const runID = crypto.randomUUID();
    const journal = Journal.create(config.dataDirectory, runID);
    await journal.set("files", {});
    const link = join(home, "agents", "sol-6-2-high-subagent.md");
    await new FileChanges(backupDirectory(config.dataDirectory, runID)).link(
      link,
      "../agent-profiles/current/sol-6-2-high-subagent.md",
    );
    // Someone repointed the link: it is theirs now.
    await rm(link);
    await symlink("/tmp/opencode/elsewhere.md", link);
    expect((await recoverInterruptedRun(config, deps())).ok).toBe(false);
    expect(await readlink(link)).toBe("/tmp/opencode/elsewhere.md");
    await rm(link);
    await symlink("../agent-profiles/current/sol-6-2-high-subagent.md", link);
    expect((await recoverInterruptedRun(config, deps())).ok).toBe(true);
    expect(await lstat(link).catch(() => null)).toBeNull();
  });

  test("a restart owed by an interrupted recovery pass is still made", async () => {
    const { config } = await install();
    const runID = crypto.randomUUID();
    const journal = Journal.create(config.dataDirectory, runID);
    await journal.set("files", {});
    await new FileChanges(backupDirectory(config.dataDirectory, runID)).write(
      teamPath(),
      "maintenance\n",
    );
    await journal.set("openCode", { restarted: true, restartPending: false });
    // The first pass restores the file, then dies in the OpenCode restart.
    const dying: CommandRunner = {
      async run(command, options) {
        if (command.join(" ").includes("opencode2.service"))
          throw new Error("killed");
        return runner.run(command, options);
      },
    };
    await expect(
      recoverInterruptedRun(config, deps({ runner: dying })),
    ).rejects.toThrow("killed");
    const left = JSON.parse(
      (await readJournalFile(config.dataDirectory)) ?? "{}",
    );
    expect(left.files).toBeUndefined();
    expect(left.openCode).toEqual({ restarted: true, restartPending: true });
    fixture.openCodeRestarts = 0;
    expect((await recoverInterruptedRun(config, deps())).ok).toBe(true);
    expect(fixture.openCodeRestarts).toBe(1);
    expect(await readJournalFile(config.dataDirectory)).toBeNull();
  });

  test("a gateway serving another release than current is restarted", async () => {
    const { config } = await install();
    const ready = (version: string) =>
      writeFile(
        join(config.dataDirectory, "ready.json"),
        JSON.stringify({
          schema: "stargate.ready.v1",
          pid: process.pid,
          readyAt: now,
          version,
        }),
      );
    // Active and alive, but still the release that was undone.
    await ready("0.2.0");
    await writeJournal(config, v2({ gateway: { restartPending: false } }));
    expect((await recoverInterruptedRun(config, deps())).ok).toBe(true);
    expect(commands("systemctl --user restart stargate.service")).toHaveLength(
      1,
    );
    // The current release answering: no restart needed.
    await ready("0.1.0");
    await writeJournal(config, v2({ gateway: { restartPending: false } }));
    fixture.commands = [];
    expect((await recoverInterruptedRun(config, deps())).ok).toBe(true);
    expect(commands("systemctl --user restart")).toEqual([]);
  });

  test("a proxy already back on its previous binary is not restarted", async () => {
    const { config } = await install();
    await writeJournal(
      config,
      v2({ cliproxyapi: { previousVersion: "8.0.54" } }),
    );
    expect((await recoverInterruptedRun(config, deps())).ok).toBe(true);
    expect(commands("systemctl --user restart cpa.service")).toEqual([]);
    expect(await readJournalFile(config.dataDirectory)).toBeNull();
  });

  test("a leftover journal waits for idle; after-run only finishes its own run", async () => {
    const { config, path } = await install();
    const journalPath = await writeJournal(
      config,
      v2({
        gateway: { restartPending: true },
        openCode: { restarted: true, restartPending: true },
      }),
    );
    const before = await readFile(journalPath, "utf8");
    fixture.active = ["ses_captain"];
    const { report, attention } = await run(config, path, "run", {
      env: invocation,
    });
    expect(report).toMatchObject({
      outcome: "deferred",
      reason: "busy-opencode",
    });
    expect(report.steps[0]).toMatchObject({
      name: "recover-previous-run",
      status: "skipped",
    });
    expect(attention).toBe(true);
    expect(await readFile(journalPath, "utf8")).toBe(before);
    expect(commands("systemctl --user restart")).toEqual([]);
    // ExecStopPost of the deferred run leaves the older journal alone.
    const after = await recoverInterruptedRun(
      config,
      deps({ env: invocation }),
      { afterRun: true },
    );
    expect(after.ok).toBe(true);
    expect(await readFile(journalPath, "utf8")).toBe(before);
    expect(commands("systemctl --user restart")).toEqual([]);
  });

  test("a leftover journal's undo stops when work arrives before a restart", async () => {
    const { config, path } = await install();
    await writeJournal(
      config,
      v2({
        gateway: { restartPending: true },
        openCode: { restarted: true, restartPending: true },
      }),
    );
    const original = opencode.active;
    let calls = 0;
    // Idle at the run's first gate; a session starts during the undo.
    opencode.active = async () => (++calls >= 2 ? ["ses_captain"] : []);
    try {
      const { report, attention } = await run(config, path);
      expect(report).toMatchObject({
        outcome: "deferred",
        reason: "busy-opencode",
      });
      expect(attention).toBe(true);
    } finally {
      opencode.active = original;
    }
    expect(fixture.openCodeRestarts).toBe(0);
    expect(commands("systemctl --user restart stargate.service")).toEqual([]);
    const left = JSON.parse(
      (await readJournalFile(config.dataDirectory)) ?? "{}",
    );
    expect(left.openCode).toEqual({ restarted: true, restartPending: true });
    expect(left.gateway).toEqual({ restartPending: true });
  });

  test("recover refuses while a run holds the lock", async () => {
    const { config } = await install();
    await writeJournal(config, v2({ gateway: { restartPending: true } }));
    const held = new Database(
      join(config.dataDirectory, "maintenance", "run.sqlite"),
      { create: true },
    );
    held.exec("BEGIN EXCLUSIVE;");
    try {
      const result = await recoverInterruptedRun(config, deps());
      expect(result).toMatchObject({ ok: false });
      expect(result.message).toContain("lock");
      expect(fixture.commands).toEqual([]);
    } finally {
      held.close();
    }
  });

  test("a stopped gateway is started before a leftover journal waits for idle", async () => {
    const { config, path } = await install();
    const journalPath = await writeJournal(
      config,
      v2({
        gateway: { restartPending: false },
        openCode: { restarted: true, restartPending: true },
      }),
    );
    fixture.gateway = "inactive";
    fixture.active = ["ses_captain"];
    const { report } = await run(config, path);
    expect(report.outcome).toBe("deferred");
    // Starting a stopped gateway interrupts nothing; Slack works again
    // while the undo waits for the next idle boundary.
    expect(fixture.gateway).toBe("active");
    expect(commands("systemctl --user start stargate.service")).toHaveLength(1);
    expect(await readFile(journalPath, "utf8")).toContain('"gateway"');
  });

  test("overdue schedules of a stopped gateway do not block its recovery", async () => {
    const { config, path } = await install();
    await writeJournal(config, v2({ gateway: { restartPending: false } }));
    const cron = join(config.dataDirectory, "cron.sqlite");
    new CronStore(cron).close();
    const sql = (text: string) => {
      const db = new Database(cron);
      db.exec(text);
      db.close();
    };
    // Due before the gateway stopped; only a running gateway advances it.
    sql(
      `INSERT INTO cron_schedules (id,botKey,channel,user,name,expression,timezone,prompt,nextAt,createdAt)
       VALUES ('s1','k','C1','U1','n','0 2 * * *','UTC','p',${now - 3_600_000},0)`,
    );
    fixture.gateway = "inactive";
    fixture.onCommand = async (command) => {
      if (command === "systemctl --user start stargate.service")
        sql(`UPDATE cron_schedules SET nextAt=${now + 86_400_000}`);
    };
    const { report } = await run(config, path);
    expect(report.steps).toContainEqual(
      expect.objectContaining({ name: "recover-previous-run", status: "ok" }),
    );
    expect(report.outcome).toBe("completed");
    expect(fixture.gateway).toBe("active");
  });

  test("after-run outside its own systemd invocation only starts the gateway", async () => {
    const { config } = await install();
    const runID = crypto.randomUUID();
    const journal = Journal.create(config.dataDirectory, runID);
    await journal.set("gateway", { restartPending: false });
    await journal.set("files", {});
    await new FileChanges(backupDirectory(config.dataDirectory, runID)).write(
      teamPath(),
      "maintenance\n",
    );
    // last-run.json names this journal's run, but a later invocation exited
    // before writing its own (disabled, outside the window, lock busy).
    await writeFile(
      join(config.dataDirectory, "maintenance", "last-run.json"),
      JSON.stringify({
        runID,
        invocationID: "ffffffffffffffffffffffffffffffff",
      }),
      { mode: 0o600 },
    );
    fixture.gateway = "inactive";
    for (const env of [invocation, { STARGATE_RELEASE_TOKEN: "x" }]) {
      fixture.commands = [];
      const result = await recoverInterruptedRun(config, deps({ env }), {
        afterRun: true,
      });
      expect(result.ok).toBe(true);
      expect(await readFile(teamPath(), "utf8")).toBe("maintenance\n");
      expect(await readJournalFile(config.dataDirectory)).toContain('"files"');
      expect(commands("systemctl --user restart")).toEqual([]);
    }
    expect(fixture.gateway).toBe("active");
  });

  test("a kill after the gateway is ready never leaves the release undone", async () => {
    const { config, path } = await install();
    const original = Journal.prototype.clear;
    let first: string | undefined;
    // Die on the second of the two final commits, whichever comes first.
    Journal.prototype.clear = async function (this: Journal, key) {
      if (
        (key === "gateway" || key === "release") &&
        this.get(key) !== undefined
      ) {
        if (first) throw new Error("killed");
        first = key;
      }
      return original.call(this, key);
    };
    try {
      await run(config, path, "run", { undoOnExit: false });
    } finally {
      Journal.prototype.clear = original;
    }
    expect(first).toBe("release");
    expect((await recoverInterruptedRun(config, deps())).ok).toBe(true);
    const state = await live();
    expect(state.release).toBe("releases/0.2.0");
    expect(state.journal).toBeNull();
    expect(state.gateway).toBe("active");
  });

  test("accept-current drops one entry the operator has checked", async () => {
    const { config } = await install();
    const runID = crypto.randomUUID();
    const journal = Journal.create(config.dataDirectory, runID);
    await journal.set("files", {});
    await new FileChanges(backupDirectory(config.dataDirectory, runID)).write(
      teamPath(),
      "maintenance\n",
    );
    await journal.set("openCode", { restarted: true, restartPending: false });
    await writeFile(teamPath(), "operator\n");
    // Without --yes: lists what would be accepted, changes nothing.
    const preview = await acceptCurrent(config, "files", false);
    expect(preview.ok).toBe(true);
    expect(preview.message).toContain(teamPath());
    expect(preview.message).toContain("changed by someone else");
    expect(await readJournalFile(config.dataDirectory)).toContain('"files"');
    const accepted = await acceptCurrent(config, "files", true);
    expect(accepted.ok).toBe(true);
    const left = JSON.parse(
      (await readJournalFile(config.dataDirectory)) ?? "{}",
    );
    expect(left.files).toBeUndefined();
    expect(left.openCode).toBeDefined();
    expect(await readFile(teamPath(), "utf8")).toBe("operator\n");
    expect((await recoverInterruptedRun(config, deps())).ok).toBe(true);
    expect(await readFile(teamPath(), "utf8")).toBe("operator\n");
    expect((await acceptCurrent(config, "evil", true)).ok).toBe(false);
  });

  test("accept-current moves a corrupt journal aside, never deletes it", async () => {
    const { config } = await install();
    const path = await writeJournal(config, { schema: "unknown" });
    expect((await acceptCurrent(config, "files", true)).ok).toBe(false);
    const preview = await acceptCurrent(config, "journal", false);
    expect(preview.message).toContain(path);
    expect(await readFile(path, "utf8")).toBe('{"schema":"unknown"}');
    expect((await acceptCurrent(config, "journal", true)).ok).toBe(true);
    expect(await readJournalFile(config.dataDirectory)).toBeNull();
    const kept = (
      await readdir(join(config.dataDirectory, "maintenance"))
    ).filter((name) => name.startsWith("journal.accepted-"));
    expect(kept).toHaveLength(1);
    expect(
      await readFile(
        join(config.dataDirectory, "maintenance", kept[0] ?? ""),
        "utf8",
      ),
    ).toBe('{"schema":"unknown"}');
    expect((await recoverInterruptedRun(config, deps())).message).toBe(
      "Nothing to recover.",
    );
  });

  const overdueSchedule = (config: Config) => {
    const cron = join(config.dataDirectory, "cron.sqlite");
    new CronStore(cron).close();
    const db = new Database(cron);
    db.exec(
      `INSERT INTO cron_schedules (id,botKey,channel,user,name,expression,timezone,prompt,nextAt,createdAt)
       VALUES ('s1','k','C1','U1','n','0 2 * * *','UTC','p',${now - 3_600_000},0)`,
    );
    db.close();
  };

  test("a crash-looping gateway does not keep its recovery waiting", async () => {
    const { config, path } = await install();
    await writeJournal(config, v2({ gateway: { restartPending: false } }));
    overdueSchedule(config);
    // Between restarts (RestartSec) the unit is `activating`; it never
    // wrote a ready record, so nothing advances the overdue schedule.
    fixture.gateway = "activating";
    // Once recovery restarts it and it is ready, it runs the schedule.
    fixture.onCommand = async (command) => {
      if (command === "systemctl --user restart stargate.service") {
        const db = new Database(join(config.dataDirectory, "cron.sqlite"));
        db.exec(`UPDATE cron_schedules SET nextAt=${now + 86_400_000}`);
        db.close();
      }
    };
    const { report } = await run(config, path);
    expect(report.steps).toContainEqual(
      expect.objectContaining({ name: "recover-previous-run", status: "ok" }),
    );
    expect(report.outcome).toBe("completed");
  });

  test("an unknown gateway unit state keeps overdue schedules busy", async () => {
    const { config, path } = await install();
    overdueSchedule(config);
    // A live ready gateway, but systemctl cannot answer.
    await writeFile(
      join(config.dataDirectory, "ready.json"),
      JSON.stringify({
        schema: "stargate.ready.v1",
        pid: process.pid,
        readyAt: now,
        version: "0.1.0",
      }),
    );
    const silent: CommandRunner = {
      async run(command, options) {
        if (command.join(" ") === "systemctl --user is-active stargate.service")
          return { code: 1, stdout: "", stderr: "" };
        return runner.run(command, options);
      },
    };
    const { report } = await run(config, path, "run", { runner: silent });
    expect(report).toMatchObject({ outcome: "deferred", reason: "busy-cron" });
  });

  test("a changed file stops the restore before anything is restored", async () => {
    const { config } = await install();
    const runID = crypto.randomUUID();
    const journal = Journal.create(config.dataDirectory, runID);
    await journal.set("files", {});
    const changes = new FileChanges(
      backupDirectory(config.dataDirectory, runID),
    );
    const captain = join(fixture.dir, "captain", ".opencode", "opencode.json");
    // Still a valid profile: crew discovery must keep finding it.
    const upgraded = (await readFile(captain, "utf8")).replaceAll(
      "gpt-6.1-sol",
      "gpt-6.2-sol",
    );
    await changes.write(teamPath(), "maintenance team\n");
    await changes.write(captain, upgraded);
    // The older write was changed by someone else; the newer one was not.
    await writeFile(teamPath(), "operator\n");
    const result = await recoverInterruptedRun(config, deps());
    expect(result.message).toContain("external-change");
    expect(await readFile(captain, "utf8")).toBe(upgraded);
    expect(await readFile(teamPath(), "utf8")).toBe("operator\n");
  });
});
