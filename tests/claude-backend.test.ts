import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
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
import { setTimeout as delay } from "node:timers/promises";
import { BUILTIN_TOOL_NAMES } from "@anthropic-ai/claude-agent-sdk";
import { Predicate, Result, Schema, SchemaTransformation } from "effect";
import type { TurnActivityRecorder } from "../src/backends/backend";
import { createBackend } from "../src/backends/factory";
import {
  ClaudeBackend,
  type ClaudeRuntime,
  claudeEnvironment,
  claudeInputContent,
} from "../src/backends/claude";
import { ClaudeTurn } from "../src/backends/claude/turn";
import { inheritedEnvironment } from "../src/backends/cli-agent";
import {
  backendSchema,
  claudeBackendSchema,
  claudeToolNames,
  ircSchema,
} from "../src/config";
import {
  AttachmentInputUnavailable,
  BackendFailure,
} from "../src/shared/request-failure";
import { backendFingerprint } from "../src/gateway/routing";
import { createActivityHub } from "../src/observability/dashboard/api/v1/activity";
import type { TurnProgress } from "../src/shared/turn-progress";
import { zodStringRecord } from "./fixtures/zod-string-record";

const apiKeyEnv = "STARGATE_CLAUDE_TEST_PROXY_KEY";
const key = "local-proxy-test-only";
const fixture = join(import.meta.dir, "claude-fixture.ts");

// Host secrets that must never reach the Claude Code child.
const hostSecrets = {
  ANTHROPIC_API_KEY: "native-key-must-not-be-sent",
  ANTHROPIC_AUTH_TOKEN: "native-token-must-not-be-sent",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:1/native",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-must-not-be-sent",
  CLAUDE_CONFIG_DIR: "/host/.claude",
  OPENAI_API_KEY: "openai-must-not-be-sent",
  CLIPROXYAPI_API_KEY: "proxy-key-only-by-reference",
  STARGATE_TEST_BOT_TOKEN: "xoxb-must-not-be-sent",
  HTTPS_PROXY: "http://127.0.0.1:2",
  NODE_OPTIONS: "--require /host/hook.js",
};

const saved = new Map<string, string | undefined>();
const cleanup: (() => Promise<unknown>)[] = [];

beforeEach(() => {
  for (const name of [apiKeyEnv, ...Object.keys(hostSecrets)]) {
    saved.set(name, process.env[name]);
  }

  Object.assign(process.env, hostSecrets, { [apiKeyEnv]: key });
});

afterEach(async () => {
  for (const [name, value] of saved) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

function config(extra: Record<string, unknown> = {}, directory = "/workspace") {
  return Schema.decodeUnknownSync(claudeBackendSchema)({
    type: "claude",
    directory,
    model: "claude-sonnet-5-5",
    provider: { baseURL: "http://127.0.0.1:8317/v1", apiKeyEnv },
    ...extra,
  });
}

// Loose objects accept instances with a valid `type` and keep enumerable
// String extras (including inherited ones), except __proto__.
const looseLogInput = Schema.Unknown.pipe(
  Schema.decodeTo(
    Schema.Unknown,
    SchemaTransformation.transform({
      decode: (input) => {
        if (!Predicate.isObject(input)) {
          return input;
        }

        const copy: Record<string, unknown> = { type: input["type"] };

        for (const key in input) {
          if (key !== "type" && key !== "__proto__") {
            copy[key] = input[key];
          }
        }

        return copy;
      },
      encode: (input) => input,
    }),
  ),
  Schema.decodeTo(
    Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
  ),
);

const decodeLogEntry = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Struct({
      pid: Schema.Finite,
      argv: Schema.Array(Schema.String),
      env: zodStringRecord(Schema.String),
      cwd: Schema.String,
    }),
    Schema.Struct({ input: looseLogInput }),
    Schema.Struct({ grandchild: Schema.Finite }),
  ]),
);

