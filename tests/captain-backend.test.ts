import { expect, test } from "bun:test";
import { Schema } from "effect";
import type { AgentBackend } from "../src/backends/backend";
import { OpenCodeBackend } from "../src/backends/opencode/opencode";
import { backendSchema, configSchema } from "../src/config";
import { buildUpdateSnapshot } from "../src/automation/maintenance/update-notice";
import { bot } from "./fixtures";

const sessionID = "ses_captain";

const session = {
  id: sessionID,
  agent: "captain",
  location: { directory: "/captain" },
  model: { providerID: "stored", id: "stored-model" },
  permissions: [{ action: "*", resource: "*", effect: "allow" }],
};

test("update notice admission queues local context via RPC, never native input", async () => {
  const requests: { path: string; body: unknown }[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;

      const body: unknown =
        request.method === "GET" ? undefined : await request.json();

      requests.push({ path, body });

      if (path.endsWith("/queueUpdateNotice"))
        return Response.json({ output: { id: "msg_update", sessionID } });

      if (path === `/api/session/${sessionID}`)
        return Response.json({ data: session });

      return new Response("Tool RPC unavailable", { status: 404 });
    },
  });

  const adapter = backend(server.url.href);

  try {
    const snapshot = await adapter.updateNoticeContext(
      sessionID,
      buildUpdateSnapshot(
        "0.37.0",
        { notifications: { updateNotice: true } },
        "- New notices",
      ),
      new AbortController().signal,
    );

    expect(snapshot.configDigest).toMatch(/^[a-f0-9]{64}$/);
    await adapter.queueUpdateNotice(
      sessionID,
      "msg_update",
      "Context only",
      new AbortController().signal,
    );
    expect(
      requests.filter((request) => request.path.endsWith("/queueUpdateNotice")),
    ).toEqual([
      {
        path: "/api/rpc/stargate.crew.reporting/queueUpdateNotice",
        body: { input: { sessionID, id: "msg_update", text: "Context only" } },
      },
    ]);
    expect(
      requests.some((request) => request.path.endsWith("/synthetic")),
    ).toBe(false);
    expect(
      requests.some((request) => /interrupt|prompt/.test(request.path)),
    ).toBe(false);
  } finally {
    await adapter.close();
    void server.stop(true);
  }
});

function backend(url: string, options: Record<string, unknown> = {}) {
  const config = Schema.decodeUnknownSync(backendSchema)({
    type: "opencode",
    url,
    directory: "/captain",
    sessionID,
    agent: "captain",
    ...options,
  });

  if (config.type !== "opencode") throw new Error("Invalid fixture");

  return new OpenCodeBackend(config);
}

test("OpenCode session pin validates a bounded native session ID", () => {
  for (const value of ["ses_captain", `ses_${"a".repeat(252)}`]) {
    expect(backend("http://127.0.0.1", { sessionID: value })).toBeDefined();
  }

  for (const value of [
    "",
    "ses_",
    "captain",
    "ses_a/b",
    "ses_a b",
    `ses_${"a".repeat(253)}`,
  ]) {
    expect(() => backend("http://127.0.0.1", { sessionID: value })).toThrow();
  }
});

test("one bot per pinned root; distinct and absent pins stay valid", () => {
  const first = bot("first");

  const second = {
    ...bot("second"),
    slack: {
      appId: "A456",
      appTokenEnv: "SECOND_APP_TOKEN",
      botTokenEnv: "SECOND_BOT_TOKEN",
    },
  };

  expect(() =>
    Schema.decodeUnknownSync(configSchema)({ bots: [first, second] }),
  ).not.toThrow();
  const pinned = { ...first, backend: { ...first.backend, sessionID } };
  expect(() =>
    Schema.decodeUnknownSync(configSchema)({ bots: [pinned, second] }),
  ).not.toThrow();
  expect(() =>
    Schema.decodeUnknownSync(configSchema)({
      bots: [
        pinned,
        {
          ...second,
          backend: { ...second.backend, sessionID: "ses_other" },
        },
      ],
    }),
  ).not.toThrow();
  expect(() =>
    Schema.decodeUnknownSync(configSchema)({
      bots: [
        pinned,
        {
          ...second,
          backend: { ...second.backend, sessionID },
        },
      ],
    }),
  ).toThrow("Duplicate pinned OpenCode sessionID");
});

