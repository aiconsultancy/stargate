import { FleetError, type FleetRequest } from "./protocol";

export type FleetPermissionRule = {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
};
type FleetAction =
  | "fleet_verify_instruction"
  | "fleet_dispatch"
  | "fleet_status";
const actions: readonly FleetAction[] = [
  "fleet_verify_instruction",
  "fleet_dispatch",
  "fleet_status",
];

// Deliberately smaller than a general native glob language. Punctuation that
// could introduce a regex, character class, alternation, negation or escaping
// is rejected. '*' is supported only alone or after one literal prefix.
const literal = /^[A-Za-z0-9_./:@%#=-]+$/;
type Pattern = { kind: "exact" | "prefix"; text: string };
function pattern(value: string): Pattern | undefined {
  if (value === "*") return { kind: "prefix", text: "" };
  if (literal.test(value)) return { kind: "exact", text: value };
  if (value.endsWith("*") && literal.test(value.slice(0, -1)))
    return { kind: "prefix", text: value.slice(0, -1) };
  return;
}
function matches(value: string, rule: Pattern) {
  return rule.kind === "exact"
    ? value === rule.text
    : value.startsWith(rule.text);
}
function potentiallyFleet(value: string) {
  const supported = pattern(value);
  if (supported) return actions.some((action) => matches(action, supported));
  // An unsupported expression can contain alternatives or negation: its
  // apparent leading namespace proves nothing. Only supported exact/prefix
  // patterns (for example subspace_*) can establish disjoint action scope.
  return true;
}

/** Validate root-controlled policy before opening an IPC listener. */
export function validateFleetPermissions(
  rules: readonly FleetPermissionRule[],
): void {
  for (const rule of rules) {
    if (!potentiallyFleet(rule.action)) continue;
    if (!pattern(rule.action) || !pattern(rule.resource))
      throw new FleetError(
        "Fleet IPC permissions support only exact literals, '*' or a literal prefix followed by '*'.",
      );
    if (rule.effect === "ask")
      throw new FleetError(
        "Fleet IPC does not support ask permissions; configure an explicit allow or deny.",
      );
    if (rule.effect !== "allow" && rule.effect !== "deny")
      throw new FleetError("Invalid fleet IPC permission effect.");
  }
}

export function fleetRequestAction(request: FleetRequest): {
  action: FleetAction;
  resource: string;
} {
  switch (request.operation) {
    case "verify":
      return {
        action: "fleet_verify_instruction",
        resource: request.input.reference,
      };
    case "dispatch":
      return { action: "fleet_dispatch", resource: request.input.target };
    case "status":
      return {
        action: "fleet_status",
        resource: request.input.requestID ?? "fleet",
      };
  }
}

/** Last matching rule wins. Missing, invalid and ask policies fail closed. */
export function fleetRequestAllowed(
  rules: readonly FleetPermissionRule[],
  request: FleetRequest,
): boolean {
  try {
    validateFleetPermissions(rules);
    const { action, resource } = fleetRequestAction(request);
    let allowed = false;
    for (const rule of rules) {
      if (!potentiallyFleet(rule.action)) continue;
      const actionPattern = pattern(rule.action);
      const resourcePattern = pattern(rule.resource);
      if (
        actionPattern &&
        resourcePattern &&
        matches(action, actionPattern) &&
        matches(resource, resourcePattern)
      )
        allowed = rule.effect === "allow";
    }
    return allowed;
  } catch {
    return false;
  }
}