async function open(
  extra: Record<string, unknown> = {},
  version = "2.1.327 (Claude Code)",
  runtime: Pick<ClaudeRuntime, "versionTimeoutMs"> = {},
  activity?: TurnActivityRecorder,
) {
  const root = await mkdtemp(join(tmpdir(), "stargate-claude-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "claude");
  await writeFile(join(root, "fixture-version"), version);
  await writeFile(
    executable,
    `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`,
    { mode: 0o755 },
  );
  const dataDirectory = join(root, "data");
  await mkdir(dataDirectory);

  const backend = await ClaudeBackend.open(
    config(extra, root),
    { dataDirectory, ...(activity && { activity }) },
    { executable, graceMs: 200, ...runtime },
  );

  cleanup.push(() => backend.close());

  const log = async () =>
    (await readFile(join(dataDirectory, "claude", "fixture.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => decodeLogEntry(JSON.parse(line)));

  const runs = async () =>
    (await log()).flatMap((entry) => ("argv" in entry ? [entry] : []));

  return { root, dataDirectory, executable, backend, log, runs };
}

const signal = () => AbortSignal.timeout(20_000);

const session = (backend: ClaudeBackend) =>
  backend.createSession({ key: "k", title: "Stargate test", signal: signal() });

test("Claude activity replays SDK frames without changing reply or progress", async () => {
  const hub = createActivityHub();
  const recording = await open({}, undefined, {}, hub.recorder("officer"));
  const plain = await open();
  const requests = [{ channel: "#Bridge", msgid: "claude-request" }];

  const replay = async (backend: ClaudeBackend) => {
    const previews: string[] = [];
    const progress: Omit<TurnProgress, "observedAt">[] = [];

    const answer = await backend.prompt(
      await session(backend),
      "activity frames",
      signal(),
      (text) => {
        previews.push(text);
      },
      undefined,
      [],
      undefined,
      ({ observedAt: _, ...update }) => {
        progress.push(update);
      },
      undefined,
      () => requests,
    );

    return { answer, previews, progress };
  };

  const baseline = await replay(plain.backend);
  expect(baseline.answer).toBe("reply\n\t");
  expect(baseline.previews).toContain("reply\n\t");
  expect(baseline.progress.some(({ stage }) => stage === "reasoning")).toBe(
    true,
  );
  expect(await replay(recording.backend)).toEqual(baseline);

  const turns = hub.turns("officer")?.turns ?? [];
  const [root] = turns;

  const child = turns.find(
    (turn) => turn.session?.parent?.callId === "tool_child",
  );

  const background = turns.find(
    (turn) => turn.session?.parent?.callId === "tool_background",
  );

  const tokens = {
    input: 3,
    output: 7,
    reasoning: 0,
    cacheRead: 4,
    cacheWrite: 5,
  };

  expect(root).toMatchObject({
    status: "completed",
    requests,
    usage: { steps: 1, tokens, cost: 0.25 },
  });
  expect(root?.items).toMatchObject([
    {
      kind: "step",
      status: "completed",
      model: { id: "fixture" },
      firstTokenAt: expect.any(Number),
      finish: "tool_use",
      tokens,
      cost: null,
      unavailable: ["cost", "tokens.reasoning"],
    },
    { kind: "reasoning", status: "completed", text: "think\u0002" },
    { kind: "reasoning", status: "completed", text: "", unavailable: ["text"] },
    { kind: "text", status: "completed", text: "reply\n\t" },
    {
      kind: "tool",
      callId: "tool_ok",
      name: "Read",
      status: "completed",
      executed: true,
      rawInput: '{"key": "value"}',
      input: { key: "value" },
      content: [{ type: "text", text: "tool output\u0001" }],
      metadata: {
        elapsed_time_seconds: 1.5,
        tool_use_result: { text: "tool output\u0001" },
      },
    },
    {
      kind: "tool",
      callId: "tool_denied",
      status: "failed",
      executed: false,
      error: {
        type: "permission_denied",
        message: "Permission denied (fixture)",
      },
    },
    {
      kind: "tool",
      callId: "tool_child",
      metadata: {
        task: {
          description: "updated child",
          status: "completed",
          summary: "child finished",
          usage: { total_tokens: 5 },
        },
      },
    },
    {
      kind: "tool",
      callId: "tool_background",
      unavailable: ["after-turn"],
      metadata: { task: { task_type: "local_agent" } },
    },
    {
      kind: "tool",
      callId: "tool_server",
      name: "web_search",
      status: "running",
      rawInput: '{"query":"fixture"}',
      input: { query: "fixture" },
    },
  ]);
  expect(turns).toHaveLength(3);
  expect(child).toMatchObject({
    status: "completed",
    requests: [],
    session: { parent: { turnId: root?.id, callId: "tool_child" } },
    items: [
      { kind: "step" },
      { kind: "text", text: "child only" },
      { kind: "step", status: "completed", finish: "end_turn" },
      { kind: "reasoning", status: "completed", text: "child thought" },
      { kind: "text", status: "completed", text: "child partial" },
    ],
  });
  expect(background).toMatchObject({
    status: "cancelled",
    session: { parent: { turnId: root?.id, callId: "tool_background" } },
  });
  expect(JSON.stringify(turns)).not.toContain("unlinked");
  expect(JSON.stringify(turns)).not.toContain("provider-ciphertext");

  // Forcing partial frames must not alter the answer when there are no sinks.
  const answer = (backend: ClaudeBackend) =>
    session(backend).then((id) =>
      backend.prompt(id, "activity frames", signal()),
    );

  expect(await answer(recording.backend)).toBe(await answer(plain.backend));
  const [, forced] = await recording.runs();
  const [, unforced] = await plain.runs();
  expect(forced?.argv).toContain("--include-partial-messages");
  expect(unforced?.argv).not.toContain("--include-partial-messages");
});

test("a background Bash task stays on the spawning tool without making a child turn", async () => {
  const hub = createActivityHub();
  const { backend } = await open({}, undefined, {}, hub.recorder("officer"));
  await backend.prompt(
    await session(backend),
    "background bash activity",
    signal(),
  );
  const turns = hub.turns("officer")?.turns;
  expect(turns).toMatchObject([
    {
      items: [
        { kind: "step" },
        {
          kind: "tool",
          callId: "bash_call",
          status: "running",
          unavailable: ["after-turn"],
          metadata: {
            task: { task_type: "local_bash", is_backgrounded: true },
          },
        },
        // The reply came only as the result's text.
        { kind: "text", status: "completed", text: "bash observed" },
      ],
    },
  ]);
});

test("Claude appends a multi-block assistant envelope after a finalized prefix", async () => {
  const hub = createActivityHub();
  const { backend } = await open({}, undefined, {}, hub.recorder("officer"));
  await backend.prompt(
    await session(backend),
    "batched assistant activity",
    signal(),
  );
  expect(hub.turns("officer")?.turns[0]?.items).toMatchObject([
    { kind: "step" },
    { kind: "reasoning", text: "first" },
    { kind: "text", text: "second" },
    { kind: "tool", callId: "third_call" },
  ]);
});

test("Claude distinguishes a full envelope from a batch with matching block types", async () => {
  const hub = createActivityHub();
  const { backend } = await open({}, undefined, {}, hub.recorder("officer"));
  await backend.prompt(
    await session(backend),
    "repeated block types activity",
    signal(),
  );
  expect(hub.turns("officer")?.turns[0]?.items).toMatchObject([
    { kind: "step" },
    { kind: "text", text: "first" },
    { kind: "tool", callId: "call_a" },
    { kind: "text", text: "first" },
    { kind: "tool", callId: "call_b" },
  ]);
});

test("Claude appends a text-first batch when the finalized prefix has different text", async () => {
  const hub = createActivityHub();
  const { backend } = await open({}, undefined, {}, hub.recorder("officer"));
  await backend.prompt(
    await session(backend),
    "text prefix activity",
    signal(),
  );
  expect(hub.turns("officer")?.turns[0]?.items).toMatchObject([
    { kind: "step" },
    { kind: "text", text: "a" },
    { kind: "text", text: "b" },
    { kind: "tool", callId: "call_x" },
  ]);
});

test("subagent tool frames preserve failure ran evidence with and without Claude activity", async () => {
  const hub = createActivityHub();
  const plain = await open();
  const recording = await open({}, undefined, {}, hub.recorder("officer"));

  for (const { backend } of [plain, recording]) {
    try {
      await backend.prompt(
        await session(backend),
        "subagent fail:rate_limit:429",
        signal(),
      );
      throw new Error("Expected provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(BackendFailure);
      expect(error).toMatchObject({
        ran: true,
        failure: "provider:quota:429:ran",
      });
    }
  }

  const [root] = hub.turns("officer")?.turns ?? [];
  expect(root).toMatchObject({ status: "failed" });
  expect(root?.items).toContainEqual(
    expect.objectContaining({
      kind: "step",
      status: "failed",
      error: expect.objectContaining({ type: "rate_limit" }),
    }),
  );
});

// Pinned CLI 2.1.327 builds every stream_event with parent_tool_use_id null,
// And passes a subagent on only as complete assistant and user messages:
// Tool_use and tool_result always, text and thinking only when forwarded.
// A parented stream_event is therefore never common to both modes.
test("ran evidence on a failed turn is the same with and without Claude activity", async () => {
  const plain = await open();

  const recording = await open(
    {},
    undefined,
    {},
    createActivityHub().recorder("officer"),
  );

  const failure = async (backend: ClaudeBackend, prompt: string) => {
    try {
      await backend.prompt(await session(backend), prompt, signal());
    } catch (error) {
      expect(error).toBeInstanceOf(BackendFailure);

      return error;
    }

    throw new Error("Expected provider failure");
  };

  for (const [prompt, ran] of [
    // Common to both modes: a subagent's tool result is work.
    ["subagent result fail:rate_limit:429", true],
    // Forwarded subagent text and a parented stream_event are not.
    ["subagent text fail:rate_limit:429", false],
  ] as const) {
    const expected = await failure(plain.backend, prompt);
    expect(expected).toMatchObject({ ran });
    expect(await failure(recording.backend, prompt)).toEqual(expected);
  }
});

test("Claude result text and errors reach activity, without repeating a reply", async () => {
  const hub = createActivityHub();
  const { backend } = await open({}, undefined, {}, hub.recorder("officer"));

  expect(
    await backend.prompt(await session(backend), "result only reply", signal()),
  ).toBe("result-only reply");
  await expect(
    backend.prompt(await session(backend), "result errors", signal()),
  ).rejects.toThrow();
  expect(
    await backend.prompt(
      await session(backend),
      "batched assistant activity",
      signal(),
    ),
  ).toBe("second");

  expect(
    await backend.prompt(
      await session(backend),
      "streamed partial reply",
      signal(),
    ),
  ).toBe("hello");

  const [reply, errors, normal, partial] = hub.turns("officer")?.turns ?? [];
  expect(reply).toMatchObject({
    status: "completed",
    items: [{ kind: "text", status: "completed", text: "result-only reply" }],
  });
  expect(errors).toMatchObject({
    status: "failed",
    items: [
      {
        kind: "step",
        status: "failed",
        model: null,
        finish: "error_max_turns",
        error: {
          type: "error_max_turns",
          message: "first error\nsecond error\twith detail",
        },
      },
    ],
  });
  expect(
    normal?.items
      .filter((item) => item.kind === "text")
      .map((item) => ("text" in item ? item.text : undefined)),
  ).toEqual(["second"]);
  // A preview that no assistant message completed is not the reply.
  expect(partial?.items).toContainEqual(
    expect.objectContaining({
      kind: "text",
      status: "completed",
      text: "hello",
    }),
  );
});

test("a Claude success result marked as an error is an unredacted failed step", async () => {
  const hub = createActivityHub();
  const { backend } = await open({}, undefined, {}, hub.recorder("officer"));

  await expect(
    backend.prompt(await session(backend), "result marked error", signal()),
  ).rejects.toThrow();

  // The route is unredacted: the raw text is the error, never also a reply.
  expect(hub.turns("officer")?.turns).toMatchObject([
    {
      status: "failed",
      items: [
        {
          kind: "step",
          status: "failed",
          finish: "success",
          error: {
            type: "is_error",
            message:
              "API Error: 529 upstream said sk-ant-api03-fixture-credential",
            status: 529,
          },
        },
      ],
    },
  ]);
  expect(
    hub
      .turns("officer")
      ?.turns[0]?.items.filter((item) => item.kind === "text"),
  ).toEqual([]);
});

test("a recorder that throws cannot fail a Claude query", async () => {
  const { backend } = await open(
    {},
    undefined,
    {},
    {
      begin: () => ({
        update() {
          throw new Error("recorder update failed");
        },
        reconnected() {},
        end() {
          throw new Error("recorder end failed");
        },
      }),
    },
  );

  expect(
    await backend.prompt(await session(backend), "activity frames", signal()),
  ).toBe("reply\n\t");
});

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
    if (Date.now() > deadline) {
      throw new Error("Condition not reached");
    }

    await delay(25);
  }
}

test("Claude turn streams visible text and returns this turn's answer", async () => {
  const { backend, runs, log } = await open();
  const id = await session(backend);
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  const previews: string[] = [];
  const inputs: string[] = [];

  const answer = await backend.prompt(
    id,
    "Say hello",
    signal(),
    (text) => previews.push(text),
    (input) => inputs.push(input),
  );

  expect(answer).toBe("Hello world\n\nDone.");
  expect(previews).toContain("Hello");
  expect(previews.at(-1)).toBe("Hello world\n\nDone.");

  for (const text of previews) {
    expect(text).not.toContain("private");
    expect(text).not.toContain("subagent");
    expect(text).not.toContain("/secret");
  }

  const [run] = await runs();
  expect(run?.argv).toContain(`--session-id=${id}`);
  expect(run?.argv).toContain("--model=claude-sonnet-5-5");
  expect(run?.argv).toContain("--include-partial-messages");
  expect(run?.argv.some((argument) => argument.startsWith("--resume"))).toBe(
    false,
  );

  const user = (await log()).find(
    (entry) => "input" in entry && entry.input.type === "user",
  );

  expect(user && "input" in user ? user.input["uuid"] : undefined).toBe(
    inputs[0],
  );
  // Chat text is data: no @file expansion or slash-command dispatch.
  expect(user && "input" in user ? user.input["client_composed"] : 0).toBe(
    true,
  );
});

test("Claude resumes its own transcript and never another namespace's", async () => {
  const first = await open();
  const id = await session(first.backend);
  await first.backend.prompt(id, "one", signal());
  expect(await first.backend.prompt(id, "two", signal())).toBe(
    "Hello world\n\nDone.",
  );
  // A restarted adapter resumes the same native session from disk.
  await first.backend.close();

  const reopened = await ClaudeBackend.open(
    config({}, first.root),
    { dataDirectory: first.dataDirectory },
    { executable: first.executable },
  );

  cleanup.push(() => reopened.close());
  await reopened.prompt(id, "after restart", signal());
  const [created, resumed, restarted] = await first.runs();
  expect(created?.argv).toContain(`--session-id=${id}`);
  expect(resumed?.argv).toContain(`--resume=${id}`);
  expect(restarted?.argv).toContain(`--resume=${id}`);
  expect(resumed?.argv.some((arg) => arg.startsWith("--session-id"))).toBe(
    false,
  );
  // Another namespace has its own CLAUDE_CONFIG_DIR: the ID is not resumed.
  const second = await open();
  await second.backend.prompt(id, "three", signal());
  const [other] = await second.runs();
  expect(other?.argv).toContain(`--session-id=${id}`);
  expect(other?.env["CLAUDE_CONFIG_DIR"]).toBe(
    join(second.dataDirectory, "claude"),
  );
  expect(other?.env["CLAUDE_CONFIG_DIR"]).not.toBe(
    created?.env["CLAUDE_CONFIG_DIR"],
  );

  // Backend settings select the namespace, as for other backends.
  const fingerprint = (backend: unknown) =>
    backendFingerprint({
      backend: Schema.decodeUnknownSync(backendSchema)(backend),
    });

  expect(fingerprint(config())).not.toBe(
    fingerprint(config({ allowedTools: ["Read"] })),
  );
  expect(fingerprint(config())).not.toBe(
    fingerprint(config({ model: "claude-opus-5-5" })),
  );
  await expect(
    reopened.prompt("../ses_not_a_claude_id", "x", signal()),
  ).rejects.toThrow("Claude session ID is not valid");
});

test("Claude preserves supported UUID session IDs at the process boundary", async () => {
  const { backend, runs } = await open();

  const ids = [
    "12345678-1234-1234-8234-123456789abc",
    "12345678-1234-2234-9234-123456789abc",
    "12345678-1234-3234-a234-123456789abc",
    "12345678-1234-4234-b234-123456789abc",
    "12345678-1234-5234-8234-123456789abc",
    "12345678-1234-6234-8234-123456789abc",
    "12345678-1234-7234-8234-123456789abc",
    "12345678-1234-8234-8234-123456789abc",
    "ABCDEFAB-CDEF-4ABC-ABCD-ABCDEFABCDEF",
    "00000000-0000-0000-0000-000000000000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
  ];

  for (const id of ids) {
    expect(await backend.prompt(id, "hi", signal())).toBe(
      "Hello world\n\nDone.",
    );
  }

  expect(
    (await runs()).map((run) =>
      run.argv.find((argument) => argument.startsWith("--session-id=")),
    ),
  ).toEqual(ids.map((id) => `--session-id=${id}`));
});

test("Claude rejects unsupported UUID forms without launching the CLI", async () => {
  const { backend, dataDirectory } = await open();

  for (const id of [
    "",
    "../session",
    "12345678-1234-0234-8234-123456789abc",
    "12345678-1234-9234-8234-123456789abc",
    "12345678-1234-4234-7234-123456789abc",
    "12345678-1234-4234-c234-123456789abc",
    "12345678123442348234123456789abc",
    "12345678-1234-4234-8234-123456789abc\n",
    " 12345678-1234-4234-8234-123456789abc",
    "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
    "Ffffffff-ffff-ffff-ffff-ffffffffffff",
  ]) {
    await expect(backend.prompt(id, "hi", signal())).rejects.toThrow(
      "Claude session ID is not valid",
    );
    await expect(backend.interrupt(id, signal())).resolves.toBeUndefined();
  }

  expect(await readdir(join(dataDirectory, "claude"))).not.toContain(
    "fixture.jsonl",
  );
});

test("Claude child receives only a minimal, explicit environment", async () => {
  const { backend, runs, dataDirectory } = await open();
  await backend.prompt(await session(backend), "hi", signal());
  const [run] = await runs();
  const env = run?.env ?? {};

  for (const name of Object.keys(hostSecrets)) {
    if (name !== "ANTHROPIC_AUTH_TOKEN" && name !== "ANTHROPIC_BASE_URL") {
      if (name !== "CLAUDE_CONFIG_DIR") {
        expect(env[name]).toBeUndefined();
      }
    }
  }

  expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe(key);
  expect(env["ANTHROPIC_BASE_URL"]).toBe("http://127.0.0.1:8317");
  expect(env["CLAUDE_CONFIG_DIR"]).toBe(join(dataDirectory, "claude"));
  expect(env[apiKeyEnv]).toBeUndefined();
  expect(env["STARGATE_CLAUDE_TURN"]).toMatch(/^[0-9a-f-]{36}$/);
  // Each turn gets a private temporary directory, removed after the turn.
  expect(env["TMPDIR"]).toStartWith(join(tmpdir(), "stargate-claude-"));
  await expect(readdir(env["TMPDIR"] ?? "")).rejects.toThrow();

  const allowed = new Set([
    ...inheritedEnvironment,
    ...Object.keys(claudeEnvironment(config(), "/private")),
    // Added by the SDK itself; none carries a credential.
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_AGENT_SDK_VERSION",
    "CLAUDE_CODE_SDK_READS_SESSION_STATE",
    // Set by the fixture's wrapper shell, not by Stargate.
    "PWD",
    // A random value per turn that finds the turn's processes.
    "STARGATE_CLAUDE_TURN",
  ]);

  expect(Object.keys(env).filter((name) => !allowed.has(name))).toEqual([]);
  expect(
    Object.keys(
      claudeEnvironment(config(), "/private", {
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
      "CLAUDE_CONFIG_DIR",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
      "NO_PROXY",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "DISABLE_AUTOUPDATER",
      "CLAUDE_AGENT_SDK_CLIENT_APP",
    ].sort(),
  );
  delete process.env[apiKeyEnv];
  await expect(ClaudeBackend.open(config(), { dataDirectory })).rejects.toThrow(
    `Missing environment variable: ${apiKeyEnv}`,
  );
});

test("Claude tools default to none; allowed names map to the SDK", async () => {
  const closed = await open();
  await closed.backend.prompt(await session(closed.backend), "hi", signal());
  const [none] = await closed.runs();
  expect(none?.argv).toContain("--tools=");
  expect(none?.argv).toContain("--permission-mode=dontAsk");
  expect(none?.argv).toContain("--permission-prompts=none");
  expect(none?.argv).toContain("--setting-sources=");
  expect(none?.argv).toContain("--strict-mcp-config");

  for (const argument of none?.argv ?? []) {
    expect(argument).not.toMatch(/allowedTools|^--mcp-config|bypass|dangerous/);
    // The key travels only in the environment, never in arguments.
    expect(argument).not.toContain(key);
  }

  // Loaded settings cannot run hooks or change the endpoint or model.
  const flags = JSON.parse(
    none?.argv[(none?.argv.indexOf("--settings") ?? -2) + 1] ?? "{}",
  );

  expect(flags).toEqual({
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-sonnet-5-5",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5-5",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-sonnet-5-5",
      CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-5-5",
      NO_PROXY: "*",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    },
    disableAllHooks: true,
  });

  const open_ = await open({
    allowedTools: ["Read", "Bash"],
    settingSources: ["project"],
  });

  await open_.backend.prompt(await session(open_.backend), "hi", signal());
  const [some] = await open_.runs();
  expect(some?.argv).toContain("--tools=Read,Bash");
  expect(some?.argv).toContain("--allowedTools=Read,Bash");
  expect(some?.argv.some((arg) => arg.includes("disallowedTools"))).toBe(false);
  expect(some?.argv).toContain("--setting-sources=project");
  expect(some?.argv).toContain("--permission-mode=dontAsk");
});

test.each(["2.1.327 (Claude Code)", "2.1.328 (Claude Code)"])(
  "Claude %s sends MCP secrets through initialize, not generated argv",
  async (version) => {
    const {
      backend: unused,
      root,
      dataDirectory,
      executable,
      runs,
      log,
    } = await open({}, version);

    await unused.close();

    // Trusted internal input exercises SDK fields that public config forbids.
    const stdio = {
      type: "stdio" as const,
      command: "/fixture/mcp",
      args: [],
      env: { MCP_KEY: "mcp-env-canary" },
    };

    const http = {
      type: "http" as const,
      url: "https://mcp.example/",
      headers: { Authorization: "mcp-header-canary" },
    };

    const backend = await ClaudeBackend.open(
      { ...config({}, root), mcpServers: { stdio, http } },
      { dataDirectory },
      { executable, graceMs: 200 },
    );

    cleanup.push(() => backend.close());
    expect(await backend.prompt(await session(backend), "hi", signal())).toBe(
      "Hello world\n\nDone.",
    );
    const [run] = await runs();
    expect(run?.argv).toContain("--await-initialize");
    expect(run?.argv.join(" ")).not.toMatch(
      /--mcp-config|mcp-env-canary|mcp-header-canary|MCP_KEY|Authorization/,
    );

    const initialize = (await log()).find(
      (entry) => "input" in entry && entry.input.type === "control_request",
    );

    expect(
      initialize && "input" in initialize
        ? initialize.input["request"]
        : undefined,
    ).toMatchObject({
      subtype: "initialize",
      mcpServers: {
        stdio: { ...stdio, alwaysLoad: true },
        http: { ...http, alwaysLoad: true },
      },
    });
  },
);

test("older Claude explicitly falls back to argv with a safe warning", async () => {
  const warning = spyOn(process, "emitWarning").mockImplementation(() => {});

  try {
    const { backend, runs, log } = await open(
      { mcpServers: { docs: { type: "http", url: "https://mcp.example/" } } },
      "2.1.326 (Claude Code)",
    );

    expect(await backend.prompt(await session(backend), "hi", signal())).toBe(
      "Hello world\n\nDone.",
    );
    const [run] = await runs();
    expect(run?.argv).toContain("--mcp-config");
    expect(run?.argv).not.toContain("--await-initialize");

    const initialize = (await log()).find(
      (entry) => "input" in entry && entry.input.type === "control_request",
    );

    expect(
      initialize && "input" in initialize
        ? initialize.input["request"]
        : undefined,
    ).not.toHaveProperty("mcpServers");
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]).toEqual([
      "Claude Code is older than the SDK bundled CLI; using MCP argv delivery. MCP environment and headers may be visible to other local users. Update Claude Code to use initialize delivery.",
      { code: "STARGATE_CLAUDE_MCP_ARGV_FALLBACK" },
    ]);
  } finally {
    warning.mockRestore();
  }
});

test.each([
  ["empty", ""],
  ["unrecognised", "private-version-error"],
  ["prerelease", "2.1.327-beta (Claude Code)"],
  ["nonzero exit", "fail"],
  ["oversized", "x".repeat(8192)],
])(
  "Claude version probe fails closed on %s without starting a turn",
  async (_label, version) => {
    const { backend, runs } = await open({}, version);
    await expect(
      backend.prompt(await session(backend), "hi", signal()),
    ).rejects.toMatchObject({
      message: "Cannot verify Claude Code version for MCP delivery",
    });
    expect(await runs().catch(() => [])).toEqual([]);
  },
);

test("a missing Claude executable fails closed before starting a turn", async () => {
  const { backend, executable, runs } = await open();
  await rm(executable);
  await expect(
    backend.prompt(await session(backend), "hi", signal()),
  ).rejects.toThrow("Cannot verify Claude Code version for MCP delivery");
  expect(await runs().catch(() => [])).toEqual([]);
});

test("Claude version probe timeout kills the process, even if SIGTERM is ignored", async () => {
  const { backend, root, runs } = await open({}, "hang", {
    versionTimeoutMs: 1500,
  });

  const turn = backend.prompt(await session(backend), "hi", signal());
  await expect(turn).rejects.toThrow(
    "Cannot verify Claude Code version for MCP delivery",
  );

  const probe = JSON.parse(
    await readFile(join(root, "fixture-probe.json"), "utf8"),
  );

  expect(alive(probe.pid)).toBe(false);
  expect(probe.argv).toEqual(["--version"]);
  expect(probe.env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
  expect(probe.env[apiKeyEnv]).toBeUndefined();
  expect(probe.env["CLAUDE_CONFIG_DIR"]).toBe(join(root, "data", "claude"));
  expect(await runs().catch(() => [])).toEqual([]);
});

test("cancelling a Claude version probe stops it before any SDK turn starts", async () => {
  const { backend, root, runs } = await open({}, "hang", {
    versionTimeoutMs: 2000,
  });

  const controller = new AbortController();
  const turn = backend.prompt(await session(backend), "hi", controller.signal);
  const path = join(root, "fixture-probe.json");
  await until(
    () =>
      readFile(path).then(
        () => true,
        () => false,
      ),
    1000,
  );
  const probe = JSON.parse(await readFile(path, "utf8"));
  controller.abort();
  await expect(turn).rejects.toThrow();
  await until(() => !alive(probe.pid), 1000);
  expect(await runs().catch(() => [])).toEqual([]);
});

test("cancelling a Claude turn stops the CLI and its tool processes", async () => {
  const hub = createActivityHub();

  const { backend, log, runs, dataDirectory } = await open(
    {},
    undefined,
    {},
    hub.recorder("officer"),
  );

  const id = await session(backend);
  const controller = new AbortController();
  const turn = backend.prompt(id, "hang", controller.signal, () => {});

  const grandchild = async () =>
    (await log().catch(() => [])).flatMap((entry) =>
      "grandchild" in entry ? [entry.grandchild] : [],
    )[0];

  await until(async () => (await grandchild()) !== undefined);
  const [run] = await runs();
  const record = join(dataDirectory, "claude-runs", `${id}.json`);
  expect(JSON.parse(await readFile(record, "utf8")).pid).toBe(run?.pid ?? -1);
  controller.abort();
  await expect(turn).rejects.toThrow();
  expect(hub.turns("officer")?.turns).toMatchObject([{ status: "cancelled" }]);
  const pids = [run?.pid ?? 0, (await grandchild()) ?? 0];
  await until(() => pids.every((pid) => !alive(pid)));
  await expect(readFile(record)).rejects.toThrow();
});

test("a Claude turn stopped without a result fails unless its caller cancelled it", async () => {
  const hub = createActivityHub();

  const { backend, log } = await open(
    {},
    undefined,
    {},
    hub.recorder("officer"),
  );

  const started = async (count: number) =>
    until(
      async () =>
        (await log().catch(() => [])).filter((entry) => "grandchild" in entry)
          .length >= count,
    );

  // A stop by the backend itself, as for a lost CLI, is a failure.
  // Only startup recovery calls interrupt(), never a user's Stop.
  const id = await session(backend);
  const stopped = backend.prompt(id, "hang", signal());
  await started(1);
  await backend.interrupt(id, signal());
  await expect(stopped).rejects.toThrow();

  // The caller's abort, as on a Slack or IRC Stop, is a cancellation.
  const controller = new AbortController();

  const cancelled = backend.prompt(
    await session(backend),
    "hang",
    controller.signal,
  );

  await started(2);
  controller.abort();
  await expect(cancelled).rejects.toThrow();

  expect(hub.turns("officer")?.turns).toMatchObject([
    { status: "failed" },
    { status: "cancelled" },
  ]);
});

test("no tool process outlives its Claude turn, even one ignoring SIGTERM", async () => {
  const { backend, log } = await open();

  const grandchildren = async () =>
    (await log().catch(() => [])).flatMap((entry) =>
      "grandchild" in entry ? [entry.grandchild] : [],
    );

  cleanup.push(async () => {
    for (const pid of await grandchildren()) {
      if (alive(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
  });
  const id = await session(backend);

  // In the CLI's group or in its own session (as Claude Code runs Bash),
  // After a normal exit, an early exit or cancellation.
  for (const placement of ["", "detached "]) {
    expect(await backend.prompt(id, `${placement}stubborn`, signal())).toBe(
      "Hello world\n\nDone.",
    );
    await expect(
      backend.prompt(id, `${placement}stubborn crash`, signal()),
    ).rejects.toThrow("Backend failure: crash");
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
  expect(pids.length).toBe(8);
  await until(() => pids.every((pid) => !alive(pid)), 3000);
});

test("a Claude turn keeps its result when the CLI does not exit", async () => {
  const { backend, runs } = await open();
  // Background work can keep the CLI alive after its result.
  expect(await backend.prompt(await session(backend), "linger", signal())).toBe(
    "Hello world\n\nDone.",
  );
  const [run] = await runs();
  await until(() => !alive(run?.pid ?? 0), 3000);
});

test("Claude failures carry fixed causes, never CLI or provider text", async () => {
  const { backend } = await open();
  const id = await session(backend);
  const previews: string[] = [];

  const failed = backend.prompt(id, "fail", signal(), (text) =>
    previews.push(text),
  );

  await expect(failed).rejects.toThrow("Backend failure: quota");
  await failed.catch((error: Error) =>
    expect(error.message).not.toContain("raw upstream"),
  );
  // Error frames never reach the live preview or the answer.
  expect(previews.join("\n")).not.toContain("raw upstream");
  const errored = new ClaudeTurn();
  errored.add({
    type: "assistant",
    parent_tool_use_id: null,
    error: "rate_limit",
    message: { id: "msg_e", content: [{ type: "text", text: "API Error: x" }] },
  });
  expect(errored.visible()).toBe("");
  expect(errored.answer()).toBe("");
  await expect(backend.prompt(id, "crash", signal())).rejects.toThrow(
    "Backend failure: crash",
  );
  const turn = new ClaudeTurn();
  turn.add({ type: "result", subtype: "mystery", is_error: true });
  expect(turn.result).toEqual({ ok: false, cause: "error" });
});

test("Claude frames preserve optional fields, safe indices and finite statuses", () => {
  for (const [index, accepted] of [
    [0, true],
    [Number.MAX_SAFE_INTEGER, true],
    [-1, false],
    [0.5, false],
    [Number.MAX_SAFE_INTEGER + 1, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [Number.NEGATIVE_INFINITY, false],
    ["0", false],
  ] as const) {
    const turn = new ClaudeTurn();

    const frame = (event: unknown) => ({
      type: "stream_event",
      parent_tool_use_id: null,
      event,
      extra: "ignored",
    });

    turn.add(frame({ type: "message_start", message: { id: "m", extra: 1 } }));
    expect(
      turn.add(
        frame({
          type: "content_block_start",
          index,
          content_block: { type: "text", extra: 1 },
        }),
      ),
    ).toBe(accepted);
    expect(
      turn.add(
        frame({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: "visible", extra: 1 },
        }),
      ),
    ).toBe(accepted);
    expect(turn.visible()).toBe(accepted ? "visible" : "");
  }

  for (const [status, accepted] of [
    [undefined, true],
    [null, true],
    [429.5, true],
    [Number.MAX_SAFE_INTEGER + 1, true],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [Number.NEGATIVE_INFINITY, false],
    ["429", false],
  ] as const) {
    const turn = new ClaudeTurn();
    turn.add({
      type: "result",
      subtype: "rate_limit",
      is_error: true,
      api_error_status: status,
      extra: "ignored",
    });
    expect(turn.result).toEqual(
      accepted
        ? {
            ok: false,
            cause: "rate_limit",
            ...(typeof status === "number" ? { status } : {}),
          }
        : undefined,
    );
  }

  for (const content of [
    [{ type: "text", text: "visible", extra: "ignored" }, { type: "text" }],
    [{ type: "text", text: null }],
    [{ text: "missing type" }],
  ]) {
    const turn = new ClaudeTurn();
    turn.add({
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "m", content },
      extra: 1,
    });
    expect(turn.answer()).toBe(content[0]?.text === "visible" ? "visible" : "");
  }
});

test("Claude work frames require a string parent or a tool-use block", () => {
  for (const [raw, worked] of [
    [{ parent_tool_use_id: "" }, true],
    [{ parent_tool_use_id: null }, false],
    [
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", secret: "hidden" }] },
      },
      true,
    ],
    [{ type: "assistant", message: { content: [{ type: "text" }] } }, false],
    [
      { type: "assistant", message: { content: [{ type: "tool_use" }, {}] } },
      false,
    ],
    [{ type: "assistant", message: { content: [] } }, false],
  ] as const) {
    const turn = new ClaudeTurn();
    turn.add(raw);
    expect(turn.worked).toBe(worked);
    expect(turn.answer()).toBe("");
  }

  const turn = new ClaudeTurn();
  turn.add({ type: "system", subtype: "init", session_id: "", extra: 1 });
  expect(turn.session).toBe("");
  turn.add({ type: "system", subtype: "init", session_id: null });
  expect(turn.session).toBe("");
});

test("Claude recovery accepts only strict UUID records with safe integer bounds", async () => {
  const { backend, dataDirectory } = await open();
  const id = await session(backend);
  const path = join(dataDirectory, "claude-runs", `${id}.json`);

  const record = {
    pid: Number.MAX_SAFE_INTEGER,
    turn: crypto.randomUUID(),
    since: Number.MAX_SAFE_INTEGER,
  };

  for (const [change, accepted] of [
    [{}, true],
    [{ pid: 1, since: 0 }, true],
    [{ turn: "ABCDEFAB-CDEF-4ABC-ABCD-ABCDEFABCDEF" }, true],
    [{ turn: "00000000-0000-0000-0000-000000000000" }, true],
    [{ turn: "ffffffff-ffff-ffff-ffff-ffffffffffff" }, true],
    [{ turn: "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF" }, false],
    [{ turn: "Ffffffff-ffff-ffff-ffff-ffffffffffff" }, false],
    [{ turn: "../unsafe" }, false],
    [{ pid: 0 }, false],
    [{ pid: 1.5 }, false],
    [{ pid: Number.MAX_SAFE_INTEGER + 1 }, false],
    [{ since: -1 }, false],
    [{ since: 0.5 }, false],
    [{ since: Number.MAX_SAFE_INTEGER + 1 }, false],
    [{ since: null }, false],
    [{ since: undefined }, false],
    [{ extra: true }, false],
  ] as const) {
    const text = JSON.stringify({ ...record, ...change });
    await writeFile(path, text);
    await backend.interrupt(id, signal());

    if (accepted) {
      await expect(readFile(path)).rejects.toThrow();
    } else {
      expect(await readFile(path, "utf8")).toBe(text);
    }
  }

  const overflow = `{"pid":1,"turn":"${record.turn}","since":1e400}`;
  await writeFile(path, overflow);
  await backend.interrupt(id, signal());
  expect(await readFile(path, "utf8")).toBe(overflow);
});

test.skipIf(process.platform !== "linux")(
  "interrupt stops what an earlier process's turn left, and nothing else",
  async () => {
    const { backend, dataDirectory } = await open();
    const id = await session(backend);

    const sleeper = async (
      argument: string,
      env: Record<string, string> = {},
    ) => {
      const child = spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 600000)", argument],
        { detached: true, stdio: "ignore", env: { ...process.env, ...env } },
      );

      const pid = child.pid ?? 0;
      cleanup.push(async () => {
        if (alive(pid)) {
          process.kill(pid, "SIGKILL");
        }
      });
      // Ready once the new program's arguments are visible.
      await until(async () =>
        (await readFile(`/proc/${pid}/cmdline`, "utf8")).includes(argument),
      );

      return pid;
    };

    const start = async (pid: number) => {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");

      return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    };

    const record = join(dataDirectory, "claude-runs", `${id}.json`);

    const write = (pid: number, turn: string, since: number) =>
      writeFile(record, JSON.stringify({ pid, turn, since }));

    const interrupt = async () => {
      await backend.interrupt(id, signal());
      await expect(readFile(record)).rejects.toThrow();
    };

    const turn = (marker = crypto.randomUUID()) => ({
      marker,
      env: { STARGATE_CLAUDE_TURN: marker },
    });

    // Neither the session ID nor the marker.
    const foreign = await sleeper("unrelated", turn().env);
    await write(foreign, crypto.randomUUID(), await start(foreign));
    await interrupt();
    // The session ID and start time match, but another turn's marker.
    const other = turn();
    const impostor = await sleeper(`--resume=${id}`, other.env);
    await write(impostor, crypto.randomUUID(), await start(impostor));
    await interrupt();
    // The session ID and marker match, but the PID started earlier than
    // The recorded CLI: a reused PID.
    const reused = turn();
    const older = await sleeper(`--resume=${id}`, reused.env);
    await write(older, reused.marker, (await start(older)) + 1);
    await interrupt();

    for (const pid of [foreign, impostor, older]) {
      expect(alive(pid)).toBe(true);
    }

    // The recorded CLI and a marked tool process outside its group.
    const real = turn();
    const leader = await sleeper(`--resume=${id}`, real.env);
    const tool = await sleeper("tool", real.env);
    await write(leader, real.marker, await start(leader));
    await interrupt();
    await until(() => !alive(leader) && !alive(tool));

    for (const pid of [foreign, impostor, older]) {
      expect(alive(pid)).toBe(true);
    }
  },
);

test("closing the Claude backend stops running turns", async () => {
  const { backend, runs } = await open();
  const turn = backend.prompt(await session(backend), "hang", signal());
  await until(async () => (await runs().catch(() => [])).length > 0);
  const [run] = await runs();
  await backend.close();
  await expect(turn).rejects.toThrow();
  await until(() => !alive(run?.pid ?? 0));
  await expect(session(backend)).rejects.toThrow("closing");
});

test("Claude attachments become content blocks or fail closed", () => {
  const file = (mime: string, data = "hello") => ({
    name: "file",
    mime,
    data: new TextEncoder().encode(data),
  });

  expect(claudeInputContent("text", [])).toBe("text");
  expect(
    claudeInputContent("look", [
      file("image/png"),
      file("application/pdf"),
      file("text/plain"),
    ]),
  ).toEqual([
    { type: "text", text: "look" },
    { type: "text", text: "Attachment: file" },
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
    },
    {
      type: "document",
      title: "file",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "aGVsbG8=",
      },
    },
    { type: "text", text: "Attachment: file\nhello" },
  ]);

  for (const bad of [
    file("application/zip"),
    file("text/plain", "\u0000"),
    { ...file("text/plain"), data: new Uint8Array([0xff]) },
  ]) {
    expect(() => claudeInputContent("x", [bad])).toThrow(
      AttachmentInputUnavailable,
    );
  }
});

test("Claude configuration is strict and fails closed", () => {
  const parse = (extra: Record<string, unknown>) =>
    Result.isSuccess(
      Schema.decodeUnknownResult(claudeBackendSchema)({
        type: "claude",
        directory: "/workspace",
        model: "claude-sonnet-5-5",
        provider: { baseURL: "http://127.0.0.1:8317/v1", apiKeyEnv },
        ...extra,
      }),
    );

  const defaults = config();
  expect(defaults.allowedTools).toEqual([]);
  expect(defaults.settingSources).toEqual([]);
  expect(defaults.maxTurns).toBe(50);
  expect(parse({})).toBe(true);
  expect(parse({ provider: undefined })).toBe(false);

  for (const provider of [
    { baseURL: "http://proxy.example/v1", apiKeyEnv },
    { baseURL: "https://user:pw@proxy.example/v1", apiKeyEnv },
    { baseURL: "http://127.0.0.1:8317", apiKeyEnv },
    { baseURL: "http://127.0.0.1:8317/v1", apiKeyEnv: "lower-case" },
    { baseURL: "http://127.0.0.1:8317/v1", apiKey: "sk-value" },
  ]) {
    expect(parse({ provider })).toBe(false);
  }

  expect(
    parse({ provider: { baseURL: "https://proxy.example/v1", apiKeyEnv } }),
  ).toBe(true);

  for (const extra of [
    { directory: "relative" },
    { model: "claude proxy" },
    { allowedTools: ["Unknown"] },
    { allowedTools: ["CronCreate"] },
    { allowedTools: ["Bash(git status,rm)"] },
    { allowedTools: ["Bash()"] },
    // Scopes are refused: the CLI does not enforce them in its directory.
    { allowedTools: ["Read(./allowed/**)"] },
    { allowedTools: ["Bash(git status:*)"] },
    { allowedTools: ["WebFetch(domain:x.dev)"] },
    { allowedTools: ["Read", "Read"] },
    { disallowedTools: ["Bash"] },
    { settingSources: ["user"] },
    { settingSources: ["project", "project"] },
    { permissionMode: "bypassPermissions" },
    { mcpServers: { linear: { type: "http", url: "http://mcp.example/" } } },
    {
      mcpServers: {
        linear: {
          type: "http",
          url: "https://mcp.example/",
          headers: { Authorization: "Bearer sk-value" },
        },
      },
    },
    {
      mcpServers: {
        linear: {
          type: "http",
          url: "https://mcp.example/",
          headersHelper: "/usr/local/bin/helper; echo nope",
        },
      },
    },
    { mcpServers: { helper: { type: "stdio", command: "relative" } } },
    { env: { ANTHROPIC_API_KEY: "x" } },
    { maxTurns: 0 },
  ]) {
    expect(parse(extra)).toBe(false);
  }

  expect(parse({ allowedTools: ["Read", "Bash", "WebFetch"] })).toBe(true);
  // Every Stargate tool name still exists in the pinned SDK.
  const builtin: readonly string[] = BUILTIN_TOOL_NAMES;
  expect(claudeToolNames.filter((name) => !builtin.includes(name))).toEqual([]);
  // IRC crew members accept the backend too.
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema)({
        id: "galactica-irc",
        server: { host: "127.0.0.1", port: 6667, tls: false },
        account: "galactica",
        passwordEnv: "IRC_CAPTAIN",
        channels: ["#ship-galactica"],
        crew: [
          {
            id: "chief",
            account: "galactica-chief",
            passwordEnv: "IRC_CHIEF",
            channels: ["#ship-galactica"],
            backend: config(),
          },
        ],
        backend: config(),
      }),
    ),
  ).toBe(true);
});

