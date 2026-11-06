# Pogo

One Slack gateway. Multiple bot registrations. Pluggable agent backends.

Pogo connects Slack to **OpenCode V2** over its TypeScript client or embeds
**Pi Durable** directly. Each bot has separate Slack credentials, access rules,
agent settings, and thread sessions. No public HTTP endpoint is required.

## Quick start

Requires [mise](https://mise.jdx.dev/). Bun **1.4.4** is pinned in `mise.toml`.

For agent-led app registration, CLI authentication, human approvals, and live
verification, follow the [setup guide](docs/setup.md). It provisions Slack apps
for Pogo without scaffolding a separate Bolt application.

For trusted project work, use the [OpenCode captain/crew profile](docs/agents/default-opencode.md).
Without `--team`, Bowser coordinates the four-member starter crew through
CLIProxyAPI and Mesij. `pogo crew init --team team.example.json` selects a
configured captain and variable roster; the portable example uses Galactica.
Each team needs separate namespace, state, captain and crew directories, but
can share an OpenCode V2 server. Existing Bowser/global settings are unchanged.
Use the [shared global agent-profile prompt and skill](docs/agents/agent-profiles.md)
to discover subscription models and install switchable model-named sub-agents.
Review and approve its migration plan before changing global configuration.

```sh
mise install
mise run deps
mise run init
mise run start
```

`init` opens a prefilled Slack app-creation link and guides you through tokens,
allowed users/channels, and the backend. Token input is hidden. Credentials go
in `pogo.json.env`, mode `0600`; configuration goes in `pogo.json`.
Run `init` again to add another bot. Existing bots and tokens are not replaced.

Invite each bot to an allowed channel. Mention it to start a conversation.
Replies in that thread continue its session without another mention.
Allowed DMs can start sessions without mentions. Both user and channel must
be allowed; messages from bots, edits, and empty prompts are ignored.
Set `access.mentionOnly` to require a mention for every turn.

Built-in backends stream visible response text through coalesced Slack message
updates. Agent replies use Slack's native Markdown blocks for headings, links,
lists, tables, and code. Long replies prefer paragraph boundaries and keep
ordinary fenced code blocks balanced across messages. Chunks with Slack mention
or broadcast controls stay literal to avoid accidental notifications.
Slow responses show named, rotating feedback after five seconds; the
same message becomes the answer when text arrives. See [waiting settings](docs/waiting.md)
for configurable delays, disabling feedback, and captain-managed changes.
Existing module backends can still return a final answer without streaming.

Select **Stop** on a live reply or waiting message to request cancellation.
Only the original requester can stop that request. Existing tool effects are
not rolled back. See [cancellation](docs/cancellation.md) for setup and limits.

`/cron` opens an interactive list of your scheduled prompts in the current
channel. Add a name, cron schedule, timezone, and prompt; remove jobs with a
confirmation button. Scheduled results start a new thread in that channel.
See [cron jobs](docs/cron.md) for app setup and execution limits.

Set `threadContext: true` on a bot to import bounded prior messages when its
first request starts inside an existing Slack thread. This is off by default.
Only the requester's and this bot's text can be included; other participants,
files, and attachments are excluded. See [thread context](docs/thread-context.md)
for limits, privacy, and Slack access requirements.

To respond wherever the bot is invited, allow all humans and accessible
channels/DMs explicitly:

```json
"access": {
  "users": ["*"],
  "channels": ["*"],
  "deniedUsers": [],
  "deniedChannels": []
}
```

**Deny always beats allow**, including explicit allows and wildcards. Add user
or channel IDs to `deniedUsers` or `deniedChannels` to exclude them later.
Missing deny lists default to empty. Both allow lists must remain nonempty;
empty allow lists are invalid, not shorthand for everyone. Only whole `*`
wildcards are supported; partial globs such as `C*` are invalid. A deny list
containing `*` blocks everyone or every channel/DM, respectively.

CLI options: `--allowed-users '*'`, `--allowed-channels '*'`,
`--denied-users U123,U456`, and `--denied-channels C123,G456`.
Quote wildcards to prevent shell expansion. The wizard supports the same rules;
leave its deny prompts blank when no exclusions are needed.

Wildcards do not grant Slack channel membership or bypass Slack permissions.
App/workspace routing checks and bot rejection remain in force. Accessible DMs
and human participants in shared channels are included, so consider exclusions
before enabling tools. Restart Pogo after changing access rules. Denies are
also checked before queued work and pending reply delivery.

Optional local command link:

```sh
mise exec -- bun link
pogo --help
```

The linked command requires `bun` on `PATH`, including outside this directory.
You can always use `mise exec -- bun run src/main.ts` instead of `pogo`.

## Task shortcuts

`mise.toml` owns the tasks; the Makefile delegates to them without duplicating
commands. Both wrappers preserve terminal input for the setup wizard.

```sh
make help
make deps
make init
make crew-init ARGS='--directory /srv/pogo/bowser --project /srv/indra --worktrees /srv/pogo/indra-crew'
make provision ARGS='--plan bots.example.json --json'
make cua-install
make cua ARGS='--help'
make start
make check
make config-check ARGS='--config pogo.example.json --schema-only'
make service ARGS='install --config /srv/pogo/pogo.json'
make pogo ARGS='bot add --help'
```

Equivalent mise commands use `mise run TASK -- OPTIONS`, for example:

```sh
mise tasks ls
mise run config-check -- --config pogo.example.json --schema-only
mise run pogo -- bot add --help
```

Other tasks: `manifest`, `service`, `test`, `typecheck`, `lint`, and `format`.
Do not put secret values in `ARGS` or task arguments. Use the wizard or private
environment variables instead.

## Slack permissions

Each bot needs its own Slack app with Socket Mode enabled:

| Scope               | Purpose                                |
| ------------------- | -------------------------------------- |
| `app_mentions:read` | Receive mentions                       |
| `channels:history`  | Receive public-channel thread replies  |
| `groups:history`    | Receive private-channel thread replies |
| `im:history`        | Receive direct messages                |
| `chat:write`        | Send replies                           |
| `reactions:write`   | Add context-selected emoji reactions   |
| `commands`          | Open the `/cron` job manager           |

Create an app-level `xapp-…` token with **`connections:write`** under
**Basic Information → App-Level Tokens**. Install the app to your workspace
and copy its **Bot User OAuth Token**, `xoxb-…`, under **OAuth & Permissions**.
Reinstall after scope changes. Use `/invite @your-bot` in each allowed channel.
Workspace administrators may need to approve installation.

The wizard supplies event subscriptions and the bot's Messages tab.
Generate the same manifest without running setup:

```sh
pogo manifest --name Pogo
pogo manifest --name Pogo --json > slack-manifest.json
```

Slack App IDs begin with `A`; member IDs with `U` or `W`; channel IDs with
`C`, `G`, or `D`. Copy member IDs from profile → More → Copy member ID;
channel details show the channel ID. `--help` includes these instructions.

## Scripted and agent-operated setup

Agents should follow [Agent-led Pogo setup](docs/setup.md) first. It covers
Slack skill/CLI installation, the `/slackauthticket` challenge exchange, manifest
creation, secure token handoff, and the difference between CLI login and app
installation. Persistent tokens must not be requested in chat.

```sh
pogo bot add --config /srv/pogo/pogo.json \
  --id code-helper --app-id A123 \
  --app-token-env POGO_CODE_APP_TOKEN --bot-token-env POGO_CODE_BOT_TOKEN \
  --allowed-users U123 --allowed-channels C123 \
  --backend opencode --directory /srv/project --url http://localhost:4096

pogo bot add --config /srv/pogo/pogo.json \
  --id pi-helper --app-id A456 \
  --app-token-env POGO_PI_APP_TOKEN --bot-token-env POGO_PI_BOT_TOKEN \
  --allowed-users U123 --allowed-channels C123 \
  --backend pi-durable --directory /srv/project --model openai/gpt-5

pogo config check --config /srv/pogo/pogo.json --schema-only
pogo config check --config /srv/pogo/pogo.json
pogo start --config /srv/pogo/pogo.json
```

Replace example IDs and choose an available model. Without bot-option flags,
`bot add` starts the wizard. With flags, it never prompts. Token **values are
not accepted as CLI arguments**: supply the referenced environment variables
or create `/srv/pogo/pogo.json.env` privately. Do not paste secrets into an
agent conversation, shell history, or a shared config file.

Every command supports `--help`; invalid commands/configuration exit nonzero.
`config check` checks schema and token presence/prefixes, not live Slack
connectivity or provider credentials. `--schema-only` needs no credentials.

See [`pogo.example.json`](pogo.example.json) for two registrations.
Relative `dataDirectory` paths resolve beside the config file. Environment
variables take precedence over companion-file values in foreground operation.
Restart Pogo after configuration changes.

## Backend configuration

### OpenCode V2

Run and authenticate an OpenCode V2 server separately. Pogo uses
`@opencode/client` and does not start or stop that server.
Set `backend.url` and the server-side `backend.directory`. Optional `agent`
and `model: { "providerID": "…", "id": "…" }` select the session agent/model.

For authentication, map HTTP header names to environment variable names:

```json
"headersEnv": { "authorization": "POGO_OPENCODE_AUTHORIZATION" }
```

Set that variable to the complete header value, such as `Bearer …`.
Use HTTPS for remote servers. Do not expose an unauthenticated service.

Tool permissions default to **deny all**. Configure `backend.permissions`
with OpenCode V2 `action`, `resource`, and `effect` rules to permit tools.
Pogo accepts `allow` and `deny`, not `ask`: Slack approval UI is not implemented.
Consult the server's V2 permission documentation before permitting tools.

### Pi Durable

Pogo embeds `@earendil-works/pi-durable` **1.5.0**, using SQLite on Bun.
It does not require a Pi server or the Pi CLI. Pi Durable's API is experimental;
the three direct Pi packages are pinned together.

- `model`: `openai/modelId` or `anthropic/modelId`.
- Credentials: `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.
- `systemPrompt`: optional instructions.
- `tools`: `none` by default; `coding` enables read, write, edit, and bash.
- `directory`: initial working directory, **not a sandbox**.

Pi credentials use standard provider environment variables. Registrations in
one process share those provider credentials; use separate Pogo processes for
credential or OS-level isolation. OpenCode header mappings can differ per bot.

### Custom adapters

Use `backend.type: "module"`, an absolute `module` path, and an `options`
object. The module exports `createBackend(options, context)` and returns
[`AgentBackend`](src/backend.ts). Context contains a private data directory.
Modules are trusted code with the process's full privileges.
See [`docs/design.md`](docs/design.md).

## Linux user service

From the installed project directory:

```sh
mise exec -- bun run src/main.ts service install --config /srv/pogo/pogo.json
systemctl --user enable --now pogo.service
systemctl --user status pogo.service
journalctl --user -u pogo.service -f
```

No `sudo`. Installation writes `~/.config/systemd/user/pogo.service` and reloads
systemd; it does **not** enable or start the service. The unit uses absolute
Bun/entrypoint paths, config-directory working directory, private umask, and
the optional config companion as `EnvironmentFile`. Keep the project and
installed Bun version in place. Reinstall the unit after moving either.

User services normally start at login. For operation after logout or before
login, ask your administrator about `loginctl enable-linger "$USER"`.
Do not assume your shell's exported variables reach systemd: use the private
companion file or configure the user-service environment explicitly.

```sh
pogo service stop
pogo service start
pogo service status
pogo service uninstall
```

Use `--name other-pogo` for a separate unit. Separate instances need separate
config/data directories **and separate Slack app registrations**. Do not run
two Socket Mode listeners with the same credentials; Slack can distribute
events between them. One data directory has one process owner, enforced by a
SQLite file lock that the OS releases on exit.

## Guarantees and limits

- Bot/app/workspace/backend/channel/thread identity separates sessions.
- Messages queue in SQLite before Slack acknowledgement. Duplicate deliveries
  and overlapping `message`/`app_mention` events do not run the agent twice.
- Turns run in order per thread; different threads run concurrently. Each bot
  defaults to four concurrent turns and a five-minute turn timeout.
- Replies persist separately from execution; Slack retries do not rerun tools.
  Up to eight delivery attempts use bounded exponential delays.
- A stopped process can leave tool outcomes unknown. On restart, Pogo attempts
  to interrupt surviving work and reports the interrupted request rather than
  automatically running it again. Transcript/session state remains available.
  Pi Durable's task storage does not provide automatic gateway-turn recovery.
- Exactly-once external side effects are **not** guaranteed. A crash after
  Slack accepts a reply but before SQLite records it can duplicate that reply.
- Events Slack does not deliver during an outage are not recovered from history.
- Backend-setting changes create a new session namespace. Pending jobs for an
  old backend identity remain on disk; they are not executed with new settings.
- Responses render Markdown, with no tool output or reasoning, at most 60,000
  Unicode characters. Streaming, `/cron`, and its interactive controls are
  supported. File transport and backend approval buttons are not implemented.
  See the [Slack feature comparison](docs/slack-parity.md) for remaining gaps.
- Database files contain prompts and replies. There is no automatic retention
  policy. Keep the data directory private and back it up only while stopped.

Access rules are request filters, not isolation. A permitted user can ask the
agent to use every enabled capability under the Pogo process's OS account.
Separate users/containers are required to isolate untrusted workloads. Never
enable coding tools for an untrusted Slack audience.

## Development

```sh
mise install
mise run deps
mise run hooks-install
mise run check
mise run hooks
```

`check` runs strict TypeScript, Biome lint/format checks, and Bun tests. TypeScript
also rejects unchecked index access, implicit returns/overrides, unused code,
fallthrough, unreachable code, unused labels, and unchecked side-effect imports.
Biome treats warnings as failures and checks promise handling, unsafe returns,
exhaustive switches, explicit `any`, non-null assertions, and `@ts-ignore`.

`format` applies Biome's safe fixes. `hooks-install` installs prek's pre-commit
hook for this clone. `hooks` runs the same repository-wide gate as CI, plus
workflow validation, merge/case conflicts, broken symlinks, large files, private
keys, trailing whitespace, final newlines, and TOML/YAML syntax. File hygiene
hooks can edit files; review and stage their changes before retrying a commit.
GitHub Actions runs this gate for pull requests and pushes to `main`, using
pinned tools and frozen dependency installation. No Slack or provider credentials
are required.

TypeScript checks first-party source and tests. `skipLibCheck` remains enabled
because the installed SDK declarations have upstream type errors. It does not
skip checks of SDK use in this code. Biome's `useLiteralKeys` style rule is off
because it conflicts with `noPropertyAccessFromIndexSignature`; record keys use
bracket access. Do not replace it with casts, suppression comments, or weaker
type-safety rules.

### Dependency updates

Dependabot checks Bun dependencies and pinned GitHub Actions each Monday.
Pi runtime packages and OpenCode SDK packages have separate groups; other
dependencies are grouped together. Security updates also use a group.
Version updates have a seven-day cooldown; security updates bypass it.
CI checks that all three Pi runtime packages stay pinned to one release.

The repository policy permits auto-merge for all version levels, including
major updates, only after the required `Quality checks` gate passes. `main`
must require pull requests, up-to-date checks, and resolved review conversations.
Do not remove those protections while dependency auto-merge is enabled.

The required quality gate checks every commit and page against signed Dependabot
authorship, the full commit count, and the current PR head. This also blocks
auto-merge after a maintainer adds commits to a previously eligible PR. Put those
edits in a human-authored PR instead. Development requires Git and jq on `PATH`.
Like other PR checks, this gate trusts repository writers not to remove or weaken
the workflow and its tests. It is not a boundary against malicious maintainers.

The privileged Dependabot workflow reads metadata and never checks out PR code.
Its required write trigger has one documented, line-scoped workflow
lint exception; other security checks stay enabled. It requests advisory Copilot
reviews for Actions updates when the
existing organization policy permits them. Copilot excludes `package.json` and
lockfiles from review, so Bun updates do not use Copilot as a merge gate. Review
requests do not enable paid usage, count as approvals, or guarantee a review
will finish before merge. Major updates can still break behavior beyond the
test coverage; failed checks and unresolved review threads require a maintainer.

Dependabot does not update the tool pins in `mise.toml`; update them separately.

### Test coverage

Tests cover routing, multi-bot isolation,
access denial, SQLite persistence/locking, queue ordering, retries, interrupted
turns, setup safety, systemd escaping, the OpenCode HTTP contract, and a real
Pi Durable session/store reopen. No Slack or paid provider calls run in tests.
Live Slack and model verification still requires your credentials.

PIPA was evaluated as a reference for Slack setup and thread behavior.
Pogo is a standalone implementation, not a PIPA fork.
