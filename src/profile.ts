import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { crewPermissions } from "./crew/policy";
import { defaultModelProviders, defaultTeam, teamSchema } from "./crew/team";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const absolute = z
  .string()
  .refine(isAbsolute)
  .refine((path) => !/[\r\n\0]/.test(path));
const optionsSchema = z.strictObject({
  directory: absolute,
  projectDirectory: absolute,
  worktreeDirectory: absolute,
  namespace: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
    .optional(),
  team: teamSchema.default(defaultTeam),
  base: z
    .string()
    .min(1)
    .refine((base) => !base.startsWith("-"))
    .default("origin/main"),
  mesijCommand: absolute,
  proxyURL: z.url().default("http://127.0.0.1:8317/v1"),
  apiKeyReference: z
    .string()
    .regex(/^\{(?:env:[A-Z_][A-Z0-9_]*|file:[^\r\n{}]+)\}$/)
    .default("{env:CLIPROXYAPI_API_KEY}"),
});
type Options = z.input<typeof optionsSchema>;
const document = z.record(z.string(), z.unknown());
const templateSchema = z
  .object({
    model: z.string(),
    compaction: document,
    experimental: document,
    providers: z.record(z.string(), document),
  })
  .passthrough();

function parseOptions(input: Options) {
  const parsed = optionsSchema.safeParse(input);
  if (!parsed.success)
    throw new Error(
      "Invalid profile paths, team, namespace, proxy URL, or credential reference.",
    );
  const options = {
    ...parsed.data,
    namespace: parsed.data.namespace ?? parsed.data.team.captain.id,
  };
  const proxy = new URL(options.proxyURL);
  if (
    !["http:", "https:"].includes(proxy.protocol) ||
    proxy.username ||
    proxy.password
  ) {
    throw new Error("Proxy URL must be HTTP(S), without credentials.");
  }
  if (
    options.directory === options.worktreeDirectory ||
    options.worktreeDirectory.startsWith(`${options.directory}/`) ||
    options.team.crew.some(({ id }) => {
      const worker = join(options.worktreeDirectory, id);
      return (
        options.directory === worker ||
        options.directory.startsWith(`${worker}/`)
      );
    })
  ) {
    throw new Error(
      "Captain and crew configuration trees must be distinct and non-nested.",
    );
  }
  return options;
}

export async function renderProfile(input: Options, role: string) {
  const options = parseOptions(input);
  const captain = role === options.team.captain.id;
  const member = options.team.crew.find((member) => member.id === role);
  if (member?.backend)
    throw new Error("Pi workers do not use OpenCode agent profiles.");
  const agent = captain ? options.team.captain : member;
  if (!agent) throw new Error("Agent does not belong to the configured team.");
  const profile = captain ? "captain" : member?.permissionProfile;
  if (!profile) throw new Error("Missing team permission profile.");
  const config = await Bun.file(
    join(packageDirectory, "templates", "opencode.json"),
  ).json();
  // The template is project-owned; untrusted inputs are validated above.
  const parsed = templateSchema.parse(config);
  const providers = parsed.providers;
  for (const provider of Object.values(providers)) {
    provider["settings"] = {
      ...document.parse(provider["settings"]),
      baseURL: options.proxyURL,
      apiKey: options.apiKeyReference,
    };
  }
  const worktrees = Object.fromEntries(
    options.team.crew.map(({ id }) => [
      id,
      join(options.worktreeDirectory, id),
    ]),
  );
  return {
    ...parsed,
    providers,
    default_agent: role,
    agents: {
      [agent.id]: {
        ...(agent.model ? { model: agent.model } : {}),
        permissions: crewPermissions(profile),
      },
    },
    plugins: [
      {
        package: packageDirectory,
        options: {
          namespace: options.namespace,
          team: options.team,
          captainDirectory: options.directory,
          stateDirectory: join(options.directory, ".local", "pogo-crew"),
          projectDirectory: options.projectDirectory,
          worktrees,
          mesijCommand: options.mesijCommand,
        },
      },
    ],
  };
}

function git(directory: string, ...args: string[]) {
  try {
    return execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch {
    throw new Error(
      "Profile Git operation failed. Check the repository, base ref, branch collisions, and worktree paths; no existing work was removed.",
    );
  }
}

async function present(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Cannot inspect profile destination.");
  }
}

async function writeNewOrSame(path: string, text: string) {
  const info = await present(path);
  if (info) {
    if (!info.isFile() || (await readFile(path, "utf8")) !== text) {
      throw new Error(`Refusing to overwrite existing profile file: ${path}`);
    }
    return;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(text);
  } finally {
    await file.close();
  }
}

async function configDirectory(directory: string) {
  const canonical = join(directory, ".agents", "opco");
  const compatible = join(directory, ".opencode");
  if (await present(canonical)) {
    if (!(await lstat(canonical)).isDirectory())
      throw new Error("Canonical OpenCode directory must be a directory.");
    if (await present(compatible)) {
      if (
        !(await lstat(compatible)).isSymbolicLink() ||
        (await realpath(compatible)) !== (await realpath(canonical))
      ) {
        throw new Error(
          "Existing .opencode path conflicts with canonical .agents/opco.",
        );
      }
    } else await symlink(".agents/opco", compatible);
    return canonical;
  }
  const info = await present(compatible);
  if (info && !info.isDirectory())
    throw new Error("Refusing an unrelated .opencode symlink or file.");
  await mkdir(compatible, { recursive: true, mode: 0o700 });
  return compatible;
}

