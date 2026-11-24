import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionBots } from "../src/app/provision";
import { addBot, readConfiguration } from "../src/app/setup";
import {
  legacyProvisionDecoded,
  legacyProvisionInput,
} from "./settings-schema-golden";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function bot(id = "crew") {
  return {
    id,
    name: `Stargate ${id}`,
    app: { mode: "create" },
    slack: {
      appTokenEnv: `${id.toUpperCase()}_APP`,
      botTokenEnv: `${id.toUpperCase()}_BOT`,
    },
    access: { users: ["U123"], channels: ["C123"] },
    backend: {
      type: "opencode",
      url: "http://127.0.0.1:4096",
      directory: "/project",
      model: { providerID: "openai-proxy", id: "gpt-6.1-sol" },
    },
  };
}

async function fixture(bots: unknown[] = [bot()]) {
  const directory = await mkdtemp(join(tmpdir(), "stargate-provision-"));
  directories.push(directory);
  const planPath = join(directory, "bots.json");
  const configPath = join(directory, "stargate.json");
  const journalPath = join(directory, "journal.json");
  await writeFile(
    planPath,
    JSON.stringify({ version: 1, teamId: "T123", bots }),
  );

  return { planPath, configPath, journalPath, apply: false };
}

const credentials = { SLACK_APP_CONFIG_TOKEN: "private-config-token" };

const noNetwork = async () => {
  throw new Error("Unexpected network access");
};

test.each([false, true])(
  "a legacy provisioning journal retains its decoded-plan hash after migration (module options: %s)",
  async (moduleOptions) => {
    const input = structuredClone(legacyProvisionInput);
    const decoded = structuredClone(legacyProvisionDecoded);

    const raw = JSON.parse(
      '{"__proto__":{"fixture":true},"ordinary":1,"nested":{"__proto__":{"keep":true}}}',
    );

    const backend = {
      type: "module",
      module: "/workspace/module.ts",
      options: raw,
    };

    const bots = moduleOptions
      ? input.bots.map((bot) => ({ ...bot, backend }))
      : input.bots;

    const plan = moduleOptions
      ? {
          ...decoded,
          bots: decoded.bots.map((bot) => ({
            ...bot,
            backend: {
              ...backend,
              options: { ordinary: 1, nested: raw.nested },
            },
          })),
        }
      : decoded;

    const options = await fixture([...bots]);

    const planHash = createHash("sha256")
      .update(
        JSON.stringify({
          plan,
          configPath: options.configPath,
        }),
      )
      .digest("hex");

    await writeFile(
      options.journalPath,
      JSON.stringify({
        version: 1,
        planHash,
        bots: [{ id: "fixture", state: "pending" }],
      }),
      { mode: 0o600 },
    );

    const result = await provisionBots(options, {
      fetch: noNetwork,
      environment: {},
    });

    expect(result.bots[0]?.app).toBe("planned");
  },
);

test.each([
  ["steerThreadFollowUps", false],
  ["steerThreadFollowUps", true],
  ["inboundReactions", false],
  ["inboundReactions", true],
] as const)(
  "legacy provisioning identity ignores disabled Slack flags but rejects enabling %s (%s)",
  async (flag, enabled) => {
    const input = structuredClone(legacyProvisionInput);

    const options = await fixture(
      input.bots.map((entry) => ({
        ...entry,
        slack: { ...entry.slack, [flag]: enabled },
      })),
    );

    await writeFile(
      options.journalPath,
      JSON.stringify({
        version: 1,
        planHash: createHash("sha256")
          .update(
            JSON.stringify({
              plan: legacyProvisionDecoded,
              configPath: options.configPath,
            }),
          )
          .digest("hex"),
        bots: [{ id: "fixture", state: "pending" }],
      }),
      { mode: 0o600 },
    );

    const result = provisionBots(options, {
      fetch: noNetwork,
      environment: {},
    });

    if (enabled) {
      await expect(result).rejects.toThrow(
        "does not match the original plan/config",
      );
    } else {
      expect((await result).bots[0]?.app).toBe("planned");
    }
  },
);

