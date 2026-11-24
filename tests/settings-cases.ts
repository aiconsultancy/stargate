/** Synthetic configuration corpus shared by the legacy characterization probe
 * and the retained Effect regression. No host configuration or credentials.
 */
export const settingsModules: Record<string, string> = {
  configSchema: "config",
  botSchema: "config",
  backendSchema: "config",
  ircSchema: "config",
  teamsSchema: "config",
  piDurableBackendSchema: "config",
  claudeBackendSchema: "config",
  codexBackendSchema: "config",
  crewActivitySchema: "activity",
  captainPostSchema: "captain-post-config",
  cronjobsSchema: "cronjob-config",
  healthConfigSchema: "health-config",
  mentionNameSchema: "mentions",
  textMentionRuleSchema: "mentions",
  transcriptionSchema: "transcription",
  waitingSchema: "waiting",
  piProviderSchema: "pi-model",
  piModelSchema: "pi-model",
  maintenanceSchema: "nightly/config",
  cleanupSchema: "nightly/cleanup-config",
  quotaConfigSchema: "quota",
  quotaWatchSchema: "quota-watch",
  fleetPolicySchema: "fleet-policy",
  fleetControlSchema: "fleet/protocol",
};

const opencode = {
  type: "opencode",
  url: "http://localhost:4096",
  directory: "/workspace",
};

const provider = {
  baseURL: "http://127.0.0.1:8317/v1",
  apiKeyEnv: "TEST_PROXY_KEY",
};

const claude = {
  type: "claude",
  directory: "/workspace",
  model: "claude-sonnet-5-5",
  provider,
};

const codex = {
  type: "codex",
  directory: "/workspace",
  model: "gpt-6.1-sol",
  provider,
};

const pi = {
  type: "pi-durable",
  directory: "/workspace",
  model: "anthropic/claude-haiku-5-5",
};

const bot = {
  id: "fixture",
  slack: { appId: "A123", appTokenEnv: "TEST_APP", botTokenEnv: "TEST_BOT" },
  access: { users: ["U123"], channels: ["C123"] },
  backend: opencode,
};

const transcription = {
  provider: {
    type: "azure-openai",
    endpoint: "https://example.test",
    deployment: "fixture",
    apiVersion: "2026-01-01",
    auth: "managedIdentity",
  },
};

const policy = {
  role: "captain",
  humanAccounts: ["human"],
  agentAccounts: ["peer"],
  assignedCheckout: "/workspace",
  capabilities: ["read_code", "dispatch"],
};

const fleet = {
  socketPath: "/workspace/fleet.sock",
  statePath: "/workspace/fleet.sqlite",
  targets: [
    {
      id: "peer",
      account: "Peer",
      channel: "#peer",
      sessionID: "ses_peer",
      role: "captain",
    },
  ],
};

const irc = {
  id: "ship",
  server: { host: "127.0.0.1", port: 6667, tls: false },
  account: "Captain",
  passwordEnv: "TEST_IRC",
  channels: ["#ship"],
  backend: opencode,
};

const uuid = "12345678-1234-4123-8123-123456789abc";

const teams = {
  id: "teams",
  botClientId: uuid,
  tenantId: uuid,
  socketPath: "/workspace/teams.sock",
  access: { users: [uuid] },
  backend: opencode,
};

const quota = {
  baseURL: "http://127.0.0.1:8317",
  managementKeyFile: "/workspace/key",
  accounts: { claude: ["fixture@example.test"], codex: ["other@example.test"] },
};

const watch = {
  proxy: quota,
  stateFile: "/workspace/quota.json",
  report: { bot: "fixture", channel: "C123" },
};

const maintenance = {
  enabled: true,
  components: {
    stargate: true,
    cliproxyapi: true,
    agentClis: true,
    models: true,
  },
  cleanup: {
    enabled: true,
    scratchRoots: ["/workspace/scratch"],
    repositories: ["/workspace/repo"],
    protectedPaths: ["/workspace/keep"],
  },
  report: { bot: "fixture", channel: "C123" },
  proxy: { clientKeyFile: "/workspace/key" },
  stargate: { root: "/workspace/releases" },
  cliproxyapi: {
    link: "/workspace/proxy",
    binary: "/workspace/proxy-{version}",
  },
  agentClis: { prefix: "/workspace/local" },
  models: { teamFiles: ["/workspace/team.json"] },
  droid: { backend: { model: "anthropic/claude-haiku-5-5" } },
};

