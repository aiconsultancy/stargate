import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { teamSchema } from "./crew/team";
import { initializeProfile } from "./profile";
import { provisionBots } from "./provision";
import { manageService } from "./service";
import {
  addBot,
  buildManifest,
  checkCredentials,
  manifestUrl,
  readConfiguration,
  setupWizard,
  slackInstructions,
} from "./setup";

const common = `--config PATH  Configuration file (default: ./pogo.json)
--help, -h     Show help. No command runs when help is requested.
Tokens are NEVER accepted as CLI arguments. Use environment variable references.
Wizard credentials go in <config>.env with mode 0600. Keep this file private.`;

const help: Record<string, string> = {
  root: `Pogo — Slack AI assistant
Usage: bun run src/main.ts <command> [options]
Commands:
  start             Run configured bots (also the default command)
  init              Interactive setup; append a bot safely
  bot add           Add a bot using flags, or interactively with no flags
  bot provision     Plan or resume a batch of Slack registrations
  crew init         Install an OpenCode captain/crew profile
  config check      Validate config and Slack token references
  manifest          Print Slack manifest JSON and prefilled creation URL
  service install   Install Linux systemd user unit; does not enable/start
  service start     Start the user unit
  service stop      Stop the user unit
  service status    Show user unit state
  service uninstall Disable, stop, and remove a Pogo-managed user unit
Use <command> --help for full options.\n${common}`,
  start: `Usage: pogo start [--config PATH]\n${common}
Provide token values through environment variables or <config>.env.
Both user and channel must be allowed; deny rules always win. Bots are rejected.`,
  init: `Usage: pogo init [--config PATH]\n${common}
Requires an interactive terminal; token input is hidden.
Creates a prefilled Slack manifest link, collects IDs and backend settings,
and appends a validated bot. Existing bots/credentials are never overwritten.
${slackInstructions}`,
  bot: `Usage: pogo bot add [--config PATH] [options]
Batch: pogo bot provision --plan PATH [--apply] [--config PATH]
  --journal PATH         Private resumable journal (default: .local/provision/)
  --record-app BOT=APP    Reconcile an app created through the browser
  --json                 Print sanitized plan/status JSON
Without --apply, provisioning only plans. Review before remote creation.
Persistent tokens are read from environment references, never arguments.
No bot options: interactive setup. With options: noninteractive, never prompts.
Required:
  --id ID                 Unique lowercase bot ID [a-z0-9_-], max 64
  --app-id A...           Slack App ID
  --app-token-env NAME    Environment reference for xapp- token
  --bot-token-env NAME    Environment reference for xoxb- token
  --allowed-users U...,W...  Human Slack IDs, or '*' for all workspace humans
  --allowed-channels C...,G...,D...  Channel/DM IDs, or '*' for all accessible channels/DMs
  --backend TYPE         opencode or pi-durable
  --directory PATH       Backend working directory (resolved to absolute)
OpenCode:
  --url URL              Server URL (default: http://localhost:4096)
  --provider ID          Model provider; requires --model
  --model ID             Model ID; requires --provider
  --agent NAME           Optional OpenCode agent
  Tool permissions default to deny; edit backend.permissions explicitly.
pi-durable:
  --model MODEL          Required openai/modelId or anthropic/modelId
  Set OPENAI_API_KEY or ANTHROPIC_API_KEY in the environment or <config>.env.
  Pi defaults to chat only. Optional backend.tools=coding enables trusted
  read/write/edit/bash; it is not a sandbox. Edit config to opt in.
Optional:
  --mention-only         Only respond to mentions
  --denied-users IDS     Comma-separated user IDs to block (default: none)
  --denied-channels IDS  Comma-separated channel/DM IDs to block (default: none)
Deny always beats allow, including explicit allows and '*'. Denies accept '*'
to block everyone/everywhere. Only a whole '*' is supported, not partial globs.
Wildcards do not grant Slack membership or allow bot messages. Quote '*'.
${common}
Environment names must match [A-Z_][A-Z0-9_]* and be unique.
Example:
  pogo bot add --id helper --app-id A123 --app-token-env HELPER_APP \\
    --bot-token-env HELPER_BOT --allowed-users U123 --allowed-channels C123 \\
    --backend opencode --directory /srv/project
Scripted setup stores references only; supply secrets through the environment
or create <config>.env securely. Exit status is nonzero on invalid input.
${slackInstructions}`,
  crew: `Usage: pogo crew init --directory PATH --project PATH --worktrees PATH [options]
--directory PATH       Captain workspace (outside the crew configuration tree)
--project PATH         Existing target Git repository, e.g. an Indra checkout
--worktrees PATH       Parent of the configured crew worktrees
--team PATH            Non-secret team JSON (default: Bowser's starter roster)
--id ID                Bot namespace (default: configured captain ID; bowser)
--base REF             Committed source ref (default: origin/main)
--mesij-command PATH   Absolute Mesij executable (default: resolved from PATH)
--proxy-url URL        CLIProxyAPI endpoint (default: http://127.0.0.1:8317/v1)
--proxy-key-file PATH  Reference an existing private key file; never a key value
Creates named feature branches, local agent/config overlays, and private state.
Existing conflicting files are not overwritten. No sessions, apps, or services
are started. Crew sessions are created lazily by the captain and then reused.
The trusted crew profile enables implementation tools; it is not a sandbox.
Default model: openai-proxy/gpt-6.1-sol. Global authentication is unchanged.`,
  config: `Usage: pogo config check [--config PATH] [--schema-only]\n${common}
Checks JSON/schema and Slack token references using environment and <config>.env.
--schema-only  Check JSON/schema without requiring any credentials
Does not contact Slack or check provider credentials.`,
  manifest: `Usage: pogo manifest [--name NAME] [--json]
--name NAME  Slack app display name (default: Pogo; 1–80 characters)
--json       Print only JSON for scripts; otherwise include prefilled URL
--help, -h   Show help
${slackInstructions}`,
  service: `Usage: pogo service <install|start|stop|status|uninstall> [options]
--name NAME  Unit basename (default: pogo; letters, digits, _ and -)
${common}
Linux systemd USER scope only. No sudo.
install: write ~/.config/systemd/user/<name>.service, then daemon-reload.
Existing units are not overwritten. Install does not enable or start.
start/stop: change running state only. status: print systemd unit properties.
uninstall: disable and stop, remove Pogo-managed unit, then daemon-reload.
Manual commands for the default name:
  systemctl --user start pogo.service
  systemctl --user enable pogo.service
  systemctl --user enable --now pogo.service
  journalctl --user -u pogo.service -f
For --name NAME, replace pogo.service with NAME.service.
WorkingDirectory is the config directory; EnvironmentFile is <config>.env.
Requires an available systemd user session bus. Login starts enabled units.`,
};

