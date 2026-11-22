import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Result, Schema } from "effect";
import pino from "pino";
import { configSchema } from "../src/config";
import { ConfigReload, restartRequired } from "../src/app/config-reload";
import { resolveDestinations } from "../src/notifications/ingest/binding";
import { producerCredentials } from "../src/notifications/ingest/config";
import { checkCredentials } from "../src/app/setup";
import { bot } from "./fixtures";
import {
  notificationConfig,
  producerToken,
  runtimeConfig,
  temporary,
} from "./notify-runtime-fixture";

test("disabled HTTP config validates without enabling the API", () => {
  const result = Schema.decodeUnknownResult(configSchema)({
    bots: [bot()],
    notify: notificationConfig(),
  });
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result)) expect(result.success.api).toBeUndefined();
});

test("disabled adapters still reject unknown types, fields, mounts, destinations, grants and echo", () => {
  const input = () => ({ bots: [bot()], notify: notificationConfig() });
  const bad: unknown[] = [];
  for (const delta of [
    { type: "github-release-poller" },
    { type: "http", intervalSeconds: 1 },
    { path: "/api/v1/fleet" },
    { path: "/v1/notifications/%6cocal" },
    { path: "/v1/notifications/local/" },
  ]) {
    const value = input();
    bad.push({
      ...value,
      notify: {
        ...value.notify,
        adapters: { local: { ...value.notify.adapters.local, ...delta } },
      },
    });
  }
  for (const channel of ["*", "D123", "#channel"]) {
    const value = input();
    value.notify.destinations.log.slack.channel = channel;
    bad.push(value);
  }
  const unknown = input();
  unknown.notify.destinations.log.slack.bot = "missing";
  bad.push(unknown);
  const duplicate = input();
  bad.push({
    ...duplicate,
    notify: {
      ...duplicate.notify,
      adapters: {
        ...duplicate.notify.adapters,
        other: duplicate.notify.adapters.local,
      },
    },
  });
  const audience = input();
  audience.notify.destinations.log.audience = "public";
  bad.push(audience);
  const receiver = {
    ...bot("receiver"),
    slack: {
      appId: "AOTHER",
      appTokenEnv: "OTHER_APP",
      botTokenEnv: "OTHER_BOT",
    },
    access: { ...bot().access, peerCaptains: true },
  };
  bad.push({ ...input(), bots: [bot(), receiver] });
  for (const value of bad)
    expect(
      Result.isFailure(Schema.decodeUnknownResult(configSchema)(value)),
    ).toBe(true);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(configSchema)({
        ...input(),
        bots: [
          bot(),
          {
            ...receiver,
            access: { ...receiver.access, deniedChannels: ["C123"] },
          },
        ],
      }),
    ),
  ).toBe(true);
});

test("credentials use effective environment without mutation, reject ambiguity and never create the operator token", async () => {
  const directory = await temporary();
  const path = join(directory, "stargate.json");
  const data = join(directory, "data");
  await mkdir(data, { mode: 0o700 });
  const config = runtimeConfig(data);
  await writeFile(
    `${path}.env`,
    `APP_TOKEN=xapp-fixture\nBOT_TOKEN=xoxb-fixture\nNOTIFY_CI=${producerToken}\n`,
    { mode: 0o600 },
  );
  const original = { ...process.env };
  const env = await checkCredentials(
    path,
    config.bots,
    {},
    [],
    config.notify,
    data,
  );
  expect(env["NOTIFY_CI"]).toBe(producerToken);
  expect(process.env).toEqual(original);
  expect(existsSync(join(data, "api-token"))).toBe(false);
  expect(() => producerCredentials(config.notify, {})).toThrow(
    "Missing or invalid notification producer credential.",
  );
  const disabled = runtimeConfig(data, false);
  expect(producerCredentials(disabled.notify, {})).toEqual([]);
  const notify = config.notify;
  if (!notify?.adapters["local"]) throw new Error("Missing config fixture");
  const ambiguous = {
    ...notify,
    adapters: {
      ...notify.adapters,
      other: {
        ...notify.adapters["local"],
        path: "/v1/notifications/other",
        sources: [
          {
            ...notify.adapters["local"].sources[0],
            id: "second",
            tokenEnv: "OTHER",
            topics: ["release.*"],
            audience: "internal" as const,
            perMinute: 60,
          },
        ],
      },
    },
  };
  expect(() =>
    producerCredentials(ambiguous, {
      NOTIFY_CI: producerToken,
      OTHER: producerToken,
    }),
  ).toThrow("Ambiguous notification producer credential.");
  const operator = "o".repeat(43);
  await writeFile(join(data, "api-token"), `${operator}\n`, { mode: 0o600 });
  await chmod(join(data, "api-token"), 0o600);
  await expect(
    checkCredentials(
      path,
      config.bots,
      { NOTIFY_CI: operator },
      [],
      notify,
      data,
    ),
  ).rejects.toThrow("Ambiguous notification producer credential.");
  expect(await readFile(join(data, "api-token"), "utf8")).toBe(`${operator}\n`);
});

test("aliases deduplicate only identical physical bindings and notify remains restart-only on failed reload", async () => {
  const config = runtimeConfig(await temporary());
  const notify = config.notify;
  if (!notify?.destinations["log"]) throw new Error("Missing config fixture");
  const aliases = {
    ...notify,
    destinations: { ...notify.destinations, alias: notify.destinations["log"] },
  };
  expect(
    resolveDestinations(aliases, [
      { bot: bot(), identity: { team: "T123", user: "UHELPER" } },
    ])["alias"],
  ).toEqual(
    resolveDestinations(aliases, [
      { bot: bot(), identity: { team: "T123", user: "UHELPER" } },
    ])["log"],
  );
  const initial = { config, environment: {} };
  const next = {
    config: { ...config, notify: { ...notify, limits: { outboxRows: 1 } } },
    environment: {},
  };
  expect(restartRequired(initial, next)).toContain("notify.limits");
  let applied = 0;
  const reload = new ConfigReload(
    initial,
    async () => next,
    pino({ enabled: false }),
  );
  reload.listen(async () => {
    applied++;
  });
  expect((await reload.request()).status).toBe("restart-required");
  expect(reload.current).toBe(initial);
  expect(applied).toBe(0);
});

test("enabled HTTP config requires Unix API; disabled invalid topology still fails", () => {
  for (const api of [undefined, { listen: "127.0.0.1:8484" }])
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(configSchema)({
          bots: [bot()],
          notify: notificationConfig(true),
          api,
        }),
      ),
    ).toBe(true);
  const invalid = notificationConfig();
  invalid.subscriptions[0]?.to.push("missing");
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(configSchema)({
        bots: [bot()],
        notify: invalid,
      }),
    ),
  ).toBe(true);
});
