import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClaudeBackend } from "../src/backends/claude";
import { createActivityHub } from "../src/observability/dashboard/api/v1/activity";
import { BackendFailure } from "../src/shared/request-failure";
import type { TurnProgress } from "../src/shared/turn-progress";
import {
  alive,
  claudeBackendFixture,
  session,
  signal,
  until,
} from "./claude-backend-fixture";

const { open } = claudeBackendFixture();

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

test("a newer Claude task run rebinds and ignores an explicitly linked stale completion", async () => {
  const hub = createActivityHub();
  const { backend } = await open({}, undefined, {}, hub.recorder("officer"));
  let live: ReturnType<typeof hub.turns>;

  await backend.prompt(
    await session(backend),
    "late task run activity",
    signal(),
    (text) => {
      if (text === "Task observed") {
        live = hub.turns("officer");
      }
    },
  );

  const tool = live?.turns[0]?.items.find(
    (item) => item.kind === "tool" && item.callId === "tool_resumed",
  );

  expect(tool).toMatchObject({
    metadata: {
      task: {
        run_id: "002",
        description: "Current run updated",
        is_backgrounded: true,
      },
    },
  });
  expect(tool).not.toHaveProperty("metadata.task.status");
  expect(tool).not.toHaveProperty("metadata.task.summary");
  expect(
    live?.turns.findLast(
      (turn) => turn.session?.parent?.callId === "tool_resumed",
    ),
  ).toMatchObject({ status: "running" });
});

test("a resumed Claude run records a new child after its predecessor stopped", async () => {
  const hub = createActivityHub();
  const { backend } = await open({}, undefined, {}, hub.recorder("officer"));

  const children = () =>
    hub
      .turns("officer")
      ?.turns.filter((turn) => turn.session?.parent?.callId === "tool_resumed");

  let live: ReturnType<typeof children>;

  await backend.prompt(
    await session(backend),
    "resumed task run activity",
    signal(),
    (text) => {
      if (text === "Task observed") {
        live = children();
      }
    },
  );

  expect(live).toMatchObject([{ status: "cancelled" }, { status: "running" }]);
  expect(live?.[1]?.items.find((item) => item.kind === "text")).toMatchObject({
    text: "Resumed output",
  });
  expect(children()).toMatchObject([
    { id: live?.[0]?.id, status: "cancelled" },
    { id: live?.[1]?.id, status: "failed" },
  ]);
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

test("Claude activity records the reply decoder's fallback after an error drops completed text", async () => {
  const hub = createActivityHub();
  const recorded = await open({}, undefined, {}, hub.recorder("officer"));
  const plain = await open();
  const prompt = "reply dropped after error";

  const answer = await recorded.backend.prompt(
    await session(recorded.backend),
    prompt,
    signal(),
  );

  expect(answer).toBe("fallback after error");
  expect(
    await plain.backend.prompt(await session(plain.backend), prompt, signal()),
  ).toBe(answer);
  expect(hub.turns("officer")?.turns[0]).toMatchObject({
    status: "completed",
    items: expect.arrayContaining([
      expect.objectContaining({
        kind: "text",
        status: "completed",
        text: answer,
      }),
    ]),
  });
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

  const [reply, errors, normal] = hub.turns("officer")?.turns ?? [];
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
});

test.each([
  [
    "prefix",
    [
      ["completed", "hel"],
      ["completed", "hello"],
    ],
  ],
  ["identical", [["completed", "hello"]]],
  [
    "unfinished",
    [
      ["streaming", "hello"],
      ["completed", "hello"],
    ],
  ],
] as const)(
  "Claude records the %s preview and result without duplicating completed text",
  async (kind, expected) => {
    const hub = createActivityHub();
    const { backend } = await open({}, undefined, {}, hub.recorder("officer"));

    expect(
      await backend.prompt(
        await session(backend),
        `streamed partial reply ${kind}`,
        signal(),
      ),
    ).toBe("hello");
    expect(
      hub
        .turns("officer")
        ?.turns[0]?.items.flatMap((item) =>
          item.kind === "text" && "text" in item
            ? [[item.status, item.text]]
            : [],
        ),
    ).toEqual(expected.map(([status, text]) => [status, text]));
  },
);

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
