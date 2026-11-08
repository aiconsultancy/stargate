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
export function crewPermissions(
  profile: PermissionProfile,
  access: "curated" | "direct" = "curated",
): Rule[] {
  if (access === "direct") {
    return [
      allow("*"),
      ...["*.env", "*.env.*", "*.key", "*.pem"].map(
        (resource): Rule => ({
          action: "read",
          resource,
          effect: "deny",
        }),
      ),
    ];
  }
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
  rules.push(allow("pogo_model", profile === "captain" ? "*" : "get"));
  // Specialisms guide assignments, not host-tool access in this trusted profile.
  rules.push(
    allow("subagent"),
    allow("edit"),
    allow("shell"),
    allow("browser"),
    allow("execute"),
  );
  rules.push(allow("linear_*"));
  for (const resource of ["*.env", "*.env.*", "*.key", "*.pem"]) {
    rules.push({ action: "read", resource, effect: "deny" });
  }
  return rules;
}
