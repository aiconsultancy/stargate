import { expect, test } from "bun:test";
import { Schema } from "effect";
import { OpenCodeBackend } from "../src/backends/opencode";
import { backendSchema } from "../src/config";
import { BackendFailure } from "../src/request-failure";

type Assistant = {
  type?: "assistant" | "user";
  time?: { created: number; completed?: number };
  finish?: "stop" | "error" | "tool-calls";
  error?: { type: string; message: string; status?: number };
  content?: { type: string; text?: string }[];
};

/** An OpenCode server whose turn ends with these assistant messages. */
function openCode(messages: Assistant[]) {
  let input = "";
  let prompts = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/session")
        return Response.json({ data: { id: "session-1" } });
      if (url.pathname.endsWith("/prompt")) {
        prompts++;
        input = ((await request.json()) as { id: string }).id;
        return Response.json({ data: { id: input } });
      }
      if (url.pathname.endsWith("/wait"))
        return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/message"))
        return Response.json({
          data: [
            ...messages
              .map((message, index) => ({
                id: `answer-${index}`,
                type: "assistant",
                content: [],
                ...message,
              }))
              .reverse(),
            { id: input, type: "user" },
          ],
          cursor: {},
        });
      return new Response(null, { status: 404 });
    },
  });
  const config = Schema.decodeUnknownSync(backendSchema)({
    type: "opencode",
    url: server.url.href,
    directory: "/workspace",
  });
  if (config.type !== "opencode") throw new Error("Invalid fixture");
  return {
    server,
    backend: new OpenCodeBackend(config),
    submissions: () => prompts,
  };
}

const failureOf = (work: Promise<unknown>) =>
  work.then(
    () => undefined,
    (error: unknown) =>
      error instanceof BackendFailure ? error.failure : String(error),
  );

// What a provider or proxy writes in an error body.
const body =
  "auth unavailable: 2 of 2 candidate(s) for model claude-fable-5-2 are in cooldown, reason=credential_quota sk-ant-secret";

const streamFailure: Assistant = {
  time: { created: 2, completed: 3 },
  finish: "error",
  error: { type: "provider.internal", message: body, status: 200 },
};
const successfulReply: Assistant = {
  time: { created: 4, completed: 5 },
  finish: "stop",
  content: [{ type: "text", text: "Final answer" }],
};

test("OpenCode reconciles an earlier error with same-input completed success without replay", async () => {
  const { server, backend, submissions } = openCode([
    { content: [{ type: "text", text: "Progress" }] },
    { ...streamFailure, content: [{ type: "text", text: "Partial answer" }] },
    successfulReply,
  ]);
  try {
    const answer = await backend.prompt(
      "session-1",
      "hello",
      AbortSignal.timeout(5000),
    );
    // Keep the existing chronological public-text contract, not a second
    // copy of the final answer substituted for an earlier failed attempt.
    expect(answer).toBe("Progress\n\nPartial answer\n\nFinal answer");
    expect(submissions()).toBe(1);
  } finally {
    await server.stop(true);
  }
});

test.each([
  ["terminal HTTP200 error", [streamFailure]],
  ["foreign-input success", [streamFailure, { type: "user" }, successfulReply]],
  [
    "uncompleted stop",
    [streamFailure, { ...successfulReply, time: { created: 4 } }],
  ],
  [
    "completed tool step",
    [streamFailure, { ...successfulReply, finish: "tool-calls" }],
  ],
  ["later terminal error", [streamFailure, successfulReply, streamFailure]],
] satisfies [string, Assistant[]][])(
  "OpenCode does not recover a %s",
  async (_name, messages) => {
    const { server, backend } = openCode(messages);
    try {
      expect(
        await failureOf(
          backend.prompt("session-1", "hello", AbortSignal.timeout(5000)),
        ),
      ).toBe("provider:provider:200:idle");
    } finally {
      await server.stop(true);
    }
  },
);

test("OpenCode retains work evidence before a recovered error and later terminal failure", async () => {
  const { server, backend } = openCode([
    { content: [{ type: "tool" }] },
    streamFailure,
    successfulReply,
    { error: { type: "APIError", message: body, status: 429 } },
  ]);
  try {
    expect(
      await failureOf(
        backend.prompt("session-1", "hello", AbortSignal.timeout(5000)),
      ),
    ).toBe("provider:quota:429:ran");
  } finally {
    await server.stop(true);
  }
});