test("pinned OpenCode calls reuse the root without changing stored settings", async () => {
  const requests: { method: string; path: string; body: string }[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: await request.text(),
      });

      return Response.json({ data: session });
    },
  });

  try {
    const adapter: AgentBackend = backend(server.url.href, {
      model: { providerID: "configured", id: "different" },
    });

    expect(adapter.sessionID).toBe(sessionID);

    for (const key of ["dm", "channel-thread"]) {
      expect(
        await adapter.createSession({
          key,
          title: key,
          signal: new AbortController().signal,
        }),
      ).toBe(sessionID);
    }

    expect(requests).toEqual(
      ["dm", "channel-thread"].map(() => ({
        method: "GET",
        path: `/api/session/${sessionID}`,
        body: "",
      })),
    );
    expect(
      await backend(server.url.href, { agent: undefined }).createSession({
        key: "unconfigured-agent",
        title: "unused",
        signal: new AbortController().signal,
      }),
    ).toBe(sessionID);
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
  } finally {
    await server.stop(true);
  }
});

test("missing, incompatible and failed pinned lookups never create a root", async () => {
  for (const result of [
    { status: 404, data: { message: "missing" } },
    { status: 503, data: { message: "PRIVATE" } },
    { status: 200, data: { ...session, id: "ses_other" } },
    { status: 200, data: { ...session, parentID: "ses_parent" } },
    { status: 200, data: { ...session, fork: { sessionID: "ses_parent" } } },
    { status: 200, data: { ...session, agent: "crew" } },
    { status: 200, data: { ...session, agent: undefined } },
    { status: 200, data: { ...session, location: { directory: "/other" } } },
    { status: 200, data: null },
  ]) {
    const methods: string[] = [];

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        methods.push(request.method);

        return Response.json({ data: result.data }, { status: result.status });
      },
    });

    try {
      await expect(
        backend(server.url.href).createSession({
          key: "thread",
          title: "unused",
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("Pinned OpenCode session unavailable or incompatible");
      expect(methods).toEqual(["GET"]);
    } finally {
      await server.stop(true);
    }
  }
});

test("OpenCode boundary corpus: pinned response strips keys and checks optional fields", async () => {
  let response: unknown;
  const paths: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      paths.push(path);

      if (path.startsWith("/api/agent/"))
        return Response.json({
          location: { directory: "/captain", ignored: true },
          data: { id: "captain", ignored: true },
          ignored: true,
        });

      return Response.json({ data: response });
    },
  });

  try {
    const adapter = backend(server.url.href, { enforcePermissions: true });

    const base = {
      id: sessionID,
      agent: "captain",
      location: { directory: "/captain" },
      permissions: [
        { effect: "deny", extra: true, resource: "*", action: "*" },
      ],
    };

    for (const [change, accepted] of [
      [{ extra: true, location: { directory: "/captain", extra: true } }, true],
      [{ parentID: undefined, fork: undefined }, true],
      [{ parentID: null }, false],
      [{ parentID: "" }, false],
      [{ fork: null }, false],
      [{ fork: false }, false],
      [{ agent: null }, false],
      [{ agent: undefined }, false],
      [{ permissions: null }, false],
      [
        { permissions: [{ action: "*", resource: "*", effect: "bogus" }] },
        false,
      ],
      [{ location: {} }, false],
      [{ id: null }, false],
    ] as const) {
      response = { ...base, ...change };

      const run = adapter.createSession({
        key: "corpus",
        title: "unused",
        signal: AbortSignal.timeout(3000),
      });

      if (accepted) expect(await run).toBe(sessionID);
      else
        await expect(run).rejects.toThrow(
          "Pinned OpenCode session unavailable or incompatible",
        );
    }

    expect(
      paths.every(
        (path) =>
          path.startsWith("/api/agent/") ||
          path === `/api/session/${sessionID}`,
      ),
    ).toBe(true);
  } finally {
    await server.stop(true);
  }
});

