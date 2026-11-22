import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, Schema } from "effect";
import { effectiveIrcConfig, ircSchema } from "../src/config";
import { fleetInstructions } from "../src/fleet/fleet-policy";
import { fold, formatMessage, parseMessage } from "../src/irc/protocol";
import {
  type IrcMember,
  ircResultJobAllowed,
  routeIrcMessage,
  withinLimits,
} from "../src/irc/routing";
import { settingsIssues } from "../src/config/settings-schema";
import { addBot, readConfiguration } from "../src/app/setup";

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0))
    await rm(path, { recursive: true, force: true });
});
function effective(input: unknown) {
  return effectiveIrcConfig(Schema.decodeUnknownSync(ircSchema)(input));
}

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
    const config = effective(raw);
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
    expect(config.access.allowedAccounts).toBeUndefined();
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
  const config = effective({
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
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema)({
        ...raw,
        fleetChannels: { home: "#command", command: "#COMMAND" },
      }),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema)({
        ...raw,
        channels: ["#discovery", "#DISCOVERY"],
      }),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema)({
        ...raw,
        audit: { channel: "#phoenix" },
      }),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema)({ ...raw, fleetPolicy: undefined }),
    ),
  ).toBe(false);
});

test("results-mode peer context requires an enrolled explicit current nick and never accepts a reserved dispatch label", () => {
  const config = effective(input("vance"));
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
  for (const text of ["@vance: peer contact", "@vance, peer contact"]) {
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
        count: () => 29,
      }),
    ).toBe(true);
    expect(
      withinLimits(admission, config, {
        shipKeys: [member.key],
        count: () => 30,
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
  const config = effective(legacy);
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
  const defaults = effective(raw);
  expect(defaults.channels).not.toContain("#admiral-private");
  expect(defaults.channels).toContain("#phoenix");
  const unknownRoles = raw.fleetControl.targets.map(
    ({ role: _role, ...target }) => target,
  );
  expect(
    effective({
      ...raw,
      fleetControl: { ...raw.fleetControl, targets: unknownRoles },
    }).channels,
  ).toEqual(["#discovery", "#command"]);
  expect(
    effective({ ...raw, channels: ["#discovery", "#admiral-private"] })
      .channels,
  ).toContain("#admiral-private");
});

test("derived peer defaults retain the schema's length and SASL-name bounds", () => {
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
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema)({
        ...raw,
        fleetPolicy: { ...raw.fleetPolicy, agentAccounts: accounts },
        fleetControl: { ...raw.fleetControl, targets },
      }),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema)({
        ...raw,
        access: { allowedAccounts: ["jac"] },
        fleetPolicy: { ...raw.fleetPolicy, agentAccounts: accounts },
        fleetControl: { ...raw.fleetControl, targets },
      }),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema)({
        ...raw,
        access: { allowedAccounts: ["jac"] },
        fleetPolicy: { ...raw.fleetPolicy, agentAccounts: ["not:valid"] },
        fleetControl: {
          ...raw.fleetControl,
          targets: [{ ...targets[0], id: "bad", account: "not:valid" }],
        },
      }),
    ),
  ).toBe(false);
});

