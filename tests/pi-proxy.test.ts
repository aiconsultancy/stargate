import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  BACKGROUND_CONTEXT,
  type Context,
} from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type ConversationId,
  createRegistry,
  GenerationTask,
  Harness,
  InboxDoc,
  LiveDoc,
  type Submission,
  type SubmissionDraft,
  type Tx,
  UserEntry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Schema } from "effect";
import { PiDurableBackend } from "../src/backends/pi/pi-durable";
import { piCrewBackendSchema, piDurableBackendSchema } from "../src/config";
import { PiCrewWorkers, type PiWorkerFactory } from "../src/crew/pi/pi-worker";
import { CrewState, type CrewTask } from "../src/crew/execution/state";
import { teamSchema } from "../src/crew/team";
import { BackendFailure } from "../src/shared/request-failure";
import { fixtureRoot } from "./fixture-root";

const apiKeyEnv = "STARGATE_PI_PROXY_TEST_KEY";
const model = "openai/opencode-go/deepseek-v4.1-flash";
const signal = () => new AbortController().signal;

function config(baseURL: string, directory = "/workspace") {
  return Schema.decodeUnknownSync(piDurableBackendSchema)({
    type: "pi-durable",
    directory,
    model,
    provider: { baseURL, apiKeyEnv },
    tools: "coding",
  });
}

