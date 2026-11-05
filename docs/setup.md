# Agent-led Pogo setup

This guide creates **Slack app registrations for the existing Pogo gateway**.
It does not create a Bolt starter, replace Pogo, or run a second bot runtime.
Repeat app registration for each bot; one Pogo process can host them all.

## 1. Confirm the target

Ask the operator for:

- Bot name and unique Pogo ID, such as `pogo-test`.
- Target Slack workspace. Prefer a sandbox or a workspace without real users
  for initial tests; confirm any installation into a production workspace.
- Existing Slack App ID, if an app has already been created. Reuse that app
  instead of creating a duplicate.
- Allowed human user IDs and channel/DM IDs. Both lists must be nonempty.
  On explicit operator request, use `users: ["*"]` and/or `channels: ["*"]`
  for all accessible humans and channels/DMs. Wildcards do not grant membership.
- Optional user and channel exclusions, saved as `deniedUsers` and
  `deniedChannels`. Leave both empty when none are requested. **Deny always
  beats allow**, even when an ID is explicitly allowed or an allow contains `*`.
- Backend, working directory, and model settings.

Choose **OpenCode** for the initial CLIProxyAPI test. Configure the proxy as
an OpenCode provider separately; installing it does not route Pogo automatically.
Pogo's Pi Durable adapter currently lacks configurable proxy endpoints.
Do not substitute the proxy URL for `backend.url`: that field addresses the
OpenCode server, not the model API. Keep tools disabled for the first test.

Run project commands from the Pogo repository:

```sh
mise install
make deps
make pogo ARGS='--help'
```

## 2. Install or update Slack skills

For OpenCode, run the official Slack skill installer through mise's Node:

```sh
mise exec -- npx -y skills add slackapi/slack-skills-plugin -g -y -a opencode
```

This installs or updates the user-level skills, including `slack-cli`,
`slack-api`, `slack-docs`, and `create-slack-app`. Read the current hosted
instructions in this session; do not wait for a new session:

