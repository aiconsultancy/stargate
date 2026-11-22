import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  OpenCode,
  type SessionCreateInput,
  type SessionPromptInput,
  type SessionSyntheticInput,
} from "@opencode/client";
import type { Plugin as EffectPlugin } from "@opencode/plugin/effect";
import { Agent, Session, SessionMessage } from "@opencode/schema";
import { Tool } from "@opencode/schema/tool";
import { Context, Deferred, Effect, Exit, Schema, Scope } from "effect";
import pino from "pino";
import {
  type CrewAgents,
  CrewEngine,
  type CrewOptions,
  type CrewSession,
  type CrewSessions,
  type CrewWaitOptions,
} from "../src/crew/engine";
import { CrewMaintenance } from "../src/crew/controls/maintenance";
import type { MesijClient, MesijMessage } from "../src/crew/mesij";
import { CrewModels, type ModelSessions } from "../src/crew/controls/models";
import { nativeWait } from "../src/crew/native-wait";
import plugin from "../src/crew/plugin";
import type {
  CrewInspectionAPI,
  EvidenceMessage,
} from "../src/crew/reconciliation";
import { CrewRecovery, runRecoveryOperator } from "../src/crew/recovery-rpc";
import type { CrewTask } from "../src/crew/state";
import {
  defaultTeam,
  profileTeam,
  type Team,
  teamSchema,
} from "../src/crew/team";
import { CrewWaiting } from "../src/crew/controls/waiting";
import { Gateway } from "../src/gateway/gateway";
import { openStore } from "../src/app/open-store";
import {
  buildUpdateSnapshot,
  noticeTools,
} from "../src/maintenance/update-notice";
import { waitingSettingsPath } from "../src/gateway/waiting";
import { bot, event, identity } from "./fixtures";
import { copyCrewDatabase } from "./fixtures/database-reuse";

const diskIntegrationTimeoutMs = 30_000;

async function boundedOutcome<T>(work: Promise<T>): Promise<T> {
  const stop = new AbortController();
  try {
    return await Promise.race([
      work,
      delay(1000, undefined, { signal: stop.signal, ref: false }).then(() => {
        throw new Error("Crew wait did not yield after its observation window");
      }),
    ]);
  } finally {
    stop.abort();
  }
}

function waitClock() {
  let now = 0;
  let poll = async () => {};
  return {
    options: {
      windowMs: 50,
      now: () => now,
      wait: async (ms: number, signal: AbortSignal) => {
        signal.throwIfAborted();
        now += ms;
        await poll();
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    },
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
    onPoll(next: () => Promise<void>) {
      poll = next;
    },
  };
}

test("conversation eval: exported plugin wires cancellable native wait through its registered crew tool", async () => {
  const historyRequests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      historyRequests.push(new URL(request.url).pathname);
      return new Response("Unexpected history request", { status: 500 });
    },
  });
  const scope = Effect.runSync(Scope.make());
  const release = Effect.runSync(Deferred.make<void>());
  const started = Promise.withResolvers<void>();
  const unexpected: string[] = [];
  let observers = 0;
  let finalizers = 0;
  let disposed = 0;
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  type RegisteredTool = {
    name: string;
    execute: (
      input: unknown,
      context: Tool.Context,
    ) => Effect.Effect<Tool.Result<undefined>, Tool.Error>;
  };
  let crewTool: RegisteredTool | undefined;
  let work:
    | Promise<
        | { type: "success"; value: Tool.Result<undefined> }
        | { type: "failure"; error: unknown }
      >
    | undefined;
  try {
    const seed = await fixture(
      Schema.decodeUnknownSync(teamSchema)({
        ...defaultTeam,
        historyAPI: { url: server.url.href },
      }),
    );
    f = seed;
    const task = (
      await seed.engine.run(
        { op: "dispatch", crew: "mario", text: "Retain this result" },
        seed.captain(),
      )
    ).task;
    if (!task) throw new Error("Missing fixture task");
    const registration = {
      dispose: Effect.sync(() => {
        disposed++;
      }),
      events: { emit: () => Effect.void },
    };
    const scopedRegistration = Effect.acquireRelease(
      Effect.succeed(registration),
      (owned) => owned.dispose,
    );
    const methods = new Map<string, unknown>([
      ["location", { directory: seed.options.captainDirectory }],
      ["options", seed.options],
      ["rpc.register", () => Effect.succeed(registration)],
      ["permission.assert", () => Effect.void],
      ["session.hook", () => scopedRegistration],
      [
        "session.get",
        ({ sessionID }: { sessionID: string }) =>
          Effect.promise(() => seed.client.get({ sessionID })).pipe(
            Effect.flatMap((session) =>
              Schema.decodeUnknownEffect(Session.Info)({
                ...session,
                projectID: "project_fixture",
                cost: 0,
                tokens: {
                  input: 0,
                  output: 0,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
                time: { created: 1, updated: 1 },
              }),
            ),
          ),
      ],
      [
        "session.wait",
        ({ sessionID }: { sessionID: string }) =>
          Effect.gen(function* () {
            expect(sessionID).toBe(task.workerSessionID);
            observers++;
            started.resolve();
            yield* Deferred.await(release);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                observers--;
                finalizers++;
              }),
            ),
          ),
      ],
      [
        "tool.transform",
        (transform: (editor: object) => void) =>
          Effect.sync(() => {
            transform(readStub("editor"));
          }).pipe(Effect.andThen(scopedRegistration)),
      ],
      [
        "editor.add",
        (tool: RegisteredTool) => {
          if (tool.name === "stargate_crew") crewTool = tool;
        },
      ],
    ]);
    // The installed adapter eagerly reads unused API paths. Only approved
    // invocations exist; every other invocation throws and remains counted.
    function readStub(path: string): object {
      return new Proxy(() => {}, {
        get(_target, key) {
          const child = path ? `${path}.${String(key)}` : String(key);
          return methods.get(child) ?? readStub(child);
        },
        apply() {
          unexpected.push(path);
          throw new Error(`Unexpected plugin host invocation: ${path}`);
        },
      });
    }
    // One fake-host boundary; production export and SDK adapter remain real.
    const host = readStub("") as EffectPlugin.Context;
    await Effect.runPromise(plugin.effect(host).pipe(Scope.provide(scope)));
    if (!crewTool) throw new Error("Crew tool was not registered");
    work = Effect.runPromise(
      crewTool.execute(
        { op: "wait", taskID: task.id },
        {
          sessionID: Session.ID.make("ses_captain_a"),
          agent: Agent.ID.make("bowser"),
          messageID: SessionMessage.ID.make("msg_wait"),
          id: Tool.CallID.make("call_wait"),
          progress: () => Effect.void,
        },
      ),
    ).then(
      (value) => ({ type: "success", value }),
      (error: unknown) => ({ type: "failure", error }),
    );
    await boundedOutcome(started.promise);
    expect(observers).toBe(1);
    await seed.engine.run(
      { op: "complete", taskID: task.id, result: "Original retained answer" },
      seed.worker(task.workerSessionID),
    );
    const result = await boundedOutcome(work).catch((cause: unknown) => {
      throw new Error(
        `Registered plugin wait remained pending with ${observers} native observer(s)`,
        { cause },
      );
    });
    if (result.type === "failure") throw result.error;
    if (typeof result.value.content !== "string")
      throw new Error("Crew tool did not return JSON text");
    expect(JSON.parse(result.value.content)).toMatchObject({
      status: "completed",
      task: {
        id: task.id,
        inputID: task.inputID,
        result: "Original retained answer",
      },
    });
    expect(observers).toBe(0);
    expect(finalizers).toBe(1);
    expect(Effect.runSync(Deferred.isDone(release))).toBe(false);
    expect(seed.busy.has(task.workerSessionID)).toBe(true);
    expect(seed.calls.filter(({ method }) => method === "interrupt")).toEqual(
      [],
    );
    expect(seed.inputs.map(({ id }) => id)).toEqual([task.inputID]);
  } finally {
    // Also joins the unbridged mutant: releasing only this observation does
    // not abort a tool, mark a worker idle, or trigger cancellation discovery.
    Effect.runSync(Deferred.succeed(release, undefined));
    try {
      await work;
    } finally {
      try {
        await Effect.runPromise(Scope.close(scope, Exit.void));
      } finally {
        try {
          await f?.close();
        } finally {
          await server.stop(true);
          expect(observers).toBe(0);
          expect(unexpected).toEqual([]);
          expect(historyRequests).toEqual([]);
          // Every registration is released once, including passive context.
          expect(disposed).toBe(7);
        }
      }
    }
  }
});

test("conversation eval: bounded wait yields without cancelling the worker and later collects its original result", async () => {
  const clock = waitClock();
  const f = await fixture(undefined, clock.options);
  const idle = Effect.runSync(Deferred.make<void>());
  let observers = 0;
  const stop = new AbortController();
  let waiting: Promise<unknown> | undefined;
  try {
    f.history.set("ses_captain_a", [
      { id: "tool", type: "assistant", time: { created: 2 } },
      { id: "private-input", type: "user", time: { created: 1 } },
    ]);
    const task = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "Original" },
        { ...f.captain(), messageID: "tool" },
      )
    ).task;
    if (!task) throw new Error("Missing task");
    f.engine.state.notice(task.id, "Already read");
    const after = f.engine.state.notices(task.id, 0).at(-1)?.id ?? 0;
    const before = f.engine.state.task(task.id);
    f.client.wait = nativeWait(
      () =>
        Effect.gen(function* () {
          observers++;
          yield* Deferred.await(idle);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              observers--;
            }),
          ),
        ),
      Context.empty(),
    );
    const observation = f.engine.run(
      { op: "wait", taskID: task.id, afterNoticeID: after },
      f.captain("ses_captain_a", stop.signal),
    );
    waiting = observation;
    expect(await boundedOutcome(observation)).toMatchObject({
      status: "running",
      task: before,
      notices: [],
      diagnostic: expect.stringContaining("End this turn"),
    });
    expect(observers).toBe(0);
    expect(Effect.runSync(Deferred.isDone(idle))).toBe(false);
    expect(f.busy.has(task.workerSessionID)).toBe(true);
    expect(f.engine.state.task(task.id)).toEqual(before);
    expect(f.calls.filter(({ method }) => method === "interrupt")).toEqual([]);
    expect(f.inputs).toHaveLength(1);
    expect(f.engine.state.notices(task.id, 0).map(({ id }) => id)).toEqual([
      after,
    ]);
    await f.engine.dm(
      { op: "send", to: "captain", taskID: task.id, text: "Ready" },
      f.worker(task.workerSessionID),
    );
    await f.engine.run(
      { op: "complete", taskID: task.id, result: "Original result" },
      f.worker(task.workerSessionID),
    );
    expect(
      await f.engine.run(
        { op: "wait", taskID: task.id, afterNoticeID: after },
        f.captain(),
      ),
    ).toMatchObject({
      status: "completed",
      task: {
        id: task.id,
        inputID: task.inputID,
        originInputID: "private-input",
        result: "Original result",
      },
    });
    expect(f.synthetics.at(-1)).toMatchObject({
      delivery: "queue",
      metadata: {
        pogoCrew: { sourceTaskID: task.id, originInputID: "private-input" },
      },
    });
    expect(f.inputs).toHaveLength(1);
  } finally {
    stop.abort();
    Effect.runSync(Deferred.succeed(idle, undefined));
    await waiting?.catch(() => {});
    await f.close();
  }
});

test("bounded queued wait preserves FIFO and origins without admitting or replaying work", async () => {
  const clock = waitClock();
  const f = await fixture(undefined, clock.options);
  try {
    const first = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "First" },
        f.captain(),
      )
    ).task;
    if (!first) throw new Error("Missing task");
    f.history.set("ses_captain_a", [
      { id: "queue-tool", type: "assistant", time: { created: 2 } },
      { id: "queue-origin", type: "user", time: { created: 1 } },
    ]);
    const caller = { ...f.captain(), messageID: "queue-tool" };
    const queued = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "Second", queue: true },
        caller,
      )
    ).task;
    await f.engine.run(
      { op: "dispatch", crew: "mario", text: "Third", queue: true },
      caller,
    );
    if (!queued) throw new Error("Missing queued task");
    const fifo = f.engine.state.queuedTasks("mario");
    const before = f.engine.state.task(first.id);
    expect(
      await boundedOutcome(
        f.engine.run({ op: "wait", taskID: queued.id }, f.captain()),
      ),
    ).toMatchObject({
      status: "queued",
      task: queued,
      notices: [],
      diagnostic: expect.stringContaining("End this turn"),
    });
    expect(clock.now()).toBe(50);
    expect(f.engine.state.queuedTasks("mario")).toEqual(fifo);
    expect(f.engine.state.task(first.id)).toEqual(before);
    expect(f.engine.state.task(queued.id)?.originInputID).toBe("queue-origin");
    expect(f.inputs).toHaveLength(1);
    expect(f.calls.filter(({ method }) => method === "interrupt")).toEqual([]);
  } finally {
    await f.close();
  }
});

test("bounded wait shares one deadline across queued promotion and running observation", async () => {
  const clock = waitClock();
  const f = await fixture(undefined, clock.options);
  try {
    const first = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "First" },
        f.captain(),
      )
    ).task;
    const queued = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "Second", queue: true },
        f.captain(),
      )
    ).task;
    if (!first || !queued) throw new Error("Missing tasks");
    let polls = 0;
    clock.onPoll(async () => {
      if (++polls !== 1) return;
      await f.engine.run(
        { op: "complete", taskID: first.id, result: "First done" },
        f.worker(first.workerSessionID),
      );
      f.busy.delete(first.workerSessionID);
    });
    expect(
      await boundedOutcome(
        f.engine.run({ op: "wait", taskID: queued.id }, f.captain()),
      ),
    ).toMatchObject({
      status: "running",
      task: {
        id: queued.id,
        inputID: queued.inputID,
        originInputID: queued.originInputID,
      },
    });
    expect(clock.now()).toBe(50);
    expect(polls).toBe(2);
    expect(f.inputs.map(({ id }) => id)).toEqual([
      first.inputID,
      queued.inputID,
    ]);
    expect(f.engine.state.queuedTasks("mario")).toEqual([]);
    expect(f.calls.filter(({ method }) => method === "interrupt")).toEqual([]);
  } finally {
    await f.close();
  }
});

test("bounded wait counts initial promotion and authorization time without restarting its window", async () => {
  const clock = waitClock();
  const f = await fixture(undefined, clock.options);
  try {
    const first = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "First" },
        f.captain(),
      )
    ).task;
    const queued = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "Second", queue: true },
        f.captain(),
      )
    ).task;
    if (!first || !queued) throw new Error("Missing tasks");
    await f.engine.run(
      { op: "complete", taskID: first.id, result: "Done" },
      f.worker(first.workerSessionID),
    );
    f.busy.delete(first.workerSessionID);
    const get = f.client.get;
    let authorization = false;
    let promotion = false;
    f.client.get = async (input, request) => {
      if (input.sessionID === "ses_captain_a" && !authorization) {
        authorization = true;
        clock.advance(25);
      }
      if (input.sessionID === queued.workerSessionID && !promotion) {
        promotion = true;
        clock.advance(25);
      }
      return get(input, request);
    };
    let polls = 0;
    clock.onPoll(async () => {
      polls++;
    });
    expect(
      await boundedOutcome(
        f.engine.run({ op: "wait", taskID: queued.id }, f.captain()),
      ),
    ).toMatchObject({
      status: "running",
      task: { id: queued.id, inputID: queued.inputID },
    });
    expect(clock.now()).toBe(50);
    expect(polls).toBe(0);
    expect(f.inputs).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("bounded wait preserves completion, notices, idle failure and caller abort at the deadline", async () => {
  for (const outcome of [
    "complete",
    "notice",
    "idle",
    "failure",
    "abort",
    "complete-abort",
  ] as const) {
    const clock = waitClock();
    const f = await fixture(undefined, clock.options, false, true);
    const idle = Effect.runSync(Deferred.make<void>());
    const stop = new AbortController();
    try {
      const task = (
        await f.engine.run(
          { op: "dispatch", crew: "mario", text: "Work" },
          f.captain(),
        )
      ).task;
      if (!task) throw new Error("Missing task");
      f.client.wait = nativeWait(
        () =>
          Effect.gen(function* () {
            if (!f.busy.has(task.workerSessionID)) return;
            yield* Deferred.await(idle);
            if (outcome === "failure")
              return yield* Effect.fail(new Error("Native observation failed"));
          }),
        Context.empty(),
      );
      clock.onPoll(async () => {
        if (clock.now() < 50) return;
        if (outcome === "complete" || outcome === "complete-abort") {
          await f.engine.run(
            { op: "complete", taskID: task.id, result: "Done" },
            f.worker(task.workerSessionID),
          );
          if (outcome === "complete-abort") stop.abort();
        } else if (outcome === "notice")
          f.engine.state.notice(task.id, "Need approval");
        else if (outcome === "abort") stop.abort();
        else Effect.runSync(Deferred.succeed(idle, undefined));
      });
      const waiting = boundedOutcome(
        f.engine.run(
          { op: "wait", taskID: task.id },
          f.captain("ses_captain_a", stop.signal),
        ),
      );
      if (outcome === "complete" || outcome === "notice") {
        const result = await waiting;
        expect(result.diagnostic).toBeUndefined();
        expect(result.status).toBe(
          outcome === "complete" ? "completed" : "running",
        );
        if (outcome === "complete") expect(result.task?.result).toBe("Done");
        else expect(result.notices?.[0]?.text).toBe("Need approval");
      } else {
        await expect(waiting).rejects.toThrow(
          outcome === "abort" || outcome === "complete-abort"
            ? "Wait cancelled"
            : "without a confirmed result",
        );
        expect(f.engine.state.task(task.id)?.status).toBe(
          outcome === "complete-abort" ? "completed" : "uncertain",
        );
        expect(
          f.calls.filter(({ method }) => method === "interrupt"),
        ).toHaveLength(outcome === "abort" ? 1 : 0);
      }
      expect(f.inputs).toHaveLength(1);
    } finally {
      stop.abort();
      Effect.runSync(Deferred.succeed(idle, undefined));
      await f.close();
    }
  }
});