async function excludeGenerated(
  project: string,
  agentIDs: string[],
  compatibilitySymlink = false,
) {
  const common = resolve(
    project,
    git(project, "rev-parse", "--git-common-dir"),
  );
  const path = join(common, "info", "exclude");
  const info = await present(path);
  if (info && !info.isFile())
    throw new Error("Git excludes must be a regular file.");
  const previous = info ? await readFile(path, "utf8") : "";
  const patterns = ["/.opencode/opencode.json", "/.agents/opco/opencode.json"];
  // Ignore compatibility symlinks, not unrelated source .opencode directories.
  if (compatibilitySymlink) patterns.push("/.opencode", "!/.opencode/");
  for (const role of agentIDs) {
    patterns.push(
      `/.opencode/agents/${role}.md`,
      `/.agents/opco/agents/${role}.md`,
    );
  }
  const missing = patterns.filter(
    (pattern) => !previous.split("\n").includes(pattern),
  );
  if (!missing.length) return;
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "a", 0o600);
  try {
    await file.writeFile(
      `${previous && !previous.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
    );
  } finally {
    await file.close();
  }
}

export async function initializeProfile(input: Options) {
  const options = parseOptions(input);
  const sourceCommon = await realpath(
    resolve(
      options.projectDirectory,
      git(options.projectDirectory, "rev-parse", "--git-common-dir"),
    ),
  );
  const base = git(
    options.projectDirectory,
    "rev-parse",
    "--verify",
    `${options.base}^{commit}`,
  );
  const worktrees = Object.fromEntries(
    options.team.crew.map(({ id }) => [
      id,
      join(options.worktreeDirectory, id),
    ]),
  );
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const state = join(options.directory, ".local", "pogo-crew");
  await mkdir(state, { recursive: true, mode: 0o700 });
  if (((await lstat(state)).mode & 0o077) !== 0)
    throw new Error("Crew state directory must be private (0700).");
  const agents = [options.team.captain, ...options.team.crew];
  await excludeGenerated(
    options.projectDirectory,
    agents.map(({ id }) => id),
  );
  const legacy = JSON.stringify(options.team) === JSON.stringify(defaultTeam);
  for (const agent of agents) {
    const role = agent.id;
    const captain = role === options.team.captain.id;
    const member = options.team.crew.find((member) => member.id === role);
    const directory = captain ? options.directory : worktrees[role];
    if (!directory) throw new Error("Missing crew directory.");
    if (!captain) {
      const info = await present(directory);
      if (info && !info.isDirectory())
        throw new Error(
          "Existing crew path must be a real worktree directory, not a symlink or file.",
        );
      if (!info) {
        await mkdir(options.worktreeDirectory, {
          recursive: true,
          mode: 0o700,
        });
        git(
          options.projectDirectory,
          "worktree",
          "add",
          "-b",
          `crew/${options.namespace}-${role}`,
          directory,
          base,
        );
      }
      const common = await realpath(
        resolve(directory, git(directory, "rev-parse", "--git-common-dir")),
      );
      const branch = git(directory, "branch", "--show-current");
      if (
        common !== sourceCommon ||
        !branch ||
        ["main", "master"].includes(branch)
      ) {
        throw new Error(
          "Existing crew worktree must belong to this project and use a non-main feature branch.",
        );
      }
    }
    if (member?.backend) continue;
    const configPath = await configDirectory(directory);
    if (!captain && configPath === join(directory, ".agents", "opco")) {
      await excludeGenerated(options.projectDirectory, [], true);
    }
    // Never hide a replacement of tracked Indra configuration as local setup.
    if (!captain) {
      const relative = configPath.slice(directory.length + 1);
      if (
        git(
          directory,
          "ls-files",
          "--",
          `${relative}/opencode.json`,
          `${relative}/agents/${role}.md`,
        )
      ) {
        throw new Error(
          "Profile destination contains tracked configuration; use an untracked overlay.",
        );
      }
    }
    const template = await readFile(
      join(
        packageDirectory,
        "templates",
        "agents",
        `${legacy ? role : captain ? "captain" : "crew"}.md`,
      ),
      "utf8",
    );
    const substitutions: Record<string, string> = {
      projectDirectory: options.projectDirectory,
      worktreeDirectory: options.worktreeDirectory,
      namespace: options.namespace,
      historyScope: options.team.historyScope ?? "team",
      modelProviders: (
        options.team.modelProviders ?? defaultModelProviders
      ).join(", "),
      agentID: role,
      agentName: agent.name ?? role,
      captainID: options.team.captain.id,
      captainName: options.team.captain.name ?? options.team.captain.id,
      directory,
      role: member?.role ?? "Captain and Slack coordinator",
      permissionProfile: member?.permissionProfile ?? "captain",
      roster: options.team.crew
        .map(
          (member) =>
            `- ${member.id} (${member.name ?? member.id}): ${member.role}; permissions: ${member.permissionProfile}${member.backend ? "; backend: Pi Durable (dispatch/wait/status only)" : ""}`,
        )
        .join("\n"),
      instructions:
        agent.instructions ??
        "Follow the assigned task and project instructions.",
    };
    const prompt = template.replace(
      /\{\{(\w+)\}\}/g,
      (match, key: string) => substitutions[key] ?? match,
    );
    await writeNewOrSame(join(configPath, "agents", `${role}.md`), prompt);
    await writeNewOrSame(
      join(configPath, "opencode.json"),
      `${JSON.stringify(await renderProfile(options, role), null, 2)}\n`,
    );
  }
  return {
    directory: options.directory,
    worktrees,
    stateDirectory: state,
    namespace: options.namespace,
    agent: options.team.captain.id,
    permissions: crewPermissions("captain"),
  };
}