test("OpenCode boundary corpus: ready response rejects missing or mistyped fields", async () => {
  let response: unknown;
  let creates = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname.startsWith("/api/agent/"))
        return Response.json(response);
      creates++;

      return Response.json({ data: { id: "ses_created" } });
    },
  });

  try {
    const adapter = backend(server.url.href, {
      sessionID: undefined,
      enforcePermissions: true,
    });

    for (const [body, accepted] of [
      [
        {
          data: { id: "captain", extra: true },
          location: { directory: "/captain", extra: true },
          extra: true,
        },
        true,
      ],
      [{ data: { id: null }, location: { directory: "/captain" } }, false],
      [{ data: {}, location: { directory: "/captain" } }, false],
      [{ data: { id: "captain" }, location: { directory: null } }, false],
      [{ data: { id: "captain" } }, false],
      [null, false],
      [[], false],
    ] as const) {
      response = body;
      const before = creates;

      const run = adapter.createSession({
        key: "corpus",
        title: "unused",
        signal: AbortSignal.timeout(3000),
      });

      if (accepted) expect(await run).toBe("ses_created");
      else
        await expect(run).rejects.toThrow(
          "Configured OpenCode agent unavailable or incompatible; no session was created or reused",
        );
      expect(creates - before).toBe(accepted ? 1 : 0);
    }
  } finally {
    await server.stop(true);
  }
});

test("pinned lookup cancellation before and during GET never creates", async () => {
  const received = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const methods: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      methods.push(request.method);
      received.resolve();

      return response.promise;
    },
  });

  try {
    const adapter = backend(server.url.href);
    await expect(
      adapter.createSession({
        key: "before",
        title: "unused",
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    expect(methods).toEqual([]);
    const controller = new AbortController();

    const run = adapter.createSession({
      key: "during",
      title: "unused",
      signal: controller.signal,
    });

    await received.promise;
    controller.abort();
    response.resolve(Response.json({ data: session }));
    await expect(run).rejects.toThrow();
    expect(methods).toEqual(["GET"]);
  } finally {
    response.resolve(Response.json({ data: session }));
    await server.stop(true);
  }
});

test("lost pinned lookup response never creates a replacement", async () => {
  const methods: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      methods.push(request.method);
      void server.stop(true);

      return new Response();
    },
  });

  try {
    await expect(
      backend(server.url.href).createSession({
        key: "thread",
        title: "unused",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Pinned OpenCode session unavailable or incompatible");
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((method) => method === "GET")).toBe(true);
  } finally {
    await server.stop(true);
  }
});

test("unpinned OpenCode still creates separate sessions with configured settings", async () => {
  const bodies: unknown[] = [];
  const methods: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      methods.push(request.method);
      bodies.push(await request.json());

      return Response.json({ data: { id: `ses_new${bodies.length}` } });
    },
  });

  try {
    const model = { providerID: "configured", id: "model" };
    const adapter = backend(server.url.href, { sessionID: undefined, model });
    expect(adapter.sessionID).toBeUndefined();

    for (const key of ["first", "second"]) {
      expect(
        await adapter.createSession({
          key,
          title: key,
          signal: new AbortController().signal,
        }),
      ).toBe(`ses_new${bodies.length}`);
    }

    expect(methods).toEqual(["POST", "POST"]);
    expect(bodies).toEqual(
      ["first", "second"].map((title) => ({
        title,
        agent: "captain",
        model,
        location: { directory: "/captain" },
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      })),
    );
  } finally {
    await server.stop(true);
  }
});

function assistant(id: string, text: string, completed = true) {
  return {
    id,
    type: "assistant",
    time: { created: 10, ...(completed ? { completed: 20 } : {}) },
    content: [{ type: "text", text }],
  };
}

test.each(["owned", "user", "shell"])(
  "recovery checks latest raw input before stopping %s work",
  async (latest) => {
    const paths: string[] = [];
    const input = "owned-input";

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        paths.push(path);

        if (path.endsWith("/message"))
          return Response.json({
            data: [
              ...(latest === "owned"
                ? []
                : [
                    assistant("ui-answer", "Native UI work", false),
                    { id: "ui-input", type: latest },
                  ]),
              assistant("unmarked-own", "Unmarked own output", false),
              { id: input, type: "user" },
            ],
            cursor: {},
          });

        if (path.endsWith("/interrupt")) return Response.json({});

        return new Response(null, { status: 204 });
      },
    });

    try {
      await backend(server.url.href).interruptInput(
        sessionID,
        input,
        new AbortController().signal,
      );
      expect(paths.some((path) => path.endsWith(`/inbox/${input}`))).toBe(true);
      expect(paths.filter((path) => path.endsWith("/interrupt"))).toHaveLength(
        latest === "owned" ? 1 : 0,
      );
    } finally {
      await server.stop(true);
    }
  },
);

