import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Predicate, Result, Schema } from "effect";
import { z } from "zod";
import { crewActivitySchema } from "../src/activity/activity";
import { captainPostSchema } from "../src/captain-post/captain-post-config";
import {
  backendSchema,
  botSchema,
  claudeBackendSchema,
  codexBackendSchema,
  configSchema,
  ircSchema,
  loadConfig,
  piCrewBackendSchema,
  piDurableBackendSchema,
  teamsSchema,
} from "../src/config";
import { objectToolInput } from "../src/crew/tool-input";
import { cronOperationSchema } from "../src/cron/control";
import { cronjobsSchema } from "../src/cron/job-config";
import { fleetControlSchema } from "../src/fleet/protocol";
import { fleetPolicySchema } from "../src/fleet/fleet-policy";
import { healthConfigSchema } from "../src/health/health-config";
import {
  mentionNameSchema,
  textMentionRuleSchema,
} from "../src/shared/mentions";
import { cleanupSchema } from "../src/maintenance/nightly/cleanup-config";
import { maintenanceSchema } from "../src/maintenance/nightly/config";
import { nightlyWindowSchema } from "../src/maintenance/nightly/instructions";
import { piModelSchema, piProviderSchema } from "../src/backends/pi/pi-model";
import { quotaConfigSchema } from "../src/quota/quota";
import { quotaWatchSchema } from "../src/quota/quota-watch";
import { decodeSettings } from "../src/settings-errors";
import { legacySetting } from "../src/settings-legacy";
import {
  settingsCheck,
  settingsDefault,
  settingsIssues,
  settingsStruct,
} from "../src/settings-schema";
import { transcriptionSchema } from "../src/transcription/transcription";
import { waitingSchema } from "../src/gateway/waiting";
import {
  settingsCanonical,
  settingsCases,
  settingsRecordCases,
  settingsSeeds,
} from "./settings-cases";
import {
  cronAdvertisementHash,
  piCrewAdvertisementHash,
  settingsGolden,
} from "./settings-schema-golden";

const codecs = {
  configSchema,
  botSchema,
  backendSchema,
  ircSchema,
  teamsSchema,
  piDurableBackendSchema,
  claudeBackendSchema,
  codexBackendSchema,
  crewActivitySchema,
  captainPostSchema,
  cronjobsSchema,
  healthConfigSchema,
  mentionNameSchema,
  textMentionRuleSchema,
  transcriptionSchema,
  waitingSchema,
  piProviderSchema,
  piModelSchema,
  maintenanceSchema,
  cleanupSchema,
  quotaConfigSchema,
  quotaWatchSchema,
  fleetPolicySchema,
  fleetControlSchema,
};

test("review: configuration records preserve legacy shallow key handling", () => {
  const first = settingsSeeds["botSchema"]?.[0] as object;
  for (const options of settingsRecordCases) {
    const expected = z.record(z.string(), z.unknown()).parse(options);
    const result = Schema.decodeUnknownSync(configSchema)({
      bots: [
        {
          ...first,
          backend: { type: "module", module: "/workspace/module.ts", options },
        },
      ],
    });
    expect(JSON.stringify(result.bots[0]?.backend)).toBe(
      JSON.stringify({
        type: "module",
        module: "/workspace/module.ts",
        options: expected,
      }),
    );
    const backend = result.bots[0]?.backend;
    if (backend?.type !== "module") throw new Error("Unexpected backend");
    expect(backend.options["nested"]).toBe(expected["nested"]);
    expect(Object.hasOwn(options as object, "__proto__")).toBe(true);
  }
  for (const backend of [
    {
      ...(settingsSeeds["backendSchema"]?.[0] as object),
      headersEnv: JSON.parse('{"__proto__":null,"ordinary":"TEST_KEY"}'),
    },
    {
      ...(settingsSeeds["claudeBackendSchema"]?.[0] as object),
      mcpServers: JSON.parse(
        '{"__proto__":null,"fixture":{"type":"stdio","command":"/workspace/fixture"}}',
      ),
    },
  ]) {
    const decoded = Schema.decodeUnknownSync(backendSchema)(backend);
    expect(JSON.stringify(decoded)).not.toContain('"__proto__"');
  }
  expect(
    Schema.decodeUnknownResult(backendSchema)({
      ...(settingsSeeds["backendSchema"]?.[0] as object),
      headersEnv: { ordinary: null },
    })._tag,
  ).toBe("Failure");
  expect(
    Schema.decodeUnknownResult(claudeBackendSchema)({
      ...(settingsSeeds["claudeBackendSchema"]?.[0] as object),
      mcpServers: {
        "bad name": { type: "stdio", command: "/workspace/fixture" },
      },
    })._tag,
  ).toBe("Failure");
});