test("conversation eval: bounded wait lets a SQLite-queued Slack source enter after progress ends the captain turn", async () => {
  const clock = waitClock();
  const f = await fixture(undefined, clock.options);
  const store = openStore(":memory:");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const posts: string[] = [];
  const prompts: string[] = [];
  const stop = new AbortController();
  let work: Promise<void> | undefined;
  const task = (
    await f.engine.run(
      { op: "dispatch", crew: "mario", text: "Original A" },
      f.captain(),
    )
  ).task;
  if (!task) throw new Error("Missing task");
  const before = f.engine.state.task(task.id);
  clock.onPoll(async () => {
    entered.resolve();
    await release.promise;
  });
  const gateway = new Gateway(
    bot(),
    identity,
    store,
    {
      sessionID: "ses_captain_a",
      async createSession() {
        return "ses_captain_a";
      },
      async prompt(_session, text, signal) {
        prompts.push(text);
        if (text === "Track A") {
          const result = await f.engine.run(
            { op: "wait", taskID: task.id },
            f.captain("ses_captain_a", signal),
          );
          expect(result).toMatchObject({
            status: "running",
            diagnostic: expect.stringContaining("End this turn"),
          });
          return "A keeps running; I will collect it later.";
        }
        return "B can proceed.";
      },
      async close() {},
    },
    {
      async post(_channel, _thread, text) {
        posts.push(text);
      },
    },
    pino({ enabled: false }),
  );
  try {
    gateway.accept(event("<@UBOT> Track A", "1.000"));
    const second = event("<@UBOT> Plan B", "2.000");
    gateway.accept({
      ...second,
      event: { ...second.event, channel: "D123", channel_type: "im" },
    });
    const first = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1, true)[0];
    if (!first) throw new Error("Missing first job");
    work = gateway.process(first, stop.signal);
    await entered.promise;
    expect(store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1, true)).toEqual(
      [],
    );
    expect(prompts).toEqual(["Track A"]);
    release.resolve();
    await boundedOutcome(work);
    const next = store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 1, true)[0];
    if (!next) throw new Error("Missing second job");
    await gateway.process(next, stop.signal);
    expect(prompts).toEqual(["Track A", "Plan B"]);
    expect(posts).toEqual([
      "A keeps running; I will collect it later.",
      "B can proceed.",
    ]);
    expect(f.engine.state.task(task.id)).toEqual(before);
    expect(f.inputs).toHaveLength(1);
    expect(f.calls.filter(({ method }) => method === "interrupt")).toEqual([]);
  } finally {
    release.resolve();
    stop.abort();
    await work?.catch(() => {});
    await gateway.close();
    store.close();
    await f.close();
  }
});

test("dispatch binds the exact open assistant origin before later inputs and preserves queued ancestry", async () => {
  const f = await fixture();
  try {
    f.history.set("ses_captain_a", [
      { id: "later", type: "user", time: { created: 3 } },
      { id: "dispatch-tool", type: "assistant", time: { created: 2 } },
      { id: "original", type: "user", time: { created: 1 } },
    ]);
    const caller = { ...f.captain(), messageID: "dispatch-tool" };
    const first = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "First" },
        caller,
      )
    ).task;
    const queued = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "Second", queue: true },
        caller,
      )
    ).task;
    if (!first || !queued) throw new Error("Missing tasks");
    expect(first.originInputID).toBe("original");
    expect(queued).toMatchObject({
      status: "queued",
      originInputID: "original",
    });
    await f.engine.run(
      { op: "complete", taskID: first.id, result: "Done" },
      f.worker(first.workerSessionID),
    );
    f.busy.delete(first.workerSessionID);
    const promoted = await f.engine.run(
      { op: "status", taskID: queued.id },
      { ...f.captain(), messageID: "unrelated-later-tool" },
    );
    expect(promoted.task).toMatchObject({
      id: queued.id,
      inputID: queued.inputID,
      status: "running",
      originInputID: "original",
    });
    expect(f.inputs).toHaveLength(2);
    expect(f.inputs.map(({ id }) => id)).toEqual([
      first.inputID,
      queued.inputID,
    ]);
  } finally {
    await f.close();
  }
});

test("dispatch leaves origin unknown when ancestry is absent, unreadable or unavailable", async () => {
  for (const mode of [
    "missing-context",
    "missing-anchor",
    "api-error",
    "missing-api",
  ] as const) {
    const f = await fixture();
    const engine =
      mode === "missing-api"
        ? await CrewEngine.open(f.options, f.client, f.mailer, f.agents)
        : f.engine;
    try {
      f.history.set("ses_captain_a", [
        { id: "unrelated", type: "user", time: { created: 1 } },
      ]);
      if (mode === "api-error")
        f.inspectionAPI.message.list = async () => {
          throw new Error("Private API failure");
        };
      const caller =
        mode === "missing-context"
          ? f.captain()
          : { ...f.captain(), messageID: "absent" };
      const result = await engine.run(
        { op: "dispatch", crew: "mario", text: "Work" },
        caller,
      );
      expect(result.task).toMatchObject({
        status: "running",
        originInputID: null,
      });
      expect(f.inputs).toHaveLength(1);
    } finally {
      if (engine !== f.engine) await engine.close();
      await f.close();
    }
  }
});

test("dispatch origin deadline cancels a stalled history read without replay or task failure", async () => {
  const f = await fixture();
  let observed: AbortSignal | undefined;
  try {
    f.inspectionAPI.message.list = async (_input, request) => {
      const signal = request?.signal;
      if (!signal) throw new Error("Missing history signal");
      observed = signal;
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    };
    const result = await f.engine.run(
      { op: "dispatch", crew: "mario", text: "Work" },
      { ...f.captain(), messageID: "open-tool" },
    );
    expect(result.task).toMatchObject({
      status: "running",
      originInputID: null,
    });
    expect(observed?.aborted).toBe(true);
    expect(f.inputs).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 10_000);

test("captain wakes queue with exact task origin while worker steer and wait notices remain intact", async () => {
  const f = await fixture();
  try {
    f.history.set("ses_captain_a", [
      { id: "tool", type: "assistant", time: { created: 2 } },
      { id: "private-input", type: "user", time: { created: 1 } },
    ]);
    const task = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "Private work" },
        { ...f.captain(), messageID: "tool" },
      )
    ).task;
    if (!task) throw new Error("Missing task");
    await f.engine.dm(
      { op: "send", to: "mario", text: "Continue" },
      f.captain(),
    );
    expect(f.synthetics.at(-1)).toMatchObject({
      sessionID: task.workerSessionID,
      delivery: "steer",
      resume: false,
    });
    const waiting = f.engine.run({ op: "wait", taskID: task.id }, f.captain());
    await f.engine.dm(
      {
        op: "send",
        to: "captain",
        text: "Private progress",
        delivery: "steer",
      },
      f.worker(task.workerSessionID),
    );
    expect(f.synthetics.at(-1)).toMatchObject({
      sessionID: "ses_captain_a",
      delivery: "queue",
      resume: true,
      metadata: {
        pogoCrew: {
          sourceTaskID: task.id,
          originCaptainID: "ses_captain_a",
          originInputID: "private-input",
        },
      },
    });
    expect(
      (await waiting).notices?.map(({ text }) => text).join("\n"),
    ).toContain("Private progress");
    expect(f.engine.state.task(task.id)).toMatchObject({
      status: "running",
      result: null,
    });
    expect(f.inputs).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("task-free and legacy-lineage captain wakes never invent a pinned input origin", async () => {
  const f = await fixture();
  const pinned = await CrewEngine.open(
    { ...f.options, captainSessionID: "ses_pinned" },
    f.client,
    f.mailer,
    f.agents,
  );
  try {
    const peer = (
      await f.engine.run({ op: "ensure", crew: "mario" }, f.captain())
    ).peers?.[0];
    if (!peer) throw new Error("Missing peer");
    const old = f.engine.state.reserveTask(
      peer,
      "ses_captain_a",
      "Old work",
      "old-private-input",
    );
    if (!old) throw new Error("Missing task");
    f.engine.state.running(old.id);
    await pinned.notifyMail(
      {
        id: "1".repeat(32),
        sender: peer.sessionID,
        recipient: "ses_pinned",
        captainID: "ses_captain_a",
        sourceTaskID: old.id,
        targetTaskID: null,
      },
      f.worker(peer.sessionID),
      "Old progress",
      "steer",
    );
    expect(f.synthetics.at(-1)).toMatchObject({
      sessionID: "ses_pinned",
      delivery: "queue",
    });
    expect(f.synthetics.at(-1)?.metadata?.["pogoCrew"]).not.toHaveProperty(
      "originInputID",
    );
    await pinned.notifyMail(
      {
        id: "2".repeat(32),
        sender: peer.sessionID,
        recipient: "ses_pinned",
        captainID: "ses_pinned",
        sourceTaskID: null,
        targetTaskID: null,
      },
      f.worker(peer.sessionID),
      "Task-free reply",
      "steer",
    );
    expect(f.synthetics.at(-1)).toMatchObject({
      sessionID: "ses_pinned",
      delivery: "queue",
    });
    expect(f.synthetics.at(-1)?.metadata?.["pogoCrew"]).not.toHaveProperty(
      "originInputID",
    );
    expect(f.inputs).toHaveLength(0);
  } finally {
    await pinned.close();
    await f.close();
  }
});

test("conversation eval: busy status lets a second source progress without replaying crew work", async () => {
  const f = await fixture();
  const idle = Effect.runSync(Deferred.make<void>());
  let observers = 0;
  let probes = 0;
  const wait = nativeWait(
    () =>
      Effect.gen(function* () {
        observers++;
        probes++;
        yield* Deferred.await(idle);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            observers--;
          }),
        ),
      ),
    Context.empty(),
  );
  const engine = await CrewEngine.open(
    f.options,
    { ...f.client, wait },
    f.mailer,
    f.agents,
    undefined,
    async () => f.inspectionAPI,
    async () => {
      throw new Error("Busy status must not read a final result");
    },
  );
  const store = openStore(":memory:");
  const posts: { channel: string; thread: string; text: string }[] = [];
  const sessions: string[] = [];
  const task = (
    await f.engine.run(
      { op: "dispatch", crew: "mario", text: "Synthetic project task" },
      f.captain(),
    )
  ).task;
  if (!task) throw new Error("Missing task");
  const before = f.engine.state.task(task.id);
  const gateway = new Gateway(
    bot(),
    identity,
    store,
    {
      sessionID: "ses_captain_a",
      async createSession() {
        return "ses_captain_a";
      },
      async prompt(session, text) {
        sessions.push(session);
        expect(
          (await engine.run({ op: "status", taskID: task.id }, f.captain()))
            .status,
        ).toBe("running");
        return text === "Track project A"
          ? "Project A is running."
          : "Project B has its independent plan.";
      },
      async close() {},
    },
    {
      async post(channel, thread, text) {
        posts.push({ channel, thread, text });
      },
    },
    pino({ enabled: false }),
  );
  try {
    gateway.accept(event("<@UBOT> Track project A", "1.000"));
    const other = event("<@UBOT> Plan project B", "2.000");
    gateway.accept({
      ...other,
      event: { ...other.event, channel: "D123", channel_type: "im" },
    });
    for (const job of store.ready(gateway.key, Number.MAX_SAFE_INTEGER, 2))
      await gateway.process(job, new AbortController().signal);
    expect(posts).toEqual([
      { channel: "C123", thread: "1.000", text: "Project A is running." },
      {
        channel: "D123",
        thread: "2.000",
        text: "Project B has its independent plan.",
      },
    ]);
    expect(sessions).toEqual(["ses_captain_a", "ses_captain_a"]);
    expect(f.inputs).toHaveLength(1);
    expect(f.engine.state.task(task.id)).toEqual(before);
    expect(f.busy.has(task.workerSessionID)).toBe(true);
    expect(Effect.runSync(Deferred.isDone(idle))).toBe(false);
    expect(observers).toBe(0);
    expect(probes).toBe(2);
  } finally {
    Effect.runSync(Deferred.succeed(idle, undefined));
    await gateway.close();
    store.close();
    await engine.close();
    await f.close();
  }
});

test("conversation eval: explicit completion releases wait before native worker idle", async () => {
  const f = await fixture();
  const idle = Effect.runSync(Deferred.make<void>());
  const started = Promise.withResolvers<void>();
  let observing = false;
  const task = (
    await f.engine.run(
      { op: "dispatch", crew: "mario", text: "Synthetic completion task" },
      f.captain(),
    )
  ).task;
  if (!task) throw new Error("Missing task");
  f.client.wait = nativeWait(
    () =>
      Effect.gen(function* () {
        observing = true;
        started.resolve();
        yield* Deferred.await(idle);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            observing = false;
          }),
        ),
      ),
    Context.empty(),
  );
  const waiting = f.engine.run({ op: "wait", taskID: task.id }, f.captain());
  try {
    await started.promise;
    await f.engine.run(
      { op: "complete", taskID: task.id, result: "Retained result" },
      f.worker(task.workerSessionID),
    );
    expect(await waiting).toMatchObject({
      status: "completed",
      task: { id: task.id, result: "Retained result" },
    });
    expect(observing).toBe(false);
    expect(Effect.runSync(Deferred.isDone(idle))).toBe(false);
    expect(f.calls.filter((call) => call.method === "interrupt")).toEqual([]);
    expect(f.inputs).toHaveLength(1);
  } finally {
    Effect.runSync(Deferred.succeed(idle, undefined));
    await waiting.catch(() => {});
    await f.close();
  }
});