test("offline planning returns manifests and links without creating files", async () => {
  const options = await fixture();

  const result = await provisionBots(options, {
    fetch: noNetwork,
    environment: {},
  });

  expect(result.bots[0]?.app).toBe("planned");
  expect(result.bots[0]?.url).toContain("manifest_json=");
  expect(result.bots[0]?.manifest.settings.socket_mode_enabled).toBe(true);
  expect(result.bots[0]?.needsHuman).toContain(
    "store_runtime_tokens_privately",
  );
  expect(await Bun.file(options.configPath).exists()).toBe(false);
  expect(await Bun.file(options.journalPath).exists()).toBe(false);
});

test("provisioning preserves all runtime settings and repeats without changes", async () => {
  const entry = {
    ...bot("pegasus"),
    app: { mode: "reuse", appId: "APEGASUS" },
    displayName: "Cain",
    threadContext: true,
    waiting: { delayMs: 3000, intervalMs: 15_000 },
    crewActivity: { detail: "summary", reporter: "twiki" },
    concurrency: 2,
    turnTimeoutMs: 60_000,
  };

  const options = { ...(await fixture([entry])), apply: true };
  const dependencies = { fetch: noNetwork, environment: {} };
  await provisionBots(options, dependencies);
  const { name: _name, app: _app, ...runtime } = entry;
  const config = await readConfiguration(options.configPath);
  expect(config.bots[0]).toMatchObject({
    ...runtime,
    slack: { ...runtime.slack, appId: "APEGASUS" },
  });
  const before = await readFile(options.configPath, "utf8");
  const result = await provisionBots(options, dependencies);
  expect(result.bots[0]?.registration).toBe("unchanged");
  expect(await readFile(options.configPath, "utf8")).toBe(before);
});

test("strict plans reject unknown fields and validate every bot before writes", async () => {
  const options = await fixture([bot(), { ...bot("other"), token: "secret" }]);
  await expect(
    provisionBots({ ...options, apply: true }, { fetch: noNetwork }),
  ).rejects.toThrow("Invalid provisioning plan");
  expect(await Bun.file(options.journalPath).exists()).toBe(false);
  await writeFile(
    options.planPath,
    JSON.stringify({ version: 2, teamId: "T123", bots: [bot()] }),
  );
  await expect(provisionBots(options)).rejects.toThrow(
    "Invalid provisioning plan",
  );
});

test("cross-kind token references conflict before remote creation", async () => {
  const second = bot("other");
  second.slack.botTokenEnv = "CREW_APP";
  const options = await fixture([bot(), second]);
  await expect(
    provisionBots({ ...options, apply: true }, { fetch: noNetwork }),
  ).rejects.toThrow("conflict");
  expect(await Bun.file(options.journalPath).exists()).toBe(false);
});

test("configuration-token reference cannot also identify a runtime token", async () => {
  const entry = bot();
  entry.slack.appTokenEnv = "SLACK_APP_CONFIG_TOKEN";
  const options = await fixture([entry]);
  await expect(
    provisionBots({ ...options, apply: true }, { fetch: noNetwork }),
  ).rejects.toThrow("conflict");
  expect(await Bun.file(options.journalPath).exists()).toBe(false);
});

test("existing registration conflicts block the whole batch before creation", async () => {
  const reused = { ...bot("bowser"), app: { mode: "reuse", appId: "ABOWSER" } };
  const options = await fixture([bot(), reused]);
  const { name: _name, app: _app, ...runtime } = bot("bowser");
  await addBot(options.configPath, {
    ...runtime,
    slack: { ...runtime.slack, appId: "ADIFFERENT" },
  });
  await expect(
    provisionBots({ ...options, apply: true }, { fetch: noNetwork }),
  ).rejects.toThrow("conflict");
  expect(await Bun.file(options.journalPath).exists()).toBe(false);
});

