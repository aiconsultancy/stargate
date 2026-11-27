import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type ConversationId,
  createRegistry,
  type EntryId,
  type EntryRecord,
  Harness,
  type TaskId,
  type TaskRecord,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Predicate, Schema } from "effect";
import {
  mapPiHistory,
  piSessionHistory,
  readPiHistory,
  storedPiIdle,
} from "../src/backends/pi/pi-history";
import {
  HISTORY_PARTS,
  HISTORY_TEXT,
  historyEntryPageSchema,
} from "../src/shared/session-history";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "test",
    timestamp: 10,
    stopReason: "toolUse",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function entry(id: number, kind: string, ...model: Message[]): EntryRecord {
  return {
    id: id as EntryId,
    conversationId: 1 as ConversationId,
    kind,
    model,
  };
}

const call = {
  type: "toolCall",
  id: "call-1",
  name: "read",
  arguments: { path: "file" },
} as const;

const result: Message = {
  role: "toolResult",
  toolCallId: call.id,
  toolName: call.name,
  content: [{ type: "text", text: "contents" }],
  isError: false,
  timestamp: 11,
};

test("Pi maps all built-in entry kinds and custom notices", () => {
  const mapped = mapPiHistory(
    [
      entry(1, "pi.user", { role: "user", content: "hello", timestamp: 1 }),
      entry(
        2,
        "pi.assistant",
        assistant([
          { type: "text", text: "before" },
          { type: "thinking", thinking: "reason" },
          call,
          { type: "text", text: "after" },
        ]),
      ),
      entry(3, "pi.tool-result", result),
      entry(4, "pi.system", { role: "system", content: "", timestamp: 4 }),
      entry(5, "pi.reset"),
      entry(6, "pi.compaction"),
      entry(7, "custom.shell"),
    ],
    "full",
  );

  expect(mapped.map(({ id, role }) => [id, role])).toEqual([
    ["1", "user"],
    ["2", "assistant"],
    ["4", "system"],
    ["5", "system"],
    ["6", "system"],
    ["7", "system"],
  ]);
  expect(mapped[1]?.parts).toEqual([
    { type: "text", text: "before" },
    { type: "reasoning", text: "reason" },
    {
      type: "tool",
      name: "read",
      status: "completed",
      input: '{"path":"file"}',
      output: "contents",
    },
    { type: "text", text: "after" },
  ]);
  expect(mapped[1]?.model).toBe("openai/test");
  expect(mapped[1]?.createdAt).toBe(10);
  expect(mapped.slice(2).map(({ parts }) => parts)).toEqual([
    [{ type: "notice", label: "pi.system" }],
    [{ type: "notice", label: "pi.reset" }],
    [{ type: "notice", label: "pi.compaction" }],
    [{ type: "notice", label: "custom.shell" }],
  ]);
});

test("Pi summary hides reasoning and tool bodies; full clips every body", () => {
  const long = "x".repeat(HISTORY_TEXT + 1);

  const records = [
    entry(
      1,
      "pi.assistant",
      assistant([
        { type: "text", text: long },
        { type: "thinking", thinking: long },
        { ...call, arguments: { text: long } },
      ]),
    ),
    entry(2, "pi.tool-result", {
      ...result,
      isError: true,
      content: [{ type: "text", text: long }],
    }),
  ];

  const summary = mapPiHistory(records, "summary");
  expect(summary[0]?.parts).toEqual([
    { type: "text", text: long.slice(0, HISTORY_TEXT), truncated: true },
    { type: "reasoning" },
    { type: "tool", name: "read", status: "error" },
  ]);
  const full = mapPiHistory(records, "full");
  expect(full[0]?.parts[1]).toEqual({
    type: "reasoning",
    text: long.slice(0, HISTORY_TEXT),
    truncated: true,
  });
  expect(full[0]?.parts[2]).toMatchObject({
    input: JSON.stringify({ text: long }).slice(0, HISTORY_TEXT),
    output: long.slice(0, HISTORY_TEXT),
    truncated: true,
  });
  Schema.decodeUnknownSync(historyEntryPageSchema)({ entries: full });
});