test("transcript attributes settled text to only preceding window inputs", async () => {
  let messages: unknown[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname.endsWith("/message"))
        return Response.json({ data: messages.toReversed(), cursor: {} });

      return Response.json({ data: { time: { busy: 100, idle: 0 } } });
    },
  });

  try {
    const adapter = backend(server.url.href);
    const signal = new AbortController().signal;
    const cursor = { id: "cursor", type: "user" };
    messages = [
      cursor,
      assistant("inherited", "Earlier owner"),
      { id: "user-one", type: "user" },
      assistant("answer-one", "First answer"),
      { id: "crew-dm", type: "synthetic" },
      assistant("answer-dm", "Unproven synthetic owner"),
      { id: "ui-shell", type: "shell" },
      assistant("shell-answer", "Native shell owner"),
      { id: "user-two", type: "user" },
      assistant("unsettled", "Not done", false),
      { id: "not-done-user", type: "user" },
      assistant("not-done-answer", "Beyond unsettled"),
    ];
    expect(await adapter.transcript(sessionID, "cursor", signal)).toEqual({
      cursor: "user-two",
      input: "user-two",
      pending: true,
      entries: [
        { id: "inherited", text: "Earlier owner", created: 10 },
        {
          id: "answer-one",
          text: "First answer",
          created: 10,
          input: "user-one",
        },
        {
          id: "answer-dm",
          text: "Unproven synthetic owner",
          created: 10,
          input: "crew-dm",
        },
        {
          id: "shell-answer",
          text: "Native shell owner",
          created: 10,
          input: "ui-shell",
        },
      ],
    });
    messages = [cursor, { id: "user-only", type: "user" }];
    expect(await adapter.transcript(sessionID, "cursor", signal)).toEqual({
      cursor: "user-only",
      input: "user-only",
      entries: [],
    });
    expect(await adapter.transcript(sessionID, undefined, signal)).toEqual({
      cursor: "user-only",
      input: "user-only",
      entries: [],
    });
    messages = [cursor, assistant("inherit", "No new input")];
    expect(await adapter.transcript(sessionID, "cursor", signal)).toEqual({
      cursor: "inherit",
      entries: [{ id: "inherit", text: "No new input", created: 10 }],
    });
    messages = [cursor];
    expect(await adapter.transcript(sessionID, "cursor", signal)).toEqual({
      cursor: "cursor",
      entries: [],
    });
  } finally {
    await server.stop(true);
  }
});

test.each(["user", "shell"])(
  "prompt excludes newer %s segments across pages",
  async (type) => {
    let input = "";
    let persisted = "";
    const methods: string[] = [];

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        methods.push(`${request.method} ${url.pathname}`);

        if (url.pathname.endsWith("/prompt")) {
          const body: { id: string } = await request.json();
          input = body.id;
          expect(persisted).toBe(input);

          return Response.json({ data: { id: input } });
        }

        if (url.pathname.endsWith("/wait"))
          return new Response(null, { status: 204 });

        if (url.pathname.endsWith("/message")) {
          if (url.searchParams.has("cursor"))
            return Response.json({
              data: [
                assistant("own-two", "Own second"),
                {
                  id: "crew-dm",
                  type: "synthetic",
                  metadata: {
                    pogoCrew: {
                      originCaptainID: sessionID,
                      originInputID: input,
                    },
                  },
                },
                assistant("own-one", "Own first"),
                { id: input, type: "user" },
              ],
              cursor: {},
            });

          return Response.json({
            data: [
              {
                ...assistant("foreign", "PRIVATE"),
                error: { message: "Foreign failure" },
              },
              { id: "foreign-input", type },
            ],
            cursor: { next: "older" },
          });
        }

        return new Response(null, { status: 404 });
      },
    });

    try {
      expect(
        await backend(server.url.href).prompt(
          sessionID,
          "hello",
          new AbortController().signal,
          undefined,
          (id) => {
            persisted = id;
          },
        ),
      ).toBe("Own first\n\nOwn second");
      expect(persisted).not.toBe("");
      expect(
        methods.filter((method) => method.endsWith("/prompt")),
      ).toHaveLength(1);
    } finally {
      await server.stop(true);
    }
  },
);

