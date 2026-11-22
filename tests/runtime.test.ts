import { expect, test } from "bun:test";
import { watch } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import pino from "pino";
import type { AgentBackend } from "../src/backend";
import { type BotConfig, botSchema } from "../src/config";
import { maintenanceSchema } from "../src/maintenance/nightly/config";
import { readReady } from "../src/maintenance/nightly/ready";
import { queueNotice } from "../src/maintenance/nightly/report";
import { NotificationStore } from "../src/notifications/preferences/notification-store";
import { notificationKey } from "../src/notifications/preferences/notifications";
import { botKey, conversationKey } from "../src/gateway/routing";
import {
  lockInstance,
  type RuntimeDependencies,
  RuntimeStopped,
  type SlackApp,
  serve,
} from "../src/app/runtime";
import { handleSlackRequest } from "../src/slack/slack";
import type { ConnectionState } from "../src/slack/slack-connection";
import { Store } from "../src/gateway/store";
import { scopedUpdate } from "../src/maintenance/update-notice";
import { bot, event, identity } from "./fixtures";

const silent = pino({ level: "silent" });

test("ready update notices are opt-in, persistent across restarts and included in readiness", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "stargate-update-ready-"));
  let queued = 0;
  let contexts = 0;
  const configured = bot();
  if (configured.backend.type !== "opencode")
    throw new Error("Wrong fixture backend");
  const pinned = {
    ...configured,
    backend: { ...configured.backend, sessionID: "ses_captain" },
  };
  try {
    for (const [enabled, changed, expected, status] of [
      [false, false, 0, undefined],
      [true, false, 1, "queued"],
      [true, false, 1, "unchanged"],
      [true, true, 2, "queued"],
    ] as const) {
      const f = harness();
      const make = f.dependencies.backend;
      const dependencies: RuntimeDependencies = {
        ...f.dependencies,
        backend: async (config, context) => ({
          ...(await make(config, context)),
          sessionID: "ses_captain",
          updateNoticeContext: async (_session, snapshot) => {
            contexts++;
            return scopedUpdate(snapshot, {}, {});
          },
          queueUpdateNotice: async () => {
            queued++;
          },
        }),
      };
      const controller = new AbortController();
      const before = Date.now();
      const running = Effect.runPromise(
        serve(
          {
            dataDirectory,
            notifications: { updateNotice: enabled },
            bots: [pinned],
            maintenance: Schema.decodeUnknownSync(maintenanceSchema)({
              models: { updateGlobalCatalog: changed },
            }),
          },
          silent,
          controller.signal,
          dependencies,
        ),
      );
      try {
        await f.started;
        for (let i = 0; i < 200; i++) {
          const ready = await readReady(dataDirectory);
          if (ready && ready.readyAt >= before) break;
          await Bun.sleep(5);
        }
        expect(queued).toBe(expected);
        const ready = await readReady(dataDirectory);
        if (enabled)
          expect(ready?.updateNotices?.[0]).toMatchObject({
            sessionID: "ses_captain",
            status,
          });
        else expect(contexts).toBe(0);
      } finally {
        controller.abort();
        await running;
      }
    }
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("unpinned Slack sessions get the notice only on their next normal turn", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "stargate-update-turn-"));
  const order: string[] = [];
  const f = harness();
  const make = f.dependencies.backend;
  const dependencies: RuntimeDependencies = {
    ...f.dependencies,
    backend: async (config, context) => ({
      ...(await make(config, context)),
      updateNoticeContext: async (_session, snapshot) =>
        scopedUpdate(snapshot, {}, {}),
      queueUpdateNotice: async () => {
        order.push("notice");
      },
      prompt: async () => {
        order.push("prompt");
        return "Answer";
      },
    }),
  };
  const controller = new AbortController();
  const running = Effect.runPromise(
    serve(
      { dataDirectory, notifications: { updateNotice: true }, bots: [bot()] },
      silent,
      controller.signal,
      dependencies,
    ),
  );
  try {
    await f.started;
    for (let i = 0; i < 100 && !(await readReady(dataDirectory)); i++)
      await Bun.sleep(5);
    expect(order).toEqual([]);
    await f.intake().accept(event("<@UBOT> hello", "100.001"));
    for (let i = 0; i < 200 && order.length < 2; i++) await Bun.sleep(5);
    expect(order).toEqual(["notice", "prompt"]);
  } finally {
    controller.abort();
    await running;
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

type Turn = (bot: string, signal: AbortSignal) => Promise<string>;

function harness(turn: Turn = async () => "Answer.") {
  const events: string[] = [];
  const calls: string[] = [];
  const started = Promise.withResolvers<void>();
  const intakes = new Map<
    string,
    {
      accept: (body: unknown) => boolean | Promise<boolean>;
      open: () => boolean;
    }
  >();
  const backends: AgentBackend[] = [];
  const dependencies: RuntimeDependencies = {
    slack: (bot) =>
      ({
        async identity() {
          if (bot.id === "broken") throw new Error("auth.test failed");
          return bot.id === "helper"
            ? identity
            : { team: "T123", user: `U${bot.id.toUpperCase()}` };
        },
        async start(accept, _log, _interactions, open) {
          intakes.set(bot.id, { accept, open });
          events.push(`${bot.id} started`);
          started.resolve();
        },
        async close() {
          events.push(`${bot.id} slack closed`);
        },
        async post() {
          return "9.000";
        },
        async announce() {
          return "9.000";
        },
        cronUI: {
          async open() {},
          async push() {},
          async update() {},
        },
        crewUI: {
          async open() {
            return "V1";
          },
          async update() {},
        },
      }) satisfies SlackApp,
    backend: async (_config, context) => {
      const bot = context.dataDirectory.split("/").at(-2) ?? "";
      const backend: AgentBackend = {
        async createSession() {
          calls.push(`${bot} createSession`);
          return `${bot}-session`;
        },
        async prompt(_session, _text, signal) {
          calls.push(`${bot} prompt`);
          return turn(bot, signal);
        },
        async close() {
          events.push("backend closed");
          // Intake must be closed for every bot before any backend closes.
          for (const [id, intake] of intakes)
            if (intake.open()) events.push(`${id} intake still open`);
        },
      };
      backends.push(backend);
      return backend;
    },
  };
  return {
    events,
    calls,
    started: started.promise,
    backends,
    dependencies,
    intake: (id = "helper") => {
      const intake = intakes.get(id);
      if (!intake) throw new Error("Slack intake not started");
      return intake;
    },
  };
}

function seed(path: string, config: BotConfig, user = identity.user) {
  const store = new Store(path);
  try {
    const key = botKey(config, { team: identity.team, user });
    const thread = `${Date.now()}.${store.ready(key, 0, 1).length}`;
    const conversation = conversationKey(key, "C123", thread);
    store.enqueue({
      eventId: `C123:${thread}`,
      botKey: key,
      conversation,
      channel: "C123",
      thread,
      user: "U123",
      text: "hello",
    });
    const job = store.queuedJob(key, `C123:${thread}`);
    if (!job) throw new Error("Missing seeded job");
    return { key, id: job.id };
  } finally {
    store.close();
  }
}

function status(path: string, key: string, id: number) {
  const store = new Store(path);
  try {
    return store.jobStatus(key, id);
  } finally {
    store.close();
  }
}

async function directory() {
  return mkdtemp(join(tmpdir(), "stargate-runtime-"));
}

test("pinned Slack runtime reads persisted notification preferences before model admission", async () => {
  const dataDirectory = await directory();
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  try {
    const config = bot();
    if (config.backend.type !== "opencode")
      throw new Error("Expected OpenCode");
    config.backend.sessionID = "ses_captain";
    config.access.textMentions = { channels: ["C123"], names: ["helper"] };
    const preferences = new NotificationStore(
      join(dataDirectory, "notifications.sqlite"),
    );
    preferences.operate(
      notificationKey(config, identity),
      { op: "mute", scope: "thread", channel: "C123", thread_ts: "1.000" },
      { id: "runtime-mute", caller: "ses_captain", now: Date.now() },
    );
    preferences.close();
    const f = harness();
    const invoked = Promise.withResolvers<void>();
    const prompts: string[] = [];
    f.dependencies.backend = async () => ({
      sessionID: "ses_captain",
      async createSession() {
        return "ses_captain";
      },
      async prompt(_session, text) {
        prompts.push(text);
        invoked.resolve();
        return "Answer.";
      },
      async close() {},
    });
    running = Effect.runPromise(
      serve(
        { dataDirectory, bots: [config] },
        silent,
        controller.signal,
        f.dependencies,
      ),
    );
    await f.started;
    expect(await f.intake().accept(event("helper inspect"))).toBe(false);
    const request = event("<@UBOT> inspect", "2.000");
    expect(
      await f.intake().accept({
        ...request,
        event: { ...request.event, thread_ts: "1.000" },
      }),
    ).toBe(true);
    await invoked.promise;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("[Notification wake:");
  } finally {
    controller.abort();
    await running;
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("shutdown closes intake before workers drain and backends close", async () => {
  const dataDirectory = await directory();
  try {
    const config = { dataDirectory, bots: [bot()] };
    const f = harness();
    const controller = new AbortController();
    const running = Effect.runPromise(
      serve(config, silent, controller.signal, f.dependencies),
    );
    await f.started;
    const { accept, open } = f.intake();
    let acks = 0;
    const deliver = () =>
      handleSlackRequest(
        {
          type: "events_api",
          body: event(),
          ack: async () => {
            acks++;
          },
        },
        accept,
        silent,
        undefined,
        open,
      );
    await deliver();
    expect(acks).toBe(1);
    controller.abort();
    await running;
    // An event arriving after intake closed is neither persisted nor ACKed.
    await deliver();
    expect(acks).toBe(1);
    expect(f.events).toEqual([
      "helper started",
      "helper slack closed",
      "backend closed",
    ]);
    // The instance lock and stores were released.
    lockInstance(join(dataDirectory, "instance.sqlite")).close();
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("a failed worker stops the process with a restartable failure", async () => {
  const dataDirectory = await directory();
  try {
    const helper = bot();
    const store = new Store(join(dataDirectory, "stargate.sqlite"));
    const key = botKey(helper, identity);
    const conversation = conversationKey(key, "C123", "1.000");
    store.enqueue({
      eventId: "C123:1.000",
      botKey: key,
      conversation,
      channel: "C123",
      thread: "1.000",
      user: "U123",
      text: "hello",
    });
    store.saveSession(conversation, "session-1");
    const job = store.queuedJob(key, "C123:1.000");
    if (!job) throw new Error("Missing seeded job");
    store.running(job.id);
    store.close();
    const config = { dataDirectory, bots: [helper] };
    const f = harness();
    // Startup cannot stop surviving work: recovery must not proceed silently.
    const backend = f.dependencies.backend;
    f.dependencies.backend = async (config, context) => {
      const opened = await backend(config, context);
      opened.interrupt = async () => {
        throw new Error("OpenCode unavailable");
      };
      return opened;
    };
    const failure = await Effect.runPromise(
      serve(config, silent, new AbortController().signal, f.dependencies),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeStopped);
    expect(f.events).toContain("backend closed");
    lockInstance(join(dataDirectory, "instance.sqlite")).close();
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("a startup failure releases bots that already connected", async () => {
  const dataDirectory = await directory();
  try {
    const broken = Schema.decodeUnknownSync(botSchema)({
      ...bot("broken"),
      slack: {
        appId: "A999",
        appTokenEnv: "BROKEN_APP_TOKEN",
        botTokenEnv: "BROKEN_BOT_TOKEN",
      },
    });
    const config = { dataDirectory, bots: [bot(), broken] };
    const f = harness();
    await expect(
      Effect.runPromise(
        serve(config, silent, new AbortController().signal, f.dependencies),
      ),
    ).rejects.toThrow();
    expect(f.events).toEqual([
      "helper started",
      "helper slack closed",
      "backend closed",
    ]);
    expect(f.intake().open()).toBe(false);
    lockInstance(join(dataDirectory, "instance.sqlite")).close();
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("ready waits for connection and records later outages and recovery", async () => {
  const dataDirectory = await directory();
  const f = harness();
  const make = f.dependencies.slack;
  const connect = Promise.withResolvers<void>();
  let state: ConnectionState = "connecting";
  f.dependencies.connectionTiming = { outageMs: 200, pollMs: 2 };
  f.dependencies.slack = (bot, log) => {
    const slack = make(bot, log);
    return {
      ...slack,
      get connectionState() {
        return state;
      },
      async start(...args) {
        await connect.promise;
        state = "connected";
        await slack.start(...args);
      },
    };
  };
  const controller = new AbortController();
  const running = Effect.runPromise(
    serve(
      { dataDirectory, bots: [bot()] },
      silent,
      controller.signal,
      f.dependencies,
    ),
  );
  try {
    await Bun.sleep(10);
    expect(await readReady(dataDirectory)).toBeNull();
    connect.resolve();
    await f.started;
    const waitState = async (expected: ConnectionState) => {
      for (let i = 0; i < 100; i++) {
        const record = await readReady(dataDirectory);
        if (record?.transports?.[0]?.state === expected) return record;
        await Bun.sleep(2);
      }
      throw new Error(`Missing transport state ${expected}`);
    };
    const first = await waitState("connected");
    state = "reconnecting";
    expect((await waitState("reconnecting")).readyAt).toBe(first.readyAt);
    state = "connected";
    expect((await waitState("connected")).readyAt).toBe(first.readyAt);
  } finally {
    controller.abort();
    await running;
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("an exhausted post-start transport exits the runtime as a failure", async () => {
  const dataDirectory = await directory();
  const f = harness();
  const make = f.dependencies.slack;
  const failed = Promise.withResolvers<void>();
  f.dependencies.slack = (bot, log) => ({
    ...make(bot, log),
    watch: () => failed.promise,
  });
  const running = Effect.runPromise(
    serve(
      { dataDirectory, bots: [bot()] },
      silent,
      new AbortController().signal,
      f.dependencies,
    ),
  );
  const result = running.catch((error: unknown) => error);
  await f.started;
  failed.reject(new Error("Slack connection unavailable"));
  expect(await result).toBeInstanceOf(RuntimeStopped);
  expect((await readReady(dataDirectory))?.transports?.[0]?.state).toBe(
    "closed",
  );
  await rm(dataDirectory, { recursive: true, force: true });
});

test("a disconnect during initial readiness I/O is not lost by the observer", async () => {
  const dataDirectory = await directory();
  const f = harness();
  const make = f.dependencies.slack;
  let state: ConnectionState = "connected";
  f.dependencies.connectionTiming = { outageMs: 1000, pollMs: 2 };
  f.dependencies.slack = (bot, log) => ({
    ...make(bot, log),
    get connectionState() {
      return state;
    },
  });
  let changed = false;
  const watcher = watch(dataDirectory, (_event, file) => {
    if (!changed && file?.startsWith("ready.json.tmp-")) {
      changed = true;
      state = "reconnecting";
    }
  });
  const controller = new AbortController();
  const running = Effect.runPromise(
    serve(
      { dataDirectory, bots: [bot()] },
      silent,
      controller.signal,
      f.dependencies,
    ),
  );
  try {
    await f.started;
    for (
      let i = 0;
      i < 100 &&
      (await readReady(dataDirectory))?.transports?.[0]?.state !==
        "reconnecting";
      i++
    )
      await Bun.sleep(2);
    expect(changed).toBe(true);
    expect((await readReady(dataDirectory))?.transports?.[0]?.state).toBe(
      "reconnecting",
    );
  } finally {
    controller.abort();
    await running;
    watcher.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("a failed Slack connection starts no queued turn", async () => {
  const dataDirectory = await directory();
  try {
    const helper = bot();
    const path = join(dataDirectory, "stargate.sqlite");
    const queued = seed(path, helper);
    const config = { dataDirectory, bots: [helper] };
    const f = harness();
    f.dependencies.slack = (bot, log) => {
      const slack = harness().dependencies.slack(bot, log);
      return {
        ...slack,
        identity: () => slack.identity(),
        async start() {
          await Bun.sleep(300);
          throw new Error("socket unavailable");
        },
        close: () => slack.close(),
      };
    };
    await expect(
      Effect.runPromise(
        serve(config, silent, new AbortController().signal, f.dependencies),
      ),
    ).rejects.toThrow();
    // A network outage plus restarts must not consume requests as uncertain.
    expect(f.calls).toEqual([]);
    expect(status(path, queued.key, queued.id)).toBe("queued");
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("shutdown closes every intake and stops every worker together", async () => {
  const dataDirectory = await directory();
  try {
    const helper = bot();
    const other = Schema.decodeUnknownSync(botSchema)({
      ...bot("other"),
      slack: {
        appId: "A999",
        appTokenEnv: "OTHER_APP_TOKEN",
        botTokenEnv: "OTHER_BOT_TOKEN",
      },
    });
    const path = join(dataDirectory, "stargate.sqlite");
    const busy = Promise.withResolvers<void>();
    let late: { key: string; id: number } | undefined;
    let draining: boolean[] = [];
    const f = harness(
      (bot, signal) =>
        new Promise((_resolve, reject) => {
          if (bot !== "other") return reject(new Error("unexpected turn"));
          busy.resolve();
          signal.addEventListener(
            "abort",
            () => {
              void (async () => {
                // First aborted-work observation: every intake already closed.
                draining = ["helper", "other"].map((id) => f.intake(id).open());
                // Work becomes ready for the first bot while this one drains.
                late = seed(path, helper);
                await Bun.sleep(400);
                reject(new Error("stopped"));
              })();
            },
            { once: true },
          );
        }),
    );
    seed(path, other, "UOTHER");
    const controller = new AbortController();
    const running = Effect.runPromise(
      serve(
        { dataDirectory, bots: [helper, other] },
        silent,
        controller.signal,
        f.dependencies,
      ),
    );
    await busy.promise;
    controller.abort();
    await running;
    expect(draining).toEqual([false, false]);
    expect(f.events.filter((event) => event.includes("intake"))).toEqual([]);
    expect(f.events.filter((event) => event === "backend closed")).toHaveLength(
      2,
    );
    expect(f.calls).toEqual(["other createSession", "other prompt"]);
    if (!late) throw new Error("Late job was not seeded");
    expect(status(path, late.key, late.id)).toBe("queued");
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("the dashboard socket serves the fleet and is removed on shutdown", async () => {
  const dataDirectory = await directory();
  try {
    const config = { dataDirectory, dashboard: true, bots: [bot()] };
    const f = harness();
    const controller = new AbortController();
    const running = Effect.runPromise(
      serve(config, silent, controller.signal, f.dependencies),
    );
    await f.started;
    const socket = join(dataDirectory, "dashboard.sock");
    const present = () =>
      stat(socket).then(
        (info) => info.isSocket(),
        () => false,
      );
    for (let attempt = 0; attempt < 200 && !(await present()); attempt++)
      await Bun.sleep(10);
    expect((await stat(socket)).mode & 0o777).toBe(0o600);
    const fleet = await fetch("http://stargate/api/fleet", { unix: socket });
    expect(fleet.status).toBe(200);
    expect(await fleet.json()).toMatchObject({
      ships: [{ id: "helper", backend: "opencode", crew: null }],
    });
    const page = await fetch("http://stargate/", { unix: socket });
    expect(page.headers.get("Content-Security-Policy")).toContain(
      "default-src 'none'",
    );
    expect(await page.text()).toContain("<title>");
    controller.abort();
    await running;
    expect(await present()).toBe(false);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("the Fleet API serves the projected fleet with the generated token", async () => {
  const dataDirectory = await directory();
  try {
    const probe = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    const port = probe.port;
    probe.stop(true);
    const config = {
      dataDirectory,
      api: { listen: `127.0.0.1:${port}`, fleetName: "Test Fleet" },
      bots: [bot()],
    };
    const f = harness();
    const controller = new AbortController();
    const running = Effect.runPromise(
      serve(config, silent, controller.signal, f.dependencies),
    );
    await f.started;
    const tokenFile = join(dataDirectory, "api-token");
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await Bun.file(tokenFile).exists()) break;
      await Bun.sleep(10);
    }
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    const token = (await Bun.file(tokenFile).text()).trim();
    const base = `http://127.0.0.1:${port}/api/v1`;
    let unauthorized: Response | undefined;
    for (let attempt = 0; attempt < 200 && !unauthorized; attempt++)
      unauthorized = await fetch(`${base}/fleet`).catch(() => undefined);
    expect(unauthorized?.status).toBe(401);
    const response = await fetch(`${base}/fleet`, {
      headers: {
        authorization: `Bearer ${token}`,
        origin: "subspace://fleet-console",
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "subspace://fleet-console",
    );
    const fleet = await response.json();
    expect(fleet).toMatchObject({
      apiVersion: 1,
      name: "Test Fleet",
      ships: [{ id: "helper" }],
      gateway: { version: expect.any(String) },
      host: { cpu: { cores: expect.any(Number) } },
    });
    expect(fleet.gateway.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "api", enabled: true }),
      ]),
    );
    const ship = await fetch(`${base}/ships/helper`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ship.status).toBe(200);
    expect(await ship.json()).toMatchObject({ id: "helper" });
    controller.abort();
    await running;
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("no dashboard socket exists unless it is configured", async () => {
  const dataDirectory = await directory();
  try {
    const f = harness();
    const controller = new AbortController();
    const running = Effect.runPromise(
      serve(
        { dataDirectory, bots: [bot()] },
        silent,
        controller.signal,
        f.dependencies,
      ),
    );
    await f.started;
    controller.abort();
    await running;
    expect(await Bun.file(join(dataDirectory, "dashboard.sock")).exists()).toBe(
      false,
    );
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("gateway writes a readiness record and delivers maintenance summaries", async () => {
  const dataDirectory = await directory();
  try {
    await queueNotice(dataDirectory, {
      schema: "stargate.maintenance.notice.v1",
      channel: "C123",
      text: "Nightly maintenance: completed.",
      report: "r.json",
    });
    const f = harness();
    const announced: string[] = [];
    const slack = f.dependencies.slack;
    const dependencies: RuntimeDependencies = {
      ...f.dependencies,
      slack: (config, log) => ({
        ...slack(config, log),
        async announce(channel, text) {
          announced.push(`${channel} ${text}`);
          return "9.000";
        },
      }),
    };
    const config = {
      dataDirectory,
      bots: [bot()],
      maintenance: Schema.decodeUnknownSync(maintenanceSchema)({
        report: { bot: "helper", channel: "C123" },
      }),
    };
    const controller = new AbortController();
    const before = Date.now();
    const running = Effect.runPromise(
      serve(config, silent, controller.signal, dependencies),
    );
    await f.started;
    for (let i = 0; i < 100 && !announced.length; i++) await Bun.sleep(20);
    const ready = await readReady(dataDirectory);
    expect(ready?.readyAt).toBeGreaterThanOrEqual(before);
    expect(ready?.pid).toBe(process.pid);
    expect(announced).toEqual(["C123 Nightly maintenance: completed."]);
    controller.abort();
    await running;
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
