import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Effect } from "effect";
import pino from "pino";
import type { AgentBackend } from "../src/backend";
import { type Config, configSchema, ircSchema } from "../src/config";
import { ConfigReload, readReloadCandidate } from "../src/config-reload";
import { IrcShip, ircKey } from "../src/irc/ship";
import { botKey } from "../src/routing";
import {
  listenForReload,
  type RuntimeDependencies,
  type SlackApp,
  serve,
} from "../src/runtime";
import { Store } from "../src/store";
import { bot, event, identity } from "./fixtures";
import { FakeIrcServer, until } from "./irc-fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

type Turn = (id: string, signal: AbortSignal) => Promise<string>;
async function running(
  options: {
    irc?: Config["irc"];
    environment?: Record<string, string>;
    turn?: Turn;
    failBackend?: string;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "stargate-runtime-reload-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "stargate.json");
  const config = configSchema.parse({
    dataDirectory: join(directory, "data"),
    bots: [bot()],
    irc: options.irc ?? [],
  });
  const environment = {
    APP_TOKEN: "xapp-fixture",
    BOT_TOKEN: "xoxb-fixture",
    ...options.environment,
  };
  const write = (next: unknown) => Bun.write(path, JSON.stringify(next));
  const writeEnvironment = (next: Record<string, string>) =>
    Bun.write(
      `${path}.env`,
      Object.entries(next)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    );
  await write(config);
  await writeEnvironment(environment);
  const initial = await readReloadCandidate(path, {});
  const ready = Promise.withResolvers<void>();
  const logs: string[] = [];
  const log = pino(
    { level: "info" },
    new Writable({
      write(chunk, _encoding, done) {
        const text = String(chunk);
        logs.push(text);
        if (text.includes('"msg":"Stargate ready"')) ready.resolve();
        done();
      },
    }),
  );
  const reload = new ConfigReload(
    initial,
    () => readReloadCandidate(path, {}),
    log,
  );
  const intakes = new Map<
    string,
    (body: unknown) => boolean | Promise<boolean>
  >();
  const messages: string[] = [];
  const built: string[] = [];
  const closed: string[] = [];
  const dependencies: RuntimeDependencies = {
    slack: (registration) =>
      ({
        async identity() {
          return identity;
        },
        async start(accept) {
          intakes.set(registration.id, accept);
        },
        async close() {},
        async post(_channel, _thread, text) {
          messages.push(text);
          return "2.000";
        },
        async update(_channel, _ts, text) {
          messages.push(text);
        },
        async remove() {},
        async announce() {
          return "2.000";
        },
        cronUI: { async open() {}, async push() {}, async update() {} },
        crewUI: {
          async open() {
            return "V1";
          },
          async update() {},
        },
      }) satisfies SlackApp,
    async backend(_config, context) {
      const id = context.dataDirectory.split("/").at(-2) ?? "";
      if (id === options.failBackend)
        throw new Error("fixture backend refused");
      built.push(id);
      return {
        async createSession() {
          return `session-${id}`;
        },
        async prompt(_session, _text, signal) {
          return options.turn ? options.turn(id, signal) : "Answer.";
        },
        async close() {
          closed.push(id);
        },
      } satisfies AgentBackend;
    },
    irc: (irc, store, logger) =>
      IrcShip.create(irc, store, logger, {
        env: initial.environment,
        timing: {
          reconnectMinMs: 20,
          reconnectMaxMs: 50,
          intervalMs: 5,
          burst: 10,
          confirmMs: 1000,
        },
        readyMs: 2000,
      }),
  };
  const stop = new AbortController();
  const work = Effect.runPromise(
    serve(config, log, stop.signal, dependencies, reload),
  );
  cleanup.push(async () => {
    stop.abort();
    await work;
  });
  await ready.promise;
  const accept = (body: unknown) => {
    const input = intakes.get("helper");
    if (!input) throw new Error("No intake");
    return input(body);
  };
  return {
    config,
    environment,
    path,
    reload,
    logs,
    messages,
    built,
    closed,
    write,
    writeEnvironment,
    accept,
    directory,
  };
}

test("SIGHUP binding requests reload and removes its listener", async () => {
  const signals = new EventEmitter();
  const requested = Promise.withResolvers<void>();
  let calls = 0;
  const remove = listenForReload(
    {
      async request() {
        calls++;
        requested.resolve();
        return { status: "applied", message: "done" };
      },
    },
    signals,
  );
  signals.emit("SIGHUP");
  await requested.promise;
  expect(calls).toBe(1);
  remove();
  signals.emit("SIGHUP");
  expect(calls).toBe(1);
  expect(signals.listenerCount("SIGHUP")).toBe(0);
});

test("valid SIGHUP candidate changes admission with the same Slack connection and backend", async () => {
  const f = await running();
  const body = {
    ...event("Apollo, inspect", "3.000"),
    event: {
      ...event("Apollo, inspect", "3.000").event,
      type: "message",
      user: "U456",
    },
  };
  expect(await f.accept(body)).toBe(false);
  await f.write({
    ...f.config,
    bots: [
      {
        ...f.config.bots[0],
        access: {
          ...f.config.bots[0]?.access,
          users: ["U456"],
          textMentions: { channels: ["C123"], names: ["Apollo"] },
        },
      },
    ],
  });
  expect((await f.reload.request()).status).toBe("applied");
  expect(await f.accept(body)).toBe(true);
  expect(f.built).toEqual(["helper"]);
  expect(f.closed).toEqual([]);
});

test("invalid and reconnect-only candidates leave running admission unchanged", async () => {
  const f = await running();
  const original = f.reload.current;
  await Bun.write(f.path, '{"private":"SENSITIVE_BAD_INPUT"');
  expect((await f.reload.request()).status).toBe("invalid");
  expect(f.reload.current).toBe(original);
  await f.write({
    ...f.config,
    bots: [
      {
        ...f.config.bots[0],
        access: { ...f.config.bots[0]?.access, users: ["U456"] },
        backend: {
          type: "opencode",
          url: "http://localhost:9999",
          directory: "/workspace",
        },
      },
    ],
  });
  const result = await f.reload.request();
  expect(result.status).toBe("restart-required");
  expect(result.message).toContain("restart required");
  expect(f.reload.current).toBe(original);
  expect(f.logs.join("")).not.toContain("SENSITIVE_BAD_INPUT");
  const body = event("<@UBOT> no", "4.000");
  expect(
    await f.accept({ ...body, event: { ...body.event, user: "U456" } }),
  ).toBe(false);
  expect(f.built).toEqual(["helper"]);
});

test("deny reload blocks a running turn's delivery without stopping its execution", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let finished = false;
  const f = await running({
    async turn(_id, signal) {
      signal.addEventListener("abort", () => release.resolve(), { once: true });
      entered.resolve();
      await release.promise;
      finished = true;
      return "Forbidden after reload.";
    },
  });
  await f.accept(event());
  await entered.promise;
  await f.write({
    ...f.config,
    bots: [
      {
        ...f.config.bots[0],
        access: { ...f.config.bots[0]?.access, deniedUsers: ["U123"] },
      },
    ],
  });
  expect((await f.reload.request()).status).toBe("applied");
  release.resolve();
  const store = new Store(join(f.config.dataDirectory, "stargate.sqlite"));
  try {
    await until(
      () => {
        const job = store.queuedJob(botKey(bot(), identity), "C123:1.000");
        return (
          !!job && store.jobStatus(botKey(bot(), identity), job.id) === "failed"
        );
      },
      5000,
      "denied turn settled",
    );
    expect(finished).toBe(true);
    expect(f.messages).toEqual([]);
  } finally {
    store.close();
  }
});

