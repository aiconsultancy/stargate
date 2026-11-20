import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseEnv } from "node:util";
import { Result, Schema } from "effect";
import {
  type BotConfig,
  botSchema,
  configSchema,
  type IrcConfig,
  reloadConfigSchema,
} from "./config";
import { clientPem } from "./irc/client-pem";
import { checkProducerCredentials, type NotifyConfig } from "./notify/config";
import { settingsIssues } from "./settings-schema";

export function buildManifest(name = "Stargate") {
  if (!name.trim() || name.length > 80)
    throw new Error("App name must be 1–80 characters.");
  return {
    display_information: { name, description: "AI assistant for Slack" },
    features: {
      bot_user: { display_name: name, always_online: false },
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      slash_commands: [
        {
          command: "/stargate",
          description: "View crew activity, usage or operator controls",
          usage_hint: "crew [member] | usage | pair",
          should_escape: true,
        },
        {
          command: "/cron",
          description: "Manage scheduled agent prompts",
          usage_hint: "[list|add|remove]",
          should_escape: true,
        },
      ],
    },
    oauth_config: {
      scopes: {
        bot: [
          "app_mentions:read",
          "channels:history",
          "groups:history",
          "im:history",
          "chat:write",
          "files:read",
          "files:write",
          "reactions:write",
          "commands",
        ],
      },
    },
    settings: {
      socket_mode_enabled: true,
      interactivity: { is_enabled: true },
      event_subscriptions: {
        bot_events: [
          "app_mention",
          "message.channels",
          "message.groups",
          "message.im",
        ],
      },
    },
  };
}

