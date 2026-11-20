import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  ConversationId,
  ConversationView,
  EntryId,
  EntryRecord,
  Observer,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";
import { latestInput } from "../src/backend";
import { OpenCodeBackend } from "../src/backends/opencode";
import { PiDurableBackend, piPartialText } from "../src/backends/pi-durable";
import { backendSchema } from "../src/config";
import {
  PendingBackendQuestion,
  PromptNotSubmitted,
} from "../src/request-failure";
import type { TurnProgress, TurnStage } from "../src/turn-progress";

test("OpenCode V2 creates, queues, waits and reads paginated replies", async () => {
  const requests: { path: string; body: unknown }[] = [];
  let inputId = "";
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
      if (url.pathname.endsWith("/prompt")) {
        const input: { id: string } = JSON.parse(body);
        inputId = input.id;
        return Response.json({ data: { id: inputId } });
      }
      if (url.pathname.endsWith("/wait"))
        return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/message")) {
        if (url.searchParams.has("cursor"))
          return Response.json({
            data: [
              { id: inputId, type: "user" },
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
    const config = Schema.decodeUnknownSync(backendSchema)({
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
    const previousRequests = requests.length;
    await expect(
      backend.prompt(
        session,
        "Cancelled before admission",
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    await expect(
      backend.transcript(session, latestInput, signal),
    ).rejects.toMatchObject({ reason: "cursor" });
    expect(requests).toHaveLength(previousRequests);
  } finally {
    await server.stop(true);
  }
});

test("OpenCode sends only a compact Slack source line before the raw instruction", async () => {
  let inputId = "";
  let prompt: Record<string, unknown> = {};
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/prompt")) {
        prompt = await request.json();
        inputId = String(prompt["id"]);
        return Response.json({ data: { id: inputId } });
      }
      if (path.endsWith("/wait")) return new Response(null, { status: 204 });
      if (path.endsWith("/message"))
        return Response.json({
          data: [
            {
              id: "answer",
              type: "assistant",
              content: [{ type: "text", text: "Migration plan" }],
            },
            { id: inputId, type: "user" },
          ],
          cursor: {},
        });
      return new Response(null, { status: 404 });
    },
  });
  try {
    const config = Schema.decodeUnknownSync(backendSchema)({
      type: "opencode",
      url: server.url.href,
      directory: "/workspace",
    });
    if (config.type !== "opencode") throw new Error("Invalid fixture");
    const source = {
      channel: "C123",
      thread: "1.000",
      message: "3.000",
      user: "U123",
    };
    const raw = "Can we resume this?";
    expect(
      await new OpenCodeBackend(config).prompt(
        "session-1",
        raw,
        new AbortController().signal,
        undefined,
        undefined,
        [],
        { source },
      ),
    ).toBe("Migration plan");
    const text = String(prompt["text"]);
    expect(text).toBe(`s=slack;c=C123;t=1.000;m=3.000;u=U123\n\n${raw}`);
    expect(text).not.toContain("slackSource");
    expect(text).not.toContain("untrustedSlackThreadContext");
    expect(prompt["delivery"]).toBe("queue");
    expect(prompt["id"]).toBe(inputId);
    await new OpenCodeBackend(config).prompt(
      "session-1",
      raw,
      new AbortController().signal,
      undefined,
      undefined,
      [],
      { source: { ...source, user: "U123;t=foreign\ninjected" } },
    );
    expect(prompt["text"]).toBe(
      `s=slack;c=C123;t=1.000;m=3.000;u=U123%3Bt%3Dforeign%0Ainjected\n\n${raw}`,
    );
  } finally {
    await server.stop(true);
  }
});

test("OpenCode placed-input failure explicitly interrupts server-side execution", async () => {
  let interrupted = false;
  let admissions = 0;
  let inputId = "";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/prompt")) {
        admissions++;
        const input: { id: string } = await request.json();
        inputId = input.id;
        return Response.json({ data: { id: inputId } });
      }
      if (path.endsWith("/message"))
        return Response.json({
          data: [{ id: inputId, type: "user" }],
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
    const config = Schema.decodeUnknownSync(backendSchema)({
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
    expect(admissions).toBe(1);
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
    const config = Schema.decodeUnknownSync(backendSchema)({
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

for (const placement of ["queued", "placed", "unreadable"] as const) {
  for (const aborted of [false, true]) {
    test(`OpenCode recovers ${placement} admission after ${aborted ? "abort" : "lost response"}`, async () => {
      const controller = new AbortController();
      let input: string | undefined;
      let prompts = 0;
      const cancelled: string[] = [];
      let interrupts = 0;
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path.endsWith("/prompt")) {
            prompts++;
            const body: { id?: string } = await request.json();
            input = body.id;
            if (aborted) controller.abort();
            return Response.json(
              { message: "Lost admission response" },
              { status: 503 },
            );
          }
          if (request.method === "DELETE" && path.includes("/inbox/")) {
            cancelled.push(path.split("/").at(-1) ?? "");
            return new Response(null, { status: 204 });
          }
          if (path.endsWith("/message")) {
            if (placement === "unreadable")
              return new Response(null, { status: 503 });
            return Response.json({
              data:
                placement === "placed" && input
                  ? [{ id: input, type: "user" }]
                  : [],
              cursor: {},
            });
          }
          if (path.endsWith("/interrupt")) {
            interrupts++;
            return Response.json({ success: true });
          }
          return new Response(null, { status: 404 });
        },
      });
      try {
        const config = Schema.decodeUnknownSync(backendSchema)({
          type: "opencode",
          url: server.url.href,
          directory: "/workspace",
        });
        if (config.type !== "opencode") throw new Error("Invalid fixture");
        await expect(
          new OpenCodeBackend(config).prompt(
            "session",
            "Own input",
            controller.signal,
          ),
        ).rejects.toThrow();
        if (!input) throw new Error("Admission had no client input ID");
        expect(input).toMatch(/^msg_/);
        expect(prompts).toBe(1);
        expect(cancelled).toEqual([input]);
        expect(interrupts).toBe(placement === "placed" ? 1 : 0);
      } finally {
        await server.stop(true);
      }
    });
  }
}

test("OpenCode cancellation before admission makes no native requests", async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      requests++;
      return new Response(null, { status: 503 });
    },
  });
  try {
    const config = Schema.decodeUnknownSync(backendSchema)({
      type: "opencode",
      url: server.url.href,
      directory: "/workspace",
    });
    if (config.type !== "opencode") throw new Error("Invalid fixture");
    const controller = new AbortController();
    controller.abort();
    await expect(
      new OpenCodeBackend(config).prompt(
        "session",
        "Own input",
        controller.signal,
        () => {},
      ),
    ).rejects.toThrow();
    expect(requests).toBe(0);
  } finally {
    await server.stop(true);
  }
});

function openCodeStreamFixture(
  queued = false,
  deliverDuringCheck = false,
  crewWake?: {
    originInputID?: string;
    originCaptainID?: string;
    batched?: boolean;
  },
  headersEnv: Record<string, string> = {},
  pendingQuestion?: {
    active: boolean;
    running?: boolean;
    unrelated?: number;
    stale?: number;
    waitForList?: Promise<void>;
  },
) {
  const waiting = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const interrupted = Promise.withResolvers<void>();
  const checked = Promise.withResolvers<void>();
  const checkedAgain = Promise.withResolvers<void>();
  const formListing = Promise.withResolvers<void>();
  const reconnected = Promise.withResolvers<void>();
  let placed = !queued;
  let interrupts = 0;
  let cancelled = false;
  const withdrawals: string[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let sequence = 0;
  let historyReads = 0;
  let inboxReads = 0;
  let inputId = "";
  let admissions = 0;
  let eventConnections = 0;
  const form = {
    id: "form_earlier",
    sessionID: "session-current",
    state: { status: "pending" },
    metadata: {
      kind: "question",
      tool: { messageID: "old-answer", id: "call_earlier" },
    },
  };
  const forms = pendingQuestion
    ? [
        ...Array.from({ length: pendingQuestion.unrelated ?? 0 }, (_, i) => ({
          ...form,
          id: `form_unrelated_${i}`,
          metadata: {},
        })),
        ...Array.from({ length: pendingQuestion.stale ?? 0 }, (_, i) => ({
          ...form,
          id: `form_stale_${i}`,
          metadata: {
            kind: "question",
            tool: { messageID: "settled-answer", id: "call_earlier" },
          },
        })),
        form,
      ]
    : [];
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
      if (path.endsWith("/form")) {
        formListing.resolve();
        await pendingQuestion?.waitForList;
        return Response.json({ data: forms });
      }
      const detail = forms.find(({ id }) => path.endsWith(`/form/${id}`));
      if (detail) return Response.json({ data: detail });
      if (path.endsWith("/message/settled-answer"))
        return Response.json({
          data: {
            id: "settled-answer",
            type: "assistant",
            time: { created: 1, completed: 2 },
            content: [],
          },
        });
      if (path === "/api/session/active")
        return Response.json({
          data: pendingQuestion?.active ? { "session-current": true } : {},
        });
      if (
        path.endsWith("/message/old-answer") &&
        pendingQuestion &&
        pendingQuestion.running !== false
      )
        return Response.json({
          data: {
            id: "old-answer",
            type: "assistant",
            time: { created: 1 },
            content: [
              {
                type: "tool",
                id: "call_earlier",
                name: "question",
                time: { created: 1 },
                state: { status: "running" },
              },
            ],
          },
        });
      if (path === "/api/event") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              emit("server.connected", {});
              if (++eventConnections > 1) reconnected.resolve();
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
        admissions++;
        const input: { id: string } = await request.json();
        inputId = input.id;
        return Response.json({ data: { id: inputId } });
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
            ...(crewWake
              ? [
                  {
                    id: "answer-wake",
                    type: "assistant",
                    content: [{ type: "text", text: "PRIVATE TASK A" }],
                  },
                  {
                    id: "wake-a",
                    type: "synthetic",
                    metadata: {
                      pogoCrew: {
                        originCaptainID: "session-current",
                        messageID: "mail-a",
                        ...crewWake,
                      },
                    },
                  },
                ]
              : []),
            ...(placed
              ? [
                  ...(!crewWake?.batched
                    ? [
                        {
                          id: "answer-current",
                          type: "assistant",
                          content: [
                            {
                              type: "reasoning",
                              text: "HISTORY REASONING SECRET",
                            },
                            { type: "tool", text: "HISTORY TOOL SECRET" },
                            { type: "text", text: "Canonical final answer." },
                          ],
                        },
                      ]
                    : []),
                  { id: inputId, type: "user" },
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
      if (path.endsWith("/inbox") && request.method === "GET") {
        if (deliverDuringCheck) placed = true;
        checked.resolve();
        if (++inboxReads === 2) checkedAgain.resolve();
        return Response.json({
          data: placed ? [] : [{ id: inputId, type: "user" }],
        });
      }
      if (path.endsWith("/interrupt")) {
        interrupts++;
        interrupted.resolve();
        return Response.json({ success: true });
      }
      if (path.endsWith(`/inbox/${inputId}`) && request.method === "DELETE") {
        cancelled = true;
        withdrawals.push(inputId);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    },
  });
  const config = Schema.decodeUnknownSync(backendSchema)({
    type: "opencode",
    url: server.url.href,
    directory: "/workspace",
    headersEnv,
  });
  if (config.type !== "opencode") throw new Error("Invalid fixture");
  return {
    backend: new OpenCodeBackend(config),
    waiting: waiting.promise,
    disconnected: disconnected.promise,
    interrupted: interrupted.promise,
    formListing: formListing.promise,
    reconnected: reconnected.promise,
    finish: () => finish.resolve(),
    historyReads: () => historyReads,
    input: () => inputId,
    admissions: () => admissions,
    checked: checked.promise,
    checkedAgain: checkedAgain.promise,
    place: () => {
      placed = true;
    },
    interrupts: () => interrupts,
    cancelled: () => cancelled,
    withdrawals: () => withdrawals,
    emit,
    disconnect(kind: "eof" | "error" = "eof") {
      if (kind === "error")
        stream?.error(new Error("Fixture event stream lost"));
      else stream?.close();
      stream = undefined;
    },
    async close() {
      finish.resolve();
      await server.stop(true);
    },
  };
}

test("OpenCode wait disables only HTTP idleness and preserves its request", async () => {
  const headerEnv = "STARGATE_TEST_WAIT_HEADER";
  const previous = process.env[headerEnv];
  process.env[headerEnv] = "fixture-value";
  const nativeFetch = globalThis.fetch;
  const requests: {
    path: string;
    init: BunFetchRequestInit | undefined;
  }[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (url: URL | RequestInfo, init?: BunFetchRequestInit) => {
        requests.push({ path: new URL(String(url)).pathname, init });
        return nativeFetch(url, init);
      },
      { preconnect: nativeFetch.preconnect },
    ),
  );
  const fixture = openCodeStreamFixture(false, false, undefined, {
    "x-fixture": headerEnv,
  });
  const controller = new AbortController();
  const pending = fixture.backend.prompt(
    "session-current",
    "hello",
    controller.signal,
    () => {},
  );
  try {
    await fixture.waiting;
    const wait = requests.find((request) => request.path.endsWith("/wait"));
    expect(wait?.init?.timeout).toBe(false);
    expect(wait?.init?.signal).toBe(controller.signal);
    expect(wait?.init?.method).toBe("POST");
    expect(wait?.init?.headers).toBeInstanceOf(Headers);
    expect(new Headers(wait?.init?.headers).get("x-fixture")).toBe(
      "fixture-value",
    );
    expect(wait?.init?.body).toBeUndefined();
    expect(
      requests
        .filter((request) => !request.path.endsWith("/wait"))
        .every((request) => request.init?.timeout === undefined),
    ).toBe(true);
    expect(fixture.admissions()).toBe(1);
    expect(fixture.interrupts()).toBe(0);
    expect(fixture.withdrawals()).toEqual([]);
    fixture.finish();
    expect(await pending).toBe("Canonical final answer.");
    expect(fixture.admissions()).toBe(1);
  } finally {
    controller.abort();
    await pending.catch(() => {});
    await fixture.close();
    fetchSpy.mockRestore();
    if (previous === undefined) delete process.env[headerEnv];
    else process.env[headerEnv] = previous;
  }
});

for (const origin of [
  { originInputID: "msg_sourceA" },
  {},
  { originCaptainID: "other-captain", originInputID: "msg_sourceA" },
]) {
  test(`conversation eval: queued crew wake cannot enter another input's preview or Stop, origin=${JSON.stringify(origin)}`, async () => {
    const f = openCodeStreamFixture(false, false, origin);
    const received = Promise.withResolvers<void>();
    const snapshots: string[] = [];
    const stop = new AbortController();
    const result = f.backend.prompt(
      "session-current",
      "Public B",
      stop.signal,
      (text) => {
        snapshots.push(text);
        if (text.includes("OWN B")) received.resolve();
      },
    );
    try {
      await f.waiting;
      f.emit("session.text.delta", {
        sessionID: "session-current",
        assistantMessageID: "answer-wake",
        ordinal: 0,
        delta: "PRIVATE TASK A",
      });
      f.emit("session.text.delta", {
        sessionID: "session-current",
        assistantMessageID: "answer-current",
        ordinal: 0,
        delta: "OWN B",
      });
      await received.promise;
      await f.backend.interruptInput("session-current", f.input(), stop.signal);
      expect(f.interrupts()).toBe(0);
      expect(f.cancelled()).toBe(true);
      f.finish();
      expect(await result).toBe("Canonical final answer.");
      expect(snapshots.join("\n")).not.toContain("PRIVATE TASK A");
    } finally {
      stop.abort();
      await result.catch(() => {});
      await f.close();
    }
  });
}

test("conversation eval: native steer batch has no public preview, final text or Stop ownership", async () => {
  const f = openCodeStreamFixture(false, false, {
    originInputID: "msg_sourceA",
    batched: true,
  });
  const stop = new AbortController();
  const snapshots: string[] = [];
  const result = f.backend.prompt(
    "session-current",
    "Public B",
    stop.signal,
    (text) => snapshots.push(text),
  );
  try {
    await f.waiting;
    f.emit("session.text.delta", {
      sessionID: "session-current",
      assistantMessageID: "answer-wake",
      ordinal: 0,
      delta: "PRIVATE TASK A",
    });
    await f.backend.interruptInput("session-current", f.input(), stop.signal);
    expect(f.interrupts()).toBe(0);
    f.finish();
    expect(await result).toBe("");
    expect(snapshots).toEqual([]);
  } finally {
    stop.abort();
    await result.catch(() => {});
    await f.close();
  }
});

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

const humanIrcSource = {
  source: {
    transport: "irc",
    authority: "human",
    channel: "#command",
    thread: "irc-thread",
    message: "irc-message",
    user: "jac",
  },
} as const;

test("OpenCode finds a running IRC question after unrelated and settled forms without status notices", async () => {
  const fixture = openCodeStreamFixture(
    false,
    false,
    undefined,
    {},
    { active: true, unrelated: 16, stale: 16 },
  );
  try {
    await expect(
      fixture.backend.prompt(
        "session-current",
        "New IRC request",
        AbortSignal.timeout(3000),
        undefined,
        undefined,
        undefined,
        humanIrcSource,
      ),
    ).rejects.toBeInstanceOf(PendingBackendQuestion);
    expect(fixture.admissions()).toBe(0);
    expect(fixture.interrupts()).toBe(0);
    expect(fixture.withdrawals()).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("OpenCode submits a new request if pending form metadata has no running question tool", async () => {
  const fixture = openCodeStreamFixture(
    false,
    false,
    undefined,
    {},
    {
      active: true,
      running: false,
    },
  );
  const controller = new AbortController();
  const result = fixture.backend.prompt(
    "session-current",
    "New IRC request",
    controller.signal,
    () => {},
    undefined,
    undefined,
    humanIrcSource,
  );
  try {
    await fixture.waiting;
    fixture.finish();
    expect(await result).toBe("Canonical final answer.");
    expect(fixture.admissions()).toBe(1);
  } finally {
    controller.abort();
    await result.catch(() => {});
    await fixture.close();
  }
});

test("OpenCode marks cancellation during an IRC form check as pre-submission", async () => {
  const list = Promise.withResolvers<void>();
  const fixture = openCodeStreamFixture(
    false,
    false,
    undefined,
    {},
    {
      active: true,
      waitForList: list.promise,
    },
  );
  const controller = new AbortController();
  const result = fixture.backend.prompt(
    "session-current",
    "New IRC request",
    controller.signal,
    undefined,
    undefined,
    undefined,
    humanIrcSource,
  );
  try {
    await fixture.formListing;
    controller.abort();
    await expect(result).rejects.toBeInstanceOf(PromptNotSubmitted);
    expect(fixture.admissions()).toBe(0);
    expect(fixture.interrupts()).toBe(0);
    expect(fixture.withdrawals()).toEqual([]);
  } finally {
    controller.abort();
    list.resolve();
    await result.catch(() => {});
    await fixture.close();
  }
});

test("OpenCode reports metadata for the exact inbox item and its own assistant", async () => {
  const fixture = openCodeStreamFixture(
    true,
    false,
    undefined,
    {},
    {
      active: false,
    },
  );
  const controller = new AbortController();
  const observed: TurnProgress[] = [];
  const stages = new Map<
    TurnStage,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  for (const stage of ["queued", "reasoning", "tool"] as const)
    stages.set(stage, Promise.withResolvers<void>());
  const result = fixture.backend.prompt(
    "session-current",
    "Public request",
    controller.signal,
    undefined,
    undefined,
    undefined,
    humanIrcSource,
    (progress) => {
      observed.push(progress);
      stages.get(progress.stage)?.resolve();
    },
  );
  try {
    await fixture.waiting;
    const sessionID = "session-current";
    fixture.emit("session.inbox.delivered", { sessionID, inboxID: "other" });
    fixture.emit("session.inbox.enqueued", {
      sessionID,
      inboxID: fixture.input(),
    });
    await stages.get("queued")?.promise;
    const owner = { sessionID, assistantMessageID: "answer-current" };
    fixture.emit("session.inbox.delivered", {
      sessionID,
      inboxID: fixture.input(),
    });
    fixture.emit("session.reasoning.started", {
      sessionID,
      assistantMessageID: "old-answer",
      ordinal: 0,
    });
    fixture.emit("session.reasoning.started", {
      ...owner,
      sessionID: "other-session",
      ordinal: 0,
    });
    fixture.emit("session.reasoning.started", { ...owner, ordinal: 0 });
    await fixture.checked;
    expect(observed.at(-1)?.stage).toBe("delivered");
    // The assistant projection becomes readable without a second owned event.
    fixture.place();
    await stages.get("reasoning")?.promise;
    fixture.emit("session.tool.called", {
      ...owner,
      id: "tool-call",
      input: { token: "PRIVATE TOOL INPUT" },
      executed: true,
    });
    await stages.get("tool")?.promise;
    fixture.finish();
    expect(await result).toBe("Canonical final answer.");
    expect(observed.map(({ stage }) => stage)).toEqual([
      "submitting",
      "accepted",
      "queued",
      "delivered",
      "reasoning",
      "tool",
    ]);
    expect(JSON.stringify(observed)).not.toContain("PRIVATE TOOL INPUT");
    expect(fixture.admissions()).toBe(1);
  } finally {
    controller.abort();
    await result.catch(() => {});
    await fixture.close();
  }
});

test("OpenCode rechecks uncertain ownership on a later tool event", async () => {
  const fixture = openCodeStreamFixture(true);
  const controller = new AbortController();
  const toolReported = Promise.withResolvers<void>();
  const result = fixture.backend.prompt(
    "session-current",
    "New IRC request",
    controller.signal,
    undefined,
    undefined,
    undefined,
    humanIrcSource,
    ({ stage }) => {
      if (stage === "tool") toolReported.resolve();
    },
  );
  try {
    await fixture.waiting;
    const owner = {
      sessionID: "session-current",
      assistantMessageID: "answer-current",
    };
    fixture.emit("session.reasoning.started", { ...owner, ordinal: 0 });
    await fixture.checkedAgain;
    // Both initial reads saw a queued input. Let the later event recheck it.
    await Bun.sleep(300);
    fixture.place();
    fixture.emit("session.tool.called", {
      ...owner,
      id: "tool-call",
      input: {},
      executed: true,
    });
    await toolReported.promise;
    fixture.finish();
    expect(await result).toBe("Canonical final answer.");
    expect(fixture.admissions()).toBe(1);
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

test.each(["eof", "error"] as const)(
  "OpenCode resumes progress after event stream %s without resubmitting",
  async (kind) => {
    const fixture = openCodeStreamFixture();
    const controller = new AbortController();
    const queued = Promise.withResolvers<void>();
    const reasoning = Promise.withResolvers<void>();
    const result = fixture.backend.prompt(
      "session-current",
      "New IRC request",
      controller.signal,
      undefined,
      undefined,
      undefined,
      humanIrcSource,
      ({ stage }) => {
        if (stage === "queued") queued.resolve();
        if (stage === "reasoning") reasoning.resolve();
      },
    );
    try {
      await fixture.waiting;
      fixture.emit("session.inbox.enqueued", {
        sessionID: "session-current",
        inboxID: fixture.input(),
      });
      await queued.promise;
      fixture.disconnect(kind);
      await fixture.reconnected;
      fixture.emit("session.reasoning.started", {
        sessionID: "session-current",
        assistantMessageID: "answer-current",
        ordinal: 0,
      });
      await reasoning.promise;
      fixture.finish();
      expect(await result).toBe("Canonical final answer.");
      expect(fixture.admissions()).toBe(1);
      expect(fixture.withdrawals()).toEqual([]);
    } finally {
      controller.abort();
      await result.catch(() => {});
      await fixture.close();
    }
  },
);

test.each([false, true])(
  "OpenCode queued preview placement race=%s",
  async (race) => {
    const fixture = openCodeStreamFixture(true, race);
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
      if (!race) expect(fixture.historyReads()).toBe(0);
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
      expect(fixture.historyReads()).toBe(race ? 3 : 2);
    } finally {
      controller.abort();
      await pending.catch(() => {});
      await fixture.close();
    }
  },
);

for (const reason of [
  new DOMException("Stop", "AbortError"),
  new DOMException("Deadline", "TimeoutError"),
]) {
  test(`OpenCode ${reason.name} closes the event subscription and interrupts owned execution`, async () => {
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
      // Deliver Stop/deadline only after the wait is admitted; no clock race.
      controller.abort(reason);
      await expect(result).rejects.toThrow();
      await fixture.interrupted;
      await fixture.disconnected;
      expect(fixture.historyReads()).toBe(1);
      expect(fixture.admissions()).toBe(1);
      expect(fixture.interrupts()).toBe(1);
      expect(fixture.withdrawals()).toEqual([fixture.input()]);
    } finally {
      controller.abort();
      await result.catch(() => {});
      await fixture.close();
    }
  });

  test(`OpenCode queued ${reason.name} withdraws only its own input`, async () => {
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
      controller.abort(reason);
      await expect(pending).rejects.toThrow();
      expect(fixture.cancelled()).toBe(true);
      expect(fixture.interrupts()).toBe(0);
      expect(fixture.admissions()).toBe(1);
      expect(fixture.withdrawals()).toEqual([fixture.input()]);
    } finally {
      controller.abort();
      await pending.catch(() => {});
      await fixture.close();
    }
  });
}

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

test("Pi live text decoding strips unknown keys and requires finite inputs", () => {
  const view = (live: ConversationView["docs"][string]): ConversationView => ({
    conversation: { id: 1 as ConversationId },
    entries: [],
    docs: { "pi.live": live },
  });
  const generation = {
    message: {
      content: [
        { type: "text", text: "Visible", extra: true },
        { type: "text" },
      ],
      extra: true,
    },
    extra: true,
  };
  for (const run of [{ inputs: [1.5, 0] }, { inputs: [], extra: true }])
    expect(piPartialText(view({ run, generation, extra: true }))).toBe(
      "Visible",
    );
  for (const live of [
    { run: null, generation },
    { run: { inputs: [Number.POSITIVE_INFINITY] }, generation },
    { run: { inputs: [Number.NaN] }, generation },
    { run: { inputs: ["1"] }, generation },
    { generation: { message: { content: [{ type: "text", text: null }] } } },
    { generation: { message: { content: [{ text: "missing type" }] } } },
  ])
    expect(piPartialText(view(live)), JSON.stringify(live)).toBe("");
  // Non-object live state is outside the SDK type; pass it without a cast.
  const untyped = (live: unknown): string =>
    Reflect.apply(piPartialText, undefined, [
      { conversation: { id: 1 }, entries: [], docs: { "pi.live": live } },
    ]);
  expect(untyped({ generation })).toBe("Visible");
  for (const live of [[], null, "Visible", 1, true])
    expect(untyped(live), JSON.stringify(live)).toBe("");
});

test("Pi conversation IDs accept decimal digits as safe integers", async () => {
  const opened: number[] = [];
  const harness = {
    async conversation(id: number) {
      opened.push(id);
      return undefined;
    },
  };
  const backend: PiDurableBackend = Reflect.construct(PiDurableBackend, [
    harness,
    {},
  ]);
  const signal = new AbortController().signal;
  for (const id of ["0", "7", "007", String(Number.MAX_SAFE_INTEGER)])
    await expect(backend.prompt(id, "hello", signal)).rejects.toThrow(
      "Pi conversation not found",
    );
  for (const id of [
    "9007199254740992",
    "9".repeat(400),
    "",
    "-1",
    "+1",
    "1.5",
    "1e3",
    " 7",
    "0x1",
  ])
    await expect(backend.prompt(id, "hello", signal), id).rejects.not.toThrow(
      "Pi conversation not found",
    );
  expect(opened).toEqual([0, 7, 7, Number.MAX_SAFE_INTEGER]);
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
  const directory = await mkdtemp(join(tmpdir(), "stargate-pi-"));
  const previous = process.env["OPENAI_API_KEY"];
  process.env["OPENAI_API_KEY"] = "local-test-not-sent";
  try {
    const config = Schema.decodeUnknownSync(backendSchema)({
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
