import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkCodexConfiguration } from "./backends/codex-paths";
import { loadConfig } from "./config";
import { teamSchema } from "./crew/team";
import { cronOperationSchema, runCronOperation } from "./cron-control";
import { maintenanceCli, maintenanceHelp } from "./nightly/cli";
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
  root: `Stargate — Slack AI assistant
Usage: stargate <command> [options]
The pogo command is a compatibility alias.
Commands:
  start             Run configured bots (also the default command)
  init              Interactive setup; append a bot safely
  bot add           Add a bot using flags, or interactively with no flags
  bot provision     Plan or resume a batch of Slack registrations
  crew init         Install an OpenCode captain/crew profile
  cron              List, add, run, remove, or report cronjobs
  config check      Validate config, Slack token and IRC credential references
  maintenance       Nightly self-update and host maintenance (plan/run/timer)
  manifest          Print Slack manifest JSON and prefilled creation URL
  service install   Install Linux systemd user unit; does not enable/start
  service start     Start the user unit
  service stop      Stop the user unit
  service status    Show user unit state
  service uninstall Disable, stop, and remove a Stargate-managed user unit
Use <command> --help for full options.\n${common}`,
  start: `Usage: stargate start [--config PATH]\n${common}
Provide token values through environment variables or <config>.env.
Both user and channel must be allowed; deny rules always win. Bots are rejected.
SIGHUP validates and reloads live access, transcription and IRC crew changes.
Reconnect-only changes report "restart required"; running turns keep their
execution snapshot, but new denies block delivery. No file watcher is enabled.`,
  init: `Usage: stargate init [--config PATH]\n${common}
Requires an interactive terminal; token input is hidden.
Creates a prefilled Slack manifest link, collects IDs and backend settings,
and appends a validated bot. Existing bots/credentials are never overwritten.
${slackInstructions}`,
  bot: `Usage: stargate bot add [--config PATH] [options]
Batch: stargate bot provision --plan PATH [--apply] [--config PATH]
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
  --backend TYPE         opencode or pi-durable (claude, codex: see docs/)
  --directory PATH       Backend working directory (resolved to absolute)
OpenCode:
  --url URL              Server URL (default: http://localhost:4096)
  --provider ID          Model provider; requires --model
  --model ID             Model ID; requires --provider
  --agent NAME           Optional OpenCode agent
  --session-id ses_...    Reuse one existing durable session across chat sources
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
  stargate bot add --id helper --app-id A123 --app-token-env HELPER_APP \\
    --bot-token-env HELPER_BOT --allowed-users U123 --allowed-channels C123 \\
    --backend opencode --directory /srv/project
Scripted setup stores references only; supply secrets through the environment
or create <config>.env securely. Exit status is nonzero on invalid input.
${slackInstructions}`,
  crew: `Usage: stargate crew init --directory PATH --project PATH --worktrees PATH [options]
--directory PATH       Captain workspace (outside the crew configuration tree)
--project PATH         Existing target Git repository, e.g. an Indra checkout
--worktrees PATH       Parent of the configured crew worktrees
--team PATH            Non-secret team JSON (default: Bowser's starter roster)
--id ID                Bot namespace (default: configured captain ID; bowser)
--session-id ses_...    Bind all crew locations to one existing captain session
--base REF             Committed source ref (default: origin/main)
--mesij-command PATH   Absolute Mesij executable (default: resolved from PATH)
--proxy-url URL        CLIProxyAPI endpoint (default: http://127.0.0.1:8317/v1)
--proxy-key-file PATH  Reference an existing private key file; never a key value
--cron-config PATH     Bind cron and pogo_post tools to this Stargate config path
--cron-bot ID          Cron bot registration; requires --cron-config (and vice versa)
--maintenance-config PATH  Render this Stargate config's nightly maintenance window
                       into captain and crew instructions (when enabled)
Creates named feature branches, local agent/config overlays, and private state.
Existing conflicting files are not overwritten. No sessions, apps, or services
are started. Crew sessions are created lazily by the captain and then reused.
The trusted crew profile enables implementation tools; it is not a sandbox.
Default model: openai-proxy/gpt-6.1-sol. Global authentication is unchanged.`,
  config: `Usage: stargate config check [--config PATH] [--schema-only]\n${common}
Checks JSON/schema, Slack tokens and IRC password references from the
environment and <config>.env, IRC caFile, and private IRC client PEM files.
--schema-only  Check JSON/schema without requiring any credentials
Does not contact Slack or IRC, or check provider credentials.`,
  cron: `Usage: stargate cron <list|add|run|remove|report> --bot ID [options]
--bot ID       Configured bot registration (required)
--input PATH   Add only: JSON definition file, at most 64 KiB
--name NAME    Run only: job name or UUID; positional name also accepted
--id UUID      Remove only: job UUID; positional UUID also accepted
Add JSON fields: name, description, schedule, prompt; optional timezone,
skills, enabled, report (immediate|daily), channel, user.
List and report accept no input or job selector. Output is JSON.
Uses configured cronjobs directory and destination; no prompt CLI arguments.
${common}`,
  maintenance: `${maintenanceHelp}\n${common}`,
  manifest: `Usage: stargate manifest [--name NAME] [--json]
--name NAME  Slack app display name (default: Stargate; 1–80 characters)
--json       Print only JSON for scripts; otherwise include prefilled URL
--help, -h   Show help
${slackInstructions}`,
  service: `Usage: stargate service <install|start|stop|status|uninstall> [options]
--name NAME  Unit basename (default: pogo; letters, digits, _ and -)
${common}
Linux systemd USER scope only. No sudo.
install: write ~/.config/systemd/user/<name>.service, then daemon-reload.
Existing units are not overwritten. Install does not enable or start.
start/stop: change running state only. status: print systemd unit properties.
uninstall: disable and stop, remove Stargate-managed unit, then daemon-reload.
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
  const options = {
    help: { type: "boolean", short: "h" },
    config: { type: "string" },
    bot: { type: "string" },
    input: { type: "string" },
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
    "session-id": { type: "string" },
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
    "cron-config": { type: "string" },
    "cron-bot": { type: "string" },
    "maintenance-config": { type: "string" },
    release: { type: "string" },
    version: { type: "string" },
    print: { type: "boolean" },
    "outside-window": { type: "boolean" },
    "after-run": { type: "boolean" },
    "accept-current": { type: "string" },
    yes: { type: "boolean" },
    now: { type: "boolean" },
    foreground: { type: "boolean" },
    "retry-failed": { type: "boolean" },
  } as const;
  const input = { args, allowPositionals: true, strict: true } as const;
  try {
    return parseArgs({ ...input, options });
  } catch {
    // Provisioning uses --plan PATH; maintenance cleanup and update have the
    // boolean --plan.
    // Retry parsing only for that exact command, including global options.
    try {
      const parsed = parseArgs({
        ...input,
        options: { ...options, plan: { type: "boolean" } },
      });
      if (
        parsed.positionals[0] === "maintenance" &&
        (parsed.positionals[1] === "cleanup" ||
          parsed.positionals[1] === "update")
      )
        return parsed;
    } catch {
      /* Fall through to the fixed, credential-safe error. */
    }
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
    console.log(help[topic ?? "root"] ?? help["root"]);
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
    "session-id",
    "mention-only",
  ];
  const allowed = new Set([
    "config",
    ...(command === "bot"
      ? p[1] === "provision"
        ? ["plan", "apply", "journal", "record-app", "json"]
        : botOptions
      : command === "cron"
        ? ["bot", "input", "name", "id"]
        : command === "crew"
          ? [
              "directory",
              "project",
              "worktrees",
              "team",
              "id",
              "session-id",
              "base",
              "mesij-command",
              "proxy-url",
              "proxy-key-file",
              "cron-config",
              "cron-bot",
              "maintenance-config",
            ]
          : command === "maintenance"
            ? [
                "json",
                ...(p[1] === "cleanup" ? ["plan"] : []),
                ...(p[1] === "update"
                  ? ["plan", "now", "foreground", "retry-failed"]
                  : []),
                "name",
                "print",
                "release",
                "version",
                "outside-window",
                "after-run",
                "accept-current",
                "yes",
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
  if (command === "maintenance") {
    if (p.length !== 2) throw new Error("Use maintenance --help.");
    const code = await maintenanceCli(p[1], {
      configPath,
      ...(v.plan === true ? { plan: true } : {}),
      ...(v.json ? { json: true } : {}),
      ...(v.name ? { name: v.name } : {}),
      ...(v.print ? { print: true } : {}),
      ...(v.release ? { release: v.release } : {}),
      ...(v.version ? { version: v.version } : {}),
      ...(v["outside-window"] ? { outsideWindow: true } : {}),
      ...(v["after-run"] ? { afterRun: true } : {}),
      ...(v["accept-current"] !== undefined
        ? { acceptCurrent: v["accept-current"] }
        : {}),
      ...(v.yes ? { yes: true } : {}),
      ...(v.now ? { now: true } : {}),
      ...(v.foreground ? { foreground: true } : {}),
      ...(v["retry-failed"] ? { retryFailed: true } : {}),
    });
    if (code !== 0) process.exitCode = code;
    return { command: "exit" };
  }
  if (command === "cron") {
    const op = p[1];
    if (!op || !["list", "add", "run", "remove", "report"].includes(op))
      throw new Error("Unknown cron operation. Use cron --help.");
    if (!v.bot?.trim()) throw new Error("--bot is required.");
    const selectors = [v.name, v.id, p[2]].filter(
      (value) => value !== undefined,
    );
    if (
      p.length > 3 ||
      (op !== "run" && op !== "remove" && p.length > 2) ||
      (v.input !== undefined && op !== "add") ||
      (v.name !== undefined && op !== "run") ||
      (v.id !== undefined && op !== "remove") ||
      (op === "run" || op === "remove"
        ? selectors.length !== 1
        : selectors.length !== 0)
    )
      throw new Error("Invalid cron options. Use cron --help.");
    let raw: unknown = { op };
    if (op === "add") {
      if (!v.input) throw new Error("cron add requires --input PATH.");
      const input = await readCronFile(resolve(v.input));
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        "op" in input
      )
        throw new Error(
          "Use a cronjob definition JSON object without an op field.",
        );
      raw = { ...input, op };
    } else if (op === "run") raw = { op, name: selectors[0] };
    else if (op === "remove") raw = { op, id: selectors[0] };
    if (!cronOperationSchema.safeParse(raw).success)
      throw new Error("Invalid cron input. Use cron --help.");
    const result = await runCronOperation(
      raw,
      { configPath, bot: v.bot },
      AbortSignal.timeout(30_000),
    );
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "crew" && p[1] === "init" && p.length === 2) {
    if (Boolean(v["cron-config"]) !== Boolean(v["cron-bot"]))
      throw new Error(
        "--cron-config and --cron-bot must be supplied together.",
      );
    if (!v.directory || !v.project || !v.worktrees)
      throw new Error("--directory, --project, and --worktrees are required.");
    const mesijCommand = v["mesij-command"] ?? Bun.which("mesij");
    if (!mesijCommand)
      throw new Error(
        "Mesij is unavailable. Run mise install or provide --mesij-command.",
      );
    const team =
      v.team !== undefined ? await readTeamFile(resolve(v.team)) : undefined;
    const maintenanceWindow = v["maintenance-config"]
      ? await readMaintenanceWindow(resolve(v["maintenance-config"]))
      : undefined;
    const result = await initializeProfile({
      directory: resolve(v.directory),
      projectDirectory: resolve(v.project),
      worktreeDirectory: resolve(v.worktrees),
      mesijCommand: resolve(mesijCommand),
      ...(team ? { team } : {}),
      ...(v.id ? { namespace: v.id } : {}),
      ...(v["session-id"] ? { captainSessionID: v["session-id"] } : {}),
      ...(v.base ? { base: v.base } : {}),
      ...(maintenanceWindow ? { maintenanceWindow } : {}),
      ...(v["proxy-url"] ? { proxyURL: v["proxy-url"] } : {}),
      ...(v["proxy-key-file"]
        ? { apiKeyReference: `{file:${resolve(v["proxy-key-file"])}}` }
        : {}),
      ...(v["cron-config"] && v["cron-bot"]
        ? {
            cron: { configPath: resolve(v["cron-config"]), bot: v["cron-bot"] },
          }
        : {}),
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "bot" && p[1] === "provision" && p.length === 2) {
    if (typeof v.plan !== "string" || !v.plan)
      throw new Error("--plan PATH is required.");
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
    if (!v["schema-only"]) {
      await checkCredentials(configPath, config.bots, process.env, config.irc);
      await checkCodexConfiguration(config, configPath);
    }
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
      if (v.backend === "claude" || v.backend === "codex")
        throw new Error(
          `Add ${v.backend} backends to the configuration JSON; see docs/${v.backend}.md.`,
        );
      if (v.backend === "opencode" && Boolean(v.provider) !== Boolean(v.model))
        throw new Error(
          "OpenCode --provider and --model must be supplied together.",
        );
      if (
        v.backend === "pi-durable" &&
        (v.provider || v.url || v.agent || v["session-id"])
      )
        throw new Error(
          "pi-durable does not support --provider, --url, --agent, or --session-id.",
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
              ...(v["session-id"] ? { sessionID: v["session-id"] } : {}),
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

async function readMaintenanceWindow(path: string) {
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(path);
  } catch {
    throw new Error(
      "Cannot load --maintenance-config. Run stargate config check.",
    );
  }
  const maintenance = config.maintenance;
  if (!maintenance?.enabled) return undefined;
  const { start, end, timeZone } = maintenance.window;
  return { start, end, timeZone };
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

async function readCronFile(path: string): Promise<unknown> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65_536) throw new Error();
      const buffer = Buffer.alloc(65_537);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > 65_536) throw new Error();
      return JSON.parse(buffer.subarray(0, length).toString("utf8"));
    } finally {
      await file.close();
    }
  } catch {
    throw new Error(
      "Cannot load cron input. Use a JSON file at most 64 KiB without credentials.",
    );
  }
}
