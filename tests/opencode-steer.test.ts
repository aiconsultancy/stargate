import { afterEach, expect, test } from "bun:test";
import { Schema } from "effect";
import pino from "pino";
import type { SteerInput } from "../src/backend";
import { OpenCodeBackend } from "../src/backends/opencode";
import { backendSchema } from "../src/config";
import { crewMessageMetadataKey } from "../src/crew/message-protocol";
import { Gateway } from "../src/gateway";
import { Store } from "../src/store";
import { bot, event, identity } from "./fixtures";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const sessionID = "ses_captain";
const original = "msg_original";

function fixture() {
  let idle = false;
  let foreign = false;
  let queued = false;
  let form = false;
  let permission = false;
  let failWrite = false;
  let loseReceipt = false;
  let pendingDelivery = false;
  let local = true;
  let promptID = original;
  let synthetic:
    | {
        readonly id: string;
        readonly text: string;
        readonly metadata: { readonly [key: string]: unknown };
      }
    | undefined;
  let pendingSynthetic: typeof synthetic;
  const writes: Record<string, unknown>[] = [];
  const submitted = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const messages = () => [
    ...(idle
      ? [
          {
            id: "msg_final",
            type: "assistant",
            time: { created: 5, completed: 6 },
            content: [{ type: "text", text: "Revised scope complete" }],
            agent: "build",
            model: { id: "fixture", providerID: "fixture" },
          },
        ]
      : []),
    ...(foreign
      ? [
          {
            id: "msg_foreign",
            type: "user",
            time: { created: 4 },
            text: "Other source",
          },
        ]
      : []),
    ...(synthetic
      ? [
          {
            ...synthetic,
            type: "synthetic",
            description: "Thread follow-up",
            time: { created: 3 },
          },
        ]
      : []),
    {
      id: promptID,
      type: "user",
      time: { created: 1 },
      text: "Original request",
    },
  ];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === `/api/session/${sessionID}/form`)
        return Response.json({
          data: form ? [{ id: "frm_1", sessionID }] : [],
        });
      if (path.endsWith("/form/frm_1"))
        return Response.json({ data: { state: { status: "pending" } } });
      if (path === `/api/session/${sessionID}/permission`)
        return Response.json({
          data: permission ? [{ id: "perm_1", sessionID }] : [],
        });
      if (path === `/api/session/${sessionID}/inbox`)
        return Response.json({ data: queued ? [{ id: promptID }] : [] });
      if (path === "/api/session/active")
        return Response.json({
          data: idle ? {} : { [sessionID]: { type: "running" } },
        });
      if (path === `/api/session/${sessionID}`)
        return Response.json({
          data: {
            id: sessionID,
            location: { directory: "/workspace" },
            permissions: [{ action: "*", resource: "*", effect: "deny" }],
            time: { busy: 1, ...(idle ? { idle: 9 } : {}) },
          },
        });
      if (path === `/api/session/${sessionID}/message`)
        return Response.json({ data: messages(), cursor: {} });
      if (path.startsWith(`/api/session/${sessionID}/message/`)) {
        const message = messages().find(
          (item) => item.id === path.split("/").at(-1),
        );
        return message
          ? Response.json({ data: message })
          : new Response(null, { status: 404 });
      }
      if (path === `/api/session/${sessionID}/synthetic`) {
        const body = (await request.json()) as Record<string, unknown>;
        writes.push(body);
        pendingSynthetic = Schema.decodeUnknownSync(
          Schema.Struct({
            id: Schema.String,
            text: Schema.String,
            metadata: Schema.Record(Schema.String, Schema.Unknown),
          }),
        )(body);
        if (!failWrite && !pendingDelivery)
          synthetic = Schema.decodeUnknownSync(
            Schema.Struct({
              id: Schema.String,
              text: Schema.String,
              metadata: Schema.Record(Schema.String, Schema.Unknown),
            }),
          )(body);
        if (failWrite || loseReceipt)
          return new Response(null, { status: 500 });
        return Response.json({
          data: {
            ...body,
            sessionID,
            type: "synthetic",
            time: { created: 3 },
            payload: body,
          },
        });
      }
      if (path === `/api/session/${sessionID}/prompt`) {
        const body = (await request.json()) as { id: string };
        promptID = body.id;
        submitted.resolve();
        return Response.json({ data: { id: body.id, sessionID } });
      }
      if (path === `/api/experimental/session/${sessionID}/wait`) {
        await finished.promise;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    },
  });
  cleanup.push(() => server.stop(true));
  const config = Schema.decodeUnknownSync(backendSchema)({
    type: "opencode",
    url: server.url.href,
    directory: "/workspace",
    sessionID,
  });
  if (config.type !== "opencode") throw new Error("Expected OpenCode");
  const backend = new OpenCodeBackend(config);
  const input: SteerInput = {
    sessionID,
    inputID: original,
    id: "msg_followup",
    text: "Revised scope",
    context: {
      source: {
        channel: "C123",
        thread: "1.000",
        message: "2.000",
        user: "U123",
      },
    },
    allowed: () => local,
  };
  return {
    backend,
    config,
    input,
    writes,
    submitted,
    set(
      value:
        | "idle"
        | "foreign"
        | "queued"
        | "form"
        | "permission"
        | "failWrite"
        | "loseReceipt"
        | "pendingDelivery"
        | "local",
    ) {
      if (value === "idle") idle = true;
      if (value === "foreign") foreign = true;
      if (value === "queued") queued = true;
      if (value === "form") form = true;
      if (value === "permission") permission = true;
      if (value === "failWrite") failWrite = true;
      if (value === "loseReceipt") loseReceipt = true;
      if (value === "pendingDelivery") pendingDelivery = true;
      if (value === "local") local = false;
    },
    finish() {
      synthetic ??= pendingSynthetic;
      idle = true;
      finished.resolve();
    },
  };
}

