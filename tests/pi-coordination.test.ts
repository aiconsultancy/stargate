import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { Schema } from "effect";
import { PiDurableBackend } from "../src/backends/pi/pi-durable";
import { piDurableBackendSchema } from "../src/config";
import { piCrewExtension } from "../src/coordination/crew/pi/pi-extension";
import { CrewError } from "../src/coordination/crew/execution/state";
import { zodStringRecord } from "./fixtures/zod-string-record";

const decodeMessages = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
);

function completion(
  text: string,
  tool = false,
  name = "pi_history",
  args = '{"limit":20}',
) {
  const chunk = (delta: object, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "opencode-go/deepseek-v4.1-flash", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;

  return new Response(
    chunk({ role: "assistant" }) +
      chunk(
        tool
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "history-call",
                  type: "function",
                  function: { name, arguments: args },
                },
              ],
            }
          : { content: text },
      ) +
      chunk({}, tool ? "tool_calls" : "stop") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("Pi preserves required default fields and native argument coercion", () => {
  const extension = piCrewExtension(
    { authorize() {}, async run() {} },
    async () => ({}),
  );

  for (const name of ["pi_history", "stargate_journal", "stargate_quota"]) {
    const tool = extension.tools?.find((tool) => tool.name === name);

    if (!tool) throw new Error(`Missing registered tool: ${name}`);

    if (name !== "stargate_journal")
      expect(tool.parameters).toHaveProperty("type", "object");
    expect(tool.replay).toBe("unsafe");

    const input =
      name === "stargate_journal"
        ? { op: "read", after: 0, limit: "2", member: null }
        : name === "pi_history"
          ? { limit: "2", cursor: null }
          : {};

    const parsed = validateToolArguments(tool, {
      type: "toolCall",
      id: "fixture-call",
      name,
      arguments: input,
    });

    expect(parsed).toEqual(
      name === "stargate_journal"
        ? { op: "read", after: 0, limit: 2, member: "null" }
        : name === "pi_history"
          ? { limit: 2 }
          : {},
    );

    if (name !== "stargate_quota")
      for (const arguments_ of name === "pi_history"
        ? [{}, { cursor: {} }]
        : [{ op: "read" }, { op: "read", after: 0 }, { op: "read", limit: 20 }])
        expect(() => {
          validateToolArguments(tool, {
            type: "toolCall",
            id: "fixture-omission",
            name,
            arguments: arguments_,
          });
        }).toThrow("Validation failed for tool");

    if (name === "pi_history") {
      const arguments_ = {
        limit: 20,
        cursor: { nested: [1, "2", null, { done: false }] },
      };

      expect(
        validateToolArguments(tool, {
          type: "toolCall",
          id: "fixture-cursor",
          name,
          arguments: arguments_,
        }),
      ).toEqual(arguments_);
      expect(
        validateToolArguments(tool, {
          type: "toolCall",
          id: "fixture-integer-coercion",
          name,
          arguments: { limit: 1.5 },
        }),
      ).toEqual({ limit: 1 });

      for (const arguments_ of [
        { limit: 0 },
        { limit: 51 },
        { limit: 20, cursor: [] },
      ])
        expect(() => {
          validateToolArguments(tool, {
            type: "toolCall",
            id: "fixture-history-bound",
            name,
            arguments: arguments_,
          });
        }).toThrow("Validation failed for tool");
    }

    if (name === "stargate_journal") {
      for (const text of ["  note  ", "  ", "😀".repeat(64_000)]) {
        const arguments_ = { op: "append", text };
        expect(
          validateToolArguments(tool, {
            type: "toolCall",
            id: "fixture-raw-text",
            name,
            arguments: arguments_,
          }),
        ).toEqual(arguments_);
      }

      for (const arguments_ of [
        { op: "read", after: Number.MAX_SAFE_INTEGER + 1, limit: 20 },
        { op: "read", after: 0, limit: 101 },
        { op: "append", text: "note", after: 0 },
        { op: "append", text: `${"😀".repeat(64_000)}x` },
      ])
        expect(() => {
          validateToolArguments(tool, {
            type: "toolCall",
            id: "fixture-journal-bound",
            name,
            arguments: arguments_,
          });
        }).toThrow("Validation failed for tool");
    }
  }
});

