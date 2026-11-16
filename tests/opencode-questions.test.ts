import { afterEach, expect, test } from "bun:test";
import { OpenCodeBackend } from "../src/backends/opencode";
import { backendSchema } from "../src/config";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const session = "ses_questions";
const input = "msg_original";
const assistant = "msg_question";
const formID = "frm_question";

function fixture() {
  const form = {
    id: formID,
    sessionID: session,
    title: "Choose next step",
    metadata: {
      kind: "question",
      tool: { messageID: assistant, id: "call_question" },
    },
    fields: [
      {
        key: "q0",
        type: "string",
        title: "Next step",
        description: "Wait or continue?",
        required: true,
        options: [
          { value: "wait", label: "Wait" },
          { value: "continue", label: "Continue" },
        ],
        custom: false,
      },
    ],
    state: { status: "pending" },
  };
  const tool = {
    type: "tool",
    id: "call_question",
    name: "question",
    executed: true,
    state: { status: "running", input: { questions: [] }, metadata: {} },
    time: { created: 2, ran: 3 },
  };
  const message = {
    id: assistant,
    type: "assistant",
    agent: "build",
    model: { providerID: "fixture", id: "model" },
    time: { created: 2 },
    content: [tool],
  };
  let origin = input;
  let queued = false;
  let idle = false;
  let laterInput = false;
  let failWrite = false;
  const writes: { method: string; path: string; body: unknown }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (
        path === `/api/session/${session}/form/${formID}` &&
        request.method === "GET"
      )
        return Response.json({ data: form });
      if (path === `/api/session/${session}/form`)
        return Response.json({ data: [form] });
      if (
        (path.endsWith(`/${formID}/reply`) && request.method === "POST") ||
        (path.endsWith(`/${formID}`) && request.method === "DELETE")
      ) {
        writes.push({
          method: request.method,
          path,
          body: request.method === "POST" ? await request.json() : null,
        });
        if (failWrite) return new Response(null, { status: 409 });
        form.state.status =
          request.method === "DELETE" ? "cancelled" : "answered";
        return new Response(null, { status: 204 });
      }
      if (path === `/api/session/${session}/message/${assistant}`)
        return Response.json({ data: message });
      if (path === `/api/session/${session}/message/${input}`)
        return Response.json({
          data: {
            id: input,
            type: "user",
            text: "Original request",
            time: { created: 1 },
          },
        });
      if (path === `/api/session/${session}/message`)
        return Response.json({
          data: [
            ...(laterInput
              ? [
                  {
                    id: "msg_later",
                    type: "user",
                    text: "Intervening request",
                    time: { created: 4 },
                  },
                ]
              : []),
            message,
            {
              id: origin,
              type: "user",
              text: "Original request",
              time: { created: 1 },
            },
          ],
          cursor: {},
        });
      if (path === `/api/session/${session}/inbox`)
        return Response.json({ data: queued ? [{ id: input }] : [] });
      if (path === "/api/session/active")
        return Response.json({
          data: idle ? {} : { [session]: { status: "busy" } },
        });
      if (path === `/api/session/${session}`)
        return Response.json({
          data: {
            id: session,
            time: {
              created: 0,
              updated: 4,
              busy: 2,
              ...(idle ? { idle: 4 } : {}),
            },
          },
        });
      return new Response(null, { status: 404 });
    },
  });
  const config = backendSchema.parse({
    type: "opencode",
    url: server.url.href,
    directory: "/workspace",
    sessionID: session,
  });
  if (config.type !== "opencode") throw new Error("Invalid native fixture");
  const backend = new OpenCodeBackend(config);
  cleanup.push(() => server.stop(true));
  return {
    backend,
    form,
    tool,
    message,
    writes,
    origin(value: string) {
      origin = value;
    },
    queued(value: boolean) {
      queued = value;
    },
    idle(value: boolean) {
      idle = value;
    },
    later(value: boolean) {
      laterInput = value;
    },
    failWrite() {
      failWrite = true;
    },
    list: () => backend.pendingQuestions(session, AbortSignal.timeout(3000)),
  };
}

