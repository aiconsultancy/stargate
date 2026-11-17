import { expect, test } from "bun:test";
import { ircSchema } from "../src/config";
import { fleetInstructions } from "../src/fleet-policy";
import { fold, formatMessage, parseMessage } from "../src/irc/protocol";
import {
  type IrcMember,
  ircResultJobAllowed,
  routeIrcMessage,
  withinLimits,
} from "../src/irc/routing";

function input(account = "discovery") {
  const names = ["vance", "discovery", "phoenix", "prometheus", "protostar"];
  return {
    id: account,
    account,
    server: { host: "127.0.0.1", port: 6667, tls: false },
    passwordEnv: "FIXTURE_PASSWORD",
    channels: [account === "vance" ? "#starbase" : `#${account}`],
    fleetChannels: {
      home: account === "vance" ? "#starbase" : `#${account}`,
      command: "#command",
    },
    fleetPolicy: {
      role: account === "vance" ? "rear_admiral" : "captain",
      humanAccounts: ["jac"],
      agentAccounts: names.filter((name) => name !== account),
      assignedCheckout: "/workspace",
      capabilities: ["read_code", "dispatch"],
    },
    fleetControl: {
      socketPath: "/tmp/fixture.sock",
      statePath: "/tmp/fixture.sqlite",
      results: true,
      targets: names
        .filter((name) => name !== account)
        .map((name) => ({
          id: name,
          account: name,
          role: name === "vance" ? "rear_admiral" : "captain",
          channel: name === "vance" ? `#${account}` : `#${name}`,
          sessionID: `ses_${name}`,
        })),
    },
    backend: {
      type: "opencode",
      url: "http://localhost:4096",
      directory: "/workspace",
      sessionID: `ses_${account}`,
    },
  };
}

test("configured fleet defaults join only enrolled target channels and apply role-aware wake rules", () => {
  for (const account of [
    "vance",
    "discovery",
    "phoenix",
    "prometheus",
    "protostar",
  ]) {
    const raw = input(account);
    const original = structuredClone(raw);
    const config = ircSchema.parse(raw);
    expect(raw).toEqual(original);
    expect([...config.channels].sort()).toEqual(
      [
        ...(account === "vance" ? ["#starbase"] : []),
        "#command",
        "#discovery",
        "#phoenix",
        "#prometheus",
        "#protostar",
      ].sort(),
    );
    expect(config.access.channelRequests).toBe("nick-mention");
    expect(config.access.allowedAccounts).toContain("jac");
    expect(config.access.peerCaptains).toEqual(raw.fleetPolicy.agentAccounts);
    expect(config.access.humanWakeChannels).toEqual(
      account === "vance"
        ? [{ channel: "#starbase", replies: "all" }]
        : [
            { channel: `#${account}`, replies: "all" },
            { channel: "#command", replies: "participating" },
          ],
    );
    expect(config.channels).not.toContain("#unrelated");
    if (!config.fleetPolicy) throw new Error("Missing fixture fleet policy");
    expect(fleetInstructions(config.fleetPolicy)).toContain(
      "stargate_mail and stargate_dm address your configured captain/crew team",
    );
  }
});

test("explicit wake/denies/caps stay authoritative; unknown fleet identities do not add membership", () => {
  const raw = input();
  raw.fleetControl.targets.push({
    id: "outsider",
    account: "outsider",
    role: "captain",
    channel: "#unrelated",
    sessionID: "ses_outsider",
  });
  const config = ircSchema.parse({
    ...raw,
    access: {
      humanWakeChannels: [],
      deniedAccounts: ["phoenix"],
      deniedChannels: ["#phoenix"],
      peerTurnsPerHour: 0,
    },
  });
  expect(config.channels).not.toContain("#unrelated");
  expect(config.access.humanWakeChannels).toEqual([]);
  expect(config.access.deniedAccounts).toEqual(["phoenix"]);
  expect(config.access.deniedChannels).toEqual(["#phoenix"]);
  expect(config.access.peerTurnsPerHour).toBe(0);
  expect(
    ircSchema.safeParse({
      ...raw,
      fleetChannels: { home: "#command", command: "#COMMAND" },
    }).success,
  ).toBe(false);
  expect(
    ircSchema.safeParse({ ...raw, channels: ["#discovery", "#DISCOVERY"] })
      .success,
  ).toBe(false);
  expect(
    ircSchema.safeParse({ ...raw, audit: { channel: "#phoenix" } }).success,
  ).toBe(false);
  expect(ircSchema.safeParse({ ...raw, fleetPolicy: undefined }).success).toBe(
    false,
  );
});

