import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { z } from "zod";
import { latestInput, TranscriptUnavailable } from "../src/backend";
import { OpenCodeBackend } from "../src/backends/opencode";
import { backendSchema, loadConfig } from "../src/config";
import { botKey, conversationKey } from "../src/routing";
import { Store } from "../src/store";
import { repairThread } from "../src/transcript";
import { bot, identity } from "./fixtures";

const assistant = (
  id: string,
  created: number,
  content: unknown[],
  completed = true,
) => ({
  id,
  type: "assistant",
  time: { created, ...(completed ? { completed: created + 1 } : {}) },
  content,
});

const outputLimitContinuation =
  "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces.";

// Newest first, as OpenCode returns `order: "desc"` pages.
const history = [
  assistant("m8", 80, [{ type: "text", text: "STILL STREAMING" }], false),
  // Native same-turn context, not an unproven background shell callback.
  {
    id: "m7",
    type: "synthetic",
    time: { created: 70 },
    text: outputLimitContinuation,
  },
  assistant("m6", 60, [{ type: "text", text: "Pushed 79233." }]),
  assistant("m5", 50, [
    { type: "tool", id: "t1", name: "bash", state: { input: "TOKEN=x" } },
  ]),
  assistant("m4", 40, [
    { type: "reasoning", text: "PRIVATE REASONING" },
    { type: "text", text: "Compile failure found." },
    { type: "tool", id: "t2", name: "bash", state: { output: "SECRET" } },
    { type: "text", text: "Fixes in place." },
  ]),
  { id: "m3", type: "user", time: { created: 30 }, text: "USER PROMPT" },
  assistant("m2", 20, [{ type: "text", text: "DO NOT REPEAT" }]),
  { id: "m1", type: "user", time: { created: 10 }, text: "OLD PROMPT" },
];