test("record validation retains independent key and value diagnostics", () => {
  let message = "";
  try {
    decodeSettings(claudeBackendSchema, {
      type: "claude",
      directory: "/workspace",
      model: "claude-sonnet-5-5",
      provider: {
        baseURL: "http://127.0.0.1:8317/v1",
        apiKeyEnv: "TEST_KEY",
      },
      mcpServers: {
        "bad name": { type: "http", url: "https://example.test" },
        remote: {
          type: "http",
          url: "https://example.test",
          headersHelper: "PRIVATE_DIAGNOSTIC_VALUE",
        },
        other: { type: "http", url: "PRIVATE_INVALID_URL" },
      },
    });
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    message = (error as Error).message;
  }
  expect(message).toContain('["mcpServers","bad name"]');
  expect(message).toContain('["mcpServers","remote","headersHelper"]');
  expect(message).toContain(
    "Use an absolute executable and optional literal arguments",
  );
  expect(message).toContain('["mcpServers","other","url"]');
  expect(message).not.toContain("PRIVATE_DIAGNOSTIC_VALUE");
  expect(message).not.toContain("PRIVATE_INVALID_URL");
});

test("review: raw unknown keys survive structural child failures safely", () => {
  let parentCalls = 0;
  const child = settingsStruct({ value: Schema.String });
  const schema = settingsStruct({ child, sibling: child }).check(
    settingsCheck(() => {
      parentCalls++;
    }),
  );
  expect(() =>
    decodeSettings(child, {
      value: 0,
      unknownOption: "SENSITIVE_CONFIG_VALUE",
    }),
  ).toThrow('Unrecognized key: "unknownOption"');
  try {
    decodeSettings(schema, {
      child: { value: 0, unknownOption: "SENSITIVE_CONFIG_VALUE" },
      sibling: { value: false, anotherOption: "SENSITIVE_CONFIG_VALUE" },
    });
    throw new Error("Unexpected acceptance");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('["child","value"]');
    expect(message).toContain('["sibling","value"]');
    expect(message).toContain('Unrecognized key: "unknownOption"');
    expect(message).toContain('Unrecognized key: "anotherOption"');
    expect(message).not.toContain("SENSITIVE_CONFIG_VALUE");
  }
  expect(parentCalls).toBe(0);
});

function withoutInboundReactions(value: unknown): unknown {
  if (!Predicate.isObject(value) || !Predicate.isObject(value["slack"]))
    return value;
  const { inboundReactions: _inboundReactions, ...slack } = value[
    "slack"
  ] as Record<string, unknown>;
  return { ...value, slack };
}

// Captured from Zod 4.6.7 at base4ff23cb, before replacing production schemas.
// Include raw wire order: provisioning hashes JSON.stringify(decoded plan).
for (const [name, codec] of Object.entries(codecs))
  test(`settings legacy acceptance, values and wire order: ${name}`, () => {
    // Keep the legacy oracle independent. New flags are covered separately
    // by their configuration and behaviour tests.
    const legacy = (value: unknown): unknown => {
      if (!Predicate.isObject(value) || Array.isArray(value)) return value;
      if (name === "botSchema") return withoutInboundReactions(value);
      if (name === "maintenanceSchema") {
        const { drain: _drain, ...rest } = value as Record<string, unknown>;
        return rest;
      }
      if (name === "configSchema") {
        const config = Array.isArray(value["bots"])
          ? { ...value, bots: value["bots"].map(withoutInboundReactions) }
          : value;
        if (!Predicate.isObject(config["maintenance"])) return config;
        const { drain: _drain, ...maintenance } = config[
          "maintenance"
        ] as Record<string, unknown>;
        return { ...config, maintenance };
      }
      return value;
    };
    const seeds = settingsSeeds[name];
    if (!seeds) throw new Error(`Missing seeds: ${name}`);
    const decode = Schema.decodeUnknownResult(codec, { errors: "all" });
    const decoded = seeds.map((input) => {
      const result = decode(input);
      if (Result.isFailure(result)) throw new Error(`Invalid seed for ${name}`);
      return legacy(result.success);
    });
    const cases = settingsCases(seeds, decoded);
    const outcomes = cases.map(({ label, input }) => {
      const result = decode(input);
      return Result.isSuccess(result)
        ? {
            label,
            accepted: true,
            value: settingsCanonical(legacy(result.success)),
            wireValue: JSON.stringify(legacy(result.success)),
          }
        : { label, accepted: false };
    });
    expect({
      count: cases.length,
      hash: createHash("sha256")
        .update(settingsCanonical(outcomes))
        .digest("hex"),
    }).toEqual(settingsGolden[name as keyof typeof settingsGolden]);
    // The legacy oracle sweep is CPU-bound and can exceed the default 5s
    // under a full-suite load; it is a deliberate golden comparison.
  }, 60_000);

