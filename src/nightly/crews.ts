import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "../config";
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

const pluginOptions = z.object({
  namespace: z.string().min(1),
  stateDirectory: z.string().min(1),
  captainDirectory: z.string().min(1),
  worktrees: z.record(z.string(), z.string()),
  captainSessionID: z.string().optional(),
  team: z
    .object({
      crew: z.array(
        z.object({ id: z.string(), backend: z.unknown().optional() }),
      ),
    })
    .optional(),
});
const profile = z.object({
  plugins: z
    .array(z.object({ package: z.string().optional(), options: z.unknown() }))
    .default([]),
});

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
    // or unreadable link is unknown state.
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw unknown();
    }
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(await realpath(path));
    } catch {
      throw unknown();
    }
    if (!info.isFile()) throw unknown();
    return path;
  }
  return undefined;
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
  const parsed = profile.safeParse(raw);
  if (!parsed.success) throw unknown();
  for (const plugin of parsed.data.plugins) {
    if (!looksLikeStargate(plugin.options)) continue;
    const options = pluginOptions.safeParse(plugin.options);
    if (!options.success || !plugin.package) throw unknown();
    return { pluginPackage: plugin.package, options: options.data };
  }
  return undefined;
}

/**
 * Fails closed with `idle-unknown` when a captain or crew profile exists but
 * cannot be read or parsed, or a configured OpenCode crew member has none.
 */
export async function discoverCrews(config: Config): Promise<Crew[]> {
  const crews: Crew[] = [];
  const seen = new Set<string>();
  for (const bot of config.bots) {
    if (bot.backend.type !== "opencode") continue;
    const captainPath = await profilePath(bot.backend.directory);
    if (!captainPath) continue;
    const captain = await readPlugin(captainPath);
    if (!captain || seen.has(captain.options.namespace)) continue;
    seen.add(captain.options.namespace);
    const pi = new Set(
      (captain.options.team?.crew ?? [])
        .filter((member) => member.backend !== undefined)
        .map((member) => member.id),
    );
    const roots: CrewRoot[] = [
      {
        directory: bot.backend.directory,
        configPath: captainPath,
        pluginPackage: captain.pluginPackage,
      },
    ];
    for (const [id, directory] of Object.entries(captain.options.worktrees)) {
      if (pi.has(id)) continue;
      const path = await profilePath(directory);
      const plugin = path ? await readPlugin(path) : undefined;
      if (!path || !plugin) throw unknown();
      roots.push({
        directory,
        configPath: path,
        pluginPackage: plugin.pluginPackage,
      });
    }
    const pin = captain.options.captainSessionID ?? bot.backend.sessionID;
    crews.push({
      namespace: captain.options.namespace,
      captainDirectory: captain.options.captainDirectory,
      stateDirectory: captain.options.stateDirectory,
      roots,
      worktreeDirectories: Object.values(captain.options.worktrees),
      piMembers: [...pi],
      ...(pin ? { captainSessionID: pin } : {}),
    });
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
