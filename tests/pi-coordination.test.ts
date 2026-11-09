import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { PiDurableBackend } from "../src/backends/pi-durable";
import { piDurableBackendSchema } from "../src/config";
import { CrewError } from "../src/crew/state";

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

test("real Pi crew extension reads only native self history and deduplicates DM admission", async () => {
  const directory = await mkdtemp("/tmp/opencode/pogo-pi-coordination-");
  const apiKeyEnv = "POGO_COORDINATION_TEST_KEY";
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
    const config = piDurableBackendSchema.parse({
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
    expect(JSON.stringify(requests[0]?.["tools"])).toContain("pogo_journal");
    expect(JSON.stringify(requests[0]?.["tools"])).toContain("pogo_quota");
    expect(JSON.stringify(requests[1]?.["messages"])).toContain(
      "Read own history",
    );
    const toolMessages = z
      .array(z.object({ role: z.string(), content: z.unknown() }))
      .parse(requests[1]?.["messages"]);
    const output = toolMessages.find(({ role }) => role === "tool")?.content;
    if (typeof output !== "string")
      throw new Error("Missing native history result");
    const page = z
      .object({
        items: z.array(z.object({ conversationId: z.number() })),
        next: z.unknown(),
      })
      .parse(JSON.parse(output));
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
    const directory = await mkdtemp("/tmp/opencode/pogo-pi-agreement-");
    const path = join(directory, "WAYS_OF_WORKING.md");
    const apiKeyEnv = `POGO_AGREEMENT_${tools.toUpperCase()}_TEST_KEY`;
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
        piDurableBackendSchema.parse({
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
    title: "journal page over 16 KB remains valid JSON",
    name: "pogo_journal",
    args: { op: "read", after: 0, limit: 20 },
    result: {
      entries: Array.from({ length: 20 }, () => ({ text: "x".repeat(1500) })),
      nextAfter: 31,
    },
    error: null,
  },
  {
    title: "oversized journal returns a fixed error, not partial JSON",
    name: "pogo_journal",
    args: { op: "read", after: 0, limit: 40 },
    result: {
      entries: Array.from({ length: 40 }, () => ({ text: "x".repeat(1500) })),
      nextAfter: 999,
    },
    error: "result too large, retry with a smaller limit",
  },
  {
    title: "oversized inbox returns a fixed error, not partial JSON",
    name: "pogo_mail",
    args: { op: "inbox", limit: 20 },
    result: { messages: [{ text: "x".repeat(64000) }], nextAfter: 999 },
    error: "result too large, retry with a smaller limit",
  },
  {
    title: "safe crew errors remain actionable",
    name: "pogo_mail",
    args: { op: "inbox", limit: 20 },
    result: null,
    error: "Owned task context is required.",
  },
]) {
  test(`real Pi binding: ${scenario.title}`, async () => {
    const directory = await mkdtemp("/tmp/opencode/pogo-pi-output-");
    const apiKeyEnv = "POGO_OUTPUT_TEST_KEY";
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
    try {
      backend = await PiDurableBackend.open(
        piDurableBackendSchema.parse({
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
      const messages = z
        .array(z.object({ role: z.string(), content: z.unknown() }))
        .parse(requests[1]?.["messages"]);
      const output = messages.find(({ role }) => role === "tool")?.content;
      if (typeof output !== "string") throw new Error("Missing tool result");
      if (scenario.error) {
        expect(output).toContain(scenario.error);
        expect(output).not.toContain("nextAfter");
        expect(output).not.toContain('"entries"');
        expect(output).not.toContain('"messages"');
      } else
        expect(JSON.parse(output)).toMatchObject({
          nextAfter: 31,
          entries: scenario.result?.entries,
        });
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
  const directory = await mkdtemp("/tmp/opencode/pogo-pi-visible-history-");
  const apiKeyEnv = "POGO_VISIBLE_HISTORY_TEST_KEY";
  const previous = process.env[apiKeyEnv];
  process.env[apiKeyEnv] = "fixture-only";
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests.push(await request.json());
      return requests.length === 1
        ? completion(`Visible prior token=fixture-secret ${"x".repeat(60000)}`)
        : completion(
            "Finished",
            requests.length === 2,
            "pi_history",
            '{"limit":4}',
          );
    },
  });
  let backend: PiDurableBackend | undefined;
  try {
    backend = await PiDurableBackend.open(
      piDurableBackendSchema.parse({
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
    const messages = z
      .array(z.object({ role: z.string(), content: z.unknown() }))
      .parse(requests[2]?.["messages"]);
    const output = messages.find(({ role }) => role === "tool")?.content;
    if (typeof output !== "string") throw new Error("Missing history output");
    const page = z
      .object({
        next: z.record(z.string(), z.unknown()),
        items: z.array(
          z.object({
            role: z.enum(["user", "assistant"]),
            text: z.string().max(1500),
          }),
        ),
      })
      .parse(JSON.parse(output));
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