test("apply checkpoints and creates sequentially, resumes without duplication", async () => {
  const options = await fixture([bot(), bot("other")]);
  const requested: string[] = [];

  const create = async (_url: string, init: RequestInit) => {
    const journal = JSON.parse(await readFile(options.journalPath, "utf8"));
    const current = requested.length === 0 ? "crew" : "other";
    expect(
      journal.bots.find((entry: { id: string }) => entry.id === current).state,
    ).toBe("creating");
    expect(init.headers).toEqual({
      authorization: "Bearer private-config-token",
    });
    const body = new URLSearchParams(String(init.body));
    requested.push(
      JSON.parse(body.get("manifest") ?? "{}").display_information.name,
    );

    return Response.json({
      ok: true,
      app_id: requested.length === 1 ? "ACREW" : "AOTHER",
      credentials: { client_secret: "xoxb-FAKE-SECRET" },
    });
  };

  const first = await provisionBots(
    { ...options, apply: true },
    { fetch: create, environment: credentials },
  );

  expect(requested).toEqual(["Stargate crew", "Stargate other"]);
  expect(first.bots.map((entry) => entry.registration)).toEqual([
    "added",
    "added",
  ]);

  const second = await provisionBots(
    { ...options, apply: true },
    { fetch: noNetwork, environment: credentials },
  );

  expect(second.bots.map((entry) => entry.registration)).toEqual([
    "unchanged",
    "unchanged",
  ]);
  expect((await readConfiguration(options.configPath)).bots).toHaveLength(2);
  expect(await Bun.file(`${options.configPath}.env`).exists()).toBe(false);
  expect((await stat(options.journalPath)).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(first)).not.toContain("FAKE-SECRET");
  expect(await readFile(options.journalPath, "utf8")).not.toContain(
    "FAKE-SECRET",
  );
});

test("uncertain creates never retry until exact bot app ID is recorded", async () => {
  const options = await fixture();

  const first = await provisionBots(
    { ...options, apply: true },
    {
      environment: credentials,
      fetch: async () => {
        throw new Error("xoxb-PRIVATE-EXCEPTION");
      },
    },
  );

  expect(first.bots[0]?.app).toBe("outcome_unknown");

  const blocked = await provisionBots(
    { ...options, apply: true },
    { fetch: noNetwork, environment: credentials },
  );

  expect(blocked.bots[0]?.app).toBe("outcome_unknown");
  expect(blocked.bots[0]?.url).toBe("https://api.slack.com/apps");
  await expect(
    provisionBots({ ...options, recordApp: "missing=ACREW" }),
  ).rejects.toThrow("record-app");

  const recorded = await provisionBots(
    { ...options, apply: true, recordApp: "crew=ACREW" },
    { fetch: noNetwork, environment: {} },
  );

  expect(recorded.bots[0]?.appId).toBe("ACREW");
  expect(recorded.bots[0]?.registration).toBe("added");
  expect(JSON.stringify(first)).not.toContain("PRIVATE-EXCEPTION");
});

test("malformed and partial-error API responses remain uncertain and sanitized", async () => {
  for (const response of [
    Response.json({ ok: true, credentials: "xoxb-FAKE-SECRET" }),
    Response.json({
      ok: false,
      error: "internal_error",
      secret: "xapp-PRIVATE",
    }),
    new Response("xoxb-FAKE-SECRET", { status: 502 }),
  ]) {
    const options = await fixture();

    const result = await provisionBots(
      { ...options, apply: true },
      { fetch: async () => response, environment: credentials },
    );

    expect(result.bots[0]?.app).toBe("outcome_unknown");
    expect(JSON.stringify(result)).not.toMatch(/FAKE-SECRET|PRIVATE/);
    await provisionBots(
      { ...options, apply: true },
      { fetch: noNetwork, environment: credentials },
    );
  }
});

test("a definite authentication rejection can retry on a later apply", async () => {
  const options = await fixture();

  const rejected = await provisionBots(
    { ...options, apply: true },
    {
      environment: credentials,
      fetch: async () =>
        Response.json({
          ok: false,
          error: "invalid_auth",
          token: "xoxb-SECRET",
        }),
    },
  );

  expect(rejected.bots[0]?.app).toBe("failed");
  expect(JSON.stringify(rejected)).not.toContain("SECRET");

  const retried = await provisionBots(
    { ...options, apply: true },
    {
      environment: credentials,
      fetch: async () => Response.json({ ok: true, app_id: "ACREW" }),
    },
  );

  expect(retried.bots[0]?.registration).toBe("added");
});

