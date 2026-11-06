import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  ConversationId,
  ConversationView,
  EntryId,
  EntryRecord,
  Observer,
} from "@earendil-works/pi-durable";
import { OpenCodeBackend } from "../src/backends/opencode";
import { PiDurableBackend, piPartialText } from "../src/backends/pi-durable";
import { backendSchema } from "../src/config";

test("OpenCode V2 creates, queues, waits and reads paginated replies", async () => {
  const requests: { path: string; body: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const body = await request.text();
      requests.push({
        path: url.pathname,
        body: body ? JSON.parse(body) : null,
      });
      if (url.pathname === "/api/session")
        return Response.json({ data: { id: "session-1" } });
      if (url.pathname.endsWith("/prompt"))
        return Response.json({ data: { id: "input-1" } });
      if (url.pathname.endsWith("/wait"))
        return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/message")) {
        if (url.searchParams.has("cursor"))
          return Response.json({
            data: [
              { id: "input-1", type: "user" },
              {
                id: "old",
                type: "assistant",
                content: [{ type: "text", text: "DO NOT REPEAT" }],
              },
            ],
            cursor: {},
          });
        return Response.json({
          data: [
            {
              id: "answer-2",
              type: "assistant",
              content: [{ type: "text", text: "second" }],
            },
            {
              id: "answer-1",
              type: "assistant",
              content: [
                { type: "reasoning", text: "PRIVATE" },
                { type: "text", text: "first" },
              ],
            },
          ],
          cursor: { next: "page2" },
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  try {
    const config = backendSchema.parse({
      type: "opencode",
      url: server.url.href,
      directory: "/workspace",
    });
    if (config.type !== "opencode") throw new Error("Invalid fixture");
    const backend = new OpenCodeBackend(config);
    const signal = new AbortController().signal;
    const session = await backend.createSession({
      key: "thread",
      title: "Slack",
      signal,
    });
    expect(session).toBe("session-1");
    expect(await backend.prompt(session, "hello", signal)).toBe(
      "first\n\nsecond",
    );
    expect(requests[0]?.body).toMatchObject({
      location: { directory: "/workspace" },
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
    });
    expect(requests[1]?.body).toMatchObject({
      text: "hello",
      delivery: "queue",
    });
  } finally {
    await server.stop(true);
  }
});

test("OpenCode failure explicitly interrupts server-side execution", async () => {
  let interrupted = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (new URL(request.url).pathname.endsWith("/interrupt")) {
        interrupted = true;
        return Response.json({ success: true });
      }
      return Response.json({ message: "unavailable" }, { status: 503 });
    },
  });
  try {
    const config = backendSchema.parse({
      type: "opencode",
      url: server.url.href,
      directory: "/workspace",
    });
    if (config.type !== "opencode") throw new Error("Invalid fixture");
    await expect(
      new OpenCodeBackend(config).prompt(
        "session",
        "hello",
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(interrupted).toBe(true);
  } finally {
    await server.stop(true);
  }
});

function openCodeStreamFixture() {
  const waiting = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const interrupted = Promise.withResolvers<void>();
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let sequence = 0;
  let historyReads = 0;
  const encoder = new TextEncoder();
  const emit = (type: string, data: Record<string, unknown>) => {
    if (!stream) throw new Error("Fixture SSE connection is not open");
    stream.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({
          id: `event-${++sequence}`,
          created: sequence,
          type,
          location: { directory: "/workspace" },
          data,
        })}\n\n`,
      ),
    );
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/event") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              emit("server.connected", {});
            },
            cancel() {
              stream = undefined;
              disconnected.resolve();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (path.endsWith("/prompt")) {
        if (!stream) throw new Error("Prompt preceded event connection");
        return Response.json({ data: { id: "input-current" } });
      }
      if (path.endsWith("/wait")) {
        waiting.resolve();
        await finish.promise;
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/message")) {
        historyReads++;
        return Response.json({
          data: [
            {
              id: "answer-current",
              type: "assistant",
              content: [
                { type: "reasoning", text: "HISTORY REASONING SECRET" },
                { type: "tool", text: "HISTORY TOOL SECRET" },
                { type: "text", text: "Canonical final answer." },
              ],
            },
            { id: "input-current", type: "user" },
            {
              id: "old-answer",
              type: "assistant",
              content: [{ type: "text", text: "DO NOT REPEAT" }],
            },
          ],
          cursor: {},
        });
      }
      if (path.endsWith("/interrupt")) {
        interrupted.resolve();
        return Response.json({ success: true });
      }
      return new Response(null, { status: 404 });
    },
  });
  const config = backendSchema.parse({
    type: "opencode",
    url: server.url.href,
    directory: "/workspace",
  });
  if (config.type !== "opencode") throw new Error("Invalid fixture");
  return {
    backend: new OpenCodeBackend(config),
    waiting: waiting.promise,
    disconnected: disconnected.promise,
    interrupted: interrupted.promise,
    finish: () => finish.resolve(),
    historyReads: () => historyReads,
    emit,
    disconnect() {
      stream?.close();
      stream = undefined;
    },
    async close() {
      finish.resolve();
      await server.stop(true);
    },
  };
}

test("OpenCode streams only current-session visible text before canonical history completes", async () => {
  const fixture = openCodeStreamFixture();
  const received = Promise.withResolvers<void>();
  const snapshots: string[] = [];
  const controller = new AbortController();
  const result = fixture.backend.prompt(
    "session-current",
    "Review this PR",
    controller.signal,
    (text) => {
      snapshots.push(text);
      if (text === "First block.\nCorrected second block.") received.resolve();
    },
  );
  try {
    await fixture.waiting;
    const current = {
      sessionID: "session-current",
      assistantMessageID: "answer-current",
    };
    fixture.emit("session.text.delta", {
      ...current,
      sessionID: "session-other",
      ordinal: 0,
      delta: "OTHER SESSION SECRET",
    });
    fixture.emit("session.reasoning.delta", {
      ...current,
      ordinal: 0,
      delta: "REASONING SECRET",
    });
    fixture.emit("session.tool.input.delta", {
      ...current,
      id: "tool-secret",
      delta: "TOOL SECRET",
    });
    fixture.emit("session.text.delta", {
      ...current,
      ordinal: 2,
      delta: "Second ",
    });
    fixture.emit("session.text.delta", {
      ...current,
      ordinal: 2,
      delta: "block.",
    });
    fixture.emit("session.text.delta", {
      ...current,
      ordinal: 0,
      delta: "First block.",
    });
    fixture.emit("session.text.ended", {
      ...current,
      ordinal: 2,
      text: "Corrected second block.",
    });
    await received.promise;
    expect(snapshots).toEqual([
      "Second ",
      "Second block.",
      "First block.\nSecond block.",
      "First block.\nCorrected second block.",
    ]);
    expect(fixture.historyReads()).toBe(0);
    fixture.finish();
    expect(await result).toBe("Canonical final answer.");
    expect(fixture.historyReads()).toBe(1);
    await fixture.disconnected;
  } finally {
    controller.abort();
    await result.catch(() => {});
    await fixture.close();
  }
});

test("OpenCode event disconnect retains authoritative final history", async () => {
  const fixture = openCodeStreamFixture();
  const received = Promise.withResolvers<void>();
  const controller = new AbortController();
  const snapshots: string[] = [];
  const result = fixture.backend.prompt(
    "session-current",
    "hello",
    controller.signal,
    (text) => {
      snapshots.push(text);
      received.resolve();
    },
  );
  try {
    await fixture.waiting;
    fixture.emit("session.text.delta", {
      sessionID: "session-current",
      assistantMessageID: "answer-current",
      ordinal: 0,
      delta: "Incomplete draft",
    });
    await received.promise;
    fixture.disconnect();
    fixture.finish();
    expect(await result).toBe("Canonical final answer.");
    expect(snapshots).toEqual(["Incomplete draft"]);
  } finally {
    controller.abort();
    await result.catch(() => {});
    await fixture.close();
  }
});

test("OpenCode cancellation closes the event subscription and interrupts execution", async () => {
  const fixture = openCodeStreamFixture();
  const controller = new AbortController();
  const result = fixture.backend.prompt(
    "session-current",
    "hello",
    controller.signal,
    () => {},
  );
  try {
    await fixture.waiting;
    controller.abort();
    await expect(result).rejects.toThrow();
    await fixture.interrupted;
    await fixture.disconnected;
    expect(fixture.historyReads()).toBe(0);
  } finally {
    controller.abort();
    await result.catch(() => {});
    await fixture.close();
  }
});

test("Pi partial text excludes thinking and tools and tolerates missing or malformed live state", () => {
  const view = (docs: ConversationView["docs"]): ConversationView => ({
    conversation: { id: 1 as ConversationId },
    entries: [],
    docs,
  });
  expect(piPartialText(view({}))).toBe("");
  expect(piPartialText(view({ "pi.live": {} }))).toBe("");
  expect(
    piPartialText(
      view({ "pi.live": { generation: { message: { content: "bad" } } } }),
    ),
  ).toBe("");
  expect(
    piPartialText(
      view({
        "pi.live": {
          generation: {
            message: {
              content: [
                { type: "thinking", text: "THINKING SECRET" },
                { type: "text", text: "Visible " },
                {
                  type: "toolCall",
                  text: "TOOL SECRET",
                  arguments: { token: "secret" },
                },
                { type: "text", text: "answer" },
              ],
            },
          },
        },
      }),
    ),
  ).toBe("Visible answer");
});

test("Pi ignores historical observer advances before attachment resolves", async () => {
  const id = 1 as ConversationId;
  const assistant = (entryId: number, text: string): EntryRecord => ({
    id: entryId as EntryId,
    conversationId: id,
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "openai-responses",
        provider: "openai",
        model: "local-test",
        stopReason: "stop",
        timestamp: 0,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    ],
  });
  const historical = assistant(10, "OLD HISTORY");
  const beforeResolution = assistant(11, "PRE-RESOLUTION HISTORY");
  const current = assistant(13, "NEW ANSWER");
  const view = (entries: readonly EntryRecord[]): ConversationView => ({
    conversation: { id },
    entries,
    docs: {},
  });
  let observer: Observer<ConversationView> | undefined;
  let detached = false;
  const advance = (value: ConversationView) => {
    if (!observer) throw new Error("Observer not attached");
    observer.advance(
      { kind: "value", value, ops: [], retired: false },
      BACKGROUND_CONTEXT,
    );
  };
  const harness = {
    async observeConversation(
      _id: ConversationId,
      attached: Observer<ConversationView>,
    ) {
      observer = attached;
      // Durable permits publication before the attachment promise resolves.
      advance(view([historical, beforeResolution]));
      return {
        value: view([historical]),
        detach() {
          detached = true;
        },
      };
    },
    async conversation() {
      return {
        async submit() {
          advance(view([historical, beforeResolution, current]));
          return {
            async wait() {
              return { status: "done", type: "input", answer: current.id };
            },
          };
        },
        async commit() {
          return current;
        },
      };
    },
  };
  // Inject the harness without opening storage or contacting a provider.
  const backend: PiDurableBackend = Reflect.construct(PiDurableBackend, [
    harness,
    {},
  ]);
  const snapshots: string[] = [];
  expect(
    await backend.prompt("1", "hello", new AbortController().signal, (text) => {
      snapshots.push(text);
    }),
  ).toBe("NEW ANSWER");
  expect(snapshots).toEqual(["NEW ANSWER"]);
  expect(detached).toBe(true);
});

test("real Pi Durable harness persists sessions under Bun SQLite", async () => {
  const directory = await mkdtemp("/tmp/opencode/pogo-pi-");
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "local-test-not-sent";
  try {
    const config = backendSchema.parse({
      type: "pi-durable",
      directory,
      model: "openai/gpt-5",
    });
    if (config.type !== "pi-durable") throw new Error("Invalid fixture");
    const backend = await PiDurableBackend.open(config, {
      dataDirectory: directory,
    });
    let session: string;
    try {
      session = await backend.createSession({
        key: "thread",
        title: "Slack",
        signal: new AbortController().signal,
      });
      expect(session).toMatch(/^\d+$/);
    } finally {
      await backend.close();
    }
    const reopened = await PiDurableBackend.open(config, {
      dataDirectory: directory,
    });
    try {
      await reopened.interrupt(session, new AbortController().signal);
    } finally {
      await reopened.close();
    }
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
