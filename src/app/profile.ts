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
import { Result, Schema } from "effect";
import {
  managedPrompt,
  piDefinitionPath,
  piMemberDefinition,
} from "../coordination/crew/instructions";
import { crewPermissions } from "../coordination/crew/execution/policy";
import {
  defaultModelProviders,
  defaultTeam,
  profileTeam,
  teamSchema,
} from "../coordination/crew/team";
import {
  ircCrewInstructions,
  ircInstructions,
} from "../transports/irc/routing";
import {
  installationDirectory,
  templatesDirectory,
} from "../lib/installation-paths";
import { textMentionInstructions } from "../shared/mentions";
import {
  nightlyInstructions,
  nightlyWindowSchema,
} from "../automation/maintenance/nightly/instructions";
import { peerInstructions } from "../gateway/peers";
import { reactionInstructions } from "../shared/reactions";
import {
  settingsDefault,
  settingsPattern,
  settingsRecord,
  settingsRefine,
  settingsStruct,
  settingsURL,
} from "../config/settings-schema";
import { voiceInstructions } from "../transcription/transcription";

const absolute = Schema.String.check(
  settingsRefine(isAbsolute, { message: "Invalid input" }),
  settingsRefine((path) => !/[\r\n\0]/.test(path), {
    message: "Invalid input",
  }),
);

const optionsSchema = settingsStruct({
  directory: absolute,
  projectDirectory: absolute,
  worktreeDirectory: absolute,
  workspaceMode: Schema.Literals(["worktree", "clone"]).pipe(
    settingsDefault("worktree"),
  ),
  namespace: Schema.optional(
    Schema.String.check(settingsPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/)),
  ),
  captainSessionID: Schema.optional(
    Schema.String.check(
      settingsPattern(/^ses_[A-Za-z0-9]+$/),
      Schema.isMaxCodePoints(256),
    ),
  ),
  cron: Schema.optional(
    settingsStruct({
      configPath: absolute,
      bot: Schema.String.check(settingsPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/)),
    }),
  ),
  team: teamSchema.pipe(settingsDefault(defaultTeam)),
  base: Schema.String.check(
    Schema.isMinCodePoints(1),
    settingsRefine((base) => !base.startsWith("-"), {
      message: "Invalid input",
    }),
  ).pipe(settingsDefault("origin/main")),
  mesijCommand: absolute,
  proxyURL: settingsURL.pipe(settingsDefault("http://127.0.0.1:8317/v1")),
  apiKeyReference: Schema.String.check(
    settingsPattern(/^\{(?:env:[A-Z_][A-Z0-9_]*|file:[^\r\n{}]+)\}$/),
  ).pipe(settingsDefault("{env:CLIPROXYAPI_API_KEY}")),
  /** Nightly maintenance window rendered into captain and crew instructions. */
  maintenanceWindow: Schema.optional(nightlyWindowSchema),
});

type Options = typeof optionsSchema.Encoded;

const document = settingsRecord(
  Schema.String,
  Schema.mutableKey(Schema.Unknown),
);

const templateSchema = document.pipe(
  Schema.decodeTo(
    Schema.StructWithRest(
      Schema.Struct({
        model: Schema.String,
        compaction: document,
        experimental: document,
        providers: settingsRecord(Schema.String, document),
      }),
      [Schema.Record(Schema.String, Schema.Unknown)],
    ),
  ),
);

