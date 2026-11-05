export const crewNames = ["mario", "luigi", "daisy", "toad"] as const;
export type CrewName = (typeof crewNames)[number];
export type CrewRole = "bowser" | CrewName;

type Rule = {
  action: string;
  resource: string;
  effect: "allow" | "deny";
};

const allow = (action: string, resource = "*"): Rule => ({
  action,
  resource,
  effect: "allow",
});

/** Session-scoped rules also constrain a crew member's child sub-agents. */
export function crewPermissions(role: CrewRole): Rule[] {
  const rules: Rule[] = [
    { action: "*", resource: "*", effect: "deny" },
    ...["read", "glob", "grep", "skill", "webfetch", "websearch"].map(
      (action) => allow(action),
    ),
    allow("external_directory"),
    allow("pogo_crew"),
    allow("pogo_mail"),
  ];
  if (role !== "bowser") {
    rules.push(allow("subagent"));
  }
  if (role !== "bowser" && role !== "daisy") {
    rules.push(allow("edit"), allow("shell"), allow("browser"));
  }
  // Daisy receives Linear's read-only tools directly, without arbitrary
  // Code Mode fetch. Session-scoped rules also constrain her child agents.
  if (role !== "daisy") rules.push(allow("execute"));
  for (const operation of ["get", "list", "search", "fetch"]) {
    rules.push(allow(`*linear*_${operation}*`));
  }
  for (const resource of ["*.env", "*.env.*", "*.key", "*.pem"]) {
    rules.push({ action: "read", resource, effect: "deny" });
  }
  return rules;
}
