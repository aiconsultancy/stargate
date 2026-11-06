import type { PermissionProfile } from "./team";

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
export function crewPermissions(profile: PermissionProfile): Rule[] {
  const rules: Rule[] = [
    { action: "*", resource: "*", effect: "deny" },
    ...["read", "glob", "grep", "skill", "webfetch", "websearch"].map(
      (action) => allow(action),
    ),
    allow("external_directory"),
    allow("pogo_crew"),
    allow("pogo_mail"),
    allow("pogo_history"),
  ];
  if (profile === "captain") rules.push(allow("pogo_model"));
  if (profile !== "captain") {
    rules.push(allow("subagent"));
  }
  if (profile === "coding") {
    rules.push(allow("edit"), allow("shell"), allow("browser"));
  }
  // Researchers receive the user's global Linear tools without arbitrary
  // Code Mode fetch. Session-scoped rules also constrain her child agents.
  if (profile !== "research") rules.push(allow("execute"));
  rules.push(allow("linear_*"));
  for (const resource of ["*.env", "*.env.*", "*.key", "*.pem"]) {
    rules.push({ action: "read", resource, effect: "deny" });
  }
  return rules;
}
