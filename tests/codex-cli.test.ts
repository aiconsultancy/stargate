import { afterAll, afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result, Schema } from "effect";
import {
  bootTicks,
  systemProcesses,
  turnProcesses,
} from "../src/backends/cli-agent";
import { CodexBackend, type CodexRuntime } from "../src/backends/codex";
import { codexSearchPath, nativeCodex } from "../src/backends/codex-paths";
import { codexBackendSchema } from "../src/config";
import { toolchain } from "./codex-toolchain";

const tools = await toolchain();

afterAll(() => tools.remove());

/*
 * The pinned SDK's real Codex CLI against a loopback OpenAI Responses
 * fixture: no provider is contacted. A fake HOME holds canary credentials,
 * configuration, skills and instructions that must never be used, and a
 * recording HTTP proxy shows any connection to anywhere else.
 */
const canary = "STARGATECANARY";
const memory = "STARGATEPROJECTMEMORY";
const skill = "STARGATESKILLCANARY";
const apiKeyEnv = "STARGATE_CODEX_CLI_TEST_KEY";
const key = "local-proxy-test-only";
const saved = new Map<string, string | undefined>();
const cleanup: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const [name, value] of saved) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  saved.clear();

  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

function setEnv(values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) {
    if (!saved.has(name)) {
      saved.set(name, process.env[name]);
    }

    process.env[name] = value;
  }
}

type Tool = {
  type: string;
  name?: string | undefined;
  description?: string | undefined;
  tools?: readonly Tool[] | undefined;
};

const toolSchema: Schema.Codec<Tool> = Schema.Struct({
  type: Schema.String,
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Array(Schema.suspend(() => toolSchema))),
});

// Zod's `.default([])` filled a missing or undefined key.
const emptyList = Effect.succeed([]);

const decodeBody = Schema.decodeUnknownResult(
  Schema.Struct({
    model: Schema.String,
    tools: Schema.Array(toolSchema).pipe(Schema.withDecodingDefault(emptyList)),
    input: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        output: Schema.optional(Schema.Unknown),
        tools: Schema.optional(Schema.Array(toolSchema)),
      }),
    ).pipe(Schema.withDecodingDefault(emptyList)),
  }),
);

/**
 * Every tool the model is offered: namespaced tools, and the nested tools
 * that Codex's JavaScript `exec` tool documents as `### \`name\``.
 */