test("host-bound journal notes work without a task and isolate captain roots", async () => {
  const f = await fixture();
  try {
    const caller = { ...f.captain(), id: "journal-call" };
    const first = await f.engine.journal(
      { op: "append", text: "  Checks passed  \n" },
      caller,
    );
    expect(
      await f.engine.journal({ op: "append", text: "Checks passed" }, caller),
    ).toEqual(first);
    const page = await f.engine.journal({ op: "read" }, f.captain());
    expect(page.entries).toHaveLength(1);
    expect(
      (await f.engine.journal({ op: "read" }, f.captain("ses_captain_b")))
        .entries,
    ).toEqual([]);
    expect(first.entry).toMatchObject({
      member: "bowser",
      taskID: null,
      kind: "note",
      text: "Checks passed",
    });
    for (const input of [
      { op: "read", text: "secret wrong-branch value" },
      { op: "read", after: -1 },
      { op: "append", text: "  " },
      { op: "append", text: "note", unexpected: true },
    ])
      await expect(
        f.engine.journal(input, {
          ...caller,
          sessionID: "unauthorized",
        }),
      ).rejects.toThrow("Invalid stargate_journal input.");
    expect(
      (await f.engine.journal({ op: "read" }, f.captain())).entries,
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("idle mail, aliases, correlated captain reply and broadcast share one inbox", async () => {
  const f = await fixture();
  try {
    const peer = (
      await f.engine.run({ op: "ensure", crew: "mario" }, f.captain())
    ).peers?.[0];
    if (!peer) throw new Error("Missing peer");
    const sent = await f.engine.mail(
      { op: "send", to: "mario", text: "Question" },
      f.captain(),
    );
    expect(sent).toMatchObject({ stored: true, notification: "not_requested" });
    expect(f.synthetics).toEqual([]);
    expect(
      (await f.engine.mail({ op: "inbox" }, f.worker(peer.sessionID)))
        .messages?.[0]?.text,
    ).toBe("Question");
    const replyTo = "id" in sent ? sent.id : undefined;
    const reply = await f.engine.dm(
      { op: "send", to: "bowser", text: "Answer", replyTo },
      f.worker(peer.sessionID),
    );
    expect(reply).toMatchObject({ stored: true, notification: "accepted" });
    expect(f.synthetics.at(-1)).toMatchObject({
      sessionID: "ses_captain_a",
      resume: true,
    });
    expect(
      (await f.engine.mail({ op: "inbox" }, f.captain())).messages?.[0]?.text,
    ).toBe("Answer");
    expect(
      (await f.engine.mail({ op: "inbox" }, f.captain("ses_captain_b")))
        .messages,
    ).toEqual([]);
    await expect(
      f.engine.dm(
        { op: "send", to: "captain", text: "Spoof", replyTo },
        f.captain("ses_captain_b"),
      ),
    ).rejects.toThrow("addressed");
    const broadcast = await f.engine.mail(
      { op: "send", to: "all", text: "FYI" },
      f.captain(),
    );
    expect(broadcast).toMatchObject({
      receipts: defaultTeam.crew.map(({ id }) => ({ to: id, stored: true })),
    });
    expect(f.creations).toHaveLength(1);
    expect(
      (await f.engine.run({ op: "roster" }, f.captain())).members?.[0],
    ).toMatchObject({ id: "bowser", aliases: ["captain"], mail: true });
  } finally {
    await f.close();
  }
});

test("DM stored first, busy steer never resumes, native failure preserves task state", async () => {
  const f = await fixture();
  try {
    const task = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "Work" },
        f.captain(),
      )
    ).task;
    if (!task) throw new Error("Missing task");
    const caller = f.captain();
    const receipt = await f.engine.dm(
      { op: "send", to: "mario", text: "Check interface" },
      caller,
    );
    expect(receipt).toMatchObject({ notification: "accepted", stored: true });
    expect(f.synthetics[0]).toMatchObject({
      resume: false,
      delivery: "steer",
      metadata: { pogoCrew: { taskID: task.id } },
    });
    expect(f.synthetics[0]?.id).toBe(
      `msg_${"id" in receipt ? receipt.id : ""}`,
    );
    expect(f.synthetics[0]?.text).toContain(
      `final answer remains task ${task.id}'s result`,
    );
    await f.engine.dm(
      { op: "send", to: "mario", text: "Check interface" },
      caller,
    );
    expect(f.synthetics[1]?.id).toBe(f.synthetics[0]?.id);
    expect(f.messages).toHaveLength(1);
    expect(
      await f.engine.dm(
        { op: "send", to: "mario", text: "Later", delivery: "queue" },
        f.captain(),
      ),
    ).toMatchObject({ notification: "unsupported", stored: true });
    f.client.synthetic = async () => {
      throw new Error("raw secret");
    };
    expect(
      await f.engine.dm(
        { op: "send", to: "mario", text: "Another" },
        f.captain(),
      ),
    ).toMatchObject({ notification: "uncertain", stored: true });
    expect(f.engine.state.task(task.id)).toMatchObject({
      status: "running",
      notifying: 0,
    });
    expect(
      await f.engine.dm(
        { op: "send", to: "mario", text: "Other captain" },
        f.captain("ses_captain_b"),
      ),
    ).toMatchObject({ notification: "deferred", stored: true });
    await f.engine.run(
      { op: "complete", taskID: task.id, result: "Done" },
      f.worker(task.workerSessionID),
    );
    f.busy.delete(task.workerSessionID);
    f.client.synthetic = async (input) => {
      f.synthetics.push(input);
    };
    expect(
      await f.engine.dm(
        { op: "send", to: "mario", text: "Free wake", delivery: "queue" },
        f.captain(),
      ),
    ).toMatchObject({ notification: "accepted" });
    expect(f.synthetics.at(-1)).toMatchObject({
      resume: true,
      delivery: "queue",
    });
  } finally {
    await f.close();
  }
});

test("busy crew receives correlated captain steer with queued work without promoting FIFO", async () => {
  const f = await fixture();
  try {
    const task = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "Current work" },
        f.captain(),
      )
    ).task;
    const queued = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "Next work", queue: true },
        f.captain(),
      )
    ).task;
    if (!task || !queued) throw new Error("Missing tasks");
    const beforeCurrent = f.engine.state.task(task.id);
    const beforeQueued = f.engine.state.task(queued.id);
    const receipt = await f.engine.dm(
      { op: "send", to: "mario", text: "Status at your next safe point?" },
      f.captain(),
    );
    expect(receipt).toMatchObject({ stored: true, notification: "accepted" });
    expect(f.synthetics.at(-1)).toMatchObject({
      sessionID: task.workerSessionID,
      resume: false,
      delivery: "steer",
      metadata: { pogoCrew: { taskID: task.id } },
    });
    const replyTo = "id" in receipt ? receipt.id : undefined;
    expect(
      await f.engine.dm(
        { op: "send", to: "captain", replyTo, text: "Running; tests next." },
        f.worker(task.workerSessionID),
      ),
    ).toMatchObject({ stored: true, notification: "accepted" });
    expect(f.engine.state.task(task.id)).toEqual(beforeCurrent);
    expect(f.engine.state.task(queued.id)).toEqual(beforeQueued);
    expect(
      await f.engine.dm(
        { op: "send", to: "mario", text: "Foreign request" },
        f.captain("ses_captain_b"),
      ),
    ).toMatchObject({ stored: true, notification: "deferred" });
    await f.engine.run(
      { op: "complete", taskID: task.id, result: "Verified result" },
      f.worker(task.workerSessionID),
    );
    f.busy.delete(task.workerSessionID);
    const deliveries = f.synthetics.length;
    expect(
      await f.engine.dm(
        {
          op: "send",
          to: "mario",
          text: "Read-only roll call; leave queued work untouched",
        },
        f.captain(),
      ),
    ).toMatchObject({ stored: true, notification: "accepted" });
    expect(f.synthetics).toHaveLength(deliveries + 1);
    expect(f.synthetics.at(-1)).toMatchObject({
      resume: true,
      delivery: "steer",
    });
    expect(f.engine.state.task(task.id)?.result).toBe("Verified result");
    expect(f.engine.state.task(queued.id)).toEqual(beforeQueued);
  } finally {
    await f.close();
  }
});

test("namespaced native definitions keep short crew, mail, journal and task identities", async () => {
  const f = await fixture(profileTeam(defaultTeam, "galactica"));
  try {
    const task = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "Work" },
        f.captain(),
      )
    ).task;
    if (!task) throw new Error("Missing task");
    expect(f.creations[0]?.agent).toBe("galactica-crew-mario");
    expect(task.crewID).toBe("mario");
    const worker = f.worker(task.workerSessionID);
    expect(worker.agent).toBe("galactica-crew-mario");
    expect(
      (await f.engine.journal({ op: "append", text: "Verified" }, worker)).entry
        ?.member,
    ).toBe("mario");
    const dm = await f.engine.dm(
      { op: "send", to: "captain", text: "Question" },
      worker,
    );
    expect(dm).toMatchObject({ to: "bowser", notification: "accepted" });
    await f.engine.dm({ op: "send", to: "bowser", text: "Question" }, worker);
    expect(f.engine.state.notices(task.id, 0)).toHaveLength(1);
    expect(
      (await f.engine.run({ op: "roster" }, worker)).members?.map(
        ({ id }) => id,
      ),
    ).toEqual(["bowser", "mario", "luigi", "daisy", "toad"]);
    await expect(
      f.engine.run(
        { op: "status", taskID: task.id },
        { ...worker, agent: "galactica-crew-luigi" },
      ),
    ).rejects.toThrow("assigned worker");
    await f.engine.run(
      { op: "complete", taskID: task.id, result: "Done" },
      worker,
    );
    expect(
      (await f.engine.run({ op: "status", taskID: task.id }, f.captain())).task
        ?.result,
    ).toBe("Done");
  } finally {
    await f.close();
  }
});

test("a correlated reply routes exactly but cannot steer another captain's work", async () => {
  const f = await fixture();
  try {
    const mario = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "A work" },
        f.captain(),
      )
    ).task;
    const luigi = (
      await f.engine.run(
        { op: "dispatch", crew: "luigi", text: "A peer" },
        f.captain(),
      )
    ).task;
    if (!mario || !luigi) throw new Error("Missing tasks");
    const incoming = await f.engine.mail(
      { op: "send", to: "mario", text: "Question" },
      f.worker(luigi.workerSessionID, "luigi"),
    );
    const replyTo = "id" in incoming ? incoming.id : undefined;
    await f.engine.run(
      { op: "complete", taskID: mario.id, result: "A done" },
      f.worker(mario.workerSessionID),
    );
    f.busy.delete(mario.workerSessionID);
    await f.engine.run(
      { op: "dispatch", crew: "mario", text: "B work" },
      f.captain("ses_captain_b"),
    );
    const reply = await f.engine.dm(
      { op: "send", to: "luigi", text: "Late answer", replyTo },
      f.worker(mario.workerSessionID),
    );
    expect(reply).toMatchObject({ stored: true, notification: "deferred" });
    expect(f.synthetics).toEqual([]);
    const inbox = await f.engine.mail(
      { op: "inbox" },
      f.worker(luigi.workerSessionID, "luigi"),
    );
    expect(inbox.messages?.[0]).toMatchObject({ text: "Late answer" });
    expect(inbox.messages?.[0]).not.toHaveProperty("sourceTaskID");
    await expect(
      f.engine.mail(
        { op: "send", to: "all", text: "Not a reply broadcast", replyTo },
        f.worker(mario.workerSessionID),
      ),
    ).rejects.toThrow("message sender");
  } finally {
    await f.close();
  }
});

test("finished worker has no stale captain context for inbox, new mail or journal", async () => {
  const f = await fixture();
  try {
    const task = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "A work" },
        f.captain(),
      )
    ).task;
    if (!task) throw new Error("Missing task");
    await f.engine.run(
      { op: "complete", taskID: task.id, result: "Done" },
      f.worker(task.workerSessionID),
    );
    f.busy.delete(task.workerSessionID);
    const incoming = await f.engine.dm(
      { op: "send", to: "mario", text: "B question" },
      f.captain("ses_captain_b"),
    );
    const worker = f.worker(task.workerSessionID);
    await expect(
      f.engine.dm({ op: "send", to: "captain", text: "Ambiguous" }, worker),
    ).rejects.toThrow("captain context");
    await expect(
      f.engine.mail(
        { op: "send", taskID: task.id, to: "captain", text: "Stale" },
        worker,
      ),
    ).rejects.toThrow("current task");
    expect(
      (await f.engine.mail({ op: "inbox" }, worker)).messages?.map(
        ({ text }) => text,
      ),
    ).toContain("B question");
    const replyTo = "id" in incoming ? incoming.id : undefined;
    expect(
      await f.engine.dm(
        { op: "send", to: "captain", text: "B answer", replyTo },
        worker,
      ),
    ).toMatchObject({ notification: "accepted" });
    expect(f.synthetics.at(-1)?.sessionID).toBe("ses_captain_b");
    expect(
      (await f.engine.journal({ op: "append", text: "Own idle note" }, worker))
        .entry,
    ).toMatchObject({ captainID: "", taskID: null });
    expect(
      JSON.stringify(
        f.engine.state.reporting.journal.read("ses_captain_a", 0, 100),
      ),
    ).not.toContain("Own idle note");
    expect(
      (await f.engine.journal({ op: "read" }, worker)).entries.map(
        ({ text }) => text,
      ),
    ).toEqual(["Own idle note"]);
    expect(
      (await f.engine.mail({ op: "inbox", taskID: task.id }, f.captain()))
        .messages,
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

test("notification bookkeeping failure keeps the successful durable mail receipt", async () => {
  const f = await fixture();
  try {
    const task = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "A work" },
        f.captain(),
      )
    ).task;
    if (!task) throw new Error("Missing task");
    f.engine.state.beginNotify = () => {
      throw new Error("private database details");
    };
    expect(
      await f.engine.dm(
        { op: "send", to: "mario", text: "Stored first" },
        f.captain(),
      ),
    ).toMatchObject({ stored: true, notification: "uncertain" });
    f.engine.state.noticeOnce = () => {
      throw new Error("private database details");
    };
    expect(
      await f.engine.dm(
        { op: "send", to: "captain", text: "Stored peer reply" },
        f.worker(task.workerSessionID),
      ),
    ).toMatchObject({ stored: true, notification: "uncertain" });
    expect(f.messages).toHaveLength(2);
    expect(f.synthetics).toEqual([]);
    expect(f.engine.state.task(task.id)?.status).toBe("running");
  } finally {
    await f.close();
  }
});

test("broadcast returns partial receipts and Pi tools-none stores no unreadable mail", async () => {
  const f = await fixture(
    Schema.decodeUnknownSync(teamSchema)({
      ...defaultTeam,
      crew: [
        ...defaultTeam.crew,
        {
          id: "silent",
          name: "Silent",
          role: "No tools",
          permissionProfile: "coding",
          backend: { type: "pi-durable", model: "openai/test", tools: "none" },
        },
      ],
    }),
  );
  try {
    const register = f.mailer.register;
    f.mailer.register = async () => {
      throw new Error("Unsupported mail must not touch Mesij");
    };
    expect(
      await f.engine.mail(
        { op: "send", to: "silent", text: "Unreadable" },
        f.captain(),
      ),
    ).toMatchObject({ stored: false, notification: "unsupported" });
    f.mailer.register = register;
    const send = f.mailer.send;
    f.mailer.send = async (input, signal) => {
      if (input.to === f.engine.state.peer("luigi")?.sessionID)
        throw new Error("private transport failure");
      return send(input, signal);
    };
    const result = await f.engine.mail(
      { op: "send", to: "all", text: "Notice" },
      f.captain(),
    );
    expect(result).toMatchObject({
      receipts: [
        { to: "mario", stored: true },
        { to: "luigi", stored: "uncertain" },
        { to: "daisy", stored: true },
        { to: "toad", stored: true },
        { to: "silent", stored: false, notification: "unsupported" },
      ],
    });
    expect(f.engine.state.peer("silent")).toBeNull();
    expect(f.messages).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain("private transport failure");
  } finally {
    await f.close();
  }
});

test("update notices queue once behind busy OpenCode crew without interrupting, creating or promoting work", async () => {
  const f = await fixture(undefined, undefined, true);
  try {
    const task = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "Keep working" },
        f.captain(),
      )
    ).task;
    if (!task) throw new Error("Missing task");
    const before = f.calls.length;
    const nativeHistory = structuredClone(f.history.get(task.workerSessionID));
    const snapshot = buildUpdateSnapshot(
      "0.37.0",
      { notifications: { updateNotice: true } },
      "- New notices",
    );
    const first = await f.engine.updateNotice(
      snapshot,
      noticeTools([{ id: "stargate_crew", description: "Current tools" }]),
      new AbortController().signal,
    );
    expect(first).toEqual([
      { sessionID: task.workerSessionID, status: "queued" },
    ]);
    expect(f.calls.slice(before)).toEqual([]);
    expect(f.synthetics).toEqual([]);
    const system: { type: "text"; text: string }[] = [];
    f.engine.updateNoticeContext(task.workerSessionID, "mario", system);
    expect(system[0]?.text).toContain("Stargate update notice");
    expect(f.history.get(task.workerSessionID)).toEqual(nativeHistory);
    expect(f.engine.state.task(task.id)?.status).toBe("running");
    const repeat = await f.engine.updateNotice(
      snapshot,
      noticeTools([{ id: "stargate_crew", description: "Current tools" }]),
      new AbortController().signal,
    );
    expect(repeat[0]?.status).toBe("unchanged");
    expect(f.calls.slice(before)).toHaveLength(0);
    f.engine.updateNoticeContext(task.workerSessionID, "mario", system);
    expect(system).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("passive notices preserve uncertain reconciliation and later legitimate dispatch", async () => {
  const f = await fixture(undefined, undefined, true);
  try {
    const task = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "Original work" },
        f.captain(),
      )
    ).task;
    if (!task) throw new Error("Missing task");
    const input = uncertainResult(f, task);
    await f.engine.updateNotice(
      buildUpdateSnapshot("0.37.0", {}, "- New notices"),
      {},
      new AbortController().signal,
    );
    expect(await f.engine.run(input, f.captain())).toMatchObject({
      status: "reconciled",
    });
    expect(
      (
        await f.engine.run(
          { op: "dispatch", crew: "mario", text: "Next legitimate work" },
          f.captain(),
        )
      ).task,
    ).toMatchObject({ status: "running" });
  } finally {
    await f.close();
  }
});