test("settings preserve Unicode bounds, URL cleanup and explicit undefined keys", () => {
  const name = "𐐀".repeat(40);
  expect(Schema.decodeUnknownSync(mentionNameSchema)(` ${name} `)).toBe(name);
  expect(
    Result.isFailure(Schema.decodeUnknownResult(mentionNameSchema)(`${name}𐐀`)),
  ).toBe(true);
  expect(
    Schema.decodeUnknownSync(piProviderSchema)({
      baseURL: " https://exa\nmple.test/v1\t ",
      apiKeyEnv: "TEST_KEY",
    }),
  ).toEqual({ baseURL: "https://example.test/v1", apiKeyEnv: "TEST_KEY" });
  const waiting = Schema.decodeUnknownSync(waitingSchema)({
    delayMs: null,
    intervalMs: undefined,
  });
  expect(waiting).toEqual({ delayMs: null, intervalMs: 10000 });
  const bot = Schema.decodeUnknownSync(botSchema)({
    ...(settingsSeeds["botSchema"]?.[0] as object),
    displayName: undefined,
  });
  expect(Object.hasOwn(bot, "displayName")).toBe(true);
});

test("otherwise-valid configuration failures retain actionable paths and safe messages", () => {
  const cases = [
    {
      codec: backendSchema,
      input: { type: "unknown" },
      path: ["type"],
      message: "Invalid input",
    },
    {
      codec: textMentionRuleSchema,
      input: {
        channels: ["C123"],
        names: ["Captain"],
        muteBypassNames: ["Other"],
      },
      path: ["muteBypassNames"],
      message: "Mute bypass names must be configured text-mention names.",
    },
    {
      codec: configSchema,
      input: {
        ...(settingsSeeds["configSchema"]?.[0] as object),
        dashboardSocket: {
          path: "/workspace/dashboard.sock",
          groupAccess: true,
        },
      },
      path: ["dashboardSocket"],
      message: "A shared dashboard socket requires dashboard: true",
    },
    {
      codec: maintenanceSchema,
      input: { window: { start: "00:00", end: "00:00" } },
      path: ["window", "end"],
      message: "Window start and end must differ",
    },
  ];
  for (const { codec, input, path, message } of cases) {
    const result = Schema.decodeUnknownResult(codec, { errors: "all" })(input);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result))
      expect(settingsIssues(result.failure.issue).issues).toContainEqual({
        path,
        message,
      });
  }
});

test("temporary mixed-schema bridges delegate defaults and reject invalid settings", () => {
  const worker = legacySetting(piCrewBackendSchema);
  expect(
    worker.parse({ type: "pi-durable", model: "anthropic/claude-haiku-5-5" }),
  ).toEqual({
    type: "pi-durable",
    model: "anthropic/claude-haiku-5-5",
    systemPrompt: "You are a helpful assistant responding in Slack.",
    tools: "none",
  });
  expect(
    worker.safeParse({
      type: "pi-durable",
      model: "anthropic/claude-haiku-5-5",
      tools: "unsafe",
    }).success,
  ).toBe(false);
  expect(
    worker.safeParse({
      type: "pi-durable",
      model: "anthropic/claude-haiku-5-5",
      unexpected: true,
    }).success,
  ).toBe(false);
});

