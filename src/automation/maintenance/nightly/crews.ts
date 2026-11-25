import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { Result, Schema } from "effect";
import type { Config } from "../../../config";
import {
  settingsDefault,
  settingsPlainRecord,
} from "../../../config/settings-schema";
import { effectProjectKeySchema } from "../../../coordination/crew/protocol/project-key";
import { StepError } from "./exec";

/**
 * One OpenCode location that loads the Stargate crew plugin: the captain
 * workspace or an OpenCode crew worktree. Discovered from the gateway's
 * OpenCode bots and their generated profile, so no second roster exists.
 */
export type CrewRoot = {
  directory: string;
  /** Generated opencode.json for this location. */
  configPath: string;
  /** Plugin `package` path that OpenCode must report as active. */
  pluginPackage: string;
};

export type Crew = {
  namespace: string;
  captainDirectory: string;
  stateDirectory: string;
  roots: CrewRoot[];
  /** Every permanent worker directory, including Pi workers without a plugin. */
  worktreeDirectories?: string[];
  /** Pi crew IDs; their task state lives under `<state>/pi/<sha256(id)>`. */
  piMembers: string[];
  /** The pinned captain session: the plugin's own pin, else the bot's. */
  captainSessionID?: string;
};

const nonEmpty = Schema.String.check(Schema.isMinCodePoints(1));
const directories = settingsPlainRecord(Schema.String, Schema.String);

const crewMember = Schema.Struct({
  id: Schema.String,
  backend: Schema.optional(Schema.Unknown),
});

const decodePluginOptions = Schema.decodeUnknownResult(
  Schema.Struct({
    namespace: nonEmpty,
    stateDirectory: nonEmpty,
    captainDirectory: nonEmpty,
    worktrees: directories,
    captainSessionID: Schema.optional(Schema.String),
    projects: Schema.optional(Schema.Unknown),
    team: Schema.optional(Schema.Struct({ crew: Schema.Array(crewMember) })),
  }),
);

const decodeProfile = Schema.decodeUnknownResult(
  Schema.Struct({
    plugins: Schema.Array(
      Schema.Struct({
        package: Schema.optional(Schema.String),
        options: Schema.Unknown,
      }),
    ).pipe(settingsDefault([])),
  }),
);

const decodeProjects = Schema.decodeUnknownResult(
  settingsPlainRecord(
    effectProjectKeySchema,
    Schema.Struct({ worktrees: directories }),
  ),
);

const unknown = () => new StepError("idle-unknown");

/**
 * Canonical `.agents/opco` first, then the `.opencode` compatibility path.
 * Symlinks are followed. Only a missing file means "no profile"; any other
 * failure is unknown state, which the idle gate treats as busy.
 */
export async function profilePath(directory: string) {
  for (const relative of [".agents/opco", ".opencode"]) {
    const path = join(directory, relative, "opencode.json");

    // Only a path that does not exist at all is "no profile"; a dangling
    // Or unreadable link is unknown state.
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }

      throw unknown();
    }

    let info: Awaited<ReturnType<typeof stat>>;

    try {
      info = await stat(await realpath(path));
    } catch {
      throw unknown();
    }

    if (!info.isFile()) {
      throw unknown();
    }

    return path;
  }

  return;
}

const looksLikeStargate = (options: unknown) =>
  typeof options === "object" &&
  options !== null &&
  ["namespace", "stateDirectory", "worktrees", "captainDirectory"].some(
    (key) => key in options,
  );

/** The Stargate crew plugin entry, or undefined when the profile has none. */
async function readPlugin(path: string) {
  let raw: unknown;

  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw unknown();
  }

  const parsed = decodeProfile(raw);

  if (Result.isFailure(parsed)) {
    throw unknown();
  }

  for (const plugin of parsed.success.plugins) {
    if (!looksLikeStargate(plugin.options)) {
      continue;
    }

    const options = decodePluginOptions(plugin.options);

    if (Result.isFailure(options) || !plugin.package) {
      throw unknown();
    }

    return { pluginPackage: plugin.package, options: options.success };
  }

  return;
}

/**
 * Fails closed with `idle-unknown` when a captain or crew profile exists but
 * cannot be read or parsed, or a configured OpenCode crew member has none.
 */
export async function discoverCrews(
  config: Config,
  draining = false,
): Promise<Crew[]> {
  const crews: Crew[] = [];
  const seen = new Set<string>();

  for (const bot of draining
    ? [...config.bots, ...(config.teams ?? []), ...(config.irc ?? [])]
    : config.bots) {
    if (bot.backend.type !== "opencode") {
      continue;
    }

    const captainPath = await profilePath(bot.backend.directory);

    if (!captainPath) {
      continue;
    }

    const captain = await readPlugin(captainPath);

    if (!captain || seen.has(captain.options.namespace)) {
      continue;
    }

    seen.add(captain.options.namespace);

    const pi = new Set(
      (captain.options.team?.crew ?? [])
        .filter((member) => member.backend !== undefined)
        .map((member) => member.id),
    );

    const contexts = [
      {
        namespace: captain.options.namespace,
        stateDirectory: captain.options.stateDirectory,
        worktrees: captain.options.worktrees,
      },
    ];

    if (draining && captain.options.projects !== undefined) {
      const parsed = decodeProjects(captain.options.projects);

      if (Result.isFailure(parsed)) {
        throw unknown();
      }

      for (const [key, project] of Object.entries(parsed.success)) {
        contexts.push({
          namespace: `${captain.options.namespace}:project:${key}`,
          stateDirectory: join(captain.options.stateDirectory, "projects", key),
          worktrees: project.worktrees,
        });
      }
    }

    for (const context of contexts) {
      const roots: CrewRoot[] = [
        {
          directory: bot.backend.directory,
          configPath: captainPath,
          pluginPackage: captain.pluginPackage,
        },
      ];

      for (const [id, directory] of Object.entries(context.worktrees)) {
        if (pi.has(id)) {
          continue;
        }

        const path = await profilePath(directory);
        const plugin = path ? await readPlugin(path) : undefined;

        if (!path || !plugin) {
          throw unknown();
        }

        roots.push({
          directory,
          configPath: path,
          pluginPackage: plugin.pluginPackage,
        });
      }

      const pin = captain.options.captainSessionID ?? bot.backend.sessionID;
      crews.push({
        namespace: context.namespace,
        captainDirectory: captain.options.captainDirectory,
        stateDirectory: context.stateDirectory,
        roots,
        worktreeDirectories: Object.values(context.worktrees),
        piMembers: [...pi],
        ...(pin && { captainSessionID: pin }),
      });
    }
  }

  return crews;
}

export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function crewDatabase(crew: Crew) {
  return join(crew.stateDirectory, `crew-${sha256(crew.namespace)}.sqlite`);
}

export function piDatabase(crew: Crew, member: string) {
  return join(crew.stateDirectory, "pi", sha256(member), "pi.sqlite");
}