test("captain context admission verifies native identity and leaves native history unchanged", async () => {
  const f = await fixture(undefined, undefined, true);
  try {
    const input = {
      sessionID: "ses_captaina",
      id: "msg_update",
      text: "Stargate update notice: passive only",
    };
    expect(
      await f.engine.queueCaptainNotice(input, new AbortController().signal),
    ).toEqual({ id: input.id, sessionID: input.sessionID });
    expect(f.calls).toEqual([]);
    const system: { type: "text"; text: string }[] = [];
    f.engine.updateNoticeContext(input.sessionID, "foreign", system);
    expect(system).toEqual([]);
    f.engine.updateNoticeContext(input.sessionID, "bowser", system);
    expect(system).toEqual([{ type: "text", text: input.text }]);
    f.engine.updateNoticeContext(input.sessionID, "bowser", system);
    expect(system).toHaveLength(1);
    await expect(
      f.engine.queueCaptainNotice(
        { ...input, sessionID: "ses_foreign" },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test("Pi update notices use durable plain mail only, and failed mail is not reported as told", async () => {
  const team = Schema.decodeUnknownSync(teamSchema)({
    captain: { id: "bowser" },
    crew: [
      {
        id: "twiki",
        role: "Worker",
        permissionProfile: "coding",
        backend: {
          type: "pi-durable",
          model: "openai/gpt-6.1-sol",
          tools: "coding",
        },
      },
    ],
  });
  const f = await fixture(team, undefined, true);
  try {
    const peer = f.engine.state.reservePeer("twiki");
    f.engine.state.readyPeer("twiki");
    const snapshot = buildUpdateSnapshot(
      "0.37.0",
      { notifications: { updateNotice: true } },
      "- New tools",
    );
    const receipts = await f.engine.updateNotice(
      snapshot,
      {},
      new AbortController().signal,
    );
    expect(receipts).toEqual([{ sessionID: peer.sessionID, status: "mail" }]);
    expect(f.messages).toHaveLength(1);
    expect(f.synthetics).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(
      (
        await f.mailer.inbox(
          { sessionID: peer.sessionID },
          new AbortController().signal,
        )
      )[0]?.to,
    ).toBe(peer.sessionID);
    f.mailer.send = async () => {
      throw new Error("secret transport failure");
    };
    expect(
      (
        await f.engine.updateNotice(
          { ...snapshot, version: "0.38.0" },
          {},
          new AbortController().signal,
        )
      )[0]?.status,
    ).toBe("uncertain");
  } finally {
    await f.close();
  }
});

async function fixture(
  team?: Team,
  waitOptions?: CrewWaitOptions,
  pin = false,
  seededSchema = true,
) {
  const definition = team ?? defaultTeam;
  const directory = await mkdtemp(join(tmpdir(), "stargate-crew-"));
  const options: CrewOptions = {
    namespace: "bowser-one",
    stateDirectory: directory,
    captainDirectory: join(directory, "captain"),
    projectDirectory: directory,
    worktrees: Object.fromEntries(
      definition.crew.map(({ id }) => [id, join(directory, id)]),
    ),
    mesijCommand: "/usr/bin/mesij",
    ...(pin ? { captainSessionID: "ses_captaina" } : {}),
    ...(team ? { team } : {}),
  };
  const sessions = new Map<string, CrewSession>();
  for (const id of pin
    ? ["ses_captaina"]
    : ["ses_captain_a", "ses_captain_b"]) {
    sessions.set(id, {
      id,
      agent: definition.captain.agent ?? definition.captain.id,
      location: { directory: options.captainDirectory },
    });
  }
  const calls: { method: string; sessionID: string; text?: string }[] = [];
  const creations: SessionCreateInput[] = [];
  const inputs: SessionPromptInput[] = [];
  const history = new Map<string, EvidenceMessage[]>();
  const pendingInputs = new Set<string>();
  const pendingForms = new Set<string>();
  const pendingPermissions = new Set<string>();
  const messages: MesijMessage[] = [];
  const sentKeys = new Map<
    string,
    { text: string; id: string; sequence: number }
  >();
  const synthetics: SessionSyntheticInput[] = [];
  let promptHook = () => {};
  let createFailure = false;
  let promptFailure = false;
  let interruptFailure = false;
  const busy = new Set<string>();
  const client: CrewSessions = {
    async get({ sessionID }) {
      const session = sessions.get(sessionID);
      if (!session) throw { _tag: "Session.NotFoundError" };
      return session;
    },
    async create(input) {
      if (!input.id || !input.location || !input.agent)
        throw new Error("Invalid fixture create");
      calls.push({ method: "create", sessionID: input.id });
      creations.push(input);
      const session = {
        id: input.id,
        agent: input.agent,
        location: input.location,
        time: { updated: 100, busy: 50, idle: 100 },
        outcome: "succeeded" as const,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
      sessions.set(input.id, session);
      if (createFailure) throw new Error("secret raw SDK error");
      return session;
    },
    async prompt(input) {
      inputs.push(input);
      calls.push({
        method: "prompt",
        sessionID: input.sessionID,
        text: input.text,
      });
      busy.add(input.sessionID);
      promptHook();
      if (promptFailure) throw new Error("secret raw SDK error");
      // Accepted input is placed in the busy worker's native history.
      history.set(input.sessionID, [
        {
          id: input.id ?? "msg_fixture",
          type: "user",
          time: { created: 60 },
          text: input.text,
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
        ...(history.get(input.sessionID) ?? []),
      ]);
      return { id: input.id ?? "msg_fixture", sessionID: input.sessionID };
    },
    async wait({ sessionID }, request) {
      if (!busy.has(sessionID)) return;
      await new Promise<void>((_, reject) => {
        const signal = request?.signal;
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    async interrupt({ sessionID }, request) {
      expect(request?.signal?.aborted).toBe(false);
      calls.push({ method: "interrupt", sessionID });
      busy.delete(sessionID);
      if (interruptFailure) throw new Error("secret raw SDK error");
      return { interrupted: true };
    },
    async compact({ sessionID }) {
      calls.push({ method: "compact", sessionID });
    },
    async synthetic(input) {
      const { sessionID, text } = input;
      synthetics.push(input);
      calls.push({ method: "synthetic", sessionID, text });
      return { id: input.id, sessionID };
    },
  };
  const mailer: Pick<MesijClient, "register" | "send" | "inbox"> = {
    async register() {
      return { id: "0".repeat(32), sequence: 0 };
    },
    async send(input) {
      const previous = sentKeys.get(input.key);
      if (previous) {
        if (previous.text !== input.text)
          throw new Error("Conflicting Mesij replay key");
        return { id: previous.id, sequence: previous.sequence };
      }
      const event = {
        id: String(messages.length + 1).padStart(32, "0"),
        sequence: messages.length + 1,
        actor: input.actor,
        sessionID: input.sessionID,
        to: input.to,
        type: input.replyTo ? "message.replied" : "message.posted",
        text: input.text,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      };
      messages.push(event);
      sentKeys.set(input.key, event);
      return { id: event.id, sequence: event.sequence };
    },
    async inbox(input) {
      return messages
        .filter((message) => message.sequence > (input.after ?? 0))
        .slice(0, input.limit ?? 20);
    },
  };
  const agents: CrewAgents = {
    async get({ agentID }) {
      return {
        data: {
          mode: "primary",
          model: { providerID: "fixture", id: agentID },
        },
      };
    },
  };
  const inspectionAPI: CrewInspectionAPI = {
    session: {
      get: (input, request) => client.get(input, request),
      async active() {
        return Object.fromEntries(
          [...busy].map((sessionID) => [sessionID, { type: "running" }]),
        );
      },
      inbox: {
        async list({ sessionID }) {
          return pendingInputs.has(sessionID) ? [{ id: "pending-input" }] : [];
        },
      },
      form: {
        async list({ sessionID }) {
          return pendingForms.has(sessionID) ? [{ id: "pending-form" }] : [];
        },
      },
    },
    permission: {
      async list({ sessionID }) {
        return pendingPermissions.has(sessionID)
          ? [{ id: "pending-permission" }]
          : [];
      },
    },
    message: {
      async list({ sessionID }) {
        return { data: history.get(sessionID) ?? [], cursor: {} };
      },
    },
  };
  if (seededSchema) await copyCrewDatabase(directory, options.namespace);
  const engine = await CrewEngine.open(
    options,
    client,
    mailer,
    agents,
    undefined,
    async () => inspectionAPI,
    undefined,
    waitOptions,
  );
  let toolCall = 0;
  const captain = (
    id = pin ? "ses_captaina" : "ses_captain_a",
    signal = new AbortController().signal,
  ) => ({
    sessionID: id,
    agent: definition.captain.agent ?? definition.captain.id,
    signal,
    id: `captain-tool-call-${++toolCall}`,
  });
  const worker = (sessionID: string, agent = definition.crew[0]?.id ?? "") => ({
    sessionID,
    agent: definition.crew.find(({ id }) => id === agent)?.agent ?? agent,
    signal: new AbortController().signal,
    id: `worker-tool-call-${++toolCall}`,
  });
  return {
    options,
    engine,
    client,
    sessions,
    calls,
    creations,
    synthetics,
    inputs,
    history,
    inspectionAPI,
    pendingInputs,
    pendingForms,
    pendingPermissions,
    messages,
    mailer,
    agents,
    busy,
    captain,
    worker,
    onPrompt(hook: () => void) {
      promptHook = hook;
    },
    failCreate: () => {
      createFailure = true;
    },
    failPrompt: () => {
      promptFailure = true;
    },
    failInterrupt: () => {
      interruptFailure = true;
    },
    async close() {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function assignedTask(f: Awaited<ReturnType<typeof fixture>>) {
  const task = (
    await f.engine.run(
      { op: "dispatch", crew: "builder", text: "Original task" },
      f.captain(),
    )
  ).task;
  if (!task) throw new Error("Missing assigned fixture task");
  return task;
}

function uncertainResult(
  f: Awaited<ReturnType<typeof fixture>>,
  task: CrewTask,
  result = "Verified original result",
) {
  const admitted = f.inputs.find((input) => input.id === task.inputID);
  if (!admitted) throw new Error("Missing admitted input");
  f.history.set(task.workerSessionID, [
    {
      id: "msg_retained_final",
      type: "assistant",
      time: { created: 70, completed: 80 },
      agent: task.crewID,
      finish: "stop",
      content: [
        { type: "reasoning", text: "private fixture reasoning" },
        { type: "text", text: result },
      ],
    },
    {
      id: task.inputID,
      type: "user",
      time: { created: 60 },
      text: admitted.text,
      ...(admitted.metadata ? { metadata: admitted.metadata } : {}),
    },
  ]);
  f.busy.delete(task.workerSessionID);
  f.engine.state.uncertain(task.id);
  return {
    op: "reconcile" as const,
    taskID: task.id,
    expected: {
      status: "uncertain" as const,
      workerSessionID: task.workerSessionID,
      originCaptainID: task.originCaptainID,
      inputID: task.inputID,
    },
    resultMessageID: "msg_retained_final",
    resultSha256: createHash("sha256").update(result).digest("hex"),
    reason: "Operator reviewed the retained task result and external outcome.",
  };
}

test("cutover reconciles immutable historical pogoCrew evidence with its original text hash", async () => {
  const f = await fixture(customTeam);
  try {
    const task = await assignedTask(f);
    const input = uncertainResult(f, task);
    const messages = f.history.get(task.workerSessionID);
    const admitted = messages?.find((message) => message.id === task.inputID);
    if (!admitted?.text) throw new Error("Missing retained input");
    admitted.text = admitted.text.replace(
      "Stargate task envelope: ",
      "Pogo task envelope: ",
    );
    admitted.metadata = {
      pogoCrew: { taskID: task.id, originCaptainID: task.originCaptainID },
    };
    const originalHash = createHash("sha256")
      .update(admitted.text)
      .digest("hex");
    const history = JSON.stringify(messages);
    const nativeWrites = () =>
      f.calls.filter(({ method }) =>
        ["prompt", "synthetic", "create"].includes(method),
      ).length;
    const before = nativeWrites();
    expect(await f.engine.run(input, f.captain())).toMatchObject({
      status: "reconciled",
    });
    expect(f.engine.state.reconciliation(task.id)?.inputSha256).toBe(
      originalHash,
    );
    expect(JSON.stringify(messages)).toBe(history);
    expect(nativeWrites()).toBe(before);
  } finally {
    await f.close();
  }
});

test("worker reads its own task status without captain mediation or execution", async () => {
  const f = await fixture({ ...defaultTeam, toolAccess: "direct" });
  try {
    const task = await f.engine.run(
      { op: "dispatch", crew: "mario", text: "Read status independently" },
      f.captain(),
    );
    const peer = f.engine.state.peer("mario");
    if (!peer || !task.task) throw new Error("Missing task fixture");
    const before = f.calls.length;
    const status = await f.engine.run(
      { op: "status", taskID: task.task.id },
      f.worker(peer.sessionID),
    );
    expect(status.status).toBe("running");
    expect(f.calls.length).toBe(before);
    expect(f.creations[0]?.permissions?.[0]).toEqual({
      action: "*",
      resource: "*",
      effect: "allow",
    });
    await expect(
      f.engine.run(
        { op: "status", taskID: task.task.id },
        f.worker(peer.sessionID, "luigi"),
      ),
    ).rejects.toThrow();
  } finally {
    await f.engine.close();
  }
});

test("waiting changes reject children, foreign roots and worker impersonation", async () => {
  const f = await fixture();
  try {
    const waiting = new CrewWaiting(f.engine);
    const path = waitingSettingsPath(f.options.captainDirectory, "bowser");
    const captain = f.sessions.get("ses_captain_a");
    if (!captain) throw new Error("missing captain fixture");
    f.sessions.set("ses_child", {
      ...captain,
      id: "ses_child",
      parentID: captain.id,
    });
    f.sessions.set("ses_foreign", {
      ...captain,
      id: "ses_foreign",
      location: { directory: "/foreign" },
    });
    for (const sessionID of ["ses_child", "ses_foreign"]) {
      await expect(
        waiting.run({ seconds: 3 }, f.captain(sessionID)),
      ).rejects.toThrow("root configured captain");
    }
    const peers = (await f.engine.run({ op: "ensure" }, f.captain())).peers;
    const workerID = peers?.[0]?.sessionID ?? "missing";
    await expect(
      waiting.run({ seconds: 3 }, f.worker(workerID)),
    ).rejects.toThrow("captain sessions");
    await expect(
      waiting.run({ seconds: 3 }, f.captain(workerID)),
    ).rejects.toThrow("captain sessions");
    expect(await Bun.file(path).exists()).toBe(false);
    await waiting.run({ seconds: 3 }, f.captain());
    expect(await Bun.file(path).json()).toEqual({ delayMs: 3000 });
  } finally {
    await f.close();
  }
});

test("crew reuses four bot-wide roots across captains and reopening", async () => {
  const f = await fixture();
  try {
    const first = await f.engine.run({ op: "ensure" }, f.captain());
    const second = await f.engine.run(
      { op: "ensure" },
      f.captain("ses_captain_b"),
    );
    expect(second.peers).toEqual(first.peers);
    expect(first.peers).toHaveLength(4);
    expect(f.calls.filter((call) => call.method === "create")).toHaveLength(4);
    expect(f.calls.filter((call) => call.method === "prompt")).toHaveLength(0);
    expect((await stat(f.engine.state.path)).mode & 0o777).toBe(0o600);
    const reopened = await CrewEngine.open(f.options, f.client);
    try {
      expect((await reopened.run({ op: "ensure" }, f.captain())).peers).toEqual(
        first.peers,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

const customTeam: Team = {
  captain: { id: "lead", name: "Lead" },
  crew: [
    { id: "builder", role: "Implementation", permissionProfile: "coding" },
    { id: "reader", role: "Research", permissionProfile: "research" },
  ],
};

test("custom roster authorizes real sessions and applies permission profiles", async () => {
  const f = await fixture(customTeam);
  try {
    const peers = (await f.engine.run({ op: "ensure" }, f.captain())).peers;
    expect(peers?.map((peer) => peer.crewID)).toEqual(["builder", "reader"]);
    expect(f.creations[0]?.permissions).toContainEqual({
      action: "edit",
      resource: "*",
      effect: "allow",
    });
    expect(f.creations[1]?.permissions).toContainEqual({
      action: "edit",
      resource: "*",
      effect: "allow",
    });
    await f.engine.authorize(f.worker(peers?.[0]?.sessionID ?? ""));
    await expect(
      f.engine.run({ op: "ensure", crew: "mario" }, f.captain()),
    ).rejects.toThrow("configured");
    const worker = f.sessions.get(peers?.[0]?.sessionID ?? "");
    if (!worker) throw new Error("Missing worker");
    worker.location.directory = "/wrong";
    await expect(f.engine.authorize(f.worker(worker.id))).rejects.toThrow(
      "identity",
    );
  } finally {
    await f.close();
  }
});

test("captain selects queued order after completion plus idle, preserving unselected work", async () => {
  const f = await fixture(customTeam);
  const reopened = await CrewEngine.open(
    f.options,
    f.client,
    f.mailer,
    f.agents,
  );
  try {
    const first = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "One" },
        f.captain(),
      )
    ).task;
    const second = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "Two", queue: true },
        f.captain(),
      )
    ).task;
    const third = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "Three", queue: true },
        f.captain(),
      )
    ).task;
    expect(second?.status).toBe("queued");
    expect(f.calls.filter((call) => call.method === "prompt")).toHaveLength(1);
    await f.engine.run(
      { op: "complete", taskID: first?.id, result: "Done" },
      f.worker(first?.workerSessionID ?? ""),
    );
    expect(
      (await reopened.run({ op: "status", taskID: second?.id }, f.captain()))
        .status,
    ).toBe("queued");
    f.busy.delete(first?.workerSessionID ?? "");
    expect(
      (await reopened.run({ op: "status", taskID: third?.id }, f.captain()))
        .status,
    ).toBe("running");
    expect(
      (await reopened.run({ op: "status", taskID: second?.id }, f.captain()))
        .status,
    ).toBe("queued");
    expect(
      f.calls.filter((call) => call.method === "prompt").at(-1)?.text,
    ).toContain("Three");
    await f.engine.run(
      { op: "complete", taskID: third?.id, result: "Done too" },
      f.worker(third?.workerSessionID ?? ""),
    );
    f.busy.delete(third?.workerSessionID ?? "");
    expect(
      (await reopened.run({ op: "status", taskID: second?.id }, f.captain()))
        .status,
    ).toBe("running");
  } finally {
    await reopened.close();
    await f.close();
  }
});

test("cancelling queued wait never interrupts another captain's running task", async () => {
  const f = await fixture(customTeam);
  try {
    const running = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "One" },
        f.captain(),
      )
    ).task;
    const queued = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "Two", queue: true },
        f.captain("ses_captain_b"),
      )
    ).task;
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.engine.run(
        { op: "wait", taskID: queued?.id },
        f.captain("ses_captain_b", controller.signal),
      ),
    ).rejects.toThrow("cancelled");
    expect(f.calls.some((call) => call.method === "interrupt")).toBe(false);
    expect(f.engine.state.task(queued?.id ?? "")?.status).toBe("cancelled");
    expect(f.engine.state.activeTask("builder")?.id).toBe(running?.id);
  } finally {
    await f.close();
  }
});

test("worker control reserves across instances without blocking other slots", async () => {
  const f = await fixture(customTeam);
  const second = await CrewEngine.open(f.options, f.client, f.mailer, f.agents);
  try {
    await f.engine.withWorkerControl("builder", f.captain(), async (peer) => {
      expect(peer.crewID).toBe("builder");
      expect(
        (
          await second.run(
            { op: "dispatch", crew: "builder", text: "Blocked" },
            f.captain(),
          )
        ).status,
      ).toBe("busy");
      expect(
        (
          await second.run(
            { op: "dispatch", crew: "reader", text: "Independent" },
            f.captain(),
          )
        ).status,
      ).toBe("running");
      await expect(
        second.withWorkerControl("builder", f.captain(), async () => {}),
      ).rejects.toThrow("control");
    });
    expect(
      (
        await second.run(
          { op: "dispatch", crew: "builder", text: "After control" },
          f.captain(),
        )
      ).status,
    ).toBe("running");
    await expect(
      f.engine.withWorkerControl("builder", f.captain(), async () => {}),
    ).rejects.toThrow("running");
  } finally {
    await second.close();
    await f.close();
  }
});

test(
  "two teams sharing one server isolate roots, results, mail and urgency",
  async () => {
    const a = await fixture(customTeam);
    const b = await fixture(customTeam);
    const otherOptions = { ...b.options, namespace: "other-team" };
    const other = await CrewEngine.open(
      otherOptions,
      a.client,
      a.mailer,
      a.agents,
    );
    const otherCaller = { ...b.captain(), sessionID: "ses_other_captain" };
    a.sessions.set(otherCaller.sessionID, {
      id: otherCaller.sessionID,
      agent: customTeam.captain.id,
      location: { directory: otherOptions.captainDirectory },
    });
    try {
      const first = (
        await a.engine.run(
          { op: "dispatch", crew: "builder", text: "Team A" },
          a.captain(),
        )
      ).task;
      const second = (
        await other.run(
          { op: "dispatch", crew: "builder", text: "Team B" },
          otherCaller,
        )
      ).task;
      expect(second?.workerSessionID).not.toBe(first?.workerSessionID);
      await expect(
        other.run({ op: "status", taskID: first?.id }, otherCaller),
      ).rejects.toThrow("does not own");
      await expect(
        other.authorize(a.worker(first?.workerSessionID ?? "")),
      ).rejects.toThrow("assigned worker");
      await expect(other.captain(a.captain())).rejects.toThrow("configured");
      await a.engine.mail(
        {
          op: "send",
          taskID: first?.id,
          to: "captain",
          key: "same",
          text: "A private mail",
        },
        a.worker(first?.workerSessionID ?? ""),
      );
      await other.mail(
        {
          op: "send",
          taskID: second?.id,
          to: "captain",
          key: "same",
          text: "B private mail",
        },
        a.worker(second?.workerSessionID ?? ""),
      );
      expect(
        (
          await a.engine.mail({ op: "inbox", taskID: first?.id }, a.captain())
        ).messages?.map((mail) => mail.text),
      ).toEqual(["A private mail"]);
      expect(
        (
          await other.mail({ op: "inbox", taskID: second?.id }, otherCaller)
        ).messages?.map((mail) => mail.text),
      ).toEqual(["B private mail"]);
      await other.run(
        { op: "urgent", taskID: second?.id, to: "builder", text: "B only" },
        otherCaller,
      );
      expect(
        a.calls
          .filter((call) => call.method === "synthetic")
          .map((call) => call.sessionID),
      ).toEqual([second?.workerSessionID ?? ""]);
      await other.run(
        { op: "complete", taskID: second?.id, result: "B result" },
        a.worker(second?.workerSessionID ?? ""),
      );
      expect(
        (await other.run({ op: "status", taskID: second?.id }, otherCaller))
          .task?.result,
      ).toBe("B result");
      expect(
        (await a.engine.run({ op: "status", taskID: first?.id }, a.captain()))
          .task?.result,
      ).toBeNull();
    } finally {
      await other.close();
      await a.close();
      await b.close();
    }
  },
  diskIntegrationTimeoutMs,
);

test("identity changes refuse rebinding; invalid and overlapping worktrees fail", async () => {
  const f = await fixture(customTeam);
  try {
    const changed: Team = { ...customTeam, captain: { id: "different-lead" } };
    await expect(
      CrewEngine.open({ ...f.options, team: changed }, f.client),
    ).rejects.toThrow("new namespace");
    await expect(
      CrewEngine.open(
        {
          ...f.options,
          worktrees: { ...f.options.worktrees, extra: "/extra" },
        },
        f.client,
      ),
    ).rejects.toThrow("exact configured");
    await expect(
      CrewEngine.open(
        { ...f.options, captainDirectory: f.options.projectDirectory },
        f.client,
      ),
    ).rejects.toThrow("non-nested");
    await mkdir(f.options.captainDirectory);
    const alias = join(f.options.projectDirectory, "captain-alias");
    await symlink(f.options.captainDirectory, alias);
    await expect(
      CrewEngine.open(
        {
          ...f.options,
          worktrees: { ...f.options.worktrees, builder: join(alias, "nested") },
        },
        f.client,
      ),
    ).rejects.toThrow("symbolic links");
  } finally {
    await f.close();
  }
});

test("queued prompt uncertainty never replays and preserves later FIFO work", async () => {
  const f = await fixture(customTeam);
  try {
    const first = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "First" },
        f.captain(),
      )
    ).task;
    const queued = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "Ambiguous", queue: true },
        f.captain(),
      )
    ).task;
    const later = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "Later", queue: true },
        f.captain(),
      )
    ).task;
    await f.engine.run(
      { op: "complete", taskID: first?.id, result: "Done" },
      f.worker(first?.workerSessionID ?? ""),
    );
    f.busy.delete(first?.workerSessionID ?? "");
    f.failPrompt();
    await expect(
      f.engine.run({ op: "status", taskID: queued?.id }, f.captain()),
    ).rejects.toThrow("not be replayed");
    expect(
      (await f.engine.run({ op: "status", taskID: queued?.id }, f.captain()))
        .status,
    ).toBe("uncertain");
    expect(
      (await f.engine.run({ op: "status", taskID: later?.id }, f.captain()))
        .status,
    ).toBe("queued");
    expect(f.calls.filter((call) => call.method === "prompt")).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("default Bowser legacy fingerprint reopens with the same task and worker IDs", async () => {
  // Keep first-create setup on the constructor path for this migration case.
  const f = await fixture(undefined, undefined, false, false);
  try {
    const task = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "Legacy" },
        f.captain(),
      )
    ).task;
    await f.engine.run(
      { op: "complete", taskID: task?.id, result: "Legacy result" },
      f.worker(task?.workerSessionID ?? ""),
    );
    const db = new Database(f.engine.state.path);
    const oldFingerprint = JSON.stringify([
      f.options.namespace,
      resolve(f.options.projectDirectory),
      resolve(f.options.captainDirectory),
      ...defaultTeam.crew.map(({ id }) =>
        resolve(f.options.worktrees[id] ?? ""),
      ),
    ]);
    db.query("UPDATE identity SET value=?").run(oldFingerprint);
    db.close();
    const changed: Team = {
      ...defaultTeam,
      crew: defaultTeam.crew.map((member) => ({
        ...member,
        permissionProfile: "coding",
      })),
    };
    await expect(
      CrewEngine.open({ ...f.options, team: changed }, f.client),
    ).rejects.toThrow("configuration changed");
    const reopened = await CrewEngine.open(
      f.options,
      f.client,
      f.mailer,
      f.agents,
    );
    try {
      const saved = await reopened.run(
        { op: "status", taskID: task?.id },
        f.captain(),
      );
      expect(saved.task?.workerSessionID).toBe(task?.workerSessionID);
      expect(saved.task?.result).toBe("Legacy result");
      expect(
        (await reopened.run({ op: "ensure", crew: "mario" }, f.captain()))
          .peers?.[0]?.sessionID,
      ).toBe(task?.workerSessionID);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

test("queued wait promotes once under contention and returns the owned result", async () => {
  const f = await fixture(customTeam);
  const second = await CrewEngine.open(f.options, f.client, f.mailer, f.agents);
  try {
    const running = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "First" },
        f.captain(),
      )
    ).task;
    const queued = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "Second", queue: true },
        f.captain(),
      )
    ).task;
    await f.engine.run(
      { op: "complete", taskID: running?.id, result: "Done" },
      f.worker(running?.workerSessionID ?? ""),
    );
    f.busy.delete(running?.workerSessionID ?? "");
    f.onPrompt(() => {
      const current = f.engine.state.activeTask("builder");
      if (!current) throw new Error("Missing task");
      f.engine.state.complete(
        current.id,
        current.workerSessionID,
        "Queued result",
      );
      f.busy.delete(current.workerSessionID);
    });
    const results = await Promise.all([
      f.engine.run({ op: "wait", taskID: queued?.id }, f.captain()),
      second.run({ op: "status", taskID: queued?.id }, f.captain()),
    ]);
    expect(results[0]?.task?.result).toBe("Queued result");
    expect(results[0]?.status).toBe("completed");
    expect(f.calls.filter((call) => call.method === "prompt")).toHaveLength(2);
  } finally {
    await second.close();
    await f.close();
  }
});