test("captain and rear-admiral prompts require a recommendation, reason and prior inspection without granting approval", () => {
  for (const account of ["discovery", "vance"]) {
    const config = effective(input(account));
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

test("fleet defaults remain runtime-only when addBot saves the parsed configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stargate-fleet-save-"));
  cleanup.push(directory);
  const path = join(directory, "stargate.json");
  await writeFile(path, JSON.stringify({ irc: [input()] }));
  const bot = (id: string) => ({
    id,
    slack: {
      appId: `A${id.toUpperCase()}`,
      appTokenEnv: `${id.toUpperCase()}_APP`,
      botTokenEnv: `${id.toUpperCase()}_BOT`,
    },
    access: { users: ["U123"], channels: ["C123"] },
    backend: {
      type: "opencode",
      url: "http://localhost:4096",
      directory: "/workspace",
    },
  });
  await addBot(path, bot("one"));
  const saved = await readConfiguration(path);
  const config = saved.irc[0];
  if (!config?.fleetPolicy || !config.fleetControl)
    throw new Error("Missing saved fleet");
  expect(config.channels).toEqual(["#discovery"]);
  expect(config.access.peerCaptains).toBeUndefined();
  expect(config.access.allowedAccounts).toBeUndefined();
  expect(config.access.humanWakeChannels).toBeUndefined();
  expect(config.access.channelRequests).toBeUndefined();
  const before = structuredClone(config);
  expect(effectiveIrcConfig(config).channels).toContain("#phoenix");
  expect(config).toEqual(before);
  config.fleetPolicy.humanAccounts.push("newhuman");
  config.fleetControl.targets = config.fleetControl.targets.filter(
    (target) => target.account !== "phoenix",
  );
  await writeFile(path, JSON.stringify(saved));
  await addBot(path, bot("two"));
  const changed = (await readConfiguration(path)).irc[0];
  if (!changed) throw new Error("Missing changed fleet");
  const runtime = effectiveIrcConfig(changed);
  expect(runtime.channels).not.toContain("#phoenix");
  expect(runtime.access.peerCaptains).not.toContain("phoenix");
  expect(runtime.access.allowedAccounts).toBeUndefined();
  expect(runtime.fleetPolicy?.humanAccounts).toContain("newhuman");
  expect(await readFile(path, "utf8")).not.toContain('"peerCaptains"');
});

test("explicit empty peer lists and legacy wake selectors override fleet defaults", () => {
  const config = effective({
    ...input(),
    access: { peerCaptains: [], wakeChannels: ["#phoenix"] },
  });
  expect(config.access.peerCaptains).toEqual([]);
  expect(config.access.wakeChannels).toEqual(["#phoenix"]);
  expect(config.access.humanWakeChannels).toBeUndefined();
  expect(config.access.channelRequests).toBeUndefined();
  const noWake = effective({ ...input(), access: { wakeChannels: [] } });
  expect(noWake.access.humanWakeChannels).toBeUndefined();
  expect(noWake.access.channelRequests).toBeUndefined();
  expect(
    effective({ ...input(), access: { channelRequests: "standard" } }).access
      .channelRequests,
  ).toBe("standard");
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema)({
        ...input(),
        access: {
          wakeChannels: ["#discovery"],
          channelRequests: "nick-mention",
        },
      }),
    ),
  ).toBe(false);
});

test("fleet trust derives only enrolled captains/admirals and excludes own captain/crew accounts", () => {
  const raw = input();
  const targets = [
    ...raw.fleetControl.targets,
    ...["discovery", "owncrew", "othercrew", "unknownrole"].map((name) => ({
      id: name,
      account: name,
      role:
        name === "othercrew"
          ? "crew"
          : name === "unknownrole"
            ? undefined
            : "captain",
      channel: `#${name}-private`,
      sessionID: `ses_${name}`,
    })),
  ];
  const config = effective({
    ...raw,
    crew: [
      {
        id: "own",
        account: "owncrew",
        passwordEnv: "OWN_CREW_PASSWORD",
        channels: ["#discovery"],
        backend: { ...raw.backend, sessionID: undefined },
      },
    ],
    fleetPolicy: {
      ...raw.fleetPolicy,
      agentAccounts: [
        ...raw.fleetPolicy.agentAccounts,
        "discovery",
        "owncrew",
        "othercrew",
        "unknownrole",
      ],
    },
    fleetControl: { ...raw.fleetControl, targets },
  });
  expect(config.access.peerCaptains.sort()).toEqual(
    raw.fleetPolicy.agentAccounts.sort(),
  );
  for (const name of ["discovery", "owncrew", "othercrew", "unknownrole"])
    expect(config.channels).not.toContain(`#${name}-private`);
});

test("derived membership rejects invalid IRC target channels at configuration check", () => {
  const raw = input();
  for (const channel of ["#fleet:alpha", `#${"x".repeat(50)}`]) {
    const targets = raw.fleetControl.targets.map((target) =>
      target.account === "phoenix" ? { ...target, channel } : target,
    );
    const result = Schema.decodeUnknownResult(ircSchema)({
      ...raw,
      fleetControl: { ...raw.fleetControl, targets },
    });
    expect(Result.isSuccess(result)).toBe(false);
    if (!Result.isSuccess(result))
      expect(
        settingsIssues(result.failure.issue).issues.some((issue) =>
          issue.message.includes("valid IRC channel"),
        ),
      ).toBe(true);
  }
});

