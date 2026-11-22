import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import pino from "pino";
import { configSchema } from "../src/config";
import {
  ConfigReload,
  type ReloadCandidate,
  ReloadRejected,
  readReloadCandidate,
  restartRequired,
} from "../src/app/config-reload";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const backend = {
  type: "opencode",
  url: "http://localhost:4096",
  directory: "/project",
};

const secrets = {
  STARGATE_RELOAD_ONE_APP: "xapp-secret-one-app",
  STARGATE_RELOAD_ONE_BOT: "xoxb-secret-one-bot",
  STARGATE_RELOAD_IRC: "irc-secret-captain",
  STARGATE_RELOAD_CHIEF: "irc-secret-chief",
};

const secretValues = [
  ...Object.values(secrets),
  "xoxb-secret-rotated",
  "deleted-later",
];

function slackBot(id = "one", overrides: Record<string, unknown> = {}) {
  const name = `STARGATE_RELOAD_${id.toUpperCase()}`;

  return {
    id,
    slack: {
      appId: `A${id.toUpperCase()}`,
      appTokenEnv: `${name}_APP`,
      botTokenEnv: `${name}_BOT`,
    },
    access: { users: ["U123"], channels: ["C123"] },
    backend,
    ...overrides,
  };
}

const chief = {
  id: "chief",
  account: "galactica-chief",
  passwordEnv: "STARGATE_RELOAD_CHIEF",
  channels: ["#galactica"],
  backend,
};

const helo = {
  id: "helo",
  account: "galactica-helo",
  passwordEnv: "STARGATE_RELOAD_HELO",
  channels: ["#galactica"],
  backend,
};

function ship(overrides: Record<string, unknown> = {}) {
  return {
    id: "galactica",
    server: { host: "127.0.0.1", port: 6667, tls: false },
    account: "galactica",
    passwordEnv: "STARGATE_RELOAD_IRC",
    channels: ["#galactica"],
    crew: [chief],
    backend,
    ...overrides,
  };
}

function configuration(overrides: Record<string, unknown> = {}) {
  return { bots: [slackBot()], irc: [ship()], ...overrides };
}

function candidate(
  input: Record<string, unknown>,
  environment: NodeJS.ProcessEnv = { ...secrets },
): ReloadCandidate {
  return { config: Schema.decodeUnknownSync(configSchema)(input), environment };
}

function envText(values: Record<string, string>) {
  return Object.entries(values)
    .map(([name, value]) => `${name}=${value}\n`)
    .join("");
}

async function files(
  config: Record<string, unknown> = configuration(),
  environment: Record<string, string> = secrets,
) {
  const directory = await mkdtemp(join(tmpdir(), "stargate-reload-"));
  cleanup.push(directory);
  const path = join(directory, "stargate.json");

  const write = {
    config: (value: Record<string, unknown>) =>
      writeFile(path, JSON.stringify(value)),
    env: (values: Record<string, string>) =>
      writeFile(`${path}.env`, envText(values)),
  };

  await write.config(config);
  await write.env(environment);

  return { directory, path, write };
}

function logger() {
  const lines: string[] = [];

  return {
    lines,
    log: pino({ level: "info" }, { write: (line: string) => lines.push(line) }),
  };
}

function expectNoSecrets(text: string) {
  for (const value of secretValues) expect(text).not.toContain(value);
}

function liveChange() {
  return configuration({
    bots: [
      slackBot("one", {
        access: {
          users: ["U999"],
          channels: ["C123"],
          textMentions: { channels: ["C123"], names: ["galactica"] },
        },
      }),
    ],
  });
}

