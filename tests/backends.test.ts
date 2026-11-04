import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { OpenCodeBackend } from "../src/backends/opencode";
import { PiDurableBackend } from "../src/backends/pi-durable";
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