export function manifestUrl(name?: string) {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(buildManifest(name)))}`;
}

export const slackInstructions = `Create the app using the prefilled manifest link.
Scopes: app_mentions:read, channels:history, groups:history, im:history, chat:write, files:read, files:write, reactions:write, commands.
In Basic Information, copy the App ID (A...). Create an app-level token
(xapp-...) with connections:write. Install/reinstall the app to your workspace
after scope changes, including file scopes; copy the Bot User OAuth Token (xoxb-...). Invite the bot
to each allowed channel with /invite @your-bot.
Find user IDs: member profile → More → Copy member ID.
Find channel IDs: channel details → channel ID at the bottom.
No additional Slack permissions are needed.
Access is denied unless BOTH the user ID and channel ID are allowed.
Use * for allowed users/channels to permit all accessible humans/channels.
Deny rules always beat allow rules, including *. Empty deny lists block nobody.
Messages from bots are never allowed. Backend permissions are separate.`;

function validBot(input: unknown): BotConfig {
  const parsed = Schema.decodeUnknownResult(botSchema)(input);
  if (Result.isFailure(parsed))
    throw new Error(
      "Invalid bot configuration. Check IDs, backend options, and nonempty user/channel allowlists.",
    );
  if (
    parsed.success.backend.type === "pi-durable" &&
    !/^(openai|anthropic)\/.+$/.test(parsed.success.backend.model)
  ) {
    throw new Error("Pi model must be openai/modelId or anthropic/modelId.");
  }
  return parsed.success;
}

/**
 * Validates credential references and returns the effective environment:
 * the `<config>.env` companion, overridden by `environment`. Neither input is
 * changed, and values are never logged.
 */
export async function checkCredentials(
  path: string,
  bots: readonly BotConfig[],
  environment: NodeJS.ProcessEnv = process.env,
  irc: readonly IrcConfig[] = [],
  notify?: NotifyConfig,
  dataDirectory = ".stargate",
): Promise<NodeJS.ProcessEnv> {
  let companion: NodeJS.ProcessEnv = {};
  try {
    companion = parseEnv(await readFile(`${path}.env`, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Cannot read credential companion.");
  }
  const env = { ...companion, ...environment };
  await checkProducerCredentials(
    notify,
    env,
    resolve(dirname(resolve(path)), dataDirectory),
  );
  // Presence only: values are never printed or sent anywhere.
  for (const registration of irc) {
    for (const name of [
      ...(registration.passwordEnv ? [registration.passwordEnv] : []),
      ...registration.crew.flatMap((member) =>
        member.passwordEnv ? [member.passwordEnv] : [],
      ),
    ])
      if (!env[name]?.trim())
        throw new Error(
          "Missing IRC password environment reference. Set it in the environment or <config>.env; use --schema-only to skip credential checks.",
        );
    const pemFiles = new Set(
      [registration, ...registration.crew].flatMap((member) =>
        member.clientPemFile ? [member.clientPemFile] : [],
      ),
    );
    for (const path of pemFiles) await clientPem(path);
    const ca = registration.server.caFile;
    if (ca && !(await lstat(ca).catch(() => undefined))?.isFile())
      throw new Error("IRC caFile is not a readable file.");
  }
  for (const bot of bots) {
    if (
      !/^xapp-[A-Za-z0-9-]+$/.test(env[bot.slack.appTokenEnv] ?? "") ||
      !/^xoxb-[A-Za-z0-9-]+$/.test(env[bot.slack.botTokenEnv] ?? "")
    ) {
      throw new Error(
        "Missing or invalid Slack token environment references. Set them in the environment or <config>.env; use --schema-only to skip credential checks.",
      );
    }
  }
  return env;
}

export async function readConfiguration(
  path: string,
  notificationReload = false,
) {
  const invalid =
    "Cannot read a valid configuration. Check path, JSON, bot IDs, and allowlists.";
  let input: unknown;
  try {
    if (!(await lstat(path)).isFile()) throw new Error("Not a regular file");
    input = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(invalid);
  }
  const parsed = Schema.decodeUnknownResult(
    notificationReload ? reloadConfigSchema : configSchema,
  )(input);
  if (Result.isSuccess(parsed)) return parsed.success;
  const apiIssues = settingsIssues(parsed.failure.issue).issues.flatMap(
    ({ path, message }) =>
      path?.[0] === "api" ? [`${path.join(".")}: ${message}`] : [],
  );
  throw new Error(apiIssues.length ? apiIssues.join("\n") : invalid);
}

async function atomicWrite(path: string, contents: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } finally {
    await file.close();
    await unlink(temporary).catch(() => {});
  }
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("Cannot inspect configuration path.");
  }
}

export async function addBot(
  path: string,
  input: unknown,
  tokens?: { app: string; bot: string },
) {
  const bot = validBot(input);
  if (
    tokens &&
    (!/^xapp-[A-Za-z0-9-]+$/.test(tokens.app) ||
      !/^xoxb-[A-Za-z0-9-]+$/.test(tokens.bot))
  ) {
    throw new Error(
      "Invalid Slack token prefixes or characters; expected xapp- and xoxb-.",
    );
  }
  path = resolve(path);
  await mkdir(dirname(path), { recursive: true });
  let lock: FileHandle;
  try {
    lock = await open(`${path}.lock`, "wx", 0o600);
  } catch {
    throw new Error(
      "Configuration is locked or not writable. Retry after the other writer finishes.",
    );
  }
  try {
    const previous = (await exists(path))
      ? await readConfiguration(path)
      : { bots: [], dataDirectory: ".stargate" };
    const next = Schema.decodeUnknownResult(configSchema)({
      ...previous,
      bots: [...previous.bots, bot],
    });
    if (Result.isFailure(next))
      throw new Error(
        "Cannot add bot: duplicate identity/token reference or invalid configuration.",
      );
    // Env names must be unique across both token kinds, too.
    const names = next.success.bots.flatMap((entry) => [
      entry.slack.appTokenEnv,
      entry.slack.botTokenEnv,
    ]);
    if (new Set(names).size !== names.length)
      throw new Error("Token environment references must be unique.");
    if (tokens) {
      const envPath = `${path}.env`;
      let contents = "";
      if (await exists(envPath)) {
        if (!(await lstat(envPath)).isFile())
          throw new Error("Credential companion must be a regular file.");
        contents = await readFile(envPath, "utf8");
      }
      for (const name of [bot.slack.appTokenEnv, bot.slack.botTokenEnv]) {
        if (
          new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`, "m").test(contents)
        ) {
          throw new Error(
            "Credential reference already exists; refusing to overwrite credentials.",
          );
        }
      }
      await atomicWrite(
        envPath,
        `${contents}${contents.endsWith("\n") || !contents ? "" : "\n"}${bot.slack.appTokenEnv}=${tokens.app}\n${bot.slack.botTokenEnv}=${tokens.bot}\n`,
      );
    }
    await atomicWrite(path, `${JSON.stringify(next.success, null, 2)}\n`);
  } finally {
    await lock.close();
    await unlink(`${path}.lock`);
  }
}