test("reload candidate: config check rules, absolute data directory, no process.env change", async () => {
  const { directory, path, write } = await files(
    configuration({ dataDirectory: "state" }),
  );

  const base: NodeJS.ProcessEnv = { STARGATE_RELOAD_MARKER: "kept" };
  const before = { ...process.env };
  const loaded = await readReloadCandidate(path, base);
  expect(loaded.config.dataDirectory).toBe(join(directory, "state"));
  expect(loaded.environment["STARGATE_RELOAD_ONE_BOT"]).toBe(
    secrets.STARGATE_RELOAD_ONE_BOT,
  );
  expect(loaded.environment["STARGATE_RELOAD_MARKER"]).toBe("kept");
  expect(base).toEqual({ STARGATE_RELOAD_MARKER: "kept" });
  expect(process.env).toEqual(before);

  // The base environment wins over the companion, as at startup.
  const override = await readReloadCandidate(path, {
    STARGATE_RELOAD_ONE_BOT: "xoxb-from-environment",
  });

  expect(override.environment["STARGATE_RELOAD_ONE_BOT"]).toBe(
    "xoxb-from-environment",
  );

  await write.env({ ...secrets, STARGATE_RELOAD_ONE_APP: "not-a-token" });
  await expect(readReloadCandidate(path, {})).rejects.toThrow(
    "Missing or invalid Slack token",
  );
  const { STARGATE_RELOAD_CHIEF: _, ...withoutChief } = secrets;
  await write.env(withoutChief);
  await expect(readReloadCandidate(path, {})).rejects.toThrow(
    "Missing IRC password",
  );
  await write.env(secrets);
  await write.config(
    configuration({
      irc: [
        ship({
          server: {
            host: "10.0.0.1",
            port: 6697,
            tls: true,
            caFile: join(directory, "missing.pem"),
          },
        }),
      ],
    }),
  );
  await expect(readReloadCandidate(path, {})).rejects.toThrow("caFile");
  await write.config(
    configuration({ bots: [slackBot("one", { access: {} })] }),
  );
  await expect(readReloadCandidate(path, {})).rejects.toThrow(
    "Cannot read a valid configuration",
  );
  expect(process.env).toEqual(before);
});

test("restart policy: access, transcription and crew membership are live; ids order ignored", () => {
  const current = candidate(
    configuration({ bots: [slackBot("one"), slackBot("two")] }),
    {
      ...secrets,
      STARGATE_RELOAD_TWO_APP: "xapp-two",
      STARGATE_RELOAD_TWO_BOT: "xoxb-two",
    },
  );

  const next = candidate(
    configuration({
      bots: [
        slackBot("two"),
        slackBot("one", {
          access: {
            users: ["*"],
            channels: ["C123", "C456"],
            deniedUsers: ["U666"],
            peerCaptains: true,
            textMentions: { channels: ["C123"], names: ["galactica"] },
          },
          transcription: {
            provider: {
              type: "azure-openai",
              endpoint: "https://speech.example.com/",
              deployment: "whisper",
              apiVersion: "2024-06-01",
              auth: "managedIdentity",
            },
            spokenMentions: { channels: ["C123"], names: ["galactica"] },
          },
        }),
      ],
      irc: [
        ship({
          access: {
            deniedAccounts: ["mallory"],
            peerCaptains: ["defiant"],
            textMentions: ["all captains"],
            shipTurnsPerAgentPerHour: 5,
          },
          crew: [helo],
        }),
      ],
    }),
    {
      ...current.environment,
      STARGATE_RELOAD_HELO: "irc-secret-helo",
    },
  );

  expect(restartRequired(current, next)).toEqual([]);
});

test("restart policy: reconnect and other fields are listed by path, without values", () => {
  const current = candidate(configuration());

  const next = candidate(
    configuration({
      dataDirectory: "elsewhere",
      dashboard: true,
      bots: [
        slackBot("one", {
          displayName: "Galactica",
          access: { users: ["U999"], channels: ["C123"] },
          slack: {
            appId: "AONE",
            appTokenEnv: "STARGATE_RELOAD_ONE_APP",
            botTokenEnv: "STARGATE_RELOAD_ROTATED_BOT",
          },
          backend: { ...backend, url: "http://localhost:4097" },
          concurrency: 8,
        }),
        slackBot("two"),
      ],
      irc: [
        ship({
          server: { host: "127.0.0.1", port: 6668, tls: false },
          channels: ["#galactica", "#pegasus"],
          features: { typing: false },
          crew: [{ ...chief, backend: { ...backend, agent: "chief" } }],
        }),
      ],
    }),
    {
      ...secrets,
      STARGATE_RELOAD_ONE_BOT: "xoxb-secret-rotated",
      STARGATE_RELOAD_ROTATED_BOT: "xoxb-secret-rotated",
    },
  );

  const paths = restartRequired(current, next);
  expect(paths).toEqual([
    "bots[one].backend.url",
    "bots[one].concurrency",
    "bots[one].displayName",
    "bots[one].slack.botTokenEnv",
    "bots[two]",
    "dashboard",
    "dataDirectory",
    "environment.STARGATE_RELOAD_ONE_BOT",
    "irc[galactica].channels",
    "irc[galactica].crew[chief].backend.agent",
    "irc[galactica].features.typing",
    "irc[galactica].server.port",
  ]);
  expectNoSecrets(JSON.stringify(paths));
  // Removing a transport or a deleted companion value is restart-only too.
  const { STARGATE_RELOAD_CHIEF: _, ...withoutChief } = secrets;
  expect(
    restartRequired(current, candidate({ bots: [slackBot()] }, withoutChief)),
  ).toEqual(["environment.STARGATE_RELOAD_CHIEF", "irc[galactica]"]);
});