function toolNames(tools: readonly Tool[], prefix = ""): string[] {
  return tools.flatMap((tool) => {
    const name = `${prefix}${tool.name ?? tool.type}`;

    if (tool.tools) {
      return toolNames(tool.tools, `${name}.`);
    }

    const nested = [...(tool.description ?? "").matchAll(/^### `([^`]+)`/gm)];

    return [name, ...nested.map((match) => `${name}/${match[1]}`)];
  });
}

/** One scripted model response: text, or JavaScript for the exec tool. */
type Reply = { text: string } | { exec: string };

function fixture(script: Reply[] = []) {
  const requests: {
    path: string;
    bearer: boolean;
    canary: boolean;
    memory: boolean;
    skill: boolean;
    body: string;
    model?: string;
    tools?: string[];
    outputs?: string[];
  }[] = [];

  let probes = 0;

  const event = (data: { type: string; [field: string]: unknown }) =>
    `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;

  const usage = {
    input_tokens: 1,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 1,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 2,
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/probe") {
        probes++;

        return new Response("PROBED");
      }

      const text = request.method === "POST" ? await request.text() : "";
      const parsed = decodeBody(text ? JSON.parse(text) : {});
      requests.push({
        path: url.pathname,
        bearer: request.headers.get("authorization") === `Bearer ${key}`,
        canary: `${[...request.headers.values()].join(" ")} ${text}`.includes(
          canary,
        ),
        memory: text.includes(memory),
        skill: text.includes(skill) || text.includes("skill-creator"),
        body: text,
        ...(Result.isSuccess(parsed)
          ? {
              model: parsed.success.model,
              tools: toolNames([
                ...parsed.success.tools,
                ...parsed.success.input.flatMap((item) => item.tools ?? []),
              ]).sort(),
              outputs: parsed.success.input
                .filter((item) => item.type.endsWith("_output"))
                .map((item) => JSON.stringify(item.output)),
            }
          : {}),
      });

      if (url.pathname !== "/v1/responses") {
        return Response.json({}, { status: 404 });
      }

      const reply = script.shift() ?? { text: "Fixture reply" };
      const id = `resp_${requests.length}`;

      const item =
        "text" in reply
          ? {
              type: "message",
              id: `msg_${requests.length}`,
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: reply.text, annotations: [] },
              ],
            }
          : {
              type: "custom_tool_call",
              id: `ctc_${requests.length}`,
              call_id: `call_${requests.length}`,
              name: "exec",
              input: reply.exec,
              status: "completed",
            };

      return new Response(
        event({ type: "response.created", response: { id } }) +
          event({
            type: "response.output_item.added",
            output_index: 0,
            item,
          }) +
          event({
            type: "response.output_item.done",
            output_index: 0,
            item,
          }) +
          event({
            type: "response.completed",
            response: { id, usage },
          }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });

  cleanup.push(async () => server.stop(true));

  return {
    requests,
    script,
    probes: () => probes,
    port: server.port,
    baseURL: `http://127.0.0.1:${server.port}/v1`,
  };
}

/** An HTTP proxy that records each request line and refuses it. */
async function recordingProxy() {
  const seen: string[] = [];

  const server = createServer((socket) => {
    socket.once("data", (data) => {
      seen.push(data.toString("latin1").split("\r\n")[0] ?? "");
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    socket.on("error", () => {});
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  cleanup.push(
    () => new Promise((resolve) => server.close(() => resolve(undefined))),
  );
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;

  // Test seam: route everything but the loopback fixture via the recorder.
  const environment = {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    ALL_PROXY: url,
    NO_PROXY: "127.0.0.1",
  };

  return { seen, environment };
}

/** No process of these tests is older than this. */
const testStart = await bootTicks();

/**
 * PIDs of live processes that carry a Codex turn's marker, found as the
 * adapter finds them: only this user's processes started during the tests.
 */
async function processesOf(turn: string) {
  const found = await turnProcesses(
    systemProcesses,
    { variable: "STARGATE_CODEX_TURN", value: turn },
    testStart,
  );

  return found.map(({ pid }) => pid);
}

async function setup(name: string) {
  const root = await mkdtemp(join(tmpdir(), `stargate-codex-cli-${name}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  const data = join(root, "data");

  for (const directory of [home, project, data]) {
    await mkdir(directory, { recursive: true });
  }

  return { root, home, project, data };
}

async function open(
  project: string,
  dataDirectory: string,
  baseURL: string,
  extra: Record<string, unknown> = {},
  runtime: CodexRuntime = {},
) {
  await mkdir(dataDirectory, { recursive: true });

  const backend = await CodexBackend.open(
    Schema.decodeUnknownSync(codexBackendSchema)({
      type: "codex",
      directory: project,
      model: "gpt-6.1-sol",
      provider: { baseURL, apiKeyEnv },
      // The tests' own programs; see `codex-toolchain.ts`.
      extraPath: [tools.directory],
      ...extra,
    }),
    { dataDirectory },
    { graceMs: 500, ...runtime },
  );

  cleanup.push(() => backend.close());

  return backend;
}

const signal = () => AbortSignal.timeout(90_000);

const session = (backend: CodexBackend) =>
  backend.createSession({ key: "k", title: "T", signal: signal() });

/** Whether the bundled Linux sandbox can start on this host. */
/**
 * Whether the Codex sandbox can start on this host with the `PATH` that the
 * backend gives the CLI: the CLI finds `bwrap` there and otherwise uses its
 * bundled copy, which may not work where the system one does.
 */
async function sandboxWorks() {
  if (process.platform !== "linux") {
    return false;
  }

  const home = await mkdtemp(join(tmpdir(), "stargate-codex-probe-"));

  try {
    const native = nativeCodex();

    const result = spawnSync(native.executable, ["sandbox", "--", "true"], {
      env: {
        PATH: await codexSearchPath([tools.directory], native.helpers, []),
        HOME: home,
        CODEX_HOME: home,
      },
      stdio: "ignore",
      timeout: 30_000,
    });

    return result.status === 0;
  } catch {
    return false;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const sandboxed = await sandboxWorks();

test("real Codex CLI uses only the configured proxy, key and thread", async () => {
  const { root, home, project, data } = await setup("routing");
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(join(home, ".agents", "skills", "stargate"), { recursive: true });
  await mkdir(join(project, ".codex"), { recursive: true });
  await writeFile(
    join(home, ".codex", "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: `sk-${canary}`, auth_mode: "apikey" }),
  );

  const redirect = `model_provider = "canary"
notify = ["touch", "${join(root, "notified")}"]
[model_providers.canary]
name = "canary"
base_url = "http://127.0.0.1:9/v1"
env_key = "OPENAI_API_KEY"
[mcp_servers.canary]
command = "touch"
args = ["${join(root, "mcp")}"]
`;

  await writeFile(join(home, ".codex", "config.toml"), redirect);
  await writeFile(join(project, ".codex", "config.toml"), redirect);
  await writeFile(
    join(home, ".agents", "skills", "stargate", "SKILL.md"),
    `---\nname: stargate\ndescription: ${skill}\n---\n${skill}\n`,
  );
  await writeFile(join(project, "AGENTS.md"), memory);

  for (const rc of [".zshrc", ".bashrc", ".profile", ".zprofile"]) {
    await writeFile(join(home, rc), `touch ${join(root, "rc")}\n`);
  }

  const before = (await readdir(home)).concat(
    await readdir(join(home, ".codex")),
  );

  const { requests, baseURL } = fixture();
  const proxy = await recordingProxy();
  setEnv({
    HOME: home,
    SHELL: "/bin/sh",
    [apiKeyEnv]: key,
    OPENAI_API_KEY: `sk-${canary}`,
    CODEX_API_KEY: `sk-${canary}`,
    OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
  });
  const runtime = { environment: proxy.environment };
  const dataDirectory = join(data, "closed");
  const backend = await open(project, dataDirectory, baseURL, {}, runtime);
  const id = await session(backend);
  const previews: string[] = [];
  expect(
    await backend.prompt(id, "Say STARGATEFIRST", signal(), (text) =>
      previews.push(text),
    ),
  ).toBe("Fixture reply");
  expect(previews).toEqual(["Fixture reply"]);
  // The second turn and a restarted backend resume the same Codex thread.
  expect(await backend.prompt(id, "Again", signal())).toBe("Fixture reply");
  await backend.close();
  const restarted = await open(project, dataDirectory, baseURL, {}, runtime);
  expect(await restarted.prompt(id, "After restart", signal())).toBe(
    "Fixture reply",
  );
  const turns = requests.filter(({ path }) => path === "/v1/responses");

  expect(turns.length).toBe(3);

  for (const turn of turns.slice(1)) {
    expect(turn.body).toContain("STARGATEFIRST");
  }

  for (const turn of turns) {
    expect(turn.model).toBe("gpt-6.1-sol");
    expect(turn.memory).toBe(false);
    expect(turn.skill).toBe(false);
    // No web search, subagent, plugin, app, goal or image generation
    // Tools. The MCP resource tools have no servers to read: project and
    // User configuration are not loaded.
    expect(turn.tools).toEqual([
      "clock.sleep",
      "functions.exec",
      "functions.exec/apply_patch",
      "functions.exec/clock__curr_time",
      "functions.exec/exec_command",
      "functions.exec/list_mcp_resource_templates",
      "functions.exec/list_mcp_resources",
      "functions.exec/read_mcp_resource",
      "functions.exec/view_image",
      "functions.exec/write_stdin",
      "functions.request_user_input",
      "functions.request_user_input_async",
      "functions.wait",
    ]);
  }

  // A new conversation is a new thread: no earlier text.
  const other = await restarted.prompt(
    await session(restarted),
    "Fresh",
    signal(),
  );

  expect(other).toBe("Fixture reply");
  expect(requests.at(-1)?.body).not.toContain("STARGATEFIRST");

  // Project instructions load only when selected; the system prompt, effort
  // And image attachments reach the model.
  const docs = await open(
    project,
    join(data, "docs"),
    baseURL,
    {
      projectDocs: true,
      systemPrompt: "STARGATESYSTEMPROMPT",
      reasoningEffort: "high",
    },
    runtime,
  );

  const png = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    ),
    (char) => char.charCodeAt(0),
  );

  await docs.prompt(await session(docs), "Hi", signal(), undefined, undefined, [
    { name: "dot.png", mime: "image/png", data: png },
  ]);
  const last = requests.at(-1);
  expect(last?.memory).toBe(true);
  expect(last?.body).toContain("STARGATESYSTEMPROMPT");
  expect(last?.body).toContain("input_image");
  expect(last?.body).toContain("Attachment: dot.png (image 1)");
  expect(
    Schema.decodeUnknownSync(
      Schema.Struct({ reasoning: Schema.Struct({ effort: Schema.String }) }),
    )(JSON.parse(last?.body ?? "{}")).reasoning.effort,
  ).toBe("high");

  for (const request of requests) {
    expect(request.path).toBe("/v1/responses");
    expect(request.bearer).toBe(true);
    expect(request.canary).toBe(false);
  }

  expect(proxy.seen).toEqual([]);

  for (const file of ["notified", "mcp", "rc"]) {
    expect(await readdir(root)).not.toContain(file);
  }

  expect(
    (await readdir(home)).concat(await readdir(join(home, ".codex"))),
  ).toEqual(before);
}, 180_000);

/** JavaScript for Codex's exec tool: each command's output, tagged. */
function commands(
  list: {
    tag: string;
    cmd: string;
    shell?: string;
    escalate?: boolean;
    wait?: number;
  }[],
) {
  return list
    .map(
      ({ tag, cmd, shell, escalate, wait }) =>
        `try { const r = await tools.exec_command(${JSON.stringify({
          cmd,
          ...(shell ? { shell } : {}),
          login: false,
          yield_time_ms: wait ?? 10_000,
          ...(escalate
            ? { sandbox_permissions: "require_escalated", justification: "t" }
            : {}),
        })}); text(${JSON.stringify(`${tag}:`)} + JSON.stringify(r)); } catch (e) { text(${JSON.stringify(`${tag}:refused `)} + String(e)); }`,
    )
    .join("\n");
}

/** Waits until no process of the turn is left. */
async function noneLeft(turn: string) {
  const deadline = Date.now() + 3000;

  while ((await processesOf(turn)).length && Date.now() < deadline) {
    await Bun.sleep(25);
  }

  return processesOf(turn);
}

test.skipIf(!sandboxed)(
  "real Codex CLI tools run sandboxed and never see the key",
  async () => {
    const { root, home, project, data } = await setup("tools");
    const { requests, script, baseURL, port, probes } = fixture();
    const proxy = await recordingProxy();

    // Shell start-up files that would run in every tool command.
    for (const rc of [".zshenv", ".zshrc", ".bashrc", ".profile"]) {
      await writeFile(join(home, rc), "export STARGATE_RC_RAN=1\n");
    }

    setEnv({ [apiKeyEnv]: key, HOME: home });
    // Probe both the account's default shell and Codex's Linux fallback.
    // Network seccomp can make Bash mistake even /dev/null for socket stdin.
    const environmentCommand = `printf 'turn=%s\\n' "$STARGATE_CODEX_TURN"; printf 'matches=%s\\n' "$(env | grep -c -F -e '${key}' -e STARGATE_CODEX_PROVIDER_KEY -e ${apiKeyEnv} -e STARGATE_RC_RAN)"`;
    // Shared /tmp is never a writable root.
    const shared = `/tmp/stargate-codex-test-${crypto.randomUUID()}`;
    cleanup.push(() =>
      Promise.all(
        ["readonly", "workspace", "network"].map((name) =>
          rm(`${shared}-${name}`, { force: true }),
        ),
      ),
    );

    const run = async (name: string, extra: Record<string, unknown>) => {
      const dataDirectory = join(data, name);

      const backend = await open(project, dataDirectory, baseURL, extra, {
        environment: proxy.environment,
      });

      script.push(
        {
          exec: commands([
            {
              // The marker, and a count of variables that must be absent;
              // The environment itself is never printed.
              tag: "ENV",
              cmd: environmentCommand,
            },
            {
              tag: "BASHENV",
              shell: "/bin/bash",
              cmd: environmentCommand,
            },
            { tag: "RG", cmd: "command -v rg" },
            { tag: "WRITE", cmd: `touch ${join(project, name)}; echo rc=$?` },
            { tag: "TMP", cmd: `touch ${shared}-${name}; echo rc=$?` },
            {
              tag: "NET",
              cmd: `curl -sS -m 3 http://127.0.0.1:${port}/probe; echo rc=$?`,
            },
            {
              tag: "ESC",
              cmd: `touch ${join(root, `escalated-${name}`)}`,
              escalate: true,
            },
            {
              tag: "BG",
              cmd: "(trap '' TERM; exec sleep 600) > /dev/null 2>&1 & echo bg",
            },
          ]),
        },
        { text: "Tools done" },
      );
      expect(
        await backend.prompt(await session(backend), "Use tools", signal()),
      ).toBe("Tools done");
      const output = (requests.at(-1)?.outputs ?? []).join("\n");
      expect(output).toContain("ENV:");
      expect(output).toContain("BASHENV:");
      expect(output).toContain("BG:");
      expect(output).not.toContain("STARGATE_RC_RAN");
      expect(
        [...output.matchAll(/matches=(\d+)/g)].map((match) => match[1]),
      ).toEqual(["0", "0"]);
      // The SDK's helper commands come first on PATH, as without Stargate.
      expect(output).toMatch(/RG:[^\n]*codex-path\/rg/);
      const marker = /turn=([0-9a-f-]{36})/.exec(output)?.[1];
      expect(marker).toBeDefined();
      // Nothing of the turn is left running, in or outside the sandbox.
      expect(await noneLeft(marker ?? "")).toEqual([]);
      expect(output).not.toContain(key);
      expect(output).not.toContain("STARGATE_CODEX_PROVIDER_KEY");
      expect(output).not.toContain(apiKeyEnv);

      return output;
    };

    // Read-only: no writes, no network, no escalation.
    await run("readonly", {});
    expect(await readdir(project)).toEqual([]);
    expect(probes()).toBe(0);
    // Workspace-write: writes inside the directory; network stays off.
    await run("workspace", { sandbox: "workspace-write" });
    expect(await readdir(project)).toEqual(["workspace"]);
    expect(probes()).toBe(0);
    // Network is opened only by explicit configuration.
    await run("network", { sandbox: "workspace-write", network: true });
    expect(probes()).toBe(1);
    expect(
      (await readdir(root)).filter((f) => f.startsWith("escalated")),
    ).toEqual([]);

    for (const name of ["readonly", "workspace", "network"]) {
      expect(await Bun.file(`${shared}-${name}`).exists()).toBe(false);
    }

    expect(proxy.seen).toEqual([]);
  },
  240_000,
);