test("Pi ambiguous or unpaired results remain tool entries", () => {
  const records = [
    entry(1, "pi.assistant", assistant([call, call])),
    entry(2, "pi.tool-result", result),
  ];

  expect(mapPiHistory(records, "full")[1]).toMatchObject({
    id: "2",
    role: "tool",
  });
  expect(
    mapPiHistory([records[1] as EntryRecord], "summary")[0]?.parts,
  ).toEqual([{ type: "tool", name: "read", status: "completed" }]);

  const duplicates = [
    entry(1, "pi.assistant", assistant([call])),
    entry(2, "pi.tool-result", result),
    entry(3, "pi.tool-result", result),
  ];

  expect(mapPiHistory(duplicates, "full")).toHaveLength(3);
});

test("Pi counts parts beyond the bound", () => {
  const parts: AssistantMessage["content"] = Array.from(
    { length: HISTORY_PARTS + 3 },
    () => ({ type: "text", text: "part" }),
  );

  const mapped = mapPiHistory(
    [entry(1, "pi.assistant", assistant(parts))],
    "summary",
  );

  expect(mapped[0]?.parts).toHaveLength(HISTORY_PARTS);
  expect(mapped[0]?.omittedParts).toBe(3);

  const hiddenCall = mapPiHistory(
    [
      entry(1, "pi.assistant", assistant([...parts, call])),
      entry(2, "pi.tool-result", result),
    ],
    "full",
  );

  expect(hiddenCall[1]).toMatchObject({
    role: "tool",
    parts: [{ type: "tool", output: "contents" }],
  });
});

test("Pi clips non-BMP text within the wire bound without splitting characters", () => {
  const entries = mapPiHistory(
    [
      entry(
        1,
        "pi.assistant",
        assistant([{ type: "text", text: `x${"😀".repeat(HISTORY_TEXT)}` }]),
      ),
    ],
    "full",
  );

  Schema.decodeUnknownSync(historyEntryPageSchema)({ entries });
  expect(entries[0]?.parts[0]).toEqual({
    type: "text",
    text: `x${"😀".repeat((HISTORY_TEXT - 2) / 2)}`,
    truncated: true,
  });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "stargate-pi-history-"));
  const path = join(directory, "pi.sqlite");

  const harness = await Harness.open(
    await openNodeSqliteStorage(path),
    {
      models: createModels(),
      registry: createRegistry(),
    },
    BACKGROUND_CONTEXT,
  );

  const conversation = await harness.createConversation(
    { ownership: { kind: "ownerless" } },
    BACKGROUND_CONTEXT,
  );

  for (let i = 0; i < 5; i++) {
    await conversation.commit(
      (tx) =>
        tx.appendEntry(conversation.id, {
          kind: "pi.user",
          model: [{ role: "user", content: `input-${i}`, timestamp: i }],
        }),
      BACKGROUND_CONTEXT,
    );
  }

  return {
    directory,
    path,
    harness,
    id: String(conversation.id),
    close: async () => {
      await harness.close(BACKGROUND_CONTEXT);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Pi native pagination supports both orders and cursor retains original order", async () => {
  const f = await fixture();
  const history = piSessionHistory(f.harness);
  const signal = new AbortController().signal;

  try {
    expect(await history.roots(signal)).toEqual([]);
    expect(await history.describe([f.id, "999999", "bad"], signal)).toEqual([
      { id: f.id, harness: "pi-durable", kind: "conversation" },
    ]);
    expect(
      await history.children({ parentID: f.id, limit: 10 }, signal),
    ).toEqual({ sessions: [] });
    const orders: string[][] = [];

    for (const order of ["asc", "desc"] as const) {
      const ids: string[] = [];
      let cursor: string | undefined;

      do {
        const page = await history.entries(
          {
            sessionID: f.id,
            limit: 2,
            detail: "summary",
            order: cursor ? (order === "asc" ? "desc" : "asc") : order,
            ...(cursor ? { cursor } : {}),
          },
          signal,
        );

        Schema.decodeUnknownSync(historyEntryPageSchema)(page);
        ids.push(...page.entries.map(({ id }) => id));
        cursor = page.cursor;
      } while (cursor);

      expect(ids).toHaveLength(5);
      expect(new Set(ids).size).toBe(5);
      orders.push(ids);
    }

    expect(orders[0]).toEqual(orders[1]?.toReversed());

    const first = await history.entries(
      { sessionID: f.id, limit: 1, detail: "full", order: "desc" },
      signal,
    );

    if (!first.cursor) {
      throw new Error("Missing cursor");
    }

    await expect(
      history.entries(
        {
          sessionID: "99999",
          limit: 1,
          detail: "full",
          order: "desc",
          cursor: first.cursor,
        },
        signal,
      ),
    ).rejects.toThrow("Pi history unavailable");
    await expect(
      history.entries(
        {
          sessionID: f.id,
          limit: 1,
          detail: "full",
          order: "desc",
          cursor: "invalid",
        },
        signal,
      ),
    ).rejects.toThrow("Pi history unavailable");
  } finally {
    await f.close();
  }
});