function fixture(time: { busy?: number; idle?: number }) {
  const lists: URLSearchParams[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/session/session-1")
        return Response.json({ data: { id: "session-1", time } });
      if (url.pathname.endsWith("/message")) {
        lists.push(url.searchParams);
        // Small pages exercise the cursor without any message limit semantics.
        const start = Number(url.searchParams.get("cursor") ?? 0);
        const end = start + 3;
        return Response.json({
          data: history.slice(start, end),
          cursor: end < history.length ? { next: String(end) } : {},
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
  return { backend: new OpenCodeBackend(config), lists, server };
}

test("OpenCode transcript returns settled public text after the cursor only", async () => {
  const f = fixture({ busy: 75 });
  try {
    const signal = new AbortController().signal;
    expect(await f.backend.transcript("session-1", "m2", signal)).toEqual({
      cursor: "m7",
      input: "m3",
      entries: [
        {
          id: "m4",
          text: "Compile failure found.\nFixes in place.",
          created: 40,
          input: "m3",
        },
        { id: "m6", text: "Pushed 79233.", created: 60, input: "m3" },
      ],
      pending: true, // m8 is still streaming; the cursor stops before it.
    });
    // A one-message probe, then descending pages through the cursor.
    expect(f.lists.map((list) => list.get("limit"))).toEqual([
      "1",
      "20",
      "100",
      "100",
    ]);
    expect(f.lists[0]?.get("order")).toBe("desc");
    expect(f.lists[2]?.get("cursor")).toBe("3");
    // An unchanged cursor reads nothing new and keeps its place.
    expect(await f.backend.transcript("session-1", "m7", signal)).toEqual({
      cursor: "m7",
      entries: [],
      pending: true,
    });
  } finally {
    await f.server.stop(true);
  }
});

test("OpenCode output-limit continuation retains the original input through a synthetic cursor", async () => {
  const f = fixture({ busy: 75, idle: 90 });
  try {
    const transcript = await f.backend.transcript(
      "session-1",
      "m2",
      new AbortController().signal,
    );
    expect(transcript.entries.at(-1)).toEqual({
      id: "m8",
      text: "STILL STREAMING",
      created: 80,
      input: "m3",
    });
    expect(transcript.input).toBe("m3");
    // A neutral cursor does not replace the caller's persisted delivery owner.
    expect(
      await f.backend.transcript(
        "session-1",
        "m7",
        new AbortController().signal,
      ),
    ).toEqual({
      cursor: "m8",
      entries: [{ id: "m8", text: "STILL STREAMING", created: 80 }],
    });
  } finally {
    await f.server.stop(true);
  }
});

test("OpenCode baselines never backfill, lost cursors fail, and idle settles stale text", async () => {
  const f = fixture({ busy: 75, idle: 90 });
  try {
    const signal = new AbortController().signal;
    expect(await f.backend.transcript("session-1", undefined, signal)).toEqual({
      cursor: "m8",
      entries: [],
    });
    expect(f.lists).toHaveLength(1);
    // A lost cursor fails instead of skipping to a fresh baseline.
    await expect(
      f.backend.transcript("session-1", "gone", signal),
    ).rejects.toThrow("cursor");
    const all = await f.backend.transcript("session-1", "", signal);
    expect(all.entries.map((entry) => entry.text)).toEqual([
      "DO NOT REPEAT",
      "Compile failure found.\nFixes in place.",
      "Pushed 79233.",
      "STILL STREAMING",
    ]);
    expect(JSON.stringify(all)).not.toContain("SECRET");
    expect(JSON.stringify(all)).not.toContain("PROMPT");
    expect(JSON.stringify(all)).not.toContain(outputLimitContinuation);
  } finally {
    await f.server.stop(true);
  }
});

test("OpenCode watch reports settled sessions and reconnects", async () => {
  const connections: ReadableStreamDefaultController<Uint8Array>[] = [];
  const paths: string[] = [];
  const encoder = new TextEncoder();
  const send = (
    stream: ReadableStreamDefaultController<Uint8Array> | undefined,
    type: string,
    data: Record<string, unknown>,
  ) =>
    stream?.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ id: type, created: 1, type, data })}\n\n`,
      ),
    );
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      paths.push(url.pathname);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            connections.push(controller);
            send(controller, "server.connected", {});
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const config = Schema.decodeUnknownSync(backendSchema)({
    type: "opencode",
    url: server.url.href,
    directory: "/workspace",
  });
  if (config.type !== "opencode") throw new Error("Invalid fixture");
  const controller = new AbortController();
  const seen: (string | undefined)[] = [];
  const reconnected = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  const watch = new OpenCodeBackend(config).watch((session) => {
    seen.push(session);
    if (session === "session-1") settled.resolve();
    if (seen.filter((value) => value === undefined).length === 2)
      reconnected.resolve();
  }, controller.signal);
  try {
    while (connections.length === 0) await Bun.sleep(5);
    send(connections[0], "session.text.delta", { sessionID: "session-1" });
    send(connections[0], "session.execution.succeeded", {
      sessionID: "session-1",
    });
    await settled.promise;
    connections[0]?.close();
    await reconnected.promise;
    expect(seen).toEqual([undefined, "session-1", undefined]);
    // The client filters event types; both connections use the event stream.
    expect(paths).toEqual(["/api/event", "/api/event"]);
  } finally {
    controller.abort();
    await watch;
    await server.stop(true);
  }
  // Stopping a read-only watch never interrupts the sessions it observed.
  expect(paths.filter((path) => path !== "/api/event")).toEqual([]);
});

test("repairThread resolves the namespace and protects existing state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-repair-"));
  const state = join(directory, "state");
  const database = join(state, "stargate.sqlite");
  const modes: number[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/session/session-1")
        return Response.json({ data: { id: "session-1", time: { idle: 99 } } });
      if (url.pathname.endsWith("/message")) {
        for (const path of [database, `${database}-wal`, `${database}-shm`])
          modes.push((await stat(path)).mode & 0o777);
        return Response.json({ data: history, cursor: {} });
      }
      return new Response(null, { status: 404 });
    },
  });
  try {
    const config = bot("captain");
    if (config.backend.type !== "opencode") throw new Error("Invalid fixture");
    config.backend.url = server.url.href;
    const path = join(directory, "stargate.json");
    await Bun.write(
      path,
      JSON.stringify({
        dataDirectory: "state",
        bots: [
          {
            id: config.id,
            slack: config.slack,
            access: { users: ["U123"], channels: ["C123"] },
            backend: {
              type: "opencode",
              url: server.url.href,
              directory: "/workspace",
            },
          },
        ],
      }),
    );
    const parsed = (await loadConfig(path)).bots[0];
    if (!parsed) throw new Error("Invalid fixture");
    await mkdir(join(directory, "state"));
    const store = new Store(join(directory, "state", "stargate.sqlite"));
    const key = botKey(parsed, identity);
    const conversation = conversationKey(key, "C123", "1.000");
    for (const [eventId, response] of [
      ["C123:1.000", ["Compile failure found.\nFixes in place."]],
      ["C123:2.000", ["Unrelated stored reply"]],
    ] as const) {
      store.enqueue({
        eventId,
        botKey: key,
        conversation,
        channel: "C123",
        thread: "1.000",
        user: "U123",
        text: "request",
      });
      const job = store.queuedJob(key, eventId);
      if (!job) throw new Error("Missing job");
      store.running(job.id);
      store.respond(job.id, [...response]);
      store.finish(job.id);
    }
    store.saveSession(conversation, "session-1", "m8");
    store.close();
    await chmod(state, 0o755);
    await chmod(database, 0o644);
    const input = {
      config: path,
      bot: "captain",
      channel: "C123",
      thread: "1.000",
      since: "m3",
    };
    expect(await repairThread(input)).toEqual({
      session: "session-1",
      cursor: "m8",
      delivered: ["m4"],
      missing: [
        { id: "m6", created: "1970-01-01 00:00:00 UTC", characters: 13 },
        { id: "m8", created: "1970-01-01 00:00:00 UTC", characters: 15 },
      ],
      requeued: [],
      conflicts: [],
      queued: 0,
    });
    expect((await stat(state)).mode & 0o777).toBe(0o700);
    expect((await stat(database)).mode & 0o777).toBe(0o600);
    expect(modes.length).toBeGreaterThan(0);
    expect(new Set(modes)).toEqual(new Set([0o600]));
    expect(
      await repairThread({ ...input, only: ["m6"], apply: true }),
    ).toMatchObject({ missing: [{ id: "m6" }], queued: 1 });
    await expect(repairThread({ ...input, bot: "other" })).rejects.toThrow(
      "Unknown bot",
    );
    await expect(repairThread({ ...input, thread: "7.000" })).rejects.toThrow(
      "one current bot namespace",
    );
    const target = join(state, "target.sqlite");
    await rename(database, target);
    await chmod(target, 0o644);
    await symlink(target, database);
    await expect(repairThread(input)).rejects.toThrow();
    expect((await stat(target)).mode & 0o777).toBe(0o644);
    await unlink(database);
    await expect(repairThread(input)).rejects.toThrow("ENOENT");
    await expect(stat(database)).rejects.toThrow("ENOENT");
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("OpenCode reads every page of a long gap, keeps missing cursors, and honours abort", async () => {
  // Newest first: 2,500 public messages after the cursor exceed the old bound.
  const messages = [
    ...Array.from({ length: 2500 }, (_, index) =>
      assistant(`n${2500 - index}`, 10_000 - index, [
        { type: "text", text: `reply ${2500 - index}` },
      ]),
    ),
    { id: "cursor", type: "user", time: { created: 1 }, text: "PROMPT" },
  ];
  const requests: string[] = [];
  let abortAfter = Number.POSITIVE_INFINITY;
  const controller = new AbortController();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      if (url.pathname === "/api/session/session-1")
        return Response.json({ data: { id: "session-1", time: { idle: 1 } } });
      if (!url.pathname.endsWith("/message"))
        return new Response(null, { status: 404 });
      if (requests.length > abortAfter) controller.abort();
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const end = start + Number(url.searchParams.get("limit"));
      return Response.json({
        data: messages.slice(start, end),
        cursor: end < messages.length ? { next: String(end) } : {},
      });
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
    const read = await backend.transcript("session-1", "cursor", signal);
    expect(read.cursor).toBe("n2500");
    expect(read.entries).toHaveLength(2500);
    expect(read.entries[0]?.text).toBe("reply 1");
    expect(read).not.toHaveProperty("reset");
    // A missing cursor is an error; the caller keeps its stored cursor.
    await expect(
      backend.transcript("session-1", "gone", signal),
    ).rejects.toThrow();
    // A quiet thread needs one small page and no session read.
    requests.length = 0;
    expect(await backend.transcript("session-1", "n2500", signal)).toEqual({
      cursor: "n2500",
      entries: [],
    });
    expect(requests).toEqual(["/api/session/session-1/message"]);
    requests.length = 0;
    abortAfter = 4;
    await expect(
      backend.transcript("session-1", "cursor", controller.signal),
    ).rejects.toThrow();
    expect(requests.length).toBeLessThan(10);
  } finally {
    await server.stop(true);
  }
});

test("OpenCode prompt pages with cursors only, records its input, and types missing sessions", async () => {
  const lists: URLSearchParams[] = [];
  let deleted = false;
  let inputID = "m3";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (deleted)
        return Response.json(
          {
            _tag: "SessionNotFoundError",
            sessionID: "session-1",
            message: "gone",
          },
          { status: 404 },
        );
      if (url.pathname.endsWith("/prompt")) {
        inputID = z.object({ id: z.string() }).parse(await request.json()).id;
        return Response.json({ data: { id: inputID } });
      }
      if (url.pathname.endsWith("/wait"))
        return new Response(null, { status: 204 });
      if (url.pathname === "/api/session/session-1")
        return Response.json({ data: { id: "session-1", time: { busy: 75 } } });
      if (!url.pathname.endsWith("/message"))
        return new Response(null, { status: 404 });
      lists.push(url.searchParams);
      // The protocol keeps the first page's order inside its cursor.
      if (url.searchParams.has("cursor") && url.searchParams.has("order"))
        return Response.json({ message: "bad cursor" }, { status: 400 });
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const end = start + 3;
      return Response.json({
        data: history
          .slice(start, end)
          .map((message) =>
            message.id === "m3" ? { ...message, id: inputID } : message,
          ),
        cursor: end < history.length ? { next: String(end) } : {},
      });
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
    // Unchanged prompt text: the tool-only step joins as an empty reply.
    expect(await backend.prompt("session-1", "hello", signal)).toBe(
      "Compile failure found.\nFixes in place.\n\n\n\nPushed 79233.\n\nSTILL STREAMING",
    );
    expect(lists[0]?.get("order")).toBe("desc");
    expect(lists[1]?.get("cursor")).toBe("3");
    // The exact submitted input anchors a re-read after a lost cursor.
    expect(await backend.transcript("session-1", latestInput, signal)).toEqual({
      cursor: "m7",
      entries: [
        {
          id: "m4",
          text: "Compile failure found.\nFixes in place.",
          created: 40,
        },
        { id: "m6", text: "Pushed 79233.", created: 60 },
      ],
      pending: true,
    });
    const missing = await backend
      .transcript("session-1", "gone", signal)
      .catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(TranscriptUnavailable);
    expect(missing).toMatchObject({ reason: "cursor" });
    await expect(
      backend.transcript("session-2", latestInput, signal),
    ).rejects.toMatchObject({ reason: "cursor" });
    deleted = true;
    await expect(
      backend.transcript("session-1", "m7", signal),
    ).rejects.toMatchObject({ reason: "session" });
  } finally {
    await server.stop(true);
  }
});

test("OpenCode interrupt treats a deleted session as stopped, other failures as errors", async () => {
  let status = 404;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return status === 404
        ? Response.json(
            {
              _tag: "SessionNotFoundError",
              sessionID: "session-1",
              message: "gone",
            },
            { status },
          )
        : Response.json({ message: "unavailable" }, { status });
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
    await backend.interrupt("session-1", signal);
    status = 503;
    await expect(backend.interrupt("session-1", signal)).rejects.toThrow();
  } finally {
    await server.stop(true);
  }
});
