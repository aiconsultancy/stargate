# Pogo

One Slack gateway. Multiple bot registrations. Pluggable agent backends.

Pogo connects Slack to **OpenCode V2** over its TypeScript client or embeds
**Pi Durable** directly. Each bot has separate Slack credentials, access rules,
agent settings, and sessions. Captains use one durable session across chat
sources; ordinary bots can use separate thread sessions. No public HTTP
endpoint is required.

## Quick start

Requires [mise](https://mise.jdx.dev/). Bun **1.4.4** is pinned in `mise.toml`.

For agent-led app registration, CLI authentication, human approvals, and live
verification, follow the [setup guide](docs/setup.md). It provisions Slack apps
for Pogo without scaffolding a separate Bolt application.

For trusted project work, use the [OpenCode captain/crew profile](docs/agents/default-opencode.md).
Without `--team`, Bowser coordinates the four-member starter crew through
CLIProxyAPI and Mesij. `pogo crew init --team team.example.json` selects a
configured captain and variable roster; the portable example uses Galactica.
Native definition IDs and filenames use `<ship>-<role>-<name>`; `--id`
selects the ship namespace. Pogo member addresses stay short within that ship.
Captain and crew reference one captain-maintained
`WAYS_OF_WORKING.md` by path, not repeated content injection. See
[crew coordination](docs/crew-coordination.md) for journal, mail and DM tools.
Its optional Bosun worker handles [ship maintenance](docs/ship-maintenance.md),
with captain/crew journals, shared lessons and explicit nightly scheduling.
Each team needs separate namespace, state, captain and crew directories, but
can share an OpenCode V2 server. Existing Bowser/global settings are unchanged.
Use the [repeatable instance procedure](docs/instances.md) for a second team,
pinned inputs, generated registration plans, authentication and retry rules.
See [knowledge search](docs/knowledge-search.md) for session history, QMD
documentation retrieval and source-code lookup.
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

New sessions use `<bot name> (slack <conversation ID>)` as their title, for
example `Galactica Captain (slack D123)`. Set `displayName` on the bot to choose
its name; otherwise Pogo uses the OpenCode agent name, then the bot ID.
Existing titles stay unchanged. Ordinary bots keep separate thread sessions
even when their titles match. A captain instead uses its configured existing
session for DMs, channels, threads and scheduled requests.

For a captain, set OpenCode `backend.sessionID` to that native root session's ID
and set the same `captainSessionID` in every crew plugin's options. Pogo never
creates a replacement when a pinned session is unavailable or incompatible.
Use the same session in OpenCode's native interfaces. See
[captain session binding](docs/agents/default-opencode.md#one-captain-session).

Built-in backends stream visible response text through coalesced Slack message
updates. Agent replies use Slack's native Markdown blocks for headings, links,
lists, tables, and code. Long replies prefer paragraph boundaries and keep
ordinary fenced code blocks balanced across messages. Chunks with Slack mention
or broadcast controls stay literal to avoid accidental notifications.
Slow responses show named, rotating feedback after five seconds; the
same message becomes the answer when text arrives. See [waiting settings](docs/waiting.md)
for configurable delays, disabling feedback, and captain-managed changes.
Existing module backends can still return a final answer without streaming.

Accepted Slack messages can carry images and files. Agents can publish requested
local evidence into the proven source thread. See [attachments](docs/attachments.md)
for scopes, supported backends, limits and explicit file publication syntax.

Requests have a 30-minute time limit by default. Set `turnTimeoutMs` on the bot
to change it, up to one hour. Ordinary long replies stream in the same thread;
large builds can need a longer limit or smaller requests. Failures end the
live reply with one collapsible **Request status** box. It states the safe cause
and next action for a timeout, Stop, backend failure or missing thread context.
With OpenCode, public text that settled before the failure stays above the box.
If the finished reply is not yet readable in session history, a **Reply
delayed** box appears and Pogo posts the reply when history is readable.
Later public replies from the same session, such as work resumed by background
shell completions, reach the same thread. See [session transcript](docs/design.md#session-transcript).
Delivery retries do not repeat agent work. Check agent state before retrying
work whose outcome is uncertain.

Use `make eval` for local conversation reliability evaluations: busy crew,
cancelled observations, two sources, reply ownership and delivery recovery.
These requests use fake native delivery and real SQLite, with no Slack posts or
provider calls. See [evaluation and improvement](docs/evaluation.md) for the
score gates, limits and small-change procedure.

Opt into a separate collapsible crew activity message with
`crewActivity: { "detail": "summary" }` on the bot.
`detailed` also shows attributed assignments, messages and results; `off` is
the default. Both modes show journal facts without a model call per refresh.
An optional configured Pi reporter prepares one final tools-off summary only
when its slot is free. Busy reporters are skipped, not queued. Set its
short Pogo member ID in `reporter`; there is no built-in Twiki default.
Empty captures and the reporter's own maintenance
do not create an activity message or summary request. See [crew activity](docs/crew-activity.md) for
setup, privacy, and delivery limits.

Use `/pogo crew` for the configured crew roster or `/pogo crew twiki` for one
member's task, queue, last outcome and recent visible progress. This private
status view calls no model and starts no work. It includes Twiki's maintenance
and reporter tasks even when automatic crew reports are off. Stored running or
ready state does not prove execution is live. See [crew activity](docs/crew-activity.md#query-a-member).

Select **Stop** on a live reply or waiting message to request cancellation.
Only the original requester can stop that request. Existing tool effects are
not rolled back. See [cancellation](docs/cancellation.md) for setup and limits.

`/cron` opens an interactive list of your scheduled prompts in the current
channel. Add a name, cron schedule, timezone, and prompt; remove jobs with a
confirmation button. Scheduled results start a new thread in that channel.
See [cron jobs](docs/cron.md) for app setup and execution limits.

Shared captains receive `s=slack;c=<channel>;t=<thread>;m=<message>;u=<user>`
and the new message each turn, without automatic history resends. Unpinned
conversations can set `threadContext: true` to import bounded requester/bot text
when their first request starts in an existing thread. This is off by default;
other participants and historical files are excluded. See
[thread context](docs/thread-context.md)
for limits, privacy, and Slack access requirements.

`/pogo pair` lets configured operators request standard OpenCode device
pairing in a private modal. Pairing is disabled until explicitly configured.
It uses the existing authenticated server and configured Tailscale or
Cloudflare addresses; it never enables remote access or creates a tunnel.
Pairing grants server access, not access to only one Slack conversation.
See [device pairing](docs/pairing.md) for authorization and expiry details.

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
| `commands`          | Open `/pogo` controls and `/cron`      |

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

Optional `provider: { baseURL, apiKeyEnv }` selects an explicit proxy instead
of native provider credentials. The supported proxy model is
`openai/opencode-go/deepseek-v4.1-flash`. Use loopback HTTP or HTTPS, with no
URL credentials, query or fragment. `apiKeyEnv` names the private proxy client
key variable; never place its value in JSON. Requests identify Pogo and retain
a stable Go session header per Pi conversation. There is no native-provider
fallback when a proxy is configured.

Without `provider`, Pi uses standard provider environment variables.
Registrations in one process can share credentials; use separate processes
for credential or OS-level isolation. OpenCode header mappings can differ per
bot. The captain can also manage [Pi Durable crew members](docs/agents/default-opencode.md#pi-durable-crew),
without another Slack app or OpenCode root session.

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

- Bot/app/workspace/backend identity separates session namespaces. Ordinary
  bots add channel/thread identity; a pinned captain shares one session across
  its allowed chat sources. Its memory is shared, not a privacy boundary.
- Messages queue in SQLite before Slack acknowledgement. Duplicate deliveries
  and overlapping `message`/`app_mention` events do not run the agent twice.
- Ordinary turns run in order per thread; different threads can run concurrently.
  Captain turns use one FIFO across sources. Each bot defaults to four concurrent
  turns and a 30-minute turn timeout (maximum one hour).
- Replies persist separately from execution; Slack retries do not rerun tools.
  Up to eight delivery attempts use bounded exponential delays.
- A stopped process can leave tool outcomes unknown. On restart, Pogo attempts
  to interrupt surviving work and reports the interrupted request rather than
  automatically running it again. Transcript/session state remains available.
  Pi Durable's task storage does not provide automatic gateway-turn recovery.
- Exactly-once external side effects are **not** guaranteed. A crash after
  Slack accepts a reply but before SQLite records it can duplicate that reply.
- OpenCode thread replies follow a durable per-thread message cursor. After a
  restart or reconnect, Pogo catches up every mapped thread. Failed history
  reads keep the cursor and retry with backoff. A deleted session or lost
  cursor stops catch-up for that thread. After a lost cursor, the next reply
  starts with a note that earlier replies may be missing. Existing threads
  start at current history, without backfill. Continuations are not
  guaranteed exactly once.
  Pinned captains instead use one source-attributed cursor. Their replies go to
  the originating job's destination, not every old chat. Unowned native UI
  output stays in native history. Per-thread transcript repair is unsupported
  for pinned captains.
- Events Slack does not deliver during an outage are not recovered from history.
- Backend-setting changes create a new session namespace. Pending jobs for an
  old backend identity remain on disk; they are not executed with new settings.
  Adding `backend.sessionID` only binds an existing native session; it does not
  change the namespace, thread admission or cron schedules. Changing that pin
  requires an explicit idle migration. One pinned session can have only one bot
  registration and one Pogo process owner.
- Responses render Markdown, with no tool output or reasoning, at most 60,000
  Unicode characters; OpenCode transcript replies are not clipped. Streaming,
  `/cron`, and its interactive controls are supported. File transport and
  backend approval buttons are not implemented.
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

Effect **4.0.6** stays pinned to the OpenCode SDK's version. The official
`effect-ts` and `effect-v3-to-v4` skills are installed in `.agents/skills`;
[provenance and file hashes](.agents/effect-skills.json) record their upstream
revision. Read `node_modules/effect/AGENTS.md` before changing Effect code.
The migration skill is available for future upgrades; this project already uses
Effect 4. Skill examples that install `latest` do not override the SDK pin.
Biome leaves these two upstream skill files unformatted to preserve their hashes.

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