test("Pi read-only reopen leaves running tasks, conversations and entries unchanged", async () => {
  const f = await fixture();
  await f.harness.close(BACKGROUND_CONTEXT);
  const db = new Database(f.path);

  try {
    const signal = new AbortController().signal;
    expect(storedPiIdle(f.directory, Number(f.id), signal)).toBe(true);

    const task: TaskRecord<null, { phase: string }, null> = {
      id: 100_000 as TaskId<null>,
      conversationId: Number(f.id) as ConversationId,
      kind: "test.never-run",
      version: 1,
      input: null,
      background: false,
      abortRequested: false,
      restarts: 3,
      state: { status: "running", checkpoint: { phase: "run" } },
    };

    db.query("INSERT INTO tasks VALUES (?,?,?,?,?,?,?)").run(
      task.id,
      task.conversationId,
      task.kind,
      task.state.status,
      0,
      0,
      JSON.stringify(task),
    );

    const snapshot = () =>
      [
        "tasks",
        "conversations",
        "entries",
        "submissions",
        "durable_metadata",
      ].map((table) => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());

    const before = snapshot();
    expect(storedPiIdle(f.directory, Number(f.id), signal)).toBe(false);

    const page = await readPiHistory(
      f.directory,
      new AbortController().signal,
      (history) =>
        history.entries(
          { sessionID: f.id, limit: 10, order: "asc", detail: "full" },
          new AbortController().signal,
        ),
    );

    expect(page.entries).toHaveLength(5);
    expect(snapshot()).toEqual(before);
  } finally {
    db.close();
    await f.close();
  }
});

test("Pi history aborts without native reads or missing-database creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-pi-history-abort-"));
  let reads = 0;

  const history = piSessionHistory({
    async conversation() {
      reads++;

      return undefined;
    },
  });

  const controller = new AbortController();
  controller.abort(new Error("private abort reason"));

  try {
    await expect(
      history.entries(
        { sessionID: "1", limit: 1, order: "asc", detail: "summary" },
        controller.signal,
      ),
    ).rejects.toThrow("Pi history unavailable or cancelled.");
    await expect(
      readPiHistory(directory, controller.signal, async () => []),
    ).rejects.toThrow("Pi history unavailable or cancelled.");
    await expect(
      readPiHistory(directory, new AbortController().signal, async () => []),
    ).rejects.toThrow("Pi history unavailable or cancelled.");
    expect(reads).toBe(0);
    expect(await Bun.file(join(directory, "pi.sqlite")).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Pi history refuses stores that need a schema migration", async () => {
  const f = await fixture();
  await f.harness.close(BACKGROUND_CONTEXT);
  const db = new Database(f.path);

  try {
    db.exec("UPDATE durable_schema SET version=1");
    const before = db.query("SELECT * FROM durable_schema").all();
    await expect(
      readPiHistory(f.directory, new AbortController().signal, async () => []),
    ).rejects.toThrow("Pi history unavailable or cancelled.");
    expect(db.query("SELECT * FROM durable_schema").all()).toEqual(before);
  } finally {
    db.close();
    await f.close();
  }
});

