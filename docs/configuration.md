# Configuration reference

`src/config/composition.ts` owns configuration composition. `src/config.ts`
retains the fixed public exports.

For Microsoft Teams, use the optional `teams` registrations described in
[Teams transport](teams.md). [Fleet controls](fleet-tools.md) are separately
opt-in. Teams registrations and fleet-control settings require a restart;
existing Slack and IRC configurations keep their current defaults.

The [Slack setup guide](setup.md) walks through the first bot. Use this reference
to add registrations, choose a backend or change a running instance. IRC-only
installations use the [IRC configuration](irc.md#configuration) instead of Slack
credentials.

## Scripted Slack registration

The examples use the linked `stargate` command. You can also substitute
`bun run src/main.ts` from the checkout. Create and install one Slack app for
each registration. Replace the IDs, directory, and model with your own values.

```sh
stargate bot add --config stargate.json \
  --id code-helper --app-id A123 \
  --app-token-env STARGATE_CODE_APP_TOKEN --bot-token-env STARGATE_CODE_BOT_TOKEN \
  --allowed-users U123 --allowed-channels C123 \
  --backend opencode --directory /srv/project --url http://localhost:4096

stargate bot add --config stargate.json \
  --id pi-helper --app-id A456 \
  --app-token-env STARGATE_PI_APP_TOKEN --bot-token-env STARGATE_PI_BOT_TOKEN \
  --allowed-users U123 --allowed-channels C123 \
  --backend pi-durable --directory /srv/project --model openai/gpt-5

stargate config check --config stargate.json --schema-only
stargate config check --config stargate.json
stargate start --config stargate.json
```

Without bot-option flags, `bot add` starts the wizard. With flags, it never prompts. Token **values are
not accepted as CLI arguments**: supply the referenced environment variables
or create `stargate.json.env` privately. Do not paste secrets into an
agent conversation, shell history, or a shared config file.

Every command supports `--help`; invalid commands/configuration exit nonzero.
`config check` checks schema and token presence/prefixes, not live Slack
connectivity or provider credentials. `--schema-only` needs no credentials.

See [`stargate.example.json`](../stargate.example.json) for two registrations.
Relative `dataDirectory` paths resolve beside the config file. Environment
variables take precedence over companion-file values in foreground operation.
Stargate defaults to `stargate.json` and loads a companion named
`<config>.env` for any explicit config path. Keep the companion and the data
directory private. The default data directory is `.stargate` beside the config.

Both Slack user and channel allowlists must be nonempty. A whole `*` allows
all accessible entries on that list. `deniedUsers` and `deniedChannels` override
every allow, including wildcards. A whole `*` in a deny list blocks all entries
on that list. Partial globs are unsupported. Slack still enforces app
installation, channel membership and its own permissions. Start with specific
IDs and keep agent tools off for the first test.

Set `bots[].access.mentionOnly` to require an explicit or configured mention
on each Slack turn. By default, an allowed user can continue an active
thread or send a direct message without another mention.

`bots[].access.textMentions.muteBypassNames` is an optional subset of that
rule's existing `names`. It uses the same channels and matcher. Absent or empty
means no text-mention mute bypass. It does not apply to `spokenMentions`.
See [notification muting](notifications.md) and [text mentions](text-mentions.md).

Stargate names new Slack sessions `<bot name> (slack <conversation ID>)`.
The bot name comes from `displayName`, then the configured OpenCode agent name,
then the bot ID. Existing session titles keep their name. A pinned OpenCode
captain uses its existing session across allowed chat sources.

`turnTimeoutMs` defaults to 30 minutes per bot and can be set up to one hour.
The per-bot `concurrency` setting defaults to four. Ordinary thread turns run
in order within a thread. Pinned captains handle turns in arrival order
across all their sources.

`bots[].slack.steerThreadFollowUps` defaults to `false`. When enabled, eligible
text follow-ups in a running OpenCode turn's exact thread use native steering
instead of a new job. Different threads retain queue isolation and receive a
queue notice. This flag requires a restart; it is not enabled by merging or
releasing the source. IRC uses its own
`irc[].features.steerThreadFollowUps` flag. See
[follow-up steering](operations.md#follow-up-steering) for refusal, uncertain
delivery and content limits.

`bots[].slack.inboundReactions` also defaults to `false` and requires a restart.
It admits the fixed reaction list and removal events only on this bot's
messages. The app owner must add the reaction read scope and subscriptions.
See [inbound Slack reactions](operations.md#inbound-slack-reactions).

Slack registrations can set optional `health` paths and freshness limits for
the read-only `@captain /health` command. See [health configuration and
coverage](meta-commands.md#health-configuration-and-coverage). Missing telemetry
is `unknown`; the gateway never runs a remote snapshot producer on demand.

`bots[].configPanelEnabled` defaults to `false`. Opting in changes Slack
`/config` replies to an interactive panel; typed settings commands remain.
See [configuration panels](meta-commands.md#optional-configuration-panel) for
staleness, access and Slack app prerequisites. This field requires a restart.

Use SIGHUP for the live changes below. Other changes require a restart.

## Reload configuration without restarting

Optional [external notification ingestion](notification-ingestion.md) uses the
top-level `notify` subtree. Each built-in HTTP adapter defaults to disabled.
Enabled HTTP requires `api.listen: "unix"`; producer credentials never grant
Fleet operator access. All notification topology and limits require restart.
Current live-safe access revocations apply to pending sends immediately.

Validate the file, then signal the running gateway (replace the unit name if
this installation uses another name):

```sh
stargate config check --config stargate.json
systemctl --user kill --signal=HUP stargate.service
```

SIGHUP reads the same regular configuration file and credential companion as
`config check`. Requests are serialised. Stargate validates the complete candidate
before publishing any setting. Invalid input, missing credentials, a busy crew
removal or any restart-only change refuses the whole candidate; the current
configuration and connections stay in place. Startup uses the same checks.
Configuration and CA files must be regular files, and Slack token prefixes
must be valid. Run `config check` before upgrading a service.
For a foreground process, use SIGHUP to reload and SIGINT or SIGTERM to stop it. Logs name the outcome and, for
`restart required`, the changed field paths. They do not contain secret values.
There is no automatic file watcher.

| Live-safe fields                              | Effect                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `bots[].access`                               | Users/channels, denies, mention-only/text mentions, peer captains and their cap                                           |
| `irc[].access`                                | Allowed accounts, denied accounts/channels, channel request policy, text mentions, all-calls, peer captains and turn caps |
| `bots[].transcription`, `irc[].transcription` | Provider/settings for future turns; spoken mentions are Slack-only                                                        |
| `irc[].crew` additions                        | Validate credentials and stage the backend/worker before connecting                                                       |
| `irc[].crew` removals                         | Refuse while any removed member has queued, running or responding work                                                    |

`access.peerTurnsPerHour` defaults to 5 per Slack thread or 30 per receiving
IRC connection and conversation in a rolling hour. The range is 0–600, where
0 refuses peer turns. IRC's `access.shipTurnsPerAgentPerHour` remains live-safe.

Turns retain their starting execution and transcription settings. Delivery
requires both the starting and current access policies: a new deny blocks the
next delivery, including previews, files and IRC queued lines; a new allow does
not expand an in-flight turn. A request already sent to Slack cannot be recalled.
Queued turns use the configuration current when they start.

All unlisted keys are restart-only. This includes transport additions/removals,
Slack/IRC credentials, existing credential values, backends, server/bind settings,
joined channels/JOIN/PART, existing crew-member fields, concurrency/timeouts,
feature switches, cron/waiting/activity, dashboard, Fleet API, agent
dispatch, maintenance and state paths.
An invalid or mixed live/restart change is never partially applied. Environment
variables keep precedence over the companion; values supplied by the service
manager remain fixed for the process lifetime. Reload never mutates the process
environment. New companion variables can supply added IRC crew `passwordEnv` values only.
Backend secret references must already exist in the process environment; adding
backend secrets to the companion requires a restart. Repeated transcript-read
failures keep removal busy until catch-up succeeds or the service is restarted.

The reloadable roster is `stargate.json`'s IRC crew, not the separate OpenCode
crew-plugin team. Reload preserves existing queue/session namespaces. Re-adding
an IRC member resumes its retained cursor/history, as after a restart. This is
configuration reload only; code updates and service handover still require their
separate maintenance procedure.

## Fleet API

The optional top-level `api` object enables the read-only
[Fleet API](api.md). Omit it to keep the listener off. Every `api` setting
requires a restart.

| Field                     | Default                                                                                                | Accepted values                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listen`                  | Required                                                                                               | `unix` for `<dataDirectory>/api.sock`, private IPv4 literal as `host:port`, private IPv6 as `[address]:port`, or `:port` to use `127.0.0.1`. Ports are 1–65535. |
| `allowedNetworks`         | `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `::1/128`, `fc00::/7` | Nonempty list of CIDRs wholly contained in the default ranges. Bind addresses must also be in these ranges.                                                     |
| `corsOrigins`             | `["subspace://*"]`                                                                                     | Exact serialized origins or hostname patterns with a whole-label `*`. An empty list disables CORS.                                                              |
| `fleetName`               | Hostname                                                                                               | Nonempty display name.                                                                                                                                          |
| `pullRequestRepositories` | Omitted                                                                                                | Map of exact absolute, normalized crew checkout paths to GitHub `owner/repository` values for [Fleet PR lookup](api.md).                                        |

`listen: "unix"` replaces TCP with one owner-only mode-0600 socket. The data
directory must be owned by the service user with mode 0700 and safe ancestors.
`allowedNetworks` remains valid configuration but only checks TCP peers.
The Fleet operator bearer and browser-origin policy still apply in Unix mode.
There is no `enabled` alias, simultaneous second API listener or notification
route in this version. For downgrade, restore the prior TCP `listen` or omit
`api` when no Fleet API is needed; keep private state. See [API limits and Unix
access](api.md#private-unix-mode).

## Agent dispatch

The optional top-level `agentDispatch` object lets the rear admiral's IRC
gateway poll the Subspace API and offer issues to the fleet's captains. It
is off by default (`enabled: false`) and every key requires a restart. Keys:
`enabled`, `fleet`, `api.baseUrl`, `api.tokenEnv`, `api.headersEnv`,
`messaging.type`, `messaging.registration`, `messaging.channel`,
`captainAccounts`, `pollIntervalSeconds` (default 120),
`answerTimeoutSeconds` (default 300) and `retryLadderSeconds` (default
`[3600, 10800, 21600, 43200]`). See [agent dispatch](agent-dispatch.md) for
each key, the credential it needs and how captains answer.

## Subspace agent identity

The optional top-level `subspaceAgents` object is absent by default. When it
is present with `enabled: true`, Stargate holds one key and certificate per
officer, enrols each with the Subspace API, and signs each officer's API
requests on a per-officer Unix socket. Keys: `enabled`, `api.baseUrl`,
`api.audience`, `api.headersEnv`, `api.timeoutSeconds` (default 60),
`enrolment.tokenFile` or `enrolment.tokenEnv`, `keyAlgorithm` (default
`ed25519`), `stateDirectory` (default `<dataDirectory>/subspace-agents`) and
`officers` (`name`, `rank`, `ship`, `model`, `ircNick`, `bundlePath`,
`socketPath`, `registration`). A section without `enabled: true` is treated
as absent and its other keys are not validated. Every change to an enabled
section requires a restart. See
[Subspace API agent identity](subspace-agents.md).

## Backend configuration

### OpenCode V2

Run and authenticate an OpenCode V2 server separately. Stargate uses
`@opencode/client` and does not start or stop that server.
Set `backend.url` and the server-side `backend.directory`. Optional `agent`
and `model: { "providerID": "…", "id": "…" }` select the session agent/model.

For authentication, map HTTP header names to environment variable names:

```json
"headersEnv": { "authorization": "STARGATE_OPENCODE_AUTHORIZATION" }
```

Set that variable to the complete header value, such as `Bearer …`.
Use HTTPS for remote servers. Do not expose an unauthenticated service.

Tool permissions default to **deny all**. Configure `backend.permissions`
with OpenCode V2 `action`, `resource`, and `effect` rules to permit tools.
Stargate accepts `allow` and `deny`, not `ask`: Slack approval UI is not implemented.
Consult the server's V2 permission documentation before permitting tools.

### Pi Durable

Stargate embeds `@earendil-works/pi-durable` **1.5.2**, using SQLite on Bun.
It does not require a Pi server or the Pi CLI. Pi Durable's API is experimental;
the three direct Pi packages are pinned together.

- `model`: `openai/modelId` or `anthropic/modelId`.
- Credentials: `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.
- `thinkingLevel`: optional Pi SDK level (`off`, `minimal`, `low`, `medium`,
  `high`, `xhigh`, `max`). Unset keeps Pi's default `off`. Stargate refuses a
  level the model does not support instead of clamping it. Changing it on a
  bot selects a new session namespace; existing crew conversations keep the
  level they were created with, like `model`.
- `systemPrompt`: optional instructions.
- `tools`: `none` by default; `coding` enables read, write, edit, and bash.
- `directory`: initial working directory, **not a sandbox**.

Optional `provider: { baseURL, apiKeyEnv }` selects an explicit proxy instead
of native provider credentials. The supported proxy models are
`openai/opencode-go/deepseek-v4.1-flash` (chat completions) and
`anthropic/claude-haiku-5-5` (Anthropic Messages); other models fail closed.
Use loopback HTTP or HTTPS, with no URL credentials, query or fragment. The
Claude route requires a `baseURL` that ends with `/v1`, the same endpoint as
OpenCode's `claude-proxy`. `apiKeyEnv` names the private proxy client
key variable; never place its value in JSON. Go requests identify Stargate and retain
a stable Go session header per Pi conversation. Capabilities, cost and limits
come from the pinned Pi catalog. Without `thinkingLevel`, Haiku requests
disable thinking; `"thinkingLevel": "low"` sends adaptive thinking with effort
`low` (OpenCode's `#low`). There is no native-provider fallback,
`ANTHROPIC_*` variable, or redirect when a proxy is configured.

Without `provider`, Pi uses standard provider environment variables.
Registrations in one process can share credentials; use separate processes
for credential or OS-level isolation. OpenCode header mappings can differ per
bot. The captain can also manage [Pi Durable crew members](agents/default-opencode.md#pi-durable-crew),
without another Slack app or OpenCode root session.

### Claude Agent SDK

Stargate pins `@anthropic-ai/claude-agent-sdk` to one exact version and runs its
bundled Claude Code CLI for each turn. `backend.type: "claude"` works for
Slack bots, IRC captains and IRC crew members. The model is reached only
through an explicit `provider: { baseURL, apiKeyEnv }`, such as the local
CLIProxyAPI at `http://127.0.0.1:8317/v1`; there is no native login or
API-key fallback. Tools default to none. `allowedTools` selects built-in
tools, and `mcpServers` opts into named external tool servers. Settings files,
`CLAUDE.md` and MCP servers are not loaded by default. The child process gets
a minimal environment and a private `CLAUDE_CONFIG_DIR`. `directory` is a
starting location, not a sandbox. See [Claude Agent SDK backend](claude.md)
for setup, permissions, recovery and limits.

### Codex SDK

Stargate pins `@openai/codex-sdk` to one exact version and runs the Codex CLI of
that version for each turn. `backend.type: "codex"` works for Slack bots, IRC
captains and IRC crew members. The model is reached only through an explicit
`provider: { baseURL, apiKeyEnv }`, such as the local CLIProxyAPI at
`http://127.0.0.1:8317/v1` with `gpt-6.1-sol`; there is no ChatGPT login,
`~/.codex` or API-key fallback. Tool commands run in Codex's `read-only`
sandbox by default, with approval policy `never` and no network;
`sandbox: "workspace-write"` and `network: true` widen it explicitly.
`AGENTS.md`, skills, plugins, hooks, MCP servers and web search are off. The
CLI gets a minimal environment and a private `CODEX_HOME`. See
[Codex SDK backend](codex.md) for setup, sandbox, recovery and limits.

### Custom adapters

Use `backend.type: "module"`, an absolute `module` path, and an `options`
object. The module exports `createBackend(options, context)` and returns
[`AgentBackend`](../src/backends/backend.ts). Context contains a private data directory.
Modules are trusted code with the process's full privileges.
See the [architecture guide](design.md).
