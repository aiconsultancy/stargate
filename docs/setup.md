# Set up a Slack bot

Stargate runs your bot in your own process and uses Slack Socket Mode for
incoming messages. Each bot needs a Slack app installed in its workspace.
Start with one bot and one test channel. Use [IRC setup](irc.md) if you want an
IRC-only installation.

## Configure your first Slack bot

1. [Install Stargate](../README.md#install), then choose Pi Durable or OpenCode
   V2. Pi runs in Stargate with an OpenAI or Anthropic API key. OpenCode needs a
   reachable V2 server with its own model and provider already configured. See
   [backend configuration](configuration.md#backend-configuration).
2. Run the setup wizard from the Stargate directory in a terminal:

   ```sh
   bun run src/main.ts init
   ```

   Enter a lowercase bot ID like `project-helper`. Open the printed manifest
   link, select your workspace, and create the app. If you already created it
   from the Stargate manifest, skip opening a new creation page. If the link
   does not prefill, run `bun run src/main.ts manifest --name project-helper --json`
   and paste the output into Slack's [manifest form][manifest].
3. In Slack's app settings, copy the **App ID** (`A…`) from **Basic
   Information**. Under **App-Level Tokens**, generate an `xapp-…` token with
   `connections:write`. Install the app from **OAuth & Permissions** and copy
   its **Bot User OAuth Token** (`xoxb-…`). Workspace admins may need to
   approve the install. Reinstall the app after changing its scopes.
4. Give the wizard your member ID and the test channel ID. Slack's member
   profile menu has **Copy member ID**; the channel details show its ID.
   Invite the installed bot with `/invite @your-bot`. Leave the deny prompts
   blank unless you need exclusions. Pick a backend and set its working
   directory. OpenCode defaults to `http://localhost:4096`. Use the actual
   server URL and leave the session ID blank for separate thread sessions.
   Enter both Slack tokens in the wizard's hidden prompts.
5. Stargate writes `pogo.json` and a private `pogo.json.env` file. If using
   Pi, add `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` to that same private file,
   according to the model you chose. If OpenCode needs an authorization header,
   map it with [`headersEnv`](configuration.md#opencode-v2). Keep credentials
   out of command arguments, chat and version control.
6. Validate, then start the gateway in the foreground:

   ```sh
   bun run src/main.ts config check
   bun run src/main.ts start
   ```

   `config check --schema-only` checks structure without credentials. A normal
   check validates Slack token references locally. Look for `Bot connected`
   at startup, then mention your bot in the allowed channel and ask it to
   reply with "Stargate is ready" without using tools. Send a follow-up in the
   same thread and verify the reply. The two messages test inference and
   thread routing as well as the Slack connection.

Use the same `--config PATH` on every command when choosing an explicit path.
Run the wizard again to add another bot with its own app. It appends the new
registration and credentials.
See [scripted registration](configuration.md#scripted-slack-registration) for
noninteractive setup or to configure another backend. Stop any foreground
listener before starting a [Linux user service](operations.md#linux-user-service)
for the same app.

## Batch provisioning

Batch provisioning can plan creation or reuse of multiple Slack apps. Install
the pinned Bun version from the [install guide](../README.md#install), install
dependencies, then inspect the provisioning options:

```sh
bun run src/main.ts bot provision --help
```

Choose the backend and verify its prerequisites for each bot. If a registration
uses an [OpenCode captain profile](agents/default-opencode.md), use the profile's
generated `agent` and `permissions` in its backend settings. Register the
captain's Slack app; the crew workers run through the profile.

Copy [`bots.example.json`](../bots.example.json) to a private local plan, such
as `.local/bots.json`. Replace every example workspace, app, user, channel,
directory, and server setting before applying it. Each entry has explicit
`id`, `name`, `app`, `slack` token environment references, `access`, and
`backend`. Plans are strict version-1 JSON: unknown fields are rejected.
They contain no tokens or provider credentials. There are no shared defaults.

- `app: { "mode": "reuse", "appId": "A…" }` uses an existing registration.
- `app: { "mode": "create" }` requests a new registration.
- The example reuses an existing app for `project-helper`. Supply its App ID,
  or use `create` and remove `appId` if you need a new app.
- The provisioner checks the full plan against known registrations before
  requesting app creation. Matching registrations are reused and conflicts
  stop the request. An OpenCode backend with no `model` override
  uses the server's default model.
- Tool permissions remain deny-all unless explicitly configured. Do not enable
  tools merely to make provisioning or a connectivity test pass.

Plan first; this command does not write files or contact Slack:

```sh
make stargate ARGS='bot provision --plan .local/bots.json --json'
```

Review every bot, workspace, existing App ID, manifest, and creation link.
Both access allowlists must be nonempty. Wildcards require explicit operator
approval. The full batch is checked against existing bot IDs, App IDs, token
references, and settings before any app is created. A reused app receives a
settings link, not a new-app link. No existing Slack manifest is modified.

### API creation or browser creation

Prefer the Manifest API when the operator can supply a configuration token
privately. The optional plan field `configTokenEnv` defaults to
`SLACK_APP_CONFIG_TOKEN`. The token must belong to the intended workspace and
have `app_configurations:write`; the plan's `teamId` records the expected
workspace, not verified Slack authentication. One user/workspace configuration
token can create multiple apps, and expires after 12 hours. CLI login is not a
substitute. Never put the token value in the plan, CLI arguments, or chat.

After explicit approval of the reviewed batch:

```sh
make stargate ARGS='bot provision --plan .local/bots.json --apply --json'
```

Known App IDs are reused. New apps are created sequentially only when the
configuration-token environment variable is present. Without that token,
creation stays pending and the output supplies manifest links for the browser.
The command does not install apps, generate runtime tokens, invite bots, run
inference, start listeners, or change services.

For each browser-created app, record its non-secret App ID:

```sh
make stargate ARGS='bot provision --plan .local/bots.json --record-app research=A012NEWAPP --json'
make stargate ARGS='bot provision --plan .local/bots.json --apply --json'
```

`--record-app BOT_ID=APP_ID` saves only the reconciliation checkpoint; without
`--apply` it does not register bots locally. It accepts only a planned `create`
bot and cannot replace a known App ID. Record other browser-created bots with
the same command, then apply once. Applying registers all known bots with
environment references only, even if runtime tokens are not yet present.

### Resume and status

The default journal is `.local/provision/bots.json` beside the Stargate config.
It is gitignored through `.local/`, written atomically with mode `0600`, and
protected by a writer lock. Use `--journal PATH` to select another private
journal. Use a separate journal for a distinct batch, never to bypass an
uncertain creation. Keep the same plan and config path when resuming.
A terminated writer can leave `<journal>.lock`. Confirm that no provisioning
writer remains before removing only that stale lock; preserve the journal.

Each result includes `app`, `registration`, `credentials`, and `needsHuman`,
plus a manifest and actionable link. Token presence/prefixes are local checks,
not proof of installation or successful Slack/provider authentication.

- Repeating `--apply` skips known apps and matching local registrations.
- HTTP 429 stops further creation in that run. `retryAfterSeconds` reports the
  wait; an early rerun does not repeat that request before its checkpoint time.
- Lost or malformed responses, partial server errors, and interrupted creates
  become `outcome_unknown`. They are **not retried automatically**.
- Inspect the correct workspace's app settings, identify the app actually
  created, and use `--record-app` to reconcile that exact bot. Do not delete
  the journal or follow a new creation link to clear uncertainty. If no app can
  be identified, stop and resolve the outcome before creating another one.
- Missing runtime tokens leave a separate human task. Put them in the named
  private environment variables or `<config>.env` with mode `0600`. The batch
  command does not write or overwrite credentials. The hidden-input wizard is
  an alternative single-bot registration workflow, not a token-update command
  for an already registered bot.

The batch and agent-assisted examples use mise tasks. Install their pinned
tools with `mise install`; the direct Bun commands above work independently.

When moving an existing bot, stop the old listener before starting the new
one. Active deployments each need their own Slack apps. Follow the
[staged verification](#8-verify-in-stages) after provisioning.

## Browser-assisted registration

Use OpenCode's built-in browser tools when they are available. Load the browser
skill, confirm access with its tab-list operation, and reuse that browser.
Do not install a second driver merely to duplicate a working built-in browser.

The agent can navigate non-secret setup forms, open the generated manifest
link, and help review names, workspace, scopes, and settings. The operator
completes sign-in, SSO/MFA, CAPTCHA, and OAuth installation approval. Workspace
admin approval can still block installation. Do not claim silent approval or
fully unattended installation.

Keep browser-generated persistent tokens out of agent context. Do not read
token-bearing pages with snapshots, screenshots, DOM/eval, clipboard tools,
console output, network dumps, or recordings. The human handles token pages
and stores credentials directly in a private local source. Record only the
App ID with `--record-app`. No private browser-to-credential transfer helper
is implemented; a browser can also be on a different machine from Stargate.

### Optional portable driver

If built-in browser tools are unavailable, Vercel Labs
[agent-browser](https://agent-browser.dev/installation) is an optional portable
browser driver. Its documented `0.41.2` release is dated November 3, 2026.
The optional mise task pins Node 24.21.0 and agent-browser 0.41.2 separately
from Stargate's Bun runtime. Obtain permission before installing the CLI, browser,
or system packages:

```sh
make cua-install
make cua ARGS='--version'
make cua ARGS='skills get core'
make cua ARGS='--session pogo-slack-setup --headed open https://api.slack.com/apps'
make cua ARGS='--session pogo-slack-setup stream disable'
```

On Linux, `agent-browser install --with-deps` also installs system libraries
and invokes `sudo` for non-root users. Request separate approval before using
it. A headed browser needs a desktop the operator can use for login/approval;
browser automation does not replace native desktop-dialog control.

Read the current [security](https://agent-browser.dev/security) and
[session](https://agent-browser.dev/sessions) documentation before use:

- Streaming is enabled by default. Disable it before human token handling.
  Do not start dashboards, traces, HAR capture, screenshots, or recordings.
- `get value`, `eval`, snapshots, and errors can contain secrets. JSON output
  and `--omit-command` are not credential redaction.
- The auth vault protects saved login passwords, not arbitrary Slack tokens.
- Navigation/action restrictions are opt-in. Domain allowlists must include
  required CDN and SSO domains. They cannot be combined with profile reuse,
  saved-state replay, or pre-existing CDP attachment.
- Do not export login cookies/state into the checkout. Saved state can contain
  plaintext session tokens unless explicitly encrypted. Close this named
  session when finished: `make cua ARGS='--session pogo-slack-setup close'`.

## Agent-assisted setup

Use this workflow when an agent is assisting a human who owns the Slack app.
Browser and Slack CLI tools help with app creation and workspace operations.
Runtime credentials still go directly into private local storage.

### 1. Confirm the target

Ask the operator for:

- Bot name and unique Stargate ID, such as `pogo-test`.
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

Choose a backend with [known working credentials](configuration.md#backend-configuration).
For OpenCode, `backend.url` is the OpenCode server URL. A provider proxy, if
used, is configured on that server. For Pi Durable, use a standard provider
API key or an [explicit proxy](configuration.md#pi-durable). Keep tools disabled
for the first test.

Run project commands from the Stargate repository:

```sh
mise install
make deps
make stargate ARGS='--help'
```

### 2. Install or update Slack skills

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

**Stargate-specific adaptation:** the generic `create-slack-app` flow scaffolds
Bolt templates. Stargate already exists, so skip its language, template, provider
SDK, and project-scaffolding steps. Reuse the CLI authentication guidance and
Stargate's own manifest. Do not run `slack create` or `slack run` for this gateway.
Stargate runs through `make start` or its user service.

### 3. Detect and install the public Slack CLI

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

### 4. Authenticate the selected workspace

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

### 5. Create or reuse Stargate's Slack app

**CLI login is not app creation.** Stargate is not a Slack CLI project, and `slack api`
does not automatically turn a developer login into a token for every method.
App Manifest APIs require a configuration token with
`app_configurations:write`, not Stargate's bot token. Do not add that permission to
the runtime bot or assume `--team` supplies the required API token.

Choose one of the following paths. Confirm the app name and target workspace
before creating anything remotely. If an app already exists, go to step 6.

#### A. Prefilled manifest link: no configuration token required

The agent generates Stargate's manifest and app-creation link:

```sh
make manifest ARGS='--name Stargate'
```

Open the printed link after the operator agrees. The operator selects the
workspace, reviews the manifest, and clicks **Create**. Record only the App ID,
not secrets. If link prefill does not work, generate the JSON instead:

```sh
make manifest ARGS='--name Stargate --json'
```

At [Slack app settings](https://api.slack.com/apps), choose **Create New App →
From a manifest** and paste that JSON. A shared JSON manifest link must use
the `manifest_json` query parameter, with the manifest URL-encoded.

If the operator is remote or on a phone, share the clickable link in chat;
opening a browser on the Stargate host does not help them. The third-party manifest
and Socket Mode notices are expected, but **"We can't translate a manifest with
errors"** is a validation failure. Check the generated fields against Slack's
[manifest reference](https://docs.slack.dev/reference/app-manifest).
The writable Messages tab uses `features.app_home.messages_tab_read_only_enabled`.
Send a newly generated link after fixing a manifest; the old link retains its
embedded JSON.

For a human driving the entire local wizard, use `make init`. For agent-led
registration, continue with steps 6 and 7 below; an interactive wizard cannot
be driven through a non-TTY shell tool.

#### B. Programmatic creation: optional configuration-token path

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
    manifest: JSON.stringify(buildManifest("Stargate")),
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
or automatically supply Stargate's app-level and bot tokens.

### 6. Review permissions, install, and collect runtime tokens

Stargate's manifest enables Socket Mode and subscribes to `app_mention`,
`message.channels`, `message.groups`, and `message.im`. Required bot scopes:

| Scope               | Purpose                                |
| ------------------- | -------------------------------------- |
| `app_mentions:read` | Receive mentions                       |
| `channels:history`  | Receive public-channel thread replies  |
| `groups:history`    | Receive private-channel thread replies |
| `im:history`        | Receive direct messages                |
| `chat:write`        | Send replies                           |
| `reactions:write`   | Add context-selected emoji reactions   |
| `commands`          | Open `/cron` and `/pogo pair` modals   |

For `/cron`, apply the updated app manifest: it registers the command and
enables interactivity over Socket Mode. No public request URL is needed.
Reinstall existing apps after adding `commands` or `reactions:write`.
Editing a local manifest file alone does not change the installed app.
See [recurring prompts](cron.md) for ownership and execution limits.

The generated manifest also registers `/pogo` for the optional operator-only
`/pogo pair` command. Pairing stays disabled until the bot has an explicit
`pairing.operators` list and `pairing.urls`. No extra scope is required.
Read [pairing](pairing.md) before enabling it: a redeemed link grants full
OpenCode server access for 30 days, not read-only conversation access.

Reactions use
[`reactions.add`](https://docs.slack.dev/reference/methods/reactions.add):
POST with the bot token, channel, emoji name, and original message timestamp.
An `already_reacted` response means the reaction is already present.
Stargate does not react to every question. The model can select `eyes` for a request
to inspect a concrete item, or another supported reaction when context calls for
it. Reaction targets stay fixed to the current user's message.
Generated captain definitions include this optional reaction protocol in their
system instructions. Stargate does not prepend it to user messages. Custom OpenCode
agents or Pi bots that need reactions should put the protocol in their agent
definition or configured `systemPrompt`; reply parsing and target checks remain
in the gateway.

Set `slackReadReceipts: true` on a bot to add 👀 to a human request when its
turn starts and remove it after a text reply is delivered. The bot needs
`reactions:write`.

Set `resumeSlackThreads: true` to accept an untagged reply in an allowed Slack
thread that Stargate has not seen before, when bounded Slack history confirms the
same bot previously replied there. The normal sender and channel rules still
apply. This helps a bot continue conversations after migrating to Stargate.

#### Silent replies

An agent posts nothing when the first line of its reply is exactly
`[[pogo:silent]]`. The same instructions block that describes reactions
describes this directive. Rules:

- Only the agent's own reply is read. The directive in a user message, a
  quotation, a code block or a later line is ordinary text.
- Text and file markers after the directive are not posted. They stay in the
  agent's session history.
- One reaction line can come before or after the directive. The reaction is
  applied; a reaction that fails does not cause a status message.
- Stargate removes waiting feedback and previews that are already shown, and
  records the request as delivered. Nothing is retried or replayed.
- With OpenCode, each assistant message is read separately. Other public text
  of the same turn is still posted, so a silent turn must contain no other
  text.
- A reply with no text and no directive still posts "Agent finished without a
  text reply.".

No Slack scope is required. An agent definition that was generated before this
directive existed does not contain it: add the "Slack silent reply" paragraph
to that definition, as for other changes to generated instructions.

Guide the operator through these human-controlled steps:

1. Under **Basic Information**, copy the non-secret App ID (`A…`).
2. Under **App-Level Tokens**, generate an `xapp-…` token with
   **`connections:write`**. This is an app-level scope, not a bot scope.
3. Under **OAuth & Permissions**, install the app to the chosen workspace.
   Wait for admin approval if required; do not claim the app is installed yet.
4. Copy its **Bot User OAuth Token** (`xoxb-…`). Reinstall after scope changes.
5. Invite the bot to each allowed channel with `/invite @Stargate`.

Keep persistent tokens out of the agent conversation, command-line arguments,
and tool output. The human can paste them into Stargate's hidden wizard prompts,
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

### 7. Register the bot with Stargate

The agent runs a noninteractive registration using references, not token values.
Replace the example IDs, path and URL with settings for this installation:

```sh
make stargate ARGS='bot add --id pogo-test --app-id A0123456789 --app-token-env POGO_TEST_APP_TOKEN --bot-token-env POGO_TEST_BOT_TOKEN --allowed-users U0123456789 --allowed-channels C0123456789 --backend opencode --directory /srv/project --url http://localhost:4096'
```

This uses the selected OpenCode server's default model. To select a specific
provider and model, pass `--provider ID --model ID` for a pair the server
already knows. For an authenticated OpenCode server, configure
`backend.headersEnv` with the name of a private environment variable.

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
token environment references. Restart an existing Stargate process after adding one.
For access-only changes, use
[live reload](configuration.md#reload-configuration-without-restarting).

### 8. Verify in stages

```sh
make config-check ARGS='--schema-only'
make config-check
make start
```

- Schema check validates configuration structure only.
- Credential check verifies local token references/prefixes, not live auth.
- `Bot connected` confirms Slack authentication and a Socket Mode connection.
- With the operator's consent, ask them to mention Stargate in an allowed channel:
  `@Stargate Say "Stargate is ready" without using tools.`
- Confirm a real reply, then a follow-up in the same thread. Do not claim success
  before those work. A backend failure may require provider configuration or
  authentication; never fix it by enabling all tools or opening allowlists.

Use a sandbox or a workspace without real users for smoke tests. Keep only one
Socket Mode listener per registration. Do not leave a second listener running
when switching from a foreground test to a user service.

### 9. Install the Stargate user service

```sh
make service ARGS='install --config /absolute/path/to/pogo.json'
systemctl --user enable --now pogo.service
systemctl --user status pogo.service
```

Installation alone does not enable or start the unit. Obtain permission before
starting/enabling services, and stop any foreground Stargate instance first.
The unit reads the private config companion; it does not inherit shell exports
automatically. See [Linux user service](operations.md#linux-user-service) for
lifecycle details.

## Agent completion checklist

Report each state separately: skills installed, CLI installed, workspace
authenticated, app created, app installed, tokens stored privately, Stargate bot
registered, backend configured, live reply verified, and service enabled.
List remaining human approvals or missing settings. Do not collapse these
states into "setup complete" after merely logging in or creating an app.

Never commit local config, credentials, API responses, auth tickets/challenges,
or runtime databases. Link to this guide rather than copying a live transcript.

## Official references

[manifest]: https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/#creating-apps-using-manifests
- [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Slack agent setup](https://docs.slack.dev/agent-setup/prompt.md)
- [Hosted Slack CLI skill](https://docs.slack.dev/.well-known/skills/slack-cli/SKILL.md)
- [App manifests and configuration tokens](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests)
- [Create an app from a manifest](https://docs.slack.dev/reference/methods/apps.manifest.create)