test("Pi history forwards only canonical numeric IDs and exact JSON cursors", async () => {
  const f = await fixture();
  const opened: number[] = [];

  const history = piSessionHistory({
    conversation(id, context) {
      opened.push(id);

      return f.harness.conversation(id, context);
    },
  });

  const signal = new AbortController().signal;

  try {
    expect(
      await history.describe(
        [
          "0",
          f.id,
          String(Number.MAX_SAFE_INTEGER),
          `0${f.id}`,
          "00",
          "9007199254740992",
          "9".repeat(400),
          "1.5",
          "-1",
          "+1",
          "1e3",
          ` ${f.id}`,
          `pi:${f.id}`,
        ],
        signal,
      ),
    ).toEqual([{ id: f.id, harness: "pi-durable", kind: "conversation" }]);
    expect(opened).toEqual([0, Number(f.id), Number.MAX_SAFE_INTEGER]);
    await expect(history.describe([f.id, ""], signal)).rejects.toThrow(
      "Pi history unavailable",
    );

    const read = (sessionID: string, cursor?: unknown) =>
      history.entries(
        {
          sessionID,
          limit: 2,
          order: "asc",
          detail: "summary",
          ...(cursor === undefined
            ? {}
            : {
                cursor: Buffer.from(JSON.stringify(cursor)).toString(
                  "base64url",
                ),
              }),
        },
        signal,
      );

    await expect(read(`0${f.id}`)).rejects.toThrow("Pi history unavailable");
    const first = await read(f.id);

    if (!first.cursor) {
      throw new Error("Missing cursor");
    }

    const cursor: unknown = JSON.parse(
      Buffer.from(first.cursor, "base64url").toString("utf8"),
    );

    if (
      !Predicate.hasProperty(cursor, "page") ||
      !Predicate.isObject(cursor.page)
    ) {
      throw new Error("Unexpected cursor");
    }

    const next = await read(f.id, cursor);
    expect(next.entries).toHaveLength(2);
    const nested = { list: [1, null, "x", true, { deep: [] }] };
    expect(
      await read(f.id, { ...cursor, page: { ...cursor.page, nested } }),
    ).toEqual(next);

    for (const invalid of [
      { ...cursor, extra: true },
      { sessionID: f.id },
      { ...cursor, sessionID: Number(f.id) },
      { ...cursor, sessionID: "999" },
      { ...cursor, page: [] },
      { ...cursor, page: null },
      { ...cursor, page: "after" },
      [],
    ]) {
      await expect(
        read(f.id, invalid),
        JSON.stringify(invalid),
      ).rejects.toThrow("Pi history unavailable");
    }
  } finally {
    await f.close();
  }
});

test("Pi history cursor JSON __proto__ keys keep the base pagination outcome", async () => {
  const f = await fixture();
  const history = piSessionHistory(f.harness);
  const signal = new AbortController().signal;

  // Raw JSON text keeps __proto__ as an own key, as a client would send it.
  const read = (cursor: string) =>
    history.entries(
      {
        sessionID: f.id,
        limit: 2,
        order: "asc",
        detail: "summary",
        cursor: Buffer.from(cursor).toString("base64url"),
      },
      signal,
    );

  try {
    const start = await history.entries(
      { sessionID: f.id, limit: 2, order: "asc", detail: "summary" },
      signal,
    );

    if (!start.cursor) {
      throw new Error("Missing cursor");
    }

    const { page } = JSON.parse(
      Buffer.from(start.cursor, "base64url").toString("utf8"),
    );

    const next = await read(JSON.stringify({ sessionID: f.id, page }));
    expect(next.entries).toHaveLength(2);
    const session = `"sessionID":"${f.id}"`;
    const own = `"after":${page.after},"order":"${page.order}"`;

    for (const cursor of [
      `{${session},"page":{${own},"__proto__":{"after":0,"order":"descending"}}}`,
      `{${session},"page":{${own},"__proto__":1}}`,
      `{${session},"page":{${own},"x":{"__proto__":{"a":1}}}}`,
    ]) {
      expect(await read(cursor), cursor).toEqual(next);
    }

    for (const cursor of [
      `{${session},"page":{"__proto__":{${own}}}}`,
      `{${session},"page":{"__proto__":1}}`,
      `{${session},"page":{${own}},"__proto__":{"x":1}}`,
      `{"page":{${own}},"__proto__":{${session}}}`,
    ]) {
      await expect(read(cursor), cursor).rejects.toThrow(
        "Pi history unavailable",
      );
    }
  } finally {
    await f.close();
  }
});
