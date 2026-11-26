import { Schema } from "effect";
import { piCrewBackendSchema } from "../../backends/pi/config";
import { isLocalhost } from "../../lib/loopback";
import { decodeSettings } from "../../config/settings-errors";
import { crewTaskTextLimit } from "../../shared/crew-status";
import {
  settingsCheck,
  settingsPattern,
  settingsRecord,
  settingsRefine,
  settingsStruct,
  settingsURL,
} from "../../config/settings-schema";

export const agentIDSchema = Schema.String.check(
  settingsPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/),
);

export function agentIDForName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const agentFields = {
  id: agentIDSchema,
  agent: Schema.optional(agentIDSchema),
  name: Schema.optional(
    Schema.Trim.check(
      Schema.isMinCodePoints(1),
      Schema.isMaxCodePoints(100),
      settingsPattern(/^[^\r\n\0]+$/),
    ),
  ),
  model: Schema.optional(
    Schema.String.check(settingsPattern(/^[^/\s#]+\/[^\s#]+(?:#[^\s#]+)?$/)),
  ),
  instructions: Schema.optional(
    Schema.Trim.check(
      Schema.isMinCodePoints(1),
      Schema.isMaxCodePoints(crewTaskTextLimit),
    ),
  ),
};

const agentSchema = settingsStruct(agentFields);

const historyAPISchema = settingsStruct({
  url: settingsURL.check(
    settingsRefine(
      (value) => {
        const url = new URL(value);

        return (
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (url.protocol === "https:" ||
            (url.protocol === "http:" && isLocalhost(url.hostname)))
        );
      },
      { message: "Invalid input" },
    ),
  ),
  headersEnv: Schema.optional(
    settingsRecord(
      Schema.String.check(settingsPattern(/^[a-zA-Z0-9-]+$/)),
      Schema.String.check(settingsPattern(/^[A-Z_][A-Z0-9_]*$/)),
    ),
  ),
});

export const teamSchema = settingsStruct({
  captain: agentSchema,
  historyScope: Schema.optional(Schema.Literals(["team", "project", "server"])),
  toolAccess: Schema.optional(Schema.Literals(["curated", "direct"])),
  historyAPI: Schema.optional(historyAPISchema),
  questionGateway: Schema.optional(Schema.Boolean),
  modelProviders: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.String.check(
          Schema.isMinCodePoints(1),
          Schema.isMaxCodePoints(100),
        ),
      ),
    ).check(Schema.isMinLength(1)),
  ),
  crew: Schema.mutable(
    Schema.Array(
      settingsStruct({
        ...agentFields,
        role: Schema.Trim.check(
          Schema.isMinCodePoints(1),
          Schema.isMaxCodePoints(1000),
        ),
        permissionProfile: Schema.Literals(["coding", "research"]),
        backend: Schema.optional(piCrewBackendSchema),
      }),
    ),
  ).check(Schema.isMinLength(1)),
}).check(
  settingsCheck((team, context) => {
    // A captain is an officer, whose name is its ID.
    // A crew name is only what people see; the ID keys all crew state.
    if (
      team.captain.name &&
      team.captain.id !== agentIDForName(team.captain.name)
    ) {
      context.addIssue({
        code: "custom",
        path: ["captain", "id"],
        message:
          "The captain's ID must match its name; only crew names may differ from their IDs.",
      });
    }

    if (team.captain.id === "all") {
      context.addIssue({
        code: "custom",
        path: ["captain", "id"],
        message: "Captain ID collides with a reserved alias.",
      });
    }

    const ids = new Set([team.captain.id, "captain", "all"]);

    const agents = [team.captain, ...team.crew].map(
      (member) => member.agent ?? member.id,
    );

    if (new Set(agents).size !== agents.length) {
      context.addIssue({
        code: "custom",
        message: "Native agent definitions must be distinct within a team.",
      });
    }

    for (const [index, member] of team.crew.entries()) {
      if (ids.has(member.id)) {
        context.addIssue({
          code: "custom",
          path: ["crew", index, "id"],
          message: "Crew IDs must be unique and distinct from the captain.",
        });
      }

      if (member.backend) {
        if (member.model) {
          context.addIssue({
            code: "custom",
            path: ["crew", index, "model"],
            message: "Pi workers select their model in backend.model.",
          });
        }
      }

      ids.add(member.id);
    }

    // Ignoring case, a name is no other member's name or ID or a reserved alias.
    const members = [team.captain, ...team.crew];

    const owners = new Map([
      ["captain", -1],
      ["all", -1],
    ]);

    for (const [index, member] of members.entries()) {
      owners.set(member.id, index);
    }

    for (const [index, member] of members.entries()) {
      const name = member.name?.toLowerCase();

      if (name === undefined) {
        continue;
      }

      if ((owners.get(name) ?? index) === index) {
        owners.set(name, index);
      } else {
        context.addIssue({
          code: "custom",
          path: index === 0 ? ["captain", "name"] : ["crew", index - 1, "name"],
          message:
            "Crew names must be unique, ignoring case, and differ from the captain's name, every other member's ID, captain and all.",
        });
      }
    }
  }),
);

export type Team = typeof teamSchema.Type;

export type CrewMember = Team["crew"][number];

export type PermissionProfile = "captain" | CrewMember["permissionProfile"];

/** Definition IDs and filenames are ship-role-ID; no runtime alias registry. */
export function profileTeam(team: Team, ship: string): Team {
  const qualify = <T extends Team["captain"]>(
    agent: T,
    role: "captain" | "crew",
  ): T => {
    return {
      ...agent,
      agent:
        agent.agent ??
        decodeSettings(agentIDSchema, `${ship}-${role}-${agent.id}`),
    };
  };

  return decodeSettings(teamSchema, {
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
export const defaultTeam: Team = Schema.decodeUnknownSync(teamSchema)({
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
