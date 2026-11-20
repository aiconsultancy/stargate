import { expect, test } from "bun:test";
import { Schema } from "effect";
import { gatewayFeatures, registrationFeatures } from "../src/api/v1/features";
import { configSchema, ircFeatureDefaults } from "../src/config";
import { bot } from "./fixtures";

test("gateway and Slack features reflect parsed defaults and explicit overrides", async () => {
  const defaultConfig = Schema.decodeUnknownSync(configSchema)({
    bots: [bot()],
  });
  const byKey = Object.fromEntries(
    gatewayFeatures(defaultConfig).map((feature) => [feature.key, feature]),
  );
  expect(byKey["dashboard"]).toMatchObject({
    enabled: false,
    defaultEnabled: false,
  });
  expect(byKey["api"]).toMatchObject({ enabled: false, defaultEnabled: false });
  expect(byKey["waiting"]).toMatchObject({
    enabled: true,
    defaultEnabled: true,
  });
  const base = bot();
  const configured = Schema.decodeUnknownSync(configSchema)({
    dashboard: true,
    dashboardSocket: { path: "/run/example/dashboard.sock", groupAccess: true },
    notifications: { updateNotice: true },
    maintenance: { enabled: true, drain: { enabled: true } },
    bots: [
      {
        ...base,
        configPanelEnabled: true,
        crewActivity: { detail: "detailed" },
        waiting: { delayMs: null },
        slack: {
          ...base.slack,
          steerThreadFollowUps: true,
          inboundReactions: true,
        },
        access: { ...base.access, channels: ["CPRIVATE"], peerCaptains: true },
      },
    ],
  });
  const gateway = gatewayFeatures({
    ...configured,
    api: { listen: "127.0.0.1:7781" },
  });
  const slack = configured.bots[0];
  if (!slack) throw new Error("Missing test registration");
  const ship = await registrationFeatures({ kind: "slack", config: slack });
  expect(gateway).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: "api",
        enabled: true,
        defaultEnabled: false,
      }),
      expect.objectContaining({ key: "dashboard.groupAccess", enabled: true }),
      expect.objectContaining({ key: "maintenance.drain", enabled: true }),
      expect.objectContaining({
        key: "notifications.updateNotice",
        enabled: true,
      }),
      expect.objectContaining({
        key: "waiting",
        enabled: false,
        defaultEnabled: true,
      }),
    ]),
  );
  expect(ship).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: "crewActivity",
        value: "detailed",
        enabled: true,
        defaultEnabled: false,
      }),
      expect.objectContaining({ key: "configPanelEnabled", enabled: true }),
      expect.objectContaining({
        key: "slack.steerThreadFollowUps",
        enabled: true,
        defaultEnabled: false,
      }),
      expect.objectContaining({
        key: "slack.inboundReactions",
        enabled: true,
        defaultEnabled: false,
      }),
      expect.objectContaining({
        key: "slack.peerCaptains",
        enabled: true,
        defaultEnabled: false,
      }),
      expect.objectContaining({
        key: "slack.questions",
        enabled: false,
        value: "requester, 15 min",
      }),
    ]),
  );
  expect(JSON.stringify([gateway, ship])).not.toMatch(
    /\/run\/|CPRIVATE|APP_TOKEN|BOT_TOKEN/,
  );
});

test("every IRC switch has its schema default and roster-aware features exclude private values", async () => {
  const base = {
    id: "captain",
    server: { host: "irc.example.test", port: 6697, tls: true },
    account: "captain",
    passwordEnv: "IRC_EXAMPLE_PASSWORD",
    channels: ["#private-room"],
    backend: {
      type: "opencode",
      directory: "/private/repo",
      url: "http://127.0.0.1:4096",
      sessionID: "ses_test",
    },
    fleetPolicy: {
      role: "captain",
      humanAccounts: ["example-human"],
      agentAccounts: ["peer"],
      assignedCheckout: "/private/repo",
      capabilities: ["dispatch"],
    },
    fleetControl: {
      socketPath: "/private/fleet.sock",
      statePath: "/private/fleet.sqlite",
      targets: [
        {
          id: "peer",
          account: "peer",
          role: "captain",
          channel: "#private-peer",
          sessionID: "ses_peer",
        },
      ],
    },
    fleetChannels: { home: "#private-room", command: "#private-command" },
  };
  const config = Schema.decodeUnknownSync(configSchema)({
    irc: [
      {
        ...base,
        features: { typing: false },
        dmPolicy: "redirect",
        access: { peerTurnsPerHour: 0, allCallWords: [] },
      },
    ],
  }).irc[0];
  if (!config) throw new Error("Missing test registration");
  const features = await registrationFeatures({ kind: "irc", config });
  const byKey = Object.fromEntries(
    features.map((feature) => [feature.key, feature]),
  );
  for (const [key, value] of Object.entries(ircFeatureDefaults))
    expect(byKey[`irc.${key}`]).toMatchObject({
      defaultEnabled: value,
      enabled: key === "typing" ? false : value,
    });
  const feedbackKeys = [
    "questions",
    "crewQuestionHandoff",
    "liveProgress",
    "fleetTyping",
  ] as const;
  for (const key of feedbackKeys)
    expect(byKey[`irc.${key}`]).toMatchObject({
      enabled: true,
      defaultEnabled: true,
    });
  expect(byKey["irc.channelRequests"]).toMatchObject({
    enabled: true,
    value: "nick-mention",
  });
  expect(byKey["irc.peerCaptains"]).toMatchObject({ enabled: false });
  expect(byKey["irc.allCalls"]).toMatchObject({
    enabled: false,
    defaultEnabled: true,
  });
  expect(byKey["irc.directMessages"]).toMatchObject({
    enabled: false,
    value: "redirect",
    defaultEnabled: true,
  });
  expect(JSON.stringify(features)).not.toMatch(
    /#private|\/private|example-human|IRC_EXAMPLE_PASSWORD/,
  );
  const disabled = await registrationFeatures({
    kind: "irc",
    config:
      Schema.decodeUnknownSync(configSchema)({
        irc: [
          {
            ...base,
            features: {
              questions: false,
              crewQuestionHandoff: false,
              liveProgress: false,
              fleetTyping: false,
            },
          },
        ],
      }).irc[0] ?? config,
  });
  for (const key of feedbackKeys)
    expect(
      disabled.find((feature) => feature.key === `irc.${key}`),
    ).toMatchObject({
      enabled: false,
      defaultEnabled: true,
    });
});