test("concurrent queued wait does not treat pre-admission idle as worker exit", async () => {
  const f = await fixture(customTeam);
  const second = await CrewEngine.open(f.options, f.client, f.mailer, f.agents);
  const admissionStarted = Promise.withResolvers<void>();
  const allowAdmission = Promise.withResolvers<void>();
  const admitted = Promise.withResolvers<void>();
  const dispatchingObserved = Promise.withResolvers<void>();
  const runningObserved = Promise.withResolvers<void>();
  const controller = new AbortController();
  const waits: Promise<unknown>[] = [];
  try {
    const first = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "First" },
        f.captain(),
      )
    ).task;
    const queued = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "Second", queue: true },
        f.captain(),
      )
    ).task;
    if (!first || !queued) throw new Error("Missing task fixture");
    await f.engine.run(
      { op: "complete", taskID: first.id, result: "First done" },
      f.worker(first.workerSessionID),
    );
    f.busy.delete(first.workerSessionID);
    const prompt = f.client.prompt.bind(f.client);
    f.client.prompt = async (input, request) => {
      admissionStarted.resolve();
      await allowAdmission.promise;
      const result = await prompt(input, request);
      admitted.resolve();
      return result;
    };
    const notices = second.state.notices.bind(second.state);
    let dispatchingPolls = 0;
    second.state.notices = (id, after) => {
      if (
        id === queued.id &&
        second.state.task(id)?.status === "dispatching" &&
        ++dispatchingPolls === 2
      )
        dispatchingObserved.resolve();
      return notices(id, after);
    };
    const wait = f.client.wait.bind(f.client);
    f.client.wait = async (input, request) => {
      if (second.state.task(queued.id)?.status === "running")
        runningObserved.resolve();
      return wait(input, request);
    };
    const collect = (engine: CrewEngine) =>
      engine
        .run(
          { op: "wait", taskID: queued.id },
          f.captain("ses_captain_a", controller.signal),
        )
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
    const promoting = collect(f.engine);
    waits.push(promoting);
    await admissionStarted.promise;
    const observing = collect(second);
    waits.push(observing);
    await dispatchingObserved.promise;
    expect(second.state.task(queued.id)?.status).toBe("dispatching");
    allowAdmission.resolve();
    await admitted.promise;
    await runningObserved.promise;
    expect(second.state.task(queued.id)?.status).toBe("running");
    await f.engine.run(
      { op: "complete", taskID: queued.id, result: "Second done" },
      f.worker(queued.workerSessionID),
    );
    f.busy.delete(queued.workerSessionID);
    for (const result of await Promise.all([promoting, observing]))
      expect(result).toMatchObject({
        result: { status: "completed", task: { result: "Second done" } },
      });
  } finally {
    controller.abort();
    allowAdmission.resolve();
    await Promise.allSettled(waits);
    await second.close();
    await f.close();
  }
});

test("admitted worker exit without completion stays uncertain and is not replayed", async () => {
  const f = await fixture(customTeam);
  try {
    const task = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "Interrupted work" },
        f.captain(),
      )
    ).task;
    if (!task) throw new Error("Missing task fixture");
    expect(task.status).toBe("running");
    f.busy.delete(task.workerSessionID);
    await expect(
      f.engine.run({ op: "wait", taskID: task.id }, f.captain()),
    ).rejects.toThrow("without a confirmed result");
    expect(f.engine.state.task(task.id)?.status).toBe("uncertain");
    expect(
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "Do not replay" },
        f.captain(),
      ),
    ).toMatchObject({ status: "busy" });
    expect(f.calls.filter((call) => call.method === "prompt")).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("captain inspection reads cross-origin ownership without promoting queued work", async () => {
  const f = await fixture(customTeam);
  try {
    const active = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "Original task" },
        f.captain(),
      )
    ).task;
    const queued = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "Next", queue: true },
        f.captain("ses_captain_b"),
      )
    ).task;
    const result = await f.engine.run(
      { op: "inspect", crew: "builder" },
      f.captain("ses_captain_b"),
    );
    expect(result).toMatchObject({
      status: "inspected",
      active: { id: active?.id, originCaptainID: "ses_captain_a" },
      queued: [{ id: queued?.id, originCaptainID: "ses_captain_b" }],
    });
    expect(f.calls.filter((call) => call.method === "prompt")).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("cross-origin captain reconciles exact evidence, retains audit and selects own queued work", async () => {
  const f = await fixture(customTeam);
  try {
    const original = await assignedTask(f);
    const queued: CrewTask[] = [];
    for (const text of ["Next", "Later"]) {
      const task = (
        await f.engine.run(
          { op: "dispatch", crew: "builder", text, queue: true },
          f.captain("ses_captain_b"),
        )
      ).task;
      if (!task) throw new Error("Missing queue fixture");
      queued.push(task);
    }
    f.engine.state.notice(original.id, "Saved notice");
    f.engine.state.mailCursor(original.originCaptainID, original.id, 42);
    const input = uncertainResult(f, original);
    const reconciled = await f.engine.run(input, f.captain("ses_captain_b"));
    expect(reconciled).toMatchObject({
      status: "reconciled",
      reconciliation: {
        taskID: original.id,
        workerSessionID: original.workerSessionID,
        originCaptainID: original.originCaptainID,
        inputID: original.inputID,
        reconciledBy: "ses_captain_b",
        previousStatus: "uncertain",
        previousResult: null,
        resultMessageID: input.resultMessageID,
        resultSha256: input.resultSha256,
        reason: input.reason,
      },
    });
    expect(reconciled.reconciliation?.inputSha256).toBe(
      createHash("sha256")
        .update(f.inputs[0]?.text ?? "")
        .digest("hex"),
    );
    expect(f.engine.state.task(original.id)).toEqual({
      ...original,
      status: "completed",
      result: "Verified original result",
    });
    expect(
      f.engine.state.mailCursor(original.originCaptainID, original.id),
    ).toBe(42);
    expect(f.engine.state.notices(original.id, 0)[0]?.text).toBe(
      "Saved notice",
    );
    expect(f.engine.state.controlled("builder")).toBe(false);
    expect(f.engine.state.queuedTasks("builder")).toEqual(queued);
    expect(f.engine.state.peer("builder")?.sessionID).toBe(
      original.workerSessionID,
    );
    const reopened = await CrewEngine.open(
      f.options,
      f.client,
      f.mailer,
      f.agents,
    );
    try {
      expect(reopened.state.reconciliation(original.id)).toEqual(
        reconciled.reconciliation ?? null,
      );
      const later = queued[1];
      const next = queued[0];
      if (!next || !later) throw new Error("Missing queue head");
      expect(
        (
          await reopened.run(
            { op: "status", taskID: later.id },
            f.captain("ses_captain_b"),
          )
        ).status,
      ).toBe("running");
      expect(
        (
          await reopened.run(
            { op: "status", taskID: next.id },
            f.captain("ses_captain_b"),
          )
        ).status,
      ).toBe("queued");
      expect(await f.engine.run(input, f.captain("ses_captain_b"))).toEqual(
        reconciled,
      );
      expect(f.engine.state.activeTask("builder")?.id).toBe(later.id);
      expect(f.engine.state.task(original.id)?.originCaptainID).toBe(
        original.originCaptainID,
      );
      await expect(
        f.engine.run(
          { op: "status", taskID: original.id },
          f.captain("ses_captain_b"),
        ),
      ).rejects.toThrow("does not own");
      const inspection = await f.engine.run(
        { op: "inspect", crew: "builder", taskID: original.id },
        f.captain("ses_captain_b"),
      );
      expect(inspection.reconciliation).toEqual(reconciled.reconciliation);
      expect(inspection.inspectedTask?.id).toBe(original.id);
    } finally {
      await reopened.close();
    }
    expect(f.calls.filter((call) => call.method === "prompt")).toHaveLength(2);
    expect(f.calls.some((call) => call.method === "interrupt")).toBe(false);
  } finally {
    await f.close();
  }
});