export const settingsSeeds: Record<string, unknown[]> = {
  configSchema: [
    { bots: [bot] },
    { irc: [irc] },
    { teams: [teams] },
    {
      bots: [
        {
          ...bot,
          health: {},
          captainPost: { channels: ["D123"] },
          cronjobs: {
            directory: "/workspace/cron",
            channel: "C123",
            user: "U123",
            dailyReport: {},
          },
          pairing: { operators: ["U123"], urls: ["http://fixture.ts.net"] },
          transcription,
          access: {
            ...bot.access,
            textMentions: {
              channels: ["C123"],
              names: [" Captain "],
              muteBypassNames: ["Captain"],
            },
          },
        },
      ],
      maintenance,
      quotaWatch: watch,
    },
  ],
  botSchema: [
    bot,
    { ...bot, backend: pi },
    { ...bot, backend: claude },
    { ...bot, backend: codex },
  ],
  backendSchema: [
    opencode,
    pi,
    claude,
    codex,
    {
      type: "module",
      module: "/workspace/module.ts",
      options: { opaque: [null, 1] },
    },
  ],
  piDurableBackendSchema: [pi],
  claudeBackendSchema: [
    claude,
    {
      ...claude,
      allowedTools: ["Read"],
      settingSources: ["project"],
      mcpServers: {
        local: { type: "stdio", command: "/bin/fixture" },
        remote: {
          type: "http",
          url: "https://example.test",
          headersHelper: "/bin/fixture arg",
        },
      },
    },
  ],
  codexBackendSchema: [
    codex,
    {
      ...codex,
      sandbox: "danger-full-access",
      network: true,
      extraPath: ["/workspace/bin"],
    },
  ],
  ircSchema: [
    irc,
    {
      ...irc,
      server: { host: "irc.example.test", port: 6697, tls: true },
      fleetPolicy: policy,
      fleetControl: fleet,
      backend: { ...opencode, sessionID: "ses_fixture" },
      fleetChannels: { home: "#ship", command: "#command" },
      crew: [
        {
          id: "crew",
          account: "Crew",
          channels: ["#ship"],
          passwordEnv: "TEST_CREW",
          backend: opencode,
        },
      ],
      features: { questions: true },
      audit: { channel: "#audit" },
    },
  ],
  teamsSchema: [teams],
  crewActivitySchema: [{}, { detail: "detailed", reporter: "fixture" }],
  captainPostSchema: [{ channels: ["C123"], fileDirectories: ["/workspace"] }],
  cronjobsSchema: [
    {
      directory: "/workspace/cron",
      channel: "C123",
      user: "U123",
      dailyReport: {},
    },
  ],
  healthConfigSchema: [
    {},
    {
      starfleetSnapshotFile: "/workspace/health.json",
      opencodeDataDirectory: "/workspace/native",
      crewWorktreesDirectory: "/workspace/crew",
    },
  ],
  mentionNameSchema: [" Captain ", "𐐀".repeat(40)],
  textMentionRuleSchema: [
    { channels: ["C123"], names: ["Captain"], muteBypassNames: ["Captain"] },
  ],
  transcriptionSchema: [transcription],
  waitingSchema: [{}, { delayMs: null, intervalMs: 1000 }],
  piProviderSchema: [
    provider,
    { ...provider, baseURL: " https://EXAMPLE.test/v1\n" },
  ],
  piModelSchema: ["anthropic/claude-haiku-5-5"],
  maintenanceSchema: [{}, maintenance],
  cleanupSchema: [{}, maintenance.cleanup],
  quotaConfigSchema: [quota],
  quotaWatchSchema: [watch],
  fleetPolicySchema: [policy],
  fleetControlSchema: [
    fleet,
    {
      ...fleet,
      results: true,
      reviews: {
        repositories: ["OWNER/REPO"],
        reviewers: [
          {
            agent: "reviewer",
            kind: "crew",
            family: "claude",
            directory: "/workspace/review",
            models: [{ provider: "proxy", model: "fixture" }],
          },
        ],
      },
    },
  ],
};

export type SettingsCase = { label: string; input: unknown };

// Bounded record-key corpus: only the outer __proto__ entry is discarded.
export const settingsRecordCases = [
  ['{"__proto__":{"fixture":true},"ordinary":1}', '{"ordinary":1}'],
  [
    '{"__proto__":null,"constructor":1,"prototype":2,"nested":{"__proto__":{"keep":true}}}',
    '{"constructor":1,"prototype":2,"nested":{"__proto__":{"keep":true}}}',
  ],
  [
    '{"ordinary":1,"__proto__":"ignored","after":2}',
    '{"ordinary":1,"after":2}',
  ],
] as const;

/** Replace every populated field in raw and decoded seeds, including defaults. */
export function settingsCases(
  seeds: unknown[],
  decoded: unknown[],
): SettingsCase[] {
  const cases: SettingsCase[] = [];

  const changes: unknown[] = [
    undefined,
    null,
    {},
    [],
    "",
    " ",
    "𐐀".repeat(101),
    -1,
    0,
    1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    true,
  ];

  const seen = new Set<string>();

  const add = (label: string, input: unknown) => {
    const key = settingsCanonical(input);

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    cases.push({ label, input });
  };

  const walk = (root: unknown, value: unknown, path: (string | number)[]) => {
    if (value === null || typeof value !== "object") {
      return;
    }

    if (!Array.isArray(value)) {
      const next = structuredClone(root);
      const target = at(next, path);

      if (target && typeof target === "object") {
        Object.assign(target, { unexpected: true });
      }

      add(`${path.join(".")}:extra`, next);
    }

    for (const [key, item] of Object.entries(value)) {
      const nextPath = [...path, Array.isArray(value) ? Number(key) : key];

      for (const [index, replacement] of changes.entries()) {
        const next = structuredClone(root);
        const target = at(next, path);

        if (target && typeof target === "object") {
          Object.assign(target, { [key]: replacement });
        }

        add(`${nextPath.join(".")}:${index}`, next);
      }

      walk(root, item, nextPath);
    }
  };

  for (const [index, seed] of [...seeds, ...decoded].entries()) {
    add(`seed:${index}`, seed);
    walk(seed, seed, []);
  }

  for (const [index, input] of changes.entries()) {
    add(`root:${index}`, input);
  }

  return cases;
}

function at(root: unknown, path: (string | number)[]): unknown {
  let value = root;

  for (const key of path) {
    if (value === null || typeof value !== "object") {
      return;
    }

    value = Reflect.get(value, key);
  }

  return value;
}

export function settingsCanonical(value: unknown): string {
  return JSON.stringify(value, (_key, input: unknown) => {
    if (input === undefined) {
      return { $undefined: true };
    }

    if (typeof input === "number" && !Number.isFinite(input)) {
      return { $number: String(input) };
    }

    if (input !== null && typeof input === "object" && !Array.isArray(input)) {
      return Object.fromEntries(
        Object.entries(input).sort(([a], [b]) => a.localeCompare(b)),
      );
    }

    return input;
  });
}
