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

test("OpenCode placed-input failure explicitly interrupts server-side execution", async () => {
  let interrupted = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/prompt"))
        return Response.json({ data: { id: "input-current" } });
      if (path.endsWith("/message"))
        return Response.json({
          data: [{ id: "input-current", type: "user" }],
          cursor: {},
        });
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

test("OpenCode uncertain admission does not interrupt unrelated native work", async () => {
  let interrupts = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (new URL(request.url).pathname.endsWith("/interrupt")) interrupts++;
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
    expect(interrupts).toBe(0);
  } finally {
    await server.stop(true);
  }
});

function openCodeStreamFixture(queued = false) {
  const waiting = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const interrupted = Promise.withResolvers<void>();
  const checked = Promise.withResolvers<void>();
  let placed = !queued;
  let interrupts = 0;
  let cancelled = false;
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
        checked.resolve();
        return Response.json({
          data: [
            ...(placed
              ? [
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
                ]
              : []),
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
        interrupts++;
        interrupted.resolve();
        return Response.json({ success: true });
      }
      if (
        path.endsWith("/inbox/input-current") &&
        request.method === "DELETE"
      ) {
        cancelled = true;
        return new Response(null, { status: 204 });
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
    checked: checked.promise,
    place: () => {
      placed = true;
    },
    interrupts: () => interrupts,
    cancelled: () => cancelled,
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
    // Ownership reads can coalesce deltas received during the history request.
    expect(snapshots.at(-1)).toBe("First block.\nCorrected second block.");
    expect(snapshots.join("\n")).not.toContain("SECRET");
    expect(fixture.historyReads()).toBe(1);
    fixture.finish();
    expect(await result).toBe("Canonical final answer.");
    expect(fixture.historyReads()).toBe(2);
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

test("OpenCode excludes prior same-session output while its input is queued", async () => {
  const fixture = openCodeStreamFixture(true);
  const received = Promise.withResolvers<void>();
  const snapshots: string[] = [];
  const controller = new AbortController();
  const pending = fixture.backend.prompt(
    "session-current",
    "Queued follow-up",
    controller.signal,
    (text) => {
      snapshots.push(text);
      if (text.includes("OWN ANSWER")) received.resolve();
    },
  );
  try {
    await fixture.waiting;
    fixture.emit("session.text.delta", {
      sessionID: "session-current",
      assistantMessageID: "old-answer",
      ordinal: 0,
      delta: "PRIOR TURN",
    });
    fixture.emit("session.text.ended", {
      sessionID: "session-current",
      assistantMessageID: "old-answer",
      ordinal: 0,
      text: "PRIOR TURN COMPLETED",
    });
    fixture.emit("session.execution.succeeded", {
      sessionID: "session-current",
    });
    await fixture.checked;
    fixture.place();
    fixture.emit("session.text.delta", {
      sessionID: "session-current",
      assistantMessageID: "answer-current",
      ordinal: 0,
      delta: "OWN ANSWER",
    });
    await received.promise;
    expect(snapshots).toEqual(["OWN ANSWER"]);
    fixture.finish();
    expect(await pending).toBe("Canonical final answer.");
  } finally {
    controller.abort();
    await pending.catch(() => {});
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
    expect(fixture.historyReads()).toBe(1);
  } finally {
    controller.abort();
    await result.catch(() => {});
    await fixture.close();
  }
});

test("OpenCode queued cancellation withdraws only its own input", async () => {
  const fixture = openCodeStreamFixture(true);
  const controller = new AbortController();
  const pending = fixture.backend.prompt(
    "session-current",
    "follow-up",
    controller.signal,
    () => {},
  );
  try {
    await fixture.waiting;
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(fixture.cancelled()).toBe(true);
    expect(fixture.interrupts()).toBe(0);
  } finally {
    controller.abort();
    await pending.catch(() => {});
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
            id: 1,
            async status() {
              return { status: "placed", type: "input", entry: 12 };
            },
            async wait() {
              return {
                status: "done",
                type: "input",
                entry: 12,
                answer: current.id,
              };
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

test.each(["done", "unanswered"])("Pi %s owns text", async (outcome) => {
  const id = 1 as ConversationId;
  const assistant = (number: number, text: string): EntryRecord => ({
    id: number as EntryId,
    conversationId: id,
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "openai-responses",
        provider: "openai",
        model: "fixture",
        stopReason: "stop",
        timestamp: 0,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
      },
    ],
  });
  const old = assistant(10, "BEFORE ATTACHMENT");
  const prior = assistant(11, "PRIOR TURN COMMITTED");
  const own = assistant(13, "OWN ANSWER");
  const next = assistant(15, "LATER NATIVE TURN");
  const terminal = {
    id: 1,
    conversationId: id,
    type: "input",
    entry: 12,
    ...(outcome === "done"
      ? { status: "done", answer: own.id }
      : { status: "unanswered", reason: "model_error" }),
  };
  const partial = Promise.withResolvers<void>();
  let completed = false;
  let observer: Observer<ConversationView> | undefined;
  const view = (
    entries: readonly EntryRecord[],
    input: number,
    text: string,
  ): ConversationView => ({
    conversation: { id },
    entries,
    docs: {
      "pi.live": {
        run: { inputs: [input] },
        generation: { message: { content: [{ type: "text", text }] } },
      },
    },
  });
  const advance = (value: ConversationView) =>
    observer?.advance(
      { kind: "value", value, ops: [], retired: false },
      BACKGROUND_CONTEXT,
    );
  const harness = {
    async observeConversation(
      _id: ConversationId,
      attached: Observer<ConversationView>,
    ) {
      observer = attached;
      return { value: view([old], 99, "PRIOR LIVE"), detach() {} };
    },
    async conversation() {
      return {
        async submit() {
          advance(view([old], 99, "PRIOR TURN LIVE"));
          advance(view([old, prior], 99, "PRIOR TURN COMPLETING"));
          return {
            id: 1,
            async status() {
              return completed
                ? terminal
                : { id: 1, type: "input", status: "placed", entry: 12 };
            },
            async abort() {
              return "settled";
            },
            async wait() {
              advance(view([old, prior], 99, "PRIOR TURN LAST DELTA"));
              advance(view([old, prior], 1, "OWN PARTIAL"));
              await partial.promise;
              completed = true;
              advance(
                view(
                  outcome === "done"
                    ? [old, prior, own, next]
                    : [old, prior, next],
                  2,
                  "NEXT LIVE",
                ),
              );
              return terminal;
            },
          };
        },
        async commit() {
          return own;
        },
      };
    },
  };
  const backend: PiDurableBackend = Reflect.construct(PiDurableBackend, [
    harness,
    {},
  ]);
  const snapshots: string[] = [];
  const pending = backend.prompt(
    "1",
    "follow-up",
    new AbortController().signal,
    (text) => {
      snapshots.push(text);
      if (text === "OWN PARTIAL") partial.resolve();
    },
  );
  if (outcome === "done") expect(await pending).toBe("OWN ANSWER");
  else {
    await expect(pending).rejects.toThrow("Pi input did not complete");
    expect(snapshots).toEqual(["OWN PARTIAL"]);
  }
  expect(snapshots.join("\n")).not.toMatch(/PRIOR|BEFORE|LATER|NEXT/);
});

test("real Pi Durable harness persists sessions under Bun SQLite", async () => {
  const directory = await mkdtemp("/tmp/opencode/pogo-pi-");
  const previous = process.env["OPENAI_API_KEY"];
  process.env["OPENAI_API_KEY"] = "local-test-not-sent";
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
    if (previous === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
