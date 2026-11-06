import { expect, test } from "bun:test";
import type { OpenCodeClient } from "@opencode/client";
import {
  CrewHistory,
  type HistoryMessage,
  type HistoryMessages,
  type HistorySession,
  type HistorySessions,
  historyInputSchema,
} from "../src/crew/history";

const session = (id: string, title = id): HistorySession => ({
  id,
  title,
  agent: "captain",
  location: { directory: "/project" },
  metadata: { private: "credential settings" },
});
const user = (id: string, text: string): HistoryMessage => ({
  id,
  type: "user",
  text,
  time: { created: 123 },
});

function fixture() {
  const signal = new AbortController().signal;
  const calls: { method: string; sessionID?: string; cursor?: string }[] = [];
  const sessionPages = new Map<
    string,
    { data: HistorySession[]; cursor: { next?: string | null } }
  >();
  const messagePages = new Map<
    string,
    { data: HistoryMessage[]; cursor: { next?: string | null } }
  >();
  const known = new Map<string, HistorySession>();
  let failure = false;
  let deny = "foreign";
  const sessions: HistorySessions = {
    async list(input, options) {
      expect(options?.signal).toBe(signal);
      if (input?.cursor && input.order !== undefined)
        throw new Error("API cursor cannot be combined with order");
      expect(input?.order).toBe(input?.cursor ? undefined : "desc");
      calls.push({
        method: "sessions",
        ...(input?.cursor && { cursor: input.cursor }),
      });
      if (failure) throw new Error("secret token raw SDK failure");
      return sessionPages.get(input?.cursor ?? "") ?? { data: [], cursor: {} };
    },
    async get(input, options) {
      expect(options?.signal).toBe(signal);
      calls.push({ method: "get", sessionID: input.sessionID });
      if (failure) throw new Error("secret token raw SDK failure");
      const found = known.get(input.sessionID);
      if (!found) throw new Error("private not-found information");
      return found;
    },
  };
  const messages: HistoryMessages = {
    async list(input, options) {
      expect(options?.signal).toBe(signal);
      if (input.cursor && input.order !== undefined)
        throw new Error("API cursor cannot be combined with order");
      expect(input.order).toBe(input.cursor ? undefined : "asc");
      calls.push({
        method: "messages",
        sessionID: input.sessionID,
        ...(input.cursor && { cursor: input.cursor }),
      });
      if (failure) throw new Error("secret token raw SDK failure");
      const page = messagePages.get(`${input.sessionID}:${input.cursor ?? ""}`);
      if ((page?.data.length ?? 0) > (input.limit ?? 20))
        throw new Error("fixture page exceeds requested limit");
      return page ?? { data: [], cursor: {} };
    },
  };
  const history = new CrewHistory({
    sessions,
    messages,
    visible: (candidate) => candidate.id !== deny,
  });
  const add = (candidate: HistorySession) => {
    known.set(candidate.id, candidate);
    return candidate;
  };
  return {
    signal,
    calls,
    sessionPages,
    messagePages,
    known,
    sessions,
    messages,
    history,
    add,
    fail: () => {
      failure = true;
    },
    deny: (id: string) => {
      deny = id;
    },
  };
}

test("history narrow clients accept installed SDK API objects", () => {
  // Compile-time check only: no live SDK calls.
  const compatible = (client: OpenCodeClient) =>
    new CrewHistory({
      sessions: client.session,
      messages: client.message,
      visible: () => true,
    });
  expect(typeof compatible).toBe("function");
});