test("legacy defaults bypass input transforms and shallow-copy only their containers", () => {
  const fallback = [{ value: "original" }];
  const codec = settingsStruct({
    entries: Schema.mutable(
      Schema.Array(settingsStruct({ value: Schema.String })),
    ).pipe(settingsDefault(fallback)),
    text: Schema.Trim.check(Schema.isMinCodePoints(1)).pipe(
      settingsDefault("  "),
    ),
  });
  const decode = Schema.decodeUnknownSync(codec);
  const first = decode({});
  const second = decode({ text: undefined });
  expect(first.text).toBe("  ");
  expect(first.entries).not.toBe(second.entries);
  expect(first.entries[0]).toBe(second.entries[0]);
  expect(first.entries[0]).toBe(fallback[0]);
  expect(() => decode({ text: "  " })).toThrow();
});

test("installed OpenCode cron tool advertisement matches its supported fields", () => {
  const advertisement = z.toJSONSchema(objectToolInput(cronOperationSchema));
  expect(Object.keys(advertisement.properties ?? {})).toEqual([
    "op",
    "channel",
    "user",
    "page",
    "name",
    "description",
    "schedule",
    "trigger",
    "model",
    "once",
    "arbiter",
    "timezone",
    "prompt",
    "skills",
    "enabled",
    "report",
    "requestId",
    "id",
  ]);
  expect(
    createHash("sha256").update(JSON.stringify(advertisement)).digest("hex"),
  ).toBe(cronAdvertisementHash);
  expect(
    createHash("sha256")
      .update(
        settingsCanonical(z.toJSONSchema(legacySetting(piCrewBackendSchema))),
      )
      .digest("hex"),
  ).toBe(piCrewAdvertisementHash);
  expect(z.toJSONSchema(legacySetting(nightlyWindowSchema))).toMatchObject({
    properties: {
      start: { pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
      end: { pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
    },
  });
});

test("public config errors retain dependent custom diagnostics and independent field paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settings-errors-"));
  const file = join(directory, "config.json");
  const first = settingsSeeds["botSchema"]?.[0] as object;
  const cases = [
    {
      input: {
        irc: [
          {
            ...(settingsSeeds["ircSchema"]?.[0] as object),
            server: { host: "", port: 6667, tls: false },
          },
        ],
      },
      messages: [
        "Plaintext IRC is allowed only for 127.0.0.1 or ::1; set tls: true",
      ],
      paths: ["server", "host"],
    },
    {
      input: {
        ...(settingsSeeds["configSchema"]?.[3] as object),
        bots: [{ ...first, id: "" }],
      },
      messages: [
        "Maintenance report bot must exist and allow the report channel",
        "Quota report bot must exist and not deny the report channel",
      ],
      paths: ["bots", "id", "maintenance", "report", "quotaWatch"],
    },
    {
      input: {
        bots: [
          {
            ...first,
            access: {
              users: [],
              channels: ["C123"],
              textMentions: {
                channels: ["C123"],
                names: [""],
                muteBypassNames: ["Captain"],
              },
            },
          },
        ],
      },
      messages: ["Mute bypass names must be configured text-mention names."],
      paths: ["users", "names", "muteBypassNames"],
    },
    {
      input: {
        bots: [
          { ...first, pairing: { operators: ["U123"], urls: ["not-a-url"] } },
        ],
        dashboardSocket: {
          path: "/workspace/dashboard.sock",
          groupAccess: true,
        },
      },
      messages: [
        "Use an HTTPS origin, or an HTTP Tailscale origin, without credentials, path, query or fragment",
        "A shared dashboard socket requires dashboard: true",
      ],
      paths: ["pairing", "urls", "dashboardSocket"],
    },
    {
      input: {
        bots: [
          {
            ...first,
            backend: {
              ...(settingsSeeds["claudeBackendSchema"]?.[0] as object),
              provider: {
                baseURL: "https://user:SENSITIVE_CONFIG_VALUE@example.test/v1",
                apiKeyEnv: "TEST_KEY",
              },
            },
          },
        ],
      },
      messages: [
        "Use HTTPS or loopback HTTP without credentials, query, or fragment",
      ],
      paths: ["backend", "provider", "baseURL"],
    },
    {
      input: { bots: [first], unknownOption: "SENSITIVE_CONFIG_VALUE" },
      messages: ['Unrecognized key: "unknownOption"'],
      paths: ["unknownOption"],
    },
  ];
  try {
    for (const { input, messages, paths } of cases) {
      await writeFile(file, JSON.stringify(input));
      const error = await loadConfig(file).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error))
        throw new Error("Invalid config was accepted");
      expect(error.message).not.toContain("SENSITIVE_CONFIG_VALUE");
      for (const message of messages) expect(error.message).toContain(message);
      for (const path of paths) expect(error.message).toContain(path);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