function irc(port: number) {
  return ircSchema.parse({
    id: "fleet",
    server: { host: "127.0.0.1", port, tls: false },
    account: "galactica",
    passwordEnv: "IRC_MAIN",
    channels: ["#fleet"],
    backend: bot().backend,
  });
}
const chief = {
  id: "chief",
  account: "galactica-chief",
  passwordEnv: "IRC_CHIEF",
  channels: ["#fleet"],
  backend: bot().backend,
};

test("IRC roster reload starts an added worker and retires only an idle removed worker", async () => {
  const server = new FakeIrcServer({
    accounts: { galactica: "captain-pass", "galactica-chief": "chief-pass" },
  }).start();
  cleanup.push(() => server.stop());
  const registration = irc(server.port);
  const f = await running({
    irc: [registration],
    environment: { IRC_MAIN: "captain-pass" },
  });
  await until(
    () => server.members.get("#fleet")?.size === 1,
    5000,
    "captain joined",
  );
  await f.writeEnvironment({ ...f.environment, IRC_CHIEF: "chief-pass" });
  await f.write({ ...f.config, irc: [{ ...registration, crew: [chief] }] });
  expect((await f.reload.request()).status).toBe("applied");
  await until(
    () => server.members.get("#fleet")?.size === 2,
    5000,
    "crew joined",
  );
  expect(f.built).toEqual(["helper", "fleet", "fleet-chief"]);
  server.say(
    { nick: "jack", account: "jack" },
    "#fleet",
    "galactica-chief: inspect",
  );
  await until(
    () =>
      server
        .received("galactica-chief")
        .some(
          (line) => line.includes("PRIVMSG #fleet") && line.includes("Answer."),
        ),
    5000,
    "added worker replied",
  );
  const key = ircKey(
    "fleet-chief",
    registration.server,
    chief.account,
    chief.backend,
  );
  await until(
    () => {
      const store = new Store(join(f.config.dataDirectory, "stargate.sqlite"));
      try {
        const counts = store.queueCounts(key);
        return counts.queued + counts.running + counts.responding === 0;
      } finally {
        store.close();
      }
    },
    5000,
    "crew idle after reply",
  );
  await f.write({ ...f.config, irc: [registration] });
  const result = await f.reload.request();
  expect(result.status).toBe("applied");
  await until(
    () => server.members.get("#fleet")?.size === 1,
    5000,
    "crew left",
  );
  expect(f.closed).toEqual(["fleet-chief"]);
});

