import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import {
  addBot,
  buildManifest,
  checkCredentials,
  manifestUrl,
  readConfiguration,
} from "../src/setup";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function path() {
  const directory = await mkdtemp(join(tmpdir(), "pogo-setup-"));
  temporary.push(directory);
  return join(directory, "pogo.json");
}
function bot(id = "one") {
  return {
    id,
    slack: {
      appId: `A${id.toUpperCase()}`,
      appTokenEnv: `${id.toUpperCase()}_APP`,
      botTokenEnv: `${id.toUpperCase()}_BOT`,
    },
    access: { users: ["U123"], channels: ["C123"] },
    backend: {
      type: "opencode",
      url: "http://localhost:4096",
      directory: "/project",
    },
  };
}
test("manifest prefill round-trips and grants only intended scopes/events", () => {
  const manifest = buildManifest("Test app");
  expect(
    JSON.parse(
      new URL(manifestUrl("Test app")).searchParams.get("manifest_json") ?? "",
    ),
  ).toEqual(manifest);
  expect(manifest.features.app_home).toEqual({
    messages_tab_enabled: true,
    messages_tab_read_only_enabled: false,
  });
  expect(manifest.settings.socket_mode_enabled).toBe(true);
  expect(manifest.oauth_config.scopes.bot).toEqual([
    "app_mentions:read",
    "channels:history",
    "groups:history",
    "im:history",
    "chat:write",
    "reactions:write",
    "commands",
  ]);
  expect(manifest.features.slash_commands).toEqual([
    {
      command: "/pogo",
      description: "View crew activity or manage operator controls",
      usage_hint: "crew [member] | pair",
      should_escape: true,
    },
    {
      command: "/cron",
      description: "Manage scheduled agent prompts",
      usage_hint: "[list|add|remove]",
      should_escape: true,
    },
  ]);
  expect(manifest.settings.interactivity).toEqual({ is_enabled: true });
  expect(manifest.settings.event_subscriptions.bot_events).toEqual([
    "app_mention",
    "message.channels",
    "message.groups",
    "message.im",
  ]);
});
test("append preserves bots and credentials with private files", async () => {
  const config = await path();
  await addBot(config, bot(), { app: "xapp-first", bot: "xoxb-first" });
  await addBot(config, bot("two"), { app: "xapp-second", bot: "xoxb-second" });
  expect((await readConfiguration(config)).bots.map((b) => b.id)).toEqual([
    "one",
    "two",
  ]);
  expect(await readFile(`${config}.env`, "utf8")).toBe(
    "ONE_APP=xapp-first\nONE_BOT=xoxb-first\nTWO_APP=xapp-second\nTWO_BOT=xoxb-second\n",
  );
  expect((await stat(`${config}.env`)).mode & 0o777).toBe(0o600);
  const before = await readFile(config, "utf8");
  await expect(addBot(config, bot())).rejects.toThrow("duplicate");
  expect(await readFile(config, "utf8")).toBe(before);
});
test("existing credentials and invalid input are never overwritten", async () => {
  const config = await path();
  await writeFile(`${config}.env`, "ONE_APP=existing\n");
  await expect(
    addBot(config, bot(), { app: "xapp-new", bot: "xoxb-new" }),
  ).rejects.toThrow("overwrite");
  expect(await readFile(`${config}.env`, "utf8")).toBe("ONE_APP=existing\n");
  await expect(
    addBot(config, { ...bot(), access: { users: [], channels: [] } }),
  ).rejects.toThrow("Invalid bot");
  await expect(
    addBot(config, bot(), { app: "secret", bot: "secret" }),
  ).rejects.toThrow("prefixes");
});

test("credential check loads companion, respects environment, and rejects missing secrets", async () => {
  const config = await path();
  await addBot(config, bot(), { app: "xapp-valid", bot: "xoxb-valid" });
  const { bots } = await readConfiguration(config);
  await checkCredentials(config, bots, {});
  await expect(
    checkCredentials(config, bots, { ONE_APP: "invalid" }),
  ).rejects.toThrow("Missing or invalid");
  await rm(`${config}.env`);
  await expect(checkCredentials(config, bots, {})).rejects.toThrow(
    "Missing or invalid",
  );
  await checkCredentials(config, bots, {
    ONE_APP: "xapp-env",
    ONE_BOT: "xoxb-env",
  });
});
test("scripted add stores references, validates without secrets, rejects token arguments", async () => {
  const config = await path();
  expect(
    await runCli([
      "bot",
      "add",
      "--config",
      config,
      "--id",
      "one",
      "--app-id",
      "A123",
      "--app-token-env",
      "ONE_APP",
      "--bot-token-env",
      "ONE_BOT",
      "--allowed-users",
      "*",
      "--allowed-channels",
      "*",
      "--denied-users",
      "U999",
      "--denied-channels",
      "C999,G999",
      "--backend",
      "opencode",
      "--directory",
      "/project",
      "--session-id",
      "ses_durableCaptain",
    ]),
  ).toEqual({ command: "exit" });
  expect((await readConfiguration(config)).bots[0]?.backend).toMatchObject({
    type: "opencode",
    sessionID: "ses_durableCaptain",
  });
  expect((await readConfiguration(config)).bots[0]?.access).toEqual({
    users: ["*"],
    channels: ["*"],
    deniedUsers: ["U999"],
    deniedChannels: ["C999", "G999"],
    mentionOnly: false,
  });
  expect(
    await runCli(["config", "check", "--config", config, "--schema-only"]),
  ).toEqual({
    command: "exit",
  });
  expect(await runCli(["start", "--config", config])).toEqual({
    command: "start",
    configPath: config,
  });
  await expect(
    runCli(["bot", "add", "--app-token", "secret-value"]),
  ).rejects.toThrow("Invalid CLI arguments");
  await expect(runCli(["start", "--model", "invalid"])).rejects.toThrow(
    "not supported",
  );
});