export async function setupWizard(configPath: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Wizard requires a terminal. Use bot add flags for scripted setup.",
    );
  let hidden = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!hidden) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const ask = async (prompt: string) => (await rl.question(prompt)).trim();
  const askSecret = async (prompt: string) => {
    process.stdout.write(prompt);
    hidden = true;
    try {
      return await ask("");
    } finally {
      hidden = false;
      process.stdout.write("\n");
    }
  };
  try {
    const id = await ask("Bot ID (lowercase letters, numbers, _ or -): ");
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id))
      throw new Error("Invalid bot ID.");
    console.log(slackInstructions);
    console.log(manifestUrl(id));
    if (
      (await ask("Open Slack setup in your browser? [Y/n]: ")).toLowerCase() !==
      "n"
    ) {
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      if (Bun.which(opener)) {
        const browser = spawn(opener, [manifestUrl(id)], {
          stdio: "ignore",
          detached: true,
        });
        browser.on("error", () =>
          console.log("Open the printed Slack link manually."),
        );
        browser.unref();
      } else console.log("Open the printed Slack link manually.");
    }
    const appId = await ask("Slack App ID: ");
    const users = (
      await ask(
        "Allowed human user IDs (comma-separated, or * for all workspace humans): ",
      )
    )
      .split(",")
      .map((v) => v.trim());
    const channels = (
      await ask(
        "Allowed channel/DM IDs (comma-separated, or * for all accessible channels/DMs): ",
      )
    )
      .split(",")
      .map((v) => v.trim());
    const deniedUsers = (
      await ask("Denied human user IDs (comma-separated, blank for none): ")
    )
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    const deniedChannels = (
      await ask("Denied channel/DM IDs (comma-separated, blank for none): ")
    )
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    const type = await ask("Backend (opencode or pi-durable): ");
    const directory = resolve(
      (await ask("Backend working directory: ")) || ".",
    );
    let backend: unknown;
    if (type === "opencode") {
      const url =
        (await ask("OpenCode URL [http://localhost:4096]: ")) ||
        "http://localhost:4096";
      const providerID = await ask(
        "Optional model provider (blank for server default): ",
      );
      const model = providerID
        ? { providerID, id: await ask("Model ID: ") }
        : undefined;
      const sessionID = await ask(
        "Existing durable session ID (blank for separate thread sessions): ",
      );
      backend = {
        type,
        directory,
        url,
        ...(model ? { model } : {}),
        ...(sessionID ? { sessionID } : {}),
      };
      console.log(
        "OpenCode tool permissions default to deny; edit backend.permissions explicitly if needed.",
      );
    } else if (type === "pi-durable") {
      backend = {
        type,
        directory,
        model: await ask(
          "pi-durable model (openai/modelId or anthropic/modelId): ",
        ),
      };
      console.log(
        "Pi defaults to chat only. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in the service environment or private .env companion. Optional tools=coding enables trusted read/write/edit/bash; it is not a sandbox.",
      );
    } else throw new Error("Unknown backend.");
    const prefix = `STARGATE_${id.toUpperCase().replaceAll("-", "_")}`;
    const bot = validBot({
      id,
      slack: {
        appId,
        appTokenEnv: `${prefix}_APP_TOKEN`,
        botTokenEnv: `${prefix}_BOT_TOKEN`,
      },
      access: { users, channels, deniedUsers, deniedChannels },
      backend,
    });
    const app = await askSecret("App token (xapp-..., hidden): ");
    const token = await askSecret("Bot token (xoxb-..., hidden): ");
    await addBot(configPath, bot, { app, bot: token });
    console.log(
      "Bot added. Credentials saved in the mode-0600 .env companion.",
    );
    console.log(
      "If you enable the Fleet API, use stargate api token to retrieve its token.",
    );
  } finally {
    rl.close();
    output.destroy();
  }
}