test("failed staging leaves all existing runtime settings and connections intact", async () => {
  const server = new FakeIrcServer({
    accounts: { galactica: "captain-pass", "galactica-chief": "chief-pass" },
  }).start();
  cleanup.push(() => server.stop());
  const registration = irc(server.port);
  const f = await running({
    irc: [registration],
    environment: { IRC_MAIN: "captain-pass", IRC_CHIEF: "chief-pass" },
    failBackend: "fleet-chief",
  });
  await f.write({
    ...f.config,
    bots: [
      {
        ...f.config.bots[0],
        access: { ...f.config.bots[0]?.access, deniedUsers: ["U123"] },
      },
    ],
    irc: [{ ...registration, crew: [chief] }],
  });
  expect((await f.reload.request()).status).toBe("failed");
  expect(f.reload.current.config).toEqual(f.config);
  expect(await f.accept(event())).toBe(true);
  expect(f.built).toEqual(["helper", "fleet"]);
  expect(f.closed).toEqual([]);
});

test("busy IRC removal rejects the whole reload without applying new denies", async () => {
  const server = new FakeIrcServer({
    accounts: { galactica: "captain-pass", "galactica-chief": "chief-pass" },
  }).start();
  cleanup.push(() => server.stop());
  const registration = ircSchema.parse({ ...irc(server.port), crew: [chief] });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await running({
    irc: [registration],
    environment: { IRC_MAIN: "captain-pass", IRC_CHIEF: "chief-pass" },
    async turn(id, signal) {
      if (id === "fleet-chief") {
        signal.addEventListener("abort", () => release.resolve(), {
          once: true,
        });
        entered.resolve();
        await release.promise;
      }
      return "Answer.";
    },
  });
  await until(
    () => server.members.get("#fleet")?.size === 2,
    5000,
    "crew joined",
  );
  server.say(
    { nick: "jack", account: "jack" },
    "#fleet",
    "galactica-chief: inspect",
  );
  await entered.promise;
  await f.write({
    ...f.config,
    bots: [
      {
        ...f.config.bots[0],
        access: { ...f.config.bots[0]?.access, deniedUsers: ["U123"] },
      },
    ],
    irc: [{ ...registration, crew: [] }],
  });
  try {
    expect((await f.reload.request()).status).toBe("busy");
    expect(f.reload.current.config).toEqual(f.config);
    expect(f.closed).toEqual([]);
    expect(server.members.get("#fleet")?.size).toBe(2);
    expect(await f.accept(event())).toBe(true);
  } finally {
    release.resolve();
  }
});
