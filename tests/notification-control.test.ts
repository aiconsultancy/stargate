import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { configSchema } from "../src/config";
import type { CrewCaller } from "../src/crew/engine";
import { CrewNotifications } from "../src/crew/controls/notifications";
import { CrewError } from "../src/crew/state";
import {
  type NotificationDependencies,
  runNotificationOperation,
} from "../src/notifications/preferences/notification-control";
import { NotificationStore } from "../src/notifications/preferences/notification-store";
import { notificationKey } from "../src/notifications/preferences/notifications";
import { bot, identity } from "./fixtures";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const target = {
  scope: "thread",
  channel: "C123",
  thread_ts: "1.000",
} as const;
const signal = () => new AbortController().signal;

async function fixture() {
  const directory = await mkdtemp(
    join(tmpdir(), "stargate-notification-control-"),
  );
  directories.push(directory);
  const config = bot();
  if (config.backend.type === "opencode") {
    config.backend.directory = "/workspace/captain";
    config.backend.sessionID = "ses_captain";
  }
  const configuration = Schema.decodeUnknownSync(configSchema)({
    dataDirectory: directory,
    bots: [config],
  });
  let identityCalls = 0;
  const dependencies: NotificationDependencies = {
    loadConfig: async () => configuration,
    identity: async () => {
      identityCalls++;
      return identity;
    },
    now: () => Date.parse("2026-11-17T10:00:00Z"),
  };
  const binding = {
    configPath: "/private/stargate.json",
    bot: config.id,
    expectedDirectory: "/workspace/captain",
    captainSessionID: "ses_captain",
    operationID: "call-1",
  };
  const run = (input: unknown, overrides: Partial<typeof binding> = {}) =>
    runNotificationOperation(
      input,
      { ...binding, ...overrides },
      signal(),
      dependencies,
    );
  return {
    directory,
    config,
    configuration,
    dependencies,
    binding,
    run,
    identityCalls: () => identityCalls,
  };
}

test("bound control persists a mute/wake preference, reads it, and retries without stale mutation", async () => {
  const f = await fixture();
  expect(
    await f.run({
      op: "mute",
      ...target,
      mute_until: "2026-11-17T13:00:00+02:00",
    }),
  ).toMatchObject({
    op: "mute",
    replay: false,
    current: {
      mode: "addressed-only",
      thread: { mute_until: "2026-11-17T11:00:00.000Z" },
    },
  });
  expect(
    await f.run({ op: "unmute", ...target }, { operationID: "call-2" }),
  ).toMatchObject({ current: { mode: "normal" } });
  expect(
    await f.run({
      op: "mute",
      ...target,
      mute_until: "2026-11-17T13:00:00+02:00",
    }),
  ).toMatchObject({
    replay: true,
    current: { mode: "normal" },
    receipt: { action: "mute" },
  });
  expect(await f.run({ op: "status", ...target })).toMatchObject({
    current: { mode: "normal" },
  });
  expect(await f.run({ op: "list" })).toMatchObject({ settings: [] });
  expect(
    await f.run({ op: "clear_all" }, { operationID: "call-3" }),
  ).toMatchObject({ cleared: { thread: 0, channel: 0 }, changed: false });
  const store = new NotificationStore(
    join(f.directory, "notifications.sqlite"),
  );
  try {
    expect(
      store.status(notificationKey(f.config, identity), "C123", "1.000").mode,
    ).toBe("normal");
  } finally {
    store.close();
  }
});

test("invalid/DM/cross-registration/foreign captain targets fail before store writes", async () => {
  const f = await fixture();
  for (const [input, binding] of [
    [{ op: "mute", ...target, channel: "D123" }, {}],
    [{ op: "mute", ...target, channel: "COTHER" }, {}],
    [{ op: "mute", ...target, bot: "another" }, {}],
    [{ op: "mute", ...target }, { bot: "another" }],
    [{ op: "mute", ...target }, { captainSessionID: "ses_child" }],
    [{ op: "mute", ...target }, { expectedDirectory: "/another" }],
    [{ op: "mute", ...target }, { operationID: "" }],
  ] as const)
    await expect(f.run(input, binding)).rejects.toThrow();
  expect(f.identityCalls()).toBe(0);
  expect(
    await Bun.file(join(f.directory, "notifications.sqlite")).exists(),
  ).toBe(false);
  f.configuration.bots[0]?.access.deniedChannels.push("C123");
  await expect(f.run({ op: "status", ...target })).rejects.toThrow(
    "not allowed",
  );
});

test("aborted, unreadable or failed identity controls claim no success and withhold raw errors", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    runNotificationOperation(
      { op: "mute", ...target },
      f.binding,
      controller.signal,
      f.dependencies,
    ),
  ).rejects.toThrow();
  f.dependencies.identity = async () => {
    throw new Error("PRIVATE_AUTH_DIAGNOSTIC");
  };
  await expect(f.run({ op: "mute", ...target })).rejects.toThrow(
    "Notification operation unconfirmed",
  );
  expect(
    await Bun.file(join(f.directory, "notifications.sqlite")).exists(),
  ).toBe(false);
  f.dependencies.identity = async () => identity;
  await writeFile(join(f.directory, "notifications.sqlite"), "not a database");
  await expect(f.run({ op: "mute", ...target })).rejects.toThrow(
    "Notification operation unconfirmed",
  );
});

test("captain wrapper rejects crew, child and binding injection before its control runner", async () => {
  let calls = 0;
  const authority = {
    options: {
      captainDirectory: "/workspace/captain",
      cron: { configPath: "/private/stargate.json", bot: "helper" },
    },
    async captain(caller: CrewCaller) {
      if (caller.agent !== "captain" || caller.sessionID !== "ses_captain")
        throw new CrewError("Captain only.");
    },
  };
  const runner: typeof runNotificationOperation = async (_raw, binding) => {
    calls++;
    return { binding };
  };
  const control = new CrewNotifications(authority, runner);
  const caller: CrewCaller = {
    sessionID: "ses_captain",
    agent: "captain",
    id: "host-call",
    signal: signal(),
  };
  await expect(
    control.run({ op: "mute", ...target }, { ...caller, agent: "worker" }),
  ).rejects.toThrow("Captain only");
  await expect(
    control.run(
      { op: "mute", ...target },
      { ...caller, sessionID: "ses_child" },
    ),
  ).rejects.toThrow("Captain only");
  await expect(
    control.run({ op: "mute", ...target, configPath: "/other" }, caller),
  ).rejects.toThrow("Invalid notification");
  expect(calls).toBe(0);
  expect(await control.run({ op: "mute", ...target }, caller)).toMatchObject({
    binding: {
      bot: "helper",
      captainSessionID: "ses_captain",
      operationID: "host-call",
      expectedDirectory: "/workspace/captain",
    },
  });
  const unbound = new CrewNotifications(
    { ...authority, options: { captainDirectory: "/workspace/captain" } },
    runner,
  );
  await expect(unbound.run({ op: "list" }, caller)).rejects.toThrow(
    "unavailable",
  );
});
