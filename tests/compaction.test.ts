import { expect, test } from "bun:test";
import {
  type CompactionEvents,
  compactAndWait,
  compactOnServer,
} from "../src/crew/history/compaction";
import { defaultTeam } from "../src/crew/team";

test("worker compaction uses the verified global API stream and waits until connected", async () => {
  const worker = {
    id: "ses_worker",
    agent: "mario",
    location: { directory: "/crew/mario" },
    metadata: { stargateCrew: { namespace: "one", crewID: "mario" } },
  };
  const envName = "STARGATE_COMPACTION_FIXTURE_AUTH";
  const previous = process.env[envName];
  process.env[envName] = "Bearer fixture-only";
  const encoder = new TextEncoder();
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connected = false;
  let sequence = 0;
  let admissions = 0;
  const emit = (type: string, data: Record<string, unknown>) => {
    stream?.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({
          id: `evt_${++sequence}`,
          created: Date.now(),
          type,
          location: worker.location,
          durable: { aggregateID: worker.id, seq: sequence, version: 1 },
          data,
        })}\n\n`,
      ),
    );
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer fixture-only");
      const path = new URL(request.url).pathname;
      if (path === `/api/session/${worker.id}`)
        return Response.json({ data: worker });
      if (path === "/api/event")
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              // The HTTP event iterator is lazy; admission must wait for SSE.
              timer = setTimeout(() => {
                connected = true;
                controller.enqueue(
                  encoder.encode(
                    'data: {"type":"server.connected","data":{}}\n\n',
                  ),
                );
              }, 25);
            },
            cancel() {
              clearTimeout(timer);
              stream = undefined;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      if (path === `/api/session/${worker.id}/compact`) {
        expect(connected).toBe(true);
        admissions++;
        const input = (await request.json()) as { id: string };
        emit("session.compaction.ended", {
          sessionID: "ses_other",
          reason: "manual",
        });
        emit("session.compaction.ended", {
          sessionID: worker.id,
          reason: "manual",
        });
        emit("session.compaction.started", {
          sessionID: worker.id,
          reason: "manual",
          inputID: input.id,
        });
        emit("session.compaction.ended", {
          sessionID: worker.id,
          reason: "manual",
        });
        return Response.json({
          data: {
            id: input.id,
            sessionID: worker.id,
            time: { created: Date.now() },
            type: "compaction",
            payload: {},
            delivery: "steer",
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    await compactOnServer(
      {
        ...defaultTeam,
        historyAPI: {
          url: server.url.href,
          headersEnv: { authorization: envName },
        },
      },
      {
        async get() {
          return worker;
        },
      },
      worker.id,
      AbortSignal.timeout(2000),
    );
    expect(admissions).toBe(1);
  } finally {
    clearTimeout(timer);
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
    await server.stop(true);
  }
});

test("compact-first waits for its correlated completion, not admission or another session", async () => {
  let requestID: string | undefined;
  let admit = () => {};
  const admitted = new Promise<void>((resolve) => {
    admit = resolve;
  });
  const events: CompactionEvents = {
    async *subscribe() {
      await admitted;
      yield {
        type: "session.compaction.ended",
        data: { sessionID: "ses_other" },
      };
      yield {
        type: "session.compaction.ended",
        data: { sessionID: "ses_worker" },
      };
      yield {
        type: "session.compaction.started",
        data: { sessionID: "ses_worker", inputID: requestID },
      };
      yield {
        type: "session.compaction.ended",
        data: { sessionID: "ses_worker" },
      };
    },
  };
  await compactAndWait(
    {
      async compact(input) {
        requestID = input.id;
        admit();
      },
    },
    events,
    "ses_worker",
    new AbortController().signal,
  );
  expect(requestID).toMatch(/^msg_/);
});

test("compaction failure is not treated as successful compact-first", async () => {
  const events: CompactionEvents = {
    async *subscribe() {
      yield {
        type: "session.compaction.failed",
        data: { sessionID: "ses_worker" },
      };
    },
  };
  await expect(
    compactAndWait(
      { async compact() {} },
      events,
      "ses_worker",
      new AbortController().signal,
    ),
  ).rejects.toThrow("not confirmed");
});

test("already aborted compaction does not admit underlying work", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const events: CompactionEvents = { async *subscribe() {} };
  await expect(
    compactAndWait(
      {
        async compact() {
          called = true;
        },
      },
      events,
      "ses_worker",
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(called).toBe(false);
});