test.each(["user", "shell"])(
  "failed prompt never interrupts a later native %s input",
  async (type) => {
    let input = "";
    let persisted = "";
    const paths: string[] = [];

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        paths.push(path);

        if (path.endsWith("/prompt")) {
          const body: { id: string } = await request.json();
          input = body.id;
          expect(persisted).toBe(input);

          // Input was accepted; its receipt was lost/failed. Never resubmit.
          return Response.json({ message: "Lost receipt" }, { status: 503 });
        }

        if (path.endsWith("/message"))
          return Response.json({
            data: [
              assistant("foreign-answer", "PRIVATE"),
              { id: "foreign-input", type },
              { id: "crew-dm", type: "synthetic" },
              { id: input, type: "user" },
            ],
            cursor: {},
          });

        if (request.method === "DELETE")
          return new Response(null, { status: 204 });

        return new Response(null, { status: 404 });
      },
    });

    try {
      await expect(
        backend(server.url.href).prompt(
          sessionID,
          "hello",
          new AbortController().signal,
          undefined,
          (id) => {
            persisted = id;
          },
        ),
      ).rejects.toThrow();
      expect(persisted).toBe(input);
      expect(paths.filter((path) => path.endsWith("/prompt"))).toHaveLength(1);
      expect(paths.some((path) => path.endsWith("/interrupt"))).toBe(false);
      expect(paths.some((path) => path.endsWith(`/inbox/${input}`))).toBe(true);
    } finally {
      await server.stop(true);
    }
  },
);

test("input persistence failure prevents HTTP admission", async () => {
  const requests: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(request.url);

      return new Response(null, { status: 500 });
    },
  });

  try {
    await expect(
      backend(server.url.href).prompt(
        sessionID,
        "hello",
        new AbortController().signal,
        undefined,
        () => {
          throw new Error("Persistence failed");
        },
      ),
    ).rejects.toThrow("Persistence failed");
    expect(requests).toEqual([]);
  } finally {
    await server.stop(true);
  }
});

test.each(["user", "shell"])(
  "stream preview rejects an assistant owned by a later native %s input",
  async (type) => {
    let input = "";
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const finish = Promise.withResolvers<void>();
    const snapshots: string[] = [];
    const encoder = new TextEncoder();
    let sequence = 0;

    const emit = (event: string, data: Record<string, unknown>) => {
      if (!stream) throw new Error("Fixture SSE connection is not open");
      stream.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id: `event-${++sequence}`,
            created: sequence,
            type: event,
            location: { directory: "/captain" },
            data,
          })}\n\n`,
        ),
      );
    };

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;

        if (path === "/api/event")
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                stream = controller;
                emit("server.connected", {});
              },
              cancel() {
                stream = undefined;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );

        if (path.endsWith("/prompt")) {
          const body: { id: string } = await request.json();
          input = body.id;

          return Response.json({ data: { id: input } });
        }

        if (path.endsWith("/wait")) {
          emit("session.text.ended", {
            sessionID,
            assistantMessageID: "foreign-answer",
            ordinal: 0,
            text: "PRIVATE native reply",
          });
          emit("session.text.ended", {
            sessionID,
            assistantMessageID: "own-answer",
            ordinal: 0,
            text: "Own preview",
          });
          await finish.promise;

          return new Response(null, { status: 204 });
        }

        if (path.endsWith("/inbox")) return Response.json({ data: [] });

        if (path.endsWith("/message"))
          return Response.json({
            data: [
              assistant("foreign-answer", "PRIVATE native reply"),
              { id: "foreign-input", type },
              assistant("own-answer", "Own final reply"),
              { id: input, type: "user" },
            ],
            cursor: {},
          });

        return new Response(null, { status: 404 });
      },
    });

    const controller = new AbortController();

    const run = backend(server.url.href).prompt(
      sessionID,
      "hello",
      controller.signal,
      (text) => {
        snapshots.push(text);

        if (text.includes("Own preview")) finish.resolve();
      },
    );

    try {
      expect(await run).toBe("Own final reply");
      expect(snapshots.join("\n")).toContain("Own preview");
      expect(snapshots.join("\n")).not.toContain("PRIVATE");
    } finally {
      controller.abort();
      finish.resolve();
      await run.catch(() => {});
      await server.stop(true);
    }
  },
);