test("native questions bind exact form, running tool and delivered input, never a later human", async () => {
  const f = fixture();
  f.later(true);
  const questions = await f.list();
  expect(questions).toHaveLength(1);
  const q = questions[0];
  if (!q) throw new Error("Missing native question");
  expect(q).toMatchObject({
    id: formID,
    sessionID: session,
    inputID: input,
    toolMessageID: assistant,
    toolCallID: "call_question",
  });
  expect(
    await f.backend.questionBelongsToInput(
      session,
      formID,
      "msg_later",
      q.fingerprint,
      AbortSignal.timeout(3000),
    ),
  ).toBe(false);
  await f.backend.replyQuestion(q, { q0: "wait" }, AbortSignal.timeout(3000));
  expect(f.writes).toEqual([
    {
      method: "POST",
      path: `/api/session/${session}/form/${formID}/reply`,
      body: { answer: { q0: "wait" } },
    },
  ]);
  expect(await f.list()).toEqual([]);
  await expect(
    f.backend.replyQuestion(q, { q0: "continue" }, AbortSignal.timeout(3000)),
  ).rejects.toThrow("stale");
  expect(f.writes).toHaveLength(1);
});

test("native cancellation uses form cancel, with no prompt or permission endpoint", async () => {
  const f = fixture();
  const q = (await f.list())[0];
  if (!q) throw new Error("Missing question");
  await f.backend.replyQuestion(q, null, AbortSignal.timeout(3000));
  expect(f.writes).toEqual([
    {
      method: "DELETE",
      path: `/api/session/${session}/form/${formID}`,
      body: null,
    },
  ]);
});

for (const change of [
  "session",
  "auth",
  "tool-id",
  "tool-name",
  "completed-tool",
  "completed-form",
  "queued-input",
  "hidden",
  "default",
  "sensitive",
] as const) {
  test(`native question rejects ${change} instead of guessing ownership or an answer`, async () => {
    const f = fixture();
    switch (change) {
      case "session":
        f.form.sessionID = "ses_other";
        break;
      case "auth":
        f.form.metadata.kind = "authentication";
        break;
      case "tool-id":
        f.tool.id = "call_other";
        break;
      case "tool-name":
        f.tool.name = "bash";
        break;
      case "completed-tool":
        f.tool.state.status = "completed";
        break;
      case "completed-form":
        f.form.state.status = "cancelled";
        break;
      case "queued-input":
        f.queued(true);
        break;
      case "hidden":
        Object.assign(f.form.fields[0] ?? {}, { hidden: true });
        break;
      case "default":
        Object.assign(f.form.fields[0] ?? {}, { default: "continue" });
        break;
      case "sensitive":
        f.form.title = "Supply your API key";
        break;
    }
    expect(await f.list()).toEqual([]);
    expect(f.writes).toHaveLength(0);
  });
}

test("native form mutation or already-completed race cannot reuse an earlier question", async () => {
  const f = fixture();
  const q = (await f.list())[0];
  if (!q) throw new Error("Missing question");
  f.form.title = "Different question";
  expect(
    await f.backend.questionBelongsToInput(
      session,
      formID,
      input,
      q.fingerprint,
      AbortSignal.timeout(3000),
    ),
  ).toBe(false);
  await expect(
    f.backend.replyQuestion(q, { q0: "wait" }, AbortSignal.timeout(3000)),
  ).rejects.toThrow("stale");
  expect(f.writes).toHaveLength(0);
});

test("recovery release requires native idle, delivered input and no queued copy", async () => {
  const f = fixture();
  const signal = AbortSignal.timeout(3000);
  expect(await f.backend.questionInputSettled(session, input, signal)).toBe(
    false,
  );
  f.idle(true);
  f.queued(true);
  expect(await f.backend.questionInputSettled(session, input, signal)).toBe(
    false,
  );
  f.queued(false);
  expect(await f.backend.questionInputSettled(session, input, signal)).toBe(
    true,
  );
  expect(await f.backend.pendingQuestions("ses_other", signal)).toEqual([]);
});