test("Pi proxy configuration validates endpoint and environment references", () => {
  for (const baseURL of [
    "http://127.0.0.1:8317/v1",
    "http://127.0.0.2/v1",
    "http://localhost/v1",
    "http://[::1]/v1",
    "https://proxy.example/v1",
  ]) {
    expect(config(baseURL).provider?.baseURL).toBe(baseURL);
  }

  for (const baseURL of [
    "http://proxy.example/v1",
    "http://127.0.0.1.example/v1",
    "ftp://127.0.0.1/v1",
    "https://user:password@proxy.example/v1",
    "https://proxy.example/v1?key=secret",
    "https://proxy.example/v1#secret",
    "https://proxy.example/v1?",
    "https://proxy.example/v1#",
  ]) {
    expect(() => config(baseURL)).toThrow();
  }

  const valid = config("http://127.0.0.1/v1");
  expect(() =>
    Schema.decodeUnknownSync(piDurableBackendSchema)({
      ...valid,
      provider: { baseURL: valid.provider?.baseURL, apiKey: "raw-secret" },
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(piDurableBackendSchema)({
      ...valid,
      provider: { baseURL: valid.provider?.baseURL, apiKeyEnv: "raw-key" },
    }),
  ).toThrow();
  const { directory: _, ...worker } = valid;
  expect(Schema.decodeUnknownSync(piCrewBackendSchema)(worker)).toEqual(worker);
});

function completion(text = "Proxy answer") {
  const chunk = (delta: object, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({
      id: "fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "opencode-go/deepseek-v4.1-flash",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;

  return new Response(
    chunk({ role: "assistant", reasoning_content: "PRIVATE" }) +
      chunk({ content: text }) +
      chunk({}, "stop") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("Pi proxy sends chat tools, safe auth and persisted conversation headers", async () => {
  const directory = await mkdtemp(join(fixtureRoot(), "stargate-pi-proxy-"));
  const previous = process.env[apiKeyEnv];
  process.env[apiKeyEnv] = "local-proxy-test-only";

  const requests: {
    path: string;
    headers: Headers;
    body: Record<string, unknown>;
  }[] = [];

  let denied = false;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: await request.json(),
      });

      if (denied)
        return Response.json(
          {
            error: {
              message: "Fixture authentication failed",
              type: "authentication_error",
            },
          },
          { status: 401 },
        );

      return completion();
    },
  });

  let backend: PiDurableBackend | undefined;

  try {
    const settings = config(new URL("/v1", server.url).href, directory);
    backend = await PiDurableBackend.open(settings, {
      dataDirectory: directory,
    });

    const first = await backend.createSession({
      key: "one",
      title: "one",
      signal: signal(),
    });

    const requestID = crypto.randomUUID();
    let recordedInput: string | undefined;
    expect(
      await backend.prompt(
        first,
        "hello",
        signal(),
        undefined,
        (id) => {
          recordedInput = id;
          expect(requests).toHaveLength(0);
        },
        requestID,
      ),
    ).toBe("Proxy answer");
    expect(recordedInput).toBe(requestID);
    expect(await backend.prompt(first, "again", signal())).toBe("Proxy answer");

    const second = await backend.createSession({
      key: "two",
      title: "two",
      signal: signal(),
    });

    expect(await backend.prompt(second, "hello", signal())).toBe(
      "Proxy answer",
    );
    await backend.close();
    backend = await PiDurableBackend.open(settings, {
      dataDirectory: directory,
    });
    expect(await backend.prompt(first, "after restart", signal())).toBe(
      "Proxy answer",
    );
    expect(requests).toHaveLength(4);

    for (const request of requests) {
      expect(request.path).toBe("/v1/chat/completions");
      expect(request.headers.get("authorization")).toBe(
        "Bearer local-proxy-test-only",
      );
      expect(request.headers.get("user-agent")).toBe("Stargate/0.1.0");
      expect(request.body["model"]).toBe("opencode-go/deepseek-v4.1-flash");
      expect(request.body["stream"]).toBe(true);
      expect(request.body["max_tokens"]).toBeGreaterThan(0);
      expect(request.body["tools"]).toBeArray();
      expect((request.body["tools"] as unknown[]).length).toBeGreaterThan(0);
      expect(request.body["store"]).toBeUndefined();
    }

    const ids = requests.map((request) =>
      request.headers.get("x-opencode-session"),
    );

    expect(ids[0]).toMatch(/^[a-f0-9-]{36}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(ids[3]).toBe(ids[0]);
    expect(JSON.stringify(requests[1]?.body["messages"])).toContain(
      "reasoning_content",
    );
    denied = true;
    await expect(backend.prompt(first, "denied", signal())).rejects.toThrow();
    expect(requests).toHaveLength(5);
  } finally {
    await backend?.close();
    await server.stop(true);

    if (previous === undefined) delete process.env[apiKeyEnv];
    else process.env[apiKeyEnv] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Pi proxy fails closed on missing auth or unsupported model", async () => {
  const settings = config("http://127.0.0.1:1/v1");
  await expect(
    PiDurableBackend.open(
      {
        ...settings,
        provider: {
          ...settings.provider,
          baseURL: "http://127.0.0.1:1/v1",
          apiKeyEnv: "STARGATE_PI_PROXY_MISSING_KEY",
        },
      },
      { dataDirectory: "/unused" },
    ),
  ).rejects.toThrow(
    "Missing environment variable: STARGATE_PI_PROXY_MISSING_KEY",
  );
  await expect(
    PiDurableBackend.open(
      { ...settings, model: "openai/gpt-5" },
      { dataDirectory: "/unused" },
    ),
  ).rejects.toThrow("Pi proxy requires model");
  const { provider: _, ...withoutProxy } = settings;
  await expect(
    PiDurableBackend.open(withoutProxy, { dataDirectory: "/unused" }),
  ).rejects.toThrow("requires provider configuration");
});

test("Pi cancellation closes the underlying proxy stream", async () => {
  const directory = await mkdtemp(join(fixtureRoot(), "stargate-pi-cancel-"));
  const previous = process.env[apiKeyEnv];
  process.env[apiKeyEnv] = "local-proxy-test-only";
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      await request.text();
      request.signal.addEventListener("abort", () => cancelled.resolve(), {
        once: true,
      });

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": connected\n\n"));
            started.resolve();
          },
          cancel() {
            cancelled.resolve();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });

  let backend: PiDurableBackend | undefined;

  try {
    backend = await PiDurableBackend.open(
      config(new URL("/v1", server.url).href, directory),
      { dataDirectory: directory },
    );

    const session = await backend.createSession({
      key: "cancel",
      title: "cancel",
      signal: signal(),
    });

    const controller = new AbortController();
    const pending = backend.prompt(session, "hello", controller.signal);

    await started.promise;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await cancelled.promise;
  } finally {
    await backend?.close();
    await server.stop(true);

    if (previous === undefined) delete process.env[apiKeyEnv];
    else process.env[apiKeyEnv] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

for (const cancelQueued of [false, true]) {
  test(
    cancelQueued
      ? "Pi queued cancellation preserves the prior native run"
      : "Pi queued follow-up streams and returns only its own answer",
    async () => {
      const directory = await mkdtemp(
        join(fixtureRoot(), "stargate-pi-follow-up-"),
      );

      const previous = process.env[apiKeyEnv];
      process.env[apiKeyEnv] = "local-proxy-test-only";
      const priorStarted = Promise.withResolvers<void>();
      const ownStarted = Promise.withResolvers<void>();
      const queued = Promise.withResolvers<void>();
      const ownPartial = Promise.withResolvers<void>();
      const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
      let priorCancelled = false;
      let requests = 0;
      const encoder = new TextEncoder();

      const chunk = (content: string, finish_reason: string | null = null) =>
        encoder.encode(
          `data: ${JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "opencode-go/deepseek-v4.1-flash",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content },
                finish_reason,
              },
            ],
          })}\n\n`,
        );

      const finish = (index: number, text: string) => {
        const stream = streams[index];

        if (!stream) throw new Error("Fixture provider is not connected");
        stream.enqueue(chunk(text, "stop"));
        stream.enqueue(encoder.encode("data: [DONE]\n\n"));
        stream.close();
      };

      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          await request.text();
          const index = requests++;
          request.signal.addEventListener(
            "abort",
            () => {
              if (index === 0) priorCancelled = true;
            },
            { once: true },
          );

          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streams[index] = controller;
                controller.enqueue(
                  chunk(index === 0 ? "PRIOR LIVE " : "OWN PARTIAL "),
                );
                (index === 0 ? priorStarted : ownStarted).resolve();
              },
              cancel() {
                if (index === 0) priorCancelled = true;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });

      let backend: PiDurableBackend | undefined;
      let pending: Promise<string> | undefined;
      const controller = new AbortController();

      try {
        backend = await PiDurableBackend.open(
          config(new URL("/v1", server.url).href, directory),
          { dataDirectory: directory },
        );

        const session = await backend.createSession({
          key: "native",
          title: "native",
          signal: signal(),
        });

        // Reuse this backend's real harness, not a competing storage owner.
        const harness: Harness = Reflect.get(backend, "harness");

        const conversation = await harness.conversation(
          Number(session) as ConversationId,
          BACKGROUND_CONTEXT,
        );

        if (!conversation) throw new Error("Fixture conversation is missing");

        const native = await conversation.submit(
          { type: "input", content: "Prior native request" },
          BACKGROUND_CONTEXT,
        );

        await priorStarted.promise;

        const observation = harness.observeCommits({
          advance(publication) {
            for (const change of publication.changes) {
              if (
                change.type === "submission" &&
                change.value.status === "queued"
              )
                queued.resolve();
            }
          },
          end() {},
        });

        const snapshots: string[] = [];
        pending = backend.prompt(
          session,
          "Own follow-up",
          controller.signal,
          (text) => {
            snapshots.push(text);

            if (text.includes("OWN PARTIAL")) ownPartial.resolve();
          },
        );
        await queued.promise;
        observation.detach();

        if (cancelQueued) {
          controller.abort();
          await expect(pending).rejects.toThrow();
          expect(priorCancelled).toBe(false);
        }

        finish(0, "PRIOR COMMITTED");
        expect((await native.wait(BACKGROUND_CONTEXT)).status).toBe("done");

        if (cancelQueued) {
          await conversation.waitForIdle(BACKGROUND_CONTEXT);
          expect(requests).toBe(1);
        } else {
          await ownStarted.promise;
          await ownPartial.promise;
          finish(1, "OWN FINAL");
          expect(await pending).toBe("OWN PARTIAL OWN FINAL");
          expect(snapshots.length).toBeGreaterThan(0);
        }

        expect(snapshots.join("\n")).not.toContain("PRIOR");
      } finally {
        controller.abort();
        await pending?.catch(() => {});
        await backend?.close();
        await server.stop(true);

        if (previous === undefined) delete process.env[apiKeyEnv];
        else process.env[apiKeyEnv] = previous;
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

for (const placement of ["queued", "placed", "unreadable"] as const) {
  for (const aborted of [false, true]) {
    test(`Pi recovers ${placement} admission after ${aborted ? "abort" : "lost handle"}`, async () => {
      const directory = await mkdtemp(
        join(fixtureRoot(), "stargate-pi-admission-"),
      );

      const previous = process.env[apiKeyEnv];
      process.env[apiKeyEnv] = "local-proxy-test-only";
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let providerAborted = false;

      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          await request.text();
          request.signal.addEventListener(
            "abort",
            () => {
              providerAborted = true;
            },
            { once: true },
          );
          started.resolve();
          await release.promise;

          return completion();
        },
      });

      let backend: PiDurableBackend | undefined;

      try {
        backend = await PiDurableBackend.open(
          config(new URL("/v1", server.url).href, directory),
          { dataDirectory: directory },
        );

        const session = await backend.createSession({
          key: "admission",
          title: "admission",
          signal: signal(),
        });

        const harness: Harness = Reflect.get(backend, "harness");

        const conversation = await harness.conversation(
          Number(session) as ConversationId,
          BACKGROUND_CONTEXT,
        );

        if (!conversation) throw new Error("Fixture conversation is missing");
        let native: Submission | undefined;

        if (placement !== "placed") {
          native = await conversation.submit(
            { type: "input", content: "Prior native input" },
            BACKGROUND_CONTEXT,
          );
          await started.promise;
        }

        const controller = new AbortController();
        let own: Submission | undefined;
        let requestId: string | undefined;
        let attempts = 0;
        let interrupts = 0;
        let queried = false;

        // One real harness owns storage. Only lose its admission response.
        const recovering: PiDurableBackend = Reflect.construct(
          PiDurableBackend,
          [
            {
              async conversation() {
                return {
                  id: conversation.id,
                  async submit(draft: SubmissionDraft, context: Context) {
                    attempts++;
                    requestId = draft.requestId;
                    own = await conversation.submit(draft, context);

                    if (aborted) controller.abort();
                    throw new Error("Admission handle lost after commit");
                  },
                  async commit<T>(
                    change: (tx: Tx) => T | Promise<T>,
                    context: Context,
                  ) {
                    queried = true;

                    if (placement === "unreadable")
                      throw new Error("Lookup unavailable");

                    return conversation.commit(change, context);
                  },
                  async abort(context: Context) {
                    interrupts++;
                    await conversation.abort(context);
                  },
                };
              },
              submission: harness.submission.bind(harness),
            },
            {},
          ],
        );

        await expect(
          recovering.prompt(session, "Own input", controller.signal),
        ).rejects.toThrow();
        expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
        expect(attempts).toBe(1);
        expect(queried).toBe(true);

        if (!own) throw new Error("Own input was not admitted");
        const status = await own.status(BACKGROUND_CONTEXT);
        expect(status.requestId).toBe(requestId);
        expect(status.status).toBe(
          placement === "unreadable" ? "queued" : "unanswered",
        );
        expect(interrupts).toBe(placement === "placed" ? 1 : 0);

        if (native) {
          expect(providerAborted).toBe(false);
          expect((await native.status(BACKGROUND_CONTEXT)).status).toBe(
            "placed",
          );
          // The unreadable-lookup outcome remains uncertain; fixture cleanup
          // Withdraws it explicitly before releasing the unrelated native run.
          await own.abort(BACKGROUND_CONTEXT);
          release.resolve();
          expect((await native.wait(BACKGROUND_CONTEXT)).status).toBe("done");
        }
      } finally {
        release.resolve();
        await backend?.close();
        await server.stop(true);

        if (previous === undefined) delete process.env[apiKeyEnv];
        else process.env[apiKeyEnv] = previous;
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}

for (const report of [false, true]) {
  test(`Pi ${report ? "report" : "maintenance"} recovers committed answer after lost crew completion without opening runtime`, async () => {
    const directory = await mkdtemp(
      join(fixtureRoot(), "stargate-pi-receipt-"),
    );

    const previous = process.env[apiKeyEnv];
    process.env[apiKeyEnv] = "local-test-only";
    let state = await CrewState.open(directory, "receipt", "identity");
    let workers: PiCrewWorkers | undefined;
    let backend: PiDurableBackend | undefined;
    let task: CrewTask | undefined;
    let requests = 0;
    let opens = 0;
    let nativeDirectory = "";

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body: Record<string, unknown> = await request.json();
        requests++;

        if (requests === 2) {
          if (!task) throw new Error("Task is missing");
          expect(state.piTaskConversation(task.id)).toBeDefined();

          if (report) {
            expect(body["tools"] ?? []).toEqual([]);
            expect(JSON.stringify(body)).not.toContain("Prior maintenance");
          }
        }

        return completion(requests === 1 ? "PRIOR ANSWER" : "TASK CANONICAL");
      },
    });

    try {
      const { directory: _, ...settings } = config(
        new URL("/v1", server.url).href,
        directory,
      );

      const member = Schema.decodeUnknownSync(teamSchema)({
        captain: { id: "captain" },
        crew: [
          {
            id: "twiki",
            role: "Maintenance",
            permissionProfile: "coding",
            backend: settings,
          },
        ],
      }).crew[0];

      if (!member) throw new Error("Member is missing");

      const factory: PiWorkerFactory = async (config, context) => {
        opens++;
        nativeDirectory = context.dataDirectory;
        backend = await PiDurableBackend.open(config, context);

        return backend;
      };

      workers = new PiCrewWorkers(state, directory, factory);
      const peer = state.reservePeer(member.id);
      await workers.ensure(member, directory, peer, signal());
      state.readyPeer(member.id);
      const maintenance = state.piPeer(peer.sessionID)?.conversationID;

      if (!backend || !maintenance) throw new Error("Native worker is missing");
      expect(
        await backend.prompt(
          maintenance,
          "Prior maintenance",
          signal(),
          undefined,
          "final",
          "unrelated-prior-input",
        ),
      ).toBe("PRIOR ANSWER");

      if (report) {
        const capture = state.reporting.start("captain", "request", member.id);
        state.reporting.finish(capture);

        const queued = state.enqueue(
          peer,
          "captain",
          "Report input",
          capture.id,
        );

        task = state.promote(queued.id, null)?.task;
      } else
        task = state.reserveTask(peer, "captain", "Maintenance") ?? undefined;

      if (!task) throw new Error("Task is missing");
      const interrupted = Promise.withResolvers<void>();
      state.complete = () => {
        throw new Error("Crash after native commit, before crew completion");
      };

      const uncertain = state.uncertain.bind(state);
      state.uncertain = (...args) => {
        uncertain(...args);
        interrupted.resolve();
      };

      workers.start(member, directory, peer, task, "Task input");
      await interrupted.promise;
      expect(state.task(task.id)?.status).toBe("uncertain");
      const bound = state.piTaskConversation(task.id);
      expect(bound).toBeDefined();

      if (report) expect(bound).not.toBe(maintenance);
      else expect(bound).toBe(maintenance);
      expect(requests).toBe(2);
      await workers.close();
      expect(
        await PiDurableBackend.recover(
          { dataDirectory: nativeDirectory },
          bound ?? "",
          "unrelated-missing-input",
          signal(),
        ),
      ).toBeUndefined();
      state.close();
      state = await CrewState.open(directory, "receipt", "identity");
      // Read-only inspection needs neither provider setup nor a replacement session.
      delete process.env[apiKeyEnv];
      workers = new PiCrewWorkers(state, directory);

      const recovered = await workers.recover(
        task,
        member,
        directory,
        signal(),
      );

      expect(recovered).toMatchObject({
        id: task.id,
        inputID: task.inputID,
        workerSessionID: task.workerSessionID,
        status: "completed",
        result: "TASK CANONICAL",
      });
      expect(state.piPeer(peer.sessionID)?.conversationID).toBe(maintenance);
      expect(state.piTaskConversation(task.id)).toBe(bound);
      expect(requests).toBe(2);
      expect(opens).toBe(1);
    } finally {
      await workers?.close();
      state.close();
      await server.stop(true);

      if (previous === undefined) delete process.env[apiKeyEnv];
      else process.env[apiKeyEnv] = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("Pi receipt inspection leaves placed, queued and unanswered native work unchanged", async () => {
  const directory = await mkdtemp(join(fixtureRoot(), "stargate-pi-readonly-"));
  const path = `${directory}/pi.sqlite`;
  const storage = await openNodeSqliteStorage(path);

  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );

  let closed = false;

  try {
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "openai", modelId: "never-request" } },
      },
      BACKGROUND_CONTEXT,
    );

    // Native commit reproduces the durable input/live/inbox/task records of an
    // Interrupted run. No scheduler is enabled while constructing the fixture.
    const seeded = await conversation.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, conversation.id);
      const inbox = await tx.doc(InboxDoc, conversation.id);

      const entry = await tx.appendEntry(UserEntry, conversation.id, {
        model: [{ role: "user", content: "Placed input", timestamp: 0 }],
      });

      const placed = await tx.createSubmission({
        conversationId: conversation.id,
        type: "input",
        requestId: "placed-input",
        status: "placed",
        entry: entry.id,
      });

      const queued = await tx.createSubmission({
        conversationId: conversation.id,
        type: "input",
        requestId: "queued-input",
        status: "queued",
      });

      const unanswered = await tx.createSubmission({
        conversationId: conversation.id,
        type: "input",
        requestId: "unanswered-input",
        status: "unanswered",
        reason: "interrupted",
      });

      const task = await tx.createTask(
        GenerationTask,
        {},
        {
          conversationId: conversation.id,
          ownership: { kind: "conversation" },
        },
      );

      live.run = {
        taskId: task,
        inputs: [placed.id],
        turns: 0,
        first: entry.id,
      };
      inbox.items.push({
        id: queued.id,
        mode: "followUp",
        content: "Queued input",
      });

      return { placed, queued, unanswered, task };
    }, BACKGROUND_CONTEXT);

    expect(
      (await harness.getTask(seeded.task, BACKGROUND_CONTEXT))?.state.status,
    ).toBe("pending");
    await harness.close(BACKGROUND_CONTEXT);
    closed = true;
    // Exported Storage contract simulates a process cut off after reservation.
    // A normal Harness open would rewrite this running task during recovery.
    const crashed = await openNodeSqliteStorage(path);
    let expectedTask: Awaited<ReturnType<typeof crashed.task>>;

    try {
      const task = await crashed.task(seeded.task, BACKGROUND_CONTEXT);

      if (task?.state.status !== "pending")
        throw new Error("Pending generation is missing");
      expectedTask = {
        ...task,
        state: {
          status: "running" as const,
          checkpoint: task.state.checkpoint,
        },
      };
      await crashed.commit(
        [[{ type: "task", value: expectedTask }]],
        () => {},
        BACKGROUND_CONTEXT,
      );
    } finally {
      await crashed.close(BACKGROUND_CONTEXT);
    }

    for (const requestID of [
      "placed-input",
      "queued-input",
      "unanswered-input",
      "missing-input",
    ]) {
      expect(
        await PiDurableBackend.recover(
          { dataDirectory: directory },
          String(conversation.id),
          requestID,
          signal(),
        ),
      ).toBeUndefined();
    }

    const inspection = await openNodeSqliteStorage(path);

    try {
      for (const record of [seeded.placed, seeded.queued, seeded.unanswered])
        expect(
          await inspection.submission(record.id, BACKGROUND_CONTEXT),
        ).toEqual(record);
      expect(await inspection.task(seeded.task, BACKGROUND_CONTEXT)).toEqual(
        expectedTask,
      );
    } finally {
      await inspection.close(BACKGROUND_CONTEXT);
    }
  } finally {
    if (!closed) await harness.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Pi maps the proxy's answer to one shared failure category", async () => {
  const directory = await mkdtemp(join(fixtureRoot(), "stargate-pi-failure-"));
  const previous = process.env[apiKeyEnv];
  process.env[apiKeyEnv] = "local-proxy-test-only";
  // The next answers of the proxy: a status, "tool" for a tool call, or
  // Undefined for a completion.
  let answers: (number | "tool" | undefined)[] = [];

  const toolCall = () => {
    const chunk = (delta: object, finish_reason: string | null = null) =>
      `data: ${JSON.stringify({
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "opencode-go/deepseek-v4.1-flash",
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`;

    return new Response(
      chunk({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            // Not a real tool: the harness answers with a tool error.
            function: { name: "fixture_missing_tool", arguments: "{}" },
          },
        ],
      }) +
        chunk({}, "tool_calls") +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  };

  let calls = 0;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch() {
      calls++;
      const status = answers.shift();

      if (status === undefined) return completion();

      if (status === "tool") return toolCall();

      return Response.json(
        {
          error: {
            message:
              "auth unavailable: 2 of 2 candidate(s) for model x are in cooldown, reason=credential_quota sk-proxy-secret",
            type: "provider_error",
          },
        },
        // The client retries at once instead of backing off.
        { status, headers: { "retry-after-ms": "0", "retry-after": "0" } },
      );
    },
  });

  let backend: PiDurableBackend | undefined;

  try {
    const settings = config(new URL("/v1", server.url).href, directory);
    backend = await PiDurableBackend.open(settings, {
      dataDirectory: directory,
    });
    const pi = backend;

    const failure = async (statuses: (number | "tool")[]) => {
      const session = await pi.createSession({
        key: crypto.randomUUID(),
        title: "failure",
        signal: signal(),
      });

      // The client may retry: every call of this turn gets the same answer.
      answers = Array.from(
        { length: 20 },
        (_, index) => statuses[index] ?? statuses.at(-1),
      );

      return pi.prompt(session, "hello", AbortSignal.timeout(20_000)).then(
        () => undefined,
        (error: unknown) =>
          error instanceof BackendFailure ? error.failure : String(error),
      );
    };

    const cases: [status: number, cause: string][] = [
      [429, "provider:quota:429:idle"],
      [402, "provider:quota:402:idle"],
      [401, "provider:auth:401:idle"],
      [403, "provider:auth:403:idle"],
      [404, "provider:model:404:idle"],
      // The harness retries 429 and 5xx with a backoff of about 14 s, so
      // One retried status is enough here; `statusKind` covers the rest.
    ];

    for (const [status, cause] of cases)
      expect([status, await failure([status])]).toEqual([status, cause]);
    expect(calls).toBeGreaterThanOrEqual(cases.length);
    // The model called a tool; the proxy refused the next call.
    expect(await failure(["tool", 429])).toBe("provider:quota:429:ran");
    // A proxy that cannot be reached: nothing ran.
    await server.stop(true);
    expect(await failure([])).toBe("provider:network:0:idle");
  } finally {
    await backend?.close();
    await server.stop(true);

    if (previous === undefined) delete process.env[apiKeyEnv];
    else process.env[apiKeyEnv] = previous;
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