test("createBackend opens the Claude adapter on demand", async () => {
  const root = await mkdtemp(join(tmpdir(), "stargate-claude-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const backend = await createBackend(config(), { dataDirectory: root });
  cleanup.push(() => backend.close());
  expect(backend).toBeInstanceOf(ClaudeBackend);
  expect(backend.supportsAttachments).toBe(true);
});

test("Claude maps what the CLI reports to one shared failure category", async () => {
  const { backend } = await open();
  const id = await session(backend);

  const failure = (prompt: string) =>
    backend.prompt(id, prompt, signal()).then(
      () => undefined,
      (error: unknown) =>
        error instanceof BackendFailure ? error.failure : String(error),
    );

  // The SDK's cause, the provider's HTTP status, and whether a tool ran.
  const cases: [prompt: string, cause: string][] = [
    ["fail:rate_limit:429", "provider:quota:429:idle"],
    ["fail:billing_error:402", "provider:quota:402:idle"],
    ["fail:rate_limit", "provider:quota:0:idle"],
    ["fail:authentication_failed:401", "provider:auth:401:idle"],
    ["fail:account_on_hold:403", "provider:auth:403:idle"],
    ["fail:model_not_found:404", "provider:model:404:idle"],
    ["fail:server_error:504", "provider:timeout:504:idle"],
    ["fail:overloaded:529", "provider:provider:529:idle"],
    ["fail:server_error:500", "provider:provider:500:idle"],
    // The proxy's cooldown answer: the SDK names no cause, only the status.
    ["fail:unknown:429", "provider:quota:429:idle"],
    // A tool ran before the provider refused the next call.
    ["tool fail:rate_limit:429", "provider:quota:429:ran"],
    // No result: Stargate cannot know what the CLI did.
    ["crash", "provider:crash:0:ran"],
  ];

  for (const [prompt, cause] of cases) {
    expect([prompt, await failure(prompt)]).toEqual([prompt, cause]);
  }

  // Not a provider failure: the generic failure stays.
  expect(await failure("fail:error_max_turns")).toBe(
    "Error: Claude turn failed: error_max_turns",
  );
});

test("Claude request progress reports only the main turn's block type", () => {
  const turn = new ClaudeTurn();
  const stages: string[] = [];

  const frame = (event: unknown, parent_tool_use_id: string | null = null) =>
    turn.add({ type: "stream_event", parent_tool_use_id, event }, (s) =>
      stages.push(s),
    );

  frame({ type: "message_start", message: { id: "first" } });
  frame({
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "private" },
  });
  frame({
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", input: { secret: "private" } },
  });
  frame({
    type: "content_block_start",
    index: 2,
    content_block: { type: "text", text: "" },
  });
  frame(
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use" },
    },
    "child",
  );
  expect(stages).toEqual(["model", "reasoning", "tool", "reply"]);
});