export type CliResult =
  | { command: "start"; configPath: string }
  | { command: "exit" };

function parseCli(args: string[]) {
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        config: { type: "string" },
        name: { type: "string" },
        json: { type: "boolean" },
        "schema-only": { type: "boolean" },
        id: { type: "string" },
        "app-id": { type: "string" },
        "app-token-env": { type: "string" },
        "bot-token-env": { type: "string" },
        "allowed-users": { type: "string" },
        "allowed-channels": { type: "string" },
        "denied-users": { type: "string" },
        "denied-channels": { type: "string" },
        backend: { type: "string" },
        directory: { type: "string" },
        url: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        agent: { type: "string" },
        "mention-only": { type: "boolean" },
        plan: { type: "string" },
        apply: { type: "boolean" },
        journal: { type: "string" },
        "record-app": { type: "string" },
        project: { type: "string" },
        worktrees: { type: "string" },
        team: { type: "string" },
        base: { type: "string" },
        "mesij-command": { type: "string" },
        "proxy-url": { type: "string" },
        "proxy-key-file": { type: "string" },
      },
    });
  } catch {
    throw new Error(
      "Invalid CLI arguments. Use --help. Secret values must never be passed as arguments.",
    );
  }
}

export async function runCli(args: string[]): Promise<CliResult> {
  const { values: v, positionals: p } = parseCli(args);
  const command = p[0] ?? "start";
  if (v.help || command === "help") {
    const topic = command === "help" ? p[1] : p[0];
    console.log(help[topic ?? "root"] ?? help.root);
    return { command: "exit" };
  }
  const configPath = resolve(v.config ?? "pogo.json");
  const botOptions = [
    "id",
    "app-id",
    "app-token-env",
    "bot-token-env",
    "allowed-users",
    "allowed-channels",
    "denied-users",
    "denied-channels",
    "backend",
    "directory",
    "url",
    "provider",
    "model",
    "agent",
    "mention-only",
  ];
  const allowed = new Set([
    "config",
    ...(command === "bot"
      ? p[1] === "provision"
        ? ["plan", "apply", "journal", "record-app", "json"]
        : botOptions
      : command === "crew"
        ? [
            "directory",
            "project",
            "worktrees",
            "team",
            "id",
            "base",
            "mesij-command",
            "proxy-url",
            "proxy-key-file",
          ]
        : command === "manifest"
          ? ["name", "json"]
          : command === "service"
            ? ["name"]
            : command === "config"
              ? ["schema-only"]
              : []),
  ]);
  if (Object.keys(v).some((key) => !allowed.has(key)))
    throw new Error(
      "Option is not supported by this command. Use command --help.",
    );
  if (command === "start" && p.length <= 1)
    return { command: "start", configPath };
  if (command === "crew" && p[1] === "init" && p.length === 2) {
    if (!v.directory || !v.project || !v.worktrees)
      throw new Error("--directory, --project, and --worktrees are required.");
    const mesijCommand = v["mesij-command"] ?? Bun.which("mesij");
    if (!mesijCommand)
      throw new Error(
        "Mesij is unavailable. Run mise install or provide --mesij-command.",
      );
    const team =
      v.team !== undefined ? await readTeamFile(resolve(v.team)) : undefined;
    const result = await initializeProfile({
      directory: resolve(v.directory),
      projectDirectory: resolve(v.project),
      worktreeDirectory: resolve(v.worktrees),
      mesijCommand: resolve(mesijCommand),
      ...(team ? { team } : {}),
      ...(v.id ? { namespace: v.id } : {}),
      ...(v.base ? { base: v.base } : {}),
      ...(v["proxy-url"] ? { proxyURL: v["proxy-url"] } : {}),
      ...(v["proxy-key-file"]
        ? { apiKeyReference: `{file:${resolve(v["proxy-key-file"])}}` }
        : {}),
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "bot" && p[1] === "provision" && p.length === 2) {
    if (!v.plan) throw new Error("--plan is required.");
    const result = await provisionBots({
      planPath: resolve(v.plan),
      apply: v.apply ?? false,
      ...(v.config ? { configPath } : {}),
      ...(v.journal ? { journalPath: resolve(v.journal) } : {}),
      ...(v["record-app"] ? { recordApp: v["record-app"] } : {}),
    });
    if (v.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Workspace ${result.teamId}; journal ${result.journalPath}`);
      for (const bot of result.bots) console.log(JSON.stringify(bot));
    }
  } else if (command === "init" && p.length === 1)
    await setupWizard(configPath);
  else if (command === "config" && p[1] === "check" && p.length === 2) {
    const config = await readConfiguration(configPath);
    if (!v["schema-only"]) await checkCredentials(configPath, config.bots);
    console.log("Configuration valid.");
  } else if (command === "manifest" && p.length === 1) {
    console.log(JSON.stringify(buildManifest(v.name), null, 2));
    if (!v.json)
      console.log(`\n${manifestUrl(v.name)}\n\n${slackInstructions}`);
  } else if (
    command === "service" &&
    p.length === 2 &&
    ["install", "start", "stop", "status", "uninstall"].includes(p[1] ?? "")
  ) {
    await manageService(p[1] as string, configPath, v.name);
  } else if (command === "bot" && p[1] === "add" && p.length === 2) {
    if (!Object.keys(v).some((key) => botOptions.includes(key)))
      await setupWizard(configPath);
    else {
      if (!v.directory) throw new Error("--directory is required.");
      if (v.backend === "opencode" && Boolean(v.provider) !== Boolean(v.model))
        throw new Error(
          "OpenCode --provider and --model must be supplied together.",
        );
      if (v.backend === "pi-durable" && (v.provider || v.url || v.agent))
        throw new Error(
          "pi-durable does not support --provider, --url, or --agent.",
        );
      const backend =
        v.backend === "opencode"
          ? {
              type: "opencode",
              directory: resolve(v.directory),
              url: v.url ?? "http://localhost:4096",
              ...(v.provider && v.model
                ? { model: { providerID: v.provider, id: v.model } }
                : {}),
              ...(v.agent ? { agent: v.agent } : {}),
            }
          : {
              type: v.backend,
              directory: resolve(v.directory),
              model: v.model,
            };
      await addBot(configPath, {
        id: v.id,
        slack: {
          appId: v["app-id"],
          appTokenEnv: v["app-token-env"],
          botTokenEnv: v["bot-token-env"],
        },
        access: {
          users: v["allowed-users"]?.split(",").map((s) => s.trim()),
          channels: v["allowed-channels"]?.split(",").map((s) => s.trim()),
          deniedUsers: v["denied-users"]
            ?.split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          deniedChannels: v["denied-channels"]
            ?.split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          mentionOnly: v["mention-only"] ?? false,
        },
        backend,
      });
      console.log(
        "Bot added. Supply tokens through the referenced environment variables.",
      );
    }
  } else throw new Error("Unknown command or extra arguments. Use --help.");
  return { command: "exit" };
}

async function readTeamFile(path: string) {
  try {
    return teamSchema.parse(await Bun.file(path).json());
  } catch {
    throw new Error(
      "Cannot load team file. Use valid team JSON without credentials.",
    );
  }
}