test("real Pi crew extension reads only native self history and deduplicates DM admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-pi-coordination-"));
  const apiKeyEnv = "STARGATE_COORDINATION_TEST_KEY";
  const previous = process.env[apiKeyEnv];
  process.env[apiKeyEnv] = "fixture-only";
  const requests: Record<string, unknown>[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests.push(await request.json());

      return completion("Fixture answer", requests.length === 1);
    },
  });

  let backend: PiDurableBackend | undefined;
  let saved = "";
  let authorized = 0;
  const signal = new AbortController().signal;

  try {
    const config = Schema.decodeUnknownSync(piDurableBackendSchema)({
      type: "pi-durable",
      model: "openai/opencode-go/deepseek-v4.1-flash",
      directory,
      tools: "coding",
      provider: { baseURL: new URL("/v1", server.url).href, apiKeyEnv },
      systemPrompt:
        "Shared working agreement: /captain/WAYS_OF_WORKING.md. Read initially; reread when updated.",
    });

    backend = await PiDurableBackend.open(config, {
      dataDirectory: directory,
      crew: {
        authorize(id) {
          expect(id).toBe(saved);
          authorized++;
        },
        async run() {
          throw new Error(
            "History must use the existing native conversation, not another crew API",
          );
        },
      },
    });
    saved = await backend.createSession({
      key: "member",
      title: "Member",
      signal,
    });
    await backend.createSession({ key: "foreign", title: "Foreign", signal });
    expect(await backend.prompt(saved, "Read own history", signal)).toBe(
      "Fixture answer",
    );
    expect(authorized).toBe(1);
    expect(JSON.stringify(requests[0]?.["tools"])).toContain(
      "stargate_journal",
    );
    expect(JSON.stringify(requests[0]?.["tools"])).toContain("stargate_quota");
    expect(JSON.stringify(requests[1]?.["messages"])).toContain(
      "Read own history",
    );

    const toolMessages = decodeMessages(requests[1]?.["messages"]);

    const output = toolMessages.find(({ role }) => role === "tool")?.content;

    if (typeof output !== "string")
      throw new Error("Missing native history result");

    const page = Schema.decodeUnknownSync(
      Schema.Struct({
        items: Schema.Array(Schema.Struct({ conversationId: Schema.Finite })),
        next: Schema.Unknown,
      }),
    )(JSON.parse(output));

    expect(page.items.length).toBeGreaterThan(0);
    expect(
      page.items.every(
        ({ conversationId }) => conversationId === Number(saved),
      ),
    ).toBe(true);
    expect(page.next).toBeDefined();
    await backend.notify(
      saved,
      "a".repeat(32),
      "Peer question",
      "steer",
      signal,
    );
    await backend.notify(
      saved,
      "a".repeat(32),
      "Peer question",
      "steer",
      signal,
    );
    await backend.waitForIdle(saved, AbortSignal.timeout(2000));
    expect(requests).toHaveLength(3);
    await backend.promptReport(saved, "Only sanitized journal facts", signal);
    expect(requests[3]?.["tools"] ?? []).toEqual([]);
    expect(authorized).toBe(1);
  } finally {
    await backend?.close();
    await server.stop(true);

    if (previous === undefined) delete process.env[apiKeyEnv];
    else process.env[apiKeyEnv] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

for (const tools of ["coding", "none"] as const) {
  test(`Pi ${tools} request hook sends changed-file advice once; reports stay excluded`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "stargate-pi-agreement-"));
    const path = join(directory, "WAYS_OF_WORKING.md");
    const apiKeyEnv = `STARGATE_AGREEMENT_${tools.toUpperCase()}_TEST_KEY`;
    const previous = process.env[apiKeyEnv];
    process.env[apiKeyEnv] = "fixture-only";
    const requests: Record<string, unknown>[] = [];

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        requests.push(await request.json());

        return completion("Fixture answer");
      },
    });

    let backend: PiDurableBackend | undefined;
    let saved = "";
    const signal = new AbortController().signal;

    const notices = () =>
      JSON.stringify(requests.at(-1)?.["messages"]).match(
        /Shared working agreement changed:/g,
      )?.length ?? 0;

    try {
      await writeFile(path, "PRIVATE AGREEMENT ONE");
      backend = await PiDurableBackend.open(
        Schema.decodeUnknownSync(piDurableBackendSchema)({
          type: "pi-durable",
          model: "openai/opencode-go/deepseek-v4.1-flash",
          directory,
          tools,
          provider: { baseURL: new URL("/v1", server.url).href, apiKeyEnv },
          systemPrompt: `Shared working agreement: ${path}. Read initially and reread when updated.`,
        }),
        {
          dataDirectory: directory,
          workingAgreement: { path, owns: (id) => id === saved },
        },
      );
      saved = await backend.createSession({
        key: "member",
        title: "Member",
        signal,
      });
      await backend.prompt(saved, "Initial request", signal);
      expect(notices()).toBe(0);
      await backend.prompt(saved, "Next request", signal);
      expect(notices()).toBe(0);
      await writeFile(path, "PRIVATE AGREEMENT TWO");

      const foreign = await backend.createSession({
        key: "foreign",
        title: "Foreign",
        signal,
      });

      await backend.prompt(foreign, "Foreign request", signal);
      expect(notices()).toBe(0);
      await backend.prompt(saved, "Request after update", signal);
      expect(notices()).toBe(1);
      expect(JSON.stringify(requests.at(-1)?.["messages"])).toContain(path);
      await backend.prompt(saved, "Next normal request", signal);
      expect(notices()).toBe(0);
      await writeFile(path, "PRIVATE AGREEMENT THREE");
      await backend.promptReport(saved, "Sanitized facts only", signal);
      expect(notices()).toBe(0);
      expect(requests.at(-1)?.["tools"] ?? []).toEqual([]);
      await backend.prompt(saved, "Resume normal request", signal);
      expect(notices()).toBe(1);
      expect(JSON.stringify(requests)).not.toContain("PRIVATE AGREEMENT");

      if (tools === "none")
        expect(
          requests.every(
            (request) =>
              !request["tools"] ||
              (Array.isArray(request["tools"]) &&
                request["tools"].length === 0),
          ),
        ).toBe(true);
    } finally {
      await backend?.close();
      await server.stop(true);

      if (previous === undefined) delete process.env[apiKeyEnv];
      else process.env[apiKeyEnv] = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  {
    title: "remaining quota binding executes its strict Zod input",
    name: "stargate_quota",
    args: {},
    input: {},
    result: { status: "not-configured", accounts: [] },
    error: null,
  },
  {
    title: "crew status uses its own native decoder rather than journal",
    name: "stargate_crew",
    args: { op: "status", taskID: "task_fixture" },
    input: { op: "status", taskID: "task_fixture" },
    result: { status: "running" },
    error: null,
  },
  {
    title: "crew wait keeps its native required numeric coercion",
    name: "stargate_crew",
    args: { op: "wait", taskID: "task_fixture", afterNoticeID: "2" },
    input: { op: "wait", taskID: "task_fixture", afterNoticeID: 2 },
    result: { status: "running" },
    error: null,
  },
  {
    title: "crew dispatch omission fails Pi before handler defaults",
    name: "stargate_crew",
    args: { op: "dispatch", crew: "worker", text: "fixture" },
    input: null,
    result: { status: "queued" },
    error: "Validation failed for tool",
  },
  {
    title: "journal read retains explicit native default fields",
    name: "stargate_journal",
    args: { op: "read", after: 0, limit: 20 },
    input: { op: "read", after: 0, limit: 20 },
    result: { entries: [], nextAfter: 0 },
    error: null,
  },
  {
    title: "journal append trims before the crew handler",
    name: "stargate_journal",
    args: { op: "append", text: "  milestone \n" },
    input: { op: "append", text: "milestone" },
    result: { entries: [], nextAfter: 1 },
    error: null,
  },
  {
    title: "journal wrong-branch arguments fail before crew execution",
    name: "stargate_journal",
    args: { op: "read", after: 0, limit: 20, text: "wrong branch" },
    input: null,
    result: { entries: [], nextAfter: 0 },
    error: "Validation failed for tool",
  },
  {
    title:
      "journal whitespace fails authoritative decode with a sanitized error",
    name: "stargate_journal",
    args: { op: "append", text: "  " },
    input: null,
    result: { entries: [], nextAfter: 0 },
    error:
      "Crew operation unavailable or unconfirmed; do not replay uncertain work.",
  },
  {
    title: "journal unknown keys fail before crew execution",
    name: "stargate_journal",
    args: { op: "read", after: 0, limit: 20, unexpected: true },
    input: null,
    result: { entries: [], nextAfter: 0 },
    error: "Validation failed for tool",
  },
  {
    title: "authorization precedes journal decoding",
    name: "stargate_journal",
    args: { op: "append", text: "  " },
    input: null,
    denied: true,
    result: { entries: [], nextAfter: 0 },
    error: "Saved member conversation required.",
  },
  {
    title: "journal page over 16 KB remains valid JSON",
    name: "stargate_journal",
    args: { op: "read", after: 0, limit: 20 },
    result: {
      entries: Array.from({ length: 20 }, () => ({ text: "x".repeat(1500) })),
      nextAfter: 31,
    },
    error: null,
  },
  {
    title: "oversized journal returns a fixed error, not partial JSON",
    name: "stargate_journal",
    args: { op: "read", after: 0, limit: 40 },
    result: {
      entries: Array.from({ length: 40 }, () => ({ text: "x".repeat(1500) })),
      nextAfter: 999,
    },
    error: "result too large, retry with a smaller limit",
  },
  {
    title: "oversized inbox returns a fixed error, not partial JSON",
    name: "stargate_mail",
    args: { op: "inbox", limit: 20 },
    result: { messages: [{ text: "x".repeat(64_000) }], nextAfter: 999 },
    error: "result too large, retry with a smaller limit",
  },
  {
    title: "mail uses its own decoder and native inbox coercion",
    name: "stargate_mail",
    args: { op: "inbox", limit: "2", after: true },
    input: { op: "inbox", limit: 2, after: 1 },
    result: { messages: [], nextAfter: 1 },
    error: null,
  },
  {
    title: "DM uses its own decoder and trims after native validation",
    name: "stargate_dm",
    args: { op: "send", to: "captain", text: " note ", delivery: "steer" },
    input: { op: "send", to: "captain", text: "note", delivery: "steer" },
    result: { status: "sent", stored: true, notification: "accepted" },
    error: null,
  },
  {
    title: "mail send does not fall through to journal append decoding",
    name: "stargate_mail",
    args: { op: "send", to: "captain", text: " note " },
    input: { op: "send", to: "captain", text: "note" },
    result: { status: "sent", stored: true },
    error: null,
  },
  {
    title: "safe crew errors remain actionable",
    name: "stargate_mail",
    args: { op: "inbox", limit: 20 },
    result: null,
    error: "Owned task context is required.",
  },
]) {
  test(`real Pi binding: ${scenario.title}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "stargate-pi-output-"));
    const apiKeyEnv = "STARGATE_OUTPUT_TEST_KEY";
    const previous = process.env[apiKeyEnv];
    process.env[apiKeyEnv] = "fixture-only";
    const requests: Record<string, unknown>[] = [];

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        requests.push(await request.json());

        return completion(
          "Finished",
          requests.length === 1,
          scenario.name,
          JSON.stringify(scenario.args),
        );
      },
    });

    let backend: PiDurableBackend | undefined;
    const inputs: unknown[] = [];

    try {
      backend = await PiDurableBackend.open(
        Schema.decodeUnknownSync(piDurableBackendSchema)({
          type: "pi-durable",
          model: "openai/opencode-go/deepseek-v4.1-flash",
          directory,
          tools: "coding",
          provider: { baseURL: new URL("/v1", server.url).href, apiKeyEnv },
        }),
        {
          dataDirectory: directory,
          crew: {
            authorize() {
              if ("denied" in scenario && scenario.denied)
                throw new CrewError("Saved member conversation required.");
            },
            async run(_name, input) {
              inputs.push(input);

              if (scenario.result === null)
                throw new CrewError(scenario.error ?? "");

              return scenario.result;
            },
          },
        },
      );
      const signal = new AbortController().signal;

      const saved = await backend.createSession({
        key: "member",
        title: "Member",
        signal,
      });

      await backend.prompt(saved, "Read a page", signal);

      const messages = decodeMessages(requests[1]?.["messages"]);

      const output = messages.find(({ role }) => role === "tool")?.content;

      if (typeof output !== "string") throw new Error("Missing tool result");

      if (scenario.error) {
        expect(output).toContain(scenario.error);
        expect(output).not.toContain("nextAfter");
        expect(output).not.toContain('"entries"');
        expect(output).not.toContain('"messages"');
        expect(output).not.toContain("private wrong-branch value");
      } else if (
        [
          "stargate_quota",
          "stargate_crew",
          "stargate_mail",
          "stargate_dm",
        ].includes(scenario.name)
      )
        expect(JSON.parse(output)).toEqual(scenario.result);
      else
        expect(JSON.parse(output)).toMatchObject({
          nextAfter: scenario.result?.nextAfter,
          entries: scenario.result?.entries,
        });

      if ("input" in scenario)
        expect(inputs).toEqual(scenario.input === null ? [] : [scenario.input]);
    } finally {
      await backend?.close();
      await server.stop(true);

      if (previous === undefined) delete process.env[apiKeyEnv];
      else process.env[apiKeyEnv] = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("native Pi history bounds visible text and retains the raw page cursor", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "stargate-pi-visible-history-"),
  );

  const apiKeyEnv = "STARGATE_VISIBLE_HISTORY_TEST_KEY";
  const previous = process.env[apiKeyEnv];
  process.env[apiKeyEnv] = "fixture-only";
  const requests: Record<string, unknown>[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests.push(await request.json());

      return requests.length === 1
        ? completion(`Visible prior token=fixture-secret ${"x".repeat(60_000)}`)
        : completion(
            "Finished",
            requests.length === 2,
            "pi_history",
            '{"limit":"4","cursor":null}',
          );
    },
  });

  let backend: PiDurableBackend | undefined;

  try {
    backend = await PiDurableBackend.open(
      Schema.decodeUnknownSync(piDurableBackendSchema)({
        type: "pi-durable",
        model: "openai/opencode-go/deepseek-v4.1-flash",
        directory,
        tools: "coding",
        provider: { baseURL: new URL("/v1", server.url).href, apiKeyEnv },
      }),
      {
        dataDirectory: directory,
        crew: {
          authorize() {},
          async run() {
            throw new Error("Native history only");
          },
        },
      },
    );
    const signal = new AbortController().signal;

    const saved = await backend.createSession({
      key: "member",
      title: "Member",
      signal,
    });

    await backend.prompt(saved, "First turn", signal);
    await backend.prompt(saved, "Read history", signal);

    const messages = decodeMessages(requests[2]?.["messages"]);

    const output = messages.find(({ role }) => role === "tool")?.content;

    if (typeof output !== "string") throw new Error("Missing history output");

    const page = Schema.decodeUnknownSync(
      Schema.Struct({
        next: zodStringRecord(Schema.Unknown),
        items: Schema.Array(
          Schema.Struct({
            role: Schema.Literals(["user", "assistant"]),
            // Zod counted string bounds in code points.
            text: Schema.String.check(Schema.isMaxCodePoints(1500)),
          }),
        ),
      }),
    )(JSON.parse(output));

    expect(page.items.some(({ text }) => text.includes("Visible prior"))).toBe(
      true,
    );
    expect(output).not.toContain("fixture-secret");
    expect(output).not.toContain("toolsAdded");
    expect(output).not.toContain("pi.system");
    expect(page.next).toBeDefined();
  } finally {
    await backend?.close();
    await server.stop(true);

    if (previous === undefined) delete process.env[apiKeyEnv];
    else process.env[apiKeyEnv] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