test("Mesij cross-origin status requests and replies preserve original task lineage and never wake workers", async () => {
  const f = await fixture(customTeam);
  try {
    const task = await assignedTask(f);
    uncertainResult(f, task);
    const request = await f.engine.run(
      { op: "inspect", crew: "builder", requestStatus: { key: "status-one" } },
      f.captain("ses_captain_b"),
    );
    expect(request.statusRequest?.id).toBeDefined();
    const retried = await f.engine.run(
      { op: "inspect", crew: "builder", requestStatus: { key: "status-one" } },
      f.captain("ses_captain_b"),
    );
    expect(retried.statusRequest).toEqual(request.statusRequest);
    expect(f.messages).toHaveLength(1);
    const inbox = await f.engine.mail(
      { op: "inbox" },
      f.worker(task.workerSessionID),
    );
    expect(inbox.messages?.[0]?.text).toContain("Status request");
    const receiptID = inbox.messages?.[0]?.id;
    await f.engine.mail(
      {
        op: "send",
        taskID: task.id,
        to: "captain",
        key: "status-reply",
        replyTo: receiptID,
        text: "Finished; retained final message available.",
      },
      f.worker(task.workerSessionID),
    );
    const replies = await f.engine.mail(
      { op: "inbox", taskID: task.id },
      f.captain("ses_captain_b"),
    );
    expect(replies.messages?.map((message) => message.text)).toEqual([
      "Finished; retained final message available.",
    ]);
    expect(
      (
        await f.engine.mail({ op: "inbox" }, f.captain("ses_captain_b"))
      ).messages?.map(({ text }) => text),
    ).toEqual(["Finished; retained final message available."]);
    const envelope = JSON.parse(f.messages[1]?.text ?? "{}");
    expect(envelope.originCaptainID).toBe(task.originCaptainID);
    expect(envelope.targetTaskID).toBe(task.id);
    expect(f.engine.state.task(task.id)?.originCaptainID).toBe(
      task.originCaptainID,
    );
    await expect(
      f.engine.mail(
        {
          op: "send",
          taskID: task.id,
          to: "captain",
          text: "Not my task",
          key: "forbidden",
        },
        f.captain("ses_captain_b"),
      ),
    ).rejects.toThrow("does not own");
    expect(f.calls.filter((call) => call.method === "prompt")).toHaveLength(1);
    expect(
      f.calls.some(
        (call) => call.method === "synthetic" || call.method === "interrupt",
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

for (const state of ["running", "uncertain", "completed"] as const) {
  test(`installed status requests remain visible and reply-scoped for ${state} workers`, async () => {
    const f = await fixture(profileTeam(customTeam, "ship"));
    try {
      const task = await assignedTask(f);
      if (state === "uncertain") uncertainResult(f, task);
      const requested = await f.engine.run(
        { op: "inspect", crew: "builder", requestStatus: { key: "interop" } },
        f.captain("ses_captain_b"),
      );
      const receiptID = requested.statusRequest?.id;
      if (!receiptID) throw new Error("Missing status request receipt");
      // Simulate an installed request predating mail_routes, then a restart.
      const db = new Database(f.engine.state.path);
      try {
        db.query("DELETE FROM mail_routes WHERE id=?").run(receiptID);
      } finally {
        db.close();
      }
      if (state === "completed") {
        await f.engine.run(
          { op: "complete", taskID: task.id, result: "Done" },
          f.worker(task.workerSessionID),
        );
        f.busy.delete(task.workerSessionID);
      }
      const reopened = await CrewEngine.open(
        f.options,
        f.client,
        f.mailer,
        f.agents,
        undefined,
        async () => f.inspectionAPI,
      );
      try {
        const worker = f.worker(task.workerSessionID);
        expect(
          (await reopened.mail({ op: "inbox" }, worker)).messages?.map(
            ({ id }) => id,
          ),
        ).toEqual([receiptID]);
        for (const to of ["captain", "all", "builder"]) {
          await expect(
            reopened.mail(
              {
                op: "send",
                to,
                taskID: task.id,
                replyTo: receiptID,
                text: "wrong task",
                key: `wrong-${to}`,
              },
              f.captain(),
            ),
          ).rejects.toThrow("validated message");
        }
        await expect(
          reopened.mail(
            {
              op: "send",
              to: "captain",
              taskID: "task_foreign",
              replyTo: receiptID,
              text: "wrong task",
              key: "wrong-task",
            },
            worker,
          ),
        ).rejects.toThrow();
        if (state !== "running")
          await expect(
            reopened.mail(
              {
                op: "send",
                to: "captain",
                taskID: task.id,
                text: "stale task",
                key: "stale",
              },
              worker,
            ),
          ).rejects.toThrow("current task");
        expect(
          await reopened.mail(
            {
              op: "send",
              to: "captain",
              taskID: task.id,
              replyTo: receiptID,
              text: "Status only",
              key: "valid",
            },
            worker,
          ),
        ).toMatchObject({ stored: true, notification: "not_requested" });
        const reply = f.messages.at(-1);
        if (!reply) throw new Error("Missing status reply");
        const oldReply = new Database(reopened.state.path);
        try {
          oldReply.query("DELETE FROM mail_routes WHERE id=?").run(reply.id);
        } finally {
          oldReply.close();
        }
        expect(
          (
            await reopened.mail({ op: "inbox" }, f.captain("ses_captain_b"))
          ).messages?.map(({ text }) => text),
        ).toEqual(["Status only"]);
        expect(
          (
            await reopened.mail(
              { op: "inbox", taskID: task.id },
              f.captain("ses_captain_b"),
            )
          ).messages?.map(({ text }) => text),
        ).toEqual(["Status only"]);
        f.sessions.set("ses_captain_c", {
          id: "ses_captain_c",
          agent: "ship-captain-lead",
          location: { directory: f.options.captainDirectory },
        });
        expect(
          (await reopened.mail({ op: "inbox" }, f.captain("ses_captain_c")))
            .messages,
        ).toEqual([]);
        await expect(
          reopened.mail(
            { op: "inbox", taskID: task.id },
            f.captain("ses_captain_c"),
          ),
        ).rejects.toThrow("does not own");
        expect(reopened.state.task(task.id)).toMatchObject({
          status: state,
          originCaptainID: "ses_captain_a",
        });
        expect(
          f.calls.filter(({ method }) => method === "prompt"),
        ).toHaveLength(1);
        expect(f.synthetics).toEqual([]);
      } finally {
        await reopened.close();
      }
    } finally {
      await f.close();
    }
  });
}

for (const native of ["builder", "ship-crew-builder", "foreign"]) {
  test(`installed reconciliation validates mapped or historical native result: ${native}`, async () => {
    const f = await fixture(profileTeam(customTeam, "ship"));
    try {
      const task = await assignedTask(f);
      const input = uncertainResult(f, task);
      const final = f.history.get(task.workerSessionID)?.[0];
      if (!final) throw new Error("Missing final answer");
      final.agent = native;
      if (native === "foreign") {
        await expect(
          f.engine.run(input, f.captain("ses_captain_b")),
        ).rejects.toThrow("Final result evidence");
        expect(f.engine.state.task(task.id)?.status).toBe("uncertain");
      } else {
        const result = JSON.parse(
          await runRecoveryOperator(
            f.engine,
            { sessionID: "ses_captain_b", request: input },
            f.captain().signal,
          ),
        );
        expect(result.status).toBe("reconciled");
        expect(f.engine.state.task(task.id)).toMatchObject({
          status: "completed",
          originCaptainID: "ses_captain_a",
        });
      }
    } finally {
      await f.close();
    }
  });
}

test("installed maintenance uses mapped captain authorization and rejects foreign roots", async () => {
  const f = await fixture(profileTeam(customTeam, "ship"));
  const gate = new CrewMaintenance(f.engine);
  try {
    await gate.open(
      { sessionID: "ses_captain_a", id: "mapped" },
      f.captain().signal,
    );
    gate.close({ sessionID: "ses_captain_a", id: "mapped" });
    const root = f.sessions.get("ses_captain_b");
    if (!root) throw new Error("Missing root");
    root.agent = "lead";
    await gate.open(
      { sessionID: root.id, id: "historical" },
      f.captain().signal,
    );
    gate.close({ sessionID: root.id, id: "historical" });
    root.agent = "foreign";
    await expect(
      gate.open({ sessionID: root.id, id: "foreign" }, f.captain().signal),
    ).rejects.toThrow("root configured captain");
  } finally {
    gate.dispose();
    await f.close();
  }
});

test("installed status inbox rejects forged legacy request/reply lineage", async () => {
  const f = await fixture(customTeam);
  try {
    const task = await assignedTask(f);
    const request = await f.engine.run(
      { op: "inspect", crew: "builder", requestStatus: { key: "status" } },
      f.captain("ses_captain_b"),
    );
    if (!request.statusRequest) throw new Error("Missing request");
    const original = f.messages[0];
    if (!original) throw new Error("Missing event");
    const envelope = JSON.parse(original.text);
    const reply = {
      ...original,
      id: "f".repeat(32),
      sequence: 2,
      sessionID: task.workerSessionID,
      actor: f.engine.mailActor(task.workerSessionID),
      to: "ses_captain_b",
      replyTo: original.id,
      text: JSON.stringify({
        ...envelope,
        sender: task.workerSessionID,
        recipient: "ses_captain_b",
        text: "Retained status",
      }),
    };
    f.messages.push(reply);
    expect(
      (
        await f.engine.mail({ op: "inbox" }, f.captain("ses_captain_b"))
      ).messages?.map(({ text }) => text),
    ).toEqual(["Retained status"]);
    const retainedReply = JSON.parse(reply.text);
    for (const changes of [
      { namespace: "foreign" },
      { sourceTaskID: "task_foreign" },
      { originCaptainID: "ses_captain_b" },
      { statusRequestID: "0".repeat(64) },
      { sender: "ses_captain_a" },
    ]) {
      reply.text = JSON.stringify({ ...retainedReply, ...changes });
      expect(
        (await f.engine.mail({ op: "inbox" }, f.captain("ses_captain_b")))
          .messages,
      ).toEqual([]);
    }
  } finally {
    await f.close();
  }
});

test("inspection/reconciliation reject workers, child/foreign roots and tasks from another team", async () => {
  const f = await fixture(customTeam);
  const other = await fixture(customTeam);
  try {
    const task = await assignedTask(f);
    const input = uncertainResult(f, task);
    for (const operation of [{ op: "inspect", crew: "builder" }, input]) {
      await expect(
        f.engine.run(operation, f.worker(task.workerSessionID)),
      ).rejects.toThrow("captain sessions");
      await expect(
        f.engine.run(operation, f.captain(task.workerSessionID)),
      ).rejects.toThrow("captain sessions");
      f.sessions.set("ses_child", {
        id: "ses_child",
        agent: "lead",
        parentID: "ses_captain_a",
        location: { directory: f.options.captainDirectory },
      });
      f.sessions.set("ses_foreign", {
        id: "ses_foreign",
        agent: "lead",
        location: { directory: other.options.captainDirectory },
      });
      for (const id of ["ses_child", "ses_foreign"])
        await expect(f.engine.run(operation, f.captain(id))).rejects.toThrow(
          "root configured captain",
        );
    }
    const foreign = await assignedTask(other);
    await expect(
      f.engine.run({ ...input, taskID: foreign.id }, f.captain()),
    ).rejects.toThrow("not in this team's state");
    await expect(
      f.engine.run(
        { op: "inspect", crew: "builder", taskID: foreign.id },
        f.captain(),
      ),
    ).rejects.toThrow("not assigned");
    expect(f.engine.state.task(task.id)?.status).toBe("uncertain");
    expect(f.engine.state.reconciliation(task.id)).toBeNull();
  } finally {
    await other.close();
    await f.close();
  }
});

test.each(["workerSessionID", "originCaptainID", "inputID"] as const)(
  "reconciliation rejects stale expected %s",
  async (field) => {
    const f = await fixture(customTeam);
    try {
      const task = await assignedTask(f);
      const input = uncertainResult(f, task);
      input.expected[field] = "stale_identity";
      await expect(
        f.engine.run(input, f.captain("ses_captain_b")),
      ).rejects.toThrow("ownership is stale");
      expect(f.engine.state.task(task.id)?.status).toBe("uncertain");
      expect(f.engine.state.controlled("builder")).toBe(false);
    } finally {
      await f.close();
    }
  },
);

test.each(["dispatching", "running", "completed", "cancelling"])(
  "reconciliation rejects non-uncertain status %s",
  async (status) => {
    const f = await fixture(customTeam);
    try {
      const task = await assignedTask(f);
      const input = uncertainResult(f, task);
      const db = new Database(f.engine.state.path);
      try {
        db.query("UPDATE tasks SET status=? WHERE id=?").run(status, task.id);
      } finally {
        db.close();
      }
      await expect(f.engine.run(input, f.captain())).rejects.toThrow(
        "ownership or state changed",
      );
      expect(f.engine.state.task(task.id)?.status).toBe(status);
      expect(f.engine.state.reconciliation(task.id)).toBeNull();
    } finally {
      await f.close();
    }
  },
);

test.each([
  "busy",
  "pendingInputs",
  "pendingForms",
  "pendingPermissions",
] as const)(
  "reconciliation rejects live or blocked execution: %s",
  async (field) => {
    const f = await fixture(customTeam);
    try {
      const task = await assignedTask(f);
      const input = uncertainResult(f, task);
      f[field].add(task.workerSessionID);
      await expect(f.engine.run(input, f.captain())).rejects.toThrow(
        "reconciliation refused",
      );
      expect(f.engine.state.task(task.id)?.status).toBe("uncertain");
      expect(f.engine.state.reconciliation(task.id)).toBeNull();
      expect(f.engine.state.controlled("builder")).toBe(false);
      expect(f.calls.some((call) => call.method === "interrupt")).toBe(false);
    } finally {
      await f.close();
    }
  },
);

test.each([
  "originCaptainID",
  "inputID",
  "workerSessionID",
  "status",
  "released",
  "notifying",
  "peer",
])(
  "reconciliation CAS rejects %s changed during verification",
  async (field) => {
    const f = await fixture(customTeam);
    try {
      const task = await assignedTask(f);
      const input = uncertainResult(f, task);
      const list = f.inspectionAPI.message.list;
      f.inspectionAPI.message.list = async (...args) => {
        const db = new Database(f.engine.state.path);
        try {
          if (field === "peer")
            db.query(
              "UPDATE peers SET sessionID='ses_changed' WHERE crewID='builder'",
            ).run();
          else if (field === "released" || field === "notifying")
            db.query(`UPDATE tasks SET ${field}=1 WHERE id=?`).run(task.id);
          else
            db.query(`UPDATE tasks SET ${field}=? WHERE id=?`).run(
              field === "status" ? "running" : "changed_identity",
              task.id,
            );
        } finally {
          db.close();
        }
        return list(...args);
      };
      await expect(
        f.engine.run(input, f.captain("ses_captain_b")),
      ).rejects.toThrow("changed during verification");
      expect(f.engine.state.reconciliation(task.id)).toBeNull();
      expect(f.engine.state.task(task.id)?.result).toBeNull();
      expect(f.engine.state.controlled("builder")).toBe(false);
    } finally {
      await f.close();
    }
  },
);

test("reconciliation rechecks live state after proof and refuses new activity", async () => {
  const f = await fixture(customTeam);
  try {
    const task = await assignedTask(f);
    const input = uncertainResult(f, task);
    const list = f.inspectionAPI.message.list;
    f.inspectionAPI.message.list = async (...args) => {
      f.pendingInputs.add(task.workerSessionID);
      return list(...args);
    };
    await expect(f.engine.run(input, f.captain())).rejects.toThrow(
      "reconciliation refused",
    );
    expect(f.engine.state.task(task.id)?.status).toBe("uncertain");
    expect(f.engine.state.controlled("builder")).toBe(false);
  } finally {
    await f.close();
  }
});

test.each([
  "hash",
  "message",
  "input",
  "envelope",
  "interleaved",
  "finish",
  "agent",
  "missing",
])("reconciliation refuses invalid retained evidence: %s", async (failure) => {
  const f = await fixture(customTeam);
  try {
    const task = await assignedTask(f);
    const input = uncertainResult(f, task);
    const messages = f.history.get(task.workerSessionID);
    const final = messages?.[0];
    const admitted = messages?.[1];
    if (!messages || !final || !admitted)
      throw new Error("Missing evidence fixture");
    if (failure === "hash") input.resultSha256 = "0".repeat(64);
    if (failure === "message") input.resultMessageID = "msg_other_result";
    if (failure === "input") admitted.metadata = {};
    if (failure === "envelope") admitted.text = "Stargate task envelope: {}";
    if (failure === "interleaved")
      messages.splice(1, 0, {
        id: "msg_other_input",
        type: "user",
        time: { created: 65 },
        text: "Unrelated private prompt",
      });
    if (failure === "finish") final.finish = "tool-calls";
    if (failure === "agent") final.agent = "reader";
    if (failure === "missing") messages.pop();
    await expect(f.engine.run(input, f.captain())).rejects.toThrow(
      /evidence|input|envelope/,
    );
    expect(f.engine.state.task(task.id)?.status).toBe("uncertain");
    expect(f.engine.state.reconciliation(task.id)).toBeNull();
    expect(f.engine.state.controlled("builder")).toBe(false);
  } finally {
    await f.close();
  }
});

test("reconciliation evidence paginates and rejects conflicting idempotent retries", async () => {
  const f = await fixture(customTeam);
  try {
    const task = await assignedTask(f);
    const input = uncertainResult(f, task);
    const messages = f.history.get(task.workerSessionID);
    if (!messages?.[0] || !messages[1]) throw new Error("Missing evidence");
    const [final, admitted] = messages;
    f.inspectionAPI.message.list = async ({ cursor, sessionID }) => {
      expect(sessionID).toBe(task.workerSessionID);
      return cursor
        ? { data: [admitted], cursor: {} }
        : { data: [final], cursor: { next: "second-page" } };
    };
    await f.engine.run(input, f.captain());
    await expect(
      f.engine.run({ ...input, resultSha256: "0".repeat(64) }, f.captain()),
    ).rejects.toThrow("conflicts");
    expect(f.engine.state.task(task.id)?.result).toBe(
      "Verified original result",
    );
  } finally {
    await f.close();
  }
});

test("operator RPC uses the same engine checks and accepts no other crew operations", async () => {
  const f = await fixture(customTeam);
  try {
    const task = await assignedTask(f);
    const input = uncertainResult(f, task);
    const signal = new AbortController().signal;
    await expect(
      runRecoveryOperator(
        f.engine,
        { sessionID: task.workerSessionID, request: input },
        signal,
      ),
    ).rejects.toThrow("captain sessions");
    await expect(
      runRecoveryOperator(
        f.engine,
        { sessionID: "ses_captain_b", agent: "lead", request: input },
        signal,
      ),
    ).rejects.toThrow();
    await expect(
      runRecoveryOperator(
        f.engine,
        {
          sessionID: "ses_captain_b",
          request: { op: "dispatch", crew: "builder", text: "No" },
        },
        signal,
      ),
    ).rejects.toThrow();
    const inspected = JSON.parse(
      await runRecoveryOperator(
        f.engine,
        {
          sessionID: "ses_captain_b",
          request: { op: "inspect", crew: "builder" },
        },
        signal,
      ),
    );
    expect(inspected.active.id).toBe(task.id);
    const reconciled = JSON.parse(
      await runRecoveryOperator(
        f.engine,
        { sessionID: "ses_captain_b", request: input },
        signal,
      ),
    );
    expect(reconciled.status).toBe("reconciled");
    expect(f.engine.state.task(task.id)?.originCaptainID).toBe("ses_captain_a");
  } finally {
    await f.close();
  }
});

test("reconciliation rejects queued/cancelled work and conflicting retained results", async () => {
  const f = await fixture(customTeam);
  try {
    const task = await assignedTask(f);
    const input = uncertainResult(f, task);
    const queued = (
      await f.engine.run(
        { op: "dispatch", crew: "builder", text: "Pending", queue: true },
        f.captain(),
      )
    ).task;
    if (!queued) throw new Error("Missing queue fixture");
    const queuedInput = {
      ...input,
      taskID: queued.id,
      expected: { ...input.expected, inputID: queued.inputID },
    };
    await expect(f.engine.run(queuedInput, f.captain())).rejects.toThrow(
      "ownership or state changed",
    );
    f.engine.state.cancelQueued(queued.id, queued.originCaptainID);
    await expect(f.engine.run(queuedInput, f.captain())).rejects.toThrow(
      "ownership or state changed",
    );
    const db = new Database(f.engine.state.path);
    try {
      db.query("UPDATE tasks SET result='Existing evidence' WHERE id=?").run(
        task.id,
      );
    } finally {
      db.close();
    }
    await expect(f.engine.run(input, f.captain())).rejects.toThrow(
      "result conflicts",
    );
    expect(f.engine.state.task(task.id)?.result).toBe("Existing evidence");
    expect(f.engine.state.reconciliation(task.id)).toBeNull();
    expect(f.engine.state.controlled("builder")).toBe(false);
  } finally {
    await f.close();
  }
});

test("reconciliation failures/cancellation release only their own control and never interrupt", async () => {
  const f = await fixture(customTeam);
  try {
    const task = await assignedTask(f);
    const input = uncertainResult(f, task);
    f.inspectionAPI.message.list = async () => {
      throw new Error("private raw API failure");
    };
    await expect(f.engine.run(input, f.captain())).rejects.toThrow(
      "raw SDK details withheld",
    );
    expect(f.engine.state.controlled("builder")).toBe(false);
    const controller = new AbortController();
    f.inspectionAPI.message.list = async () => {
      controller.abort();
      return { data: [], cursor: {} };
    };
    await expect(
      f.engine.run(input, f.captain("ses_captain_b", controller.signal)),
    ).rejects.toThrow("raw SDK details withheld");
    expect(f.engine.state.controlled("builder")).toBe(false);
    expect(f.engine.state.task(task.id)?.status).toBe("uncertain");
    expect(f.calls.some((call) => call.method === "interrupt")).toBe(false);
    const token = f.engine.state.reserveReconciliation(
      f.engine.state.task(task.id) ?? task,
    );
    await expect(f.engine.run(input, f.captain())).rejects.toThrow(
      "control is reserved",
    );
    expect(f.engine.state.controlled("builder")).toBe(true);
    f.engine.state.releaseControl("builder", token);
  } finally {
    await f.close();
  }
});

test("reconciliation never clears a control token changed during verification", async () => {
  const f = await fixture(customTeam);
  try {
    const task = await assignedTask(f);
    const input = uncertainResult(f, task);
    const list = f.inspectionAPI.message.list;
    f.inspectionAPI.message.list = async (...args) => {
      const db = new Database(f.engine.state.path);
      try {
        db.query(
          "UPDATE worker_controls SET token='replacement-control' WHERE crewID='builder'",
        ).run();
      } finally {
        db.close();
      }
      return list(...args);
    };
    await expect(f.engine.run(input, f.captain())).rejects.toThrow(
      "changed during verification",
    );
    expect(f.engine.state.controlled("builder")).toBe(true);
    expect(f.engine.state.reconciliation(task.id)).toBeNull();
    f.engine.state.releaseControl("builder", "replacement-control");
  } finally {
    await f.close();
  }
});

test("inspection/reconciliation fail closed on foreign peer metadata and changed idle boundary", async () => {
  const f = await fixture(customTeam);
  try {
    const task = await assignedTask(f);
    const input = uncertainResult(f, task);
    const session = f.sessions.get(task.workerSessionID);
    if (!session) throw new Error("Missing peer fixture");
    const metadata = session.metadata;
    session.metadata = {
      stargateCrew: { namespace: "foreign-team", crewID: "builder" },
    };
    await expect(
      f.engine.run({ op: "inspect", crew: "builder" }, f.captain()),
    ).rejects.toThrow("identity changed");
    await expect(f.engine.run(input, f.captain())).rejects.toThrow(
      "identity changed",
    );
    if (metadata) session.metadata = metadata;
    const list = f.inspectionAPI.message.list;
    f.inspectionAPI.message.list = async (...args) => {
      session.time = { updated: 200, busy: 150, idle: 200 };
      return list(...args);
    };
    await expect(f.engine.run(input, f.captain())).rejects.toThrow(
      "execution changed",
    );
    expect(f.engine.state.task(task.id)?.status).toBe("uncertain");
    expect(f.engine.state.controlled("builder")).toBe(false);
  } finally {
    await f.close();
  }
});

test("authenticated operator SDK RPC invokes inspection/reconciliation without a prompt", async () => {
  const f = await fixture(customTeam);
  const task = await assignedTask(f);
  const input = uncertainResult(f, task);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== "Bearer fixture-only")
        return Response.json({ _tag: "UnauthorizedError" }, { status: 401 });
      const url = new URL(request.url);
      expect(url.pathname).toBe("/api/rpc/stargate.crew.recovery/run");
      expect(url.searchParams.get("location[directory]")).toBe(
        f.options.captainDirectory,
      );
      const body = await request.json();
      const decoded = await CrewRecovery.methods.run.input[
        "~standard"
      ].validate(body.input);
      if (decoded.issues)
        return Response.json({ _tag: "BadRequestError" }, { status: 400 });
      return Response.json({
        output: await runRecoveryOperator(
          f.engine,
          decoded.value,
          request.signal,
        ),
      });
    },
  });
  try {
    const client = OpenCode.make({
      baseUrl: server.url.href,
      headers: { authorization: "Bearer fixture-only" },
    });
    const rpc = client.rpc(CrewRecovery);
    const options = { location: { directory: f.options.captainDirectory } };
    // Portable SDK defaults must not strip nested recovery acknowledgements
    // or expected identities before the authoritative strict decoder sees them.
    for (const malformed of [
      {
        sessionID: "ses_captain_b",
        request: { op: "inspect" as const, crew: "builder" },
        extra: true,
      },
      {
        sessionID: "ses_captain_b",
        request: { op: "inspect" as const, crew: "builder", extra: true },
      },
      {
        sessionID: "ses_captain_b",
        request: { ...input, expected: { ...input.expected, extra: true } },
      },
    ])
      await expect(rpc.run(malformed, options)).rejects.toBeDefined();
    const inspected = JSON.parse(
      await rpc.run(
        {
          sessionID: "ses_captain_b",
          request: { op: "inspect", crew: "builder" },
        },
        options,
      ),
    );
    expect(inspected.active.id).toBe(task.id);
    expect(inspected.execution.state).toBe("idle");
    const recovered = JSON.parse(
      await rpc.run({ sessionID: "ses_captain_b", request: input }, options),
    );
    expect(recovered.status).toBe("reconciled");
    await expect(
      OpenCode.make({ baseUrl: server.url.href })
        .rpc(CrewRecovery)
        .run(
          {
            sessionID: "ses_captain_b",
            request: { op: "inspect", crew: "builder" },
          },
          options,
        ),
    ).rejects.toBeDefined();
    expect(f.calls.filter((call) => call.method === "prompt")).toHaveLength(1);
    expect(f.calls.some((call) => call.method === "interrupt")).toBe(false);
  } finally {
    await server.stop(true);
    await f.close();
  }
});

test("external worker activity blocks admission and controls always release", async () => {
  const f = await fixture(customTeam);
  try {
    const peer = (
      await f.engine.run({ op: "ensure", crew: "builder" }, f.captain())
    ).peers?.[0];
    if (!peer) throw new Error("Missing peer");
    f.busy.add(peer.sessionID);
    const queued = await f.engine.run(
      { op: "dispatch", crew: "builder", text: "Wait for idle", queue: true },
      f.captain(),
    );
    expect(queued.status).toBe("queued");
    expect(f.calls.filter((call) => call.method === "prompt")).toHaveLength(0);
    await expect(
      f.engine.withWorkerControl("builder", f.captain(), async () => {}),
    ).rejects.toThrow("not idle");
    f.busy.delete(peer.sessionID);
    await expect(
      f.engine.withWorkerControl("builder", f.captain(), async () => {
        throw new Error("callback failed");
      }),
    ).rejects.toThrow("callback failed");
    expect(
      (
        await f.engine.run(
          { op: "status", taskID: queued.task?.id },
          f.captain(),
        )
      ).status,
    ).toBe("running");
  } finally {
    await f.close();
  }
});

test("root plugin metadata resolves to the installed V2 definition", () => {
  expect(plugin.id).toBe("stargate.crew");
});

test("worker urgency cannot create an idle colleague's root session", async () => {
  const f = await fixture();
  try {
    const task = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "Assigned work" },
        f.captain(),
      )
    ).task;
    if (!task) throw new Error("Missing task");
    expect(
      await f.engine.run(
        { op: "urgent", taskID: task.id, to: "luigi", text: "Question" },
        f.worker(task.workerSessionID),
      ),
    ).toMatchObject({ status: "unavailable" });
    expect(f.creations).toHaveLength(1);
    expect(f.engine.state.peer("luigi")?.status).toBe("pending");
  } finally {
    await f.close();
  }
});