test("OpenCode steers through the supported synthetic API with original-input attribution", async () => {
  const f = fixture();
  expect(await f.backend.steer(f.input, AbortSignal.timeout(3000))).toEqual({
    status: "accepted",
  });
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]).toMatchObject({
    id: "msg_followup",
    delivery: "steer",
    resume: false,
    metadata: {
      [crewMessageMetadataKey]: {
        originCaptainID: sessionID,
        originInputID: original,
      },
    },
  });
  f.finish();
  const transcript = await f.backend.transcript(
    sessionID,
    original,
    AbortSignal.timeout(3000),
  );
  expect(transcript.entries).toEqual([
    {
      id: "msg_final",
      text: "Revised scope complete",
      created: 5,
      input: original,
    },
  ]);
});

test("OpenCode refuses idle, foreign, prompt-pending, form, permission and lost local ownership before writing", async () => {
  for (const state of [
    "idle",
    "foreign",
    "queued",
    "form",
    "permission",
    "local",
  ] as const) {
    const f = fixture();
    f.set(state);
    expect(await f.backend.steer(f.input, AbortSignal.timeout(3000))).toEqual({
      status: "refused",
    });
    expect(f.writes).toEqual([]);
  }
});

test("lost native response reconciles delivered synthetic evidence, missing evidence stays uncertain", async () => {
  for (const state of ["loseReceipt", "failWrite"] as const) {
    const f = fixture();
    f.set(state);
    expect(await f.backend.steer(f.input, AbortSignal.timeout(3000))).toEqual({
      status: state === "loseReceipt" ? "accepted" : "uncertain",
    });
    expect(
      await f.backend.reconcileSteer(f.input, AbortSignal.timeout(3000)),
    ).toEqual({ status: state === "loseReceipt" ? "accepted" : "uncertain" });
    expect(f.writes).toHaveLength(1);
  }
});

test("native inbox acceptance alone does not claim the running turn received a follow-up", async () => {
  const f = fixture();
  f.set("pendingDelivery");
  expect(await f.backend.steer(f.input, AbortSignal.timeout(3000))).toEqual({
    status: "uncertain",
  });
  expect(f.writes).toHaveLength(1);
});

for (const delayed of [false, true])
  test(`real OpenCode synthetic boundary keeps final gateway answer and link on original thread, delayed=${delayed}`, async () => {
    const f = fixture();
    if (delayed) f.set("pendingDelivery");
    const config = bot();
    config.backend = f.config;
    config.slack.steerThreadFollowUps = true;
    config.waiting.delayMs = null;
    const store = new Store(":memory:");
    cleanup.push(() => store.close());
    const posts: { thread: string; text: string }[] = [];
    // Keep optional maintenance/activity RPCs outside this native input fixture.
    const backend = {
      sessionID,
      createSession: () => Promise.resolve(sessionID),
      prompt: f.backend.prompt.bind(f.backend),
      transcript: f.backend.transcript.bind(f.backend),
      steer: f.backend.steer.bind(f.backend),
      reconcileSteer: f.backend.reconcileSteer.bind(f.backend),
      close: async () => {},
    };
    const gateway = new Gateway(
      config,
      identity,
      store,
      backend,
      {
        post: async (_channel, thread, text) => {
          posts.push({ thread, text });
        },
      },
      pino({ enabled: false }),
    );
    gateway.accept(event());
    const job = store.ready(gateway.key, Date.now(), 1, true)[0];
    if (!job) throw new Error("Missing original job");
    const process = gateway.process(job, AbortSignal.timeout(5000));
    await f.submitted.promise;
    const follow = event("<@UBOT> revised scope", "2.000");
    gateway.accept({
      ...follow,
      event: { ...follow.event, type: "message", thread_ts: "1.000" },
    });
    await gateway.pollFollowUps(AbortSignal.timeout(3000));
    f.finish();
    await process;
    const answers = posts.filter((post) =>
      post.text.includes("Revised scope complete"),
    );
    expect(answers).toHaveLength(1);
    expect(answers[0]).toEqual({
      thread: "1.000",
      text: expect.stringContaining("Revised scope complete"),
    });
    expect(answers[0]?.text).toContain("https://slack.com/archives/C123/p2000");
    expect(store.queueCounts(gateway.key)).toMatchObject({
      queued: 0,
      done: 1,
    });
  });
