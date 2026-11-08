import { z } from "zod";
import { piDurableBackendSchema } from "../config";

export const agentIDSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export function agentIDForName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
const agentSchema = z.strictObject({
  id: agentIDSchema,
  agent: agentIDSchema.optional(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[^\r\n\0]+$/)
    .optional(),
  model: z
    .string()
    .regex(/^[^/\s#]+\/[^\s#]+(?:#[^\s#]+)?$/)
    .optional(),
  instructions: z.string().trim().min(1).max(64000).optional(),
});
const historyAPISchema = z.strictObject({
  url: z.url().refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
    );
  }),
  headersEnv: z
    .record(
      z.string().regex(/^[a-zA-Z0-9-]+$/),
      z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    )
    .optional(),
});
export const teamSchema = z
  .strictObject({
    captain: agentSchema,
    historyScope: z.enum(["team", "project", "server"]).optional(),
    toolAccess: z.enum(["curated", "direct"]).optional(),
    historyAPI: historyAPISchema.optional(),
    modelProviders: z.array(z.string().min(1).max(100)).min(1).optional(),
    crew: z
      .array(
        agentSchema.extend({
          role: z.string().trim().min(1).max(1000),
          permissionProfile: z.enum(["coding", "research"]),
          backend: piDurableBackendSchema.omit({ directory: true }).optional(),
        }),
      )
      .min(1),
  })
  .superRefine((team, context) => {
    for (const [index, agent] of [team.captain, ...team.crew].entries()) {
      if (agent.name && agent.id !== agentIDForName(agent.name))
        context.addIssue({
          code: "custom",
          path: index === 0 ? ["captain", "id"] : ["crew", index - 1, "id"],
          message:
            "Agent IDs must match assigned names; hidden legacy aliases are not allowed.",
        });
    }
    if (team.captain.id === "all")
      context.addIssue({
        code: "custom",
        path: ["captain", "id"],
        message: "Captain ID collides with a reserved alias.",
      });
    const ids = new Set([team.captain.id, "captain", "all"]);
    const agents = [team.captain, ...team.crew].map(
      (member) => member.agent ?? member.id,
    );
    if (new Set(agents).size !== agents.length)
      context.addIssue({
        code: "custom",
        message: "Native agent definitions must be distinct within a team.",
      });
    for (const [index, member] of team.crew.entries()) {
      if (ids.has(member.id)) {
        context.addIssue({
          code: "custom",
          path: ["crew", index, "id"],
          message: "Crew IDs must be unique and distinct from the captain.",
        });
      }
      if (member.backend) {
        if (member.model)
          context.addIssue({
            code: "custom",
            path: ["crew", index, "model"],
            message: "Pi workers select their model in backend.model.",
          });
      }
      ids.add(member.id);
    }
  });
export type Team = z.infer<typeof teamSchema>;
export type CrewMember = Team["crew"][number];
export type PermissionProfile = "captain" | CrewMember["permissionProfile"];

/** Definition IDs and filenames are ship-role-name; no runtime alias registry. */
export function profileTeam(team: Team, ship: string): Team {
  const qualify = <T extends Team["captain"]>(
    agent: T,
    role: "captain" | "crew",
  ): T => {
    return {
      ...agent,
      agent: agent.agent ?? agentIDSchema.parse(`${ship}-${role}-${agent.id}`),
    };
  };
  return teamSchema.parse({
    ...team,
    captain: qualify(team.captain, "captain"),
    crew: team.crew.map((member) => qualify(member, "crew")),
  });
}
export const defaultModelProviders = [
  "openai-proxy",
  "claude-proxy",
  "go-proxy",
];

/** Optional starter roster, never the runtime's authority or identity list. */
export const defaultTeam: Team = teamSchema.parse({
  captain: { id: "bowser", name: "Bowser" },
  crew: [
    {
      id: "mario",
      name: "Mario",
      role: "Backend and general implementation",
      permissionProfile: "coding",
    },
    {
      id: "luigi",
      name: "Luigi",
      role: "Frontend and integration implementation",
      permissionProfile: "coding",
    },
    {
      id: "daisy",
      name: "Daisy",
      role: "Documentation and Linear research; assigned ticket updates/comments",
      permissionProfile: "research",
    },
    {
      id: "toad",
      name: "Toad",
      role: "Verification and review",
      permissionProfile: "coding",
    },
  ],
});