test("Daisy receives broad session tools but workers cannot ensure", async () => {
  const f = await fixture();
  try {
    const peer = (
      await f.engine.run({ op: "ensure", crew: "daisy" }, f.captain())
    ).peers?.[0];
    const rules = f.creations[0]?.permissions;
    expect(rules).toContainEqual({
      action: "*",
      resource: "*",
      effect: "deny",
    });
    expect(rules).toContainEqual({
      action: "edit",
      resource: "*",
      effect: "allow",
    });
    expect(f.creations[0]?.parentID).toBeUndefined();
    expect(f.creations[0]?.model).toEqual({
      providerID: "fixture",
      id: "daisy",
    });
    await expect(
      f.engine.run({ op: "ensure" }, f.worker(peer?.sessionID ?? "", "daisy")),
    ).rejects.toThrow("Only Bowser");
    const captain = f.sessions.get("ses_captain_a");
    if (!captain) throw new Error("Missing fixture captain");
    captain.location.directory = "/different-workspace";
    await expect(f.engine.run({ op: "ensure" }, f.captain())).rejects.toThrow(
      "configured",
    );
  } finally {
    await f.close();
  }
});

test("independent plugin instances atomically reserve the same worker", async () => {
  const f = await fixture();
  const second = await CrewEngine.open(f.options, f.client, f.mailer);
  try {
    const results = await Promise.all([
      f.engine.run(
        { op: "dispatch", crew: "mario", text: "First" },
        f.captain(),
      ),
      second.run(
        { op: "dispatch", crew: "mario", text: "Second" },
        f.captain("ses_captain_b"),
      ),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "busy",
      "running",
    ]);
    expect(f.calls.filter((call) => call.method === "prompt")).toHaveLength(1);
    expect(new Set(f.creations.map((input) => input.id)).size).toBe(1);
  } finally {
    await second.close();
    await f.close();
  }
});

for (const placed of [true, false])
  test(`aborted admission interrupts only proven own placement: ${placed}`, async () => {
    const f = await fixture();
    try {
      const controller = new AbortController();
      f.onPrompt(() => {
        const input = f.inputs.at(-1);
        if (placed && input)
          f.history.set(input.sessionID, [
            {
              id: input.id ?? "",
              type: "user",
              time: { created: 60 },
              text: input.text,
            },
          ]);
        controller.abort();
      });
      f.failPrompt();
      await expect(
        f.engine.run(
          { op: "dispatch", crew: "mario", text: "Cancelled admission" },
          f.captain("ses_captain_a", controller.signal),
        ),
      ).rejects.toThrow("uncertain");
      // Unproven native activity may be foreign work; it is not interrupted.
      expect(
        f.calls.filter((call) => call.method === "interrupt"),
      ).toHaveLength(placed ? 1 : 0);
      expect(f.engine.state.activeTask("mario")?.status).toBe("uncertain");
    } finally {
      await f.close();
    }
  });

test("same-captain colleague urgency includes the recipient's exact task ID", async () => {
  const f = await fixture();
  try {
    const mario = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "A" },
        f.captain(),
      )
    ).task;
    const luigi = (
      await f.engine.run(
        { op: "dispatch", crew: "luigi", text: "B" },
        f.captain(),
      )
    ).task;
    await f.engine.run(
      {
        op: "urgent",
        taskID: mario?.id,
        to: "luigi",
        text: "Interface changed",
      },
      f.worker(mario?.workerSessionID ?? ""),
    );
    expect(f.synthetics).toHaveLength(1);
    expect(f.synthetics[0]).toMatchObject({
      sessionID: luigi?.workerSessionID,
      delivery: "steer",
      resume: false,
      metadata: {
        pogoCrew: { taskID: luigi?.id, sourceTaskID: mario?.id },
      },
    });
    expect(f.synthetics[0]?.text).toContain("Interface changed");
    await expect(
      f.engine.run(
        { op: "compact", crew: "mario" },
        f.captain("ses_captain_b"),
      ),
    ).rejects.toThrow("another captain");
  } finally {
    await f.close();
  }
});

test("Mesij inbox filters sent/unrelated mail and acknowledges pages explicitly", async () => {
  const f = await fixture();
  try {
    const task = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "A" },
        f.captain(),
      )
    ).task;
    const worker = f.worker(task?.workerSessionID ?? "");
    await f.engine.mail(
      {
        op: "send",
        taskID: task?.id,
        to: "captain",
        text: "Private result",
        key: "one",
      },
      worker,
    );
    const other = (
      await f.engine.run(
        { op: "dispatch", crew: "luigi", text: "Other thread" },
        f.captain("ses_captain_b"),
      )
    ).task;
    await f.engine.mail(
      {
        op: "send",
        taskID: other?.id,
        to: "captain",
        text: "Different thread result",
        key: "one",
      },
      f.worker(other?.workerSessionID ?? "", "luigi"),
    );
    const ownInbox = await f.engine.mail(
      { op: "inbox", taskID: task?.id },
      worker,
    );
    expect(ownInbox.messages).toEqual([]);
    const captainInbox = await f.engine.mail(
      { op: "inbox", taskID: task?.id },
      f.captain(),
    );
    expect(captainInbox.messages?.[0]?.text).toBe("Private result");
    expect(captainInbox.messages).toHaveLength(1);
    expect(
      (await f.engine.mail({ op: "inbox", taskID: task?.id }, f.captain()))
        .messages,
    ).toEqual(captainInbox.messages);
    expect(
      (
        await f.engine.mail(
          { op: "inbox", taskID: task?.id, after: captainInbox.nextAfter },
          f.captain(),
        )
      ).messages,
    ).toEqual([]);
    await expect(
      f.engine.mail(
        { op: "inbox", taskID: task?.id },
        f.captain("ses_captain_b"),
      ),
    ).rejects.toThrow("does not own");
    expect(f.calls.some((call) => call.method === "synthetic")).toBe(false);
  } finally {
    await f.close();
  }
});

