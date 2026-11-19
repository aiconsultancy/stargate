import { expect, test } from "bun:test";
import { Schema } from "effect";
import { OpenCodeBackend } from "../src/backends/opencode";
import { backendSchema } from "../src/config";

const sessionID = "ses_fleet";
const messageID = "msg_assistant";
const inputID = "msg_human";
const expected = {
  agent: "configured-agent",
  id: "call_live",
  tool: "fleet_dispatch",
  input: {
    target: "captain",
    text: "Read the issue",
    sourceReference: "teams-original",
    requestID: "durable-request",
  },
};
type Changes = {
  id?: string;
  agent?: string;
  callID?: string;
  tool?: string;
  input?: unknown;
  status?: string;
  completed?: boolean;
  toolCompleted?: boolean;
  duplicate?: boolean;
  origin?: string;
  queued?: boolean;
  laterInput?: boolean;
  busy?: boolean;
};

function fixture(changes: Changes = {}) {
  const calls: string[] = [];
  const tool = {
    type: "tool",
    id: changes.callID ?? expected.id,
    name: changes.tool ?? expected.tool,
    state: {
      status: changes.status ?? "running",
      input: changes.input ?? expected.input,
      metadata: {},
    },
    time: {
      created: 2,
      ran: 3,
      ...(changes.toolCompleted ? { completed: 4 } : {}),
    },
  };
  const message = {
    id: changes.id ?? messageID,
    type: "assistant",
    agent: changes.agent ?? expected.agent,
    model: { providerID: "provider", id: "model" },
    time: { created: 2, ...(changes.completed ? { completed: 4 } : {}) },
    content: changes.duplicate ? [tool, tool] : [tool],
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(path);
      if (path === `/api/session/${sessionID}`)
        return Response.json({
          data: {
            id: sessionID,
            time: {
              created: 0,
              updated: 10,
              busy: 1,
              ...(changes.busy ? {} : { idle: 10 }),
            },
          },
        });
      if (path === `/api/session/${sessionID}/message/${messageID}`)
        return Response.json({ data: message });
      if (path === `/api/session/${sessionID}/inbox`)
        return Response.json({ data: changes.queued ? [{ id: inputID }] : [] });
      if (path === `/api/session/${sessionID}/message`)
        return Response.json({
          data: [
            ...(changes.laterInput
              ? [
                  {
                    ...message,
                    id: "later-assistant",
                    agent: "other-agent",
                    model: { providerID: "other-provider", id: "other-model" },
                    time: { created: 6, completed: 7 },
                  },
                  {
                    id: "later-human",
                    type: "user",
                    time: { created: 5 },
                    text: "Different request",
                  },
                ]
              : []),
            message,
            {
              id: changes.origin ?? inputID,
              type: "user",
              time: { created: 1 },
              text: "Human instruction",
            },
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
    sessionID,
  });
  if (config.type !== "opencode") throw new Error("Invalid native fixture");
  const backend = new OpenCodeBackend(config);
  return {
    calls,
    backend,
    check: () =>
      backend.toolBelongsToInput(
        sessionID,
        messageID,
        inputID,
        new AbortController().signal,
        expected,
      ),
    async close() {
      await backend.close();
      await server.stop(true);
    },
  };
}

test("live native tool correlation requires exact agent/call/name/full input and original human input", async () => {
  const f = fixture({
    input: {
      requestID: "durable-request",
      sourceReference: "teams-original",
      text: "Read the issue",
      target: "captain",
    },
  });
  try {
    expect(await f.check()).toBe(true);
    expect(f.calls).toEqual([
      `/api/session/${sessionID}/message/${messageID}`,
      `/api/session/${sessionID}/inbox`,
      `/api/session/${sessionID}/message`,
    ]);
  } finally {
    await f.close();
  }
});

test("fleet makers are read from exact settled native input, excluding a later request", async () => {
  const f = fixture({ completed: true, laterInput: true });
  try {
    expect(
      await f.backend.executionMakers(
        sessionID,
        inputID,
        new AbortController().signal,
      ),
    ).toEqual([
      {
        messageID,
        agent: expected.agent,
        provider: "provider",
        model: "model",
      },
    ]);
    const count = f.calls.length;
    await expect(
      f.backend.executionMakers(
        "foreign-session",
        inputID,
        new AbortController().signal,
      ),
    ).rejects.toThrow("not pinned");
    expect(f.calls).toHaveLength(count);
    await expect(
      f.backend.executionMakers(
        sessionID,
        messageID,
        new AbortController().signal,
      ),
    ).rejects.toThrow("request boundary");
  } finally {
    await f.close();
  }
});

test("missing or unsettled native maker evidence fails closed", async () => {
  for (const changes of [{ origin: "another-input" }, { busy: true }]) {
    const f = fixture(changes);
    try {
      await expect(
        f.backend.executionMakers(
          sessionID,
          inputID,
          new AbortController().signal,
        ),
      ).rejects.toThrow();
    } finally {
      await f.close();
    }
  }
});

test("mismatched native actor, call, tool, payload and completed/ambiguous calls are refused", async () => {
  const cases: Changes[] = [
    { id: "msg_other" },
    { agent: "other-agent" },
    { callID: "call_other" },
    { tool: "fleet_status" },
    { input: { ...expected.input, target: "other-captain" } },
    { input: { ...expected.input, extra: "not in the requested payload" } },
    { input: { ...expected.input, requestID: "another-request" } },
    { status: "completed" },
    { status: "streaming" },
    { status: "error" },
    { completed: true },
    { toolCompleted: true },
    { duplicate: true },
  ];
  for (const changes of cases) {
    const f = fixture(changes);
    try {
      expect(await f.check()).toBe(false);
      expect(f.calls).toHaveLength(1);
    } finally {
      await f.close();
    }
  }
});

test("a matching live call still requires delivered native input ancestry", async () => {
  for (const changes of [{ origin: "msg_different" }, { queued: true }]) {
    const f = fixture(changes);
    try {
      expect(await f.check()).toBe(false);
    } finally {
      await f.close();
    }
  }
});

test("a foreign pinned root cannot use a native tool call from this backend", async () => {
  const f = fixture();
  try {
    expect(
      await f.backend.toolBelongsToInput(
        "ses_other",
        messageID,
        inputID,
        new AbortController().signal,
        expected,
      ),
    ).toBe(false);
    expect(f.calls).toEqual([]);
  } finally {
    await f.close();
  }
});