for (const operation of [
  "sessions",
  "messages",
  "search sessions",
  "search messages",
] as const)
  test(`${operation} continuations respect the cursor-bound API ordering`, async () => {
    const f = fixture();
    f.sessionPages.set("", {
      data: [f.add(session("one"))],
      cursor: operation === "search messages" ? {} : { next: "sessions-next" },
    });
    f.sessionPages.set("sessions-next", {
      data: [f.add(session("two"))],
      cursor: {},
    });
    f.messagePages.set("one:", {
      data: [user("first", "hit")],
      cursor: operation === "search sessions" ? {} : { next: "messages-next" },
    });
    f.messagePages.set("one:messages-next", {
      data: [user("second", "hit")],
      cursor: {},
    });
    if (operation === "sessions" || operation === "messages") {
      const input =
        operation === "sessions"
          ? ({ op: "sessions" } as const)
          : ({ op: "messages", sessionID: "one" } as const);
      const first = await f.history.run(input, f.signal);
      expect(first.partial).toBe(true);
      const next = await f.history.run(
        { ...input, cursor: first.cursor },
        f.signal,
      );
      expect(next.partial).toBe(false);
      return;
    }
    const result = await f.history.run(
      { op: "search", query: "hit" },
      f.signal,
    );
    expect(result.op).toBe("search");
    expect(result.partial).toBe(false);
    expect(
      f.calls.some((call) =>
        operation === "search sessions"
          ? call.method === "sessions" && call.cursor === "sessions-next"
          : call.method === "messages" && call.cursor === "messages-next",
      ),
    ).toBe(true);
  });

test("history validates bounded, literal inputs", () => {
  for (const input of [
    { op: "search", query: "" },
    { op: "search", query: " " },
    { op: "search", query: "x".repeat(201) },
    { op: "sessions", limit: 21 },
    { op: "sessions", limit: 0 },
    { op: "messages", sessionID: "x", cursor: "x".repeat(16385) },
    { op: "sessions", directory: "/foreign" },
  ])
    expect(historyInputSchema.safeParse(input).success).toBe(false);
  expect(
    historyInputSchema.safeParse({ op: "search", query: "[a.*" }).success,
  ).toBe(true);
});

test("session listing filters titles and visibility without exposing metadata", async () => {
  const f = fixture();
  f.sessionPages.set("", {
    data: [session("foreign", "Target"), session("one", "Other")],
    cursor: { next: "opaque session +/==" },
  });
  f.sessionPages.set("opaque session +/==", {
    data: [session("two", `TARGET ${"x".repeat(1000)}`)],
    cursor: {},
  });
  const first = await f.history.run(
    { op: "sessions", query: "target" },
    f.signal,
  );
  expect(first.op).toBe("sessions");
  if (first.op !== "sessions") throw new Error("wrong operation");
  expect(first.sessions).toEqual([]);
  expect(first.partial).toBe(true);
  expect(first.cursor).toBe("opaque session +/==");
  const next = await f.history.run(
    { op: "sessions", query: "target", cursor: first.cursor },
    f.signal,
  );
  if (next.op !== "sessions") throw new Error("wrong operation");
  expect(next.sessions[0]?.id).toBe("two");
  expect(next.sessions[0]?.title?.length).toBeLessThanOrEqual(256);
  expect(JSON.stringify(next)).not.toContain("credential");
  expect(JSON.stringify(next)).not.toContain("/project");
  expect(next.partial).toBe(false);
  expect(f.calls.every((call) => call.method === "sessions")).toBe(true);
});

test("targeted messages fetch metadata before reading and reject foreign sessions", async () => {
  const f = fixture();
  f.add(session("foreign"));
  await expect(
    f.history.run({ op: "messages", sessionID: "foreign" }, f.signal),
  ).rejects.toThrow("History session is not available.");
  expect(f.calls).toEqual([{ method: "get", sessionID: "foreign" }]);
  f.calls.length = 0;
  f.add(session("owned"));
  await f.history.run({ op: "messages", sessionID: "owned" }, f.signal);
  expect(f.calls.map((call) => call.method)).toEqual(["get", "messages"]);
});