test("OpenCode maps a failed generation to one shared failure category", async () => {
  const tool = { content: [{ type: "tool" }] };
  const cases: [messages: Assistant[], cause: string][] = [
    [
      [{ error: { type: "APIError", message: body, status: 429 } }],
      "provider:quota:429:idle",
    ],
    [
      [{ error: { type: "APIError", message: body, status: 402 } }],
      "provider:quota:402:idle",
    ],
    [
      [{ error: { type: "APIError", message: body, status: 401 } }],
      "provider:auth:401:idle",
    ],
    [
      [{ error: { type: "APIError", message: body, status: 403 } }],
      "provider:auth:403:idle",
    ],
    [
      [{ error: { type: "APIError", message: body, status: 404 } }],
      "provider:model:404:idle",
    ],
    [
      [{ error: { type: "APIError", message: body, status: 504 } }],
      "provider:timeout:504:idle",
    ],
    [
      [{ error: { type: "APIError", message: body, status: 503 } }],
      "provider:provider:503:idle",
    ],
    // No status: only OpenCode's error type name is read.
    [
      [{ error: { type: "ProviderAuthError", message: body } }],
      "provider:auth:0:idle",
    ],
    [
      [{ error: { type: "RateLimitError", message: body } }],
      "provider:quota:0:idle",
    ],
    [
      [{ error: { type: "ConnectionError", message: body } }],
      "provider:network:0:idle",
    ],
    // A tool ran before the provider refused the next call.
    [
      [tool, { error: { type: "APIError", message: body, status: 429 } }],
      "provider:quota:429:ran",
    ],
    // Not a provider failure: the generic failure stays.
    [
      [{ error: { type: "MessageAbortedError", message: body } }],
      "Error: OpenCode generation failed",
    ],
    [
      [{ error: { type: "failure", message: body } }],
      "Error: OpenCode generation failed",
    ],
  ];
  for (const [messages, cause] of cases) {
    const { server, backend } = openCode(messages);
    try {
      const signal = AbortSignal.timeout(5000);
      const session = await backend.createSession({
        key: "thread",
        title: "Slack",
        signal,
      });
      expect([
        messages,
        await failureOf(backend.prompt(session, "hello", signal)),
      ]).toEqual([messages, cause]);
    } finally {
      await server.stop(true);
    }
  }
});

test("an OpenCode server that cannot be reached is a network failure; nothing ran", async () => {
  const { server, backend } = openCode([]);
  const signal = AbortSignal.timeout(5000);
  const session = await backend.createSession({
    key: "thread",
    title: "Slack",
    signal,
  });
  await server.stop(true);
  expect(
    await failureOf(
      backend.createSession({ key: "thread", title: "Slack", signal }),
    ),
  ).toBe("provider:network:0:idle");
  expect(await failureOf(backend.prompt(session, "hello", signal))).toBe(
    "provider:network:0:idle",
  );
});

test("a lost history read after the turn ran never says that nothing ran", async () => {
  // The prompt is accepted and the turn settles; then the server goes away
  // on the first or on a further history page.
  for (const failAt of [1, 2]) {
    let input = "";
    let reads = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/session")
          return Response.json({ data: { id: "session-1" } });
        if (url.pathname.endsWith("/prompt")) {
          input = ((await request.json()) as { id: string }).id;
          return Response.json({ data: { id: input } });
        }
        if (url.pathname.endsWith("/wait"))
          return new Response(null, { status: 204 });
        if (url.pathname.endsWith("/message")) {
          if (++reads === failAt) {
            await server.stop(true);
            return new Response(null, { status: 500 });
          }
          return Response.json({
            data: [
              {
                id: "answer",
                type: "assistant",
                content: [{ type: "tool" }],
              },
            ],
            cursor: { next: "page2" },
          });
        }
        return new Response(null, { status: 404 });
      },
    });
    const config = Schema.decodeUnknownSync(backendSchema)({
      type: "opencode",
      url: server.url.href,
      directory: "/workspace",
    });
    if (config.type !== "opencode") throw new Error("Invalid fixture");
    const backend = new OpenCodeBackend(config);
    try {
      const signal = AbortSignal.timeout(5000);
      const session = await backend.createSession({
        key: "thread",
        title: "Slack",
        signal,
      });
      const failure = await failureOf(backend.prompt(session, "hello", signal));
      expect(input).not.toBe("");
      expect(reads).toBe(failAt);
      // Classified or not, the answer is never "idle".
      expect([failAt, failure]).not.toEqual([
        failAt,
        "provider:network:0:idle",
      ]);
      expect([failAt, failure]).toEqual([failAt, "provider:network:0:ran"]);
    } finally {
      await server.stop(true);
    }
  }
});
