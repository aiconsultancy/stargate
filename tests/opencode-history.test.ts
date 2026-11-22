import { describe, expect, test } from "bun:test";
import type {
  SessionInfo,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "@opencode/client";
import { Schema } from "effect";
import {
  OpenCodeHistory,
  type OpenCodeHistoryClient,
  type OpenCodeHistoryReporting,
} from "../src/backends/opencode/opencode-history";
import { CrewReporting } from "../src/crew/report-rpc";
import {
  HISTORY_PARTS,
  HISTORY_TEXT,
  type HistoryEntriesInput,
  historyEntriesInputSchema,
  historyEntryPageSchema,
} from "../src/shared/session-history";

const failure =
  "Session history unavailable or cancelled; raw details withheld.";
const model = { providerID: "provider", id: "model", variant: "high" };
const time = { created: 10 };
const info = (id: string): Pick<SessionInfo, "id" | "time"> => ({
  id,
  time: { created: 10, updated: 20 },
});
const base = { id: "message", time };
const assistant = (
  content: Extract<SessionMessageInfo, { type: "assistant" }>["content"],
): SessionMessageInfo => ({
  ...base,
  type: "assistant",
  agent: "agent",
  model,
  content,
});
const tool = (
  state: SessionMessageAssistantTool["state"],
  name = "subagent",
): SessionMessageAssistantTool => ({
  type: "tool",
  id: "call",
  name,
  time,
  state,
});

function fixture() {
  const controller = new AbortController();
  const { signal } = controller;
  const calls: Array<{ method: string; input: unknown; request: unknown }> = [];
  const data = {
    messages: [] as SessionMessageInfo[],
    sessions: [info("child")],
    cursor: undefined as string | undefined,
    roots: {
      sessions: [{ id: "root", harness: "opencode", kind: "captain" }],
    } as unknown,
    describe: {
      sessions: [{ id: "pi:worker", harness: "pi-durable", kind: "crew" }],
    } as unknown,
    children: { sessions: [] } as unknown,
    entries: { entries: [] } as unknown,
  };
  const record = (
    method: string,
    input: unknown,
    request: { signal: AbortSignal },
  ) => {
    expect(request.signal).toBe(signal);
    calls.push({ method, input, request });
  };
  const reporting: OpenCodeHistoryReporting = {
    async historyRoots(input, request) {
      record("roots", input, request);
      return data.roots;
    },
    async historyDescribe(input, request) {
      record("describe", input, request);
      return data.describe;
    },
    async historyChildren(input, request) {
      record("children", input, request);
      return data.children;
    },
    async historyEntries(input, request) {
      record("entries", input, request);
      return data.entries;
    },
  };
  const client: OpenCodeHistoryClient = {
    session: {
      async get(input, request) {
        record("get", input, request);
        return info(input.sessionID);
      },
      async list(input, request) {
        record("list", input, request);
        return { data: data.sessions, cursor: { next: data.cursor ?? null } };
      },
    },
    message: {
      async list(input, request) {
        record("messages", input, request);
        return { data: data.messages, cursor: { next: data.cursor ?? null } };
      },
    },
    rpc(definition) {
      expect(definition).toBe(CrewReporting);
      return reporting;
    },
  };
  const history = new OpenCodeHistory(client, "/captain");
  const entries = (input: Partial<HistoryEntriesInput> = {}) =>
    history.entries(
      Schema.decodeUnknownSync(historyEntriesInputSchema)({
        sessionID: "native",
        ...input,
      }),
      signal,
    );
  return {
    client,
    reporting,
    history,
    entries,
    data,
    calls,
    signal,
    controller,
  };
}

describe("OpenCode fleet history", () => {
  test("roots use only the scoped reporting RPC and validate its response", async () => {
    const f = fixture();
    expect(await f.history.roots(f.signal)).toEqual([
      { id: "root", harness: "opencode", kind: "captain" },
    ]);
    expect(f.calls).toEqual([
      {
        method: "roots",
        input: {},
        request: { signal: f.signal, location: { directory: "/captain" } },
      },
    ]);
    f.data.roots = { sessions: [{ id: "private transcript" }] };
    await expect(f.history.roots(f.signal)).rejects.toThrow(failure);
  });

  test("describe separates mixed IDs in one Pi RPC and retains request order", async () => {
    const f = fixture();
    f.data.describe = {
      sessions: [
        { id: "pi:worker", harness: "pi-durable", kind: "crew" },
        {
          id: "pi:child",
          harness: "pi-durable",
          kind: "subagent",
          parentID: "pi:worker",
        },
      ],
    };
    f.client.session.get = async ({ sessionID }, { signal }) => {
      expect(signal).toBe(f.signal);
      if (sessionID === "missing")
        throw { _tag: "SessionNotFoundError", message: "private missing ID" };
      return {
        ...info(sessionID),
        ...(sessionID === "child" && { parentID: "native" }),
        title: "Title",
        agent: "agent",
        model,
      };
    };
    expect(
      await f.history.describe(
        ["native", "pi:worker", "missing", "child", "pi:child"],
        f.signal,
      ),
    ).toEqual([
      {
        id: "native",
        harness: "opencode",
        kind: "conversation",
        title: "Title",
        agent: "agent",
        model: "provider/model#high",
        createdAt: 10,
        updatedAt: 20,
      },
      { id: "pi:worker", harness: "pi-durable", kind: "crew" },
      {
        id: "child",
        parentID: "native",
        harness: "opencode",
        kind: "subagent",
        title: "Title",
        agent: "agent",
        model: "provider/model#high",
        createdAt: 10,
        updatedAt: 20,
      },
      {
        id: "pi:child",
        harness: "pi-durable",
        kind: "subagent",
        parentID: "pi:worker",
      },
    ]);
    expect(f.calls).toEqual([
      {
        method: "describe",
        input: { ids: ["pi:worker", "pi:child"] },
        request: { signal: f.signal, location: { directory: "/captain" } },
      },
    ]);
  });

  test("describe bounds concurrent native lookups", async () => {
    const f = fixture();
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let active = 0;
    let maximum = 0;
    let calls = 0;
    f.client.session.get = async ({ sessionID }) => {
      calls++;
      active++;
      maximum = Math.max(maximum, active);
      if (active === 5) started.resolve();
      await gate.promise;
      active--;
      return info(sessionID);
    };
    const result = f.history.describe(
      Array.from({ length: 12 }, (_, i) => `session-${i}`),
      f.signal,
    );
    await started.promise;
    expect(calls).toBe(5);
    gate.resolve();
    expect(await result).toHaveLength(12);
    expect(maximum).toBe(5);
  });

  test("children include both archive states; cursors retain native filters", async () => {
    const f = fixture();
    f.data.sessions = [
      { ...info("archived"), time: { ...info("archived").time, archived: 30 } },
      info("active"),
    ];
    f.data.cursor = "opaque-next";
    const first = await f.history.children(
      { parentID: "root", limit: 2 },
      f.signal,
    );
    expect(first.sessions.map((session) => session.id)).toEqual([
      "archived",
      "active",
    ]);
    expect(first.cursor).toBe("opaque-next");
    expect(f.calls[0]?.input).toEqual({
      parentID: "root",
      limit: 2,
      order: "desc",
    });
    await f.history.children(
      { parentID: "root", limit: 2, cursor: first.cursor },
      f.signal,
    );
    expect(f.calls[1]?.input).toEqual({ limit: 2, cursor: "opaque-next" });
  });

  test("Pi children and entries use scoped RPCs without native calls", async () => {
    const f = fixture();
    f.data.children = {
      sessions: [
        {
          id: "pi:child",
          parentID: "pi:worker",
          harness: "pi-durable",
          kind: "subagent",
        },
      ],
      cursor: "pi-next",
    };
    f.data.entries = {
      entries: [
        {
          id: "pi:message",
          role: "assistant",
          parts: [{ type: "text", text: "Reply" }],
        },
      ],
      cursor: "pi-messages",
    };
    expect(
      (
        await f.history.children(
          { parentID: "pi:worker", limit: 7, cursor: "pi-cursor" },
          f.signal,
        )
      ).cursor,
    ).toBe("pi-next");
    expect(
      (
        await f.entries({
          sessionID: "pi:worker",
          detail: "full",
          order: "asc",
          cursor: "pi-before",
        })
      ).cursor,
    ).toBe("pi-messages");
    expect(f.calls).toEqual([
      {
        method: "children",
        input: { parentID: "pi:worker", limit: 7, cursor: "pi-cursor" },
        request: { signal: f.signal, location: { directory: "/captain" } },
      },
      {
        method: "entries",
        input: {
          sessionID: "pi:worker",
          detail: "full",
          order: "asc",
          cursor: "pi-before",
          limit: 30,
        },
        request: { signal: f.signal, location: { directory: "/captain" } },
      },
    ]);
  });

  test("maps every message variant without attachment payloads", async () => {
    const f = fixture();
    f.data.messages = [
      {
        ...base,
        id: "user",
        type: "user",
        text: "Question",
        files: [
          {
            data: "private-base64",
            mime: "image/png",
            source: { type: "inline" },
            name: "image.png",
          },
        ],
        agents: [{ name: "helper" }],
        skills: [{ id: "skill", name: "testing", text: "private-skill" }],
      },
      { ...base, id: "synthetic", type: "synthetic", text: "Synthetic" },
      { ...base, id: "system", type: "system", text: "System" },
      {
        ...base,
        id: "skill",
        type: "skill",
        skill: "skill",
        name: "testing",
        text: "private-skill",
      },
      {
        ...base,
        id: "shell",
        type: "shell",
        shellID: "shell-id",
        command: "echo private",
        status: "running",
      },
      assistant([{ type: "text", text: "Answer" }]),
      {
        ...base,
        id: "compaction-running",
        type: "compaction",
        status: "running",
        reason: "auto",
        summary: "private-summary",
      },
      {
        ...base,
        id: "compaction-completed",
        type: "compaction",
        status: "completed",
        reason: "manual",
        summary: "private-summary",
      },
      {
        ...base,
        id: "compaction-failed",
        type: "compaction",
        status: "failed",
        reason: "manual",
        error: { type: "failure", message: "private-error" },
      },
      { ...base, id: "agent", type: "agent-switched", agent: "helper" },
      { ...base, id: "model", type: "model-switched", model },
      {
        ...base,
        id: "location",
        type: "location-switched",
        location: { directory: "/child" },
      },
      { ...base, id: "idle", type: "idle", outcome: "succeeded" },
    ];
    const page = await f.entries();
    expect(() =>
      Schema.decodeUnknownSync(historyEntryPageSchema)(page),
    ).not.toThrow();
    expect(
      page.entries.map((entry) => [entry.id, entry.role, entry.parts]),
    ).toEqual([
      [
        "user",
        "user",
        [
          { type: "text", text: "Question" },
          { type: "notice", label: "Attachment: image.png" },
          { type: "notice", label: "Agent: helper" },
          { type: "notice", label: "Skill: testing" },
        ],
      ],
      ["synthetic", "system", [{ type: "text", text: "Synthetic" }]],
      ["system", "system", [{ type: "text", text: "System" }]],
      ["skill", "system", [{ type: "notice", label: "Skill: testing" }]],
      ["shell", "tool", [{ type: "tool", name: "shell", status: "running" }]],
      ["message", "assistant", [{ type: "text", text: "Answer" }]],
      [
        "compaction-running",
        "system",
        [{ type: "notice", label: "Compaction: running" }],
      ],
      [
        "compaction-completed",
        "system",
        [{ type: "notice", label: "Compaction: completed" }],
      ],
      [
        "compaction-failed",
        "system",
        [{ type: "notice", label: "Compaction: failed" }],
      ],
      ["agent", "system", [{ type: "notice", label: "Agent: helper" }]],
      [
        "model",
        "system",
        [{ type: "notice", label: "Model: provider/model#high" }],
      ],
      ["location", "system", [{ type: "notice", label: "Location: /child" }]],
    ]);
    expect(JSON.stringify(page)).not.toContain("private");
    expect(page.entries.find((entry) => entry.id === "message")?.model).toBe(
      "provider/model#high",
    );
  });

  test("summary preserves assistant part order and child IDs but hides tool bodies", async () => {
    const f = fixture();
    f.data.messages = [
      assistant([
        { type: "text", text: "Before" },
        { type: "reasoning", text: "private reasoning" },
        tool({ status: "streaming", input: "private partial" }),
        tool({
          status: "running",
          input: { private: true },
          metadata: { sessionID: "child" },
        }),
        tool({
          status: "completed",
          input: {},
          content: [{ type: "text", text: "private output" }],
          metadata: { sessionId: "legacy-child" },
        }),
        tool({
          status: "error",
          input: { sessionID: "not-created" },
          error: { type: "failure", message: "private failure" },
        }),
        { type: "text", text: "After" },
      ]),
    ];
    expect((await f.entries()).entries[0]?.parts).toEqual([
      { type: "text", text: "Before" },
      { type: "reasoning" },
      { type: "tool", name: "subagent", status: "pending" },
      { type: "tool", name: "subagent", status: "running", sessionID: "child" },
      {
        type: "tool",
        name: "subagent",
        status: "completed",
        sessionID: "legacy-child",
      },
      { type: "tool", name: "subagent", status: "error" },
      { type: "text", text: "After" },
    ]);
  });

  test("full detail includes reasoning, serialized tool bodies and shell output", async () => {
    const f = fixture();
    f.data.messages = [
      assistant([
        { type: "reasoning", text: "Reason" },
        tool({ status: "streaming", input: "partial" }),
        tool({
          status: "completed",
          input: { n: 1 },
          content: [{ type: "text", text: "Done" }],
        }),
        tool({
          status: "error",
          input: {},
          error: { type: "failure", message: "Tool failed" },
        }),
      ]),
      {
        ...base,
        id: "shell",
        type: "shell",
        shellID: "shell",
        command: "echo done",
        status: "exited",
        exit: 0,
        output: { output: "done", cursor: 4, size: 4, truncated: false },
      },
    ];
    const page = await f.entries({ detail: "full" });
    expect(page.entries[0]?.parts).toEqual([
      { type: "reasoning", text: "Reason" },
      { type: "tool", name: "subagent", status: "pending", input: "partial" },
      {
        type: "tool",
        name: "subagent",
        status: "completed",
        input: '{"n":1}',
        output: '[{"type":"text","text":"Done"}]',
      },
      {
        type: "tool",
        name: "subagent",
        status: "error",
        input: "{}",
        output: "Tool failed",
      },
    ]);
    expect(page.entries[1]?.parts).toEqual([
      {
        type: "tool",
        name: "shell",
        status: "completed",
        input: "echo done",
        output: "done",
      },
    ]);
  });

  test.each(["timeout", "killed", "exited"] as const)(
    "shell %s failure maps to error",
    async (status) => {
      const f = fixture();
      f.data.messages = [
        {
          ...base,
          type: "shell",
          shellID: "shell",
          command: "false",
          status,
          exit: 1,
        },
      ];
      expect((await f.entries()).entries[0]?.parts[0]).toEqual({
        type: "tool",
        name: "shell",
        status: "error",
      });
    },
  );

  test("clips every body, reports omitted parts, retains shell truncation", async () => {
    const f = fixture();
    const long = "x".repeat(HISTORY_TEXT + 1);
    f.data.messages = [
      assistant([
        { type: "text", text: long },
        { type: "reasoning", text: long },
        tool({
          status: "completed",
          input: { long },
          content: [{ type: "text", text: long }],
        }),
        ...Array.from({ length: HISTORY_PARTS }, () => ({
          type: "text" as const,
          text: "extra",
        })),
      ]),
      { ...base, id: "user", type: "user", text: long },
      {
        ...base,
        id: "shell",
        type: "shell",
        shellID: "shell",
        command: long,
        status: "exited",
        exit: 0,
        output: { output: long, cursor: 0, size: long.length, truncated: true },
      },
    ];
    const page = await f.entries({ detail: "full" });
    expect(page.entries[0]?.parts).toHaveLength(HISTORY_PARTS);
    expect(page.entries[0]?.omittedParts).toBe(3);
    for (const entry of page.entries)
      for (const part of entry.parts) {
        if (part.type === "text" && part.text !== "extra") {
          expect(part.text).toHaveLength(HISTORY_TEXT);
          expect(part.truncated).toBe(true);
        }
        if (part.type === "reasoning") {
          expect(part.text).toHaveLength(HISTORY_TEXT);
          expect(part.truncated).toBe(true);
        }
        if (part.type === "tool") {
          expect(part.input).toHaveLength(HISTORY_TEXT);
          expect(part.output).toHaveLength(HISTORY_TEXT);
          expect(part.truncated).toBe(true);
        }
      }
    expect(() =>
      Schema.decodeUnknownSync(historyEntryPageSchema)(page),
    ).not.toThrow();
  });

  test("message cursor passes through unchanged without conflicting order", async () => {
    const f = fixture();
    f.data.cursor = "native-next";
    expect(await f.entries({ order: "asc", limit: 9 })).toEqual({
      entries: [],
      cursor: "native-next",
    });
    await f.entries({ order: "desc", cursor: "native-next", limit: 9 });
    expect(f.calls.map((call) => call.input)).toEqual([
      { sessionID: "native", limit: 9, order: "asc" },
      { sessionID: "native", limit: 9, cursor: "native-next" },
    ]);
  });

  test("rejects invalid inputs before I/O and sanitizes malformed outputs", async () => {
    const f = fixture();
    await expect(f.history.describe([], f.signal)).rejects.toThrow(failure);
    await expect(
      f.history.describe(["x".repeat(513)], f.signal),
    ).rejects.toThrow(failure);
    await expect(
      f.history.children({ parentID: "native", limit: 51 }, f.signal),
    ).rejects.toThrow(failure);
    await expect(
      f.history.entries(
        { sessionID: "", order: "desc", limit: 1, detail: "summary" },
        f.signal,
      ),
    ).rejects.toThrow(failure);
    expect(f.calls).toEqual([]);
    f.data.cursor = "";
    await expect(f.entries()).rejects.toThrow(failure);
    f.data.entries = {
      entries: [
        { id: "sensitive", role: "assistant", parts: [{ type: "unknown" }] },
      ],
    };
    await expect(f.entries({ sessionID: "pi:worker" })).rejects.toThrow(
      failure,
    );
  });

  test("sanitizes SDK and RPC failures; only real not-found errors are omitted", async () => {
    const f = fixture();
    const fail = async () => {
      throw new Error("private transcript token headers session-id");
    };
    f.client.session.get = fail;
    f.client.session.list = fail;
    f.client.message.list = fail;
    f.reporting.historyRoots = fail;
    f.reporting.historyDescribe = fail;
    f.reporting.historyChildren = fail;
    f.reporting.historyEntries = fail;
    const operations = [
      () => f.history.roots(f.signal),
      () => f.history.describe(["native"], f.signal),
      () => f.history.describe(["pi:worker"], f.signal),
      () => f.history.children({ parentID: "native", limit: 1 }, f.signal),
      () => f.history.children({ parentID: "pi:worker", limit: 1 }, f.signal),
      () => f.entries(),
      () => f.entries({ sessionID: "pi:worker" }),
    ];
    for (const run of operations) await expect(run()).rejects.toThrow(failure);
  });

  test("already-aborted operations do not call native APIs or RPC", async () => {
    const f = fixture();
    f.controller.abort(new Error("private abort reason"));
    await expect(f.history.roots(f.signal)).rejects.toThrow(failure);
    await expect(
      f.history.describe(["native", "pi:worker"], f.signal),
    ).rejects.toThrow(failure);
    await expect(
      f.history.children({ parentID: "native", limit: 1 }, f.signal),
    ).rejects.toThrow(failure);
    await expect(f.entries()).rejects.toThrow(failure);
    expect(f.calls).toEqual([]);
  });

  test("in-flight reads forward cancellation and withhold abort reasons", async () => {
    const f = fixture();
    const started = Promise.withResolvers<void>();
    f.client.message.list = async (_input, { signal }) => {
      expect(signal).toBe(f.signal);
      started.resolve();
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    };
    const reading = f.entries();
    await started.promise;
    f.controller.abort(new Error("private abort reason"));
    await expect(reading).rejects.toThrow(failure);
  });

  test("does not return successful responses after cancellation", async () => {
    const f = fixture();
    f.reporting.historyRoots = async () => {
      f.controller.abort();
      return f.data.roots;
    };
    await expect(f.history.roots(f.signal)).rejects.toThrow(failure);
  });
});