test("messages expose only user/assistant text and preserve opaque page cursors", async () => {
  const f = fixture();
  f.add(session("owned"));
  const assistant = {
    id: "assistant",
    type: "assistant" as const,
    time: { created: 456 },
    content: [
      { type: "reasoning", text: "hidden reasoning" },
      { type: "tool", text: "raw tool secret", output: "credential" },
      { type: "text", text: "Public answer" },
    ],
    metadata: { settings: "private" },
  };
  f.messagePages.set("owned:", {
    data: [
      user("user", "Question"),
      assistant,
      {
        id: "system",
        type: "system",
        time: { created: 789 },
        text: "system prompt",
      },
      {
        id: "synthetic",
        type: "synthetic",
        time: { created: 789 },
        text: "synthetic instructions",
      },
    ],
    cursor: { next: "message /+ opaque==" },
  });
  f.messagePages.set("owned:message /+ opaque==", {
    data: [user("later", "LATER [a.*")],
    cursor: {},
  });
  const page = await f.history.run(
    { op: "messages", sessionID: "owned" },
    f.signal,
  );
  if (page.op !== "messages") throw new Error("wrong operation");
  expect(page.messages.map((message) => message.text)).toEqual([
    "Question",
    "Public answer",
  ]);
  expect(page.cursor).toBe("message /+ opaque==");
  expect(page.untrusted).toBe(true);
  const output = JSON.stringify(page);
  for (const secret of [
    "reasoning",
    "tool secret",
    "credential",
    "system prompt",
    "instructions",
    "settings",
  ])
    expect(output).not.toContain(secret);
  const next = await f.history.run(
    {
      op: "messages",
      sessionID: "owned",
      query: "later [a.*",
      cursor: page.cursor,
    },
    f.signal,
  );
  if (next.op !== "messages") throw new Error("wrong operation");
  expect(next.messages[0]?.id).toBe("later");
  expect(next.partial).toBe(false);
  expect(f.calls.slice(-2).map((call) => call.method)).toEqual([
    "get",
    "messages",
  ]);
});

test("search resumes at unscanned message pages and later sessions", async () => {
  const f = fixture();
  f.sessionPages.set("", {
    data: [f.add(session("one"))],
    cursor: { next: "next session /+==" },
  });
  f.sessionPages.set("next session /+==", {
    data: [f.add(session("two"))],
    cursor: {},
  });
  for (let page = 0; page < 8; page++) {
    const cursor = page === 0 ? "" : `message ${page} /+==`;
    f.messagePages.set(`one:${cursor}`, {
      data: [user(`m${page}`, page === 7 ? "LITERAL [a.* match" : "no match")],
      cursor: page === 7 ? {} : { next: `message ${page + 1} /+==` },
    });
  }
  f.messagePages.set("two:", {
    data: [user("two-hit", "literal [a.* match")],
    cursor: {},
  });
  const first = await f.history.run(
    { op: "search", query: "literal [a.*" },
    f.signal,
  );
  if (first.op !== "search") throw new Error("wrong operation");
  expect(first.matches).toEqual([]);
  expect(first.partial).toBe(true);
  expect(first.cursor).toBeDefined();
  const second = await f.history.run(
    { op: "search", query: "literal [a.*", cursor: first.cursor },
    f.signal,
  );
  if (second.op !== "search") throw new Error("wrong operation");
  expect(second.matches.map((match) => match.id)).toEqual(["m7", "two-hit"]);
  expect(second.partial).toBe(false);
  expect(second.cursor).toBeUndefined();
  expect(
    f.calls
      .filter((call) => call.method === "messages" && call.sessionID === "one")
      .map((call) => call.cursor ?? ""),
  ).toEqual([
    "",
    ...Array.from({ length: 7 }, (_, i) => `message ${i + 1} /+==`),
  ]);
});

test("search result limits continue without dropping pages or later matches", async () => {
  const f = fixture();
  f.sessionPages.set("", { data: [f.add(session("one"))], cursor: {} });
  f.messagePages.set("one:", {
    data: [user("a", "hit")],
    cursor: { next: "next" },
  });
  f.messagePages.set("one:next", { data: [user("b", "hit")], cursor: {} });
  const first = await f.history.run(
    { op: "search", query: "hit", limit: 1 },
    f.signal,
  );
  if (first.op !== "search") throw new Error("wrong operation");
  expect(first.matches.map((match) => match.id)).toEqual(["a"]);
  expect(first.partial).toBe(true);
  const next = await f.history.run(
    { op: "search", query: "hit", limit: 1, cursor: first.cursor },
    f.signal,
  );
  if (next.op !== "search") throw new Error("wrong operation");
  expect(next.matches.map((match) => match.id)).toEqual(["b"]);
  expect(next.partial).toBe(false);
});