test("reload applies a valid live change; current advances only after apply resolves", async () => {
  const { path, write } = await files();
  const { lines, log } = logger();
  const initial = await readReloadCandidate(path, {});

  const reload = new ConfigReload(
    initial,
    () => readReloadCandidate(path, {}),
    log,
  );

  const gate = Promise.withResolvers<void>();
  const applied: ReloadCandidate[] = [];
  reload.listen(async (next) => {
    applied.push(next);
    await gate.promise;
  });
  await write.config(liveChange());
  const pending = reload.request();
  await Bun.sleep(20);
  expect(applied).toHaveLength(1);
  expect(reload.current).toBe(initial);
  gate.resolve();
  expect(await pending).toEqual({
    status: "applied",
    message: "Configuration reloaded.",
  });
  expect(reload.current).toBe(applied[0] as ReloadCandidate);
  expect(reload.current.config.bots[0]?.access.users).toEqual(["U999"]);
  // Nothing changed: no apply.
  expect((await reload.request()).status).toBe("unchanged");
  expect(applied).toHaveLength(1);
  expectNoSecrets(lines.join(""));
});

test("reload keeps the running config for invalid files, restart-only keys and changed credentials", async () => {
  const kept = { ...secrets, STARGATE_RELOAD_UNUSED: "deleted-later" };
  const { path, write } = await files(configuration(), kept);
  const { lines, log } = logger();
  const before = { ...process.env };
  const initial = await readReloadCandidate(path, {});

  const reload = new ConfigReload(
    initial,
    () => readReloadCandidate(path, {}),
    log,
  );

  const applied: ReloadCandidate[] = [];
  reload.listen(async (next) => {
    applied.push(next);
  });

  await writeFile(path, "{ not json");
  const invalid = await reload.request();
  expect(invalid.status).toBe("invalid");
  await write.config(
    configuration({ bots: [slackBot("one", { access: {} })] }),
  );
  expect((await reload.request()).status).toBe("invalid");
  await write.config(configuration());
  await write.env({ ...kept, STARGATE_RELOAD_ONE_BOT: "" });
  expect((await reload.request()).status).toBe("invalid");

  // A live change mixed with reconnect keys is refused as a whole.
  await write.env(kept);
  const mixed = liveChange();
  await write.config({
    ...mixed,
    bots: [
      {
        ...(mixed.bots as Record<string, unknown>[])[0],
        backend: { ...backend, url: "http://localhost:4097" },
      },
    ],
    irc: [ship({ server: { host: "127.0.0.1", port: 6668, tls: false } })],
  });
  const refused = await reload.request();
  expect(refused).toMatchObject({
    status: "restart-required",
    paths: ["bots[one].backend.url", "irc[galactica].server.port"],
  });
  expect(refused.message).toContain("restart required");

  // A changed or deleted companion value is visible and restart-only.
  await write.config(configuration());
  await write.env({ ...kept, STARGATE_RELOAD_ONE_BOT: "xoxb-secret-rotated" });
  expect(await reload.request()).toMatchObject({
    status: "restart-required",
    paths: ["environment.STARGATE_RELOAD_ONE_BOT"],
  });
  await write.env(secrets);
  expect(await reload.request()).toMatchObject({
    status: "restart-required",
    paths: ["environment.STARGATE_RELOAD_UNUSED"],
  });

  expect(applied).toEqual([]);
  expect(reload.current).toBe(initial);
  expect(process.env).toEqual(before);
  const text = lines.join("");
  expect(text).toContain("Run stargate config check for details");
  expect(text).toContain("environment.STARGATE_RELOAD_ONE_BOT");
  expectNoSecrets(text);
  expect(text).not.toContain("not json");
});

