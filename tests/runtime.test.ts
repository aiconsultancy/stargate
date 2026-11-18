import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import pino from "pino";
import type { AgentBackend } from "../src/backend";
import { type BotConfig, botSchema } from "../src/config";
import { maintenanceSchema } from "../src/nightly/config";
import { readReady } from "../src/nightly/ready";
import { queueNotice } from "../src/nightly/report";
import { NotificationStore } from "../src/notification-store";
import { notificationKey } from "../src/notifications";
import { botKey, conversationKey } from "../src/routing";
import {
  lockInstance,
  type RuntimeDependencies,
  RuntimeStopped,
  type SlackApp,
  serve,
} from "../src/runtime";
import { handleSlackRequest } from "../src/slack";
import { Store } from "../src/store";
import { bot, event, identity } from "./fixtures";

const silent = pino({ level: "silent" });

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
    const broken = botSchema.parse({
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
    const other = botSchema.parse({
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
            async () => {
              // First aborted-work observation: every intake already closed.
              draining = ["helper", "other"].map((id) => f.intake(id).open());
              // Work becomes ready for the first bot while this one drains.
              late = seed(path, helper);
              await Bun.sleep(400);
              reject(new Error("stopped"));
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
      maintenance: maintenanceSchema.parse({
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
