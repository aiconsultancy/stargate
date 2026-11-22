import { expect, test } from "bun:test";
import { Result, Schema } from "effect";
import { sourceLine } from "../src/backends/backend";
import { configSchema, ircSchema } from "../src/config";
import {
  fleetAuthority,
  fleetInstructions,
  fleetPermissions,
  fleetPolicySchema,
} from "../src/fleet/fleet-policy";
import { parseMessage } from "../src/irc/protocol";
import {
  type IrcMember,
  ircCrewInstructions,
  ircInstructions,
  routeIrcMessage,
} from "../src/irc/routing";

const policy = Schema.decodeUnknownSync(fleetPolicySchema)({
  role: "rear_admiral",
  humanAccounts: ["operator"],
  agentAccounts: ["captain"],
  assignedCheckout: "/srv/assigned",
  capabilities: ["read_code", "subspace", "dispatch"],
});

test("review native permissions require explicit opt-in and a dispatch-capable captain", () => {
  const captain = { ...policy, role: "captain" as const };
  expect(
    fleetPermissions(captain).some((r) => r.action === "fleet_review"),
  ).toBe(false);
  expect(fleetPermissions(captain, { reviews: true })).toContainEqual({
    action: "fleet_review",
    resource: "*",
    effect: "allow",
  });
  expect(
    fleetPermissions(policy, { reviews: true }).some(
      (r) => r.action === "fleet_review",
    ),
  ).toBe(false);
  expect(
    fleetPermissions(
      { ...captain, capabilities: ["read_code"] },
      { reviews: true },
    ).some((r) => r.action === "fleet_review"),
  ).toBe(false);
});

test("fleet controls are explicit and preserve human authority", () => {
  expect(fleetAuthority(policy, "OPERATOR")).toBe("human");
  expect(fleetAuthority(policy, "captain")).toBe("agent");
  expect(fleetAuthority(policy, "outsider")).toBe("context");
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(fleetPolicySchema)({
        ...policy,
        agentAccounts: ["Operator"],
      }),
    ),
  ).toBe(false);
  expect(fleetInstructions(policy)).toContain(
    "MUST use your assigned checkout: /srv/assigned",
  );
  expect(fleetInstructions(policy)).toContain(
    "rank grants no human approval authority",
  );
  expect(fleetInstructions(policy)).toContain(
    "reviewability, complexity and business risk",
  );
  expect(fleetInstructions(policy)).toContain(
    "Human-only approval and deployment gates still apply.",
  );
  expect(fleetInstructions({ ...policy, role: "captain" })).not.toContain(
    "Recommend PR scope",
  );
  const rules = fleetPermissions(policy);
  expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
  expect(
    rules.some((rule) => rule.action === "shell" && rule.effect === "allow"),
  ).toBe(false);
  expect(
    rules.some(
      (rule) => rule.action === "fleet_dispatch" && rule.effect === "allow",
    ),
  ).toBe(true);
});

test("IRC fleet and profile instructions use one plain pull request reference", () => {
  for (const guidance of [
    fleetInstructions(policy, "irc"),
    ircInstructions,
    ircCrewInstructions,
  ]) {
    expect(guidance).toContain("[PR:owner/repo#number]");
    expect(guidance).toContain("Use one form per reference");
    expect(guidance).not.toContain("An ordinary Markdown link");
  }

  expect(fleetInstructions(policy)).toContain("An ordinary Markdown link");
});

test("authority is separate from source transport and sender rank", () => {
  expect(
    sourceLine({
      source: {
        transport: "teams",
        channel: "chat",
        thread: "root",
        message: "original",
        user: "human",
        authority: "human",
      },
    }),
  ).toBe("s=teams;c=chat;t=root;m=original;u=human;a=human");
  expect(
    sourceLine({
      source: {
        transport: "irc",
        channel: "#ship",
        thread: "root",
        message: "msg",
        user: "captain",
        sender: "captain",
        authority: "agent",
      },
    }),
  ).toContain(";k=captain;a=agent");
});

test("wake channels are opt-in, authenticated and constrained to joined channels", () => {
  const input = {
    id: "test",
    server: { host: "irc.example.invalid", port: 6697, tls: true },
    account: "ship",
    passwordEnv: "IRC_PASSWORD",
    channels: ["#ship"],
    fleetPolicy: policy,
    backend: {
      type: "opencode",
      url: "http://127.0.0.1:4096",
      directory: "/srv/assigned",
    },
  };

  const member: IrcMember = {
    id: "test",
    role: "captain",
    account: "ship",
    nick: "ship",
    channels: ["#ship"],
    key: "key",
  };

  const context = {
    currentNick: "ship",
    now: () => 0,
    fold: (value: string) => value.toLowerCase(),
    sent: () => false,
  };

  const message = parseMessage(
    "@account=operator;msgid=original :person!u@h PRIVMSG #ship :ordinary instruction",
  );

  if (!message) throw new Error("Missing fixture message");
  expect(
    routeIrcMessage(message, {
      ...context,
      config: Schema.decodeUnknownSync(ircSchema)(input),
      member,
    }),
  ).toBeUndefined();

  const enabled = Schema.decodeUnknownSync(ircSchema)({
    ...input,
    access: { wakeChannels: ["#ship"] },
  });

  expect(
    routeIrcMessage(message, { ...context, config: enabled, member })?.user,
  ).toBe("operator");

  const stranger = parseMessage(
    "@account=outsider;msgid=original :person!u@h PRIVMSG #ship :ordinary instruction",
  );

  if (!stranger) throw new Error("Missing fixture message");
  expect(
    routeIrcMessage(stranger, { ...context, config: enabled, member }),
  ).toBeUndefined();
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ircSchema)({
        ...input,
        access: { wakeChannels: ["#other"] },
      }),
    ),
  ).toBe(false);
  expect(
    Schema.decodeUnknownSync(configSchema)({ irc: [input] }).teams,
  ).toEqual([]);
});