test("429 persists Retry-After and prevents an early retry", async () => {
  const options = await fixture([bot(), bot("other")]);
  let requests = 0;

  const result = await provisionBots(
    { ...options, apply: true },
    {
      environment: credentials,
      now: () => 1000,
      fetch: async () => {
        requests++;

        return new Response("private body", {
          status: 429,
          headers: { "retry-after": "120" },
        });
      },
    },
  );

  expect(result.bots[0]?.app).toBe("rate_limited");
  expect(result.bots[0]?.retryAfterSeconds).toBe(120);
  expect(result.bots[1]?.app).toBe("planned");
  expect(requests).toBe(1);

  const early = await provisionBots(
    { ...options, apply: true },
    {
      environment: credentials,
      now: () => 2000,
      fetch: async () => {
        requests++;

        return Response.json({ ok: true, app_id: "ATOOSOON" });
      },
    },
  );

  expect(requests).toBe(1);
  expect(early.bots[1]?.app).toBe("planned");

  const retried = await provisionBots(
    { ...options, apply: true },
    {
      environment: credentials,
      now: () => 121_000,
      fetch: async () =>
        Response.json({
          ok: true,
          app_id: ++requests === 2 ? "ACREW" : "AOTHER",
        }),
    },
  );

  expect(retried.bots[0]?.registration).toBe("added");
});

test("interrupted checkpoints become unknown, and changed plans are rejected", async () => {
  const options = await fixture();
  await provisionBots({ ...options, apply: true }, { environment: {} });
  const journal = JSON.parse(await readFile(options.journalPath, "utf8"));
  journal.bots[0].state = "creating";
  await writeFile(options.journalPath, JSON.stringify(journal), {
    mode: 0o600,
  });

  const result = await provisionBots(
    { ...options, apply: true },
    { environment: credentials, fetch: noNetwork },
  );

  expect(result.bots[0]?.app).toBe("outcome_unknown");
  const changed = bot();
  changed.name = "Different";
  await writeFile(
    options.planPath,
    JSON.stringify({ version: 1, teamId: "T123", bots: [changed] }),
  );
  await expect(provisionBots(options)).rejects.toThrow("original plan/config");
});

test("recorded App ID conflicts fail before a checkpoint is written", async () => {
  const options = await fixture([
    bot(),
    { ...bot("other"), app: { mode: "reuse", appId: "AOTHER" } },
  ]);

  await expect(
    provisionBots({ ...options, recordApp: "crew=AOTHER" }),
  ).rejects.toThrow("App ID conflict");
  expect(await Bun.file(options.journalPath).exists()).toBe(false);
});

test("reuse never creates or modifies an app and registers references only", async () => {
  const options = await fixture([
    { ...bot("bowser"), app: { mode: "reuse", appId: "ABOWSER" } },
  ]);

  const result = await provisionBots(
    { ...options, apply: true },
    {
      fetch: noNetwork,
      environment: { BOWSER_APP: "xapp-private", BOWSER_BOT: "xoxb-private" },
    },
  );

  expect(result.bots[0]?.app).toBe("reused");
  expect(result.bots[0]?.url).toBe("https://api.slack.com/apps/ABOWSER");
  expect(result.bots[0]?.credentials).toBe("present");
  expect(await Bun.file(`${options.configPath}.env`).exists()).toBe(false);
  expect(await readFile(options.configPath, "utf8")).not.toContain("private");
});

test("recording UI-created apps does not require configuration tokens", async () => {
  const options = await fixture();

  const result = await provisionBots(
    { ...options, recordApp: "crew=ACREW" },
    { fetch: noNetwork, environment: {} },
  );

  expect(result.bots[0]?.app).toBe("recorded");
  expect(await Bun.file(options.configPath).exists()).toBe(false);
  await expect(
    provisionBots({ ...options, recordApp: "crew=ADIFFERENT" }),
  ).rejects.toThrow("record-app");
});

test("journal lock prevents concurrent writers", async () => {
  const options = await fixture();
  await writeFile(`${options.journalPath}.lock`, "", { mode: 0o600 });
  await expect(
    provisionBots({ ...options, apply: true }, { fetch: noNetwork }),
  ).rejects.toThrow("locked");
});