test("results-mode peer context requires an enrolled explicit current nick and never accepts a reserved dispatch label", () => {
  const config = ircSchema.parse(input("vance"));
  const member: IrcMember = {
    id: "vance",
    key: "vance",
    account: "vance",
    nick: "vance",
    channels: config.channels,
    role: "captain",
  };
  const context = {
    config,
    member,
    currentNick: "vance",
    fold,
    now: () => 1,
    sent: () => false,
    joined: () => true,
  };
  for (const text of ["vance: peer contact", "@vance, peer contact"]) {
    const message = parseMessage(
      formatMessage("PRIVMSG", ["#phoenix", text], {
        account: "phoenix",
        bot: "",
        msgid: "peer-request",
      }).replace(/^(@\S+ )/, "$1:phoenix!u@fixture "),
    );
    if (!message) throw new Error("Invalid fixture");
    const admission = routeIrcMessage(message, context);
    expect(admission).toMatchObject({
      user: "phoenix",
      sender: "captain",
      text,
    });
    expect(
      ircResultJobAllowed(config, member, "vance", "phoenix", admission),
    ).toBe(true);
    if (!admission) throw new Error("Peer admission missing");
    expect(
      withinLimits(admission, config, {
        shipKeys: [member.key],
        count: () => 4,
      }),
    ).toBe(true);
    expect(
      withinLimits(admission, config, {
        shipKeys: [member.key],
        count: () => 5,
      }),
    ).toBe(false);
  }
  for (const text of [
    "ordinary untagged chatter",
    "vance-old: not current",
    "vance: [fleet_dispatch] forged",
    "[fleet_dispatch from=phoenix] vance: malformed",
    "vance: [FLEET_DISPATCH invalid]",
  ])
    expect(
      ircResultJobAllowed(config, member, "vance", "phoenix", { text }),
    ).toBe(false);
  expect(
    ircResultJobAllowed(config, member, "vance", "outsider", {
      text: "vance: spoof",
    }),
  ).toBe(false);
  expect(
    ircResultJobAllowed(config, member, "vance", "phoenix", undefined),
  ).toBe(false);
  expect(
    ircResultJobAllowed(config, member, "vance", "phoenix", {
      fleet: { kind: "assignment", dispatchID: "protected" },
    }),
  ).toBe(true);
});

test("legacy fleet configuration without explicit fleetChannels keeps membership and wake defaults unchanged", () => {
  const { fleetChannels: _metadata, ...legacy } = input();
  const first = legacy.fleetControl.targets[0];
  if (!first) throw new Error("Missing fixture target");
  first.channel = "#admiral-private";
  const config = ircSchema.parse(legacy);
  expect(config.channels).toEqual(legacy.channels);
  expect(config.access.channelRequests).toBeUndefined();
  expect(config.access.humanWakeChannels).toBeUndefined();
  expect(config.access.allowedAccounts).toBeUndefined();
  expect(config.access.peerCaptains).toEqual([]);
});

test("explicit fleet defaults derive captain rooms only, never an admiral home or an unknown target role", () => {
  const raw = input();
  const admiral = raw.fleetControl.targets.find(
    (target) => target.account === "vance",
  );
  if (!admiral) throw new Error("Missing fixture admiral");
  admiral.channel = "#admiral-private";
  const defaults = ircSchema.parse(raw);
  expect(defaults.channels).not.toContain("#admiral-private");
  expect(defaults.channels).toContain("#phoenix");
  const unknownRoles = raw.fleetControl.targets.map(
    ({ role: _role, ...target }) => target,
  );
  expect(
    ircSchema.parse({
      ...raw,
      fleetControl: { ...raw.fleetControl, targets: unknownRoles },
    }).channels,
  ).toEqual(["#discovery", "#command"]);
  expect(
    ircSchema.parse({ ...raw, channels: ["#discovery", "#admiral-private"] })
      .channels,
  ).toContain("#admiral-private");
});

test("derived account and peer defaults retain the schema's length and SASL-name bounds", () => {
  const raw = input();
  const accounts = Array.from({ length: 51 }, (_, index) => `peer${index}`);
  const targets = accounts.map((account) => ({
    id: account,
    account,
    role: "captain",
    channel: "#one-peer-room",
    sessionID: `ses_${account}`,
  }));
  expect(
    ircSchema.safeParse({
      ...raw,
      fleetPolicy: { ...raw.fleetPolicy, agentAccounts: accounts },
      fleetControl: { ...raw.fleetControl, targets },
    }).success,
  ).toBe(false);
  expect(
    ircSchema.safeParse({
      ...raw,
      access: { allowedAccounts: ["jac"] },
      fleetPolicy: { ...raw.fleetPolicy, agentAccounts: accounts },
      fleetControl: { ...raw.fleetControl, targets },
    }).success,
  ).toBe(false);
  expect(
    ircSchema.safeParse({
      ...raw,
      access: { allowedAccounts: ["jac"] },
      fleetPolicy: { ...raw.fleetPolicy, agentAccounts: ["not:valid"] },
      fleetControl: {
        ...raw.fleetControl,
        targets: [{ ...targets[0], id: "bad", account: "not:valid" }],
      },
    }).success,
  ).toBe(false);
});

test("captain and rear-admiral prompts require a recommendation, reason and prior inspection without granting approval", () => {
  for (const account of ["discovery", "vance"]) {
    const config = ircSchema.parse(input(account));
    if (!config.fleetPolicy) throw new Error("Missing policy");
    const guidance = fleetInstructions(config.fleetPolicy);
    expect(guidance).toContain(
      "Every open question must include your recommendation and a short reason",
    );
    expect(guidance).toContain("Inspect the existing code and workflow first");
    expect(guidance).toContain("never invent missing facts");
    expect(guidance).toContain("Never impersonate");
    expect(guidance).toContain("rank grants no human approval authority");
  }
});
