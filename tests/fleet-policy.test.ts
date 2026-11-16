import { expect, test } from "bun:test";
import { sourceLine } from "../src/backend";
import { configSchema, ircSchema } from "../src/config";
import {
  fleetAuthority,
  fleetInstructions,
  fleetPermissions,
  fleetPolicySchema,
} from "../src/fleet-policy";
import { parseMessage } from "../src/irc/protocol";
import { type IrcMember, routeIrcMessage } from "../src/irc/routing";

const policy = fleetPolicySchema.parse({
  role: "rear_admiral",
  humanAccounts: ["operator"],
  agentAccounts: ["captain"],
  assignedCheckout: "/srv/assigned",
  capabilities: ["read_code", "subspace", "dispatch"],
});
test("fleet controls are explicit and preserve human authority", () => {
  expect(fleetAuthority(policy, "OPERATOR")).toBe("human");
  expect(fleetAuthority(policy, "captain")).toBe("agent");
  expect(fleetAuthority(policy, "outsider")).toBe("context");
  expect(
    fleetPolicySchema.safeParse({ ...policy, agentAccounts: ["Operator"] })
      .success,
  ).toBe(false);
  expect(fleetInstructions(policy)).toContain(
    "MUST use your assigned checkout: /srv/assigned",
  );
  expect(fleetInstructions(policy)).toContain(
    "rank grants no human approval authority",
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
      config: ircSchema.parse(input),
      member,
    }),
  ).toBeUndefined();
  const enabled = ircSchema.parse({
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
    ircSchema.safeParse({ ...input, access: { wakeChannels: ["#other"] } })
      .success,
  ).toBe(false);
  expect(configSchema.parse({ irc: [input] }).teams).toEqual([]);
});