function parseOptions(input: Options) {
  const parsed = Schema.decodeUnknownResult(optionsSchema)(input);

  if (Result.isFailure(parsed))
    throw new Error(
      "Invalid profile paths, team, namespace, proxy URL, or credential reference.",
    );

  const options = {
    ...parsed.success,
    namespace: parsed.success.namespace ?? parsed.success.team.captain.id,
  };

  options.team = profileTeam(options.team, options.namespace);
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

  const config: unknown = await Bun.file(
    join(templatesDirectory, "opencode.json"),
  ).json();

  // The template is project-owned; untrusted inputs are validated above.
  const parsed = Schema.decodeUnknownSync(templateSchema)(config);
  const providers = parsed.providers;

  for (const provider of Object.values(providers)) {
    provider["settings"] = {
      ...Schema.decodeUnknownSync(document)(provider["settings"]),
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
    skills: [
      join(options.projectDirectory, ".agents", "opco", "skills"),
      join(templatesDirectory, "skills"),
    ],
    default_agent: agent.agent ?? role,
    agents: {
      [agent.agent ?? agent.id]: {
        ...(agent.model && { model: agent.model }),
        permissions: crewPermissions(profile, options.team.toolAccess),
      },
    },
    plugins: [
      {
        package: installationDirectory,
        options: {
          namespace: options.namespace,
          ...(options.cron && { cron: options.cron }),
          ...(options.captainSessionID && {
            captainSessionID: options.captainSessionID,
          }),
          team: options.team,
          captainDirectory: options.directory,
          stateDirectory: join(options.directory, ".local", "stargate-crew"),
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Cannot inspect profile destination.");
  }
}

async function writeProfileFile(
  path: string,
  text: string,
  preserveExisting = false,
) {
  const info = await present(path);

  if (info) {
    if (
      !info.isFile() ||
      (!preserveExisting && (await readFile(path, "utf8")) !== text)
    ) {
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

  if (missing.length === 0) return;
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
  let cloneOrigin = options.projectDirectory;

  if (options.workspaceMode === "clone") {
    try {
      cloneOrigin = git(
        options.projectDirectory,
        "remote",
        "get-url",
        "origin",
      );
    } catch {
      /* A local repository need not have an upstream. */
    }
  }

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
  const state = join(options.directory, ".local", "stargate-crew");
  await mkdir(state, { recursive: true, mode: 0o700 });

  if (((await lstat(state)).mode & 0o077) !== 0)
    throw new Error("Crew state directory must be private (0700).");
  const agents = [options.team.captain, ...options.team.crew];

  const roster = [
    `- ${options.team.captain.id}: Captain and coordinator`,
    ...options.team.crew.map((member) => `- ${member.id}: ${member.role}`),
  ].join("\n");

  await writeProfileFile(
    join(options.directory, "WAYS_OF_WORKING.md"),
    (
      await readFile(join(templatesDirectory, "ways-of-working.md"), "utf8")
    ).replace("{{roster}}", roster),
    true,
  );
  const ship = join(options.directory, ".local", "ship");
  await writeProfileFile(
    join(ship, "log.md"),
    "# Ship log\n\nRecord verified team lessons and useful inspection findings.\n",
    true,
  );

  const shipInstructions = await readFile(
    join(templatesDirectory, "ship-instructions.md"),
    "utf8",
  );

  await excludeGenerated(
    options.projectDirectory,
    agents.map(({ id, agent }) => agent ?? id),
  );

  for (const agent of agents) {
    const role = agent.id;
    const journalPath = join(ship, "journals", `${role}.md`);
    await writeProfileFile(
      journalPath,
      `# ${role} journal\n\nRecord useful findings, checks, actions and lessons at task boundaries.\n`,
      true,
    );
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

        if (options.workspaceMode === "clone") {
          git(
            options.projectDirectory,
            "clone",
            "--no-hardlinks",
            "--no-checkout",
            "--",
            options.projectDirectory,
            directory,
          );
          git(
            directory,
            "checkout",
            "-b",
            `crew/${options.namespace}-${role}`,
            base,
          );
          git(directory, "remote", "set-url", "origin", cloneOrigin);
        } else {
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
      }

      const common = await realpath(
        resolve(directory, git(directory, "rev-parse", "--git-common-dir")),
      );

      const branch = git(directory, "branch", "--show-current");

      if (
        (options.workspaceMode === "clone"
          ? common === sourceCommon ||
            git(directory, "remote", "get-url", "origin") !== cloneOrigin
          : common !== sourceCommon) ||
        !branch ||
        ["main", "master"].includes(branch)
      ) {
        throw new Error(
          "Existing crew workspace must belong to this project and use a non-main feature branch.",
        );
      }

      if (options.workspaceMode === "clone")
        await excludeGenerated(
          directory,
          agents.map(({ id, agent }) => agent ?? id),
        );
    }

    if (member?.backend) {
      await writeProfileFile(
        piDefinitionPath(options.directory, member),
        piMemberDefinition(
          member,
          directory,
          options.directory,
          nightlyInstructions(options.maintenanceWindow),
        ),
        true,
      );
      continue;
    }

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
          `${relative}/agents/${agent.agent ?? role}.md`,
        )
      ) {
        throw new Error(
          "Profile destination contains tracked configuration; use an untracked overlay.",
        );
      }
    }

    const template = await readFile(
      join(templatesDirectory, "agents", `${captain ? "captain" : "crew"}.md`),
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
      nativeAgent: agent.agent ?? role,
      agentName: agent.name ?? role,
      captainID: options.team.captain.id,
      captainName: options.team.captain.name ?? options.team.captain.id,
      directory,
      shipLog: join(ship, "log.md"),
      journalPath,
      journalDirectory: join(ship, "journals"),
      waysOfWorking: join(options.directory, "WAYS_OF_WORKING.md"),
      skillsDirectory: join(
        options.projectDirectory,
        ".agents",
        "opco",
        "skills",
      ),
      role: member?.role ?? "Captain and Slack coordinator",
      permissionProfile: member?.permissionProfile ?? "captain",
      roster: options.team.crew
        .map(
          (member) =>
            `- ${member.id} (${member.name ?? member.id}): ${member.role}; permissions: ${member.permissionProfile}${member.backend ? `; backend: Pi Durable (coordination ${member.backend.tools === "coding" ? "enabled" : "disabled"})` : ""}`,
        )
        .join("\n"),
      reactionInstructions,
      voiceInstructions,
      textMentionInstructions,
      peerInstructions,
      ircInstructions,
      ircCrewInstructions,
      maintenanceInstructions: nightlyInstructions(options.maintenanceWindow),
      instructions:
        agent.instructions ??
        "Follow the assigned task and project instructions.",
    };

    const prompt = `${template.trimEnd()}\n\n${shipInstructions}`.replace(
      /\{\{(\w+)\}\}/g,
      (match, key: string) => substitutions[key] ?? match,
    );

    await writeProfileFile(
      join(configPath, "agents", `${agent.agent ?? role}.md`),
      managedPrompt(prompt),
    );
    await writeProfileFile(
      join(configPath, "opencode.json"),
      `${JSON.stringify(await renderProfile(options, role), null, 2)}\n`,
    );
  }

  return {
    directory: options.directory,
    worktrees,
    stateDirectory: state,
    namespace: options.namespace,
    agent: options.team.captain.agent ?? options.team.captain.id,
    ...(options.captainSessionID && { sessionID: options.captainSessionID }),
    permissions: crewPermissions("captain", options.team.toolAccess),
  };
}