- [Slack agent setup](https://docs.slack.dev/agent-setup/prompt.md)
- [Slack CLI skill](https://docs.slack.dev/.well-known/skills/slack-cli/SKILL.md)
- [Slack API skill](https://docs.slack.dev/.well-known/skills/slack-api/SKILL.md)

**Pogo-specific adaptation:** the generic `create-slack-app` flow scaffolds
Bolt templates. Pogo already exists, so skip its language, template, provider
SDK, and project-scaffolding steps. Reuse the CLI authentication guidance and
Pogo's own manifest. Do not run `slack create` or `slack run` for this gateway.
Pogo runs through `make start` or its user service.

## 3. Detect and install the public Slack CLI

Follow the hosted `slack-cli` skill in order:

1. If executable, use the standard path `~/.slack/bin/slack` directly.
2. Otherwise, run `slack _fingerprint 2>/dev/null`. The public CLI responds
   with `d41d8cd98f00b204e9800998ecf8427e`.
3. If neither works, ask whether the CLI uses another command name. Verify
   that alias with the same fingerprint, or ask permission to install it.

Do not assume a command named `slack` is the developer CLI; it may be a
different application. Check existing executable paths before replacing files.
After reviewing the official installer and obtaining installation permission:

```sh
curl -fsSL https://downloads.slack-edge.com/slack-cli/install.sh | bash
```

Resolve the executable again. In the examples below, set `SLACK_CMD` to its
verified path; this is the standard installation:

```sh
SLACK_CMD="$HOME/.slack/bin/slack"
"$SLACK_CMD" version
"$SLACK_CMD" login --help
"$SLACK_CMD" auth list --help
"$SLACK_CMD" auth list --no-color
```

Run each unfamiliar command's `--help` before constructing its flags. These
steps were checked with Slack CLI 4.12.0; installed help remains authoritative.

## 4. Authenticate the selected workspace

Authentication is per workspace. An existing login to another workspace is
not enough. Confirm which workspace the operator wants before starting login.

The **agent** runs:

```sh
"$SLACK_CMD" login --no-prompt --no-color
```

The CLI returns a single-use command of this form:

```text
/slackauthticket <new-ticket-from-the-CLI>
```

The agent then:

1. Shows that exact new command to the operator and asks them to send it in
   the intended workspace's Slack message box.
2. Asks the operator to review Slack's authorization permissions. The operator
   approves only if the permissions and workspace are correct.
3. Collects the short challenge code shown in Slack, with the operator's consent.
   It is a one-time authorization challenge, not a bot token or API key.
4. Completes the pending login itself:

```sh
"$SLACK_CMD" login --ticket <pending-ticket> --challenge <challenge-code> --no-color
"$SLACK_CMD" auth list --no-color
```

Confirm the resulting workspace name, Team ID, and User ID with the operator.
If a ticket expires or a challenge fails, start a fresh login. Never reuse the
same failed ticket. Do not copy tickets or challenge codes into documentation,
commits, scripts, task arguments, or durable setup notes. The only command-line
exception is the CLI's supported one-time `login --ticket --challenge` exchange.

Do not ask the operator to run `slack login` in a separate terminal. The agent
drives these commands; the human only approves in Slack and returns the code.
Do not read or print `~/.slack/credentials.json` to recover credentials.

## 5. Create or reuse Pogo's Slack app

**CLI login is not app creation.** Pogo is not a Slack CLI project, and `slack api`
does not automatically turn a developer login into a token for every method.
App Manifest APIs require a configuration token with
`app_configurations:write`, not Pogo's bot token. Do not add that permission to
the runtime bot or assume `--team` supplies the required API token.

Choose one of the following paths. Confirm the app name and target workspace
before creating anything remotely. If an app already exists, go to step 6.

### A. Prefilled manifest link: no configuration token required

The agent generates Pogo's manifest and app-creation link:

```sh
make manifest ARGS='--name Pogo'
```

Open the printed link after the operator agrees. The operator selects the
workspace, reviews the manifest, and clicks **Create**. Record only the App ID,
not secrets. If link prefill does not work, generate the JSON instead:

```sh
make manifest ARGS='--name Pogo --json'
```

At [Slack app settings](https://api.slack.com/apps), choose **Create New App →
From a manifest** and paste that JSON. A shared JSON manifest link must use
the `manifest_json` query parameter, with the manifest URL-encoded.

If the operator is remote or on a phone, share the clickable link in chat;
opening a browser on the Pogo host does not help them. The third-party manifest
and Socket Mode notices are expected, but **"We can't translate a manifest with
errors"** is a validation failure. Check the generated fields against Slack's
[manifest reference](https://docs.slack.dev/reference/app-manifest).
The writable Messages tab uses `features.app_home.messages_tab_read_only_enabled`.
Send a newly generated link after fixing a manifest; the old link retains its
embedded JSON.

For a human driving the entire local wizard, use `make init`. For agent-led
registration, continue with steps 6 and 7 below; an interactive wizard cannot
be driven through a non-TTY shell tool.

### B. Programmatic creation: optional configuration-token path

Use this path only when the operator wants the agent to create the registration
through the API and can supply the configuration token securely. Obtain it
under **Your App Configuration Tokens** at Slack app settings for the intended
workspace. Tokens expire after 12 hours; use a fresh token or the documented
rotation flow. Never request either access or refresh tokens in chat.

Have the operator make `SLACK_APP_CONFIG_TOKEN` available through a private
environment or local credential source. Do not put its value in a shell
command, `ARGS`, source code, or documentation. Read the live
[apps.manifest.create contract](https://docs.slack.dev/reference/methods/apps.manifest.create)
and confirm the write with the operator before running this command:

```sh
mise exec -- bun -e '
import { z } from "zod";
import { buildManifest } from "./src/setup.ts";

const token = process.env.SLACK_APP_CONFIG_TOKEN;
if (!token) throw new Error("SLACK_APP_CONFIG_TOKEN is required");
const response = await fetch("https://slack.com/api/apps.manifest.create", {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
  body: new URLSearchParams({
    manifest: JSON.stringify(buildManifest("Pogo")),
  }),
  signal: AbortSignal.timeout(30_000),
});
const result = z.object({
  ok: z.boolean(),
  app_id: z.string().regex(/^A[A-Z0-9]+$/).optional(),
  error: z.string().regex(/^[a-z_]+$/).optional(),
}).parse(await response.json());
if (!response.ok || !result.ok || !result.app_id) {
  throw new Error(`Slack app creation failed: ${result.error ?? response.status}`);
}
console.log(`Created app: ${result.app_id}`);
console.log(`Settings: https://api.slack.com/apps/${result.app_id}`);
'
```

The response can contain client secrets and signing secrets. The example strips
those fields and prints only the App ID/settings link. Do not dump the raw API
response or save it in the repository. On an uncertain network outcome, inspect
Slack app settings before retrying: a retry may create a duplicate app.
This path creates the registration; it does not finish workspace installation
or automatically supply Pogo's app-level and bot tokens.

## 6. Review permissions, install, and collect runtime tokens

Pogo's manifest enables Socket Mode and subscribes to `app_mention`,
`message.channels`, `message.groups`, and `message.im`. Required bot scopes:

| Scope               | Purpose                                |
| ------------------- | -------------------------------------- |
| `app_mentions:read` | Receive mentions                       |
| `channels:history`  | Receive public-channel thread replies  |
| `groups:history`    | Receive private-channel thread replies |
| `im:history`        | Receive direct messages                |
| `chat:write`        | Send replies                           |

Guide the operator through these human-controlled steps:

1. Under **Basic Information**, copy the non-secret App ID (`A…`).
2. Under **App-Level Tokens**, generate an `xapp-…` token with
   **`connections:write`**. This is an app-level scope, not a bot scope.
3. Under **OAuth & Permissions**, install the app to the chosen workspace.
   Wait for admin approval if required; do not claim the app is installed yet.
4. Copy its **Bot User OAuth Token** (`xoxb-…`). Reinstall after scope changes.
5. Invite the bot to each allowed channel with `/invite @Pogo`.

Keep persistent tokens out of the agent conversation, command-line arguments,
and tool output. The human can paste them into Pogo's hidden wizard prompts,
or store them in the referenced private environment variables / `pogo.json.env`
with mode `0600`. Do not overwrite existing credentials or print that file.

Member profile → **More → Copy member ID** gives the human user ID (`U…` or
`W…`). Channel details show the channel ID (`C…`, `G…`, or `D…`). The login's
User ID may be used only after the operator confirms that user is allowed.
Do not expand channel/user access merely to make a test pass.
If the operator chooses invitation-based access, use `--allowed-users '*'` and
`--allowed-channels '*'` instead of enumerating users or channels. Quote `*`
so the shell does not expand filenames. Within `make ... ARGS='...'`, use
`--allowed-users "*" --allowed-channels "*"`. Optional `--denied-users` and
`--denied-channels` take comma-separated IDs; their defaults are empty lists.
Whole `*` also works in deny lists to block everyone/everywhere, but partial
globs such as `C*` are invalid. Denies override exact and wildcard allows.

## 7. Register the bot with Pogo

The agent runs a noninteractive registration using references, not token values.
Replace example IDs, paths, URL, provider, and model with confirmed settings:

```sh
make pogo ARGS='bot add --id pogo-test --app-id A0123456789 --app-token-env POGO_TEST_APP_TOKEN --bot-token-env POGO_TEST_BOT_TOKEN --allowed-users U0123456789 --allowed-channels C0123456789 --backend opencode --directory /srv/project --url http://localhost:4096 --provider openai-proxy --model MODEL_ID'
```

`openai-proxy` here is an example **OpenCode provider ID**, not an automatic
integration. It must already exist on the selected server. The model ID must
be one that provider exposes. Do not modify the user's global OpenCode
configuration without permission; prefer an explicitly scoped test workspace.
OpenCode server authentication uses `backend.headersEnv` when needed; proxy
client authentication belongs in the OpenCode provider configuration.

Do not assume the wizard's `http://localhost:4096` default is the running
OpenCode service. Check `opencode service status`, or use
`Service.discover()` from `@opencode/client/service` to discover its endpoint.
When a local service reports `0.0.0.0`, use `127.0.0.1` as the client host.
For a managed authenticated service, obtain headers with `Service.headers()`
and store the complete authorization value privately in the config companion.
Map `backend.headersEnv.authorization` to that environment variable's name;
never print the value or paste it into chat. A shared service's port or
credentials can change after its restart, so rediscover them if needed.
`Bot connected` only verifies Slack, not this backend connection.

Alternatively, the human can run `make init`. If the app was already created,
decline opening another creation page and enter the existing App ID/tokens.
Do not add the same bot twice. Multiple bots need unique IDs, Slack apps, and
token environment references. Restart an existing Pogo process after adding one.
Restart after changing access rules, too. Adding Bowser to another channel
needs no config change when channels are allowed with `*` and not denied.

## 8. Verify in stages

```sh
make config-check ARGS='--schema-only'
make config-check
make start
```

- Schema check validates configuration structure only.
- Credential check verifies local token references/prefixes, not live auth.
- `Bot connected` confirms Slack authentication and a Socket Mode connection.
- A proxy model listing proves discovery, not successful inference.
- With the operator's consent, ask them to mention Pogo in an allowed channel:
  `@Pogo Say "Pogo is ready" without using tools.`
- Confirm a real reply, then a follow-up in the same thread. Do not claim success
  before those work. A backend failure may require provider configuration or
  authentication; never fix it by enabling all tools or opening allowlists.

Use a sandbox or a workspace without real users for smoke tests. Keep only one
Socket Mode listener per registration. Do not leave a second listener running
when switching from a foreground test to a user service.

## 9. Install the Pogo user service when requested

```sh
make service ARGS='install --config /absolute/path/to/pogo.json'
systemctl --user enable --now pogo.service
systemctl --user status pogo.service
```

Installation alone does not enable or start the unit. Obtain permission before
starting/enabling services, and stop any foreground Pogo instance first.
The unit reads the private config companion; it does not inherit shell exports
automatically. See the [README service section](../README.md#linux-user-service)
and [CLIProxyAPI installation notes](cliproxyapi.md) for lifecycle details.

## Agent completion checklist

Report each state separately: skills installed, CLI installed, workspace
authenticated, app created, app installed, tokens stored privately, Pogo bot
registered, backend configured, live reply verified, and service enabled.
List remaining human approvals or missing settings. Do not collapse these
states into "setup complete" after merely logging in or creating an app.

Never commit local config, credentials, API responses, auth tickets/challenges,
or runtime databases. Link to this guide rather than copying a live transcript.

## Official references

- [Slack agent setup](https://docs.slack.dev/agent-setup/prompt.md)
- [Hosted Slack CLI skill](https://docs.slack.dev/.well-known/skills/slack-cli/SKILL.md)
- [App manifests and configuration tokens](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests)
- [Create an app from a manifest](https://docs.slack.dev/reference/methods/apps.manifest.create)