test("fleet human enrolment does not acquire an implicit 50-account allowlist limit", () => {
  const raw = input();
  const config = effective({
    ...raw,
    fleetPolicy: {
      ...raw.fleetPolicy,
      humanAccounts: Array.from({ length: 55 }, (_, n) => `human${n}`),
    },
  });
  expect(config.access.allowedAccounts).toBeUndefined();
  expect(config.fleetPolicy?.humanAccounts).toHaveLength(55);
});

test("peer leading recipients and captured admission nick survive connection nick changes", () => {
  const config = effective(input("vance"));
  const member: IrcMember = {
    id: "vance",
    key: "vance",
    account: "vance",
    nick: "vance",
    channels: config.channels,
    role: "captain",
  };
  const receive = (text: string, currentNick = "vance", override = config) => {
    const message = parseMessage(
      formatMessage("PRIVMSG", ["#phoenix", text], {
        account: "phoenix",
        bot: "",
        msgid: "peer-stable",
      }),
    );
    if (!message) throw new Error("Invalid fixture");
    return routeIrcMessage(message, {
      config: override,
      member,
      currentNick,
      fold,
      now: () => 1,
      sent: () => false,
      joined: () => true,
    });
  };
  for (const text of [
    "phoenix: ask vance for logs",
    "@phoenix: ask @vance for logs",
    "prometheus, vance should remain quiet",
  ])
    expect(receive(text)).toBeUndefined();
  for (const [accepted, later] of [
    ["vance", "vance_"],
    ["vance_", "vance"],
  ]) {
    const text = `@${accepted}: peer contact`;
    const admitted = receive(text, accepted);
    expect(admitted?.text).toBe(text);
    expect(admitted?.textMention).toBe(`@${accepted}`);
    expect(
      ircResultJobAllowed(config, member, later ?? "", "phoenix", admitted),
    ).toBe(true);
    const denied = {
      ...config,
      access: { ...config.access, peerCaptains: [] },
    };
    expect(
      ircResultJobAllowed(denied, member, later ?? "", "phoenix", admitted),
    ).toBe(false);
  }
  for (const text of [
    "@phoenix @vance: one atomic notice",
    "@phoenix, @vance: one atomic notice",
  ])
    expect(receive(text)).toBeDefined();
  const legacy = {
    ...config,
    access: {
      ...config.access,
      channelRequests: "standard" as const,
      allCallWords: ["vance"],
    },
  };
  const allCall = receive(
    "vance: direct nickname plus configured all-call",
    "vance",
    legacy,
  );
  expect(allCall?.textMention).toBe("@vance");
  // A direct peer request has no channel mention gate. Without a recorded
  // recipient it still needs the actual nick at intake, never an old alias.
  expect(
    ircResultJobAllowed(config, member, "vance_", "phoenix", {
      sender: "captain",
      text: "vance: wrong current recipient",
    }),
  ).toBe(false);
  // An old ordinary text alias cannot fabricate the reserved @nick proof.
  expect(
    ircResultJobAllowed(config, member, "vance", "phoenix", {
      sender: "captain",
      text: "computer ping",
      textMention: "computer",
    }),
  ).toBe(false);
});

test("portable guidance keeps PR and question rules for every role and advertises only configured dispatch capability", () => {
  const policy = effective(input()).fleetPolicy;
  if (!policy) throw new Error("Missing policy");
  for (const role of ["captain", "rear_admiral", "crew"] as const) {
    const readOnly = fleetInstructions({
      ...policy,
      role,
      capabilities: ["read_code"],
    });
    expect(readOnly).not.toContain("fleet_dispatch");
    expect(readOnly).not.toContain("fleet_status");
    expect(readOnly).toContain("Every PR reference must use");
    expect(readOnly).toContain(
      "Every open question must include your recommendation and a short reason",
    );
    const dispatcher = fleetInstructions({
      ...policy,
      role,
      capabilities: ["dispatch"],
    });
    expect(dispatcher).toContain("fleet_dispatch");
    expect(dispatcher).toContain("fleet_status");
  }
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema)({
        ...input(),
        access: { allCallWords: ["@vance"] },
      }),
    ),
  ).toBe(false);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema)({
        ...input(),
        access: { textMentions: ["@vance"] },
      }),
    ),
  ).toBe(false);
});
