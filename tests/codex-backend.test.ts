import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Codex } from "@openai/codex-sdk";
import { z } from "zod";
import { createBackend } from "../src/backend";
import { inheritedEnvironment } from "../src/backends/cli-agent";
import {
  CodexBackend,
  CodexTurn,
  codexConfig,
  codexEnvironment,
  codexInput,
  codexLauncher,
  nativeCodex,
  verifyLauncher,
  writeLauncher,
} from "../src/backends/codex";
import {
  checkCodexPaths,
  codexSearchPath,
  systemDirectories,
  trustedPath,
  trustedUtilities,
} from "../src/backends/codex-paths";
import { runCli } from "../src/cli";
import { backendSchema, codexBackendSchema, ircSchema } from "../src/config";
import {
  AttachmentInputUnavailable,
  BackendFailure,
} from "../src/request-failure";
import { backendFingerprint } from "../src/routing";
import { toolchain } from "./codex-toolchain";

const apiKeyEnv = "STARGATE_CODEX_TEST_PROXY_KEY";
const key = "local-proxy-test-only";
const fixture = join(import.meta.dir, "codex-fixture.ts");
// Host secrets that must never reach the Codex child.
const hostSecrets = {
  OPENAI_API_KEY: "native-key-must-not-be-sent",
  CODEX_API_KEY: "codex-key-must-not-be-sent",
  OPENAI_BASE_URL: "http://127.0.0.1:1/native",
  CODEX_HOME: "/host/.codex",
  ANTHROPIC_API_KEY: "anthropic-must-not-be-sent",
  CLIPROXYAPI_API_KEY: "proxy-key-only-by-reference",
  STARGATE_TEST_BOT_TOKEN: "xoxb-must-not-be-sent",
  HTTPS_PROXY: "http://127.0.0.1:2",
  NODE_OPTIONS: "--require /host/hook.js",
};
const saved = new Map<string, string | undefined>();
const cleanup: (() => Promise<unknown>)[] = [];

beforeEach(() => {
  for (const name of [apiKeyEnv, ...Object.keys(hostSecrets)])
    saved.set(name, process.env[name]);
  Object.assign(process.env, hostSecrets, { [apiKeyEnv]: key });
});

afterEach(async () => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const step of cleanup.splice(0).reverse()) await step();
});

// The tests' own programs; see `codex-toolchain.ts`.
const tools = await toolchain();
afterAll(() => tools.remove());

function config(extra: Record<string, unknown> = {}, directory = "/workspace") {
  return codexBackendSchema.parse({
    type: "codex",
    directory,
    model: "gpt-6.1-sol",
    provider: { baseURL: "http://127.0.0.1:8317/v1", apiKeyEnv },
    extraPath: [tools.directory],
    ...extra,
  });
}

const logEntry = z.union([
  z.object({
    pid: z.number(),
    argv: z.array(z.string()),
    env: z.record(z.string(), z.string()),
    cwd: z.string(),
  }),
  z.object({ prompt: z.string(), images: z.array(z.boolean()) }),
  z.object({ grandchild: z.number() }),
]);