test("reload adds a crew member only once its new credential is present", async () => {
  const { path, write } = await files();
  const { lines, log } = logger();

  const reload = new ConfigReload(
    await readReloadCandidate(path, {}),
    () => readReloadCandidate(path, {}),
    log,
  );

  const applied: ReloadCandidate[] = [];
  reload.listen(async (next) => {
    applied.push(next);
  });
  await write.config(configuration({ irc: [ship({ crew: [chief, helo] })] }));
  expect((await reload.request()).status).toBe("invalid");
  await write.env({ ...secrets, STARGATE_RELOAD_HELO: "irc-secret-helo" });
  expect((await reload.request()).status).toBe("applied");
  expect(reload.current.config.irc[0]?.crew.map((member) => member.id)).toEqual(
    ["chief", "helo"],
  );
  expect(reload.current.environment["STARGATE_RELOAD_HELO"]).toBe(
    "irc-secret-helo",
  );
  // Removal is live as well; the runtime decides whether the member is idle.
  await write.config(configuration({ irc: [ship({ crew: [helo] })] }));
  expect((await reload.request()).status).toBe("applied");
  expect(applied).toHaveLength(2);
  expect(lines.join("")).not.toContain("irc-secret-helo");
});

test("reload serializes requests and is unavailable without a listener or after close", async () => {
  const { log } = logger();
  const initial = candidate(configuration());

  const changes = [
    candidate(liveChange()),
    candidate(
      configuration({
        bots: [
          slackBot("one", { access: { users: ["U1"], channels: ["C1"] } }),
        ],
      }),
    ),
  ];

  let reads = 0;

  const reload = new ConfigReload(
    initial,
    async () => changes[reads++ % changes.length] as ReloadCandidate,
    log,
  );

  expect(await reload.request()).toMatchObject({ status: "unavailable" });
  expect(reload.current).toBe(initial);

  let active = 0;
  let overlap = false;
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const applied: ReloadCandidate[] = [];

  const stop = reload.listen(async (next) => {
    overlap ||= active > 0;
    active++;
    applied.push(next);
    await gates[applied.length - 1]?.promise;
    active--;
  });

  reads = 0;
  const first = reload.request();
  const second = reload.request();
  await Bun.sleep(20);
  expect(applied).toHaveLength(1);
  expect(reads).toBe(1);
  gates[0]?.resolve();
  expect((await first).status).toBe("applied");
  await Bun.sleep(20);
  expect(applied).toHaveLength(2);
  gates[1]?.resolve();
  expect((await second).status).toBe("applied");
  expect(overlap).toBe(false);
  expect(reload.current).toBe(changes[1] as ReloadCandidate);

  stop();
  reads = 0;
  expect((await reload.request()).status).toBe("unavailable");
  expect(reload.current).toBe(changes[1] as ReloadCandidate);

  // Close while a read is pending: the loaded candidate is never applied.
  const read = Promise.withResolvers<ReloadCandidate>();
  const closing = new ConfigReload(initial, () => read.promise, log);
  const calls: ReloadCandidate[] = [];
  closing.listen(async (next) => {
    calls.push(next);
  });
  const pending = closing.request();
  const queued = closing.request();
  closing.close();
  read.resolve(candidate(liveChange()));
  expect((await pending).status).toBe("unavailable");
  expect((await queued).status).toBe("unavailable");
  expect((await closing.request()).status).toBe("unavailable");
  expect(calls).toEqual([]);
  expect(closing.current).toBe(initial);
});

test("runtime rejections and unknown failures keep the current config and leak nothing", async () => {
  const { lines, log } = logger();
  const initial = candidate(configuration());
  const next = candidate(liveChange());
  let failure: unknown;
  const reload = new ConfigReload(initial, async () => next, log);
  reload.listen(async () => {
    throw failure;
  });

  failure = new ReloadRejected("busy");
  expect(await reload.request()).toEqual({
    status: "busy",
    message: new ReloadRejected("busy").message,
  });
  failure = new ReloadRejected("unavailable");
  expect(await reload.request()).toEqual({
    status: "unavailable",
    message: new ReloadRejected("unavailable").message,
  });
  failure = new Error(`socket failed with ${secrets.STARGATE_RELOAD_ONE_BOT}`);
  expect((await reload.request()).status).toBe("failed");
  expect(reload.current).toBe(initial);

  const raw = new ConfigReload(
    initial,
    async () => {
      throw new Error(`provider said ${secrets.STARGATE_RELOAD_IRC}`);
    },
    log,
  );

  raw.listen(async () => {});
  expect((await raw.request()).status).toBe("invalid");
  expect(raw.current).toBe(initial);

  const text = lines.join("");
  expectNoSecrets(text);
  expect(text).not.toContain("socket failed");
  expect(text).not.toContain("provider said");
});