test.skipIf(!sandboxed)(
  "real Codex CLI and launcher never run commands from a writable PATH",
  async () => {
    const { root, project, data } = await setup("shims");
    await Bun.$`git init -q ${project}`.quiet();
    const bin = join(project, "bin");
    await mkdir(bin);
    // The CLI runs git outside the sandbox in a repository; the launcher
    // Runs sh, mkfifo, cat and rm.
    const names = ["git", "rg", "sh", "mkfifo", "cat", "rm", "bwrap"];

    for (const name of names) {
      await writeFile(
        join(bin, name),
        `#!/bin/sh\n: > ${join(root, `ran-${name}`)}\nexit 1\n`,
        { mode: 0o755 },
      );
    }

    // A PATH entry behind a link outside the workspace, retargeted to the
    // Shims between turns, and a directory with a link to the git shim.
    const benign = join(root, "benign");
    await mkdir(benign);
    const linked = join(root, "linked-bin");
    await symlink(benign, linked);
    const links = join(root, "links");
    await mkdir(links);
    await symlink(join(bin, "git"), join(links, "git"));
    const { requests, script, baseURL } = fixture();
    setEnv({
      [apiKeyEnv]: key,
      PATH: [linked, links, bin, process.env["PATH"] ?? "/usr/bin:/bin"].join(
        ":",
      ),
    });

    const backend = await open(project, join(data, "shims"), baseURL, {
      sandbox: "workspace-write",
    });

    const id = await session(backend);

    for (const turn of [1, 2]) {
      if (turn === 2) {
        await rm(linked);
        await symlink(bin, linked);
      }

      script.push(
        { exec: commands([{ tag: "WHICH", cmd: "command -v git cat rg" }]) },
        { text: "Done" },
      );
      expect(await backend.prompt(id, "Look", signal())).toBe("Done");
      const output = (requests.at(-1)?.outputs ?? []).join("\n");
      expect(output).toContain("WHICH:");

      for (const path of [bin, linked, links]) {
        expect(output).not.toContain(path);
      }

      expect(
        (await readdir(root)).filter((name) => name.startsWith("ran-")),
      ).toEqual([]);
    }

    // A data directory inside the workspace is refused before any turn.
    await expect(
      open(project, join(project, ".stargate"), baseURL, {
        sandbox: "workspace-write",
      }),
    ).rejects.toThrow(/Stargate's data directory/);
  },
  120_000,
);

test.skipIf(process.platform !== "linux")(
  "cancelling a real Codex turn stops the CLI and every tool process",
  async () => {
    const { root, project, data } = await setup("cancel");
    const { script, baseURL } = fixture();
    setEnv({ [apiKeyEnv]: key });

    // The real CLI behind a shell that ignores SIGTERM and keeps its output
    // Open: the SDK's own SIGTERM cannot end the turn.
    const [native] = [
      ...new Bun.Glob(
        "node_modules/@openai/codex-*/vendor/*/bin/codex",
      ).scanSync({
        cwd: join(import.meta.dir, ".."),
        absolute: true,
      }),
    ];

    const deaf = join(root, "deaf-codex");
    await writeFile(
      deaf,
      `#!/bin/sh\ntrap '' TERM\n"${native}" "$@"\nexit $?\n`,
      { mode: 0o755 },
    );
    const full = { sandbox: "danger-full-access", network: true };

    // With the sandbox and without one, where tools see the host directly.
    const modes: { extra: Record<string, unknown>; runtime?: CodexRuntime }[] =
      [{ extra: full }, { extra: full, runtime: { executable: deaf } }];

    if (sandboxed) {
      modes.push({ extra: {} });
    }

    for (const [index, { extra, runtime }] of modes.entries()) {
      const dataDirectory = join(data, String(index));

      const backend = await open(
        project,
        dataDirectory,
        baseURL,
        extra,
        runtime,
      );

      script.push({
        exec: commands([
          {
            tag: "HANG",
            cmd: "trap '' TERM; sleep 600 & wait; sleep 600",
            wait: 60_000,
          },
        ]),
      });
      const controller = new AbortController();
      const id = await session(backend);
      const turn = backend.prompt(id, "Hang", controller.signal);
      const record = join(dataDirectory, "codex-runs", `${id}.json`);
      let marker = "";

      const sleeping = async () => {
        marker ||= await readFile(record, "utf8").then(
          (text) =>
            Schema.decodeUnknownSync(Schema.Struct({ turn: Schema.String }))(
              JSON.parse(text),
            ).turn,
          () => "",
        );

        if (!marker) {
          return false;
        }

        for (const pid of await processesOf(marker)) {
          const argv = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(
            () => "",
          );

          if (argv.split("\0")[0] === "sleep") {
            return true;
          }
        }

        return false;
      };

      const deadline = Date.now() + 60_000;

      while (!(await sleeping())) {
        if (Date.now() > deadline) {
          controller.abort();
          await turn.catch(() => {});
          throw new Error("No tool process started");
        }

        await Bun.sleep(50);
      }

      cleanup.push(async () => {
        for (const pid of await processesOf(marker)) {
          process.kill(pid, "SIGKILL");
        }
      });
      // The CLI, the sandbox helpers and the sleepers all carry the marker.
      expect((await processesOf(marker)).length).toBeGreaterThan(2);
      const begin = Date.now();
      controller.abort();
      await expect(turn).rejects.toThrow();
      // Grace (500 ms) for SIGTERM, then SIGKILL and a short wait.
      expect(Date.now() - begin).toBeLessThan(3000);
      expect(await noneLeft(marker)).toEqual([]);
    }
  },
  240_000,
);
