// Legacy Zod 4.6.7 corpus at 4ff23cb, with the IRC turn defaults,
// NET-1736 follow-up steering and optional IRC questions contracts.
export const settingsGolden = {
  configSchema: {
    count: 6688,
    hash: "ac44815557e0bd194a6378137b05640e7110fdcafbb6699a4fdbc2929049fb6b",
  },
  botSchema: {
    count: 2646,
    hash: "fc6cf1408d118fcdfb7195edaae7a964a45b9b40ccfbe33d14d45e2cd5be0083",
  },
  backendSchema: {
    count: 831,
    hash: "b54a366b9892b4d5dfa3a4b422ed54d701b04e74874a43b0f54feff3415dfad9",
  },
  ircSchema: {
    count: 2950,
    hash: "b93d0e12061d7c8a19470a7bff9ff4d55c57cc88b9a7e1aac207dfac5923b938",
  },
  teamsSchema: {
    count: 580,
    hash: "e0cae1ae8037898688d2dda5beb983a5f7f5a665443830344c7879c784ad0f34",
  },
  piDurableBackendSchema: {
    count: 130,
    hash: "24be0ea26eee008b05724be3581fdfdc26f2ca05b8cc3b6bc1ffc49df5c3bcb7",
  },
  claudeBackendSchema: {
    count: 771,
    hash: "4fc4a5f9a301ead9673dabc17f95a76a5e9119272fa3c3e4b20f202a62dc6547",
  },
  codexBackendSchema: {
    count: 541,
    hash: "e8f8ae3b3ecb2b907d190670c66a5115241b5ee95bfcf52ca92749d1450038da",
  },
  crewActivitySchema: {
    count: 61,
    hash: "5ca8ea7e4004f2d3d04f904464aa463e2cfbedce9f05ebc06bb1ea0d221437ad",
  },
  captainPostSchema: {
    count: 144,
    hash: "7c2dffded1faec2146c8a912e291bfdc06dcfc73ac089000b32a6195f41c4607",
  },
  cronjobsSchema: {
    count: 145,
    hash: "8610e8fbc637319b1c7b56d22983c918f012433f5ced0324b90d58858a8cba50",
  },
  healthConfigSchema: {
    count: 161,
    hash: "4e6c0eb440ef5d37483555f7b978bd2e75ae063b0ba06d1a6859d471c26a274a",
  },
  mentionNameSchema: {
    count: 17,
    hash: "aaa084c5440b8ecc4ae12ae864ec903b02fb6f027f24a77bb7b03cd6bc2aa079",
  },
  textMentionRuleSchema: {
    count: 100,
    hash: "d9fae4cfcbe8cca2ba5e4dc6c26fd9cecf04e5f25562f151edaab2643181daba",
  },
  transcriptionSchema: {
    count: 202,
    hash: "6a2b916f5c95ee46d3c78becce7df255793aff23d5bbd10aa07391244ad74ef4",
  },
  waitingSchema: {
    count: 74,
    hash: "b74c889a3ff42f57b98a6110e6a777751e62ef850bda05b58056eef2909c6abe",
  },
  piProviderSchema: {
    count: 76,
    hash: "723a140e20c20ed9e425eeacb66ed9cb281ab8738be707797f567fa6a70f0c48",
  },
  piModelSchema: {
    count: 15,
    hash: "4f8c25bc90c937255920b7e478f5af2d5511eaad0c5a50f145feb9b567d41e7f",
  },
  maintenanceSchema: {
    count: 2376,
    hash: "3927034dc3952461c35139d31fda29b447621f2977dd84f0c6ffdbfd9ad93f3b",
  },
  cleanupSchema: {
    count: 296,
    hash: "8017b9a7ec9b0c6ae1ce1064da7a015a0200cab007658952ff0b97b882ad7c5c",
  },
  quotaConfigSchema: {
    count: 115,
    hash: "238a01b690e920343a6b2fd3df2b4bed135ffd2b717b1b0ccfb961db85d96a70",
  },
  quotaWatchSchema: {
    count: 402,
    hash: "518cf95757d90aa37df73228e9179ff4bdab406f29f8d904c3ebddfad5dde365",
  },
  fleetPolicySchema: {
    count: 142,
    hash: "ea4771108c195a228e45c8b0b90f3ecdb2c297fe776259da1ab418b482b90b33",
  },
  fleetControlSchema: {
    count: 796,
    hash: "cafdb338b72dc7f400ce1e96136e2c308335e685b17fb0a5bf8805af52f97c0d",
  },
} as const;

export const cronAdvertisementHash =
  "805102783f02eb7c49a877cb0796e6f5bfca3a3853a9f4b981354958cfe21bba";

// Legacy normalised provisioning plan, including property order used by its hash.
export const legacyProvisionInput = {
  version: 1,
  teamId: "T123",
  bots: [
    {
      id: "fixture",
      access: {
        users: ["U123"],
        channels: ["C123"],
      },
      backend: {
        type: "opencode",
        url: "http://localhost:4096",
        directory: "/workspace",
      },
      name: " Fixture ",
      app: {
        mode: "create",
      },
      slack: {
        appTokenEnv: "TEST_APP",
        botTokenEnv: "TEST_BOT",
      },
    },
  ],
} as const;

export const legacyProvisionDecoded = {
  version: 1,
  teamId: "T123",
  configTokenEnv: "SLACK_APP_CONFIG_TOKEN",
  bots: [
    {
      id: "fixture",
      access: {
        users: ["U123"],
        channels: ["C123"],
        deniedUsers: [],
        deniedChannels: [],
        mentionOnly: false,
      },
      backend: {
        type: "opencode",
        url: "http://localhost:4096",
        directory: "/workspace",
        headersEnv: {},
        permissions: [
          {
            action: "*",
            resource: "*",
            effect: "deny",
          },
        ],
      },
      configPanelEnabled: false,
      threadContext: false,
      waiting: {
        delayMs: 5000,
        intervalMs: 10_000,
      },
      crewActivity: {
        detail: "off",
      },
      concurrency: 4,
      turnTimeoutMs: 1_800_000,
      name: "Fixture",
      app: {
        mode: "create",
      },
      slack: {
        appTokenEnv: "TEST_APP",
        botTokenEnv: "TEST_BOT",
      },
    },
  ],
} as const;

export const piCrewAdvertisementHash =
  "e677f37f70bcf5ea3b4f29d5421c2a9f8ee2f5d85a1cc536db5333073380b3fc";