test("search never fetches messages for foreign list entries or newly hidden metadata", async () => {
  const f = fixture();
  f.sessionPages.set("", {
    data: [session("foreign")],
    cursor: { next: "two" },
  });
  f.sessionPages.set("two", { data: [f.add(session("owned"))], cursor: {} });
  f.deny("foreign");
  const result = await f.history.run({ op: "search", query: "hit" }, f.signal);
  expect(result.partial).toBe(false);
  expect(f.calls.some((call) => call.sessionID === "foreign")).toBe(false);

  f.calls.length = 0;
  f.sessionPages.set("", { data: [session("owned")], cursor: {} });
  f.known.set("owned", { ...session("owned"), id: "foreign" });
  await f.history.run({ op: "search", query: "hit" }, f.signal);
  expect(f.calls.some((call) => call.method === "messages")).toBe(false);
});

test("search cursor cannot bypass visibility and is bound to its query", async () => {
  const f = fixture();
  f.sessionPages.set("", { data: [f.add(session("owned"))], cursor: {} });
  f.messagePages.set("owned:", {
    data: [user("a", "hit")],
    cursor: { next: "later" },
  });
  const first = await f.history.run(
    { op: "search", query: "hit", limit: 1 },
    f.signal,
  );
  await expect(
    f.history.run(
      { op: "search", query: "other", cursor: first.cursor },
      f.signal,
    ),
  ).rejects.toThrow("Invalid history cursor.");
  f.deny("owned");
  f.calls.length = 0;
  await f.history.run(
    { op: "search", query: "hit", cursor: first.cursor },
    f.signal,
  );
  expect(f.calls.some((call) => call.method === "messages")).toBe(false);
  await expect(
    f.history.run(
      { op: "search", query: "hit", cursor: "not a cursor" },
      f.signal,
    ),
  ).rejects.toThrow("Invalid history cursor.");
});

test("text is bounded and search excerpts contain matches beyond truncation", async () => {
  const f = fixture();
  f.add(session("one"));
  f.sessionPages.set("", { data: [session("one")], cursor: {} });
  f.messagePages.set("one:", {
    data: [user("long", `${"x".repeat(8000)} Needle ${"x".repeat(8000)}`)],
    cursor: {},
  });
  const page = await f.history.run(
    { op: "messages", sessionID: "one" },
    f.signal,
  );
  if (page.op !== "messages") throw new Error("wrong operation");
  expect(page.messages[0]?.text.length).toBeLessThanOrEqual(2000);
  expect(page.messages[0]?.truncated).toBe(true);
  const search = await f.history.run(
    { op: "search", query: "needle" },
    f.signal,
  );
  if (search.op !== "search") throw new Error("wrong operation");
  expect(search.matches[0]?.text).toContain("Needle");
  expect(search.matches[0]?.text.length).toBeLessThanOrEqual(2000);
  expect(JSON.stringify(search).length).toBeLessThan(5000);
});

test("API errors and cancellations have sanitized messages", async () => {
  const f = fixture();
  f.fail();
  await expect(f.history.run({ op: "sessions" }, f.signal)).rejects.toThrow(
    "History API request failed; raw details withheld.",
  );
  const controller = new AbortController();
  controller.abort(new Error("secret abort reason"));
  await expect(
    f.history.run({ op: "sessions" }, controller.signal),
  ).rejects.toThrow("History operation cancelled.");
  expect(f.calls).toHaveLength(1);

  const active = new AbortController();
  const history = new CrewHistory({
    visible: () => true,
    sessions: {
      async get() {
        return session("one");
      },
      async list(_input, request) {
        expect(request?.signal).toBe(active.signal);
        active.abort("secret reason");
        throw new Error("raw transport error");
      },
    },
    messages: f.messages,
  });
  await expect(history.run({ op: "sessions" }, active.signal)).rejects.toThrow(
    "History operation cancelled.",
  );
});