async function open(extra: Record<string, unknown> = {}, root?: string) {
  root ??= await mkdtemp(join(tmpdir(), "stargate-codex-"));
  const base = root;
  cleanup.push(() => rm(base, { recursive: true, force: true }));
  const executable = join(root, "fake-codex");
  await writeFile(
    executable,
    `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`,
    { mode: 0o755 },
  );
  const dataDirectory = join(root, "data");
  await mkdir(dataDirectory, { recursive: true });
  // The working directory never contains Stargate's data directory.
  await mkdir(join(root, "workspace"), { recursive: true });
  const backend = await CodexBackend.open(
    config(extra, join(root, "workspace")),
    { dataDirectory },
    { executable, graceMs: 200 },
  );
  cleanup.push(() => backend.close());
  const log = async () =>
    (await readFile(join(dataDirectory, "codex", "fixture.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => logEntry.parse(JSON.parse(line)));
  const runs = async () =>
    (await log()).flatMap((entry) => ("argv" in entry ? [entry] : []));
  const prompts = async () =>
    (await log()).flatMap((entry) => ("prompt" in entry ? [entry] : []));
  const grandchildren = async () =>
    (await log().catch(() => [])).flatMap((entry) =>
      "grandchild" in entry ? [entry.grandchild] : [],
    );
  return {
    root,
    dataDirectory,
    backend,
    log,
    runs,
    prompts,
    grandchildren,
  };
}

const signal = () => AbortSignal.timeout(20_000);
const session = (backend: CodexBackend) =>
  backend.createSession({ key: "k", title: "Stargate test", signal: signal() });

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => Promise<boolean> | boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Condition not reached");
    await delay(25);
  }
}

/** `--config key=value` arguments as a map. */
function overrides(argv: readonly string[]) {
  const map = new Map<string, string>();
  argv.forEach((argument, index) => {
    if (argument !== "--config") return;
    const value = argv[index + 1] ?? "";
    const at = value.indexOf("=");
    map.set(value.slice(0, at), value.slice(at + 1));
  });
  return map;
}

test("Codex turn streams agent messages only and returns this turn's answer", async () => {
  const { backend, prompts } = await open();
  const id = await session(backend);
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  const previews: string[] = [];
  const answer = await backend.prompt(id, "Say hello", signal(), (text) =>
    previews.push(text),
  );
  expect(answer).toBe("Hello world\n\nDone.");
  expect(previews).toEqual(["Hello world", "Hello world\n\nDone."]);
  for (const text of previews)
    expect(text).not.toMatch(/private|SECRETOUTPUT|cat \/secret|raw/);
  const [first] = await prompts();
  expect(first?.prompt).toBe("Say hello");
});

test("Codex runs with a read-only sandbox, no approvals and no network", async () => {
  const { backend, runs, root } = await open();
  await backend.prompt(await session(backend), "hi", signal());
  const [run] = await runs();
  const argv = run?.argv ?? [];
  expect(argv.slice(0, 2)).toEqual(["exec", "--experimental-json"]);
  expect(argv).toContain("--sandbox");
  expect(argv[argv.indexOf("--sandbox") + 1]).toBe("read-only");
  expect(argv[argv.indexOf("--model") + 1]).toBe("gpt-6.1-sol");
  expect(argv[argv.indexOf("--cd") + 1]).toBe(join(root, "workspace"));
  expect(argv).toContain("--skip-git-repo-check");
  for (const flag of argv)
    expect(flag).not.toMatch(/dangerously|--trust|--profile|^-p$|bypass/);
  const map = overrides(argv);
  expect(map.get("approval_policy")).toBe('"never"');
  expect(map.get("sandbox_workspace_write.network_access")).toBe("false");
  expect(map.get("web_search")).toBe('"disabled"');
  expect(map.get("model_provider")).toBe('"stargate"');
  expect(map.get("model_providers.stargate.base_url")).toBe(
    '"http://127.0.0.1:8317/v1"',
  );
  expect(map.get("model_providers.stargate.env_key")).toBe(
    '"STARGATE_CODEX_PROVIDER_KEY"',
  );
  expect(map.get("model_providers.stargate.wire_api")).toBe('"responses"');
  expect(map.get("project_doc_max_bytes")).toBe("0");
  expect(map.get("skills.include_instructions")).toBe("false");
  expect(map.get("agents.enabled")).toBe("false");
  expect(map.get("features.plugins")).toBe("false");
  expect(map.get("features.shell_snapshot")).toBe("false");
  expect(map.get("analytics.enabled")).toBe("false");
  expect(map.get("shell_environment_policy.exclude")).toBe(
    '["STARGATE_CODEX_PROVIDER_KEY"]',
  );
  expect(map.get("shell_environment_policy.set.SHLVL")).toBe('"1"');
  // The key travels only in the environment, never in arguments.
  for (const flag of argv) expect(flag).not.toContain(key);
  // Explicit widening maps to the CLI's own enforcement.
  const widened = await open({
    sandbox: "workspace-write",
    network: true,
    projectDocs: true,
    systemPrompt: "Be brief.",
    reasoningEffort: "high",
  });
  await widened.backend.prompt(await session(widened.backend), "hi", signal());
  const [wide] = await widened.runs();
  const wideMap = overrides(wide?.argv ?? []);
  expect(wide?.argv[(wide?.argv.indexOf("--sandbox") ?? 0) + 1]).toBe(
    "workspace-write",
  );
  expect(wideMap.get("sandbox_workspace_write.network_access")).toBe("true");
  expect(wideMap.has("project_doc_max_bytes")).toBe(false);
  expect(wideMap.get("developer_instructions")).toBe('"Be brief."');
  expect(wideMap.get("model_reasoning_effort")).toBe('"high"');
  expect(wideMap.get("approval_policy")).toBe('"never"');
});

test("Codex child receives only a minimal, explicit environment", async () => {
  const { backend, runs, dataDirectory } = await open();
  await backend.prompt(await session(backend), "hi", signal());
  const [run] = await runs();
  const env = run?.env ?? {};
  for (const name of Object.keys(hostSecrets))
    if (name !== "CODEX_HOME") expect(env[name]).toBeUndefined();
  expect(env["STARGATE_CODEX_PROVIDER_KEY"]).toBe(key);
  expect(env["CODEX_HOME"]).toBe(join(dataDirectory, "codex"));
  expect(env["ZDOTDIR"]).toBe(join(dataDirectory, "codex-shell"));
  expect(await readdir(env["ZDOTDIR"] ?? "")).toEqual([]);
  expect(env[apiKeyEnv]).toBeUndefined();
  expect(env["STARGATE_CODEX_TURN"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(env["NO_PROXY"]).toBe("*");
  // Each turn gets a private temporary directory, removed after the turn.
  expect(env["TMPDIR"]).toStartWith(join(tmpdir(), "stargate-codex-"));
  await expect(readdir(env["TMPDIR"] ?? "")).rejects.toThrow();
  const allowed = new Set([
    ...inheritedEnvironment,
    "CODEX_HOME",
    "ZDOTDIR",
    "NO_PROXY",
    "STARGATE_CODEX_PROVIDER_KEY",
    "STARGATE_CODEX_TURN",
    // Added by the SDK itself; it carries no credential.
    "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    // Set by the fixture's wrapper shell, not by Stargate.
    "PWD",
  ]);
  expect(Object.keys(env).filter((name) => !allowed.has(name))).toEqual([]);
  expect(
    Object.keys(
      codexEnvironment(config(), "/private", {
        ...hostSecrets,
        PATH: "/bin",
        HOME: "/home/stargate",
        [apiKeyEnv]: key,
      }),
    ).sort(),
  ).toEqual(
    [
      "PATH",
      "HOME",
      "CODEX_HOME",
      "ZDOTDIR",
      "NO_PROXY",
      "STARGATE_CODEX_PROVIDER_KEY",
    ].sort(),
  );
  delete process.env[apiKeyEnv];
  await expect(CodexBackend.open(config(), { dataDirectory })).rejects.toThrow(
    `Missing environment variable: ${apiKeyEnv}`,
  );
});

test("Codex resumes its own thread, also after restart, and never another namespace's", async () => {
  const first = await open();
  const id = await session(first.backend);
  await first.backend.prompt(id, "one", signal());
  await first.backend.prompt(id, "two", signal());
  await first.backend.close();
  const reopened = await CodexBackend.open(
    config({}, join(first.root, "workspace")),
    { dataDirectory: first.dataDirectory },
    { executable: join(first.root, "fake-codex"), graceMs: 200 },
  );
  cleanup.push(() => reopened.close());
  expect(await reopened.prompt(id, "three", signal())).toBe(
    "Hello world\n\nDone.",
  );
  const [created, resumed, restarted] = await first.runs();
  expect(created?.argv).not.toContain("resume");
  const thread = resumed?.argv[resumed.argv.indexOf("resume") + 1];
  expect(thread).toMatch(/^[0-9a-f-]{36}$/);
  expect(thread).not.toBe(id);
  expect(restarted?.argv[restarted.argv.indexOf("resume") + 1]).toBe(thread);
  // Another namespace has its own CODEX_HOME and mapping: a new thread.
  const second = await open();
  await second.backend.prompt(id, "four", signal());
  const [other] = await second.runs();
  expect(other?.argv).not.toContain("resume");
  expect(other?.env["CODEX_HOME"]).not.toBe(created?.env["CODEX_HOME"]);
  // A thread that changes identity fails without remapping.
  await expect(reopened.prompt(id, "rethread", signal())).rejects.toThrow(
    "Codex thread identity changed",
  );
  await reopened.prompt(id, "five", signal());
  const all = await first.runs();
  expect(all.at(-1)?.argv[(all.at(-1)?.argv.indexOf("resume") ?? 0) + 1]).toBe(
    thread,
  );
  // Backend settings select the namespace, as for other backends.
  const fingerprint = (backend: unknown) =>
    backendFingerprint({ backend: backendSchema.parse(backend) });
  expect(fingerprint(config())).not.toBe(
    fingerprint(config({ sandbox: "workspace-write" })),
  );
  expect(fingerprint(config())).not.toBe(
    fingerprint(config({ model: "gpt-6.1-terra" })),
  );
  await expect(
    reopened.prompt("../not-a-conversation", "x", signal()),
  ).rejects.toThrow("Codex conversation ID is not valid");
});

test("one Codex turn runs per thread at a time", async () => {
  const { backend } = await open();
  const id = await session(backend);
  const controller = new AbortController();
  const busy = backend.prompt(id, "hang", controller.signal);
  await expect(backend.prompt(id, "again", signal())).rejects.toThrow(
    "Codex thread is busy",
  );
  controller.abort();
  await expect(busy).rejects.toThrow();
});

test("no tool process outlives its Codex turn, even one ignoring SIGTERM", async () => {
  const { backend, grandchildren } = await open();
  cleanup.push(async () => {
    for (const pid of await grandchildren())
      if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  const id = await session(backend);
  // In the CLI's process group or in its own session, after a normal exit,
  // an early exit, a CLI that lingers, or cancellation.
  for (const placement of ["", "detached "]) {
    expect(await backend.prompt(id, `${placement}stubborn`, signal())).toBe(
      "Hello world\n\nDone.",
    );
    await expect(
      backend.prompt(id, `${placement}stubborn crash`, signal()),
    ).rejects.toThrow("Backend failure: crash");
    expect(
      await backend.prompt(id, `${placement}stubborn linger`, signal()),
    ).toBe("Hello world\n\nDone.");
    const before = (await grandchildren()).length;
    const controller = new AbortController();
    const turn = backend.prompt(
      id,
      `${placement}stubborn hang`,
      controller.signal,
    );
    await until(async () => (await grandchildren()).length === before + 2);
    controller.abort();
    await expect(turn).rejects.toThrow();
  }
  const pids = await grandchildren();
  expect(pids.length).toBe(10);
  await until(() => pids.every((pid) => !alive(pid)), 3000);
});

test("a Codex CLI that ignores SIGTERM cannot keep a turn pending", async () => {
  const { backend, runs, grandchildren } = await open();
  const grace = 200;
  const bound = grace * 2 + 1500;
  cleanup.push(async () => {
    for (const pid of [
      ...(await runs().catch(() => [])).map((run) => run.pid),
      ...(await grandchildren()),
    ])
      if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  const started = async (count: number) =>
    until(async () => (await runs().catch(() => [])).length >= count);
  const settles = async (turn: Promise<unknown>, action: () => unknown) => {
    const begin = Date.now();
    await action();
    await turn.then(
      () => {},
      () => {},
    );
    return Date.now() - begin;
  };
  // Cancellation by the request's signal, by interrupt and by close.
  const controller = new AbortController();
  const id = await session(backend);
  let turn = backend.prompt(id, "deaf hang", controller.signal);
  await started(1);
  expect(await settles(turn, () => controller.abort())).toBeLessThan(bound);
  await expect(turn).rejects.toThrow();
  turn = backend.prompt(id, "deaf hang", signal());
  await started(2);
  expect(
    await settles(turn, () => backend.interrupt(id, signal())),
  ).toBeLessThan(bound);
  await expect(turn).rejects.toThrow();
  // Its output can stay open in a process without the marker, which the
  // clean-up does not find: the turn stops waiting for the stream.
  turn = backend.prompt(id, "deaf hold hang", signal());
  await started(3);
  expect(
    await settles(turn, () => backend.interrupt(id, signal())),
  ).toBeLessThan(bound);
  await expect(turn).rejects.toThrow();
  // A deaf CLI that lingers after its result keeps the result.
  expect(await backend.prompt(id, "deaf linger", signal())).toBe(
    "Hello world\n\nDone.",
  );
  turn = backend.prompt(id, "deaf hang", signal());
  await started(5);
  expect(await settles(turn, () => backend.close())).toBeLessThan(bound);
  await expect(turn).rejects.toThrow();
  // The CLI and its marked tool processes are gone.
  const pids = (await runs()).map((run) => run.pid);
  expect(pids.length).toBe(5);
  await until(() => pids.every((pid) => !alive(pid)), 3000);
});

test.skipIf(process.platform !== "linux")(
  "an abandoned Codex turn closes Stargate's pipes while its output is held",
  async () => {
    const { backend, runs, grandchildren } = await open();
    cleanup.push(async () => {
      for (const pid of [
        ...(await runs().catch(() => [])).map((run) => run.pid),
        ...(await grandchildren()),
      ])
        if (alive(pid)) process.kill(pid, "SIGKILL");
    });
    /** Pipes and socket pairs open here: Bun gives children socket pairs. */
    const pipes = async () => {
      let count = 0;
      for (const fd of await readdir("/proc/self/fd")) {
        const target = await readlink(`/proc/self/fd/${fd}`).catch(() => "");
        if (/^(pipe|socket):/.test(target)) count++;
      }
      return count;
    };
    const id = await session(backend);
    await backend.prompt(id, "warm up", signal());
    const baseline = await pipes();
    for (let turn = 1; turn <= 3; turn++) {
      // The holder has no turn marker, so the clean-up leaves it running.
      const running = backend.prompt(id, "deaf hold hang", signal());
      await until(
        async () =>
          (await runs().catch(() => [])).length > turn &&
          (await grandchildren()).length >= turn * 2,
      );
      await backend.interrupt(id, signal());
      await expect(running).rejects.toThrow();
      await until(async () => (await pipes()) <= baseline, 3000);
    }
    // Every holder still runs: the pipes closed before any holder exited.
    const holders = (await grandchildren()).filter(
      (_, index) => index % 2 === 0,
    );
    expect(holders.length).toBe(3);
    for (const pid of holders) expect(alive(pid)).toBe(true);
    expect(await pipes()).toBeLessThanOrEqual(baseline);
  },
);

test("the launcher starts the CLI that the SDK would start", () => {
  // Read from the SDK's internals in this test only, so that an SDK update
  // that moves its CLI fails here.
  const sdk = z
    .object({
      exec: z.object({
        executablePath: z.string(),
        pathDirs: z.array(z.string()),
      }),
    })
    .parse(new Codex());
  const native = nativeCodex();
  expect(native.executable).toBe(sdk.exec.executablePath);
  expect([native.helpers]).toEqual(sdk.exec.pathDirs);
});

test("the launcher keeps arguments, input and exit status, and only cat holds its output", async () => {
  const root = await mkdtemp(join(tmpdir(), "stargate-codex-launcher-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const odd = join(root, "it's a dir");
  await mkdir(odd);
  const cli = join(odd, "cli");
  await writeFile(
    cli,
    `#!/bin/sh\nprintf '%s|' "$@"\ncat\necho to-stderr >&2\nexit 7\n`,
    { mode: 0o755 },
  );
  const launcher = join(root, "launcher");
  await writeFile(launcher, codexLauncher(cli, await trustedUtilities()), {
    mode: 0o700,
  });
  const temporary = join(root, "tmp");
  await mkdir(temporary);
  const child = Bun.spawn([launcher, "exec", "a b", "it's"], {
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", TMPDIR: temporary },
    stdin: new TextEncoder().encode("prompt"),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await new Response(child.stdout).text()).toBe("exec|a b|it's|prompt");
  expect(await new Response(child.stderr).text()).toBe("");
  expect(await child.exited).toBe(7);
  // The FIFO was unlinked as soon as both ends were open.
  expect(await readdir(temporary)).toEqual([]);
});

test("a writable Codex directory never holds what runs outside the sandbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "stargate-codex-paths-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const write = (directory: string, extra: Record<string, unknown> = {}) =>
    config({ sandbox: "workspace-write", ...extra }, directory);
  const refused = async (
    directory: string,
    data: string,
    reason: RegExp,
    extra: Record<string, unknown> = {},
  ) => {
    await mkdir(data, { recursive: true });
    await expect(
      CodexBackend.open(write(directory, extra), { dataDirectory: data }),
    ).rejects.toThrow(reason);
    // The read-only sandbox writes nothing, so the same layout is accepted.
    const backend = await CodexBackend.open(config({}, directory), {
      dataDirectory: data,
    });
    await backend.close();
  };
  // The data directory below the workspace, through a symbolic link, or
  // the workspace below the data directory.
  await refused(join(root, "a"), join(root, "a", "data"), /Stargate's data/);
  // Through a link that Stargate's user can change, the path is refused before
  // the overlap is even compared.
  await mkdir(join(root, "b", "data"), { recursive: true });
  await symlink(join(root, "b"), join(root, "link"));
  await refused(join(root, "link"), join(root, "b", "data"), /symbolic link/);
  await refused(
    join(root, "c", "data", "codex-bin"),
    join(root, "c", "data"),
    /Stargate's data/,
  );
  // Stargate's installation, and a home directory with start-up files.
  await refused(
    join(import.meta.dir, ".."),
    join(root, "d", "data"),
    /Stargate's installation|Stargate's data/,
  );
  saved.set("HOME", process.env["HOME"]);
  process.env["HOME"] = join(root, "e", "home");
  await refused(join(root, "e"), join(root, "data-e"), /home directory/);
  // A workspace inside the home directory is fine.
  await mkdir(join(root, "e", "home", "project"), { recursive: true });
  const inside = await CodexBackend.open(
    write(join(root, "e", "home", "project")),
    { dataDirectory: join(root, "data-e") },
  );
  await inside.close();
  // `stargate config check` applies the same rule to the configured data root.
  const path = join(root, "f", "stargate.json");
  await mkdir(join(root, "f"));
  const bot = (directory: string) => ({
    id: "codex-helper",
    slack: {
      appId: "A123",
      appTokenEnv: "STARGATE_CODEX_TEST_APP",
      botTokenEnv: "STARGATE_CODEX_TEST_BOT",
    },
    access: { users: ["U123"], channels: ["C123"] },
    backend: {
      type: "codex",
      directory,
      model: "gpt-6.1-sol",
      provider: { baseURL: "http://127.0.0.1:8317/v1", apiKeyEnv },
      sandbox: "workspace-write",
      extraPath: [tools.directory],
    },
  });
  for (const name of ["STARGATE_CODEX_TEST_APP", "STARGATE_CODEX_TEST_BOT"])
    saved.set(name, process.env[name]);
  process.env["STARGATE_CODEX_TEST_APP"] = "xapp-test";
  process.env["STARGATE_CODEX_TEST_BOT"] = "xoxb-test";
  // The default data directory `.stargate` is next to the configuration file.
  await writeFile(path, JSON.stringify({ bots: [bot(join(root, "f"))] }));
  await expect(runCli(["config", "check", "--config", path])).rejects.toThrow(
    /Stargate's data directory/,
  );
  await mkdir(join(root, "g"));
  await writeFile(path, JSON.stringify({ bots: [bot(join(root, "g"))] }));
  expect(await runCli(["config", "check", "--config", path])).toEqual({
    command: "exit",
  });
  // So is the fixed PATH: an extraPath inside the workspace is refused.
  const withPath = bot(join(root, "g"));
  await writeFile(
    path,
    JSON.stringify({
      bots: [
        {
          ...withPath,
          backend: { ...withPath.backend, extraPath: [join(root, "g")] },
        },
      ],
    }),
  );
  await expect(runCli(["config", "check", "--config", path])).rejects.toThrow(
    /extraPath/,
  );
});

test("Codex uses canonical paths only and refuses links that can change", async () => {
  const root = await mkdtemp(join(tmpdir(), "stargate-codex-links-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const write = (directory: string) =>
    config({ sandbox: "workspace-write" }, directory);
  await mkdir(join(root, "safe"));
  // A workspace, a data directory or a CLI behind a link in a directory
  // that Stargate's user can write: refused, so no later retarget is followed.
  await symlink(join(root, "safe"), join(root, "linked"));
  await expect(
    CodexBackend.open(write(join(root, "linked")), {
      dataDirectory: join(root, "data-a"),
    }),
  ).rejects.toThrow(/symbolic link/);
  await mkdir(join(root, "real-data"));
  await symlink(join(root, "real-data"), join(root, "data-link"));
  await expect(
    CodexBackend.open(write(join(root, "safe")), {
      dataDirectory: join(root, "data-link"),
    }),
  ).rejects.toThrow(/symbolic link/);
  await writeFile(join(root, "cli"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await symlink(join(root, "cli"), join(root, "cli-link"));
  await expect(
    CodexBackend.open(
      write(join(root, "safe")),
      { dataDirectory: join(root, "data-b") },
      { executable: join(root, "cli-link") },
    ),
  ).rejects.toThrow(/symbolic link/);
  // Links that only root controls resolve to their canonical form.
  expect(await trustedPath("/bin/sh")).toBe(await realpath("/bin/sh"));
});

test("a Codex turn writes, verifies and runs only a fresh canonical launcher", async () => {
  const { backend, runs, dataDirectory, root } = await open({
    sandbox: "workspace-write",
  });
  const bin = join(dataDirectory, "codex-bin");
  const id = await session(backend);
  await backend.prompt(id, "hi", signal());
  // Each turn's launcher is removed after it.
  expect(await readdir(bin)).toEqual([]);
  // A file planted where an earlier version kept its launcher is never run.
  await writeFile(join(bin, "codex"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  await backend.prompt(id, "again", signal());
  expect((await runs()).length).toBe(2);
  // The launcher directory swapped for a link: the turn fails before it
  // writes or runs anything there.
  const elsewhere = join(root, "elsewhere");
  await mkdir(elsewhere);
  await rm(bin, { recursive: true });
  await symlink(elsewhere, bin);
  await expect(backend.prompt(id, "third", signal())).rejects.toThrow(
    /symbolic link|verification/,
  );
  expect(await readdir(elsewhere)).toEqual([]);
  expect((await runs()).length).toBe(2);
  await expect(writeLauncher(join(bin, "x.sh"), "#!/bin/sh\n")).rejects.toThrow(
    "verification",
  );
  expect(await readdir(elsewhere)).toEqual([]);
  // The launcher check fails closed on content, mode and symbolic links.
  await rm(bin);
  await mkdir(bin, { mode: 0o700 });
  const launcher = join(bin, "check.sh");
  const script = "#!/bin/sh\nexit 0\n";
  await writeLauncher(launcher, script);
  await expect(writeLauncher(launcher, script)).rejects.toThrow();
  await expect(verifyLauncher(launcher, `${script}x`)).rejects.toThrow(
    "verification",
  );
  await chmod(launcher, 0o755);
  await expect(verifyLauncher(launcher, script)).rejects.toThrow(
    "verification",
  );
  await rm(launcher);
  await writeFile(join(root, "other.sh"), script, { mode: 0o700 });
  await symlink(join(root, "other.sh"), launcher);
  await expect(verifyLauncher(launcher, script)).rejects.toThrow(
    "verification",
  );
});

test("the CLI's PATH holds only the helper and root-owned system directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "stargate-codex-shim-"));
  const workspace = join(root, "workspace");
  const user = join(root, "user-bin");
  // Shims for the launcher's utilities and the CLI's commands, in the
  // workspace and in a user directory before the system directories.
  for (const directory of [join(workspace, "bin"), user]) {
    await mkdir(directory, { recursive: true });
    for (const name of ["sh", "mkfifo", "cat", "rm", "git", "rg"])
      await writeFile(
        join(directory, name),
        `#!/bin/sh\n: > ${join(root, `ran-${name}`)}\nexit 1\n`,
        { mode: 0o755 },
      );
  }
  const path = process.env["PATH"] ?? "/usr/bin:/bin";
  saved.set("PATH", path);
  process.env["PATH"] = [join(workspace, "bin"), ".", "bin", user, path].join(
    ":",
  );
  // Nothing of the operator's PATH: the helper directory, then canonical
  // root-controlled system directories only, whichever this host has. A
  // host without one (hosted CI runners) gets a clear start-up failure.
  const { found } = await systemDirectories();
  for (const entry of found) expect((await lstat(entry)).uid).toBe(0);
  if (found.length === 0) {
    await expect(
      open({ sandbox: "workspace-write", extraPath: [] }, root),
    ).rejects.toThrow(/no root-controlled system directory for PATH/);
  } else {
    const { backend, runs } = await open(
      { sandbox: "workspace-write", extraPath: [] },
      root,
    );
    expect(await backend.prompt(await session(backend), "hi", signal())).toBe(
      "Hello world\n\nDone.",
    );
    expect((await runs())[0]?.env["PATH"]?.split(":")).toEqual([
      nativeCodex().helpers,
      ...found,
    ]);
  }
  // The same with the tests' toolchain, which comes last.
  const { backend, runs } = await open({ sandbox: "workspace-write" }, root);
  expect(await backend.prompt(await session(backend), "hi", signal())).toBe(
    "Hello world\n\nDone.",
  );
  expect((await runs()).at(-1)?.env["PATH"]?.split(":")).toEqual([
    nativeCodex().helpers,
    ...found,
    await realpath(tools.directory),
  ]);
  expect(
    (await readdir(root)).filter((name) => name.startsWith("ran-")),
  ).toEqual([]);
  // Utilities come only from root-controlled system paths.
  await expect(trustedUtilities([user])).rejects.toThrow("root-owned");
  for (const tool of Object.values(await trustedUtilities())) {
    expect(tool.startsWith("/")).toBe(true);
    expect((await lstat(tool)).uid).toBe(0);
  }
  // The workspace check is also a plain function for `config check`.
  await expect(
    checkCodexPaths(
      config({ sandbox: "workspace-write" }, root),
      join(root, "data"),
    ),
  ).rejects.toThrow(/Stargate's data/);
});

test("without a root-controlled system directory, start-up fails clearly", async () => {
  // A system directory that Stargate's user owns, as on hosted CI runners,
  // where some program in /usr/local/bin or /usr/bin is not root's.
  const root = await mkdtemp(join(tmpdir(), "stargate-codex-system-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const system = join(root, "usr-bin");
  await mkdir(system);
  await writeFile(join(system, "ls"), "#!/bin/sh\n", { mode: 0o755 });
  expect(await systemDirectories([system, join(root, "none")])).toEqual({
    found: [],
    reasons: [
      `${system}: not root-controlled`,
      `${join(root, "none")}: missing`,
    ],
  });
  const helpers = nativeCodex().helpers;
  await expect(codexSearchPath([], helpers, [], [system])).rejects.toThrow(
    `Codex found no root-controlled system directory for PATH (${system}: not root-controlled)`,
  );
  // Never accepted, not even next to a qualifying one.
  const usable = await systemDirectories(["/usr/bin", system]);
  expect(usable.found).not.toContain(system);
  // A trusted extraPath gives the CLI its programs instead.
  expect(await codexSearchPath([tools.directory], helpers, [], [system])).toBe(
    `${helpers}:${await realpath(tools.directory)}`,
  );
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const executable = join(root, "fake-codex");
  await writeFile(
    executable,
    `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`,
    { mode: 0o755 },
  );
  const runtime = { executable, graceMs: 200, searchDirectories: [system] };
  await expect(
    CodexBackend.open(
      config({ extraPath: [] }, workspace),
      { dataDirectory: join(root, "data") },
      runtime,
    ),
  ).rejects.toThrow(/no root-controlled system directory/);
  // The fake CLI runs its processes by absolute path, so turns that start
  // and stop them work with only the toolchain on PATH.
  const backend = await CodexBackend.open(
    config({}, workspace),
    { dataDirectory: join(root, "data") },
    runtime,
  );
  cleanup.push(() => backend.close());
  const log = join(root, "data", "codex", "fixture.jsonl");
  const children = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const entry = logEntry.parse(JSON.parse(line));
        return "grandchild" in entry ? [entry.grandchild] : [];
      });
  cleanup.push(async () => {
    for (const pid of await children())
      if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  const controller = new AbortController();
  const turn = backend.prompt(
    await session(backend),
    "stubborn hang",
    controller.signal,
  );
  await until(async () => (await children()).length === 2);
  controller.abort();
  await expect(turn).rejects.toThrow();
  const pids = await children();
  await until(() => pids.every((pid) => !alive(pid)), 3000);
});

test("extraPath adds only directories whose programs stay out of the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "stargate-codex-extra-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "bin"), { recursive: true });
  const program = `#!/bin/sh\n: > ${join(root, "ran")}\n`;
  await writeFile(join(workspace, "real-git"), program, { mode: 0o755 });
  await writeFile(join(root, "outside-git"), program, { mode: 0o755 });
  const bin = async (name: string, entries: Record<string, string>) => {
    const directory = join(root, name);
    await mkdir(directory);
    for (const [entry, target] of Object.entries(entries))
      if (target) await symlink(target, join(directory, entry));
      else await writeFile(join(directory, entry), program, { mode: 0o755 });
    return directory;
  };
  // Accepted: a user directory of plain programs, last on PATH.
  const tools = await bin("tools", { mytool: "" });
  const { backend, runs } = await open(
    { sandbox: "workspace-write", extraPath: [tools] },
    root,
  );
  await backend.prompt(await session(backend), "hi", signal());
  expect((await runs())[0]?.env["PATH"]?.split(":").at(-1)).toBe(tools);
  // Refused: reached through a changeable link, inside the workspace, a
  // program whose link chain passes through the workspace before it
  // leaves it again, and a program that runs from the workspace.
  await symlink(tools, join(root, "tools-link"));
  await symlink(join(root, "outside-git"), join(workspace, "hop"));
  const refused: [string, RegExp][] = [
    [join(root, "tools-link"), /symbolic link/],
    [join(workspace, "bin"), /inside a writable/],
    [await bin("hop-bin", { git: join(workspace, "hop") }), /link through/],
    [
      await bin("into-bin", { git: join(workspace, "real-git") }),
      /run from a writable/,
    ],
  ];
  for (const [directory, reason] of refused)
    await expect(
      CodexBackend.open(
        config(
          { sandbox: "workspace-write", extraPath: [directory] },
          workspace,
        ),
        { dataDirectory: join(root, "data") },
      ),
    ).rejects.toThrow(reason);
  expect(await readdir(root)).not.toContain("ran");
});

test("a program link chain through the workspace is never followed", async () => {
  const root = await mkdtemp(join(tmpdir(), "stargate-codex-chain-"));
  const workspace = join(root, "workspace");
  const shims = join(workspace, "shims");
  await mkdir(shims, { recursive: true });
  await writeFile(
    join(shims, "git"),
    `#!/bin/sh\n: > ${join(root, "ran-git")}\nexit 1\n`,
    { mode: 0o755 },
  );
  // A user PATH directory whose git links through a workspace link to a
  // program outside the workspace: the final target alone looks safe.
  await writeFile(join(root, "real-git"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  const hop = join(workspace, "hop");
  await symlink(join(root, "real-git"), hop);
  const user = join(root, "user-bin");
  await mkdir(user);
  await symlink(hop, join(user, "git"));
  const path = process.env["PATH"] ?? "/usr/bin:/bin";
  saved.set("PATH", path);
  process.env["PATH"] = `${user}:${path}`;
  const executable = join(root, "fake-codex");
  await writeFile(
    executable,
    `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`,
    { mode: 0o755 },
  );
  const backend = await CodexBackend.open(
    config({ sandbox: "workspace-write" }, workspace),
    { dataDirectory: join(root, "data") },
    {
      executable,
      graceMs: 200,
      // The intermediate link, retargeted to the shim during the turn.
      environment: {
        STARGATE_TEST_LINK: hop,
        STARGATE_TEST_TARGET: join(shims, "git"),
      },
    },
  );
  cleanup.push(async () => {
    await backend.close();
    await rm(root, { recursive: true, force: true });
  });
  await backend.prompt(await session(backend), "swap", signal());
  expect(await readdir(root)).not.toContain("ran-git");
});

test("a PATH link retargeted during a turn is never followed", async () => {
  const root = await mkdtemp(join(tmpdir(), "stargate-codex-swap-"));
  const workspace = join(root, "workspace");
  const shims = join(workspace, "shims");
  await mkdir(shims, { recursive: true });
  await writeFile(
    join(shims, "git"),
    `#!/bin/sh\n: > ${join(root, "ran-git")}\nexit 1\n`,
    { mode: 0o755 },
  );
  // A workspace link to a directory outside it, first in PATH.
  const benign = join(root, "benign");
  await mkdir(benign);
  const link = join(workspace, "tools");
  await symlink(benign, link);
  const path = process.env["PATH"] ?? "/usr/bin:/bin";
  saved.set("PATH", path);
  process.env["PATH"] = `${link}:${path}`;
  const executable = join(root, "fake-codex");
  await writeFile(
    executable,
    `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`,
    { mode: 0o755 },
  );
  const dataDirectory = join(root, "data");
  const backend = await CodexBackend.open(
    config({ sandbox: "workspace-write" }, workspace),
    { dataDirectory },
    {
      executable,
      graceMs: 200,
      environment: { STARGATE_TEST_LINK: link, STARGATE_TEST_TARGET: shims },
    },
  );
  cleanup.push(async () => {
    await backend.close();
    await rm(root, { recursive: true, force: true });
  });
  // The retarget happens after Stargate checked PATH, while the CLI runs.
  await backend.prompt(await session(backend), "swap", signal());
  expect(await readdir(root)).not.toContain("ran-git");
});

test("Codex failures carry a fixed cause, never CLI or provider text", async () => {
  const { backend } = await open();
  const id = await session(backend);
  const previews: string[] = [];
  for (const [prompt, message] of [
    ["fail", /^Codex turn failed$/],
    ["crash", /^Backend failure: crash$/],
  ] as const) {
    const failed = backend.prompt(id, prompt, signal(), (text) =>
      previews.push(text),
    );
    await expect(failed).rejects.toThrow(message);
  }
  expect(previews.join("\n")).not.toContain("raw");
  const turn = new CodexTurn();
  turn.add({
    type: "item.completed",
    item: { id: "e", type: "error", message: "raw" },
  });
  turn.add({ type: "turn.failed", error: { message: "raw" } });
  expect(turn.answer()).toBe("");
  expect(turn.result).toEqual({ ok: false });
});

test.skipIf(process.platform !== "linux")(
  "interrupt stops what an earlier process's Codex turn left, and nothing else",
  async () => {
    const { backend, dataDirectory } = await open();
    const id = await session(backend);
    const sleeper = async (argument: string, env: Record<string, string>) => {
      const child = spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 600000)", argument],
        { detached: true, stdio: "ignore", env: { ...process.env, ...env } },
      );
      const pid = child.pid ?? 0;
      cleanup.push(async () => {
        if (alive(pid)) process.kill(pid, "SIGKILL");
      });
      await until(async () =>
        (await readFile(`/proc/${pid}/cmdline`, "utf8")).includes(argument),
      );
      return pid;
    };
    const start = async (pid: number) => {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    };
    const turn = crypto.randomUUID();
    const record = join(dataDirectory, "codex-runs", `${id}.json`);
    // Another turn's marker, or an earlier start than the record: kept.
    const other = await sleeper("other", {
      STARGATE_CODEX_TURN: crypto.randomUUID(),
    });
    const older = await sleeper("older", { STARGATE_CODEX_TURN: turn });
    await delay(50);
    const tool = await sleeper("tool", { STARGATE_CODEX_TURN: turn });
    await writeFile(
      record,
      JSON.stringify({ turn, since: (await start(older)) + 1 }),
    );
    // The tool may share the older process's clock tick; then it is kept too.
    if ((await start(tool)) <= (await start(older))) return;
    await backend.interrupt(id, signal());
    await until(() => !alive(tool));
    expect(alive(other)).toBe(true);
    expect(alive(older)).toBe(true);
    await expect(readFile(record)).rejects.toThrow();
  },
);

test("closing the Codex backend stops running turns", async () => {
  const { backend, runs } = await open();
  const turn = backend.prompt(await session(backend), "hang", signal());
  await until(async () => (await runs().catch(() => [])).length > 0);
  const [run] = await runs();
  await backend.close();
  await expect(turn).rejects.toThrow();
  await until(() => !alive(run?.pid ?? 0));
  await expect(session(backend)).rejects.toThrow("closing");
});

test("Codex attachments become images or inline text, or fail closed", async () => {
  const file = (mime: string, data = "hello", name = "file") => ({
    name,
    mime,
    data: new TextEncoder().encode(data),
  });
  expect(codexInput("text", [])).toEqual({ text: "text", images: [] });
  const input = codexInput("look", [file("image/png"), file("text/plain")]);
  expect(input.text).toBe(
    "look\n\nAttachment: file (image 1)\n\nAttachment: file\nhello",
  );
  expect(input.images.map(({ mime }) => mime)).toEqual(["image/png"]);
  for (const bad of [
    file("application/pdf"),
    file("application/zip"),
    file("text/plain", "\u0000"),
    file("image/png", "png", "../../etc/passwd"),
  ])
    expect(() => codexInput("x", [bad])).toThrow(AttachmentInputUnavailable);
  const { backend, prompts } = await open();
  await backend.prompt(
    await session(backend),
    "look",
    signal(),
    undefined,
    undefined,
    [file("image/png", "png", "screen shot.png")],
  );
  const [entry] = await prompts();
  expect(entry?.images).toEqual([true]);
});

test("Codex configuration is strict and fails closed", () => {
  const parse = (extra: Record<string, unknown>) =>
    codexBackendSchema.safeParse({
      type: "codex",
      directory: "/workspace",
      model: "gpt-6.1-sol",
      provider: { baseURL: "http://127.0.0.1:8317/v1", apiKeyEnv },
      ...extra,
    }).success;
  const defaults = config();
  expect(defaults.sandbox).toBe("read-only");
  expect(defaults.network).toBe(false);
  expect(defaults.projectDocs).toBe(false);
  expect(parse({})).toBe(true);
  expect(parse({ provider: undefined })).toBe(false);
  for (const provider of [
    { baseURL: "http://proxy.example/v1", apiKeyEnv },
    { baseURL: "https://user:pw@proxy.example/v1", apiKeyEnv },
    { baseURL: "http://127.0.0.1:8317", apiKeyEnv },
    { baseURL: "http://127.0.0.1:8317/v1", apiKeyEnv: "lower-case" },
    { baseURL: "http://127.0.0.1:8317/v1", apiKey: "sk-value" },
  ])
    expect(parse({ provider })).toBe(false);
  for (const extra of [
    { directory: "relative" },
    { model: "gpt 6" },
    { extraPath: ["relative/bin"] },
    { extraPath: Array.from({ length: 33 }, (_, index) => `/opt/${index}`) },
    { sandbox: "none" },
    // The read-only sandbox always blocks network; it cannot be opened.
    { network: true },
    // No sandbox cannot block network; it must be acknowledged.
    { sandbox: "danger-full-access" },
    { approvalPolicy: "on-request" },
    { webSearch: true },
    { mcpServers: {} },
    { profile: "fast" },
    { config: { model_provider: "openai" } },
    { env: { OPENAI_API_KEY: "x" } },
    { reasoningEffort: "ultra" },
  ])
    expect(parse(extra)).toBe(false);
  for (const extra of [
    { sandbox: "workspace-write" },
    { sandbox: "workspace-write", network: true },
    { sandbox: "danger-full-access", network: true },
    { projectDocs: true, reasoningEffort: "medium", systemPrompt: "Brief." },
  ])
    expect(parse(extra)).toBe(true);
  // Code, instructions and tools from outside Stargate's configuration stay off.
  const features = codexConfig(config())["features"];
  expect(Object.values(features as object).every((on) => on === false)).toBe(
    true,
  );
  for (const name of ["plugins", "apps", "hooks", "shell_snapshot", "goals"])
    expect(Object.keys(features as object)).toContain(name);
  // IRC captains and crew accept the backend too.
  expect(
    ircSchema.safeParse({
      id: "galactica-irc",
      server: { host: "127.0.0.1", port: 6667, tls: false },
      account: "galactica",
      passwordEnv: "IRC_CAPTAIN",
      channels: ["#ship-galactica"],
      crew: [
        {
          id: "helo",
          account: "galactica-helo",
          passwordEnv: "IRC_HELO",
          channels: ["#ship-galactica"],
          backend: config(),
        },
      ],
      backend: config(),
    }).success,
  ).toBe(true);
});

test("createBackend opens the Codex adapter on demand", async () => {
  const root = await mkdtemp(join(tmpdir(), "stargate-codex-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const backend = await createBackend(config(), { dataDirectory: root });
  cleanup.push(() => backend.close());
  expect(backend).toBeInstanceOf(CodexBackend);
  expect(backend.supportsAttachments).toBe(true);
});

test("Codex maps what the CLI reports to one shared failure category", async () => {
  const { backend } = await open();
  const id = await session(backend);
  const failure = (prompt: string) =>
    backend.prompt(id, prompt, signal()).then(
      () => undefined,
      (error: unknown) =>
        error instanceof BackendFailure ? error.failure : String(error),
    );
  // Messages as the Codex CLI writes them; the provider body follows a colon.
  const secret = '{"error":"acct_42 sk-proj-secret in cooldown"}';
  const cases: [prompt: string, cause: string][] = [
    [
      `fail=unexpected status 429 Too Many Requests: ${secret};`,
      "provider:quota:429:idle",
    ],
    [
      "fail=exceeded retry limit, last status: 429 Too Many Requests;",
      "provider:quota:429:idle",
    ],
    ["fail=You have hit your usage limit.;", "provider:quota:0:idle"],
    [
      `fail=unexpected status 401 Unauthorized: ${secret};`,
      "provider:auth:401:idle",
    ],
    ["fail=unexpected status 403 Forbidden: no;", "provider:auth:403:idle"],
    [
      "fail=unexpected status 404 Not Found: no such model;",
      "provider:model:404:idle",
    ],
    [
      "fail=unexpected status 504 Gateway Timeout: slow;",
      "provider:timeout:504:idle",
    ],
    ["fail=request timed out;", "provider:timeout:0:idle"],
    [
      "fail=unexpected status 503 Service Unavailable: down;",
      "provider:provider:503:idle",
    ],
    [
      "fail=error sending request for url (http://127.0.0.1:8317/v1/responses);",
      "provider:network:0:idle",
    ],
    [
      "fatal fail=stream disconnected before completion: reset;",
      "provider:network:0:idle",
    ],
    // A command ran before the provider refused the next call.
    [
      "tool fail=unexpected status 429 Too Many Requests: later;",
      "provider:quota:429:ran",
    ],
    // No result: Stargate cannot know what the CLI did.
    ["crash", "provider:crash:0:ran"],
  ];
  for (const [prompt, cause] of cases)
    expect([prompt, await failure(prompt)]).toEqual([prompt, cause]);
  // A message that names no provider failure keeps the generic failure.
  expect(await failure("fail")).toBe("Error: Codex turn failed");
});