test("uncertain create adopts stable ID; missing ready session is not recreated", async () => {
  const f = await fixture();
  try {
    f.failCreate();
    await expect(
      f.engine.run({ op: "ensure", crew: "mario" }, f.captain()),
    ).rejects.toThrow("not confirmed");
    const result = await f.engine.run(
      { op: "ensure", crew: "mario" },
      f.captain(),
    );
    const peer = result.peers?.[0];
    expect(peer).toBeDefined();
    expect(f.calls).toHaveLength(1);
    f.sessions.delete(peer?.sessionID ?? "");
    await expect(
      f.engine.run({ op: "ensure", crew: "mario" }, f.captain()),
    ).rejects.toThrow("missing");
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("busy assignments stay bounded and task results belong to their captain", async () => {
  const f = await fixture();
  try {
    const task = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "Implement one" },
        f.captain(),
      )
    ).task;
    expect(task?.inputID).toMatch(/^msg_/);
    expect(task?.originCaptainID).toBe("ses_captain_a");
    const busy = await f.engine.run(
      { op: "dispatch", crew: "mario", text: "Different thread" },
      f.captain("ses_captain_b"),
    );
    expect(busy.status).toBe("busy");
    expect(busy.task).toBeUndefined();
    await expect(
      f.engine.run(
        { op: "wait", taskID: task?.id },
        f.captain("ses_captain_b"),
      ),
    ).rejects.toThrow("does not own");
    await expect(
      f.engine.run(
        { op: "complete", taskID: task?.id, result: "stolen" },
        f.worker("ses_unassigned"),
      ),
    ).rejects.toThrow("assigned worker");
    await f.engine.run(
      { op: "complete", taskID: task?.id, result: "Verified result" },
      f.worker(task?.workerSessionID ?? ""),
    );
    const result = await f.engine.run(
      { op: "wait", taskID: task?.id },
      f.captain(),
    );
    expect(result.task?.result).toBe("Verified result");
    const reopened = await CrewEngine.open(
      f.options,
      f.client,
      f.mailer,
      f.agents,
    );
    try {
      expect(
        (await reopened.run({ op: "status", taskID: task?.id }, f.captain()))
          .task?.result,
      ).toBe("Verified result");
    } finally {
      await reopened.close();
    }
    expect(f.calls.some((call) => call.sessionID === "ses_captain_a")).toBe(
      false,
    );
  } finally {
    await f.close();
  }
});

test("cancelling an old completed wait cannot interrupt a replacement task", async () => {
  const f = await fixture();
  try {
    const first = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "First" },
        f.captain(),
      )
    ).task;
    await f.engine.run(
      { op: "complete", taskID: first?.id, result: "Done" },
      f.worker(first?.workerSessionID ?? ""),
    );
    f.busy.delete(first?.workerSessionID ?? "");
    const replacement = await f.engine.run(
      { op: "dispatch", crew: "mario", text: "Second" },
      f.captain("ses_captain_b"),
    );
    expect(replacement.status).toBe("running");
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.engine.run(
        { op: "wait", taskID: first?.id },
        f.captain("ses_captain_a", controller.signal),
      ),
    ).rejects.toThrow("cancelled");
    expect(f.calls.filter((call) => call.method === "interrupt")).toEqual([]);
    expect(f.engine.state.activeTask("mario")?.originCaptainID).toBe(
      "ses_captain_b",
    );
  } finally {
    await f.close();
  }
});

test("prompt ambiguity is retained and never replayed", async () => {
  const f = await fixture();
  try {
    f.failPrompt();
    await expect(
      f.engine.run(
        { op: "dispatch", crew: "mario", text: "Do not replay" },
        f.captain(),
      ),
    ).rejects.toThrow("uncertain");
    expect(
      (
        await f.engine.run(
          { op: "dispatch", crew: "mario", text: "Again" },
          f.captain(),
        )
      ).status,
    ).toBe("busy");
    expect(f.calls.filter((call) => call.method === "prompt")).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("cancelled wait interrupts only its own task and preserves uncertain state", async () => {
  const f = await fixture();
  try {
    const task = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "Long task" },
        f.captain(),
      )
    ).task;
    f.failInterrupt();
    const controller = new AbortController();
    const pending = f.engine.run(
      { op: "wait", taskID: task?.id },
      f.captain("ses_captain_a", controller.signal),
    );
    controller.abort();
    await expect(pending).rejects.toThrow("uncertain");
    expect(f.engine.state.task(task?.id ?? "")?.status).toBe("uncertain");
    expect(f.calls.filter((call) => call.method === "interrupt")).toEqual([
      { method: "interrupt", sessionID: task?.workerSessionID ?? "" },
    ]);
  } finally {
    await f.close();
  }
});

test("urgent captain mail stays durable and cross-captain colleague input is rejected", async () => {
  const f = await fixture();
  try {
    const mario = (
      await f.engine.run(
        { op: "dispatch", crew: "mario", text: "Task A" },
        f.captain(),
      )
    ).task;
    await f.engine.run(
      { op: "dispatch", crew: "luigi", text: "Task B" },
      f.captain("ses_captain_b"),
    );
    await f.engine.run(
      {
        op: "urgent",
        taskID: mario?.id,
        to: "captain",
        text: "Approval needed",
      },
      f.worker(mario?.workerSessionID ?? ""),
    );
    const notice = await f.engine.run(
      { op: "wait", taskID: mario?.id },
      f.captain(),
    );
    expect(notice.notices?.[0]?.text).toContain("Approval needed");
    expect(f.synthetics[0]).toMatchObject({
      sessionID: "ses_captain_a",
      resume: true,
    });
    expect(
      await f.engine.run(
        {
          op: "urgent",
          taskID: mario?.id,
          to: "luigi",
          text: "Wrong thread",
        },
        f.worker(mario?.workerSessionID ?? ""),
      ),
    ).toMatchObject({ status: "deferred" });
  } finally {
    await f.close();
  }
});

test("unrelated lookup failures preserve the pending reservation without creating a session", async () => {
  const f = await fixture();
  const get = f.client.get;
  try {
    f.client.get = async (input, request) => {
      if (input.sessionID === "ses_captain_a") return get(input, request);
      throw { _tag: "Location.NotFoundError", message: "secret raw SDK error" };
    };
    await expect(
      f.engine.run({ op: "ensure", crew: "mario" }, f.captain()),
    ).rejects.toThrow(
      "Crew operation unavailable. Inspect OpenCode and crew state; raw SDK details withheld.",
    );
    const pending = f.engine.state.peer("mario");
    expect(pending?.status).toBe("pending");
    expect(f.creations).toHaveLength(0);
    if (!pending) throw new Error("Missing fixture reservation");
    f.client.get = get;
    const result = await f.engine.run(
      { op: "ensure", crew: "mario" },
      f.captain(),
    );
    expect(result.peers?.[0]?.sessionID).toBe(pending.sessionID);
    expect(f.creations).toHaveLength(1);
    expect(f.creations[0]?.id).toBe(pending.sessionID);
  } finally {
    f.client.get = get;
    await f.close();
  }
});

test("ready-only model inspection/control never reserve or create an unprovisioned or pending peer", async () => {
  const f = await fixture(customTeam);
  try {
    for (const pending of [false, true]) {
      if (pending) f.engine.state.reservePeer("builder");
      const before = f.engine.state.peer("builder");
      await expect(
        f.engine.inspectWorkerModel("builder", f.captain()),
      ).rejects.toThrow("not provisioned");
      await expect(
        f.engine.withWorkerControl(
          "builder",
          f.captain(),
          async () => {
            throw new Error("must not enter operation");
          },
          { requireReady: true },
        ),
      ).rejects.toThrow("does not create sessions");
      expect(f.engine.state.peer("builder")).toEqual(before);
      expect(f.engine.state.controlled("builder")).toBe(false);
      expect(f.creations).toHaveLength(0);
      expect(f.inputs).toHaveLength(0);
    }
  } finally {
    await f.close();
  }
});

test("ready-only inspection validates one existing native snapshot and refuses changed worker identity", async () => {
  const f = await fixture(customTeam);
  try {
    await f.engine.run({ op: "ensure", crew: "builder" }, f.captain());
    const peer = f.engine.state.peer("builder");
    if (!peer) throw new Error("Missing peer");
    const native = f.sessions.get(peer.sessionID);
    if (!native) throw new Error("Missing native worker");
    native.model = { providerID: "fixture", id: "builder", variant: "high" };
    const original = structuredClone(native);
    const reads: string[] = [];
    const get = f.client.get.bind(f.client);
    f.client.get = async (input, options) => {
      reads.push(input.sessionID);
      return get(input, options);
    };
    const inspected = await f.engine.inspectWorkerModel("builder", f.captain());
    expect(inspected).toEqual({ ...peer, model: native.model });
    expect(reads).toEqual(["ses_captain_a", peer.sessionID]);
    for (const changed of [
      { ...original, agent: "foreign" },
      { ...original, location: { directory: "/foreign" } },
      {
        ...original,
        metadata: { stargateCrew: { namespace: "foreign", crewID: "builder" } },
      },
      { ...original, parentID: "ses_foreign" },
    ]) {
      f.sessions.set(peer.sessionID, changed);
      await expect(
        f.engine.inspectWorkerModel("builder", f.captain()),
      ).rejects.toThrow("identity changed");
      await expect(
        f.engine.withWorkerControl("builder", f.captain(), async () => {}, {
          requireReady: true,
        }),
      ).rejects.toThrow("identity changed");
      expect(f.engine.state.controlled("builder")).toBe(false);
      expect(f.engine.state.peer("builder")).toEqual(peer);
    }
    expect(f.creations).toHaveLength(1);
    expect(f.inputs).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("ready-only model operations refuse Pi, unknown crew and foreign native captain roots", async () => {
  const f = await fixture(
    Schema.decodeUnknownSync(teamSchema)({
      ...customTeam,
      crew: customTeam.crew.map((member) =>
        member.id === "builder"
          ? {
              ...member,
              backend: {
                type: "pi-durable",
                model: "openai/test",
                tools: "none",
              },
            }
          : member,
      ),
    }),
  );
  const captain = f.sessions.get("ses_captain_a");
  if (!captain) throw new Error("Missing captain fixture");
  f.sessions.set("ses_captaina", { ...captain, id: "ses_captaina" });
  const pinned = await CrewEngine.open(
    { ...f.options, captainSessionID: "ses_captaina" },
    f.client,
    f.mailer,
    f.agents,
  );
  try {
    for (const op of [
      () => f.engine.inspectWorkerModel("builder", f.captain()),
      () =>
        f.engine.withWorkerControl("builder", f.captain(), async () => {}, {
          requireReady: true,
        }),
    ])
      await expect(op()).rejects.toThrow(/Pi|OpenCode workers/);
    await expect(
      f.engine.inspectWorkerModel("foreign", f.captain()),
    ).rejects.toThrow("Unknown configured crew");
    await expect(
      f.engine.withWorkerControl("foreign", f.captain(), async () => {}, {
        requireReady: true,
      }),
    ).rejects.toThrow("Unknown configured crew");
    await expect(
      pinned.inspectWorkerModel("reader", f.captain("ses_captain_b")),
    ).rejects.toThrow("configured");
    await expect(
      pinned.withWorkerControl(
        "reader",
        f.captain("ses_captain_b"),
        async () => {},
        { requireReady: true },
      ),
    ).rejects.toThrow("configured");
    await expect(
      pinned.inspectWorkerModel("reader", f.worker("ses_captaina")),
    ).rejects.toThrow("captain sessions");
    expect(f.engine.state.peer("builder")).toBeNull();
    expect(f.engine.state.peer("reader")).toBeNull();
    expect(f.creations).toHaveLength(0);
  } finally {
    await pinned.close();
    await f.close();
  }
});

function effortModels(f: Awaited<ReturnType<typeof fixture>>) {
  let writes = 0;
  let catalogues = 0;
  let whileListing = async () => {};
  const sessions: ModelSessions = {
    get: (input, options) => f.client.get(input, options),
    async switchModel({ sessionID, model }) {
      const current = f.sessions.get(sessionID);
      if (!current) throw new Error("Missing worker");
      writes++;
      current.model = model;
    },
    compact: (input, options) => f.client.compact(input, options),
    interrupt: (input, options) => f.client.interrupt(input, options),
  };
  const tool = new CrewModels(
    f.engine,
    sessions,
    {
      async list() {
        catalogues++;
        await whileListing();
        return {
          data: [
            {
              providerID: "openai-proxy",
              id: "model",
              enabled: true,
              variants: [{ id: "low" }, { id: "high" }],
            },
          ],
        };
      },
    },
    async () => {
      throw new Error("Compaction forbidden");
    },
  );
  return {
    tool,
    writes: () => writes,
    catalogues: () => catalogues,
    duringCatalogue: (fn: () => Promise<void>) => {
      whileListing = fn;
    },
  };
}

test("effort real engine refuses held/running/uncertain/native-busy work including no-op without catalogue or queued requests", async () => {
  const f = await fixture(customTeam);
  try {
    await f.engine.run({ op: "ensure", crew: "builder" }, f.captain());
    const peer = f.engine.state.peer("builder");
    const native = peer && f.sessions.get(peer.sessionID);
    if (!peer || !native) throw new Error("Missing worker");
    native.model = { providerID: "openai-proxy", id: "model", variant: "high" };
    const models = effortModels(f);
    const request = () =>
      models.tool.run(
        { op: "effort", target: "builder", variant: "high" },
        f.captain(),
      );
    const control = f.engine.state.reserveControl("builder");
    await expect(request()).rejects.toThrow("control already reserved");
    expect(
      await models.tool.run({ op: "inspect", target: "builder" }, f.captain()),
    ).toMatchObject({ model: { variant: "high" } });
    f.engine.state.releaseControl("builder", control);
    f.busy.add(peer.sessionID);
    await expect(request()).rejects.toThrow("not idle");
    f.busy.delete(peer.sessionID);
    const task = f.engine.state.reserveTask(
      peer,
      "ses_captain_a",
      "Retained original work",
    );
    if (!task) throw new Error("Missing task");
    f.engine.state.running(task.id);
    const running = f.engine.state.task(task.id);
    await expect(request()).rejects.toThrow("running or uncertain");
    expect(f.engine.state.task(task.id)).toEqual(running);
    f.engine.state.uncertain(task.id);
    const uncertain = f.engine.state.task(task.id);
    await expect(request()).rejects.toThrow("running or uncertain");
    expect(f.engine.state.task(task.id)).toEqual(uncertain);
    expect(models.writes()).toBe(0);
    expect(models.catalogues()).toBe(0);
    expect(native.model.variant).toBe("high");
    expect(f.engine.state.controlled("builder")).toBe(false);
    expect(f.inputs).toHaveLength(0);
    expect(f.creations).toHaveLength(1);
    const db = new Database(f.engine.state.path, { readonly: true });
    try {
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM pending_tasks",
          )
          .get()?.count,
      ).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test("effort ready-only control excludes competing dispatch and retains session/model/metadata", async () => {
  const f = await fixture(customTeam);
  try {
    await f.engine.run({ op: "ensure", crew: "builder" }, f.captain());
    const peer = f.engine.state.peer("builder");
    const native = peer && f.sessions.get(peer.sessionID);
    if (!peer || !native) throw new Error("Missing worker");
    native.model = { providerID: "openai-proxy", id: "model", variant: "low" };
    const before = structuredClone(native);
    const models = effortModels(f);
    models.duringCatalogue(async () => {
      expect(f.engine.state.controlled("builder")).toBe(true);
      expect(
        (
          await f.engine.run(
            { op: "dispatch", crew: "builder", text: "Must not start" },
            f.captain(),
          )
        ).status,
      ).toBe("busy");
    });
    expect(
      await models.tool.run(
        { op: "effort", target: "builder", variant: "high" },
        f.captain(),
      ),
    ).toMatchObject({
      status: "switched",
      sessionID: peer.sessionID,
      model: { providerID: "openai-proxy", id: "model", variant: "high" },
    });
    expect(native.id).toBe(before.id);
    expect(native.agent).toBe(before.agent);
    expect(native.location).toEqual(before.location);
    expect(native.metadata).toEqual(before.metadata);
    expect(f.engine.state.peer("builder")).toEqual(peer);
    expect(models.writes()).toBe(1);
    expect(models.catalogues()).toBe(1);
    expect(f.engine.state.controlled("builder")).toBe(false);
    expect(f.engine.state.activeTask("builder")).toBeNull();
    expect(f.inputs).toHaveLength(0);
    expect(f.creations).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("effort can update an idle provisioned worker with queued-only work without starting that work", async () => {
  const f = await fixture(customTeam);
  try {
    await f.engine.run({ op: "ensure", crew: "builder" }, f.captain());
    const peer = f.engine.state.peer("builder");
    const native = peer && f.sessions.get(peer.sessionID);
    if (!peer || !native) throw new Error("Missing worker");
    native.model = { providerID: "openai-proxy", id: "model", variant: "low" };
    f.busy.add(peer.sessionID);
    const queued = await f.engine.run(
      {
        op: "dispatch",
        crew: "builder",
        text: "Existing queued work",
        queue: true,
      },
      f.captain(),
    );
    expect(queued.status).toBe("queued");
    if (!queued.task) throw new Error("Missing queued task");
    f.busy.delete(peer.sessionID);
    const models = effortModels(f);
    expect(
      await models.tool.run(
        { op: "effort", target: "builder", variant: "high" },
        f.captain(),
      ),
    ).toMatchObject({ status: "switched", sessionID: peer.sessionID });
    expect(f.engine.state.task(queued.task.id)).toEqual(queued.task);
    expect(f.engine.state.activeTask("builder")).toBeNull();
    expect(f.inputs).toHaveLength(0);
    expect(models.writes()).toBe(1);
    expect(native.model.variant).toBe("high");
  } finally {
    await f.close();
  }
});
