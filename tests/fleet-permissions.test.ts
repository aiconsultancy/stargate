import { expect, test } from "bun:test";
import {
  type FleetPermissionRule,
  fleetRequestAction,
  fleetRequestAllowed,
  validateFleetPermissions,
} from "../src/coordination/fleet/permissions";
import type { FleetRequest } from "../src/coordination/fleet/protocol";
import { fleetPermissions } from "../src/coordination/fleet/fleet-policy";

const caller = {
  sessionID: "ses_agent",
  agent: "agent",
  messageID: "msg_assistant",
  id: "call_dispatch",
};

const verify: FleetRequest = {
  operation: "verify",
  caller,
  input: { reference: "teams-original" },
};

const dispatch: FleetRequest = {
  operation: "dispatch",
  caller,
  input: {
    target: "captain",
    text: "Read the issue",
    sourceReference: "teams-original",
  },
};

const status: FleetRequest = { operation: "status", caller, input: {} };

const rule = (
  action: string,
  resource: string,
  effect: FleetPermissionRule["effect"] = "allow",
): FleetPermissionRule => ({ action, resource, effect });

test("fleet IPC maps every operation to its native action and exact resource", () => {
  expect(fleetRequestAction(verify)).toEqual({
    action: "fleet_verify_instruction",
    resource: "teams-original",
  });
  expect(fleetRequestAction(dispatch)).toEqual({
    action: "fleet_dispatch",
    resource: "captain",
  });
  expect(fleetRequestAction(status)).toEqual({
    action: "fleet_status",
    resource: "fleet",
  });
  expect(
    fleetRequestAction({ ...status, input: { requestID: "request-1" } }),
  ).toEqual({ action: "fleet_status", resource: "request-1" });
});

test("empty, direct deny and unmatched policies never grant IPC authority", () => {
  expect(fleetRequestAllowed([], dispatch)).toBe(false);
  expect(fleetRequestAllowed([rule("*", "*", "deny")], dispatch)).toBe(false);
  expect(fleetRequestAllowed([rule("fleet_status", "*")], dispatch)).toBe(
    false,
  );
  expect(
    fleetRequestAllowed([rule("fleet_dispatch", "other-captain")], dispatch),
  ).toBe(false);
});

test("exact, wildcard and simple prefix rules follow last-match ordering", () => {
  const base = [rule("*", "*", "deny"), rule("fleet_*", "cap*")];
  expect(fleetRequestAllowed(base, dispatch)).toBe(true);
  expect(fleetRequestAllowed(base, verify)).toBe(false);
  expect(
    fleetRequestAllowed(
      [...base, rule("fleet_dispatch", "captain", "deny")],
      dispatch,
    ),
  ).toBe(false);
  expect(
    fleetRequestAllowed(
      [
        ...base,
        rule("fleet_dispatch", "captain", "deny"),
        rule("fleet_dispatch", "captain"),
      ],
      dispatch,
    ),
  ).toBe(true);
  expect(fleetRequestAllowed([rule("fleet_verify_*", "teams-*")], verify)).toBe(
    true,
  );
  expect(fleetRequestAllowed([rule("fleet_status", "fleet")], status)).toBe(
    true,
  );
});

test("ask rules cannot be bypassed through direct IPC or a later allow", () => {
  for (const action of ["*", "fleet_*", "fleet_dispatch", "fleet_status"])
    expect(() => validateFleetPermissions([rule(action, "*", "ask")])).toThrow(
      "does not support ask",
    );

  const rules = [
    rule("*", "*", "deny"),
    rule("fleet_dispatch", "captain", "ask"),
    rule("fleet_dispatch", "captain"),
  ];

  expect(fleetRequestAllowed(rules, dispatch)).toBe(false);
});

test("unsupported potentially matching action/resource patterns fail closed", () => {
  for (const action of [
    "fleet_**",
    "f?eet_*",
    "[f]leet_*",
    "{fleet_dispatch,fleet_status}",
    "!shell",
    "*dispatch",
    "fleet_(dispatch|status)",
    "subspace_*|fleet_dispatch",
    "stargate_foo|fleet_status",
  ])
    expect(() => validateFleetPermissions([rule(action, "*")])).toThrow(
      "only exact literals",
    );

  for (const resource of [
    "cap?ain",
    "[ct]*",
    "captain/**",
    "*captain",
    "cap\\*",
    "captain*other",
    "",
  ])
    expect(() =>
      validateFleetPermissions([rule("fleet_dispatch", resource)]),
    ).toThrow("only exact literals");
  expect(
    fleetRequestAllowed(
      [rule("*", "*"), rule("fleet_**", "*", "deny")],
      dispatch,
    ),
  ).toBe(false);
});

test("provably separate native tools keep their own ask and resource patterns", () => {
  const rules = [
    rule("subspace_*", "[project]", "ask"),
    rule("stargate_*", "unsupported/**", "ask"),
    rule("read", "*.env", "deny"),
    rule("fleet_dispatch", "captain"),
  ];

  expect(() => validateFleetPermissions(rules)).not.toThrow();
  expect(fleetRequestAllowed(rules, dispatch)).toBe(true);
  expect(fleetRequestAllowed(rules, verify)).toBe(false);
});

test("the selected fleet profile's root policy works without broadening its allows", () => {
  const rules = fleetPermissions({
    role: "rear_admiral",
    humanAccounts: ["human"],
    agentAccounts: ["captain"],
    assignedCheckout: "/workspace/coordinator",
    capabilities: ["read_code", "subspace", "dispatch"],
  });

  expect(() => validateFleetPermissions(rules)).not.toThrow();

  for (const request of [verify, dispatch, status])
    expect(fleetRequestAllowed(rules, request)).toBe(true);

  const restricted = fleetPermissions({
    role: "captain",
    humanAccounts: ["human"],
    agentAccounts: [],
    assignedCheckout: "/workspace/captain",
    capabilities: ["read_code", "subspace", "implement"],
  });

  for (const request of [verify, status])
    expect(fleetRequestAllowed(restricted, request)).toBe(true);
  expect(fleetRequestAllowed(restricted, dispatch)).toBe(false);
});
