import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ClaudeBackend } from "../src/backends/claude";
import { claudeBackendSchema } from "../src/config";

/*
 * The pinned SDK's real Claude Code CLI against a loopback Anthropic
 * Messages fixture: no provider is contacted. A fake HOME holds canary
 * credentials, settings and memory that must never be used.
 */
const canary = "POGOCANARY";
const memory = "POGOPROJECTMEMORY";
const apiKeyEnv = "POGO_CLAUDE_CLI_TEST_KEY";
const key = "local-proxy-test-only";
const saved = new Map<string, string | undefined>();
const cleanup: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  for (const step of cleanup.splice(0).reverse()) await step();
});

function setEnv(values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    process.env[name] = value;
  }
}

const body = z.object({
  model: z.string(),
  tools: z.array(z.object({ name: z.string() })).default([]),
  messages: z
    .array(z.object({ role: z.string(), content: z.unknown() }))
    .default([]),
});
const toolResult = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
  content: z.unknown(),
});

/** One scripted model response: text, or tool calls the CLI must handle. */
type Reply =
  | { text: string }
  | { tools: { id: string; name: string; input: object }[] };

function fixture(script: Reply[] = []) {
  const requests: {
    path: string;
    bearer: boolean;
    apiKey: boolean;
    canary: boolean;
    memory: boolean;
    model?: string;
    tools?: string[];
    results?: { id: string; error: boolean; text: string }[];
  }[] = [];
  const event = (type: string, data: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const blocks = (reply: Reply) =>
    "text" in reply
      ? event("content_block_start", {
          index: 0,
          content_block: { type: "text", text: "" },
        }) +
        event("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: reply.text },
        }) +
        event("content_block_stop", { index: 0 })
      : reply.tools
          .map(
            (tool, index) =>
              event("content_block_start", {
                index,
                content_block: {
                  type: "tool_use",
                  id: tool.id,
                  name: tool.name,
                  input: {},
                },
              }) +
              event("content_block_delta", {
                index,
                delta: {
                  type: "input_json_delta",
                  partial_json: JSON.stringify(tool.input),
                },
              }) +
              event("content_block_stop", { index }),
          )
          .join("");
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const text = request.method === "POST" ? await request.text() : "";
      const parsed = body.safeParse(text ? JSON.parse(text) : {});
      const last = parsed.success ? parsed.data.messages.at(-1) : undefined;
      requests.push({
        path: url.pathname,
        bearer: request.headers.get("authorization") === `Bearer ${key}`,
        apiKey: request.headers.has("x-api-key"),
        canary: `${[...request.headers.values()].join(" ")} ${text}`.includes(
          canary,
        ),
        memory: text.includes(memory),
        ...(parsed.success
          ? {
              model: parsed.data.model,
              tools: parsed.data.tools.map(({ name }) => name),
              results: (Array.isArray(last?.content) ? last.content : [])
                .flatMap((block) => {
                  const result = toolResult.safeParse(block);
                  return result.success ? [result.data] : [];
                })
                .map((result) => ({
                  id: result.tool_use_id,
                  error: result.is_error === true,
                  text: JSON.stringify(result.content),
                })),
            }
          : {}),
      });
      if (url.pathname !== "/v1/messages")
        return Response.json({}, { status: 404 });
      const reply = script.shift() ?? { text: "Fixture reply" };
      return new Response(
        event("message_start", {
          message: {
            id: `msg_fixture_${requests.length}`,
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5-5",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        }) +
          blocks(reply) +
          event("message_delta", {
            delta: { stop_reason: "text" in reply ? "end_turn" : "tool_use" },
            usage: { output_tokens: 3 },
          }) +
          event("message_stop", {}),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  cleanup.push(async () => server.stop(true));
  return { requests, baseURL: `http://127.0.0.1:${server.port}/v1` };
}

test("real Claude Code CLI uses only the configured proxy and key", async () => {
  const root = await mkdtemp(join(tmpdir(), "pogo-claude-cli-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  const data = join(root, "data");
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(project, ".claude"), { recursive: true });
  await mkdir(data);
  await writeFile(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: `sk-ant-oat01-${canary}`,
        refreshToken: `sk-ant-ort01-${canary}`,
        expiresAt: Date.now() + 3_600_000,
        scopes: ["user:inference"],
      },
    }),
  );
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({ primaryApiKey: `sk-ant-api03-${canary}` }),
  );
  await writeFile(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" } }),
  );
  await writeFile(join(project, "CLAUDE.md"), memory);
  await writeFile(
    join(project, ".claude", "settings.json"),
    JSON.stringify({
      permissions: {
        allow: ["Bash", "Write"],
        defaultMode: "bypassPermissions",
      },
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" },
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: `touch ${root}/hook` }] },
        ],
      },
    }),
  );
  const before = (await readdir(home)).concat(
    await readdir(join(home, ".claude")),
  );
  const { requests, baseURL } = fixture();
  setEnv({
    HOME: home,
    [apiKeyEnv]: key,
    ANTHROPIC_API_KEY: `sk-ant-api03-${canary}`,
    CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${canary}`,
  });
  const open = async (extra: Record<string, unknown>, name: string) => {
    const dataDirectory = join(data, name);
    await mkdir(dataDirectory);
    const backend = await ClaudeBackend.open(
      claudeBackendSchema.parse({
        type: "claude",
        directory: project,
        model: "claude-sonnet-5-5",
        provider: { baseURL, apiKeyEnv },
        ...extra,
      }),
      { dataDirectory },
    );
    cleanup.push(() => backend.close());
    return backend;
  };
  const signal = () => AbortSignal.timeout(60_000);

  const closed = await open({}, "closed");
  const id = await closed.createSession({
    key: "k",
    title: "T",
    signal: signal(),
  });
  const previews: string[] = [];
  expect(
    await closed.prompt(id, "Say hi", signal(), (text) => previews.push(text)),
  ).toBe("Fixture reply");
  expect(previews.at(-1)).toBe("Fixture reply");
  // Resumes the same native session; prompt text is never expanded.
  expect(await closed.prompt(id, "@CLAUDE.md /clear", signal())).toBe(
    "Fixture reply",
  );
  const first = requests.filter(({ path }) => path === "/v1/messages");
  expect(first.length).toBe(2);
  for (const request of first) {
    expect(request.model).toBe("claude-sonnet-5-5");
    expect(request.tools).toEqual([]);
    expect(request.memory).toBe(false);
  }

  // Project settings load only when selected. They cannot add tools, run
  // hooks or redirect the endpoint.
  const allowed = await open(
    { allowedTools: ["Read"], settingSources: ["project"] },
    "allowed",
  );
  expect(
    await allowed.prompt(
      await allowed.createSession({ key: "k", title: "T", signal: signal() }),
      "Read something",
      signal(),
    ),
  ).toBe("Fixture reply");
  const last = requests.at(-1);
  expect(last?.memory).toBe(true);
  expect(last?.tools).toContain("Read");
  for (const tool of ["Bash", "Write", "Edit", "Agent", "WebFetch"])
    expect(last?.tools).not.toContain(tool);
  expect(requests.filter(({ path }) => path === "/v1/messages").length).toBe(3);
  expect(await readdir(root)).not.toContain("hook");

  for (const request of requests) {
    expect(request.bearer).toBe(true);
    expect(request.apiKey).toBe(false);
    expect(request.canary).toBe(false);
  }
  expect(
    (await readdir(home)).concat(await readdir(join(home, ".claude"))),
  ).toEqual(before);
}, 120_000);

test("real Claude Code CLI runs only the allowed tool names", async () => {
  const root = await mkdtemp(join(tmpdir(), "pogo-claude-cli-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const data = join(root, "data");
  await mkdir(join(project, "allowed"), { recursive: true });
  await mkdir(data);
  await writeFile(join(project, "allowed", "ok.txt"), "POGOALLOWED");
  await writeFile(join(project, "forbidden.txt"), "POGOFORBIDDEN");
  const { requests, baseURL } = fixture([
    {
      tools: [
        {
          id: "toolu_read",
          name: "Read",
          input: { file_path: join(project, "forbidden.txt") },
        },
        {
          id: "toolu_write",
          name: "Write",
          input: { file_path: join(root, "written"), content: "x" },
        },
        {
          id: "toolu_bash",
          name: "Bash",
          input: { command: `touch ${join(root, "ran")}` },
        },
      ],
    },
    { text: "Tools done" },
  ]);
  setEnv({ [apiKeyEnv]: key });
  const open = async (allowedTools: string[]) =>
    ClaudeBackend.open(
      claudeBackendSchema.parse({
        type: "claude",
        directory: project,
        model: "claude-sonnet-5-5",
        provider: { baseURL, apiKeyEnv },
        allowedTools,
      }),
      { dataDirectory: data },
    );
  // A path scope would not bind the CLI: Read inside the working directory
  // is always allowed. Pogo accepts bare tool names only.
  await expect(open(["Read(./allowed/**)"])).rejects.toThrow();
  const backend = await open(["Read"]);
  cleanup.push(() => backend.close());
  const signal = AbortSignal.timeout(60_000);
  const id = await backend.createSession({ key: "k", title: "T", signal });
  expect(await backend.prompt(id, "Use tools", signal)).toBe("Tools done");
  const results = new Map(
    (requests.at(-1)?.results ?? []).map((result) => [result.id, result]),
  );
  // The allowed tool name runs without a scope; others never run.
  expect(results.get("toolu_read")?.error).toBe(false);
  expect(results.get("toolu_read")?.text).toContain("POGOFORBIDDEN");
  expect(results.get("toolu_write")?.error).toBe(true);
  expect(results.get("toolu_bash")?.error).toBe(true);
  expect(await readdir(root)).not.toContain("written");
  expect(await readdir(root)).not.toContain("ran");
}, 120_000);

test("no Bash process of the real CLI outlives its turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "pogo-claude-cli-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const data = join(root, "data");
  await mkdir(project);
  await mkdir(data);
  const record = join(root, "pid");
  const background = join(root, "background");
  // Claude Code runs Bash in its own session. The first command leaves a
  // SIGTERM-ignoring process behind after its own call has finished; the
  // second is a background task that keeps the CLI alive after its result.
  const { baseURL } = fixture([
    {
      tools: [
        {
          id: "toolu_bash",
          name: "Bash",
          input: {
            command: `(trap "" TERM; sh -c 'echo $PPID' > ${record}; exec sleep 600) > /dev/null 2>&1 &\necho started`,
            description: "Leave a process behind",
          },
        },
        {
          id: "toolu_background",
          name: "Bash",
          input: {
            command: `trap "" TERM; echo $$ > ${background}; while true; do sleep 1; done`,
            description: "Keep running",
            run_in_background: true,
          },
        },
      ],
    },
    { text: "Left one behind" },
  ]);
  setEnv({ [apiKeyEnv]: key });
  const backend = await ClaudeBackend.open(
    claudeBackendSchema.parse({
      type: "claude",
      directory: project,
      model: "claude-sonnet-5-5",
      provider: { baseURL, apiKeyEnv },
      allowedTools: ["Bash"],
    }),
    { dataDirectory: data },
    { graceMs: 500 },
  );
  cleanup.push(() => backend.close());
  const signal = AbortSignal.timeout(60_000);
  const id = await backend.createSession({ key: "k", title: "T", signal });
  expect(await backend.prompt(id, "Run it", signal)).toBe("Left one behind");
  const pids = await Promise.all(
    [record, background].map(async (path) =>
      Number((await readFile(path, "utf8")).trim()),
    ),
  );
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  cleanup.push(async () => {
    for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  for (const pid of pids) expect(pid).toBeGreaterThan(1);
  // A killed process can stay a zombie for a moment until it is reaped.
  const deadline = Date.now() + 3000;
  while (pids.some(alive) && Date.now() < deadline) await Bun.sleep(25);
  expect(pids.filter(alive)).toEqual([]);
}, 120_000);
